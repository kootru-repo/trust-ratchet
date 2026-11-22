import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { contextFor, UnitStore, unitId, unitsOf } from "../src/swarm/units.ts";

const DOC = [
  "---",
  "name: demo",
  "---",
  "# Demo skill",
  "",
  "Run the checks before you commit. Never skip them.",
  "",
  "## Steps",
  "",
  "Do these in order:",
  "",
  "- Run `npm test`. It must pass.",
  "  - This covers the unit tests only.",
  "- Commit with a short message.",
  "",
  "| Rule | Limit |",
  "|---|---|",
  "| Subject line | At most 72 characters. |",
  "",
  "```",
  "ignored code. Not a sentence.",
  "```",
  "",
  "> Keep it small. Then ship.",
].join("\n");

test("units: the same text always gives the same units, with ids that are hashes of the item and the sentence", () => {
  const a = unitsOf("skill:demo", DOC);
  const b = unitsOf("skill:demo", DOC);
  assert.deepEqual(a, b);
  assert.equal(a[0]?.id, unitId("skill:demo", "Run the checks before you commit."));
  assert.notEqual(unitId("skill:demo", "x y z, a sentence"), unitId("skill:other", "x y z, a sentence"));
  assert.deepEqual(a.map((u) => u.text), ["Run the checks before you commit.", "Never skip them.", "Do these in order:", "Run `npm test`.", "It must pass.", "This covers the unit tests only.", "Commit with a short message.", "Subject line", "At most 72 characters.", "Keep it small.", "Then ship."]);
});

test("units: structure becomes context: headings, the line that introduces a list, a parent item, a table header, the whole block", () => {
  const u = unitsOf("skill:demo", DOC);
  const by = (t: string) => u.find((x) => x.text === t);
  assert.equal(by("Run `npm test`.")?.headingPath, "Demo skill > Steps");
  assert.equal(by("Run `npm test`.")?.leadIn, "Do these in order:");
  assert.equal(by("Run `npm test`.")?.blockText, "Run `npm test`. It must pass.");
  assert.match(by("This covers the unit tests only.")?.leadIn ?? "", /Do these in order: \/\/ Run `npm test`\. It must pass\./);
  assert.equal(by("At most 72 characters.")?.kind, "table");
  assert.equal(by("At most 72 characters.")?.leadIn, "| Rule | Limit |");
  assert.equal(by("Keep it small.")?.kind, "quote");
  assert.ok(!u.some((x) => x.text.includes("ignored code")), "a fenced block is not a sentence");
});

test("units: a sentence that points back gets wider context, deterministically", () => {
  const u = unitsOf("skill:demo", DOC);
  const pointing = u.find((x) => x.text === "This covers the unit tests only.");
  assert.equal(pointing?.refStart, true);
  assert.equal(u.find((x) => x.text === "Never skip them.")?.refStart, false);
  const ctx = contextFor(pointing ?? (u[0] as (typeof u)[number]), u);
  assert.match(ctx, /SECTION: Demo skill > Steps/);
  assert.match(ctx, /INTRODUCED BY: Do these in order:/);
  assert.match(ctx, /SENTENCES BEFORE: Do these in order: \| Run `npm test`\. \| It must pass\./);
  assert.match(ctx, /THE SENTENCE TO JUDGE: This covers the unit tests only\.$/);
  assert.equal(contextFor(pointing ?? (u[0] as (typeof u)[number]), u), ctx, "the same unit always gets the same context");
});

const store = (): UnitStore => new UnitStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-units-")), "s.sqlite"));

test("store: units load once, verdicts are written once per unit and pass, completion is a count", () => {
  const s = store();
  const units = unitsOf("skill:demo", DOC);
  assert.equal(s.load(units), units.length);
  assert.equal(s.load(units), 0, "loading again adds nothing");
  assert.equal(s.missing("p1"), units.length);
  const first = s.pending("p1", 3);
  assert.deepEqual(first.map((u) => u.ord), [0, 1, 2], "the order is fixed");
  for (const u of first) assert.equal(s.record({ unit: u.id, pass: "p1", model: "m", enforceable: u.ord !== 1, how: "x" }), true);
  assert.equal(s.record({ unit: first[0]?.id ?? "", pass: "p1", model: "m", enforceable: false, how: "again" }), false, "a verdict is never overwritten");
  assert.equal(s.missing("p1"), units.length - 3);
  assert.equal(s.pending("p1", 1)[0]?.ord, 3, "the next batch starts where the last stopped");
  assert.equal(s.record({ unit: "nope", pass: "p1", model: "m", enforceable: true, how: "" }), false, "a verdict for an unknown unit is refused");
  assert.deepEqual(s.enforceable("p1", "skill:demo"), [first[0]?.id, first[2]?.id]);
  s.close();
});

test("store: two passes are compared by query; a disagreement and a union need no model", () => {
  const s = store();
  const units = unitsOf("skill:demo", DOC);
  s.load(units);
  const [a, b, c] = units;
  assert.ok(a && b && c);
  for (const [pass, flags] of [["p1", [true, false, true]], ["p2", [true, true, false]]] as const) [a, b, c].forEach((u, i) => s.record({ unit: u.id, pass, model: "m", enforceable: flags[i] ?? false, how: "" }));
  assert.deepEqual(s.disagreements("p1", "p2").sort(), [b.id, c.id].sort());
  assert.deepEqual(s.union(["p1", "p2"], "skill:demo"), [a.id, b.id, c.id]);
  assert.equal(s.missing("p1", "skill:demo"), units.length - 3);
  s.close();
});
