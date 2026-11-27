// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from "node:child_process";
import { forShell } from "../shellcmd.ts";

/**
 * Runs a shell command and, when it runs out of time, kills every process it started, not only the shell. Node's own
 * timeout kills just the shell, and on Windows the shell's children (npx, then node, then tsc) keep running; at every
 * turn end that adds processes nobody stops. A small Node supervisor starts the command in a process group (a new
 * group on Linux and macOS, `taskkill /T` on Windows) and kills the group at the deadline.
 *
 * The supervisor reads the command's output itself and stops waiting once the command has exited, so a process the
 * build leaves running (a daemon holding the output pipe) cannot make a finished build look out of time. A timeout is
 * told by a marker line, not by an exit code the command could give itself.
 *
 * Known limit: on Windows a grandchild whose own parent has already exited is outside the tree `taskkill /T` follows
 * (a launcher that hands off and exits). Catching that needs a Job Object, which Node cannot create without a native module.
 */
export const TIMEOUT_MARK = "__ratchet_supervisor_timeout__";

const SUPERVISOR = [
  'const { spawn, execFileSync } = require("node:child_process");',
  "const ms = Number(process.argv[1]);",
  "const win = process.platform === 'win32';",
  "const c = spawn(process.argv[2], { shell: true, stdio: ['ignore', 'pipe', 'pipe'], detached: !win, windowsHide: true });",
  "c.stdout.on('data', (d) => process.stdout.write(d));",
  "c.stderr.on('data', (d) => process.stderr.write(d));",
  "const kill = () => { try { if (win) execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else process.kill(-c.pid, 'SIGKILL'); } catch {} };",
  "const leave = (code) => { c.stdout.destroy(); c.stderr.destroy(); process.stdout.write('', () => process.stderr.write('', () => process.exit(code))); };",
  `const t = setTimeout(() => { kill(); process.stderr.write('\\n${TIMEOUT_MARK}\\n'); leave(124); }, ms);`,
  "c.on('exit', (code, signal) => { clearTimeout(t); setTimeout(() => leave(code ?? (signal ? 1 : 0)), 100); });",
  "c.on('error', () => { clearTimeout(t); leave(127); });",
].join("\n");

export type Bounded = { status: number; stdout: string; stderr: string; timedOut: boolean; tooMuch: boolean };

export const runBounded = ({ command, cwd, timeoutMs, env = process.env }: { command: string; cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Bounded => {
  const r = spawnSync(process.execPath, ["-e", SUPERVISOR, String(Math.max(1, Math.floor(timeoutMs))), forShell(command)], { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs + 10_000, windowsHide: true });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  const stderr = r.stderr ?? "";
  const timedOut = stderr.includes(TIMEOUT_MARK) || (r.status === null && code === "ETIMEDOUT");
  return { status: r.status ?? (timedOut ? 124 : 1), stdout: r.stdout ?? "", stderr: stderr.split(`\n${TIMEOUT_MARK}\n`).join(""), timedOut, tooMuch: code === "ENOBUFS" };
};
