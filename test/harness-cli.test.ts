import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { census, countHatches, detectConfig, harnessCli, proveRule } from "../src/harness/cli.ts";
import { addHooks, formatLike, install, installed, MARK, removeHooks, uninstall, type Settings } from "../src/harness/install.ts";
import type { Rule } from "../src/harness/rules.ts";
import { projectDir, readConfig, readState } from "../src/harness/state.ts";
import { readRules } from "../src/harness/turn.ts";

const tmp = (name: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ratchet-${name}-`)));
const SOURCE = path.resolve(import.meta.dirname, "..");
const gitIn = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
const put = (repo: string, file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};
/** A repository with a fault in two files and a commit that fixes one of them. */
const repoWithFix = (): { repo: string; fix: string } => {
  const repo = tmp("repo");
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, "lib/run.py", "import os\nos.system('ls ' + name)\n");
  put(repo, "lib/other.py", "import os\nos.system('rm ' + name)\nos.system('x')\n");
  put(repo, "web/a.ts", "const a = b as any;\n// @ts-ignore\nconst c = 1;\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "add");
  put(repo, "lib/run.py", "import subprocess\nsubprocess.run(['ls', name])\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "fix: shell injection in run");
  return { repo, fix: gitIn(repo, "rev-parse", "HEAD").trim() };
};
const SETTINGS: Settings = {
  env: { A: "1" },
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: "python", args: ["-I", "reminder.py"], timeout: 15 }] }],
    PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "powershell -File voice.ps1", timeout: 15 }] }],
  },
  model: "x",
};
const quiet = <T>(work: () => T): { value: T; text: string } => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (line?: unknown) => void lines.push(String(line));
  try {
    return { value: work(), text: lines.join("\n") };
  } finally {
    console.log = log;
  }
};

test("adding the hooks keeps every other entry, and removing them gives back the same settings", () => {
  const added = addHooks({ settings: SETTINGS, node: "node", entry: "C:/h/app/entry.ts" });
  assert.deepEqual(Object.keys(added), ["env", "hooks", "model"]);
  assert.deepEqual(Object.keys(added.hooks ?? {}), ["SessionStart", "PostToolUse", "PreToolUse", "Stop", "UserPromptSubmit"]);
  assert.deepEqual(added.hooks?.SessionStart?.[0], SETTINGS.hooks?.SessionStart?.[0]);
  assert.equal(added.hooks?.PostToolUse?.length, 2);
  assert.equal(added.hooks?.PostToolUse?.[1]?.matcher, "Edit|Write|MultiEdit");
  assert.ok((added.hooks?.Stop?.[0]?.hooks?.[0]?.timeout ?? 0) > 120);
  assert.deepEqual(addHooks({ settings: added, node: "node", entry: "C:/h/app/entry.ts" }), added);
  assert.deepEqual(removeHooks(added), SETTINGS);
  assert.equal(JSON.stringify(removeHooks(added)), JSON.stringify(SETTINGS));
  assert.deepEqual(removeHooks(addHooks({ settings: { model: "x" }, node: "n", entry: "e" })), { model: "x" });
  assert.equal(removeHooks(SETTINGS), SETTINGS);
});

test("the settings file keeps its layout", () => {
  const original = '{\r\n    "a": 1,\r\n    "b": [\r\n        2\r\n    ]\r\n}\r\n';
  assert.equal(formatLike(original, JSON.parse(original)), original);
  assert.equal(formatLike('{\n  "a": 1\n}', { a: 1 }), '{\n  "a": 1\n}');
});

test("install on a copy of a settings file, then uninstall, gives back the file byte for byte", () => {
  const dir = tmp("install");
  process.env.RATCHET_HOME = path.join(dir, "ratchet");
  process.env.RATCHET_SETTINGS = path.join(dir, "claude", "settings.json");
  delete process.env.RATCHET_CHILD;
  const original = `${JSON.stringify(SETTINGS, null, 2)}\n`;
  fs.mkdirSync(path.join(dir, "claude"), { recursive: true });
  fs.writeFileSync(process.env.RATCHET_SETTINGS, original);
  try {
    assert.deepEqual(installed(), { hooks: [], app: null });
    const first = install({ source: SOURCE });
    assert.equal(first.changed, true);
    assert.equal(fs.readFileSync(first.backup ?? "", "utf8"), original);
    assert.equal(installed().hooks.length, 5);
    const written = JSON.parse(fs.readFileSync(process.env.RATCHET_SETTINGS, "utf8")) as Settings;
    const ours = written.hooks?.Stop?.[0]?.hooks?.[0];
    assert.ok(ours?.args?.includes(MARK));
    assert.equal(fs.existsSync(path.join(dir, "claude", "commands", "ratchet.md")), true);
    assert.equal(readState().enabled, false);

    // The installed entry runs, says nothing while switched off, and exits clean on input that is not JSON.
    const run = (input: string): string => execFileSync(ours?.command ?? "", (ours?.args ?? []).map((a) => (a === "Stop" ? "PostToolUse" : a)), { input, encoding: "utf8", env: { ...process.env } });
    assert.equal(run(JSON.stringify({ session_id: "x", tool_input: { file_path: path.join(dir, "a.py") } })), "");
    assert.equal(run("not json"), "");
    assert.match(fs.readFileSync(path.join(dir, "ratchet", "log", "errors.log"), "utf8"), /PostToolUse/);

    assert.equal(install({ source: SOURCE }).changed, false);
    assert.equal(uninstall().changed, true);
    assert.equal(fs.readFileSync(process.env.RATCHET_SETTINGS, "utf8"), original);
    assert.equal(fs.existsSync(path.join(dir, "claude", "commands", "ratchet.md")), false);
    assert.equal(uninstall().changed, false);
  } finally {
    delete process.env.RATCHET_SETTINGS;
  }
});

test("a rule is proven on the fix it was written for, and the census finds its siblings", () => {
  const { repo, fix } = repoWithFix();
  const rule: Rule = { id: "no-os-system", kind: "ban-api", pattern: "os.system", files: ["**/*.py"], message: "m", fix: "f" };
  assert.deepEqual(proveRule({ root: repo, rule, commit: fix, file: "lib/run.py" }), { firedBefore: 1, firedAfter: 0, onRemoved: 1, onAdded: 0, proven: true });
  assert.equal(proveRule({ root: repo, rule, commit: fix, file: "lib/other.py" })?.proven, false);
  assert.equal(proveRule({ root: repo, rule, commit: fix, file: "nope.py" }), null);
  assert.deepEqual(census(repo, rule), { "lib/other.py": 2 });
  assert.deepEqual(countHatches(repo).byName, { "as any": 1, "@ts-ignore": 1 });
});

test("rule add refuses a rule with no fix or one that does not match its fix commit, and stores the backlog", () => {
  process.env.RATCHET_HOME = tmp("home");
  const { repo, fix } = repoWithFix();
  const base = ["rule", "add", "--project", repo, "--id", "no-os-system", "--kind", "ban-api", "--files", "**/*.py", "--message", "os.system runs a shell"];
  assert.equal(quiet(() => harnessCli([...base, "--pattern", "os.system"], SOURCE)).value, 1);
  const wrong = quiet(() => harnessCli([...base, "--pattern", "subprocess.run", "--fix", "x", "--proof-commit", fix, "--proof-file", "lib/run.py"], SOURCE));
  assert.equal(wrong.value, 1);
  assert.match(wrong.text, /fires on 0 line\(s\) that .* removed and on 1 it added/);
  const ok = quiet(() => harnessCli([...base, "--pattern", "os.system", "--fix", "Use subprocess.run with a list.", "--proof-commit", fix, "--proof-file", "lib/run.py"], SOURCE));
  assert.equal(ok.value, 0);
  assert.match(ok.text, /proven on .*: fired on 1 line\(s\) the fix removed, on none it added/);
  assert.match(ok.text, /2 more of the same in 1 file/);
  const stored = readRules(repo);
  assert.equal(stored[0]?.proof?.commit, fix);
  assert.deepEqual(stored[0]?.baseline, { "lib/other.py": 2 });
  assert.equal(fs.existsSync(path.join(repo, ".ratchet")), false);
  assert.equal(quiet(() => harnessCli(["census", "--project", repo], SOURCE)).value, 0);
  put(repo, "lib/other.py", "import os\nos.system('a')\nos.system('b')\nos.system('c')\n");
  gitIn(repo, "add", "-A");
  const risen = quiet(() => harnessCli(["census", "--project", repo], SOURCE));
  assert.equal(risen.value, 1);
  assert.match(risen.text, /RISEN in lib\/other\.py \(2 to 3\)/);
  // Tightening never raises a backlog: a rise is still reported and the stored number stays.
  assert.equal(quiet(() => harnessCli(["census", "--project", repo, "--tighten"], SOURCE)).value, 1);
  assert.deepEqual(readRules(repo)[0]?.baseline, { "lib/other.py": 2 });
  put(repo, "lib/other.py", "import os\nos.system('a')\n");
  gitIn(repo, "add", "-A");
  assert.match(quiet(() => harnessCli(["census", "--project", repo, "--tighten"], SOURCE)).text, /backlog lowered from 2 to 1/);
  assert.deepEqual(readRules(repo)[0]?.baseline, { "lib/other.py": 1 });
});

test("init never writes a whole test suite, and the hatch ceiling is lowered, never raised", () => {
  process.env.RATCHET_HOME = tmp("home");
  const config = detectConfig({ scripts: { test: "vitest", "check-types": "tsc --noEmit", lint: "eslint ." }, hasRuff: true });
  assert.deepEqual((config.checks ?? []).map((c) => c.name), ["types", "lint", "ruff"]);
  assert.deepEqual(config.tests, []);
  assert.equal(JSON.stringify(config).includes("npm test"), false);
  assert.ok((config.checks ?? []).every((c) => (c.timeoutS ?? 0) > 0));
  const { repo } = repoWithFix();
  assert.equal(quiet(() => harnessCli(["init", "--project", repo], SOURCE)).value, 0);
  assert.equal(readConfig(repo).hatchCeiling, 2);
  assert.equal(fs.existsSync(path.join(projectDir(repo), "config.json")), true);
  put(repo, "web/a.ts", "const a = b as any;\n// @ts-ignore\nconst c = d as any;\n");
  assert.equal(quiet(() => harnessCli(["hatches", "--project", repo, "--set-ceiling"], SOURCE)).value, 1);
  assert.equal(readConfig(repo).hatchCeiling, 2);
  put(repo, "web/a.ts", "const a = 1;\n");
  assert.equal(quiet(() => harnessCli(["hatches", "--project", repo, "--set-ceiling"], SOURCE)).value, 0);
  assert.equal(readConfig(repo).hatchCeiling, 0);
  const measured = quiet(() => harnessCli(["measure", "--project", repo], SOURCE));
  assert.match(measured.text, /last 2 commits: 2 commits; fixes 1 \(50%\); fixes of a fix made within 14 days 0; reverts 0\./);
});

test("on and off switch one project or everything", () => {
  process.env.RATCHET_HOME = tmp("home");
  const { repo } = repoWithFix();
  const on = quiet(() => harnessCli(["on", "--project", repo, "--mode", "enforce"], SOURCE));
  assert.match(on.text, /Global switch: off/);
  assert.match(on.text, /Here \(.*\): ON, mode enforce/);
  quiet(() => harnessCli(["on"], SOURCE));
  assert.equal(readState().enabled, true);
  quiet(() => harnessCli(["off"], SOURCE));
  assert.equal(readState().enabled, false);
  assert.match(quiet(() => harnessCli(["default", "--project", repo], SOURCE)).text, /Here \(.*\): off/);
});

test("writing the config again with init --force keeps the loop's switch, its limits and what it mapped itself", () => {
  process.env.RATCHET_HOME = tmp("home");
  const repo = tmp("reinit");
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, "a.py", "x = 1\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "add");
  quiet(() => harnessCli(["init", "--project", repo], SOURCE));
  quiet(() => harnessCli(["auto", "--project", repo, "--on", "--guards", "--exclude", "sealed/**", "--py-test", "python -B {test}"], SOURCE));
  const file = path.join(projectDir(repo), "config.json");
  const before = readConfig(repo);
  fs.writeFileSync(file, JSON.stringify({ ...before, autoLimitsOn: true, autoLimits: { tests: 5 }, tests: [{ name: "mine", when: ["test_a.py"], command: "python -B test_a.py", origin: "auto" }, { name: "theirs", command: "x" }] }));
  quiet(() => harnessCli(["init", "--project", repo, "--force"], SOURCE));
  const after = readConfig(repo);
  assert.deepEqual({ auto: after.auto, guards: after.autoGuards, exclude: after.autoExclude, test: after.autoTest }, { auto: true, guards: true, exclude: ["sealed/**"], test: { py: "python -B {test}" } });
  assert.deepEqual(after.tests?.map((t) => t.name), ["mine"]);
  assert.deepEqual({ on: after.autoLimitsOn, limits: after.autoLimits }, { on: true, limits: { tests: 5 } });   // the loop's limits switch and the value it set survive a re-init
});

test("init --force --keep-own also keeps the commands and limits a person wrote", () => {
  process.env.RATCHET_HOME = tmp("home");
  const repo = tmp("reinit-own");
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, "a.py", "x = 1\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "add");
  quiet(() => harnessCli(["init", "--project", repo], SOURCE));
  const file = path.join(projectDir(repo), "config.json");
  const before = readConfig(repo);
  fs.writeFileSync(file, JSON.stringify({ ...before, budgetS: { stop: 240 }, maxTestsPerStop: 6,
    checks: [...(before.checks ?? []), { name: "my-check", command: "python -B check.py" }],
    tests: [{ name: "mine", command: "python -B test_a.py", origin: "auto" }, { name: "theirs", command: "x" }],
    drivers: [{ name: "my-driver", command: "node drive.mjs" }] }));
  const said = quiet(() => harnessCli(["init", "--project", repo, "--force", "--keep-own"], SOURCE));
  const after = readConfig(repo);
  assert.deepEqual(after.tests?.map((t) => t.name), ["mine", "theirs"]);
  assert.ok(after.checks?.some((c) => c.name === "my-check"));
  assert.deepEqual(after.drivers?.map((d) => d.name), ["my-driver"]);
  assert.deepEqual({ budget: after.budgetS, max: after.maxTestsPerStop }, { budget: { stop: 240 }, max: 6 });
  assert.match(said.text, /Kept your own: .*my-check/);
  // without the flag a person's part starts afresh, as before
  quiet(() => harnessCli(["init", "--project", repo, "--force"], SOURCE));
  assert.deepEqual(readConfig(repo).tests?.map((t) => t.name), ["mine"]);
});
