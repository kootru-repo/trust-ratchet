// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { applyAccepted } from "../src/swarm/apply.ts";
import { patchId } from "../src/swarm/verdict.ts";
import type { VerdictRecord } from "../src/harness/mergeclass.ts";
import { diffTo, fixtureRepo } from "./fixture.ts";

const rec = (diff: string, o: Partial<VerdictRecord> = {}): VerdictRecord => ({ author: "w", verifier: "v", patchId: patchId(diff), verdict: "VERIFIED", evidence: ["e.txt"], ...o });

test("a counted verdict applies the patch, twice is idempotent", () => {
  const { repo } = fixtureRepo();
  const diff = diffTo(repo, "ok2\n");
  assert.equal(applyAccepted(repo, diff, rec(diff)).state, "applied");
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "ok2\n");
  assert.equal(applyAccepted(repo, diff, rec(diff)).state, "already");
});

test("refused and the tree untouched: wrong patch id, self-verified, not verified, inconclusive, no evidence", () => {
  const { repo } = fixtureRepo();
  const diff = diffTo(repo, "ok2\n");
  const cases: VerdictRecord[] = [rec(diff, { patchId: "0000000000000000" }), rec(diff, { verifier: "w" }), rec(diff, { verdict: "NOT VERIFIED" }), rec(diff, { verdict: "INCONCLUSIVE" }), rec(diff, { evidence: [] })];
  for (const c of cases) {
    const r = applyAccepted(repo, diff, c);
    assert.equal(r.state, "refused");
    assert.ok(r.reasons.length > 0);
  }
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "ok\n");
});

test("a verdict for an older patch refuses an edited patch", () => {
  const { repo } = fixtureRepo();
  const old = diffTo(repo, "ok2\n");
  const edited = diffTo(repo, "ok3\n");
  assert.equal(applyAccepted(repo, edited, rec(old)).state, "refused");
});
