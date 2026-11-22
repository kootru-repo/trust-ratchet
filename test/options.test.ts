// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { harnessCli, readMustNot } from "../src/harness/cli.ts";
import { ident } from "../src/ident.ts";
import { applyMustNot, budgetFor, budgetLine, diffSize, guidesFor, judgeVerifierReading, lookedBeyond, mustNotFromRulings, parseGuide, PROPERTY_GUIDE, type MustNot } from "../src/options.ts";
import { renderReport } from "../src/report.ts";
import { reviewFile } from "../src/review.ts";
import type { Check, Checked, ModelFn, ToolUse } from "../src/types.ts";

const tmp = (name: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ratchet-${name}-`)));
const LINE = "rows.map((r) => r[0].trim());";
const SOURCE = ["export const pick = (rows: string[][]) =>", `  ${LINE}`, "export const size = (rows: string[][]) => rows.length;", ""].join("\n");
const tree = (): string => {
  const root = tmp("opt");
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "pick.ts"), SOURCE);
  fs.writeFileSync(path.join(root, "caller.ts"), 'import { pick } from "./pick.ts";\nexport const run = () => pick([[]]);\n');
  return root;
};
/** A model that raises one concern on the risky line, confirms it, and records every prompt it was given. */
const recorder = (verifierTools: ToolUse[] | null): { model: ModelFn; prompts: Record<string, string> } => {
  const prompts: Record<string, string> = {};
  const model: ModelFn = async ({ label, prompt, onTools }) => {
    prompts[label.split(" ")[0] ?? ""] = prompt;
    if (label.startsWith("verify ")) {
      if (verifierTools !== null) onTools?.(verifierTools);
      return JSON.stringify({ verdict: "confirmed", proof: [{ file: "pick.ts", line: 2, quote: LINE }], explanation: "an empty row has no first item", callSites: ["caller.ts:2"], guard: "" });
    }
    if (label.startsWith("repro ")) return JSON.stringify({ reproducible: false, reason: "not here", test: "" });
    return JSON.stringify({ concerns: [{ title: "row may be empty", severity: "major", file: "pick.ts", line: 2, quote: LINE, reasoning: "r[0] is undefined for an empty row" }], dismissed: [] });
  };
  return { model, prompts };
};
const check = (over: Partial<Check> = {}): Check => ({ origin: "concern", specialist: "nullflow", title: "row may be empty", severity: "major", cite: { file: "pick.ts", line: 2, quote: LINE }, claim: "c", ...over });

test("S6: the budget follows the size of the change, the diff before the file", () => {
  assert.deepEqual(budgetFor({ fileLines: 900, diffLines: 12 }), { size: 12, toolCalls: 6, label: "small" });
  assert.equal(budgetFor({ fileLines: 120 }).label, "medium");
  assert.equal(budgetFor({ fileLines: 900 }).toolCalls, 20);
  assert.equal(budgetFor({ fileLines: 30, diffLines: 0 }).size, 30);
  assert.equal(diffSize("--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-old\n+new\n+more\n context\n"), 3);
  assert.match(budgetLine(budgetFor({ fileLines: 10 })), /10 lines \(small\).*about 6 tool calls/);
});

test("S12: a guide applies to the files its first line names, and a missing folder is no guides", () => {
  assert.deepEqual(parseGuide("a.md", "applies: src/dm/**, tools/*.py\nThe vault is the source.\n"), { name: "a.md", applies: ["src/dm/**", "tools/*.py"], text: "The vault is the source." });
  assert.deepEqual(parseGuide("b.md", "Everywhere.").applies, ["**"]);
  const dir = tmp("guides");
  fs.writeFileSync(path.join(dir, "dm.md"), "applies: src/dm/**\nNever edit generated files.\n");
  fs.writeFileSync(path.join(dir, "all.md"), "Dates are UTC.\n");
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a guide");
  assert.deepEqual(guidesFor({ dir, file: "src/dm/build.py" }).map((g) => g.name), ["all.md", "dm.md"]);
  assert.deepEqual(guidesFor({ dir, file: "web/a.ts" }).map((g) => g.name), ["all.md"]);
  assert.deepEqual(guidesFor({ dir: path.join(dir, "none"), file: "a.ts" }), []);
});

test("S14: a false-alarm ruling becomes a case, and a program drops that place when it is raised again", () => {
  const checked = [{ ...check(), verdict: "confirmed", proof: [], explanation: "", callSites: [], guard: "" } as Checked];
  const id = ident(checked[0]?.cite ?? { file: "", line: 0, quote: "" });
  const got = mustNotFromRulings({ rulings: [{ finding: id, ruling: "false-alarm", note: "rows come from the parser, never empty\nmore" }, { finding: "nope", ruling: "false-alarm", note: "" }, { finding: id, ruling: "real", note: "" }], checked });
  assert.deepEqual(got.unmatched, ["nope"]);
  assert.equal(got.cases.length, 1);
  assert.equal(got.cases[0]?.reason, "rows come from the parser, never empty");
  const cases = got.cases as MustNot[];
  const split = applyMustNot({ checks: [check(), check({ cite: { file: "pick.ts", line: 3, quote: "export const size = (rows: string[][]) => rows.length;" } }), check({ cite: { file: "other.ts", line: 2, quote: LINE } })], mustNot: cases });
  assert.equal(split.kept.length, 2);
  assert.match(split.dropped[0]?.reason ?? "", /a person ruled this place a false alarm: rows come from the parser/);
  assert.deepEqual(applyMustNot({ checks: [check()], mustNot: [{ files: ["**"], pattern: "(", reason: "bad pattern never matches" }] }).dropped, []);
});

test("S5: a verifier's verdict needs reading beyond the cited file, when the rule is on", () => {
  assert.deepEqual(judgeVerifierReading({ others: 0, required: 1 }), { ok: false, others: 0 });
  assert.deepEqual(judgeVerifierReading({ others: 1, required: 1 }), { ok: true, others: 1 });
  assert.equal(judgeVerifierReading({ others: null, required: 2 }).ok, true);
  assert.equal(judgeVerifierReading({ others: 0, required: 0 }).ok, true);
  const look = (tools: { name: string; target: string }[]): number => lookedBeyond({ tools, root: "/r", cited: "src/pick.ts" });
  assert.equal(look([{ name: "Read", target: "src/pick.ts" }, { name: "Grep", target: "src/pick.ts" }]), 0);
  assert.equal(look([{ name: "Read", target: "/r/src/caller.ts" }, { name: "Read", target: "src/caller.ts" }]), 1);
  assert.equal(look([{ name: "Grep", target: "src" }, { name: "Grep", target: "pick\\(" }, { name: "Read", target: "../outside.ts" }]), 2);
});

test("every option is off by default: the prompts and the verdicts are what they were", async () => {
  const root = tree();
  const { model, prompts } = recorder([]);
  const plain = await reviewFile({ root, file: "pick.ts", model });
  assert.equal(plain.checked[0]?.verdict, "confirmed");
  const all = `${prompts.nullflow ?? Object.values(prompts)[0]}${prompts.verify}`;
  assert.doesNotMatch(all, /Budget:|Notes from the people who own|already ruled these false alarms|Reading is required, and a program checks it from your tool calls/);
  assert.doesNotMatch(renderReport(plain), /Is this intended\?|Questions for the author, each backed/);
});

test("with the options on, reviewers are told the budget, the notes and the ruled places, and an unread verdict is not kept", async () => {
  const root = tree();
  const options = { budget: true, guides: [{ name: "own.md", applies: ["**"], text: "Rows may be empty after a filter." }], verifierReads: 1 };
  const lazy = recorder([{ name: "Read", target: "pick.ts" }]);
  const r1 = await reviewFile({ root, file: "pick.ts", model: lazy.model, options });
  const specialist = Object.entries(lazy.prompts).find(([k]) => k !== "verify")?.[1] ?? "";
  assert.match(specialist, /Budget: what you are judging is 4 lines \(small\)/);
  assert.match(specialist, /Notes from the people who own this code[\s\S]*--- own\.md\nRows may be empty after a filter\./);
  assert.match(lazy.prompts.verify ?? "", /look at least 1 time beyond the cited file/);
  assert.match(lazy.prompts.verify ?? "", /Rows may be empty after a filter\./);
  assert.equal(r1.checked[0]?.verdict, "unproven");
  assert.match(r1.checked[0]?.downgraded ?? "", /said confirmed after looking 0 time\(s\) beyond the cited file where 1 are required/);

  const reader = recorder([{ name: "Read", target: "pick.ts" }, { name: "Read", target: path.join(root, "caller.ts") }]);
  assert.equal((await reviewFile({ root, file: "pick.ts", model: reader.model, options })).checked[0]?.verdict, "confirmed");
  const unlogged = recorder(null);
  assert.equal((await reviewFile({ root, file: "pick.ts", model: unlogged.model, options })).checked[0]?.verdict, "confirmed");

  const ruled = recorder([]);
  const r2 = await reviewFile({ root, file: "pick.ts", model: ruled.model, options: { mustNotFlag: [{ files: ["pick.ts"], pattern: "r\\[0\\]\\.trim", reason: "the parser never yields an empty row" }] } });
  assert.equal(r2.checked.length, 0);
  assert.equal(ruled.prompts.verify, undefined);
  assert.match(r2.dropped.map((d) => d.reason).join(";"), /a person ruled this place a false alarm: the parser never yields an empty row/);
  assert.match(Object.values(ruled.prompts)[0] ?? "", /A person has already ruled these false alarms in this file\. Do not raise them again:\n- a line matching \/r\\\[0\\\]\\\.trim\//);
});

test("T11: the reproduction guide asks for a property only when the option is on", async () => {
  const root = tree();
  const runner = () => ({ outcome: "error" as const, output: "" });
  const off = recorder([]);
  await reviewFile({ root, file: "pick.ts", model: off.model, repro: { pkg: ".", runner } });
  assert.equal((off.prompts.repro ?? "").includes(PROPERTY_GUIDE), false);
  assert.match(off.prompts.repro ?? "", /write one test file/);
  const on = recorder([]);
  await reviewFile({ root, file: "pick.ts", model: on.model, repro: { pkg: ".", runner }, options: { property: true } });
  assert.equal((on.prompts.repro ?? "").includes(PROPERTY_GUIDE), true);
});

test("S8: with the questions option a confirmed finding is put to the author as a question, with the same evidence", async () => {
  const root = tree();
  const r = await reviewFile({ root, file: "pick.ts", model: recorder([]).model });
  const asked = renderReport(r, { questions: true });
  assert.match(asked, /## Questions for the author, each backed by quoted code \(1\)/);
  assert.match(asked, /### Is this intended\? row may be empty/);
  assert.match(asked, /- Proof: `pick\.ts:2`/);
  assert.match(renderReport(r), /## Confirmed \(1\)\n### row may be empty/);
});

test("must-not cases are added by hand with a reason, kept outside the repository, and refused without one", () => {
  process.env.RATCHET_HOME = tmp("home");
  const root = tree();
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  const quiet = (argv: string[]): number => {
    const log = console.log;
    console.log = () => {};
    try {
      return harnessCli(argv, root);
    } finally {
      console.log = log;
    }
  };
  assert.equal(quiet(["must-not", "add", "--project", root, "--files", "pick.ts", "--pattern", "trim"]), 1);
  assert.equal(quiet(["must-not", "add", "--project", root, "--files", "pick.ts", "--pattern", "trim", "--reason", "never empty"]), 0);
  assert.equal(quiet(["must-not", "add", "--project", root, "--files", "pick.ts", "--pattern", "trim", "--reason", "again"]), 0);
  assert.deepEqual(readMustNot(root), [{ files: ["pick.ts"], pattern: "trim", reason: "never empty" }]);
  assert.equal(fs.existsSync(path.join(root, ".ratchet")), false);
});
