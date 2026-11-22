// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import { decideStep, passedStep, type RunRecord, type Step } from "../src/swarm/ladder.ts";

const calm = { ramPercent: 40, cpuPercent: 20, processes: 3, workers: 0 };
const clean = (step: Step): RunRecord => ({ step, completed: true, gaps: 0, unverifiedPatches: 0 });
const q = (requested: Step, records: RunRecord[], extra: { shares?: boolean | null; second?: boolean; machine?: typeof calm } = {}) =>
  decideStep({ requested, records, machine: extra.machine ?? calm, otherProjectShares: extra.shares === undefined ? false : extra.shares, usesSecondServer: extra.second });
const why = (d: ReturnType<typeof q>): string => (d.allowed ? "" : d.reasons.join("|"));

test("step 1 allowed on a calm machine", () => assert.equal(q(1, []).allowed, true));
test("step 2 needs a step 1 record", () => assert.match(why(q(2, [])), /no run record for step 1/));
test("step 2 refused on gaps, unverified patch or incomplete run", () => {
  assert.match(why(q(2, [{ ...clean(1), gaps: 2 }])), /2 gaps/);
  assert.match(why(q(2, [{ ...clean(1), unverifiedPatches: 1 }])), /unverified/);
  assert.match(why(q(2, [{ ...clean(1), completed: false }])), /did not complete/);
});
test("step 2 allowed with clean step 1, even when shared", () => assert.equal(q(2, [clean(1)], { shares: true }).allowed, true));
test("steps 3 and 4 need no other project; unknown counts as shared", () => {
  const recs = [clean(1), clean(2), clean(3)];
  assert.equal(q(3, recs.slice(0, 2)).allowed, true);
  assert.equal(q(4, recs).allowed, true);
  assert.match(why(q(3, recs.slice(0, 2), { shares: true })), /shares the machine/);
  assert.match(why(q(4, recs, { shares: null })), /unknown/);
});
test("cannot skip a step", () => assert.equal(q(4, [clean(1), clean(2)]).allowed, false));
test("second page server only with one worker", () => {
  assert.equal(q(1, [], { second: true }).allowed, true);
  assert.match(why(q(2, [clean(1)], { second: true })), /second page server/);
});
test("launch gate refusal is named", () => assert.match(why(q(1, [], { machine: { ...calm, ramPercent: 95 } })), /RAM is 95/));
test("passedStep stops at first unclean step", () => assert.equal(passedStep([clean(1), { ...clean(2), gaps: 1 }, clean(3)]), 1));
