// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnose, type DoctorProbes } from "../src/harness/doctor.ts";

const cfg = { port: 4000, expectedVersion: "b1" };
const good: DoctorProbes = {
  process: async () => ({ pid: 10, startedByUs: true }),
  version: async () => "b1",
  portOwner: async () => 10,
  realPath: async () => ({ ok: true }),
};
const codes = async (p: Partial<DoctorProbes>): Promise<string[]> => (await diagnose({ ...good, ...p }, cfg)).reasons.map((r) => r.code);

test("all probes good is ready with no reasons", async () => {
  assert.deepEqual(await diagnose(good, cfg), { ready: true, reasons: [] });
});

test("a port that answers is not ready when the real path is broken", async () => {
  const d = await diagnose({ ...good, realPath: async () => ({ ok: false, detail: "blank page" }) }, cfg);
  assert.equal(d.ready, false);
  assert.deepEqual(d.reasons.map((r) => r.code), ["path-broken"]);
  assert.match(d.reasons[0]?.message ?? "", /blank page/);
});

test("each fault gives its own reason, each with a fix", async () => {
  assert.deepEqual(await codes({ process: async () => null }), ["process-down", "port-foreign"]);
  assert.deepEqual(await codes({ process: async () => ({ pid: 10, startedByUs: false }) }), ["foreign-process"]);
  assert.deepEqual(await codes({ version: async () => "other" }), ["wrong-version"]);
  assert.deepEqual(await codes({ portOwner: async () => null }), ["port-free"]);
  assert.deepEqual(await codes({ portOwner: async () => 99 }), ["port-foreign"]);
  const d = await diagnose({ ...good, version: async () => "x", portOwner: async () => 99 }, cfg);
  assert.equal(d.reasons.length, 2);
  assert.ok(d.reasons.every((r) => r.fix.length > 10));
});

test("a foreign server on the port that answers is not ready", async () => {
  const d = await diagnose({ ...good, process: async () => null, portOwner: async () => 77 }, cfg);
  assert.equal(d.ready, false);
  assert.deepEqual(d.reasons.map((r) => r.code), ["process-down", "port-foreign"]);
});

test("a throwing probe is not ready and says which probe", async () => {
  const d = await diagnose({ ...good, version: async () => { throw new Error("boom"); } }, cfg);
  assert.equal(d.ready, false);
  assert.deepEqual(d.reasons.map((r) => r.code), ["probe-failed"]);
  assert.match(d.reasons[0]?.message ?? "", /version probe threw: boom/);
});

test("a missing real-path probe is refused at run time", async () => {
  const bad = { ...good } as Partial<DoctorProbes>;
  delete bad.realPath;
  const d = await diagnose(bad as DoctorProbes, cfg);
  assert.equal(d.ready, false);
  assert.deepEqual(d.reasons.map((r) => r.code), ["no-real-path-probe"]);
});
