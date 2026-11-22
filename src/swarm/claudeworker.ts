// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { SpawnRequest, WorkerEnd, WorkerHandle } from "./orchestrator.ts";

/**
 * The real worker: `claude -p` in `root`, prompt on stdin, the guard's RATCHET_SWARM_* variables and no API key
 * (req.env comes from workerEnv, which strips every billing variable). Not run by the tests.
 */
export const spawnClaudeWorker =
  (root: string, settingsFile: string, model = "haiku", extraArgs: string[] = [], bin = "claude") =>
  (req: SpawnRequest): WorkerHandle => {
    const args = bin === "claude" ? ["-p", "--model", model, "--permission-mode", "acceptEdits", "--allowedTools", "Read,Edit,Write,Bash,Glob,Grep", "--settings", settingsFile, ...extraArgs] : extraArgs;
    const child = spawn(bin, args, {
      cwd: root,
      env: req.env,
      shell: process.platform === "win32" && bin === "claude",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let bytes = 0;
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
      bytes += c.length;
    });
    child.stderr.on("data", (c: Buffer) => {
      bytes += c.length;
    });
    child.stdin.end(req.slice.prompt);
    const git = (args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const done = new Promise<WorkerEnd>((resolve) => {
      child.on("error", (e) => resolve({ report: `the worker could not start: ${e.message}` }));
      child.on("close", () => {
        // A new file is untracked and `git diff` would not show it: the orchestrator (never the worker) marks every new file as intended so the patch carries it.
        git(["add", "--intent-to-add", "--all"]);
        resolve({ report: out, diff: git(["diff"]), files: git(["diff", "--name-only"]).split("\n").filter(Boolean), base: git(["rev-parse", "--short", "HEAD"]).trim() });
      });
    });
    const mtimes = (): Record<string, number> => {
      const m: Record<string, number> = {};
      for (const f of req.slice.files) {
        if (f.endsWith("/")) continue;
        try {
          m[f] = fs.statSync(path.join(root, f)).mtimeMs;
        } catch {
          // not written yet
        }
      }
      return m;
    };
    return { author: `worker-${req.slice.id}`, done, probe: () => ({ transcriptBytes: bytes, fileMtimes: mtimes() }), stop: () => void child.kill() };
  };
