// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { CaseFile } from "../src/bench.ts";
import { isProven, judgeGuards, judgeRetirement, promote, prove, renderGuards, renderRetirement, type Guard, type GuardFile, type GuardReport } from "../src/guard.ts";
import { reviewFile } from "../src/review.ts";
import type { Checked, ModelFn } from "../src/types.ts";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-guard-"));

const BUGGY = ["def first_titles(rows):", "    return [r[0].strip() or '' for r in rows]", ""].join("\n");
const FIXED = ["def first_titles(rows):", "    return [(r[0].strip() if r else '') for r in rows]", ""].join("\n");

/** A real git repository with one bug commit and one fix commit. */
const repoWithFix = (): { repo: string; fix: string } => {
  const repo = tmp();
  const git = (...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  fs.mkdirSync(path.join(repo, "lib"));
  fs.writeFileSync(path.join(repo, "lib", "__init__.py"), "");
  fs.writeFileSync(path.join(repo, "lib", "pick.py"), BUGGY);
  git("add", "-A");
  git("commit", "-q", "-m", "add pick");
  fs.writeFileSync(path.join(repo, "lib", "pick.py"), FIXED);
  git("add", "-A");
  git("commit", "-q", "-m", "fix: empty row");
  return { repo, fix: git("rev-parse", "HEAD").trim() };
};

const GOOD_TEST = "import pytest\nfrom lib.pick import first_titles\n\ndef test_empty_row():\n    try:\n        out = first_titles([[]])\n    except IndexError as e:\n        pytest.fail(f'raised {e!r}')\n    assert out == ['']\n";
const USELESS_TEST = "from lib.pick import first_titles\n\ndef test_ok():\n    assert first_titles([['a']]) == ['a']\n";
const ALWAYS_RED = "def test_red():\n    assert 1 == 2\n";

test("isProven needs a failure before the fix and a pass after it", () => {
  assert.equal(isProven("fails", "passes"), true);
  assert.equal(isProven("fails", "fails"), false);
  assert.equal(isProven("passes", "passes"), false);
  assert.equal(isProven("error", "passes"), false);
});

test("prove runs guards on the real buggy and fixed trees, tells good guards from useless and noisy ones, and resumes", () => {
  const { repo, fix } = repoWithFix();
  const guardsDir = tmp();
  fs.writeFileSync(path.join(guardsDir, "good.py"), GOOD_TEST);
  fs.writeFileSync(path.join(guardsDir, "useless.py"), USELESS_TEST);
  fs.writeFileSync(path.join(guardsDir, "red.py"), ALWAYS_RED);
  const guards: GuardFile = {
    target: "demo",
    guards: [
      { id: "good", title: "empty row", scope: "case", kind: "test", testFile: "good.py", caseId: "empty-row" },
      { id: "useless", title: "passes anyway", scope: "case", kind: "test", testFile: "useless.py", caseId: "empty-row" },
      { id: "red", title: "always fails", scope: "case", kind: "test", testFile: "red.py", caseId: "empty-row" },
      // A class guard as a command: flags any unguarded r[0] on a row. Exit 1 means "found".
      { id: "rule-unguarded-index", title: "row indexed without a check", scope: "class", kind: "command", command: `python -c "import sys;sys.exit(1 if 'r[0].strip() or' in open(sys.argv[1]).read() else 0)" {file}` },
      { id: "rule-broken", title: "command that does not exist", scope: "class", kind: "command", command: "ratchet-no-such-command {file}" },
      { id: "other-case", title: "belongs to another case", scope: "case", kind: "test", testFile: "good.py", caseId: "not-this-one" },
    ],
  };
  const caseFile: CaseFile = { target: "demo", repo, paths: ["lib"], repro: { pkg: "." }, cases: [{ id: "empty-row", fix, file: "lib/pick.py", note: "" }] };
  const lines: string[] = [];
  const proofs = prove({ caseFile, guards, guardsDir, log: (l) => lines.push(l) });
  const by = new Map(proofs.map((p) => [p.guard, p]));
  assert.deepEqual([by.get("good")?.before, by.get("good")?.after, by.get("good")?.proven], ["fails", "passes", true]);
  assert.deepEqual([by.get("useless")?.before, by.get("useless")?.proven], ["passes", false]);
  assert.deepEqual([by.get("red")?.after, by.get("red")?.proven], ["fails", false]);
  assert.deepEqual([by.get("rule-unguarded-index")?.before, by.get("rule-unguarded-index")?.after, by.get("rule-unguarded-index")?.proven], ["fails", "passes", true]);
  assert.equal(by.get("rule-broken")?.before, "error");
  assert.equal(by.has("other-case"), false);

  const reports = judgeGuards({ guards: guards.guards, proofs });
  const status = Object.fromEntries(reports.map((r) => [r.guard.id, r.status]));
  assert.deepEqual(status, { good: "proven", useless: "not proven", red: "not proven", "rule-unguarded-index": "proven", "rule-broken": "broken", "other-case": "not proven" });
  assert.deepEqual(reports.find((r) => r.guard.id === "red")?.noisy, ["empty-row"]);
  assert.match(renderGuards(reports), /Proven: 2 of 6\. Class guards proven: 1\./);

  // Second call does no work: every pair is already in proofs.json.
  const again: string[] = [];
  assert.equal(prove({ caseFile, guards, guardsDir, log: (l) => again.push(l) }).length, proofs.length);
  assert.equal(again.length, 0);
});

test("promote takes only tests that reproduced the bug and passed after the real fix", () => {
  const resultsDir = tmp();
  const guardsDir = path.join(tmp(), "guards");
  const item = (over: Partial<Checked>): Checked => ({ origin: "concern", specialist: "missing", title: "t", severity: "major", cite: { file: "lib/pick.py", line: 2, quote: "return [r[0].strip() or '' for r in rows]" }, claim: "", verdict: "confirmed", proof: [], explanation: "", callSites: [], guard: "", ...over });
  const checked = [
    item({ title: "kept", repro: { status: "reproduced", reason: "", test: GOOD_TEST, output: "", attempts: 1, afterFix: "passes" } }),
    item({ title: "still fails after fix", cite: { file: "lib/pick.py", line: 9, quote: "another line of code" }, repro: { status: "reproduced", reason: "", test: ALWAYS_RED, output: "", attempts: 1, afterFix: "still-fails" } }),
    item({ title: "never checked after fix", cite: { file: "lib/pick.py", line: 12, quote: "a third line of code" }, repro: { status: "reproduced", reason: "", test: ALWAYS_RED, output: "", attempts: 1 } }),
    item({ title: "argued only", cite: { file: "lib/pick.py", line: 15, quote: "a fourth line of code" } }),
  ];
  fs.writeFileSync(path.join(resultsDir, "empty-row-bug.json"), JSON.stringify({ score: {}, review: { file: "lib/pick.py", checked } }));
  const caseFile: CaseFile = { target: "demo", repo: "unused", paths: [], cases: [{ id: "empty-row", fix: "x", file: "lib/pick.py", note: "" }] };
  const data = promote({ caseFile, resultsDir, guardsDir });
  assert.equal(data.guards.length, 1);
  assert.equal(data.guards[0]?.title, "kept");
  assert.equal(data.guards[0]?.scope, "case");
  assert.equal(fs.readFileSync(path.join(guardsDir, data.guards[0]?.testFile ?? ""), "utf8"), GOOD_TEST);
  assert.equal(promote({ caseFile, resultsDir, guardsDir }).guards.length, 1);
});

const report = (guard: Partial<Guard>, catches: string[], noisy: string[] = []): GuardReport => ({ guard: { id: "g", title: "", scope: "class", kind: "command", ...guard }, catches, noisy, broken: [], status: catches.length ? "proven" : "not proven" });
const hits = (o: Record<string, boolean>): Map<string, boolean> => new Map(Object.entries(o));

test("retirement: a specialist is retirable only when a class guard has replaced it and nothing is lost", () => {
  const caseIds = ["a", "b", "c"];
  const baseline = hits({ a: true, b: true, c: false });

  const lost = judgeRetirement({ specialist: "nullflow", caseIds, baseline, without: hits({ a: true, b: false, c: false }), reports: [] });
  assert.equal(lost.retirable, false);
  assert.deepEqual(lost.lost, ["b"]);
  assert.deepEqual([lost.recallBaseline, lost.recallWithout], [2, 1]);

  // A regression test for bug b does not make the specialist retirable.
  const caseOnly = judgeRetirement({ specialist: "nullflow", caseIds, baseline, without: hits({ a: true, b: false, c: false }), reports: [report({ scope: "case", kind: "test" }, ["b"])] });
  assert.equal(caseOnly.retirable, false);
  assert.equal(caseOnly.cases.find((c) => c.id === "b")?.caseGuard, true);

  const covered = judgeRetirement({ specialist: "nullflow", caseIds, baseline, without: hits({ a: true, b: false, c: false }), reports: [report({}, ["b", "c"])] });
  assert.equal(covered.retirable, true);
  assert.equal(covered.recallWithoutPlusClassGuards, 3);
  assert.match(renderRetirement(covered), /RETIRABLE on this benchmark/);

  // Nothing lost, but nothing replaced it either: overlap with other specialists is not a reason to retire.
  const overlap = judgeRetirement({ specialist: "nullflow", caseIds, baseline, without: hits({ a: true, b: true, c: false }), reports: [] });
  assert.equal(overlap.retirable, false);
  assert.match(overlap.reason, /nothing has replaced/);

  const noisy = judgeRetirement({ specialist: "nullflow", caseIds, baseline, without: hits({ a: true, b: false, c: false }), reports: [report({}, ["b"], ["a"])] });
  assert.equal(noisy.retirable, false);
  assert.match(noisy.reason, /still fails after the real fix/);

  const incomplete = judgeRetirement({ specialist: "nullflow", caseIds, baseline, without: hits({ a: true }), reports: [report({}, ["b"])] });
  assert.equal(incomplete.retirable, false);
  assert.match(incomplete.reason, /no result for: b, c/);
});

test("reviewFile leaves out a specialist named in `without`", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "pick.py"), BUGGY);
  const labels: string[] = [];
  const model: ModelFn = async ({ label }) => {
    labels.push(label.split(" ")[0] ?? "");
    return '```json\n{"concerns":[],"dismissed":[]}\n```';
  };
  const res = await reviewFile({ root, file: "pick.py", model, without: ["missing"] });
  assert.deepEqual(res.specialists, ["intent", "mutation"]);
  assert.deepEqual(labels.sort(), ["intent", "mutation"]);
});
