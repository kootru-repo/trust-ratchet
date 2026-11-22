// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { score } from "../src/bench.ts";
import { checkCite, quoteMatches } from "../src/cite.ts";
import { hunkRanges, inRanges } from "../src/git.ts";
import { pool } from "../src/model.ts";
import { lastJson, parseSpecialist, parseVerifier } from "../src/parse.ts";
import { pickSpecialists } from "../src/plan.ts";
import { renderReport } from "../src/report.ts";
import { reviewFile } from "../src/review.ts";
import { triage } from "../src/triage.ts";
import type { Concern, Dismissal, ModelFn } from "../src/types.ts";

const SOURCE = ["export const pick = (rows: string[][]) =>", "  rows.map((d) => d[0].trim() || '');", "", "export const other = 1;", ""].join("\n");

const tree = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-test-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "src", "pick.ts"), SOURCE);
  fs.writeFileSync(path.join(root, "src", "use.ts"), 'import { pick } from "./pick";\nexport const x = pick([]);\n');
  return root;
};

const json = (v: unknown): string => "Some thinking first.\n```json\n" + JSON.stringify(v) + "\n```";

test("quoteMatches accepts an exact quote near the line and ignores whitespace", () => {
  assert.deepEqual(quoteMatches({ text: SOURCE, line: 2, quote: "rows.map((d) =>   d[0].trim() || '');" }), { ok: true });
  assert.deepEqual(quoteMatches({ text: SOURCE, line: 4, quote: "d[0].trim()" }), { ok: true });
});

test("quoteMatches rejects invented text, short quotes and lines outside the file", () => {
  assert.equal(quoteMatches({ text: SOURCE, line: 2, quote: "rows.map((d) => d[1].trim())" }).ok, false);
  assert.equal(quoteMatches({ text: SOURCE, line: 2, quote: "});" }).ok, false);
  assert.equal(quoteMatches({ text: SOURCE, line: 99, quote: "d[0].trim()" }).ok, false);
  const far = Array.from({ length: 20 }, () => "const filler = 0;").join("\n") + "\nconst target = 1;";
  assert.equal(quoteMatches({ text: far, line: 2, quote: "const target = 1;" }).ok, false);
});

test("checkCite refuses a path outside the tree and a missing file", () => {
  const root = tree();
  assert.equal(checkCite({ root, cite: { file: "../outside.ts", line: 1, quote: "anything long" } }).ok, false);
  assert.equal(checkCite({ root, cite: { file: "src/none.ts", line: 1, quote: "anything long" } }).ok, false);
  assert.equal(checkCite({ root, cite: { file: "src/pick.ts", line: 2, quote: "d[0].trim()" } }).ok, true);
});

test("lastJson reads the last fenced block and falls back to a bare object", () => {
  assert.deepEqual(lastJson('```json\n{"a":1}\n```\ntext\n```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(lastJson('The answer is {"verdict":"refuted"}'), { verdict: "refuted" });
  assert.throws(() => lastJson("no json here"));
});

test("parseSpecialist drops entries without a citation and treats an unlabelled dismissal as assumed", () => {
  const out = parseSpecialist({
    specialist: "nullflow",
    text: json({
      concerns: [{ title: "ok", severity: "major", file: "src\\pick.ts", line: "2", quote: "d[0].trim()", reasoning: "r" }, { title: "no cite" }],
      dismissed: [{ title: "d", file: "src/pick.ts", line: 2, quote: "d[0].trim()" }],
    }),
  });
  assert.equal(out.concerns.length, 1);
  assert.deepEqual(out.concerns[0]?.cite, { file: "src/pick.ts", line: 2, quote: "d[0].trim()" });
  assert.equal(out.dismissed[0]?.proof, "assumed");
});

test("parseVerifier maps anything unexpected to unproven", () => {
  assert.equal(parseVerifier(json({ verdict: "probably" })).verdict, "unproven");
  assert.equal(parseVerifier(json({ verdict: "confirmed", proof: [{ file: "a.ts", line: 1, quote: "abcdef" }] })).proof.length, 1);
});

test("hunkRanges reads changed, single-line and inserted hunks of the old file", () => {
  const diff = "@@ -10,3 +10,4 @@ ctx\n@@ -20 +21 @@\n@@ -30,0 +32,2 @@\n";
  assert.deepEqual(hunkRanges(diff), [
    { from: 10, to: 12 },
    { from: 20, to: 20 },
    { from: 30, to: 31 },
  ]);
  assert.equal(inRanges({ line: 17, ranges: hunkRanges(diff), slack: 5 }), true);
  assert.equal(inRanges({ line: 40, ranges: hunkRanges(diff), slack: 5 }), false);
});

test("pickSpecialists always runs intent and nullflow and adds the rest by content", () => {
  const ids = (file: string, content: string): string[] => pickSpecialists({ file, content }).map((s) => s.id);
  assert.deepEqual(ids("a.ts", "export const a = 1;"), ["intent", "nullflow"]);
  assert.deepEqual(ids("a.ts", "const x = await f(); const y = v as Foo;"), ["intent", "nullflow", "async", "types"]);
  assert.deepEqual(ids("a.tsx", "export const A = () => null;"), ["intent", "nullflow", "react"]);
  assert.deepEqual(ids("a.ts", "const x = [1] as const;"), ["intent", "nullflow"]);
});

const concern = (over: Partial<Concern>): Concern => ({ specialist: "nullflow", title: "t", severity: "major", cite: { file: "f.ts", line: 10, quote: "abcdefgh" }, reasoning: "r", ...over });
const dismissal = (over: Partial<Dismissal>): Dismissal => ({ specialist: "intent", title: "d", cite: { file: "f.ts", line: 50, quote: "abcdefgh" }, proof: "assumed", reasoning: "r", ...over });

test("triage drops bad citations and locally proven dismissals, promotes assumed dismissals, merges neighbours, caps the rest", () => {
  const res = triage({
    concerns: [
      concern({ title: "a" }),
      concern({ title: "a again", specialist: "types", severity: "critical", cite: { file: "f.ts", line: 11, quote: "abcdefgh" } }),
      concern({ title: "bad", cite: { file: "f.ts", line: 99, quote: "BAD" } }),
      concern({ title: "minor one", severity: "minor", cite: { file: "f.ts", line: 80, quote: "abcdefgh" } }),
    ],
    dismissals: [dismissal({ title: "shaky" }), dismissal({ title: "safe", proof: "local", cite: { file: "f.ts", line: 70, quote: "abcdefgh" } })],
    cite: (c) => (c.quote === "BAD" ? { ok: false, reason: "nope" } : { ok: true }),
    maxChecks: 2,
  });
  assert.deepEqual(
    res.checks.map((c) => [c.title, c.specialist, c.origin]),
    [
      ["a again", "nullflow+types", "concern"],
      // The promoted dismissal is another specialist's first item, so it goes ahead of a second item rated by its own author.
      ["shaky", "intent", "dismissal"],
    ],
  );
  assert.deepEqual(res.unchecked.map((c) => [c.title, c.origin]), [["minor one", "concern"]]);
  assert.deepEqual(res.dropped.map((d) => d.title).sort(), ["bad", "safe"]);
});

test("pool never runs more than its limit at once", async () => {
  const run = pool(2);
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      }),
    ),
  );
  assert.equal(peak, 2);
});

test("reviewFile: a confirmed verdict with a false proof quote is downgraded, a shaky dismissal is verified, a broken specialist is recorded", async () => {
  const root = tree();
  const good = { file: "src/pick.ts", line: 2, quote: "d[0].trim()" };
  const prompts: string[] = [];
  const model: ModelFn = async ({ prompt, label }) => {
    prompts.push(label);
    if (label.startsWith("intent")) return json({ concerns: [{ title: "row may be empty", severity: "major", ...good, reasoning: "d[0] can be undefined" }], dismissed: [] });
    if (label.startsWith("nullflow")) return json({ concerns: [], dismissed: [{ title: "other is unused", file: "src/pick.ts", line: 4, quote: "export const other = 1;", proof: "assumed", reasoning: "probably used elsewhere" }] });
    if (label.startsWith("verify src/pick.ts:2")) {
      assert.match(prompt, /A reviewer claims this is a bug/);
      return json({ verdict: "confirmed", explanation: "pick([[]]) throws", callSites: ["src/use.ts:2"], proof: [good], guard: "unit test: pick([[]])" });
    }
    if (label.startsWith("verify src/pick.ts:4")) {
      assert.match(prompt, /dismissed it on an assumption/);
      return json({ verdict: "confirmed", explanation: "made up", proof: [{ file: "src/pick.ts", line: 4, quote: "this text is not in the file" }], guard: "" });
    }
    return "not json at all";
  };
  const res = await reviewFile({ root, file: "src/pick.ts", model });
  assert.deepEqual(res.specialists, ["intent", "nullflow"]);
  assert.equal(res.modelCalls, 4);
  const byLine = new Map(res.checked.map((c) => [c.cite.line, c]));
  assert.equal(byLine.get(2)?.verdict, "confirmed");
  assert.equal(byLine.get(4)?.verdict, "unproven");
  assert.match(byLine.get(4)?.downgraded ?? "", /proof citation failed/);

  const report = renderReport(res);
  assert.match(report, /## Confirmed \(1\)/);
  assert.match(report, /## Open questions \(1\)/);
  assert.match(report, /unit test: pick/);

  const s = score({ id: "x", kind: "bug", ranges: [{ from: 2, to: 2 }], review: res, seconds: 1, locate: (c) => c.line });
  assert.equal(s.candidateHit, true);
  assert.equal(s.confirmedHit, true);
  assert.equal(s.confirmedElsewhere, 0);
  const miss = score({ id: "y", kind: "bug", ranges: [{ from: 40, to: 41 }], review: res, seconds: 1, locate: (c) => c.line });
  assert.equal(miss.confirmedHit, false);
  assert.equal(miss.confirmedElsewhere, 1);
});

test("reviewFile records a specialist whose reply cannot be parsed and still finishes", async () => {
  const root = tree();
  const res = await reviewFile({ root, file: "src/pick.ts", model: async () => "sorry, no" });
  assert.equal(res.errors.length, 2);
  assert.equal(res.checked.length, 0);
});

test("locateQuote finds the line a quote really starts on, even when the cited line number is off", async () => {
  const { locateQuote } = await import("../src/cite.ts");
  const text = ["const a = 1;", "const rows = load();", "  rows", "    .filter(({ text }) => {", "      if (seen.has(text)) return false;", "    });", "void openSidebar(uid);"].join("\n");
  assert.equal(locateQuote({ text, line: 5, quote: "if (seen.has(text)) return false;" }), 5);
  assert.equal(locateQuote({ text, line: 2, quote: "if (seen.has(text)) return false;" }), 5);
  assert.equal(locateQuote({ text, line: 6, quote: "void openSidebar(uid);" }), 7);
  assert.equal(locateQuote({ text, line: 4, quote: ".filter(({ text }) => {\n      if (seen.has(text)) return false;" }), 4);
  assert.equal(locateQuote({ text, line: 1, quote: "void openSidebar(uid);" }), null);
  assert.equal(locateQuote({ text, line: 5, quote: "not in the file at all" }), null);
});
