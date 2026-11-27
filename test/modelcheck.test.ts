// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import { assertExplored, explore, shrink, type Model } from "../src/modelcheck.ts";

// A tiny door lock: 3 right digits in a row arm it; "wrong" resets the count; "open" must only succeed when armed.
// The buggy version forgets to reset on "wrong" after 2 right digits.
type Ev = "right" | "wrong" | "open";
type Lock = { count: number; armed: boolean; opened: boolean; model: { count: number; armed: boolean } };
const lock = (buggy: boolean): Model<Lock, Ev> => ({
  alphabet: ["right", "wrong", "open"],
  depth: 8,
  init: () => ({ count: 0, armed: false, opened: false, model: { count: 0, armed: false } }),
  step: (s, e) => {
    if (e === "right") {
      s.count += 1;
      s.model.count += 1;
    } else if (e === "wrong") {
      if (!(buggy && s.count === 2)) s.count = 0;
      s.model.count = 0;
    } else {
      s.opened = s.armed;
      if (s.opened && !s.model.armed) return "opened while the model says it is not armed";
    }
    s.armed = s.count >= 3;
    s.model.armed = s.model.count >= 3;
    return null;
  },
  check: (s) => (s.count < 0 ? "negative count" : null),
  key: (s) => `${Math.min(s.count, 3)}|${s.armed}|${s.opened}|${Math.min(s.model.count, 3)}|${s.model.armed}`,
  reach: [
    { name: "armed", hit: (s) => s.armed },
    { name: "opened", hit: (s) => s.opened },
  ],
});

test("a correct machine passes every sequence and reaches every named state", () => {
  const r = explore(lock(false));
  assert.equal(r.counterexample, null);
  assert.deepEqual(r.unreached, []);
  assert.ok(r.steps > 100);
  assertExplored(r);
});

test("a bug is found and shrunk until no event can be dropped alone", () => {
  const r = explore(lock(true));
  assert.deepEqual(r.counterexample, ["right", "right", "wrong", "right", "open"]);
  assert.match(r.message ?? "", /opened while the model says it is not armed/);
  assert.throws(() => assertExplored(r), /sequence \(5 steps, none can be dropped alone\): "right" -> "right" -> "wrong" -> "right" -> "open"/);
  const long: Ev[] = ["wrong", "right", "right", "open", "wrong", "right", "open"];
  assert.deepEqual(shrink(lock(true), long), ["right", "right", "wrong", "right", "open"]);
});

test("a pass that never reached a named state, or that hit the step limit, is not a pass", () => {
  const r = explore({ ...lock(false), depth: 2 });
  assert.deepEqual(r.unreached, ["armed", "opened"]);
  assert.throws(() => assertExplored(r), /without reaching: armed, opened/);
  const capped = explore({ ...lock(false), key: undefined, maxSteps: 50 });
  assert.equal(capped.capped, true);
  assert.throws(() => assertExplored({ ...capped, unreached: [] }), /stopped at its step limit/);
});

test("review of D1: a key that leaves out the system's state hides a bug, and the whole state finds it", () => {
  // The system flips on "tick" once it has seen two "a"; the model never flips.
  type S = { seen: number; flipped: boolean };
  const m: Model<S, "tick" | "a"> = {
    alphabet: ["tick", "a"],
    depth: 3,
    init: () => ({ seen: 0, flipped: false }),
    step: (s, e) => {
      if (e === "a") s.seen += 1;
      else if (s.seen >= 2) s.flipped = true;
      return s.flipped ? "the system flipped; the model did not" : null;
    },
  };
  assert.equal(explore({ ...m, key: () => "model" }).counterexample, null);
  assert.deepEqual(explore(m).counterexample, ["a", "a", "tick"]);
  assert.deepEqual(explore({ ...m, key: (s) => `${s.seen}|${s.flipped}` }).counterexample, ["a", "a", "tick"]);
});

test("review of D1: init faults, empty messages, the initial state, and shrinking keeps the same failure", () => {
  const noDevice = (): number => {
    throw new Error("no device");
  };
  assert.equal(explore<number, number>({ alphabet: [1], depth: 2, init: noDevice, step: () => null }).message, "init: no device");
  let calls = 0;
  const flaky = (): number => {
    calls += 1;
    if (calls > 2) throw new Error("later");
    return 0;
  };
  assert.equal(explore<number, number>({ alphabet: [1, 2], depth: 2, init: flaky, step: () => null }).message, "init: later");
  const silent = (): string => {
    throw new Error("");
  };
  assert.equal(explore<number, number>({ alphabet: [1], depth: 1, init: () => 0, step: silent }).message, "(no message)");
  assert.equal(explore<{ n: number }, number>({ alphabet: [1], depth: 1, init: () => ({ n: 0 }), step: () => "", check: () => null }).message, "(no message)");
  const atInit = explore<{ n: number }, number>({ alphabet: [1], depth: 0, init: () => ({ n: -1 }), step: () => null, check: (s) => (s.n < 0 ? "negative at start" : null) });
  assert.deepEqual({ ce: atInit.counterexample, msg: atInit.message }, { ce: [], msg: "negative at start" });
  assert.deepEqual(explore<{ n: number }, number>({ alphabet: [1], depth: 0, init: () => ({ n: 0 }), step: () => null, reach: [{ name: "start", hit: () => true }] }).unreached, []);
  // Bug A shows on p q q; bug B on any other three-event sequence ending q q. The counterexample stays one of bug A.
  type P = { seq: string };
  const two: Model<P, "p" | "q"> = {
    alphabet: ["p", "q"],
    depth: 3,
    init: () => ({ seq: "" }),
    step: (s, e) => {
      s.seq += e;
      if (s.seq === "pqq") return "A";
      if (s.seq.length === 2 && s.seq === "qq") return "B";
      return null;
    },
  };
  const r = explore(two);
  assert.equal(r.message, "A");
  assert.deepEqual(r.counterexample, ["p", "q", "q"]);
});
