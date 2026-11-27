// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { handle } from "../src/harness/hook.ts";
import { featureMap, outcomes, pairTests, parseLog, renderFeatureMap } from "../src/harness/outcomes.ts";
import { matchesAny, matchesCarriageReturn, ruleLines, ruleProblems, statements, type Rule } from "../src/harness/rules.ts";
import { projectDir, readJson, readState, setSwitch, writeJson } from "../src/harness/state.ts";

const tmp = (name: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ratchet-${name}-`)));
const gitIn = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
const put = (repo: string, file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};
const newRepo = (files: Record<string, string>): string => {
  const repo = tmp("repo");
  gitIn(repo, "init", "-q", "-b", "main");
  for (const [f, text] of Object.entries(files)) put(repo, f, text);
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "start");
  return repo;
};
const RULE: Rule = { id: "subprocess-text-needs-encoding", kind: "ban-pattern", pattern: "subprocess\\.run\\((?=.*\\btext=True\\b)(?!.*\\bencoding=)", files: ["**/*.py"], message: "m", fix: "f" };

test("T2: a statement rule sees a call written over several lines, a line rule does not", () => {
  const code = ["r = subprocess.run(", "    [sys.executable, 'x.py'],", "    capture_output=True, text=True,", ")", "ok = subprocess.run(['a'], text=True,", "                    encoding='utf-8')", "one = subprocess.run(['b'], text=True)", ""].join("\n");
  // The line rule misses the call on line 1 and wrongly reports line 5, whose encoding is on the next line.
  assert.deepEqual(ruleLines(RULE, code), [5, 7]);
  assert.deepEqual(ruleLines({ ...RULE, scope: "statement" }, code), [1, 7]);
  assert.deepEqual(statements("a = f(\n  1,\n  2)\nb = 3\n").map((s) => [s.line, s.text]), [[1, "a = f( 1, 2)"], [4, "b = 3"], [5, ""]]);
  assert.match(ruleProblems({ ...RULE, scope: "file" as "line" }).join(";"), /scope must be line or statement/);
  // A statement is cut at 40 lines, so a runaway bracket cannot swallow a file.
  assert.equal((statements(`x = (\n${"1,\n".repeat(60)})\n`)[0]?.text.match(/1,/g) ?? []).length, 39);
});

test("a rule pattern that looks for a carriage return is refused, because rules see lines already split on CR LF", () => {
  for (const pattern of ["\r$", "\\r$", "x\\r", "\\x0d", "\\x0D", "\\u000d", "\\cM", "\\cm", "\\015", "\\15", "[\\r\\n]", "[\\n\\r]+$", "a\\\\\\r", "\\r+", "\\r{1,2}", "\\[\\r"]) {
    assert.equal(matchesCarriageReturn(pattern), true, pattern);
    assert.match(ruleProblems({ ...RULE, pattern }).join(";"), /carriage return.*LF line-endings check/, pattern);
  }
  // A CR that may match nothing, or sits beside something that can match, still lets the rule work: a negated or mixed
  // class, a ? * or {0, after it, a group, or a top-level |. \u{d} without the u flag is not a CR.
  for (const pattern of ["\\\\r", "a\\\\rb", "\\bfor\\b", "\\x0a", "\\n$", "r$", "\\\\x0d", "\\\\\\\\r", "[^\\r\\n]*", "foo[^\\r\\n]*bar", ";\\r?$", "\\r*", "\\r{0,1}", "[\\r\\n]?", "\\u{d}", "\\0150", "\\x0d?", "[ \\t\\r]+$", "[\\t-\\r]", "[a\\r]x", "[\\\\\\r]", ";(\\r)?$", ";(?:\\r\\n)?$", "foo(\\r|$)", "foo(?!\\r)", "\\r$|foo"]) assert.equal(matchesCarriageReturn(pattern), false, pattern);
  assert.deepEqual(ruleProblems({ ...RULE, pattern: ";\\r?$" }), []);
  assert.deepEqual(ruleProblems({ ...RULE, pattern: "\\\\r" }), []);
  // The reason: a line rule never fires on a CRLF file.
  assert.deepEqual(ruleLines({ ...RULE, pattern: "\\r$", files: ["**/*.ts"] }, "a\r\nb\r\n"), []);
});

test("T8: a test is mapped only to the file it sits beside, and a language with no command is left out", () => {
  const files = ["tools/dm/quote_check.py", "tools/dm/test_quote_check.py", "tools/dm/test_semantic.py", "tools/brain/cell.py", "tools/brain/test_cell.py", "web/a.ts", "web/a.test.ts"];
  const maps = pairTests({ files, exclude: ["tools/brain/**"], template: { py: "python -B {test}" } });
  assert.deepEqual(maps, [{ name: "test_quote_check", when: ["tools/dm/quote_check.py", "tools/dm/test_quote_check.py"], command: "python -B tools/dm/test_quote_check.py", timeoutS: 60 }]);
  assert.deepEqual(pairTests({ files, exclude: [], template: { ts: "npx vitest run {test}" } }).map((m) => m.command), ["npx vitest run web/a.test.ts"]);
});

test("a command runs again only when its own files changed, and a turn end runs a limited number of mapped tests", () => {
  process.env.RATCHET_HOME = tmp("home");
  delete process.env.RATCHET_CHILD;
  const count = "require('fs').appendFileSync('runs.log', process.argv[2] + '\\n');";
  const repo = newRepo({ "a.py": "x = 1\n", "b.py": "y = 1\n", "c.py": "z = 1\n", "d.py": "w = 1\n", "count.js": count, ".gitignore": "runs.log\n" });
  setSwitch({ root: repo, enabled: true });
  writeJson(path.join(projectDir(repo), "config.json"), { maxTestsPerStop: 2, tests: ["a", "b", "c", "d"].map((n) => ({ name: n, when: [`${n}.py`], command: `node count.js ${n}` })) });
  handle("SessionStart", { session_id: "k1", cwd: repo });
  const runs = (): string[] => (fs.existsSync(path.join(repo, "runs.log")) ? fs.readFileSync(path.join(repo, "runs.log"), "utf8").trim().split("\n") : []);
  put(repo, "a.py", "x = 2\n");
  handle("Stop", { session_id: "k1", cwd: repo });
  assert.deepEqual(runs(), ["a"]);
  put(repo, "b.py", "y = 2\n");
  handle("Stop", { session_id: "k1", cwd: repo });
  assert.deepEqual(runs(), ["a", "b"]);
  put(repo, "c.py", "z = 2\n");
  put(repo, "d.py", "w = 2\n");
  put(repo, "a.py", "x = 3\n");
  const out = handle("Stop", { session_id: "k1", cwd: repo }) as { systemMessage?: string };
  assert.deepEqual(runs(), ["a", "b", "a", "c"]);
  // The message says the test was left by the limit, not that it could not run.
  assert.match(out.systemMessage ?? "", /left for the next turn end by the limits: 1\)/);
  assert.doesNotMatch(out.systemMessage ?? "", /could not run/);
  assert.match(fs.readFileSync(path.join(projectDir(repo), "latest.md"), "utf8"), /test d: not-run \(over the limit of 2 mapped tests per turn end\)/);
  assert.match(fs.readFileSync(path.join(projectDir(repo), "latest.md"), "utf8"), /test b: pass \(its files are unchanged since it last passed/);
  assert.deepEqual(readJson<Record<string, number>>(path.join(projectDir(repo), "waits.json"), {}), { d: 1 });
  // Drain: nothing changed, but a test is owed. The next turn end runs it; the one after has nothing left to do.
  handle("Stop", { session_id: "k1", cwd: repo });
  assert.deepEqual(runs(), ["a", "b", "a", "c", "d"]);
  assert.deepEqual(readJson<Record<string, number>>(path.join(projectDir(repo), "waits.json"), {}), {});
  assert.equal(handle("Stop", { session_id: "k1", cwd: repo }), null);
  assert.deepEqual(runs(), ["a", "b", "a", "c", "d"]);
});

test("T9: the feature map says what watches each folder, and names the folders nothing watches", () => {
  const rows = featureMap({
    files: ["tools/dm/a.py", "tools/dm/test_a.py", "tools/brain/cell.py", "docs/x.md", "top.py"],
    rules: [{ ...RULE, files: ["tools/**/*.py"] }],
    config: { tests: [{ name: "test_a", when: ["tools/dm/a.py"], command: "x" }], drivers: [{ name: "vault-check", when: ["tools/dm/**"], command: "y" }], checks: [{ name: "everywhere", command: "z" }] },
  });
  assert.deepEqual(rows.map((r) => [r.folder, r.files, r.rules.length, r.tests, r.drivers, r.checks]), [[".", 1, 0, [], [], ["everywhere"]], ["tools/brain", 1, 1, [], [], ["everywhere"]], ["tools/dm", 2, 1, ["test_a"], ["vault-check"], ["everywhere"]]]);
  const bare = renderFeatureMap({ root: "/r", rows: featureMap({ files: ["a/b/c.py", "d/e.py"], rules: [{ ...RULE, files: ["d/**"] }], config: {} }) });
  assert.match(bare, /\| a\/b \| 1 \| - \| - \| - \| - \|/);
  assert.match(bare, /Folders with nothing beyond syntax and escape hatches: 1 of 2 \(a\/b\)/);
});

test("T15: fixes, fixes of a fix and reverts are read from history", () => {
  const day = 86_400;
  const log = ["\u0001h5\t" + 40 * day + "\tRevert \"add thing\"\n\na.py", "\u0001h4\t" + 30 * day + "\tfix: again in a\n\nsrc/a.py\nREADME.md", "\u0001h3\t" + 25 * day + "\tfix: crash in a\n\nsrc/a.py", "\u0001h2\t" + 2 * day + "\tfix: b\n\nsrc/a.py", "\u0001h1\t" + day + "\tadd thing\n\nsrc/a.py\nsrc/b.py"].join("\n");
  const commits = parseLog(log);
  assert.equal(commits.length, 5);
  assert.deepEqual(commits[1], { hash: "h4", time: 30 * day, subject: "fix: again in a", files: ["src/a.py", "README.md"] });
  assert.deepEqual(outcomes({ commits }), { commits: 5, fixes: 3, reverts: 1, fixOfFix: 1 });
  assert.deepEqual(outcomes({ commits: commits.filter((c) => c.time >= 26 * day) }), { commits: 2, fixes: 1, reverts: 1, fixOfFix: 0 });
});

test("the switch remembers when it was turned on", () => {
  process.env.RATCHET_HOME = tmp("home");
  assert.equal(readState().since, undefined);
  setSwitch({ enabled: true });
  const first = readState().since;
  assert.match(first ?? "", /^\d{4}-\d\d-\d\dT/);
  setSwitch({ mode: "enforce" });
  assert.equal(readState().since, first);
  setSwitch({ root: "/w/p", enabled: true });
  assert.match(Object.values(readState().projects)[0]?.since ?? "", /^\d{4}/);
});

test("a glob that starts with ! takes files out of a rule again", () => {
  const globs = ["pkg/*.py", "!pkg/test_*.py"];
  assert.equal(matchesAny("pkg/cell.py", globs), true);
  assert.equal(matchesAny("pkg/test_cell.py", globs), false);
  assert.equal(matchesAny("pkg/test_cell.py", ["!pkg/test_*.py"]), false);
});
