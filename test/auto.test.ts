// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isRealSession, reads_like_a_fix, renderEvidence, runAuto, supportOf, tally, tallyEdit, verdicts, whenFor, type Ledger, type RecordFile } from "../src/harness/auto.ts";
import { renderDashboard } from "../src/harness/dashboard.ts";
import { judgeRules, type Rule } from "../src/harness/rules.ts";
import { projectDir, projectFile, readConfig, writeJson } from "../src/harness/state.ts";
import { readRules } from "../src/harness/turn.ts";

const tmp = (name: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ratchet-${name}-`)));
const gitIn = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
const put = (repo: string, file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};
const SESSION = "0a1b2c3d-1111-2222-3333-444455556666";
const rec = (over: Partial<RecordFile>): RecordFile => ({ time: "t", sessionId: SESSION, mode: "enforce", held: false, findings: [], outcomes: [], ...over });
const finding = (id: string, file: string): RecordFile["findings"][number] => ({ kind: "rule", file, title: `rule ${id}, line 3`, blocking: false });
const EMPTY: Ledger = { rules: {}, open: {} };

test("the ledger counts a finding once when it appears, as fixed when it is gone, and as let go when the turn ends with it", () => {
  let l = tally(EMPTY, rec({ held: true, findings: [finding("auto-1", "a.py")] }));
  assert.deepEqual(l.rules["auto-1"], { fired: 1, fixed: 0, letGo: 0 });
  // The same finding in the next record of the session is not a second firing.
  l = tally(l, rec({ held: true, findings: [finding("auto-1", "a.py")] }));
  assert.equal(l.rules["auto-1"]?.fired, 1);
  l = tally(l, rec({ findings: [] }));
  assert.deepEqual(l.rules["auto-1"], { fired: 1, fixed: 1, letGo: 0 });
  const gone = tally(tally(EMPTY, rec({ findings: [finding("auto-2", "b.py")] })), rec({ findings: [finding("auto-2", "b.py")] }));
  // Standing over two turn ends of one session is one finding left standing, not two.
  assert.deepEqual(gone.rules["auto-2"], { fired: 1, fixed: 0, letGo: 1 });
});

test("a fix made right after the edit message is seen by the ledger, which a turn record alone would miss", () => {
  const ev = (rules: string[], file = "a.py") => ({ time: "t", sessionId: SESSION, file, rules });
  let l = tallyEdit(EMPTY, ev(["auto-1"]));
  l = tallyEdit(l, ev(["auto-1"]));
  assert.deepEqual(l.rules["auto-1"], { fired: 1, fixed: 0, letGo: 0 });
  // An edit of another file says nothing about this one.
  l = tallyEdit(l, ev([], "b.py"));
  assert.equal(l.rules["auto-1"]?.fixed, 0);
  l = tallyEdit(l, ev([]));
  assert.deepEqual(l.rules["auto-1"], { fired: 1, fixed: 1, letGo: 0 });
  // The turn then ends clean: nothing more is counted.
  assert.deepEqual(tally(l, rec({ findings: [] })).rules["auto-1"], { fired: 1, fixed: 1, letGo: 0 });
  // Left in place instead, the turn end counts it as let go, and it is not promoted.
  const left = tally(tallyEdit(EMPTY, ev(["auto-1"])), rec({ findings: [finding("auto-1", "a.py")] }));
  assert.deepEqual(left.rules["auto-1"], { fired: 1, fixed: 0, letGo: 1 });
});

test("promotion needs two occurrences that do not depend on each other, one of them live; only the loop's own rules are ever moved", () => {
  const base = { kind: "ban-pattern" as const, pattern: "x", files: ["**/*.py"], message: "m", fix: "f" };
  const trial = (id: string, support = 0): Rule => ({ id, ...base, origin: "auto", stage: "trial", evidence: { support, standing: 0, read: 50 } });
  const rules: Rule[] = [
    trial("auto-once"),
    trial("auto-once-and-history", 1),
    trial("auto-twice"),
    trial("auto-history-only", 5),
    trial("auto-ignored"),
    trial("auto-silent", 3),
    trial("auto-mixed", 4),
    { id: "auto-overruled", ...base, origin: "auto" },
    { id: "auto-holding", ...base, origin: "auto" },
    { id: "person", ...base },
  ];
  const t = (fired: number, fixed: number, letGo: number) => ({ fired, fixed, letGo });
  const ledger: Ledger = {
    open: {},
    rules: { "auto-once": t(1, 1, 0), "auto-once-and-history": t(1, 1, 0), "auto-twice": t(2, 2, 0), "auto-ignored": t(1, 0, 2), "auto-mixed": t(2, 1, 1), "auto-overruled": t(6, 2, 3), "auto-holding": t(9, 6, 3), person: t(9, 0, 9) },
    // Both were promoted at fired 3, fixed 2, left standing 0.
    promoted: { "auto-overruled": t(3, 2, 0), "auto-holding": t(3, 2, 0) },
  };
  assert.deepEqual(verdicts({ rules, ledger }), { promote: ["auto-once-and-history", "auto-twice"], retire: ["auto-ignored"], demote: ["auto-overruled"] });
});

test("history support counts the other past fixes that took out a line the rule fires on, and the evidence is printed per rule", () => {
  const rule: Rule = { id: "auto-1", kind: "ban-pattern", pattern: "os\\.system\\(", files: ["tools/**/*.py"], message: "m", fix: "f", origin: "auto", stage: "trial", proof: { commit: "aaaaaaaa1", file: "tools/a.py", firedBefore: 1, firedAfter: 0 } };
  const fixes = [
    { commit: "aaaaaaaa1", files: [{ file: "tools/a.py", removed: ["os.system(x)"], added: ["run(x)"] }] },
    { commit: "b", files: [{ file: "tools/b.py", removed: ["  os.system(y)"], added: ["  run(y)"] }] },
    // Moved, not fixed: the line comes back in what was added.
    { commit: "c", files: [{ file: "tools/c.py", removed: ["os.system(z)"], added: ["os.system(z)  # moved"] }] },
    // Outside the rule's files.
    { commit: "d", files: [{ file: "web/d.py", removed: ["os.system(w)"], added: ["run(w)"] }] },
  ];
  assert.equal(supportOf({ rule, fixes, except: "aaaaaaaa1" }), 1);
  assert.equal(supportOf({ rule, fixes }), 2);
  const text = renderEvidence({ rules: [{ ...rule, evidence: { support: 1, standing: 4, read: 4 } }, { ...rule, id: "by-hand", origin: undefined, stage: undefined } as Rule], ledger: { open: {}, rules: { "auto-1": { fired: 4, fixed: 3, letGo: 1 } } } });
  assert.match(text, /auto-1 \(loop, on trial; proven on fix aaaaaaaa\): live fired 4, fixed 3, left standing 1, precision 75%; 1 other past fix\(es\) of 4 read, 4 standing when written/);
  assert.match(text, /by-hand \(person, holds a turn; proven on fix aaaaaaaa\): live fired 0, fixed 0, left standing 0$/);
});

test("a rule on trial is reported and does not hold a turn", () => {
  const rule: Rule = { id: "auto-abc", kind: "ban-pattern", pattern: "os\\.system\\(", files: ["**/*.py"], message: "m", fix: "f", origin: "auto", stage: "trial" };
  const [f] = judgeRules({ rules: [rule], file: "a.py", content: "os.system('x')\n" });
  assert.equal(f?.blocking, false);
  assert.match(f?.detail ?? "", /on trial/);
  const { stage: _stage, ...promoted } = rule;
  assert.equal(judgeRules({ rules: [promoted], file: "a.py", content: "os.system('x')\n" })[0]?.blocking, true);
});

test("a test is mapped to the files it imports, and a hand-run proof session is not evidence", () => {
  assert.deepEqual(whenFor({ test: "tools/dm/test_a.py", text: "import os\nfrom dmlib import x\nimport helper, json\n", files: ["tools/dm/dmlib.py", "tools/helper.py", "tools/dm/test_a.py"] }), ["tools/dm/test_a.py", "tools/dm/dmlib.py", "tools/helper.py"]);
  assert.deepEqual(whenFor({ test: "test/a.test.ts", text: 'import { a } from "../src/a.ts";\nimport fs from "node:fs";\n', files: ["src/a.ts", "test/a.test.ts"] }), ["test/a.test.ts", "src/a.ts"]);
  assert.equal(isRealSession(SESSION), true);
  assert.equal(isRealSession("enf1"), false);
  assert.equal(reads_like_a_fix("Viewer shim reads the window; test file passes again"), false);
  assert.equal(reads_like_a_fix("fix: name the encoding"), true);
});

test("one pass after another: the loop maps a passing test, writes a trial rule from a fix, promotes it when it was fixed, and leaves a person's items alone", () => {
  process.env.RATCHET_HOME = tmp("home");
  const repo = tmp("auto");
  gitIn(repo, "init", "-q", "-b", "main");
  const bad = (n: string): string => `import subprocess\ndef go():\n    return subprocess.run(["${n}"], capture_output=True, text=True)\n`;
  put(repo, "tools/a.py", bad("a"));
  put(repo, "tools/b.py", bad("b"));
  put(repo, "tools/plain.py", 'import subprocess\n' + 'subprocess.run(["x"], capture_output=True)\n'.repeat(30));
  put(repo, "tools/test_ok.py", "import a\nassert True\n");
  put(repo, "tools/test_bad.py", "raise SystemExit(3)\n");
  put(repo, "sealed/test_never.py", "raise SystemExit(3)\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "add");
  const person: Rule = { id: "person-rule", kind: "ban-pattern", pattern: "never_there\\(", files: ["**/*.py"], message: "m", fix: "f", baseline: { "tools/a.py": 4 } };
  writeJson(projectFile(repo, "rules.json"), [person]);
  const manual = { name: "by-hand", command: "python -B tools/plain.py", when: ["tools/plain.py"] };
  const namesake = { name: "test_ok", command: "python -B -m something_else", when: ["tools/plain.py"] };
  writeJson(projectFile(repo, "config.json"), { tests: [manual, namesake], hatchCeiling: 9 });

  assert.match(runAuto({ memory: () => 10, root: repo }).skipped ?? "", /off/);
  assert.deepEqual(readRules(repo), [person]);

  writeJson(projectFile(repo, "config.json"), { ...readConfig(repo), auto: true, autoExclude: ["sealed/**"], autoTest: { py: "python -B {test}" } });
  // Switched on, the loop does not sweep the tests that were already there.
  assert.equal(runAuto({ memory: () => 10, root: repo }).changes.some((c) => /mapped/.test(c.what)), false);
  assert.equal(readConfig(repo).tests?.length, 2);
  // With memory short, no test is started, and it is said.
  const short = runAuto({ memory: () => 95, root: repo, backlog: true });
  assert.ok(short.notes.some((n) => /memory is at 95%/.test(n)) && !short.changes.some((c) => /mapped/.test(c.what)));
  const first = runAuto({ memory: () => 10, root: repo, backlog: true });
  const cfg1 = readConfig(repo);
  // The person's entry of the same name is still there, untouched; the loop's entry carries the folder.
  assert.deepEqual(cfg1.tests?.[1], namesake);
  const mapped = cfg1.tests?.find((t) => t.name === "test_ok@tools");
  assert.equal(mapped?.origin, "auto");
  assert.deepEqual(mapped?.when, ["tools/test_ok.py", "tools/a.py"]);
  assert.equal(cfg1.tests?.some((t) => t.name === "test_bad" || t.name === "test_never"), false);
  assert.deepEqual(cfg1.tests?.[0], manual);
  assert.equal(cfg1.hatchCeiling, 0);
  // A test written after the switch is timed without being asked.
  put(repo, "tools/test_new.py", "import a\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "a new test");
  assert.ok(runAuto({ memory: () => 10, root: repo }).changes.some((c) => /test test_new mapped/.test(c.what)));
  assert.ok(first.notes.some((n) => /test_bad\.py not mapped/.test(n)));
  assert.equal(first.notes.some((n) => /test_never/.test(n)), false);
  // A person's backlog falls with the tree, and the rule stays.
  assert.deepEqual(readRules(repo), [{ ...person, baseline: {} }]);
  assert.equal(first.level?.level !== undefined, true);

  put(repo, "tools/a.py", 'import subprocess\ndef go():\n    return subprocess.run(["a"], capture_output=True, text=True, encoding="utf-8")\n');
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "fix: name the encoding of the text read from a child");
  const fix = gitIn(repo, "rev-parse", "HEAD").trim();
  const second = runAuto({ memory: () => 10, root: repo });
  const id = `auto-${fix.slice(0, 7)}`;
  const learned = readRules(repo).find((r) => r.id === id);
  assert.equal(learned?.stage, "trial");
  assert.equal(learned?.origin, "auto");
  assert.equal(learned?.proof?.commit, fix);
  assert.deepEqual(learned?.baseline, { "tools/b.py": 1 });
  assert.ok(second.changes.some((c) => c.what.includes(id) && /rule remove --id/.test(c.undo)));
  // A third pass with no new commit writes nothing more.
  assert.equal(runAuto({ memory: () => 10, root: repo }).changes.length, 0);
  assert.equal(readRules(repo).filter((r) => r.origin === "auto").length, 1);

  // A real session trips the rule and fixes it: promoted. A proof session with a made-up id counts for nothing.
  const records = path.join(projectDir(repo), "records");
  const write = (name: string, r: RecordFile): void => writeJson(path.join(records, name), r);
  write("9001.json", rec({ sessionId: "px1", findings: [finding(id, "tools/c.py")] }));
  write("9002.json", rec({ sessionId: "px1", findings: [] }));
  assert.equal(readRules(repo).find((r) => r.id === id)?.stage === "trial" && runAuto({ memory: () => 10, root: repo }).changes.length === 0, true);
  const event = (sessionId: string, rules: string[]): string => `${JSON.stringify({ time: "t", sessionId, file: "tools/c.py", rules })}\n`;
  const events = path.join(projectDir(repo), "events.jsonl");
  fs.appendFileSync(events, event("px1", [id]) + event("px1", []));
  assert.equal(runAuto({ memory: () => 10, root: repo }).changes.length, 0);
  // The rule on trial does not hold the turn, so the fix shows only between two edits of the file.
  fs.appendFileSync(events, event(SESSION, [id]) + event(SESSION, []));
  write("9004.json", rec({ findings: [] }));
  // One live fix, and no other fix in the history: not enough to hold a turn.
  assert.equal(readRules(repo).find((r) => r.id === id)?.evidence?.support, 0);
  assert.equal(runAuto({ memory: () => 10, root: repo }).changes.some((c) => /promoted/.test(c.what)), false);
  // The same fault written and fixed a second time, in another session.
  const OTHER = "1a1b2c3d-1111-2222-3333-444455556666";
  fs.appendFileSync(events, event(OTHER, [id]) + event(OTHER, []));
  write("9005.json", rec({ sessionId: OTHER, findings: [] }));
  const fourth = runAuto({ memory: () => 10, root: repo });
  assert.ok(fourth.changes.some((c) => /promoted from trial/.test(c.what)));
  assert.equal(readRules(repo).find((r) => r.id === id)?.stage, undefined);
  assert.equal(readRules(repo).some((r) => r.id === "person-rule"), true);
  // Now holding turns, it is left standing in two more sessions and fixed in none: back on trial.
  for (const [n, sid] of [["9006", "2a1b2c3d-1111-2222-3333-444455556666"], ["9007", "3a1b2c3d-1111-2222-3333-444455556666"]] as const) write(`${n}.json`, rec({ sessionId: sid, findings: [{ ...finding(id, "tools/d.py"), blocking: true }] }));
  const back = runAuto({ memory: () => 10, root: repo });
  assert.ok(back.changes.some((c) => /put back on trial/.test(c.what)));
  assert.equal(readRules(repo).find((r) => r.id === id)?.stage, "trial");
  assert.equal(runAuto({ memory: () => 10, root: repo }).changes.length, 0);

  // Uncommitted work is not tightened on: the sibling is fixed in the working tree only, and its backlog stays.
  put(repo, "tools/b.py", "import subprocess\n");
  assert.equal(runAuto({ memory: () => 10, root: repo }).changes.some((c) => /backlog/.test(c.what)), false);
  assert.deepEqual(readRules(repo).find((r) => r.id === id)?.baseline, { "tools/b.py": 1 });
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "sibling");
  assert.ok(runAuto({ memory: () => 10, root: repo }).changes.some((c) => /backlog of rule auto-\w+ lowered from 1 to 0/.test(c.what)));
  const log = fs.readFileSync(path.join(projectDir(repo), "auto-log.jsonl"), "utf8").trim().split("\n");
  assert.ok(log.length >= 4 && log.every((l) => typeof (JSON.parse(l) as { undo?: string }).undo === "string"));
  assert.equal(gitIn(repo, "status", "--porcelain").trim(), "");
  assert.match(renderDashboard({ projects: [{ root: repo, last: { level: 2, name: "Ruled" }, history: [{ level: 1 }, { level: 2 }], level: fourth.level ? "Level 1 Watched:\n  [x] the harness is on (on)" : "" }], now: "now" }), /Ruled[\s\S]*the harness is on/);
});
