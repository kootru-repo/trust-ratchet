// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runBounded } from "../src/harness/runtree.ts";

const sleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
const tmp = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-tree-")));

test("a command that runs out of time is stopped with every process it started", () => {
  const dir = tmp();
  const marker = path.join(dir, "beat.txt");
  // The command starts a grandchild that writes a beat every 50 ms, waits for its first beat, then waits forever.
  fs.writeFileSync(path.join(dir, "beat.cjs"), `setInterval(() => require("fs").appendFileSync(${JSON.stringify(marker)}, "x"), 50);\n`);
  fs.writeFileSync(path.join(dir, "start.cjs"), `require("child_process").spawn(process.execPath, [${JSON.stringify(path.join(dir, "beat.cjs"))}], { stdio: "ignore" });\nconst fs = require("fs");\nconst wait = setInterval(() => { if (fs.existsSync(${JSON.stringify(marker)})) { clearInterval(wait); console.log("beating"); setInterval(() => {}, 1000); } }, 20);\n`);
  const started = Date.now();
  const r = runBounded({ command: `node "${path.join(dir, "start.cjs")}"`, cwd: dir, timeoutMs: 6000 });
  assert.equal(r.timedOut, true);
  assert.match(r.stdout, /beating/);
  assert.doesNotMatch(r.stderr, /__ratchet_supervisor_timeout__/);
  assert.ok(Date.now() - started < 15_000);
  sleep(300);
  const size = fs.statSync(marker).size;
  sleep(600);
  assert.equal(fs.statSync(marker).size, size, "the grandchild was stopped");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a finished command gives its status and output, exit 124 of its own is not a timeout, and a process it leaves running does not hold it", () => {
  const dir = tmp();
  const ok = runBounded({ command: 'node -e "console.log(41 + 1); process.exit(3)"', cwd: dir, timeoutMs: 20_000 });
  assert.deepEqual({ status: ok.status, out: ok.stdout.trim(), timedOut: ok.timedOut }, { status: 3, out: "42", timedOut: false });
  const own124 = runBounded({ command: 'node -e "console.error(\'real error\'); process.exit(124)"', cwd: dir, timeoutMs: 20_000 });
  assert.deepEqual({ status: own124.status, timedOut: own124.timedOut }, { status: 124, timedOut: false });
  assert.match(own124.stderr, /real error/);
  // A launcher that leaves a daemon holding the output pipe: the build is done when its command is.
  fs.writeFileSync(path.join(dir, "daemon.cjs"), "setTimeout(() => {}, 4000);\n");
  fs.writeFileSync(path.join(dir, "launch.cjs"), `require("child_process").spawn(process.execPath, [${JSON.stringify(path.join(dir, "daemon.cjs"))}], { stdio: "inherit", detached: true }).unref();\nconsole.log("built");\n`);
  const started = Date.now();
  const daemon = runBounded({ command: `node "${path.join(dir, "launch.cjs")}"`, cwd: dir, timeoutMs: 20_000 });
  assert.deepEqual({ status: daemon.status, timedOut: daemon.timedOut, out: daemon.stdout.trim() }, { status: 0, timedOut: false, out: "built" });
  assert.ok(Date.now() - started < 3500, "it did not wait for the daemon");
  sleep(4500);
  fs.rmSync(dir, { recursive: true, force: true });
});
