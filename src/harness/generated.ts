// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runBounded } from "./runtree.ts";

/**
 * Generated outputs (A4): files built from sources and committed, such as compiled browser scripts. A config names
 * the check by hand: `{ "command": "builtin:generated", "when": ["web/src/**"], "build": "cd web && npx --no-install
 * tsc -p . --outDir {out}", "into": "static/js" }`. At a turn end it builds into a temporary folder ({out}), never into
 * the working tree, so the tree cannot fix itself and hide the drift, and compares each file built with the one of the
 * same name under `into`. Line endings are compared as LF.
 */
export type GeneratedSpec = { build?: string; into?: string };

const walk = (dir: string, base = dir): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) return walk(abs, base);
    return e.isFile() ? [path.relative(base, abs).split(path.sep).join("/")] : [];
  });


/** Pure: text that line endings may be compared on as LF: no NUL byte, and valid UTF-8. */
const isText = (b: Buffer): boolean => !b.includes(0) && Buffer.from(b.toString("utf8"), "utf8").equals(b);
/** Pure: the same content: equal bytes, or for text the same once CR LF is read as LF. */
export const sameContent = (a: Buffer, b: Buffer): boolean => a.equals(b) || (isText(a) && isText(b) && a.toString("utf8").replace(/\r\n/g, "\n") === b.toString("utf8").replace(/\r\n/g, "\n"));

const extOf = (rel: string): string => path.posix.extname(rel).toLowerCase();

/**
 * Pure: the files built that the committed folder lacks or holds differently, and the committed files the build no
 * longer makes. Only files of a kind the build makes (by extension) count as extras, so a folder that also holds
 * hand-written files (styles, pages) is not flagged for them.
 */
export const driftOf = ({ built, committed, committedFiles = [] }: { built: Map<string, Buffer>; committed: (rel: string) => Buffer | null; committedFiles?: string[] }): { missing: string[]; differ: string[]; extra: string[] } => {
  const missing: string[] = [];
  const differ: string[] = [];
  for (const [rel, bytes] of [...built.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const have = committed(rel);
    if (have === null) missing.push(rel);
    else if (!sameContent(have, bytes)) differ.push(rel);
  }
  const kinds = new Set([...built.keys()].map(extOf));
  const extra = committedFiles.filter((rel) => !built.has(rel) && kinds.has(extOf(rel))).sort();
  return { missing, differ, extra };
};

/** Pure: the build command with {out} as one quoted path. A config that quoted {out} itself is not quoted twice. Null with no {out}. */
export const buildCommand = (build: string, out: string): string | null => {
  if (!build.includes("{out}")) return null;
  return build.split('"{out}"').join("{out}").split("'{out}'").join("{out}").split("{out}").join(`"${out}"`);
};

const gitStatus = (root: string): string => {
  try {
    return execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
};

/**
 * The generated-outputs check. `files` are the changed source files that started it, named on each line. A build that
 * writes into the working tree anyway is reported, since it would hide the drift it is meant to find.
 */
export const generatedCheck = ({ root, files, spec, deadline = Infinity }: { root: string; files: string[]; spec: GeneratedSpec; deadline?: number }): { status: number; output: string } => {
  if (!spec.build || !spec.into) return { status: 127, output: 'builtin:generated: command not found (the check needs "build" with {out} and "into" in its config entry)' };
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-gen-"));
  const named = `${files.slice(0, 5).join(", ")}${files.length > 5 ? ", ..." : ""}`;
  try {
    const command = buildCommand(spec.build, out);
    if (command === null) return { status: 127, output: 'builtin:generated: command not found (its "build" has no {out}, so it would write into the working tree)' };
    const leftMs = deadline - Date.now();
    if (leftMs < 1000) return { status: 124, output: "builtin:generated ran out of time" };
    const before = gitStatus(root);
    // At the deadline every process the build started is killed, not only its shell.
    const ran = runBounded({ command, cwd: root, timeoutMs: Number.isFinite(leftMs) ? leftMs : 24 * 3600 * 1000, env: { ...process.env, RATCHET_CHILD: "1" } });
    if (ran.timedOut) return { status: 124, output: "builtin:generated ran out of time" };
    if (ran.status !== 0 || ran.tooMuch) {
      const said = ran.tooMuch ? "(it printed more than 64 MB)" : `${ran.stdout}\n${ran.stderr}`.trim().split(/\r?\n/).slice(-6).join("\n");
      return { status: 1, output: `${named}: the build of the generated files fails (${spec.build}):\n${said}` };
    }
    if (gitStatus(root) !== before) return { status: 1, output: `${named}: the build changed files in the working tree; it must write only into {out} (${spec.build})` };
    const built = new Map(walk(out).map((rel) => [rel, fs.readFileSync(path.join(out, rel))] as const));
    if (built.size === 0) return { status: 1, output: `${named}: the build wrote nothing into {out}; check that "build" writes its output there (${spec.build})` };
    const into = spec.into.replace(/\\/g, "/").replace(/\/+$/, "");
    const intoAbs = path.join(root, into);
    const committedFiles = fs.existsSync(intoAbs) ? walk(intoAbs) : [];
    const { missing, differ, extra } = driftOf({
      built,
      committedFiles,
      committed: (rel) => {
        try {
          return fs.readFileSync(path.join(intoAbs, rel));
        } catch {
          return null;
        }
      },
    });
    if (missing.length + differ.length + extra.length === 0) return { status: 0, output: "" };
    const rebuild = spec.build.split("{out}").join(into);
    const lines = [
      ...differ.map((r) => `${into}/${r}: differs from what its sources build`),
      ...missing.map((r) => `${into}/${r}: is built from its sources but missing`),
      ...extra.map((r) => `${into}/${r}: is no longer built from its sources; remove it if nothing else makes it`),
    ];
    return { status: 1, output: lines.map((l) => `${l} (sources changed here: ${named}). Rebuild with: ${rebuild}`).join("\n") };
  } finally {
    try {
      fs.rmSync(out, { recursive: true, force: true });
    } catch {
      // A build process still holding the folder (Windows) must not replace the check's answer.
    }
  }
};
