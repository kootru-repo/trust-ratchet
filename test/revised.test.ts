// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { caseRanges, score, summarize, type CaseFile } from "../src/bench.ts";
import { summarizeEffort } from "../src/effort.ts";
import { judgeLint } from "../src/guard.ts";
import { hunkPairs, introducing, isFixSubject, linesWith, mineCases, removedTexts } from "../src/history.ts";
import { judgeCheck } from "../src/layer0.ts";
import { readEslint } from "../src/packs/typescript.ts";
import { SPECIALISTS } from "../src/plan.ts";
import { specialistPrompt } from "../src/prompts.ts";
import { reviewFile } from "../src/review.ts";
import { triage } from "../src/triage.ts";
import type { ModelFn } from "../src/types.ts";

const DIFF = ["--- a/x.ts", "+++ b/x.ts", "@@ -10,2 +10,3 @@", "-  if (settings.open) show();", "-}", "+  if (settings.open === true) show();", "+  log();", "+}", "@@ -40,0 +42 @@", "+extra();"].join("\n");

test("hunkPairs gives the old and the new lines of every hunk", () => {
  assert.deepEqual(hunkPairs(DIFF), [
    { before: { from: 10, to: 11 }, after: { from: 10, to: 12 } },
    { before: { from: 40, to: 41 }, after: { from: 42, to: 42 } },
  ]);
});

test("removedTexts keeps telling lines only and linesWith finds them in an older file", () => {
  const removed = removedTexts(DIFF);
  assert.deepEqual(removed, ["if (settings.open) show();"]);
  const older = ["a();", "function f() {", "    if (settings.open)   show();", "}"].join("\n");
  assert.deepEqual(linesWith({ text: older, wanted: removed }), [{ from: 3, to: 3 }]);
});

test("a check that could not run is not reported as a pass or a failure", () => {
  const missing = judgeCheck({ spec: { command: "npx tsc" }, command: "npx tsc", file: "src/a.ts", status: 1, output: "'tsc' is not recognized as an internal or external command" });
  assert.equal(missing.ran, false);
  const drift = judgeCheck({ spec: { command: "npx tsc", onlyFile: true }, command: "npx tsc", file: "src/a.ts", status: 2, output: "src/b.ts(3,56): error TS2307: Cannot find module 'x' or its corresponding type declarations." });
  assert.equal(drift.ran, true);
  assert.equal(drift.exitCode, 0);
  const config = judgeCheck({ spec: { command: "npx eslint a" }, command: "npx eslint a", file: "src/a.ts", status: 1, output: "  0:0  error  Parsing error: parserOptions.tsconfigRootDir must be an absolute path" });
  assert.equal(config.ran, false);
  const failed = judgeCheck({ spec: { command: "npx tsc" }, command: "npx tsc", file: "src/a.ts", status: 1, output: "src/a.ts(3,1): error TS2322: no" });
  assert.equal(failed.ran, true);
  assert.equal(failed.exitCode, 1);
});

test("onlyFile ignores errors in other files", () => {
  const spec = { command: "npx tsc --noEmit", onlyFile: true };
  const other = judgeCheck({ spec, command: spec.command, file: "src/a.ts", status: 2, output: "src/b.ts(3,1): error TS2322: no\nlib/src/sub/a.ts(9,1): error TS1: no\nother/a.ts(1,1): error TS1: no" });
  assert.equal(other.ran, true);
  assert.equal(other.exitCode, 0);
  const mine = judgeCheck({ spec, command: spec.command, file: "src/a.ts", status: 2, output: "src/b.ts(3,1): error\nsrc/a.ts(7,2): error TS2345: bad" });
  assert.equal(mine.exitCode, 1);
  assert.match(mine.tail, /TS2345/);
  assert.doesNotMatch(mine.tail, /b\.ts/);
});

test("effort is split by kind of call and gives the verification share", () => {
  const usage = { input_tokens: 100, cache_read_input_tokens: 400, output_tokens: 500 };
  const { rows, verificationShare } = summarizeEffort([
    { label: "nullflow src/a.ts", turns: 2, usage, durationMs: 4000 },
    { label: "verify src/a.ts:10", turns: 8, usage, durationMs: 9000 },
    { label: "repro src/a.ts:10 #1", turns: 12, usage, durationMs: 20000 },
  ]);
  assert.equal(rows.find((r) => r.role === "verify")?.meanTurns, 8);
  assert.equal(rows.find((r) => r.role === "specialist")?.tokensIn, 500);
  assert.ok(verificationShare !== null && Math.abs(verificationShare - 2 / 3) < 1e-9);
  assert.equal(summarizeEffort([]).verificationShare, null);
});

test("a fix subject is a whole word in the subject, and not housekeeping", () => {
  assert.equal(isFixSubject("ENG-1335 Fix node create modal results"), true);
  assert.equal(isFixSubject("fix: crash on an empty row"), true);
  assert.equal(isFixSubject("ENG-2026 Update publicAppId in BirdEatsBugs"), false);
  assert.equal(isFixSubject("Fix CI (#526)"), false);
  assert.equal(isFixSubject("ENG-1965 Fix: rename template block props"), false);
  assert.equal(isFixSubject("Add prefix option"), false);
});

test("readEslint returns reports, and null when the run was fatal", () => {
  assert.deepEqual(readEslint(JSON.stringify([{ messages: [{ line: 4, ruleId: "r", message: "m" }] }])), [{ line: 4, rule: "r", message: "m" }]);
  assert.equal(readEslint(JSON.stringify([{ messages: [{ fatal: true, message: "Parsing error" }] }])), null);
  assert.equal(readEslint("not json"), null);
});

test("a lint guard is judged on the lines the fix changed", () => {
  const file = (line10: string, line90: string, shift: number): string => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}();`);
    lines[9] = line10;
    lines[89 + shift] = line90;
    return lines.join("\n");
  };
  const r = (line: number, message = "Unexpected nullable boolean"): { line: number; rule: string; message: string } => ({ line, rule: "sbe", message });
  const buggy = file("  if (settings.open) show();", "  if (other) go();", 0);
  const fixed = file("  if (settings.open === true) show();", "  if (other) go();", 1);
  const caught = judgeLint({ diff: DIFF, before: [r(10), r(90)], after: [r(91)], beforeText: buggy, afterText: fixed });
  assert.deepEqual({ before: caught.before, after: caught.after, proven: caught.proven }, { before: "fails", after: "passes", proven: true });
  assert.deepEqual({ ...caught.detail, messages: [] }, { onFixBefore: 1, onFixAfter: 0, resolved: 1, introduced: 0, backlog: 1, messages: [] });
  assert.match(caught.detail?.messages[0] ?? "", /gone line 10/);
  // Reports elsewhere in the file prove nothing about this bug.
  assert.equal(judgeLint({ diff: DIFF, before: [r(90)], after: [r(91)], beforeText: buggy, afterText: fixed }).proven, false);
  // The fixed line still breaks the rule: the rule did not tell the bug from its fix.
  const still = judgeLint({ diff: DIFF, before: [r(10)], after: [r(10)], beforeText: buggy, afterText: fixed });
  assert.deepEqual({ before: still.before, after: still.after, proven: still.proven }, { before: "fails", after: "fails", proven: false });
  // The same report on an untouched line inside the hunk, before and after: the rule was talking about something else.
  const same = judgeLint({ diff: DIFF, before: [r(11)], after: [r(12)], beforeText: buggy.replace("line10();", "if (z) {"), afterText: fixed.replace("line11();", "if (z) {") });
  assert.deepEqual({ before: same.before, after: same.after, proven: same.proven }, { before: "passes", after: "passes", proven: false });
  assert.equal(judgeLint({ diff: DIFF, before: null, after: [], beforeText: "", afterText: "" }).before, "error");
});

test("triage hands back locally proven dismissals for audit", () => {
  const t = triage({
    concerns: [],
    dismissals: [
      { specialist: "nullflow", title: "x may be null", cite: { file: "a.ts", line: 3, quote: "const y = x.z;" }, reasoning: "checked two lines up", proof: "local" },
      { specialist: "nullflow", title: "bad cite", cite: { file: "a.ts", line: 9, quote: "nothing like this" }, reasoning: "r", proof: "local" },
    ],
    cite: (c) => (c.line === 3 ? { ok: true, line: 3 } : { ok: false, reason: "quote not found" }),
    maxChecks: 40,
  });
  assert.equal(t.checks.length, 0);
  assert.equal(t.local.length, 1);
  assert.equal(t.local[0]?.origin, "local-dismissal");
});

test("only the intent specialist sees the commit message; a broken check is shown as no evidence", () => {
  const context = { content: "const a = 1;\n", importers: [], pkg: "." };
  const patch = { message: "SECRET-MESSAGE fix the flag", diff: "@@ -1 +1 @@\n-const a = 0;\n+const a = 1;\n" };
  const facts = [{ command: "npx tsc", exitCode: 1, tail: "boom", ran: false }];
  const intent = SPECIALISTS.find((s) => s.id === "intent");
  const other = SPECIALISTS.find((s) => s.id !== "intent");
  assert.ok(intent && other);
  const a = specialistPrompt({ specialist: intent, file: "a.ts", context, facts, language: "TypeScript", patch });
  const b = specialistPrompt({ specialist: other, file: "a.ts", context, facts, language: "TypeScript", patch });
  assert.match(a, /SECRET-MESSAGE/);
  assert.doesNotMatch(b, /SECRET-MESSAGE/);
  assert.match(b, /\+const a = 1;/);
  assert.match(b, /could not run/);
  assert.doesNotMatch(b, /boom/);
});

const SOURCE = ["export const pick = (rows: string[][]) =>", "  rows.map((r) => r[0].trim());", "export const size = (rows: string[][]) => rows.length;", ""].join("\n");

test("a sample of local dismissals reaches a verifier and can be overturned", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-audit-"));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "pick.ts"), SOURCE);
  const labels: string[] = [];
  const model: ModelFn = async ({ label }) => {
    labels.push(label);
    if (label.startsWith("verify "))
      return JSON.stringify({ verdict: "confirmed", proof: [{ file: "pick.ts", line: 2, quote: "rows.map((r) => r[0].trim());" }], explanation: "an empty row has no first item", callSites: [], guard: "" });
    return JSON.stringify({
      concerns: [],
      dismissed: [{ title: "row may be empty", file: "pick.ts", line: 2, quote: "rows.map((r) => r[0].trim());", reasoning: "rows are never empty", proof: "local" }],
    });
  };
  const off = await reviewFile({ root, file: "pick.ts", model });
  assert.equal(off.checked.length, 0);
  assert.ok((off.localDismissals ?? 0) >= 1);
  const on = await reviewFile({ root, file: "pick.ts", model, auditLocal: 1 });
  assert.equal(on.localAudited, 1);
  assert.equal(on.checked[0]?.origin, "local-dismissal");
  // A dismissal on a line a check reported is verified even with the sample switched off.
  const facts = [{ command: "lint rule x", exitCode: 1, tail: "pick.ts:2 Unexpected value in conditional", ran: true }];
  const forced = await reviewFile({ root, file: "pick.ts", model, facts, auditLocal: 0 });
  assert.equal(forced.checked.length, 1);
  assert.equal((await reviewFile({ root, file: "pick.ts", model, facts: [{ command: "lint rule x", exitCode: 1, tail: "pick.ts:3 other", ran: true }], auditLocal: 0 })).checked.length, 0);
  const s = score({ id: "x-bug", kind: "bug", ranges: [{ from: 2, to: 2 }], review: on, seconds: 1, locate: () => 2 });
  assert.equal(s.localOverturned, 1);
  assert.equal(s.confirmedHit, true);
  assert.match(summarize({ scores: [s], model: "m", repro: false }), /Found to be bugs: 1/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("history finds the commit that wrote a bug, and patch-mode ranges follow the text", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-hist-"));
  const git = (...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  const write = (text: string, message: string): string => {
    fs.mkdirSync(path.join(repo, "src"), { recursive: true });
    fs.writeFileSync(path.join(repo, "src", "pick.ts"), text);
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD").trim();
  };
  git("init", "-q", "-b", "main");
  write("export const size = (rows: string[][]) => rows.length;\n", "add size");
  const intro = write(SOURCE, "add pick");
  // An unrelated commit moves the buggy line down before the fix lands.
  write(`// header\n// more\n${SOURCE}`, "add header");
  const fix = write(`// header\n// more\n${SOURCE.replace("r[0].trim()", '(r[0] ?? "").trim()')}`, "fix: crash on an empty row");

  assert.equal(introducing({ repo, fix, file: "src/pick.ts" }), intro);
  const cases = mineCases({ repo, prefix: "src", exclude: [], max: 5 });
  assert.equal(cases.length, 1);
  assert.equal(cases[0]?.intro, intro.slice(0, 10));
  assert.equal(mineCases({ repo, prefix: "src", exclude: [fix], max: 5 }).length, 0);

  const caseFile: CaseFile = { target: "t", repo, paths: ["src"], cases };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-hist-tree-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "pick.ts"), SOURCE);
  const c = cases[0];
  assert.ok(c);
  // At the introducing commit the line is 2; at fix^ it is 4. Patch mode must say 2.
  assert.deepEqual(caseRanges({ caseFile, c, kind: "bug", root }), [{ from: 2, to: 2 }]);
  assert.deepEqual(caseRanges({ caseFile, c: { ...c, intro: undefined as unknown as string }, kind: "bug", root }), [{ from: 4, to: 4 }]);
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});
