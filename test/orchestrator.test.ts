// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Machine } from "../src/swarm/launchgate.ts";
import { runSwarm, type RunRecord, type Slice, type SpawnWorker, type Verify, type WorkerEnd, type WorkerHandle } from "../src/swarm/orchestrator.ts";
import { patchId } from "../src/swarm/verdict.ts";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "orch-"));
const okMachine = (): Machine => ({ ramPercent: 10, cpuPercent: 10, processes: 1, workers: 0 });
const report = '{"status":"PASS","heads":["abc1234"],"method":"ran tests"}';
const slice = (id: string): Slice => ({ id, files: [`${id}.js`], prompt: id });
const diffOf = (id: string): string => `diff --git a/${id}.js b/${id}.js\n+${id}\n`;
const good = (id: string): WorkerEnd => ({ report, diff: diffOf(id), files: [`${id}.js`], base: "abc1234" });
const handle = (id: string, end: Promise<WorkerEnd>, o: Partial<WorkerHandle> = {}): WorkerHandle => ({
  author: `w-${id}`,
  done: end,
  probe: () => ({ transcriptBytes: 1, fileMtimes: {} }),
  stop: () => {},
  ...o,
});
const verifier =
  (name: string): Verify =>
  async (_h, diff) => ({ verifier: name, patchId: patchId(diff), verdict: "VERIFIED", evidence: ["log.txt"], status: "PASS", method: "ran suite", checks: [{ command: "npm test", exit: 0 }] });
const base = (dir: string) => ({ holdFile: path.join(dir, "HOLD"), recordFile: path.join(dir, "out", "run.json"), root: dir, pollMs: 5, stuckAfterMs: 60, machine: okMachine, env: { ANTHROPIC_API_KEY: "k", PATH: "p" } });
const finishes: SpawnWorker = ({ slice: s }) => handle(s.id, Promise.resolve(good(s.id)));

test("a stuck worker is stopped and its slice is a gap", async () => {
  const dir = tmp();
  let stopped = false;
  const spawnWorker: SpawnWorker = ({ slice: s }) => (s.id === "a" ? handle("a", Promise.resolve(good("a"))) : handle("b", new Promise<WorkerEnd>(() => {}), { stop: () => void (stopped = true) }));
  const r = await runSwarm({ ...base(dir), slices: [slice("a"), slice("b")], spawnWorker, verify: verifier("v") });
  assert.equal(stopped, true);
  assert.deepEqual(r.stuck, ["b"]);
  assert.deepEqual(r.coverage.gaps, ["b"]);
  assert.deepEqual(r.accepted, ["a"]);
  assert.equal(r.coverage.mayProceed, true);
});

test("a patch verified by its own author is refused", async () => {
  const dir = tmp();
  const r = await runSwarm({ ...base(dir), slices: [slice("a")], spawnWorker: finishes, verify: verifier("w-a") });
  assert.equal(r.outcomes[0]?.state, "refused");
  assert.ok(r.outcomes[0]?.reasons.some((x) => /wrote/.test(x)));
  assert.deepEqual(r.accepted, []);
});

test("a verdict on a stale patch id is refused", async () => {
  const dir = tmp();
  const stale: Verify = async (h, diff) => ({ ...(await verifier("v")(h, diff)), patchId: "0000000000000000" });
  const r = await runSwarm({ ...base(dir), slices: [slice("a")], spawnWorker: finishes, verify: stale });
  assert.equal(r.outcomes[0]?.state, "refused");
});

test("a missing slice result is a gap and N-1 proceeds", async () => {
  const dir = tmp();
  const spawnWorker: SpawnWorker = ({ slice: s }) => handle(s.id, Promise.resolve(s.id === "b" ? {} : good(s.id)));
  const r = await runSwarm({ ...base(dir), slices: [slice("a"), slice("b")], spawnWorker, verify: verifier("v") });
  assert.deepEqual(r.coverage.gaps, ["b"]);
  assert.equal(r.coverage.mayProceed, true);
  assert.equal(r.coverage.allPass, false);
  assert.deepEqual(r.accepted, ["a"]);
});

test("a hold file stops all launches", async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "HOLD"), "stop");
  let spawned = 0;
  const spawnWorker: SpawnWorker = (req) => {
    spawned++;
    return finishes(req);
  };
  const r = await runSwarm({ ...base(dir), slices: [slice("a"), slice("b")], spawnWorker, verify: verifier("v") });
  assert.equal(spawned, 0);
  assert.equal(r.held, true);
  assert.deepEqual(r.coverage.gaps, ["a", "b"]);
});

test("a hold written mid-run stops a running worker", async () => {
  const dir = tmp();
  let stopped = false;
  const spawnWorker: SpawnWorker = ({ slice: s }) => {
    setTimeout(() => fs.writeFileSync(path.join(dir, "HOLD"), "x"), 20);
    return handle(s.id, new Promise<WorkerEnd>(() => {}), { probe: () => ({ transcriptBytes: Date.now(), fileMtimes: {} }), stop: () => void (stopped = true) });
  };
  const r = await runSwarm({ ...base(dir), stuckAfterMs: 10_000, slices: [slice("a")], spawnWorker, verify: verifier("v") });
  assert.equal(stopped, true);
  assert.equal(r.held, true);
  assert.deepEqual(r.coverage.gaps, ["a"]);
});

test("the launch gate delays a start until the machine allows it", async () => {
  const dir = tmp();
  let calls = 0;
  const machine = (): Machine => (++calls <= 3 ? { ramPercent: 95, cpuPercent: 10, processes: 1, workers: 0 } : okMachine());
  const t0 = Date.now();
  const r = await runSwarm({ ...base(dir), machine, slices: [slice("a")], spawnWorker: finishes, verify: verifier("v") });
  assert.ok(calls >= 4);
  assert.ok(Date.now() - t0 >= 10);
  assert.equal(r.launchWaits.length, 1);
  assert.match(r.launchWaits[0]?.reasons[0] ?? "", /RAM/);
  assert.deepEqual(r.accepted, ["a"]);
});

test("the run record is written, and workers get the guard env and no API key", async () => {
  const dir = tmp();
  let env: Record<string, string> = {};
  const spawnWorker: SpawnWorker = (req) => {
    env = req.env;
    return finishes(req);
  };
  await runSwarm({ ...base(dir), slices: [slice("a")], spawnWorker, verify: verifier("v") });
  const written = JSON.parse(fs.readFileSync(path.join(dir, "out", "run.json"), "utf8")) as RunRecord;
  assert.deepEqual(written.accepted, ["a"]);
  assert.equal(env.RATCHET_SWARM_ROLE, "worker");
  assert.equal(env.RATCHET_SWARM_ALLOW, "a.js");
  assert.equal(env.RATCHET_SWARM_HOLD, path.join(dir, "HOLD"));
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
});

test("an accepted patch whose worker wrote no JSON line is not a coverage gap", async () => {
  const dir = tmp();
  const spawnWorker: SpawnWorker = ({ slice: s }) => handle(s.id, Promise.resolve({ ...good(s.id), report: "done, plain words" }));
  const r = await runSwarm({ ...base(dir), slices: [slice("a")], spawnWorker, verify: verifier("v") });
  assert.deepEqual(r.accepted, ["a"]);
  assert.deepEqual(r.coverage.gaps, []);
  assert.equal(r.coverage.allPass, true);
});

test("a refused patch is not an all-pass coverage line, even with a worker JSON line that says PASS", async () => {
  const dir = tmp();
  const r = await runSwarm({ ...base(dir), slices: [slice("a")], spawnWorker: finishes, verify: verifier("w-a") });
  assert.equal(r.outcomes[0]?.state, "refused");
  assert.equal(r.coverage.allPass, false);
});

test("each slice's worker gets its own root", async () => {
  const dir = tmp();
  const roots: Record<string, string | undefined> = {};
  const spawnWorker: SpawnWorker = ({ slice: s, env }) => {
    roots[s.id] = env.RATCHET_SWARM_ROOT;
    return handle(s.id, Promise.resolve(good(s.id)));
  };
  await runSwarm({ ...base(dir), slices: [{ ...slice("a"), root: "/wt/a" }, slice("b")], spawnWorker, verify: verifier("v") });
  assert.equal(roots.a, "/wt/a");
  assert.equal(roots.b, dir);
});
