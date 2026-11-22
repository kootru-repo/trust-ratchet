// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { VerdictWord } from "../harness/mergeclass.ts";
import { subscriptionEnv } from "../subscription.ts";
import type { Verify, VerifierReport } from "./orchestrator.ts";
import { applyPatch } from "./patch.ts";
import { parseResult, patchId, type Check, type Handover } from "./verdict.ts";

/** What the injected claude call gets: a read-only session in `cwd` with the guard environment (no API key). Returns the session's text. */
export type ClaudeCall = (req: { cwd: string; env: Record<string, string>; prompt: string }) => Promise<string>;

export type VerifierOptions = {
  /** The target repository: cloned, never modified. */
  repo: string;
  /** Where the clones and the evidence go. */
  workDir: string;
  /** The project's checks, run by the verifier itself in the patched clone. */
  checks: string[];
  /** Commands from `checks` that must pass on the patched tree whatever the base does (see Check.mustPass). */
  mustPass?: string[];
  claude: ClaudeCall;
  holdFile?: string;
  env?: Record<string, string | undefined>;
  checkTimeoutMs?: number;
};

const git = (cwd: string, args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const clone = (repo: string, dest: string, base: string): void => {
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", repo, dest], { stdio: ["ignore", "pipe", "pipe"] });
  git(dest, ["checkout", "--quiet", "--detach", base]);
};

const runCheck = (cwd: string, command: string, timeout: number, env: Record<string, string>): { exit: number; output: string } => {
  const r = spawnSync(command, { cwd, shell: true, encoding: "utf8", timeout, env });
  return { exit: r.status ?? 1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

const briefing = (h: Handover, checks: Check[]): string =>
  [
    "You are a read-only verifier. Do not edit, create or delete any file. You did not write this patch.",
    `Task ${h.task}, patch ${h.patchId}, base ${h.base}. The patch is already applied in the current directory.`,
    `The orchestrator ran these checks: ${checks.map((c) => `${c.command} (exit ${c.exit})`).join("; ") || "none"}.`,
    'Read the change (git diff) and judge it. End your reply with one JSON object: {"status":"PASS|ISSUES|BLOCKED","heads":["<base commit sha>"],"method":"what you did"}.',
  ].join("\n");

/** a verifier in a separate clone that runs the checks itself and proves it wrote nothing. */
export const makeVerifier = (o: VerifierOptions): Verify => {
  let n = 0;
  return async (handover, diff): Promise<VerifierReport> => {
    const id = patchId(diff);
    const verifier = handover.author === `verifier-${handover.task}` ? `verifier-${handover.task}-2` : `verifier-${handover.task}`;
    const dir = path.resolve(o.workDir, `${handover.task}-${++n}`);
    const evidenceFile = `${dir}.evidence.txt`;
    const log: string[] = [];
    const report = (verdict: VerdictWord, status: VerifierReport["status"], method: string, checks: Check[]): VerifierReport => {
      fs.mkdirSync(o.workDir, { recursive: true });
      fs.writeFileSync(evidenceFile, `${log.join("\n")}\n`);
      return { verifier, patchId: id, verdict, evidence: [evidenceFile], status, method, checks };
    };
    fs.mkdirSync(o.workDir, { recursive: true });
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(subscriptionEnv(o.env ?? process.env))) if (v !== undefined) clean[k] = v;
    const timeout = o.checkTimeoutMs ?? 10 * 60 * 1000;
    const base = handover.base || "HEAD";
    try {
      clone(o.repo, dir, base);
      const applied = applyPatch(dir, diff);
      log.push(`apply: ${applied.state} ${applied.message}`);
      if (applied.state === "conflict") return report("INCONCLUSIVE", "BLOCKED", "patch does not apply to the base in a clean clone", []);
      const checks: Check[] = [];
      for (const command of o.checks) {
        const r = runCheck(dir, command, timeout, clean);
        log.push(`check ${command}: exit ${r.exit}\n${r.output.slice(-2000)}`);
        const c: Check = { command, exit: r.exit, ...(o.mustPass?.includes(command) ? { mustPass: true } : {}) };
        if (r.exit !== 0) {
          const baseDir = `${dir}-base`;
          try {
            clone(o.repo, baseDir, base);
            c.baseExit = runCheck(baseDir, command, timeout, clean).exit;
            log.push(`check ${command} on base: exit ${c.baseExit}`);
          } finally {
            fs.rmSync(baseDir, { recursive: true, force: true });
          }
        }
        checks.push(c);
      }
      const before = git(dir, ["status", "--porcelain"]);
      let text = "";
      try {
        text = await o.claude({
          cwd: dir,
          env: { ...clean, RATCHET_SWARM_ROLE: "verifier", RATCHET_SWARM_ROOT: dir, RATCHET_SWARM_ALLOW: "", RATCHET_SWARM_HOLD: o.holdFile ?? "", RATCHET_SWARM_LOG: `${dir}.refusals.jsonl` },
          prompt: briefing(handover, checks),
        });
      } catch (e) {
        log.push(`claude failed: ${e instanceof Error ? e.message : String(e)}`);
        return report("INCONCLUSIVE", "BLOCKED", "the verifier session failed", checks);
      }
      log.push(`claude: ${text.slice(-2000)}`);
      const after = git(dir, ["status", "--porcelain"]);
      if (after !== before) {
        log.push(`status changed:\n${before}\n--- after ---\n${after}`);
        return report("INCONCLUSIVE", "BLOCKED", "the read-only verifier wrote to its tree; result refused (K14)", checks);
      }
      const parsed = parseResult(text);
      if (parsed.gap) return report("INCONCLUSIVE", "BLOCKED", `verifier result unusable: ${parsed.reason}`, checks);
      const held = checks.every((c) => c.exit === 0 || (c.mustPass !== true && c.baseExit !== undefined && c.baseExit !== 0));
      if (parsed.status === "PASS" && held && checks.some((c) => c.exit === 0)) return report("VERIFIED", "PASS", parsed.method, checks);
      return report("NOT VERIFIED", parsed.status === "PASS" ? "ISSUES" : parsed.status, parsed.method, checks);
    } catch (e) {
      log.push(`error: ${e instanceof Error ? e.message : String(e)}`);
      return report("INCONCLUSIVE", "BLOCKED", "the verifier could not run", []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
};
