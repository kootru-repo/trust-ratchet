import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { guardPrompt, runAt } from "../src/harness/guardwriter.ts";
import { eligibleFixes, sweep, walkFixes } from "../src/harness/guardsweep.ts";
import { readJson, writeJson } from "../src/harness/state.ts";
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
const quiet = { memory: () => 10 };
const fenced = (code: string): string => `\`\`\`python\n${code}\`\`\`\n`;
// A test in the project's own style: it stands in the project's test folder and leans on the project's setup file.
const OWN = 'import os, sys\nhere = os.path.dirname(os.path.abspath(__file__))\nsys.path.insert(0, os.path.join(os.getcwd(), "app"))\nsys.path.insert(0, os.path.join(os.getcwd(), "app", "checks"))\nimport setup_checks\nimport calc\nassert os.path.basename(here) == "checks"\nassert calc.add(2, 3) == setup_checks.FIVE\n';

const history = (): { repo: string; fix1: string; fix2: string; other: string; setup: string } => {
  const repo = tmp("own");
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, "app/calc.py", BUG);
  put(repo, "side/tool.py", "def one():\n    return 2\n");
  commit(repo, "add");
  put(repo, "app/calc.py", FIX);
  const fix1 = commit(repo, "fix: add subtracted");
  put(repo, "side/tool.py", "def one():\n    return 1\n");
  const other = commit(repo, "fix: one was two");
  put(repo, "app/calc.py", `# tidy\n${BUG}`);
  commit(repo, "tidy the calculator");
  put(repo, "app/calc.py", `# tidy\n${FIX}`);
  const fix2 = commit(repo, "fix: add subtracted again");
  put(repo, "app/checks/setup_checks.py", "FIVE = 5\n");
  const setup = commit(repo, "add the project's test setup");
  return { repo, fix1, fix2, other, setup };
};

test("a command can say where the project's runner looks for tests and which setup files an older tree lacks", () => {
  const { repo, fix1, setup } = history();
  const run = (template: string, rev: string) => runAt({ root: repo, rev, files: ["app/calc.py"], testName: "test_guard_x.py", code: OWN, template });
  const own = `[lay ${setup} app/checks/setup_checks.py] [place app/checks] python -B app/checks/{name}`;
  assert.deepEqual(run(own, fix1), { ran: "passes", wrote: false });
  assert.deepEqual(run(own, `${fix1}^`), { ran: "fails", wrote: false });
  // Without the setup file laid in, the older tree cannot load the test; in the default folder the test is not where it says.
  assert.equal(run("[place app/checks] python -B app/checks/{name}", fix1).ran, "errors");
  assert.equal(run(`[lay ${setup} app/checks/setup_checks.py] python -B {test}`, fix1).ran, "fails");
  // A tree that has the setup file keeps its own.
  assert.equal(run(own, "HEAD").ran, "passes");
  assert.equal(gitIn(repo, "status", "--porcelain").trim(), "");
});

test("a request can carry the project's own test style in place of the plain one", () => {
  const plain = guardPrompt({ file: "src/a.ts", diff: "d", after: "a" });
  const styled = guardPrompt({ file: "src/a.ts", diff: "d", after: "a", style: ["Write it for the project's runner."] });
  assert.match(plain, /node:test/);
  assert.doesNotMatch(styled, /node:test/);
  assert.match(styled, /Write it for the project's runner\.[\s\S]*UNTESTABLE/);
});

test("a sweep can be limited to one folder and to commits after one, keeps its own state under its own style, and its walk goes on from kept progress", async () => {
  process.env.RATCHET_HOME = tmp("home");
  const { repo, fix1, fix2, other, setup } = history();
  const templates = { py: `[lay ${setup} app/checks/setup_checks.py] [place app/checks] python -B app/checks/{name}` };
  assert.deepEqual(eligibleFixes({ root: repo, exclude: [], templates }).eligible.sort(), [fix1, fix2, other].sort());
  assert.deepEqual(eligibleFixes({ root: repo, exclude: [], templates, only: ["app/**"] }).eligible.sort(), [fix1, fix2].sort());
  assert.deepEqual(eligibleFixes({ root: repo, exclude: [], templates, only: ["app/**"], after: fix1 }).eligible, [fix2]);
  const asked: string[] = [];
  const model: ModelFn = async ({ prompt }) => {
    asked.push(prompt);
    return fenced(OWN);
  };
  const statePath = path.join(tmp("st"), "sweep.json");
  const args = { root: repo, model, statePath, n: 5, seed: "s", templates, only: ["app/**"], style: ["Write it the project's way."], ...quiet };
  const done = await sweep(args);
  assert.deepEqual({ sample: [...done.sample].sort(), kept: Object.values(done.results).map((r) => r.cls) }, { sample: [fix1, fix2].sort(), kept: ["kept", "kept"] });
  assert.match(asked[0] ?? "", /Write it the project's way\./);
  assert.match(done.promptId, /-[0-9a-f]{6}$/);
  // The registered walk, only over later fix commits that touched the folder: the fix elsewhere is not visited.
  assert.equal(walkFixes({ statePath, ...quiet }).fixWalk[fix1]?.laterFixes, 2);
  writeJson(statePath, { ...readJson<Record<string, unknown>>(statePath, {}), fixWalk: {} });
  const walked = walkFixes({ statePath, paths: ["app"], ...quiet });
  assert.deepEqual({ later: walked.fixWalk[fix1]?.laterFixes, caught: walked.fixWalk[fix1]?.caught }, { later: 1, caught: [fix2] });
  // Progress is kept per whole tree. With the results taken away and a command that can no longer run, the walk
  // still ends the same way: it went on from what was kept and ran nothing again.
  const kept = readJson<Record<string, unknown>>(statePath, {});
  assert.ok(Object.keys((kept.fixWalkSeen as Record<string, Record<string, string>>)[fix1] ?? {}).length >= 2);
  writeJson(statePath, { ...kept, fixWalk: {}, templates: { py: "python -B no-such-file-{name}" } });
  assert.deepEqual(walkFixes({ statePath, paths: ["app"], ...quiet }).fixWalk[fix1]?.caught, [fix2]);
});
