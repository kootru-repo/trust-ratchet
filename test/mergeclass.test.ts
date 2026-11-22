import assert from "node:assert/strict";
import { test } from "node:test";
import { autoMergeMayBeOn, classOfTurn, countVerdict, readGates, refusal, REQUIRED_ROWS, type Gates, type TurnFacts, type VerdictRecord } from "../src/harness/mergeclass.ts";

const clean: TurnFacts = { changedSource: true, changedTest: true, allChecksRan: true, tests: "pass", driver: "pass", speed: "pass", speedWord: "faster", speedLimiter: "profile/run3.json", lookChanged: false };

test("class: a clean turn is inside; each deviation is outside", () => {
  assert.equal(classOfTurn(clean).inside, true);
  const outside: Partial<TurnFacts>[] = [
    { driver: "inconclusive" }, { allChecksRan: false }, { lookChanged: true },
    { speedWord: "slower" }, { speed: "pending" }, { speedLimiter: "" },
    { changedTest: false }, { changedSource: false }, { tests: "fail" },
  ];
  for (const o of outside) assert.equal(classOfTurn({ ...clean, ...o }).inside, false, JSON.stringify(o));
  assert.equal(classOfTurn({ ...clean, speedWord: "no measurable difference", speedLimiter: "" }).inside, true);
});

const rec: VerdictRecord = { author: "s1", verifier: "s2", patchId: "abc", verdict: "VERIFIED", evidence: ["runs/driver-1.json"] };

test("verdict: only an independent VERIFIED verdict on the current patch with evidence counts", () => {
  assert.equal(countVerdict(rec, "abc").counted, true);
  assert.equal(countVerdict({ ...rec, verifier: "s1" }, "abc").counted, false);
  assert.equal(countVerdict(rec, "def").counted, false);
  const inc = countVerdict({ ...rec, verdict: "INCONCLUSIVE" }, "abc");
  assert.equal(inc.counted, false);
  assert.match(inc.reasons.join(), /not a pass/);
  assert.equal(countVerdict({ ...rec, verdict: "NOT VERIFIED" }, "abc").counted, false);
  assert.equal(countVerdict({ ...rec, evidence: [] }, "abc").counted, false);
});

test("switch: proof/gates.json has every row open, so auto-merge is refused and names them", () => {
  const s = autoMergeMayBeOn(readGates("proof/gates.json"));
  assert.equal(s.allowed, false);
  assert.deepEqual(s.open, [...REQUIRED_ROWS]);
  assert.match(refusal(s), /rows 2, 3, 4/);
});

test("switch: one open row still refuses; all closed allows; missing reads as open", () => {
  const all: Gates = Object.fromEntries(REQUIRED_ROWS.map((r): [string, "closed"] => [String(r), "closed"]));
  assert.equal(autoMergeMayBeOn(all).allowed, true);
  assert.deepEqual(autoMergeMayBeOn({ ...all, "13": "open" }).open, [13]);
  assert.equal(autoMergeMayBeOn({}).allowed, false);
});
