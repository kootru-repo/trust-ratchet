import assert from "node:assert/strict";
import type os from "node:os";
import { test } from "node:test";
import { countProcesses, cpuPercent, decideLaunch, DEFAULT_LIMITS, type Machine } from "../src/swarm/launchgate.ts";
import { judgeWorker, showsNothingNew, stuckWorkers } from "../src/swarm/stuck.ts";
import { coverage } from "../src/swarm/slices.ts";

const calm: Machine = { ramPercent: 50, cpuPercent: 20, processes: 4, workers: 1 };

test("K6: start on a calm machine, wait on each limit", () => {
  assert.deepEqual(decideLaunch(calm), { start: true });
  assert.equal(decideLaunch({ ...calm, ramPercent: 90 }).start, false);
  assert.equal(decideLaunch({ ...calm, ramPercent: 89.9 }).start, true);
  assert.equal(decideLaunch({ ...calm, workers: 3 }).start, false);
  assert.equal(decideLaunch({ ...calm, workers: 2 }).start, true);
  const all = decideLaunch({ ramPercent: 95, cpuPercent: 99, processes: 20, workers: 5 });
  assert.equal(all.start === false && all.reasons.length, 4);
  assert.equal(decideLaunch({ ...calm, workers: 5 }, { ...DEFAULT_LIMITS, maxWorkers: 6 }).start, true);
});

test("K6: process count and cpu percent readers", () => {
  const win = ['"claude.exe","1","Console"', '"node.exe","2","Console"', '"chrome.exe","3","x"', '"nodemon.exe","4","x"'].join("\r\n");
  assert.equal(countProcesses(win), 2);
  assert.equal(countProcesses("/usr/bin/node\nclaude\nbash\n"), 2);
  const t = (idle: number, user: number): os.CpuInfo => ({ model: "", speed: 0, times: { user, nice: 0, sys: 0, idle, irq: 0 } });
  assert.equal(cpuPercent([t(0, 0)], [t(50, 50)]), 50);
  assert.equal(cpuPercent([t(0, 0)], [t(0, 0)]), 0);
});

test("K10: stuck by side effects past the stuck-after time", () => {
  const w = { id: "a", startedAt: 1000, lastActivityAt: 5000 };
  assert.equal(judgeWorker(w, 5500, 1000), "running");
  assert.equal(judgeWorker(w, 6001, 1000), "stuck");
  assert.equal(judgeWorker({ id: "b", startedAt: 1000 }, 2001, 1000), "stuck");
  assert.equal(judgeWorker({ id: "b", startedAt: 1000 }, 1500, 1000), "running");
  assert.equal(judgeWorker({ ...w, endedAt: 5200 }, 99999, 1000), "finished");
  assert.deepEqual(stuckWorkers([w, { id: "c", startedAt: 5900 }], 6500, 1000), ["a"]);
});

test("K10: growth of the transcript or a file is new, silence is not", () => {
  const p = { transcriptBytes: 100, fileMtimes: { "a.ts": 10 } };
  assert.equal(showsNothingNew(p, { ...p }), true);
  assert.equal(showsNothingNew(p, { ...p, transcriptBytes: 101 }), false);
  assert.equal(showsNothingNew(p, { ...p, fileMtimes: { "a.ts": 11 } }), false);
  assert.equal(showsNothingNew(p, { ...p, fileMtimes: { "a.ts": 10, "b.ts": 1 } }), false);
});

const ok = '{"status":"PASS","heads":["abc1234"],"method":"ran tests"}';

test("K2: a missing result is a gap, never a pass; N-1 proceeds with a note", () => {
  const c = coverage(["s1", "s2", "s3"], { s1: { report: ok }, s2: {} });
  assert.deepEqual(c.gaps, ["s2", "s3"]);
  assert.equal(c.allPass, false);
  assert.equal(c.mayProceed, true);
  assert.match(c.note, /1 of 3/);
  const full = coverage(["s1"], { s1: { report: ok } });
  assert.equal(full.allPass, true);
  assert.deepEqual(full.gaps, []);
});

test("K2: unparseable and ISSUES results, extra slices, none returned", () => {
  const issues = '{"status":"ISSUES","heads":["abc1234"],"method":"m"}';
  const c = coverage(["s1", "s2"], { s1: { report: "done, all good" }, s2: { report: issues }, extra: { report: ok } });
  assert.deepEqual(c.gaps, ["s1"]);
  assert.equal(c.allPass, false);
  assert.equal(c.lines.length, 2);
  assert.equal(coverage(["s1"], {}).mayProceed, false);
  assert.equal(coverage([], {}).allPass, false);
  assert.equal(coverage(["toString"], {}).gaps[0], "toString");
});
