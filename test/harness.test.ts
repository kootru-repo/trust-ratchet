import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { handle, MAX_HOLDS } from "../src/harness/hook.ts";
import { findHatches, globToRegExp, judgeHatches, judgeRules, newHatches, renderFindings, ruleLines, ruleProblems, type Rule } from "../src/harness/rules.ts";
import { changedFiles, ensureBaseline, statusPaths, takeBaseline } from "../src/harness/session.ts";
import { allOff, effective, projectDir, readState, setSwitch, slug, writeJson } from "../src/harness/state.ts";
import { judgeCommand, passedAtBaseline, renderRecord, syntaxCheck } from "../src/harness/turn.ts";

const tmp = (name: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `ratchet-${name}-`));
/** Each test gets its own harness home, so nothing touches the real one. */
const freshHome = (): string => {
  const dir = tmp("home");
  process.env.RATCHET_HOME = dir;
  delete process.env.RATCHET_CHILD;
  return dir;
};
const gitIn = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
const newRepo = (files: Record<string, string>): string => {
  const repo = fs.realpathSync(tmp("repo"));
  gitIn(repo, "init", "-q", "-b", "main");
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), text);
  }
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "start");
  return repo;
};
const put = (repo: string, file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};
const rule = (over: Partial<Rule> = {}): Rule => ({ id: "no-os-system", kind: "ban-api", pattern: "os.system", files: ["**/*.py"], message: "os.system runs a shell with unchecked text", fix: "Use subprocess.run with a list of arguments.", ...over });

test("a glob crosses folders only with two stars", () => {
  assert.equal(globToRegExp("src/*.ts").test("src/a.ts"), true);
  assert.equal(globToRegExp("src/*.ts").test("src/x/a.ts"), false);
  assert.equal(globToRegExp("**/*.py").test("a.py"), true);
  assert.equal(globToRegExp("**/*.py").test("x/y/a.py"), true);
  assert.equal(globToRegExp("src/**").test("src/x/y.ts"), true);
  assert.equal(globToRegExp("a.b").test("aXb"), false);
});

test("a rule with no named fix is refused", () => {
  assert.deepEqual(ruleProblems(rule()), []);
  assert.match(ruleProblems(rule({ fix: " " })).join(";"), /fix is missing/);
  assert.match(ruleProblems(rule({ kind: "ban-pattern", pattern: "(" })).join(";"), /not a regular expression/);
  assert.match(ruleProblems(rule({ files: [] })).join(";"), /files is missing/);
});

test("the three kinds of rule fire where they should", () => {
  const py = ["import os", "# os.system is banned", "os.system('ls')", "myos.system('x')", "os.system_call()"].join("\n");
  assert.deepEqual(ruleLines(rule(), py), [3]);
  const ts = ["import { x } from '../brain/core.ts';", "const s = '../brain/core.ts';", "export { y } from \"../brain/y.ts\";"].join("\n");
  assert.deepEqual(ruleLines(rule({ kind: "ban-import", pattern: "\\.\\./brain/" }), ts), [1, 3]);
  assert.deepEqual(ruleLines(rule({ kind: "ban-pattern", pattern: "console\\.log" }), "a\nconsole.log(1)\n"), [2]);
});

test("a rule's baseline lets a count fall but never rise", () => {
  const two = "os.system('a')\nos.system('b')\n";
  const r = rule({ baseline: { "lib/old.py": 2 } });
  assert.equal(judgeRules({ rules: [r], file: "lib/old.py", content: two }).length, 0);
  const risen = judgeRules({ rules: [r], file: "lib/old.py", content: `${two}os.system('c')\n` });
  assert.equal(risen.length, 1);
  assert.match(risen[0]?.detail ?? "", /had 2 .* now has 3/);
  assert.equal(judgeRules({ rules: [r], file: "lib/new.py", content: "os.system('a')\n" }).length, 1);
  assert.equal(judgeRules({ rules: [r], file: "lib/new.ts", content: "os.system('a')\n" }).length, 0);
  assert.match(renderFindings({ findings: risen, heading: "h" }), /Fix: Use subprocess\.run/);
});

test("only escape hatches the session added are reported", () => {
  const before = "x = f()  # type: ignore\n";
  const same = judgeHatches({ file: "a.py", content: `y = 1\n${before}`, before: findHatches("a.py", before).map((h) => h.text) });
  assert.equal(same.length, 0);
  const added = judgeHatches({ file: "a.py", content: `${before}z = g()  # noqa\n`, before: findHatches("a.py", before).map((h) => h.text) });
  assert.equal(added.length, 1);
  assert.match(added[0]?.title ?? "", /noqa \(line 2\)/);
  assert.equal(newHatches({ now: findHatches("a.ts", "const a = b as any;\nconst a = b as any;\n"), before: ["const a = b as any;"] }).length, 1);
  assert.equal(findHatches("a.md", "as any @ts-ignore").length, 0);
});

test("the syntax check tells a file that does not parse from one it cannot judge", () => {
  const bad = syntaxCheck({ file: "a.ts", abs: "a.ts", content: "const x = ;\n" });
  assert.ok(bad !== null && bad !== "not-run");
  assert.equal(syntaxCheck({ file: "a.ts", abs: "a.ts", content: "const x: number = 1;\n" }), null);
  assert.equal(syntaxCheck({ file: "a.ts", abs: "a.ts", content: "enum A { B }\n" }), "not-run");
  assert.equal(syntaxCheck({ file: "a.md", abs: "a.md", content: "# x" }), "not-run");
  assert.equal(syntaxCheck({ file: "tsconfig.json", abs: "x", content: "{ // c\n}" }), "not-run");
  const json = syntaxCheck({ file: "data/a.json", abs: "x", content: "{,}" });
  assert.ok(json !== null && json !== "not-run");
  const dir = tmp("py");
  fs.writeFileSync(path.join(dir, "bad.py"), "def f(:\n    pass\n");
  fs.writeFileSync(path.join(dir, "good.py"), "def f():\n    pass\n");
  const py = syntaxCheck({ file: "bad.py", abs: path.join(dir, "bad.py"), content: "" });
  assert.ok(py !== null && py !== "not-run");
  assert.match(py.detail, /line 1/);
  assert.equal(syntaxCheck({ file: "good.py", abs: path.join(dir, "good.py"), content: "" }), null);
  assert.equal(fs.existsSync(path.join(dir, "__pycache__")), false);
});

test("a command result is a pass, a failure of this session, an inherited failure or not run", () => {
  const check = { name: "types", command: "tsc" };
  const j = (over: Partial<Parameters<typeof judgeCommand>[0]>) => judgeCommand({ check, kind: "check", command: "tsc", status: 1, output: "src/a.ts(3,1): error TS2322: no\nsrc/b.ts(1,1): error TS1: no", timedOut: false, changed: ["src/a.ts"], knownGreen: false, seconds: 1, ...over });
  assert.equal(j({ status: 0 }).outcome.status, "pass");
  assert.equal(j({ timedOut: true }).outcome.status, "not-run");
  assert.equal(j({ output: "'tsc' is not recognized as an internal or external command" }).outcome.status, "not-run");
  const inherited = j({});
  assert.equal(inherited.outcome.status, "fail");
  assert.equal(inherited.finding?.blocking, false);
  assert.equal(j({ knownGreen: true }).finding?.blocking, true);
  const mine = j({ check: { ...check, onlyChanged: true } });
  assert.equal(mine.finding?.blocking, true);
  assert.equal(mine.finding?.detail.includes("src/b.ts"), false);
  assert.equal(j({ check: { ...check, onlyChanged: true }, changed: ["src/c.ts"] }).outcome.status, "fail-elsewhere");
});

test("status output with a rename gives the new path only", () => {
  assert.deepEqual(statusPaths(" M a.ts\0R  new.ts\0old.ts\0?? dir/b c.py\0"), ["a.ts", "new.ts", "dir/b c.py"]);
});

test("the session's change is what differs from its baseline, however it was written", () => {
  freshHome();
  const repo = newRepo({ "a.py": "x = 1\n", "b.py": "y = 1\n" });
  put(repo, "b.py", "y = 2  # noqa\n");
  put(repo, "left.txt", "there before the session\n");
  const { baseline, fresh } = ensureBaseline("s1", repo);
  assert.equal(fresh, true);
  assert.equal(baseline.clean, false);
  assert.deepEqual(changedFiles(baseline), []);
  put(repo, "a.py", "x = 2\n");
  put(repo, "made_by_script.py", "z = 1\n");
  assert.deepEqual(changedFiles(baseline).map((c) => c.file), ["a.py", "made_by_script.py"]);
  gitIn(repo, "add", "a.py");
  gitIn(repo, "commit", "-q", "-m", "mid-session commit");
  assert.deepEqual(changedFiles(baseline).map((c) => c.file), ["a.py", "made_by_script.py"]);
  put(repo, "b.py", "y = 3  # noqa\n");
  assert.deepEqual(changedFiles(baseline).map((c) => c.file), ["a.py", "b.py", "made_by_script.py"]);
  assert.equal(ensureBaseline("s1", repo).fresh, false);
  const tidy = newRepo({ "a.py": "" });
  put(tidy, "__pycache__/a.cpython-313.pyc", "x");
  put(tidy, ".pytest_cache/v/cache/lastfailed", "{}");
  assert.equal(takeBaseline(tidy).clean, true);
});

test("the switch: off by default, a project can be on while the global switch is off, and off while it is on", () => {
  freshHome();
  const state = readState();
  assert.equal(state.enabled, false);
  assert.equal(allOff(state), true);
  const on = setSwitch({ root: "C:/Work/Proj", enabled: true, mode: "enforce" });
  assert.equal(allOff(on), false);
  assert.deepEqual(effective(on, "C:/Work/Proj/"), { enabled: true, mode: "enforce" });
  assert.deepEqual(effective(on, "C:/Work/Other"), { enabled: false, mode: "advise" });
  const global = setSwitch({ enabled: true });
  setSwitch({ root: "C:/Work/Quiet", enabled: false });
  assert.equal(effective(global, "C:/Work/Other").enabled, true);
  assert.equal(effective(readState(), "C:/Work/Quiet").enabled, false);
  assert.match(slug("C:/Work/Proj"), /work-proj$/i);
});

test("the hook says nothing while switched off, and nothing inside Ratchet's own model calls", () => {
  freshHome();
  const repo = newRepo({ "a.py": "x = 1\n" });
  put(repo, "a.py", "def f(:\n");
  const payload = { session_id: "s", cwd: repo, tool_name: "Edit", tool_input: { file_path: path.join(repo, "a.py") } };
  assert.equal(handle("PostToolUse", payload), null);
  setSwitch({ root: repo, enabled: true });
  assert.notEqual(handle("PostToolUse", payload), null);
  process.env.RATCHET_CHILD = "1";
  assert.equal(handle("PostToolUse", payload), null);
  delete process.env.RATCHET_CHILD;
});

test("after an edit the agent gets the fact and its fix, for the repository of the edited file", () => {
  freshHome();
  const elsewhere = newRepo({ "x.txt": "" });
  const repo = newRepo({ "lib/a.py": "import os\n" });
  setSwitch({ root: repo, enabled: true });
  writeJson(path.join(projectDir(repo), "rules.json"), [rule()]);
  const edit = { session_id: "s2", cwd: elsewhere, tool_name: "Edit", tool_input: { file_path: path.join(repo, "lib", "a.py") } };
  assert.equal(handle("PreToolUse", edit), null);
  put(repo, "lib/a.py", "import os\nos.system('ls')  # noqa\n");
  const out = handle("PostToolUse", edit) as { hookSpecificOutput?: { additionalContext?: string } };
  const text = out.hookSpecificOutput?.additionalContext ?? "";
  assert.match(text, /rule no-os-system, line 2/);
  assert.match(text, /Fix: Use subprocess\.run with a list of arguments\./);
  assert.match(text, /escape hatch added: noqa \(line 2\)/);
  setSwitch({ root: repo, mode: "enforce" });
  const held = handle("PostToolUse", edit) as { decision?: string; reason?: string };
  assert.equal(held.decision, "block");
  put(repo, "lib/a.py", "import os\nimport subprocess\n");
  assert.equal(handle("PostToolUse", edit), null);
});

test("in enforce mode the turn is held twice at most, and an inherited failure never holds it", () => {
  freshHome();
  const repo = newRepo({ "a.py": "x = 1\n", "check.js": "process.exit(1);\n" });
  setSwitch({ root: repo, enabled: true, mode: "enforce" });
  writeJson(path.join(projectDir(repo), "config.json"), { checks: [{ name: "always-red", command: "node check.js" }] });
  const start = handle("SessionStart", { session_id: "s3", cwd: repo }) as { hookSpecificOutput?: { additionalContext?: string } };
  assert.match(start.hookSpecificOutput?.additionalContext ?? "", /Ratchet harness is on .* \(mode: enforce\)/);
  assert.equal(handle("Stop", { session_id: "s3", cwd: repo }), null);
  put(repo, "a.py", "x = 2\n");
  const inherited = handle("Stop", { session_id: "s3", cwd: repo }) as { decision?: string; systemMessage?: string };
  assert.equal(inherited.decision, undefined);
  assert.match(inherited.systemMessage ?? "", /0 failing, 1 noted/);
  put(repo, "a.py", "x = 2\ndef f(:\n");
  for (let i = 1; i <= MAX_HOLDS; i += 1) {
    const held = handle("Stop", { session_id: "s3", cwd: repo }) as { decision?: string; reason?: string };
    assert.equal(held.decision, "block");
    assert.match(held.reason ?? "", new RegExp(`hold ${i} of ${MAX_HOLDS}`));
    assert.match(held.reason ?? "", /a\.py: does not parse/);
  }
  const released = handle("Stop", { session_id: "s3", cwd: repo }) as { decision?: string; systemMessage?: string };
  assert.equal(released.decision, undefined);
  assert.match(released.systemMessage ?? "", /ends with the failures stated/);
  const latest = fs.readFileSync(path.join(projectDir(repo), "latest.md"), "utf8");
  assert.match(latest, /FAILS: a\.py: does not parse/);
  assert.match(latest, /check always-red: fail \(not known to have passed before this session\)/);
  put(repo, "a.py", "x = 3\n");
  const clean = handle("Stop", { session_id: "s3", cwd: repo }) as { systemMessage?: string };
  assert.match(clean.systemMessage ?? "", /0 failing, 1 noted/);
  assert.equal(handle("Stop", { session_id: "s3", cwd: repo }), null);
});

test("a command that passed earlier in the session holds the turn when it fails later", () => {
  freshHome();
  const repo = newRepo({ "a.py": "x = 1\n", "flag.txt": "ok\n", "check.js": "process.exit(require('fs').readFileSync('flag.txt','utf8').trim()==='ok'?0:1);\n" });
  setSwitch({ root: repo, enabled: true, mode: "enforce" });
  writeJson(path.join(projectDir(repo), "config.json"), { tests: [{ name: "flag", command: "node check.js", when: ["**/*.py", "flag.txt"] }] });
  handle("SessionStart", { session_id: "s4", cwd: repo });
  put(repo, "a.py", "x = 2\n");
  assert.match((handle("Stop", { session_id: "s4", cwd: repo }) as { systemMessage?: string }).systemMessage ?? "", /nothing failed/);
  put(repo, "flag.txt", "broken\n");
  const held = handle("Stop", { session_id: "s4", cwd: repo }) as { decision?: string; reason?: string };
  assert.equal(held.decision, "block");
  assert.match(held.reason ?? "", /flag fails/);
});

test("the record says what ran, what it said and what could not run", () => {
  const page = renderRecord({ sessionId: "s", mode: "advise", held: false, time: "T", result: { root: "/r", changed: ["a.py"], findings: [], outcomes: [{ kind: "check", name: "lint", command: "x", status: "not-run", note: "could not run: missing", seconds: 0 }], fileChecks: ["syntax"], repeated: false, notRun: ["lint: could not run: missing"], wallS: 0, fileS: 0 } });
  assert.match(page, /Nothing failed\./);
  assert.match(page, /check lint: not-run/);
  assert.match(page, /## What could not run\n\n- lint: could not run: missing/);
});

test("a test the session broke holds the turn at once: the failing command is run on the baseline commit to find out", () => {
  freshHome();
  const repo = newRepo({ "calc.py": "def add(a, b):\n    return a + b\n", "check.js": "process.exit(require('fs').readFileSync('calc.py','utf8').includes('a + b')?0:1);\n" });
  setSwitch({ root: repo, enabled: true, mode: "enforce" });
  writeJson(path.join(projectDir(repo), "config.json"), { tests: [{ name: "calc", command: "node check.js", when: ["calc.py"] }] });
  handle("SessionStart", { session_id: "s5", cwd: repo });
  put(repo, "calc.py", "def add(a, b):\n    return a - b\n");
  const held = handle("Stop", { session_id: "s5", cwd: repo }) as { decision?: string; reason?: string };
  assert.equal(held.decision, "block");
  assert.match(held.reason ?? "", /calc fails, exit 1/);
  assert.equal(passedAtBaseline({ baseline: ensureBaseline("s5", repo).baseline, command: "node check.js", limitMs: 20_000 }), true);
  assert.equal(passedAtBaseline({ baseline: ensureBaseline("s5", repo).baseline, command: "node -e \"process.exit(1)\"", limitMs: 20_000 }), false);
  assert.equal(passedAtBaseline({ baseline: ensureBaseline("s5", repo).baseline, command: "no-such-program-xyz", limitMs: 20_000 }), null);
  put(repo, "calc.py", "def add(a, b):\n    return a + b\n");
  assert.equal(handle("Stop", { session_id: "s5", cwd: repo }), null);
});

test("a mapped test on trial that the session broke is reported and does not hold the turn, even in enforce mode", () => {
  freshHome();
  const repo = newRepo({ "calc.py": "def add(a, b):\n    return a + b\n", "check.js": "process.exit(require('fs').readFileSync('calc.py','utf8').includes('a + b')?0:1);\n" });
  setSwitch({ root: repo, enabled: true, mode: "enforce" });
  writeJson(path.join(projectDir(repo), "config.json"), { tests: [{ name: "guard-abc1234", command: "node check.js", when: ["calc.py"], origin: "auto", stage: "trial" }] });
  handle("SessionStart", { session_id: "s6", cwd: repo });
  put(repo, "calc.py", "def add(a, b):\n    return a - b\n");
  const out = handle("Stop", { session_id: "s6", cwd: repo }) as { decision?: string } | null;
  assert.notEqual(out?.decision, "block");
  const record = fs.readFileSync(path.join(projectDir(repo), "latest.md"), "utf8");
  assert.match(record, /test guard-abc1234: fail/);
});

test("a driver runs with the turn checks, a deleted repository does not silence the others, and a branch switch is not the session's work", () => {
  freshHome();
  const gone = newRepo({ "a.py": "x = 1\n" });
  const repo = newRepo({ "a.py": "x = 1\n", "drive.js": "console.log('driver ran'); process.exit(require('fs').readFileSync('a.py','utf8').includes('boom')?1:0);\n" });
  setSwitch({ enabled: true, mode: "enforce" });
  writeJson(path.join(projectDir(repo), "config.json"), { drivers: [{ name: "real-thing", command: "node drive.js", when: ["a.py"] }] });
  handle("PreToolUse", { session_id: "s6", cwd: repo, tool_input: { file_path: path.join(gone, "a.py") } });
  handle("PreToolUse", { session_id: "s6", cwd: repo, tool_input: { file_path: path.join(repo, "a.py") } });
  fs.rmSync(gone, { recursive: true, force: true });
  put(repo, "a.py", "x = 2\n");
  assert.match((handle("Stop", { session_id: "s6", cwd: repo }) as { systemMessage?: string }).systemMessage ?? "", /nothing failed \(1 changed file, 1 command\)/);
  assert.match(fs.readFileSync(path.join(projectDir(repo), "latest.md"), "utf8"), /driver real-thing: pass/);
  put(repo, "a.py", "x = 'boom'\n");
  const held = handle("Stop", { session_id: "s6", cwd: repo }) as { decision?: string; reason?: string };
  assert.equal(held.decision, "block");
  assert.match(held.reason ?? "", /real-thing fails/);

  const other = newRepo({ "a.py": "x = 1\n" });
  gitIn(other, "checkout", "-q", "-b", "side");
  put(other, "side.py", "y = 1\n");
  gitIn(other, "add", "-A");
  gitIn(other, "commit", "-q", "-m", "side work");
  const { baseline } = ensureBaseline("s7", other);
  gitIn(other, "checkout", "-q", "main");
  put(other, "main_only.py", "z = 1\n");
  gitIn(other, "add", "-A");
  gitIn(other, "commit", "-q", "-m", "on main");
  assert.deepEqual(changedFiles(baseline), []);
});
