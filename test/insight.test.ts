// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gatherFacts, runAuto } from "../src/harness/auto.ts";
import { harnessCli } from "../src/harness/cli.ts";
import { baselineStep, guardVerdicts, offUnseen, prevention, readBaseline, selfCheck, type TurnRecord } from "../src/harness/insight.ts";
import { levelOf } from "../src/harness/level.ts";
import { isWritten, nearestFirst } from "../src/harness/turn.ts";
import { projectDir, projectFile, readConfig, writeJson } from "../src/harness/state.ts";

process.env.RATCHET_CHILD = "";
const SOURCE = path.resolve(import.meta.dirname, "..");
const tmp = (name: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ratchet-${name}-`)));
const gitIn = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
const put = (repo: string, file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};
const quiet = <T>(work: () => T): T => {
  const log = console.log;
  console.log = () => {};
  try {
    return work();
  } finally {
    console.log = log;
  }
};

test("what was acted on is read from the turn records as three counts that are never added up", () => {
  const finding = (title: string, blocking: boolean) => ({ kind: "rule", file: "a.py", title, blocking });
  const turn = (sessionId: string, time: string, findings: TurnRecord["findings"], outcomes: TurnRecord["outcomes"] = []): TurnRecord => ({ sessionId, time, findings, outcomes });
  const out = (name: string, status: string) => ({ kind: "test", name, status });
  const p = prevention([
    // Session one: a trial finding and a holding finding stand, then both are gone; a test fails, then passes.
    turn("s1", "1", [finding("rule trial-x", false), finding("rule hold-y", true)], [out("t1", "fail"), out("t2", "pass")]),
    turn("s1", "2", [], [out("t1", "pass"), out("t2", "pass")]),
    // Session two: the finding stays; the test that fails is never seen to pass; a failure in another session is not this one's.
    turn("s2", "3", [finding("rule hold-y", true)], [out("t3", "fail")]),
    turn("s2", "4", [finding("rule hold-y", true)], [out("t3", "not-run")]),
    turn("s3", "5", [], [out("t3", "pass")]),
  ]);
  assert.deepEqual(p, { advisedActedOn: 1, holdingActedOn: 1, turned: [{ name: "t1", times: 1 }], sessions: 3 });
});

test("the measure is checked against the commits that followed: a higher level with clearly more fixes is a contradiction, too little history says nothing", () => {
  const day = (n: number): string => new Date(Date.UTC(2026, 0, n)).toISOString();
  const commits = (from: number, n: number, fixes: number) => Array.from({ length: n }, (_, i) => ({ time: Date.parse(day(from)) / 1000 + i * 60, fix: i < fixes }));
  const assessments = [
    { time: day(1), level: 1, scheme: 3 },
    { time: day(2), level: 1, scheme: 3 },
    { time: day(10), level: 3, scheme: 3 },
    { time: day(5), level: 5, scheme: 2 },
  ];
  const bad = selfCheck({ assessments, commits: [...commits(1, 40, 2), ...commits(10, 40, 20)], scheme: 3 });
  assert.deepEqual(bad.periods.map((p) => [p.level, p.commits, p.fixes]), [[1, 40, 2], [3, 40, 20]]);
  assert.equal(bad.contradictions.length, 1);
  assert.match(bad.text, /CONTRADICTION/);
  const fine = selfCheck({ assessments, commits: [...commits(1, 40, 20), ...commits(10, 40, 2)], scheme: 3 });
  assert.equal(fine.contradictions.length, 0);
  const thin = selfCheck({ assessments, commits: [...commits(1, 5, 0), ...commits(10, 5, 5)], scheme: 3 });
  assert.deepEqual({ usable: thin.usable, n: thin.contradictions.length }, { usable: 0, n: 0 });
  assert.match(thin.text, /Too little history/);
  assert.match(thin.text, /does not calibrate/);
});

test("a baseline run gives a project no session has edited a first assessment, a few commands a pass, and is refused where full runs are forbidden", () => {
  process.env.RATCHET_HOME = tmp("home");
  const repo = tmp("base");
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, "ok.py", "x = 1\n");
  put(repo, "bad.py", "raise SystemExit(3)\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "add");
  put(repo, "someone.txt", "uncommitted work\n");
  const cmd = (name: string, command: string) => ({ name, command, when: ["*.py"] });
  writeJson(projectFile(repo, "config.json"), { auto: true, hatchCeiling: 0, tests: [cmd("a", "python -B ok.py"), cmd("b", "python -B ok.py"), cmd("c", "python -B ok.py")], checks: [cmd("lint", "lint {files}")] });
  const quietMem = { memory: () => 10 };
  const one = baselineStep({ root: repo, max: 2, ...quietMem });
  assert.deepEqual({ ran: one.ran, done: one.baseline?.done, dirty: one.baseline?.dirty }, { ran: 2, done: false, dirty: 1 });
  assert.equal(levelOf(gatherFacts(repo)).requirements.find((r) => /checked turn is on record/.test(r.text))?.met, false);
  const two = baselineStep({ root: repo, max: 2, ...quietMem });
  assert.deepEqual({ ran: two.ran, done: two.baseline?.done, statuses: two.baseline?.results.map((r) => r.status).sort() }, { ran: 1, done: true, statuses: ["pass", "pass", "pass", "skipped"] });
  assert.equal(levelOf(gatherFacts(repo)).requirements.find((r) => /checked turn is on record/.test(r.text))?.met, true);
  assert.equal(levelOf(gatherFacts(repo)).requirements.find((r) => /ended with nothing failing/.test(r.text))?.met, true);
  // The uncommitted file is still there, untouched, and no turn record was made.
  assert.equal(fs.readFileSync(path.join(repo, "someone.txt"), "utf8"), "uncommitted work\n");
  assert.equal(fs.existsSync(path.join(projectDir(repo), "records")), false);
  // A failing command is a failing baseline. A new commit starts the baseline again.
  writeJson(projectFile(repo, "config.json"), { ...readConfig(repo), tests: [cmd("a", "python -B bad.py")] });
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "more");
  const three = baselineStep({ root: repo, ...quietMem });
  assert.deepEqual(three.baseline?.results.map((r) => r.status), ["skipped", "fail"]);
  assert.equal(levelOf(gatherFacts(repo)).requirements.find((r) => /ended with nothing failing/.test(r.text))?.met, false);
  // Forbidden: nothing runs, nothing is written.
  const sealed = tmp("sealed");
  gitIn(sealed, "init", "-q", "-b", "main");
  put(sealed, "ok.py", "x = 1\n");
  gitIn(sealed, "add", "-A");
  gitIn(sealed, "commit", "-q", "-m", "add");
  writeJson(projectFile(sealed, "config.json"), { auto: true, noFullRuns: true, tests: [cmd("a", "python -B ok.py")] });
  assert.match(baselineStep({ root: sealed, ...quietMem }).note ?? "", /forbidden/);
  assert.equal(readBaseline(sealed), null);
  assert.ok(!runAuto({ root: sealed, ...quietMem }).notes.some((n) => /baseline/i.test(n)));
});

test("the loop runs the baseline by itself when there is no checked turn, and says when it finished", () => {
  process.env.RATCHET_HOME = tmp("home");
  const repo = tmp("loopbase");
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, "ok.py", "x = 1\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "add");
  writeJson(projectFile(repo, "config.json"), { auto: true, tests: [{ name: "a", command: "python -B ok.py", when: ["ok.py"] }] });
  const pass = runAuto({ root: repo, memory: () => 10 });
  assert.ok(pass.notes.some((n) => /Baseline run of the mapped commands.*1 passed, 0 failed.*finished/.test(n)));
  assert.equal(runAuto({ root: repo, memory: () => 10 }).notes.some((n) => /aseline run/.test(n)), false);
  assert.match(fs.readFileSync(path.join(projectDir(repo), "evidence.md"), "utf8"), /Acted on, read from 0 session[\s\S]*Too little history[\s\S]*Baseline run/);
});

test("a loop that was on and is off without an off command is said in one line; an off command ends the notice; it is never switched back on", () => {
  process.env.RATCHET_HOME = tmp("home");
  const repo = tmp("offmark");
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, "a.py", "x = 1\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "add");
  assert.equal(offUnseen(repo), null);
  quiet(() => harnessCli(["auto", "--project", repo, "--on"], SOURCE));
  assert.equal(offUnseen(repo), null);
  // The config is written again by hand, without the switch.
  writeJson(projectFile(repo, "config.json"), { checks: [] });
  assert.match(offUnseen(repo) ?? "", /is off now, though nobody switched it off by command/);
  assert.equal(readConfig(repo).auto, undefined);
  // Switched off by command: no notice. The mark survives another rewrite of the config.
  quiet(() => harnessCli(["auto", "--project", repo, "--off"], SOURCE));
  writeJson(projectFile(repo, "config.json"), { checks: [] });
  assert.equal(offUnseen(repo), null);
  // On again by command, then lost again: the notice is back.
  quiet(() => harnessCli(["auto", "--project", repo, "--on"], SOURCE));
  runAuto({ root: repo, memory: () => 10 });
  writeJson(projectFile(repo, "config.json"), {});
  assert.notEqual(offUnseen(repo), null);
});

test("a test the harness wrote is on trial: it never takes a place from a project test, is promoted when a session acted on it, and is taken out when left failing twice", () => {
  const t = (name: string, when: string[], origin?: "auto") => ({ name, when, command: name, ...(origin ? { origin } : {}) });
  const tests = [t("guard-abc1234", ["src/a.ts"], "auto"), t("wide", ["test/wide.test.ts", "src/a.ts", "src/b.ts"]), t("near", ["test/near.test.ts", "src/a.ts"], "auto")];
  assert.deepEqual(nearestFirst(tests, ["src/a.ts"]).map((x) => x.name), ["near", "wide", "guard-abc1234"]);
  assert.equal(isWritten(tests[0] as (typeof tests)[number]), true);
  assert.equal(isWritten(tests[2] as (typeof tests)[number]), false);
  const turn = (sessionId: string, time: string, outcomes: TurnRecord["outcomes"]): TurnRecord => ({ sessionId, time, findings: [], outcomes });
  const out = (name: string, status: string) => ({ kind: "test", name, status });
  const v = guardVerdicts({
    names: ["guard-acted", "guard-noise", "guard-once", "guard-quiet"],
    records: [
      turn("s1", "1", [out("guard-acted", "fail"), out("guard-noise", "fail"), out("guard-once", "fail")]),
      turn("s1", "2", [out("guard-acted", "pass"), out("guard-noise", "fail")]),
      turn("s2", "3", [out("guard-noise", "fail"), out("guard-quiet", "pass")]),
    ],
  });
  assert.deepEqual(v, { promote: ["guard-acted"], retire: ["guard-noise"] });
});

test("the loop puts the tests it wrote on trial, where a failure is reported and does not hold the turn", () => {
  process.env.RATCHET_HOME = tmp("home");
  const repo = tmp("trial");
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, "ok.py", "x = 1\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "add");
  const person = { name: "guard-by-hand", command: "python -B ok.py", when: ["ok.py"] };
  writeJson(projectFile(repo, "config.json"), { auto: true, noFullRuns: true, tests: [{ name: "guard-abc1234", command: "python -B ok.py", when: ["ok.py"], origin: "auto" }, person] });
  const pass = runAuto({ root: repo, memory: () => 10 });
  assert.ok(pass.changes.some((c) => /1 test\(s\) the harness wrote are on trial from now on/.test(c.what)));
  assert.deepEqual(readConfig(repo).tests?.map((x) => x.stage), ["trial", undefined]);
  assert.equal(runAuto({ root: repo, memory: () => 10 }).changes.length, 0);
});
