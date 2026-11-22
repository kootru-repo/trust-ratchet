import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { addGuardJob, judge, leansOnNew, plainDiff, writeGuard } from "../src/harness/guardwriter.ts";
import { adopt, faultReturns, pick, readWalk, renderSweep, summarizeSweep, sweep, walk, walkFixes } from "../src/harness/guardsweep.ts";
import { projectDir, projectFile, readConfig, writeJson } from "../src/harness/state.ts";
import type { ModelFn } from "../src/types.ts";

process.env.RATCHET_CHILD = "";
const tmp = (name: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ratchet-${name}-`)));
const gitIn = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
const put = (repo: string, file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};
const commit = (repo: string, message: string): string => {
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", message);
  return gitIn(repo, "rev-parse", "HEAD").trim();
};
const BUG = "def add(a, b):\n    return a - b\n";
const FIX = "def add(a, b):\n    return a + b\n";
const HEADER = 'import os, sys\nsys.path.insert(0, os.path.join(os.getcwd(), "tools"))\nimport calc\n';
const GOOD_TEST = `${HEADER}assert calc.add(2, 3) == 5\n`;
const fenced = (code: string): string => `\`\`\`python\n${code}\`\`\`\n`;
const quiet = { memory: () => 10 };

test("a proof on two sides is read into one class, and only a failed assertion before with a pass after is kept", () => {
  const cls = (before: "passes" | "fails" | "errors", after: "passes" | "fails" | "errors", wrote = false): string => judge({ before, after, wrote }).cls;
  assert.equal(cls("fails", "passes"), "kept");
  assert.equal(cls("errors", "passes"), "errors-before");
  assert.equal(cls("passes", "passes"), "passes-both");
  assert.equal(cls("fails", "fails"), "fails-both");
  assert.equal(cls("passes", "fails"), "not-passing-after");
  assert.equal(cls("fails", "passes", true), "wrote-files");
});

test("a written test that leans on a name the fix itself added is seen, in Python and in TypeScript", () => {
  const py = [{ file: "tools/calc.py", before: "def add(a, b):\n    return a + b\n", after: "LIMIT = 9\ndef add(a, b):\n    return clamp(a + b)\ndef clamp(x):\n    return x\n" }];
  assert.equal(leansOnNew({ files: py, code: "assert calc.clamp(3) == 3\n" }), "clamp");
  assert.equal(leansOnNew({ files: py, code: "assert calc.add(1, 2) == 3  # not clamped\n" }), null);
  const ts = [{ file: "src/a.ts", before: "export const load = () => 1;\n", after: "export const load = () => 1;\nexport function loadAll() { return [1]; }\n" }];
  assert.equal(leansOnNew({ files: ts, code: "assert.equal(mod.loadAll().length, 1)" }), "loadAll");
  assert.equal(leansOnNew({ files: ts, code: "assert.equal(mod.load(), 1) // loadAllowed" }), null);
});

test("the loop refuses a written test that does not load before the fix, that writes into the tree, or that is stale in the project as it is now", async () => {
  process.env.RATCHET_HOME = tmp("home");
  const repo = tmp("hard");
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, "tools/calc.py", BUG);
  commit(repo, "add");
  put(repo, "tools/calc.py", `${FIX}def twice(a):\n    return add(a, a)\n`);
  const fix = commit(repo, "fix: add subtracted");
  writeJson(projectFile(repo, "config.json"), { auto: true, autoGuards: true, autoTest: { py: "python -B {test}" } });
  const replies: string[] = [];
  const model: ModelFn = async () => replies.shift() ?? "UNTESTABLE";
  const tryWith = async (code: string) => (await writeGuard({ root: repo, model, only: fix, ...quiet })).tried ?? { cls: "", reason: "" };
  // Throws before the fix instead of failing an assertion: it proves nothing about the behaviour.
  replies.push(fenced(`${HEADER}assert calc.missing_name(2) == 4\n`));
  assert.equal((await tryWith("")).cls, "errors-before");
  // Uses a function the fix added.
  replies.push(fenced(`${HEADER}assert calc.twice(2) == 4\n`));
  assert.equal((await tryWith("")).cls, "new-name");
  // Writes a file into the tree it runs in.
  replies.push(fenced(`${HEADER}open(os.path.join(os.getcwd(), "tools", "made.txt"), "w").write("x")\nassert calc.add(2, 3) == 5\n`));
  assert.equal((await tryWith("")).cls, "wrote-files");
  assert.equal(readConfig(repo).tests, undefined);
  // Right for the fix, but the project has moved on: it fails now, so it is not mapped.
  put(repo, "tools/calc.py", "def add(a, b):\n    return float(a + b) + 0.5\n");
  commit(repo, "sums are shifted now");
  replies.push(fenced(GOOD_TEST));
  const stale = await tryWith("");
  assert.equal(stale.cls, "stale-now");
  assert.equal(readConfig(repo).tests, undefined);
  assert.equal(gitIn(repo, "status", "--porcelain").trim(), "");
});

test("a change that followed a correction in chat gets a written test: the model sees the two texts and never the chat", async () => {
  process.env.RATCHET_HOME = tmp("home");
  const repo = tmp("chat");
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, "tools/calc.py", BUG);
  const head = commit(repo, "add");
  put(repo, "tools/calc.py", FIX);
  writeJson(projectFile(repo, "config.json"), { auto: true, autoGuards: true, autoTest: { py: "python -B {test}" } });
  addGuardJob(repo, { id: "2026-11-20T10-00-00-000Z-abc1234", time: "2026-11-20T10:00:00.000Z", head, files: [{ file: "tools/calc.py", before: BUG, after: FIX }] });
  let seen = "";
  const model: ModelFn = async ({ prompt }) => {
    seen = prompt;
    return fenced(GOOD_TEST);
  };
  const step = await writeGuard({ root: repo, model, ...quiet });
  assert.equal(step.tried?.kept, true);
  assert.match(seen, /-    return a - b\n\+    return a \+ b/);
  assert.match(step.change?.what ?? "", /the change after a correction given in chat at 2026-11-20 10:00/);
  const entry = readConfig(repo).tests?.[0];
  assert.deepEqual({ name: entry?.name, when: entry?.when, origin: entry?.origin }, { name: "guard-chat-abc1234", when: ["tools/calc.py"], origin: "auto" });
  // The job is used once.
  assert.equal((await writeGuard({ root: repo, model, ...quiet })).tried, null);
  assert.equal(plainDiff("a\nb\nc\n", "a\nB\nc\n"), "@@ line 2 @@\n-b\n+B");
});

test("the sample of a sweep is fixed by its seed, and a walk is read into catches and costs", () => {
  const hashes = ["a1", "b2", "c3", "d4", "e5", "f6"];
  assert.deepEqual(pick(hashes, "s", 3), pick([...hashes].reverse(), "s", 3));
  assert.notDeepEqual(pick(hashes, "s", 6), pick(hashes, "t", 6));
  const later = [{ hash: "r", fix: false }, { hash: "f", fix: true }, { hash: "x", fix: false }, { hash: "y", fix: false }];
  // Broken by an assertion, mended by a fix whose own parent fails: a catch. Then it stops loading and stays so.
  const one = readWalk({ later, statuses: ["fails", "passes", "errors", "errors"], exact: () => "fails" });
  assert.deepEqual({ caught: one.caught, breaks: one.breaks.map((b) => `${b.at}:${b.kind}`), mended: one.mendedByNonFix, standing: one.standing }, { caught: ["f"], breaks: ["r:fails", "x:errors"], mended: 0, standing: "errors" });
  // Mended by a commit that is not a fix, or by a fix whose parent does not fail by an assertion: not a catch.
  assert.deepEqual(readWalk({ later: [later[0], later[2]] as typeof later, statuses: ["fails", "passes"], exact: () => "fails" }).caught, []);
  assert.deepEqual(readWalk({ later: later.slice(0, 2), statuses: ["fails", "passes"], exact: () => "errors" }).caught, []);
});

test("a sweep over a small history keeps the tests a program proved, and the walk counts the regression one of them catches", async () => {
  process.env.RATCHET_HOME = tmp("home");
  const repo = tmp("sweep");
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, "tools/calc.py", BUG);
  commit(repo, "add");
  put(repo, "tools/calc.py", FIX);
  const fix1 = commit(repo, "fix: add subtracted");
  put(repo, "tools/calc.py", `# tidy\n${BUG}`);
  commit(repo, "tidy the calculator");
  put(repo, "tools/calc.py", `# tidy\n${FIX}`);
  const fix2 = commit(repo, "fix: add subtracted again");
  put(repo, "docs.md", "notes\n");
  commit(repo, "fix: a typo in the notes");
  let calls = 0;
  const model: ModelFn = async () => {
    calls += 1;
    return fenced(GOOD_TEST);
  };
  const statePath = path.join(tmp("st"), "sweep.json");
  const args = { root: repo, model, statePath, n: 5, seed: "s", templates: { py: "python -B {test}" }, ...quiet };
  // Stopped at once by a zero time limit: the sample is fixed, nothing is tried. Run again, it goes on.
  const first = await sweep({ ...args, minutes: 0 });
  assert.deepEqual({ fixes: first.fixes, eligible: first.eligible, sample: [...first.sample].sort(), tried: Object.keys(first.results).length }, { fixes: 3, eligible: 2, sample: [fix1, fix2].sort(), tried: 0 });
  const done = await sweep(args);
  assert.equal(done.done, true);
  assert.equal(calls, 2);
  await sweep(args);
  assert.equal(calls, 2);
  const walked = walk({ statePath, ...quiet });
  const s = summarizeSweep(walked);
  assert.deepEqual({ kept: s.kept, atHead: s.keptPassingAtHead, walked: s.walked, later: s.laterCommits, caught: s.caught, assertionBreaks: s.assertionBreaks, standing: s.standingAtEnd }, { kept: 2, atHead: 2, walked: 2, later: 2, caught: 1, assertionBreaks: 1, standing: 0 });
  assert.deepEqual(walked.walk[fix1]?.caught, [fix2]);
  assert.match(renderSweep(walked), /Kept: 2 of 2[\s\S]*Caught \(broke by an assertion, mended by a later fix commit\): 1/);
  // The walk as registered: every later fix commit, whatever it touched. The first test catches the second fix; the notes fix catches nothing.
  const byFix = walkFixes({ statePath, ...quiet });
  assert.deepEqual({ later: byFix.fixWalk[fix1]?.laterFixes, caught: byFix.fixWalk[fix1]?.caught, second: byFix.fixWalk[fix2]?.caught }, { later: 2, caught: [fix2], second: [] });
  // If the fault came back today: the fix is taken out of the tree at HEAD and the test must fail by an assertion.
  assert.deepEqual(faultReturns({ statePath })[fix2], { undone: true, ran: "fails" });
  // The kept tests become mapped tests of the project, once, and the working tree is left as it was.
  const where = { statePath, projectDirOf: projectDir(repo), configFile: projectFile(repo, "config.json") };
  const adopted = adopt(where);
  assert.deepEqual(adopted.adopted.sort(), [`guard-${fix1.slice(0, 7)}`, `guard-${fix2.slice(0, 7)}`].sort());
  assert.deepEqual(readConfig(repo).tests?.map((t) => `${t.origin} ${t.stage}`), ["auto trial", "auto trial"]);
  assert.equal(adopt(where).adopted.length, 0);
  assert.equal(gitIn(repo, "status", "--porcelain").trim(), "");
});
