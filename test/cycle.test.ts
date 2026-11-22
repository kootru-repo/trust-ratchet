import assert from "node:assert/strict";
import { test } from "node:test";
import { resetForAttempt, startCycle, step, type Budget, type ExitPredicate } from "../src/harness/cycle.ts";

const pred: ExitPredicate = { metric: "failures", op: "<=", target: 0 };
const budget: Budget = { maxIterations: 6, maxFiles: 3, maxLines: 50, plateauAfter: 2 };
const patch = { files: 1, lines: 10 };
const hi = [5, 5, 6, 5, 5];
const lo = [2, 2, 3, 2, 2];
const zero = [0, 0, 0, 0, 0];

test("keeps an advance, ends done when predicate met with n", () => {
  let r = step(startCycle(pred, budget), { predicate: pred, base: hi, candidate: lo, patch });
  assert.equal(r.action, "keep");
  r = step(r.state, { predicate: pred, base: lo, candidate: zero, patch });
  assert.equal(r.action, "done");
  assert.equal(r.state.ended?.kind, "done");
  assert.equal(step(r.state, { predicate: pred, base: hi, candidate: lo, patch }).action, "refuse");
});

test("a changed predicate ends as condition changed, never done", () => {
  const r = step(startCycle(pred, budget), { predicate: { ...pred, target: 3 }, base: hi, candidate: lo, patch });
  assert.equal(r.action, "refuse");
  assert.equal(r.state.ended?.kind, "condition-changed");
});

test("no claim without n: too few runs discard", () => {
  const r = step(startCycle(pred, budget), { predicate: pred, base: [5, 5], candidate: [0, 0], patch });
  assert.equal(r.action, "discard");
  assert.equal(r.verdict?.word, "inconclusive");
});

test("an attempt that does not help is discarded; plateau pivots and never stops", () => {
  const s = startCycle(pred, budget);
  let r = step(s, { predicate: pred, base: hi, candidate: hi, patch });
  assert.equal(r.action, "discard");
  r = step(r.state, { predicate: pred, base: hi, candidate: hi, patch });
  assert.equal(r.action, "pivot");
  assert.equal(r.state.ended, null);
  assert.equal(r.state.pivots, 1);
  assert.deepEqual(r.state.predicate, pred);
});

test("risk budget stops with no patch", () => {
  const r = step(startCycle(pred, budget), { predicate: pred, base: hi, candidate: lo, patch: { files: 9, lines: 10 } });
  assert.equal(r.action, "stop");
  assert.equal(r.state.kept, 0);
});

test("effort budget stops", () => {
  const s = startCycle(pred, { ...budget, maxIterations: 1, plateauAfter: 5 });
  const r1 = step(s, { predicate: pred, base: hi, candidate: lo, patch });
  assert.equal(r1.action, "keep");
  assert.equal(step(r1.state, { predicate: pred, base: lo, candidate: lo, patch }).action, "stop");
});

test("reset record: independence required", () => {
  const s = startCycle(pred, budget);
  assert.equal(resetForAttempt(s, { runId: "a", base: "b1", cleared: [] }).ok, false);
  const a = resetForAttempt(s, { runId: "a", base: "b1", cleared: ["workdir", "cache"] });
  assert.ok(a.ok);
  if (!a.ok) return;
  assert.equal(a.state.attempt, 2);
  assert.equal(resetForAttempt(a.state, { runId: "a", base: "b1", cleared: ["x"] }).ok, false);
  assert.equal(resetForAttempt(a.state, { runId: "b", base: "b2", cleared: ["x"] }).ok, false);
  assert.ok(resetForAttempt(a.state, { runId: "b", base: "b1", cleared: ["x"] }).ok);
});

test("bad construction throws", () => {
  assert.throws(() => startCycle({ ...pred, target: NaN }, budget));
  assert.throws(() => startCycle(pred, { ...budget, plateauAfter: 0 }));
});
