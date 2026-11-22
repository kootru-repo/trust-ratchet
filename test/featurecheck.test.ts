// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkFeatures, type Feature, type VerificationRecord } from "../src/harness/featurecheck.ts";

const features: Feature[] = [
  { id: "talk", entryPoints: ["press E near a person", "click a person"], words: "Talk to a villager" },
  { id: "walk", entryPoints: ["arrow keys"], words: "Walk around" },
];
const rec = (o: Partial<VerificationRecord>): VerificationRecord => ({ featureId: "walk", claimedEntryPoint: "arrow keys", usedEntryPoint: "arrow keys", status: "verified", evidence: "shot-1.png", ...o });

test("a full pass is complete with nothing unverified", () => {
  const c = checkFeatures(features, [rec({}), rec({ featureId: "talk", claimedEntryPoint: "press E near a person", usedEntryPoint: "press E near a person" }), rec({ featureId: "talk", claimedEntryPoint: "click a person", usedEntryPoint: "click a person" })]);
  assert.equal(c.refused.length, 0);
  assert.deepEqual(c.unverified, []);
  assert.ok(c.features.every((f) => f.complete));
});

test("a record through a different entry point than claimed is refused, and the claimed one stays unverified", () => {
  const c = checkFeatures(features, [rec({ featureId: "talk", claimedEntryPoint: "click a person", usedEntryPoint: "press E near a person" })]);
  assert.equal(c.refused.length, 1);
  assert.match(c.refused[0]?.reason ?? "", /different path/);
  assert.deepEqual(c.unverified.filter((u) => u.featureId === "talk").map((u) => u.entryPoint), ["press E near a person", "click a person"]);
});

test("a feature with two entry points and one driven is incomplete and lists the skipped one", () => {
  const c = checkFeatures(features, [rec({ featureId: "talk", claimedEntryPoint: "press E near a person", usedEntryPoint: "press E near a person" })]);
  const talk = c.features.find((f) => f.id === "talk");
  assert.equal(talk?.complete, false);
  assert.deepEqual(talk?.unverified, ["click a person"]);
});

test("refuses unknown feature, unknown entry point and empty evidence", () => {
  const c = checkFeatures(features, [rec({ featureId: "nope" }), rec({ claimedEntryPoint: "x", usedEntryPoint: "x" }), rec({ evidence: "  " })]);
  assert.equal(c.refused.length, 3);
  assert.equal(c.accepted.length, 0);
});

test("unreachable needs a prerequisite and a route, and is kept apart from verified", () => {
  const bad = checkFeatures(features, [rec({ status: "unreachable" })]);
  assert.equal(bad.refused.length, 1);
  const ok = checkFeatures(features, [rec({ status: "unreachable", prerequisite: "needs a gamepad", routeTried: "keyboard only" })]);
  const walk = ok.features.find((f) => f.id === "walk");
  assert.deepEqual(walk?.verified, []);
  assert.deepEqual(walk?.unreachable, ["arrow keys"]);
  assert.equal(walk?.complete, true);
});

test("map problems are listed: duplicate feature, duplicate entry point, empty words", () => {
  const c = checkFeatures([...features, { id: "walk", entryPoints: ["a", "a"], words: "" }], []);
  assert.equal(c.problems.length, 3);
});
