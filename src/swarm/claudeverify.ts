// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from "node:child_process";
import type { ClaudeCall } from "./verifier.ts";

/**
 * The real read-only verifier call: `claude -p` in the clone, the prompt on stdin, the guard's settings file
 * (a verifier may write nothing) and the environment the caller built (no API key: see subscription.ts).
 * `bin` and `extraArgs` exist so a test can stand in a small program for claude. Not run live by the tests.
 */
export const claudeReadOnly =
  ({ settingsFile, model = "opus", bin = "claude", extraArgs = [], timeoutMs = 600_000 }: { settingsFile: string; model?: string; bin?: string; extraArgs?: string[]; timeoutMs?: number }): ClaudeCall =>
  (req) =>
    new Promise<string>((resolve, reject) => {
      const args = bin === "claude" ? ["-p", "--model", model, "--permission-mode", "default", "--allowedTools", "Read,Glob,Grep", "--settings", settingsFile, ...extraArgs] : extraArgs;
      const child = spawn(bin, args, { cwd: req.cwd, env: req.env, shell: process.platform === "win32" && bin === "claude", stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`verifier session timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      child.stdout.on("data", (c: Buffer) => void (out += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => void (err += c.toString("utf8")));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(`verifier session exited ${code}: ${err.slice(0, 500)}`));
      });
      child.stdin.end(req.prompt);
    });
