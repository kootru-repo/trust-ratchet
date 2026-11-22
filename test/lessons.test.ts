// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runAuto, type RecordFile } from "../src/harness/auto.ts";
import { HARNESS_COMMANDS, harnessCli } from "../src/harness/cli.ts";
import { prevention } from "../src/harness/insight.ts";
import { COMMENT_FORMS, MIN_COMMITS, actedOn, lessonCard, renderLessons, ruleLesson, snapshotOf, type LessonFacts, type LessonRow } from "../src/harness/lessons.ts";
import type { Rule } from "../src/harness/rules.ts";
import { projectDir, readConfig, setSwitch, writeJson } from "../src/harness/state.ts";

process.env.RATCHET_CHILD = "";
const tmp = (name: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ratchet-${name}-`)));
const gitIn = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
const SID = "0a1b2c3d-1111-2222-3333-444455556666";
const here = path.resolve(import.meta.dirname, "..");

const rule = (id: string, kind: Rule["kind"], pattern: string, more: Partial<Rule> = {}): Rule => ({ id, kind, pattern, files: ["**/*.ts"], message: "m", fix: "f", ...more });
const rec = (i: number, findings: RecordFile["findings"], outcomes: RecordFile["outcomes"] = []): RecordFile => ({ time: `2026-11-20T10:${String(i).padStart(2, "0")}:00.000Z`, sessionId: SID, mode: "enforce", held: false, findings, outcomes });
const finding = (title: string, blocking: boolean, kind = "rule"): RecordFile["findings"][number] => ({ kind, file: "a.ts", title, blocking });
const ran = (name: string, status: string, kind = "test"): RecordFile["outcomes"][number] => ({ kind, name, status, seconds: 1 });
const facts = (more: Partial<LessonFacts> = {}): LessonFacts => ({ rules: [], config: {}, records: [], topFolders: ["src", "test"], census: {}, hatches: { total: 0, byName: {} }, sinceDate: null, before: null, since: null, snapshots: [], corrections: [], correctionsWaiting: 0, shown: [], logOn: false, ...more });
const row = (rows: LessonRow[], n: number): LessonRow => rows.find((r) => r.n === n) as LessonRow;
const page = (f: LessonFacts): string => renderLessons({ root: "r", rows: lessonCard(f), logOn: f.logOn, time: "2026-11-20T12:00:00.000Z" });

test("C1, C9, C10: nineteen rows with two cells each, the effect counts first, and no word that a lesson is met", () => {
  const rows = lessonCard(facts());
  assert.deepEqual(rows.map((r) => r.n), Array.from({ length: 19 }, (_, i) => i + 1));
  const text = page(facts());
  assert.equal(text.split("\n").filter((l) => /^\| \d+ \|/.test(l)).length, 19);
  assert.match(text, /\| # \| Lesson \(talk time, audit row\) \| In use here \| Effect measured \|/);
  assert.ok(text.indexOf("Effect shown: 0 of 19 lessons") < text.indexOf("In use here:"));
  assert.doesNotMatch(text, /achiev|improv|\bmet\b/i);
  // The lessons the harness cannot see say so, each with its reason.
  for (const n of [9, 11, 13, 14, 15, 18, 19]) assert.deepEqual([row(rows, n).inUse, row(rows, n).effect], [null, "not measured"], `row ${n}`);
  assert.equal(row(lessonCard(facts({ rules: [rule("no-x", "ban-pattern", "x")] })), 7).effect, "not measured");
  assert.match(row(rows, 1).use, /out of reach/);
  assert.match(row(rows, 15).use, /cannot tell which tokens/);
});

test("C2: a finding gone while it could hold the turn is compliance and never 'shown'; one gone while it could not is", () => {
  const rules = [rule("no-x", "ban-pattern", "x", { proof: { commit: "abc", file: "a.ts", firedBefore: 1, firedAfter: 0 } })];
  const held = facts({ rules, records: [rec(0, [finding("rule no-x, line 3", true)]), rec(1, [])] });
  assert.equal(row(lessonCard(held), 2).effect, "none yet");
  assert.match(row(lessonCard(held), 2).effectText, /could hold the turn: 1 \(compliance, not counted as effect\)/);
  assert.match(page(held), /Effect shown: 0 of 19/);
  const advised = facts({ rules, records: [rec(0, [finding("rule no-x, line 3", false)]), rec(1, [])] });
  assert.equal(row(lessonCard(advised), 2).effect, "shown");
  assert.match(row(lessonCard(advised), 2).effectText, /gone while it could not hold the turn: 1/);
  assert.match(page(advised), /Effect shown: 1 \(2\) of 19/);
  // Row 8 carries the same events and is outside the count.
  assert.equal(row(lessonCard(advised), 8).effect, "shared");
});

test("C2: a finding that only moved, and the finding of a command that was not run again, are not 'shown'", () => {
  const rules = [rule("no-x", "ban-pattern", "x", { proof: { commit: "abc", file: "a.ts", firedBefore: 1, firedAfter: 0 } })];
  // The same rule in the same file at two turn ends; an edit above it moved the line.
  const moved = facts({ rules, records: [rec(0, [finding("rule no-x, line 3", false)]), rec(1, [finding("rule no-x, line 9", false)])] });
  assert.equal(row(lessonCard(moved), 2).effect, "none yet");
  assert.deepEqual(prevention(moved.records).advisedActedOn, 0);
  // A hatch finding names its count and lines: another count in the same file is the same finding.
  const hatch = facts({ records: [rec(0, [finding("2 escape hatches added: noqa (line 1), noqa (line 2)", false, "hatch")]), rec(1, [finding("1 escape hatch added: noqa (line 2)", false, "hatch")])] });
  assert.equal(row(lessonCard(hatch), 6).effect, "none yet");
  // A check failed without holding the turn, and at the next turn end it was not run at all.
  const config = { checks: [{ name: "types", command: "c" }] };
  const notRerun = facts({ config, records: [rec(0, [finding("types", false, "check")], [ran("types", "fail", "check")]), rec(1, [], [])] });
  assert.equal(row(lessonCard(notRerun), 10).effect, "none yet");
  assert.match(page(notRerun), /Effect shown: 0 of 19/);
});

test("C3: one rule, test or driver counts for one row only, and the totals are those of prevention", () => {
  const rules = [rule("no-x", "ban-pattern", "x"), rule("no-eval", "ban-api", "eval"), rule("no-pkg", "ban-import", "three/addons/loaders/GLTFLoader.js"), rule("no-main", "ban-import", "src/main"), rule("no-up", "ban-import", "\\.\\./main")];
  assert.deepEqual(rules.map((r) => ruleLesson(r, ["src", "test"])), [2, 4, 4, 5, 5]);
  const config = { tests: [{ name: "guard-abc1234", command: "c", origin: "auto" as const }, { name: "unit", command: "c" }], checks: [{ name: "types", command: "c" }], drivers: [{ name: "drive", command: "c" }] };
  const records = [
    rec(0, [finding("rule no-x, line 1", false), finding("rule no-eval, line 2", false), finding("rule no-pkg, line 3", true), finding("rule no-main, line 4", false), finding("types", false, "check")], [ran("guard-abc1234", "fail"), ran("unit", "fail"), ran("drive", "fail", "driver"), ran("types", "fail", "check")]),
    rec(1, [], [ran("guard-abc1234", "pass"), ran("unit", "pass"), ran("drive", "pass", "driver"), ran("types", "pass", "check")]),
  ];
  const rows = lessonCard(facts({ rules, config, records }));
  const count = (n: number): [number, number] => [Number(/in one session: (\d+)/.exec(row(rows, n).effectText)?.[1] ?? 0), Number(/could not hold the turn: (\d+)/.exec(row(rows, n).effectText)?.[1] ?? 0)];
  assert.deepEqual(count(2), [1, 1], "the written test and the pattern rule");
  assert.deepEqual(count(4), [0, 1], "the ban of a call; the ban of an outside package was compliance");
  assert.match(row(rows, 4).effectText, /could hold the turn: 1 \(compliance/);
  assert.deepEqual(count(5), [0, 1], "the boundary rule");
  assert.deepEqual(count(10), [2, 0], "the mapped test and the check; the check's finding is the same event and is not counted again");
  assert.deepEqual(count(12), [1, 0], "the driver");
  assert.match(row(rows, 4).use, /no-eval, no-pkg/);
  assert.match(row(rows, 5).use, /no-main, no-up/);
  // C5: nothing counted twice and nothing lost against the function evidence.md is written from.
  const p = prevention(records);
  const acted = actedOn(records);
  assert.equal(acted.reduce((a, x) => a + x.advised, 0), p.advisedActedOn);
  assert.equal(acted.reduce((a, x) => a + x.holding, 0), p.holdingActedOn);
  const strong = [2, 4, 5, 6, 10, 12].reduce((a, n) => a + count(n)[0], 0);
  const advised = [2, 4, 5, 6, 10, 12].reduce((a, n) => a + count(n)[1], 0);
  assert.deepEqual([strong, advised], [p.turned.reduce((a, t) => a + t.times, 0), p.advisedActedOn - 1], "all of prevention's, less the one finding of a check");
  const snap = snapshotOf(facts({ rules, config, records }), "t");
  assert.deepEqual([snap.strong, snap.advised, snap.holding, snap.written, snap.tests, snap.drivers], [4, 4, 1, 1, 2, 1]);
});

test("C3, C7: a row that is not in use says so and waits for no effect", () => {
  const rows = lessonCard(facts({ rules: [rule("no-eval", "ban-api", "eval")] }));
  assert.deepEqual([row(rows, 4).inUse, row(rows, 4).effect], [true, "none yet"]);
  assert.deepEqual([row(rows, 5).inUse, row(rows, 5).effect], [false, "not in use"]);
  assert.deepEqual([row(rows, 12).inUse, row(rows, 12).effect], [false, "not in use"]);
});

test("C4: row 6 counts only the suppressions that are comments", () => {
  assert.equal(COMMENT_FORMS.length, 8);
  assert.ok(!COMMENT_FORMS.some((n) => /any|unknown|skipped/.test(n)));
  const byName = Object.fromEntries([...COMMENT_FORMS.map((n) => [n, 1] as const), ["skipped test", 5] as const]);
  const rows = lessonCard(facts({ hatches: { total: 20, byName: { ...byName, "skipped or only test": 7 } } }));
  assert.match(row(rows, 6).use, /counted: 8 in tracked source .* of 20 escape hatches/);
});

test("C6: outcome shares are compared only with twenty commits on each side, and the cell gives no verdict", () => {
  const o = (commits: number, fixes: number): LessonFacts["since"] => ({ commits, fixes, reverts: 0, fixOfFix: 0 });
  const few = row(lessonCard(facts({ sinceDate: "2026-11-20T00:00:00.000Z", before: o(176, 7), since: o(MIN_COMMITS - 1, 1) })), 17);
  assert.equal(few.effect, "too little history");
  assert.match(few.effectText, /1 of 19; before: 7 of 176/);
  const enough = row(lessonCard(facts({ sinceDate: "2026-11-20T00:00:00.000Z", before: o(200, 20), since: o(40, 1) })), 17);
  assert.equal(enough.effect, "measured");
  assert.match(enough.effectText, /this low or lower \d+\.\d%/);
  assert.doesNotMatch(enough.effectText, /better|worse|improv/i);
  assert.equal(row(lessonCard(facts()), 17).effect, "not in use");
});

test("C7, C8: off writes nothing and leaves evidence.md as it was; on keeps a line a pass, the page, and a record shown", () => {
  process.env.RATCHET_HOME = tmp("home");
  const repo = tmp("lessons");
  gitIn(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.py"), "x = 1  # noqa\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "add");
  setSwitch({ root: repo, enabled: true });
  const dir = projectDir(repo);
  writeJson(path.join(dir, "config.json"), { auto: true, tests: [{ name: "t0", when: ["a.py"], command: "node -e 0" }] });
  fs.mkdirSync(path.join(dir, "records"), { recursive: true });
  writeJson(path.join(dir, "records", "r00.json"), { ...rec(0, [], [ran("t0", "pass")]), root: repo });
  fs.writeFileSync(path.join(dir, "latest.md"), "# record\n");
  const quiet = { root: repo, memory: () => 10 };
  const logs = (): string[] => fs.readdirSync(dir).filter((f) => /^(lessons|shown|corrections)\./.test(f));
  const out: string[] = [];
  const log = console.log;
  console.log = (line: string) => void out.push(line);
  try {
    assert.ok(HARNESS_COMMANDS.has("lessons"));
    runAuto(quiet);
    runAuto(quiet); // the second pass is the steady state: the first one writes the first assessment
    const evidence = fs.readFileSync(path.join(dir, "evidence.md"), "utf8");
    assert.equal(harnessCli(["lessons", "--project", repo], here), 0);
    assert.equal(harnessCli(["lessons", "--project", repo, "--record"], here), 0);
    runAuto(quiet);
    assert.deepEqual(logs(), [], "off: no file of the log");
    assert.equal(fs.readFileSync(path.join(dir, "evidence.md"), "utf8"), evidence);
    assert.match(out.join("\n"), /The log is off for this project: nothing was written/);
    assert.match(out.join("\n"), /counted: 1 in tracked source \(noqa 1\), of 1 escape hatches/);

    assert.equal(harnessCli(["lessons", "--project", repo, "--on"], here), 0);
    assert.equal(readConfig(repo).lessonsLog, true);
    runAuto(quiet);
    const kept = fs.readFileSync(path.join(dir, "lessons.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { commentForms: number; tests: number });
    assert.equal(kept.length, 2, "one line at the switch, one at the pass");
    assert.deepEqual([kept[1]?.commentForms, kept[1]?.tests], [1, 1]);
    // Two lines seconds apart are no trend: the log has to span a day.
    assert.match(fs.readFileSync(path.join(dir, "lessons.md"), "utf8"), /comment suppressions: 1 now; a trend is read once the log spans a day/);
    const old = { ...(kept[0] as object), time: "2026-11-01T00:00:00.000Z", commentForms: 5 };
    assert.match(lessonCard({ ...facts({ logOn: true, hatches: { total: 1, byName: { noqa: 1 } } }), snapshots: [old, { ...old, time: "2026-11-20T00:00:00.000Z" }] as never }).find((r) => r.n === 6)?.effectText ?? "", /comment suppressions: 5 at the first line of the log \(2026-11-01\), 1 now/);
    assert.equal(fs.readFileSync(path.join(dir, "evidence.md"), "utf8"), evidence, "the card is its own page");
    process.env.CLAUDECODE = "1";
    assert.equal(harnessCli(["lessons", "--project", repo, "--record"], here), 0);
    process.env.CLAUDECODE = "";
    assert.equal(harnessCli(["lessons", "--project", repo, "--record"], here), 0);
    out.length = 0;
    assert.equal(harnessCli(["lessons", "--project", repo], here), 0);
    assert.match(out.join("\n"), /shown by command: 1 time\(s\) from a shell that is not an agent's, 1 from an agent's shell/);
    // Writing the config again keeps the switch, and off takes it out.
    assert.equal(harnessCli(["init", "--project", repo, "--force"], here), 0);
    assert.equal(readConfig(repo).lessonsLog, true);
    assert.equal(harnessCli(["lessons", "--project", repo, "--off"], here), 0);
    assert.equal(readConfig(repo).lessonsLog, undefined);
  } finally {
    console.log = log;
  }
});
