// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import { atLeast, commitsNeeded, levelOf, renderLevel, upperBound, type LevelFacts } from "../src/harness/level.ts";

const rec = (mode: "advise" | "enforce", failing = false, held = false) => ({ time: "2026-11-20T00:00:00Z", mode, failing, held });
const base: LevelFacts = {
  on: true,
  mode: "advise",
  rules: 0,
  provenRules: 0,
  risenRules: 0,
  hatches: 10,
  hatchCeiling: 10,
  commands: 0,
  fixFolders: 3,
  watchedFixFolders: 0,
  folders: 9,
  watchedFolders: 0,
  records: [rec("advise")],
  before: { commits: 200, fixes: 40 },
  since: { commits: 0, fixes: 0 },
};

test("the statistics behind the levels are exact", () => {
  assert.ok(Math.abs(atLeast(1, 10, 0.1) - (1 - 0.9 ** 10)) < 1e-12);
  assert.equal(atLeast(0, 10, 0.1), 1);
  // None seen in n tries: the 95% bound is 1 - 0.05^(1/n), the "rule of three".
  assert.ok(Math.abs(upperBound(0, 29, 0.95) - (1 - 0.05 ** (1 / 29))) < 1e-6);
  assert.ok(upperBound(0, 28, 0.95) > 0.1 && upperBound(0, 29, 0.95) <= 0.1);
  assert.ok(upperBound(1, 29, 0.95) > 0.1);
  assert.equal(upperBound(0, 0, 0.95), 1);
  // A rarer event needs more commits before a doubling can be seen; one too rare cannot be measured at all.
  const common = commitsNeeded(0.2);
  const rare = commitsNeeded(0.02);
  assert.ok(common !== null && rare !== null && common > 20 && common < 200 && rare > common * 5);
  assert.equal(commitsNeeded(1 / 4000), null);
  assert.equal(commitsNeeded(0), null);
});

test("a level needs every level below it, and each one is earned by facts", () => {
  assert.equal(levelOf({ ...base, on: false }).level, 0);
  assert.equal(levelOf({ ...base, records: [] }).level, 0);
  assert.equal(levelOf(base).level, 1);
  assert.equal(levelOf({ ...base, hatches: 11 }).level, 0);
  const ruled = { ...base, rules: 3, provenRules: 1 };
  assert.equal(levelOf(ruled).level, 2);
  assert.equal(levelOf({ ...ruled, risenRules: 1 }).level, 1);
  // Level 3 is about where fixes landed: every folder that took one must be watched, the rest need not be.
  const tested = { ...ruled, commands: 4, watchedFixFolders: 3, watchedFolders: 3 };
  assert.equal(levelOf(tested).level, 3);
  assert.equal(levelOf({ ...tested, watchedFixFolders: 2 }).level, 2);
  assert.equal(levelOf({ ...tested, records: [rec("advise", true)] }).level, 2);
  assert.equal(levelOf({ ...tested, fixFolders: 0, watchedFixFolders: 0, watchedFolders: 1 }).level, 3);
  assert.equal(levelOf({ ...tested, fixFolders: 0, watchedFixFolders: 0, watchedFolders: 0 }).level, 2);
  // Level 4: the number of turns is not picked, it falls out of the bound. 29 clean turns show "at most 10%".
  const turns = (n: number, bad = 0) => [...Array.from({ length: n - bad }, () => rec("enforce")), ...Array.from({ length: bad }, () => rec("enforce", true, false))].reverse();
  const enforced = (n: number, bad = 0): LevelFacts => ({ ...tested, mode: "enforce", records: [...turns(n, bad), rec("enforce")] });
  assert.equal(levelOf(enforced(27)).level, 3);
  assert.equal(levelOf(enforced(28)).level, 4);
  assert.equal(levelOf(enforced(28, 1)).level, 3);
  assert.equal(levelOf(enforced(60, 1)).level, 4);
  assert.equal(levelOf({ ...enforced(28), mode: "advise" }).level, 3);
  // A held turn is the harness working, not a release.
  assert.equal(levelOf({ ...enforced(28), records: [...turns(28), rec("enforce", true, true), rec("enforce")] }).level, 4);
  // Level 5: enough commits to see a doubling, and no rise seen.
  const needed = commitsNeeded(40 / 200) ?? 0;
  const measured = (commits: number, fixes: number): LevelFacts => ({ ...enforced(28), since: { commits, fixes } });
  assert.equal(levelOf(measured(needed - 1, 0)).level, 4);
  assert.equal(levelOf(measured(needed, Math.round(needed * 0.2))).level, 5);
  assert.equal(levelOf(measured(needed, Math.round(needed * 0.45))).level, 4);
  // A base rate too low to measure with is said, and level 5 is not reached by waiting.
  const rare = levelOf({ ...measured(4000, 1), before: { commits: 400, fixes: 0 } });
  assert.equal(rare.level, 4);
  assert.match(rare.next.join(" "), /no fix to compare with/);
});

test("the level is printed with every requirement, met or not, and its scheme", () => {
  const text = renderLevel({ root: "c:/p", level: levelOf(base) });
  assert.match(text, /Verification level of c:\/p: 1 Watched \(scheme 3\)/);
  assert.match(text, /\[x\] the harness is on/);
  assert.match(text, /\[ \] at least one rule that holds a turn is proven/);
  assert.match(text, /To reach level 2: /);
});
