import assert from "node:assert/strict";
import { test } from "node:test";
import { checkGenerated, genArray, genInt, halveArray, halveNumber, inputAt, makeRng, runProperty } from "../src/harness/props.ts";

const gen = genArray(genInt(0, 1000), 20);

test("the same seed gives the same stream and another seed another", () => {
  const a = Array.from({ length: 5 }, makeRng(7).next);
  const b = Array.from({ length: 5 }, makeRng(7).next);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, Array.from({ length: 5 }, makeRng(8).next));
});

test("a true property passes the whole budget with many distinct inputs", () => {
  const r = runProperty({ seed: 1, cases: 200, gen, prop: (xs) => [...xs].reverse().reverse().length === xs.length });
  assert.equal(r.failure, null);
  assert.equal(r.cases, 200);
  assert.ok(r.distinct > 100);
});

test("a planted fault is found, shrunk by halving, and replays from its seed", () => {
  const prop = (xs: number[]): boolean => !xs.some((x) => x > 900);
  const r = runProperty({ seed: 3, cases: 200, gen, prop, shrink: halveArray });
  assert.ok(r.failure);
  const f = r.failure;
  assert.ok(f.shrunk.length <= f.input.length);
  assert.ok(f.shrunk.length <= 1);
  assert.equal(prop(f.shrunk), false);
  assert.deepEqual(inputAt(gen, f.seed, f.caseIndex), f.input);
  assert.deepEqual(runProperty({ seed: 3, cases: 200, gen, prop, shrink: halveArray }), r);
});

test("a throwing property is a failure and numbers halve toward zero", () => {
  const r = runProperty({ seed: 5, cases: 50, gen: genInt(100, 10000), prop: (n) => { if (n > 50) throw new Error("too big"); }, shrink: halveNumber });
  assert.ok(r.failure);
  assert.equal(r.failure.error, "too big");
  assert.ok(r.failure.shrunk > 50 && r.failure.shrunk <= 100);
});

test("the generated check accepts a generator and records its seed", () => {
  const c = checkGenerated({ gen, seed: 42, cases: 100 });
  assert.equal(c.ok, true);
  assert.equal(c.seed, 42);
  assert.ok(c.distinct >= 50);
});

test("a hand-written list, a fixed generator and a one-value generator are refused", () => {
  const handwritten = checkGenerated({ gen, seed: 42, cases: 10, inputs: [[1], [2], [3], [4], [5], [6], [7], [8], [9], [10]] });
  assert.equal(handwritten.ok, false);
  assert.match(handwritten.reasons.join(" "), /written by hand/);
  const fixed = checkGenerated({ gen: () => [1, 2, 3], seed: 42, cases: 10 });
  assert.equal(fixed.ok, false);
  assert.match(fixed.reasons.join(" "), /fixed|distinct/);
  const generatedInputs = Array.from({ length: 10 }, (_, i) => inputAt(gen, 42, i));
  assert.equal(checkGenerated({ gen, seed: 42, cases: 10, inputs: generatedInputs }).ok, true);
});

import { replayTwice } from "../src/harness/props.ts";
test("replayTwice: a deterministic failure reproduces twice from its seed and index; a flake and a wrong record do not", () => {
  const gen = genInt(0, 1000);
  const report = runProperty({ seed: 7, cases: 500, gen, prop: (n) => n < 900 });
  assert.ok(report.failure);
  const failure = report.failure as NonNullable<typeof report.failure>;
  assert.deepEqual(replayTwice({ gen, prop: (n) => n < 900, failure }), { reproduced: true, runs: 2, reasons: [] });
  let calls = 0;
  const flaky = replayTwice({ gen, prop: () => (calls++ === 0 ? false : true), failure });
  assert.equal(flaky.reproduced, false);
  assert.match(flaky.reasons.join(" "), /flake/);
  const wrong = replayTwice({ gen, prop: (n) => n < 900, failure: { ...failure, caseIndex: failure.caseIndex + 1 } });
  assert.equal(wrong.reproduced, false);
  assert.match(wrong.reasons.join(" "), /different input/);
});
