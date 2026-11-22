import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runAuto } from "../src/harness/auto.ts";
import { HARNESS_COMMANDS, harnessCli } from "../src/harness/cli.ts";
import { CUT_BY_BUDGET, OUT_OF_BUDGET, ceiling, decide, effectiveLimits, nextWaits, renderLimits, replay, skipCause, turnStats, unrunAtEnd, type RecordLike, type TurnStat } from "../src/harness/limits.ts";
import { ensureBaseline } from "../src/harness/session.ts";
import { projectDir, readConfig, readJson, setSwitch, writeJson } from "../src/harness/state.ts";
import { checkOrder, nearestFirst, runTurn } from "../src/harness/turn.ts";

process.env.RATCHET_CHILD = "";
const tmp = (name: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ratchet-${name}-`)));
const gitIn = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
const put = (repo: string, file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};
const newRepo = (files: Record<string, string>): string => {
  const repo = tmp("limits");
  gitIn(repo, "init", "-q", "-b", "main");
  for (const [f, t] of Object.entries(files)) put(repo, f, t);
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "add");
  return repo;
};
const OVER = "over the limit of 3 mapped tests per turn end";
const SID = "0a1b2c3d-1111-2222-3333-444455556666";
const ran = (name: string, seconds: number, kind = "test") => ({ kind, name, status: "pass", seconds, note: "" });
const left = (name: string, note = OVER) => ({ kind: "test", name, status: "not-run", seconds: 0, note });
const rec = (i: number, outcomes: RecordLike["outcomes"], extra: Partial<RecordLike> = {}): RecordLike => ({ time: `2026-11-20T10:${String(i).padStart(2, "0")}:00.000Z`, sessionId: SID, outcomes, ...extra });
const stat = (i: number, part: Partial<TurnStat>): TurnStat => ({ time: `2026-11-20T10:${String(i).padStart(2, "0")}:00.000Z`, sessionId: SID, ranSeconds: 10, wallS: 10, fileS: 1, testSeconds: [3, 3, 4], otherSeconds: 2, overCount: [], outOfBudget: [], cut: [], stillOwed: [], ...part });

test("L1: the file checks take code before data when more files changed than are checked", () => {
  const changed = [...Array.from({ length: 300 }, (_, i) => `bench/results/${i}.json`), "src/a.ts", "tools/b.py"];
  assert.deepEqual(checkOrder(changed).slice(0, 2), ["src/a.ts", "tools/b.py"]);
  assert.equal(checkOrder(changed).length, 302);
});

test("L2: the three ways a limit leaves a command unrun are told apart, and nothing else is taken for one", () => {
  assert.equal(skipCause(left("t")), "count");
  assert.equal(skipCause(left("t", "over the limit of 3 written tests per turn end")), "count");
  assert.equal(skipCause(left("t", OUT_OF_BUDGET)), "budget");
  assert.equal(skipCause(left("t", `${CUT_BY_BUDGET} after 4 s (its own limit is 60 s)`)), "cut");
  assert.equal(skipCause(left("t", "did not finish inside its time limit")), null);
  assert.equal(skipCause(left("t", "could not run: no such file")), null);
  assert.equal(skipCause(ran("t", 2)), null);
  // The loop's own words for a test that cannot run do not match a cut by the budget.
  assert.doesNotMatch(`${CUT_BY_BUDGET} after 4 s`, /^(did not finish|could not run)/);
});

test("L2, L3: a command cut by the turn's budget says so, the record carries wall-clock time, and a shared deadline binds", () => {
  process.env.RATCHET_HOME = tmp("home");
  const repo = newRepo({ "a.py": "x = 1\n", "slow.js": "setTimeout(() => {}, 20000);\n" });
  setSwitch({ root: repo, enabled: true });
  writeJson(path.join(projectDir(repo), "config.json"), { tests: [{ name: "slow", when: ["a.py"], command: "node slow.js", timeoutS: 30 }] });
  const { baseline } = ensureBaseline("s1", repo);
  put(repo, "a.py", "x = 2\n");
  // The Stop shared deadline leaves this repository eight seconds (a margin that survives a loaded machine: the file checks before the command may take seconds), well under the test own thirty.
  const out = runTurn({ sessionId: "s1", baseline, stopDeadline: Date.now() + 8000 });
  assert.equal(out?.outcomes[0]?.status, "not-run");
  assert.match(out?.outcomes[0]?.note ?? "", /^cut short by the time budget of the turn checks after \d+ s \(its own limit is 30 s\)/);
  assert.equal(skipCause(out?.outcomes[0] ?? { status: "" }), "cut");
  assert.ok((out?.wallS ?? 0) >= 2 && (out?.wallS ?? 0) < 15 && (out?.fileS ?? -1) >= 0);
  // With no room at all the command is not started: out of budget, which is owed at the next turn end.
  put(repo, "a.py", "x = 3\n");
  const none = runTurn({ sessionId: "s1", baseline, stopDeadline: Date.now() });
  assert.equal(skipCause(none?.outcomes[0] ?? { status: "" }), "budget");
});

test("L5: among tests waiting, the test of the file just changed goes first, then the one that has waited longest", () => {
  const t = (name: string, when: string[]) => ({ name, when, command: "x" });
  const tests = [t("a", ["a.py"]), t("b", ["b.py", "lib.py"]), t("c", ["c.py", "lib.py"]), t("d", ["d.py", "lib.py"])];
  assert.deepEqual(nearestFirst(tests, ["lib.py"]).map((x) => x.name), ["a", "b", "c", "d"]);
  assert.deepEqual(nearestFirst(tests, ["lib.py"], { d: 4, c: 1 }).map((x) => x.name), ["d", "c", "a", "b"]);
  assert.deepEqual(nearestFirst(tests, ["b.py", "lib.py"], { d: 4, c: 1 }).map((x) => x.name), ["b", "d", "c", "a"]);
  assert.deepEqual(nextWaits({ d: 4, c: 1 }, [ran("d", 2), left("c"), left("b", OUT_OF_BUDGET), left("a", "could not run: x")]), { c: 2, b: 1 });
});

test("L6: a person's value is the floor, the loop's value counts only above it, and the budget never passes the hook's own limit", () => {
  assert.deepEqual(effectiveLimits({}), { floorTests: 3, floorBudgetS: 120, tests: 3, budgetS: 120 });
  assert.deepEqual(effectiveLimits({ maxTestsPerStop: 4, autoLimits: { tests: 2 } }), { floorTests: 4, floorBudgetS: 120, tests: 4, budgetS: 120 });
  assert.deepEqual(effectiveLimits({ maxTestsPerStop: 4, autoLimits: { tests: 6, budgetS: 150 } }), { floorTests: 4, floorBudgetS: 120, tests: 6, budgetS: 150 });
  assert.equal(effectiveLimits({ autoLimits: { budgetS: 900 } }).budgetS, 170);
});

test("L7: turns that ran nothing are left out, the ceiling comes from the project's own times, and the count moves one step with a pause", () => {
  const stats = turnStats([rec(1, [ran("a", 4), ran("types", 6, "check"), left("b"), left("c")], { wallS: 12, fileS: 2 }), rec(2, [{ kind: "test", name: "a", status: "pass", seconds: 0, note: "its files are unchanged" }]), rec(3, [ran("b", 5), left("c", OUT_OF_BUDGET)])]);
  assert.deepEqual(stats.map((s) => [s.wallS, s.fileS, s.overCount, s.outOfBudget, s.otherSeconds]), [[12, 2, ["b", "c"], [], 6], [5, 0, [], ["c"], 0]]);
  const limits = effectiveLimits({});
  const busy = Array.from({ length: 10 }, (_, i) => stat(i, { overCount: ["x"], stillOwed: i % 2 === 0 ? ["x"] : [], wallS: 20 }));
  // Left at two turn ends running is read from the records: e was left at both, d only at the first.
  assert.deepEqual(turnStats([rec(1, [ran("a", 2), left("d"), left("e")]), rec(2, [ran("d", 2), left("e")])]).map((s) => s.stillOwed), [[], ["e"]]);
  const top = ceiling({ stats: busy, limits, mapped: 23, written: 0 });
  // (120 s less 2 s of other commands) / 4 s for a slow test = 29 tests, and there are 23.
  assert.deepEqual([top.tests, top.budgetS], [23, 169]);
  // With two written tests beside them: 27 mapped and 2 written are 116 s, one more would be 120.
  assert.equal(ceiling({ stats: busy, limits, mapped: 40, written: 2 }).tests, 27);
  assert.equal(ceiling({ stats: busy, limits, mapped: 40, written: 40 }).tests, 14);
  assert.equal(ceiling({ stats: [], limits, mapped: 23, written: 0 }).tests, 3);
  const up = decide({ stats: busy, limits, top, last: null, noRaise: false });
  assert.equal(up?.tests, 4);
  assert.match(up?.what ?? "", /goes up from 3 to 4 \(ceiling 23/);
  // Not where full runs are forbidden, not with too few turns, not when the turns already use most of the budget.
  assert.equal(decide({ stats: busy, limits, top, last: null, noRaise: true }), null);
  assert.equal(decide({ stats: busy.slice(0, 4), limits, top, last: null, noRaise: false }), null);
  assert.equal(decide({ stats: busy.map((s) => ({ ...s, wallS: 90 })), limits, top, last: null, noRaise: false }), null);
  // A test left once and run at the next turn end is no harm: no raise, however often it happens.
  assert.equal(decide({ stats: busy.map((s, i) => ({ ...s, stillOwed: i < 4 ? ["x"] : [] })), limits, top, last: null, noRaise: false }), null);
  assert.equal(decide({ stats: busy.map((s) => ({ ...s, stillOwed: [] })), limits, top, last: null, noRaise: false }), null);
  // A move needs new evidence: three turns recorded since the last move the same way.
  assert.equal(decide({ stats: busy, limits, top, last: { time: busy[8]?.time ?? "", dir: "up" }, noRaise: false }), null);
  assert.equal(decide({ stats: busy, limits, top, last: { time: busy[6]?.time ?? "", dir: "up" }, noRaise: false })?.tests, 4);
  // Down when a command was cut by the budget twice, never under the floor, and not against a move just made.
  const raised = effectiveLimits({ autoLimits: { tests: 5 } });
  const cut = busy.map((s, i) => ({ ...s, cut: i >= 8 ? ["x"] : [] }));
  assert.equal(decide({ stats: cut, limits: raised, top, last: null, noRaise: false })?.tests, 4);
  assert.equal(decide({ stats: cut, limits, top, last: null, noRaise: false }), null);
  assert.equal(decide({ stats: cut, limits: raised, top, last: { time: cut[7]?.time ?? "", dir: "up" }, noRaise: false }), null);
  assert.equal(decide({ stats: cut, limits: raised, top, last: { time: cut[3]?.time ?? "", dir: "up" }, noRaise: false })?.tests, 4);
  // The budget is never raised by the loop; one it holds comes down in 15 s steps once the count is at its floor.
  const atTop = effectiveLimits({ autoLimits: { tests: 23 } });
  assert.equal(decide({ stats: busy, limits: atTop, top, last: null, noRaise: false }), null);
  assert.equal(decide({ stats: cut, limits: effectiveLimits({ autoLimits: { budgetS: 150 } }), top, last: null, noRaise: false })?.budgetS, 135);
});

test("L8: tests still unrun at a session's last turn are counted, and the replay is an estimate that carries what ran", () => {
  const other = "0a1b2c3d-9999-2222-3333-444455556666";
  const records = [
    rec(1, [ran("a", 2), ran("b", 2), ran("c", 2), left("d"), left("e"), left("f")]),
    rec(2, [ran("a", 2), left("d"), left("e"), left("f")]),
    { ...rec(3, [ran("a", 2), ran("b", 2)]), sessionId: other },
  ];
  assert.deepEqual(unrunAtEnd(records).map((e) => [e.turns, e.unrun]), [[2, ["d", "e", "f"]], [1, []]]);
  // One more test a turn end: d at the first turn, e at the second, f still left.
  assert.deepEqual(replay({ records, extra: 1 }), { sessions: 2, turns: 3, unrunBefore: 3, unrunAfter: 1, extraRuns: 2, extraSeconds: 4, sessionsWithUnrun: 1, sessionsWithUnrunAfter: 1 });
  assert.equal(replay({ records, extra: 3 }).unrunAfter, 0);
  assert.equal(replay({ records, extra: 0 }).unrunAfter, 3);
  const page = renderLimits({ limits: effectiveLimits({}), top: { tests: 5, budgetS: 168, why: "x" }, stats: turnStats(records), waits: { d: 2 }, ends: unrunAtEnd(records), on: false });
  assert.match(page, /Tests per turn end: 3 \(floor 3, ceiling 5\)[\s\S]*the loop does not raise it[\s\S]*does not move the count here[\s\S]*Waiting longest: d, left unrun at 2 turn end\(s\)[\s\S]*still unrun at a session's last recorded turn: 3 in 1 session/);
});

test("L7: the loop moves its own value only where the moves are on, logs the move with its undo, and never writes the person's value", () => {
  process.env.RATCHET_HOME = tmp("home");
  const repo = newRepo({ "a.py": "x = 1\n" });
  setSwitch({ root: repo, enabled: true });
  const configFile = path.join(projectDir(repo), "config.json");
  const tests = Array.from({ length: 8 }, (_, i) => ({ name: `t${i}`, when: ["a.py"], command: "node -e 0" }));
  writeJson(configFile, { auto: true, maxTestsPerStop: 3, tests });
  const dir = path.join(projectDir(repo), "records");
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 10; i++) writeJson(path.join(dir, `r${String(i).padStart(2, "0")}.json`), { ...rec(i, [ran("t0", 3), ran("t1", 3), ran("t2", 4), left("t3"), left("t4")], { wallS: 12, fileS: 1 }), mode: "enforce", held: false, findings: [] });
  const quiet = { root: repo, memory: () => 10 };
  // Off: nothing moves, and the page says so.
  assert.deepEqual(runAuto(quiet).changes.filter((c) => /turn end|time budget/.test(c.what)), []);
  assert.equal(readConfig(repo).autoLimits, undefined);
  assert.match(fs.readFileSync(path.join(projectDir(repo), "evidence.md"), "utf8"), /## Turn-end limits[\s\S]*does not move the count here/);
  // On: one step up a pass, the person's value untouched, the undo names the value before.
  writeJson(configFile, { ...readJson<Record<string, unknown>>(configFile, {}), autoLimitsOn: true });
  const first = runAuto(quiet).changes.filter((c) => /turn end/.test(c.what));
  assert.match(first[0]?.what ?? "", /the count of tests per turn end goes up from 3 to 4 \(ceiling 8/);
  assert.match(first[0]?.undo ?? "", /set "autoLimits" in .* back to \{\}/);
  assert.deepEqual([readConfig(repo).maxTestsPerStop, readConfig(repo).autoLimits], [3, { tests: 4 }]);
  // A second pass over the same records has no new evidence: nothing moves. Three more turns, and it may.
  assert.equal(runAuto(quiet).changes.filter((c) => /turn end/.test(c.what)).length, 0);
  assert.deepEqual(readConfig(repo).autoLimits, { tests: 4 });
  for (let i = 10; i < 13; i++) writeJson(path.join(dir, `r${String(i).padStart(2, "0")}.json`), { ...rec(i, [ran("t0", 3), ran("t1", 3), ran("t2", 4), ran("t5", 3), left("t3"), left("t4")], { wallS: 15, fileS: 1 }), mode: "enforce", held: false, findings: [] });
  assert.equal(runAuto(quiet).changes.filter((c) => /turn end/.test(c.what)).length, 1);
  assert.deepEqual(readConfig(repo).autoLimits, { tests: 5 });
  // Where full runs are forbidden there is no raise.
  writeJson(configFile, { ...readJson<Record<string, unknown>>(configFile, {}), autoLimits: undefined, noFullRuns: true });
  assert.deepEqual(runAuto(quiet).changes.filter((c) => /turn end/.test(c.what)), []);
  // A value of the loop above a ceiling that fell comes down at once, on or off.
  writeJson(configFile, { auto: true, maxTestsPerStop: 3, tests: tests.slice(0, 4), autoLimits: { tests: 7 } });
  const fell = runAuto(quiet).changes.filter((c) => /come down to their ceiling/.test(c.what));
  assert.equal(fell.length, 1);
  assert.deepEqual(readConfig(repo).autoLimits, { tests: 4 });
});

test("the limits command is a harness command: it prints the limits, the replay, and switches the moves on and off", () => {
  process.env.RATCHET_HOME = tmp("home");
  const repo = newRepo({ "a.py": "x = 1\n" });
  setSwitch({ root: repo, enabled: true });
  writeJson(path.join(projectDir(repo), "config.json"), { maxTestsPerStop: 4, tests: [{ name: "t", when: ["a.py"], command: "node -e 0" }] });
  const lines: string[] = [];
  const log = console.log;
  console.log = (line?: unknown) => void lines.push(String(line));
  try {
    assert.ok(HARNESS_COMMANDS.has("limits"));
    assert.equal(harnessCli(["limits", "--project", repo, "--replay"], path.resolve(import.meta.dirname, "..")), 0);
    assert.equal(harnessCli(["limits", "--project", repo, "--on"], path.resolve(import.meta.dirname, "..")), 0);
    assert.equal(readConfig(repo).autoLimitsOn, true);
    assert.equal(harnessCli(["limits", "--project", repo, "--off"], path.resolve(import.meta.dirname, "..")), 0);
    assert.equal(readConfig(repo).autoLimitsOn, undefined);
    assert.equal(readConfig(repo).maxTestsPerStop, 4);
  } finally {
    console.log = log;
  }
  assert.match(lines.join("\n"), /Tests per turn end: 4 \(floor 4[\s\S]*AN ESTIMATE[\s\S]*as recorded[\s\S]*may move the turn-end limits[\s\S]*no longer moves/);
});

test("L4: the drain reaches what is owed even when a failing test stands ahead of it, and then stops", () => {
  process.env.RATCHET_HOME = tmp("home");
  const count = "require('fs').appendFileSync('runs.log', process.argv[2] + '\\n'); process.exit(process.argv[2] === 'f' ? 1 : 0);";
  const repo = newRepo({ "a.py": "x = 1\n", "count.js": count, ".gitignore": "runs.log\n" });
  setSwitch({ root: repo, enabled: true });
  writeJson(path.join(projectDir(repo), "config.json"), { maxTestsPerStop: 1, tests: ["f", "g", "h"].map((n) => ({ name: n, when: ["a.py"], command: `node count.js ${n}` })) });
  const { baseline } = ensureBaseline("s2", repo);
  const runs = (): string[] => (fs.existsSync(path.join(repo, "runs.log")) ? fs.readFileSync(path.join(repo, "runs.log"), "utf8").trim().split("\n") : []);
  put(repo, "a.py", "x = 2\n");
  const first = runTurn({ sessionId: "s2", baseline });
  assert.deepEqual(runs(), ["f"]);
  assert.deepEqual(first?.outcomes.map((o) => skipCause(o)), [null, "count", "count"]);
  // Nothing changed. The failing test is not run again; the two owed tests are, one a turn end, the longest wait first.
  const second = runTurn({ sessionId: "s2", baseline });
  assert.deepEqual(runs(), ["f", "g"]);
  const again = second?.outcomes.find((o) => o.name === "f");
  assert.match(again?.note ?? "", /already run at this state of its files/);
  assert.deepEqual([again?.status, again?.seconds], ["fail", 0]);
  runTurn({ sessionId: "s2", baseline });
  assert.deepEqual(runs(), ["f", "g", "h"]);
  assert.equal(runTurn({ sessionId: "s2", baseline })?.repeated, true);
  assert.deepEqual(runs(), ["f", "g", "h"]);
});
