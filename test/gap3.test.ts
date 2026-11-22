// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { importsOf, runAuto, whenFor } from "../src/harness/auto.ts";
import { checkCandidates, tryCheck } from "../src/harness/checks.ts";
import { extractCode, guardPrompt, proveGuard, refusal, writeGuard } from "../src/harness/guardwriter.ts";
import { projectDir, projectFile, readConfig, writeJson } from "../src/harness/state.ts";
import { nearestFirst } from "../src/harness/turn.ts";
import type { ModelFn } from "../src/types.ts";

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

test("a test is mapped to what it imports and to what those import, and a script's .mjs import is followed", () => {
  const files = ["test/a.test.mjs", "lib/a.mjs", "lib/b.mjs", "lib/deep/c.mjs", "lib/deep/d.mjs", "lib/deep/e.mjs", "lib/unrelated.mjs", "pkg/__init__.py", "pkg/core.py", "tools/test_x.py", "tools/helper.py"];
  const text: Record<string, string> = {
    "test/a.test.mjs": 'import { a } from "../lib/a.mjs";\nimport fs from "node:fs";\n',
    "lib/a.mjs": 'import { b } from "./b.mjs";\nconst late = await import("./deep/c.mjs");\n',
    "lib/b.mjs": "export const b = 1;\n",
    "lib/deep/c.mjs": 'import "./d.mjs";\n',
    "lib/deep/d.mjs": 'import "./e.mjs";\n',
    "tools/test_x.py": "import helper\nfrom pkg.core import thing\nimport os, json as j\n",
    "tools/helper.py": "import pkg\n",
  };
  const read = (f: string): string | null => text[f] ?? "";
  assert.deepEqual(importsOf({ file: "test/a.test.mjs", text: text["test/a.test.mjs"] ?? "", have: new Set(files) }), ["lib/a.mjs"]);
  // Three steps: the test, a, then b and c, then d. e is a fourth step and is left out.
  assert.deepEqual(whenFor({ test: "test/a.test.mjs", text: text["test/a.test.mjs"] ?? "", files, read }).sort(), ["lib/a.mjs", "lib/b.mjs", "lib/deep/c.mjs", "lib/deep/d.mjs", "test/a.test.mjs"]);
  // Without a reader only the test's own imports are known.
  assert.deepEqual(whenFor({ test: "test/a.test.mjs", text: text["test/a.test.mjs"] ?? "", files }), ["test/a.test.mjs", "lib/a.mjs"]);
  assert.deepEqual(whenFor({ test: "tools/test_x.py", text: text["tools/test_x.py"] ?? "", files, read }).sort(), ["pkg/__init__.py", "pkg/core.py", "tools/helper.py", "tools/test_x.py"]);
});

test("a check is a candidate only where the project could run it, a person's check of the same folder stands, and a script that rewrites files is never one", () => {
  const files = ["tsconfig.json", "apps/web/tsconfig.json", "apps/api/tsconfig.json", "sealed/x/tsconfig.json", "a/b/c/d/tsconfig.json", "node_modules/p/tsconfig.json"];
  const found = checkCandidates({ files, scripts: { lint: "eslint . --fix", typecheck: "tsc --noEmit" }, hasTypescript: (dir) => dir !== "apps/api", config: { checks: [{ name: "types-demo-web", command: "cd apps/web && npx tsc --noEmit --skipLibCheck" }] }, exclude: ["sealed/**"] });
  assert.deepEqual(found.map((c) => c.name), ["types-root"]);
  assert.equal(found[0]?.command, "npx --no-install tsc --noEmit -p .");
  assert.equal(found[0]?.origin, "auto");
  // With no tsconfig at the root, the package's own script is the candidate; a lint that checks only is one too.
  const scripts = checkCandidates({ files: [], scripts: { lint: "eslint .", typecheck: "tsc --noEmit", format: "prettier --write ." }, hasTypescript: () => true, config: {} });
  assert.deepEqual(scripts.map((c) => c.command), ["npm run -s lint", "npm run -s typecheck"]);
});

test("a candidate check is kept only when it ran clean and left the working tree as it was", () => {
  const repo = tmp("chk");
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, "a.py", "x = 1\n");
  commit(repo, "add");
  const cand = (command: string) => ({ name: "c", command, from: "a.py" });
  assert.equal(tryCheck({ root: repo, check: cand("python -B a.py") }).ok, true);
  assert.equal(tryCheck({ root: repo, check: cand('python -c "raise SystemExit(2)"') }).ok, false);
  const wrote = tryCheck({ root: repo, check: cand("python -c \"open('made.txt','w').write('x')\"") });
  assert.deepEqual({ ok: wrote.ok, why: wrote.why }, { ok: false, why: "it changed files in the working tree" });
});

const BUG = "def add(a, b):\n    return a - b\n";
const FIX = "def add(a, b):\n    return a + b\n";
const GOOD_TEST = 'import os, sys\nsys.path.insert(0, os.path.join(os.getcwd(), "tools"))\nimport calc\nassert calc.add(2, 3) == 5\n';

test("a written test is kept only when a program saw it fail before the fix and pass after it", async () => {
  process.env.RATCHET_HOME = tmp("home");
  const repo = tmp("guard");
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, "tools/calc.py", BUG);
  commit(repo, "add");
  writeJson(projectFile(repo, "config.json"), { auto: true, autoGuards: true, autoTest: { py: "python -B {test}" } });
  let asked = 0;
  const replies: string[] = [];
  const model: ModelFn = async ({ prompt }) => {
    asked += 1;
    assert.match(prompt, /must FAIL on the code as it was before the fix and PASS/);
    return replies.shift() ?? "UNTESTABLE";
  };
  const quiet = { memory: () => 10 };
  // Switched on: the fixes already in the history are not swept, and no model is called.
  assert.equal((await writeGuard({ root: repo, model, ...quiet })).tried, null);
  assert.equal(asked, 0);
  put(repo, "tools/calc.py", FIX);
  const fix = commit(repo, "fix: add subtracted");
  assert.deepEqual(proveGuard({ root: repo, commit: fix, files: ["tools/calc.py"], testName: "test_guard_x.py", code: GOOD_TEST, template: "python -B {test}" }), { before: "fails", after: "passes", wrote: false });

  // A test that passes on both sides proves nothing and is thrown away. So is one that would start a process.
  replies.push("```python\nassert True, 'always'\nprint(1)\n```");
  const empty = await writeGuard({ root: repo, model, only: fix, ...quiet });
  assert.deepEqual({ kept: empty.tried?.kept, reason: empty.tried?.reason }, { kept: false, reason: "the written test passes before the fix and passes after it; it must fail before and pass after" });
  replies.push("```python\nimport subprocess\nsubprocess.run(['x'])\nassert False\n```");
  assert.match((await writeGuard({ root: repo, model, only: fix, ...quiet })).tried?.reason ?? "", /is not run/);
  assert.match((await writeGuard({ root: repo, model, only: fix, ...quiet })).tried?.reason ?? "", /cannot be tested/);
  assert.equal(readConfig(repo).tests, undefined);

  replies.push(`Here it is.\n\`\`\`python\n${GOOD_TEST}\`\`\`\n`);
  const kept = await writeGuard({ root: repo, model, only: fix, ...quiet });
  assert.equal(kept.tried?.kept, true);
  const entry = readConfig(repo).tests?.[0];
  assert.deepEqual({ name: entry?.name, when: entry?.when, origin: entry?.origin }, { name: `guard-${fix.slice(0, 7)}`, when: ["tools/calc.py"], origin: "auto" });
  // The kept file is outside the repository and runs in it as it is: clean now, failing if the bug comes back.
  const stored = path.join(projectDir(repo), "guards", `test_guard_${fix.slice(0, 7)}.py`);
  assert.equal(fs.readFileSync(stored, "utf8"), GOOD_TEST);
  assert.equal(gitIn(repo, "status", "--porcelain").trim(), "");
  const run = (): boolean => {
    try {
      execFileSync(entry?.command ?? "", { cwd: repo, shell: true, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(run(), true);
  put(repo, "tools/calc.py", BUG);
  assert.equal(run(), false);
  assert.match(kept.change?.undo ?? "", /remove the entry named guard-/);
  // With the switch off nothing is asked.
  writeJson(projectFile(repo, "config.json"), { ...readConfig(repo), autoGuards: false });
  const before = asked;
  await writeGuard({ root: repo, model, only: fix, ...quiet });
  assert.equal(asked, before);
});

test("the request names the file through the working directory, a reply is read for its code, and code that reaches outside is refused", () => {
  assert.match(guardPrompt({ file: "src/a.ts", diff: "d", after: "a" }), /path\.join\(process\.cwd\(\), "src\/a\.ts"\)/);
  assert.match(guardPrompt({ file: "tools/dm/a.py", diff: "d", after: "a" }), /os\.path\.join\(os\.getcwd\(\), "tools\/dm"\)/);
  assert.equal(extractCode("UNTESTABLE"), null);
  assert.equal(extractCode("```ts\nimport { test } from 'node:test';\ntest('x', () => {});\n```"), "import { test } from 'node:test';\ntest('x', () => {});\n");
  assert.equal(refusal("import fs from 'node:fs';\nassert.equal(1, 1)\n"), null);
  for (const bad of ["await fetch('x')", "import { execFileSync } from 'node:child_process'", "os.remove(p)", "fs.rmSync(p)", "eval(x)"]) assert.notEqual(refusal(bad), null, bad);
});

test("the loop finds a check by itself, maps it once it ran clean, and does not try a failed one again until its source changes", () => {
  process.env.RATCHET_HOME = tmp("home");
  const repo = tmp("loopchk");
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, "package.json", JSON.stringify({ scripts: { lint: "node lint.mjs" } }));
  put(repo, "lint.mjs", "process.exit(1);\n");
  put(repo, "src/a.mjs", "export const a = 1;\n");
  commit(repo, "add");
  writeJson(projectFile(repo, "config.json"), { auto: true });
  const failed = runAuto({ memory: () => 10, root: repo });
  assert.ok(failed.notes.some((n) => /check "npm run -s lint" was tried and not mapped/.test(n)));
  assert.equal(runAuto({ memory: () => 10, root: repo }).notes.some((n) => /was tried/.test(n)), false);
  put(repo, "lint.mjs", "process.exit(0);\n");
  put(repo, "package.json", JSON.stringify({ scripts: { lint: "node lint.mjs" }, name: "x" }));
  commit(repo, "lint passes");
  const mapped = runAuto({ memory: () => 10, root: repo });
  assert.ok(mapped.changes.some((c) => /check lint-root-script found and mapped/.test(c.what)));
  assert.deepEqual(readConfig(repo).checks?.map((c) => ({ name: c.name, origin: c.origin })), [{ name: "lint-root-script", origin: "auto" }]);
  assert.equal(runAuto({ memory: () => 10, root: repo }).changes.length, 0);
});

test("a test the loop mapped to itself alone is widened to what it imports, and a person's entry is left as it is", () => {
  process.env.RATCHET_HOME = tmp("home");
  const repo = tmp("widen");
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, "lib/a.mjs", "export const a = 1;\n");
  put(repo, "test/a.test.mjs", 'import { a } from "../lib/a.mjs";\n');
  commit(repo, "add");
  const mine = { name: "a.test", when: ["test/a.test.mjs"], command: "node --test test/a.test.mjs", origin: "auto" };
  const theirs = { name: "theirs", when: ["test/a.test.mjs"], command: "node --test test/a.test.mjs" };
  writeJson(projectFile(repo, "config.json"), { auto: true, tests: [mine, theirs] });
  const widened = runAuto({ memory: () => 10, root: repo });
  assert.ok(widened.changes.some((c) => /1 test\(s\) the loop mapped now also run/.test(c.what)));
  assert.deepEqual(readConfig(repo).tests?.map((t) => t.when), [["test/a.test.mjs", "lib/a.mjs"], ["test/a.test.mjs"]]);
  assert.equal(runAuto({ memory: () => 10, root: repo }).changes.length, 0);
});

test("when only a few mapped tests may run at a turn end, the test of the changed file and the narrowest test go first", () => {
  const t = (name: string, when: string[]) => ({ name, when, command: name });
  const tests = [t("wide", ["test/wide.test.ts", "src/a.ts", "src/b.ts", "src/c.ts"]), t("near", ["test/near.test.ts", "src/a.ts"]), t("own", ["test/own.test.ts", "src/a.ts", "src/b.ts"])];
  assert.deepEqual(nearestFirst(tests, ["src/a.ts"]).map((x) => x.name), ["near", "own", "wide"]);
  assert.deepEqual(nearestFirst(tests, ["src/a.ts", "test/own.test.ts"]).map((x) => x.name), ["own", "near", "wide"]);
});
