// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { builtinName, runBuiltin } from "./builtins.ts";
import { findHatches, matchesAny, type Finding } from "./rules.ts";
import { runBounded } from "./runtree.ts";
import { changedFiles, type Baseline } from "./session.ts";
import { readConfig, type CheckCmd } from "./state.ts";
import { fileFindings, readRules } from "./turn.ts";

/**
 * `ratchet check --base <ref>`: the turn-end checks, run by CI on everything changed since a base commit. It closes the
 * gap between the agent's turn and the merge: a change made by hand, or by an agent with Ratchet off, meets the same
 * file checks (syntax, project rules, escape hatches) and the project's checks before it reaches the main branch.
 *
 * In CI nothing is known to have passed before, so every finding fails. A command that could not run fails too.
 * Tests and drivers are left to the project's own CI. A protected file may change only when a commit in the range
 * carries a `Ratchet-Allow-Protected: <glob>` git trailer (in the trailer block, not a sentence of the body); the
 * allowance then covers the whole range, which a reviewer sees in the pull request.
 */
export const ALLOW_TRAILER = "Ratchet-Allow-Protected";

const git = (root: string, args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

/** Pure: the globs from trailer values, one per line, as `git log --format=%(trailers:...,valueonly)` prints them. */
export const allowedByTrailers = (values: string): string[] =>
  values.split(/\r?\n/).map((v) => v.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "")).filter((g) => g !== "");

/** Pure: `git diff --name-status -M -z` output as deleted paths and renames (old path to new path). */
export const parseNameStatus = (out: string): { deleted: string[]; renamed: { from: string; to: string }[] } => {
  const parts = out.split("\0");
  const deleted: string[] = [];
  const renamed: { from: string; to: string }[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const status = parts[i] ?? "";
    if (status === "") continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const from = parts[i + 1] ?? "";
      const to = parts[i + 2] ?? "";
      if (status.startsWith("R")) renamed.push({ from, to });
      i += 2;
    } else {
      if (status === "D") deleted.push(parts[i + 1] ?? "");
      i += 1;
    }
  }
  return { deleted, renamed };
};

/** Pure: a file name as one argument of a shell command, for the shell this platform uses. */
export const shellArg = (file: string, platform: string = process.platform): string => (platform === "win32" ? `"${file.replace(/"/g, '""')}"` : `'${file.replace(/'/g, "'\\''")}'`);

/** The base as a commit that HEAD descends from: the ref itself, or its merge base with HEAD. */
export const resolveBase = (root: string, ref: string): string => {
  const sha = git(root, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
  try {
    git(root, ["merge-base", "--is-ancestor", sha, "HEAD"]);
    return sha;
  } catch {
    return git(root, ["merge-base", sha, "HEAD"]).trim();
  }
};

export type CiCheckResult = { base: string; changed: string[]; findings: Finding[]; ran: string[]; allowed: string[] };

export const ciCheck = ({ root, base, only = [], timeoutS = 600 }: { root: string; base: string; only?: string[]; timeoutS?: number }): CiCheckResult => {
  const head = resolveBase(root, base);
  const { deleted, renamed } = parseNameStatus(git(root, ["diff", "--name-status", "-M", "-z", head]));
  // A renamed file is judged against what its old path held, so moving a file does not count its hatches as new.
  const dirty: Baseline["dirty"] = {};
  for (const r of renamed) {
    let before = "";
    try {
      before = git(root, ["show", `${head}:${r.from}`]);
    } catch {
      before = "";
    }
    dirty[r.to] = { hash: `renamed-from:${r.from}`, hatches: findHatches(r.to, before).map((h) => h.text) };
  }
  const baseline: Baseline = { root, head, taken: new Date().toISOString(), clean: true, dirty };
  const changed = changedFiles(baseline).map((c) => c.file);
  const config = readConfig(root);
  const rules = readRules(root);
  const findings: Finding[] = [];
  for (const file of changed) findings.push(...fileFindings({ baseline, file, rules, ...(config.comments ? { comments: config.comments } : {}) }).findings.filter((f) => f.blocking));
  const allowed = allowedByTrailers(git(root, ["log", `--format=%(trailers:key=${ALLOW_TRAILER},valueonly)`, `${head}..HEAD`]));
  const checks = (config.checks ?? []).filter((c) => c.stage !== "trial" && (only.length === 0 || only.includes(c.name)));
  const ran: string[] = [];
  for (const check of checks) {
    const isProtected = builtinName(check.command) === "protected";
    // Deleted files and the old paths of renamed ones matter only to protected paths: the other checks read files.
    const candidates = isProtected ? [...new Set([...changed, ...deleted, ...renamed.map((r) => r.from)])] : changed;
    let matching = check.when ? candidates.filter((f) => matchesAny(f, check.when ?? [])) : candidates;
    if (isProtected) matching = matching.filter((f) => !matchesAny(f, allowed));
    if (matching.length === 0) continue;
    ran.push(check.name);
    const r = run(root, check, matching, head, timeoutS);
    if (r.status === 0) continue;
    const why = r.status === 127 || r.status === 124 ? `could not run (exit ${r.status}); in CI that fails` : `exit ${r.status}`;
    findings.push({ kind: "check", title: `${check.name} fails, ${why}`, detail: r.output.split(/\r?\n/).filter((l) => l.trim() !== "").slice(-25).join("\n"), fix: "Fix what the check reports in the changed files.", blocking: true });
  }
  return { base: head, changed, findings, ran, allowed };
};

const run = (root: string, check: CheckCmd, files: string[], head: string, timeoutS: number): { status: number; output: string } => {
  const limit = Math.min(check.timeoutS ?? 120, timeoutS) * 1000;
  if (builtinName(check.command) !== null) {
    const r = runBuiltin({ command: check.command, root, files, deadline: Date.now() + limit, head, spec: { ...(check.build ? { build: check.build } : {}), ...(check.into ? { into: check.into } : {}) } });
    return { status: r.status, output: r.output };
  }
  const command = check.command.split("{files}").join(files.map((f) => shellArg(f)).join(" "));
  const r = runBounded({ command, cwd: root, timeoutMs: limit, env: { ...process.env, RATCHET_CHILD: "1" } });
  return { status: r.timedOut ? 124 : r.status, output: `${r.stdout}\n${r.stderr}` };
};
