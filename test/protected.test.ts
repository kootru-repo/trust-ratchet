// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { protectedFolders, runBuiltin } from "../src/harness/builtins.ts";
import { checkCandidates, statusBothPaths, tryCheck } from "../src/harness/checks.ts";
import { harnessCli } from "../src/harness/cli.ts";
import { allowedNow, allowProtected, normalizeGlob, readAllowances, restoreHint } from "../src/harness/protected.ts";
import { ensureBaseline } from "../src/harness/session.ts";
import { projectFile, writeJson } from "../src/harness/state.ts";
import { runTurn } from "../src/harness/turn.ts";

process.env.RATCHET_CHILD = "";
const tmp = (name: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ratchet-${name}-`)));
process.env.RATCHET_HOME = tmp("pr-home");
const SOURCE = path.resolve(import.meta.dirname, "..");
const gitIn = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
const put = (repo: string, file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};
const repoWith = (files: Record<string, string>): string => {
  const repo = tmp("pr");
  gitIn(repo, "init", "-q", "-b", "main");
  for (const [f, text] of Object.entries(files)) put(repo, f, text);
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  return repo;
};
const quiet = (fn: () => number): number => {
  const log = console.log;
  console.log = () => undefined;
  try {
    return fn();
  } finally {
    console.log = log;
  }
};

test("folders that hold a recorded reference are found by name, outermost only", () => {
  assert.deepEqual(protectedFolders(["app/ts/fixtures/a.json", "app/ts/fixtures/deep/fixtures/b.json", "src/__snapshots__/x.snap", "golden/out.txt", "node_modules/p/fixtures/x.json", "src/fixtures.ts", "testdata"]), ["app/ts/fixtures", "golden", "src/__snapshots__"]);
});

test("an allowance covers its glob until it ends; the command normalizes the glob and refuses one that covers no protected file", () => {
  const now = 1_000_000;
  const list = [{ glob: "fx/**", at: now, until: now + 60_000 }];
  assert.equal(allowedNow(list, "fx/a.json", now + 59_000), true);
  assert.equal(allowedNow(list, "fx/a.json", now + 61_000), false);
  assert.equal(allowedNow(list, "other/a.json", now), false);
  assert.equal(normalizeGlob(" ./././test\\fixtures\\** "), "test/fixtures/**");
  const repo = repoWith({ "a.txt": "x\n", "fx/a.json": "{}\n" });
  writeJson(projectFile(repo, "config.json"), { checks: [{ name: "p", command: "builtin:protected", when: ["fx/**"] }] });
  assert.equal(quiet(() => harnessCli(["allow-protected", "--project", repo], SOURCE)), 1);
  assert.equal(quiet(() => harnessCli(["allow-protected", "--project", repo, "--path", "other/**"], SOURCE)), 1);
  assert.equal(quiet(() => harnessCli(["allow-protected", "--project", repo, "--path", "fx/**", "--minutes", "0"], SOURCE)), 1);
  assert.equal(quiet(() => harnessCli(["allow-protected", "--project", repo, "--path", ".\\fx\\**", "--minutes", "5"], SOURCE)), 0);
  assert.deepEqual(readAllowances(repo).map((a) => a.glob), ["fx/**"]);
  assert.match(fs.readFileSync(projectFile(repo, "allowances.log"), "utf8"), /allowed fx\/\*\* for 5 min/);
});

test("at a turn end a protected file the session changed fails and holds, even once committed, until the person allows it mid-session", () => {
  const repo = repoWith({ "fx/a.json": '{"v":1}\n', "src/a.ts": "export const a = 1;\n" });
  writeJson(projectFile(repo, "config.json"), { checks: [{ name: "fixtures-unchanged", command: "builtin:protected", when: ["fx/**"] }] });
  const { baseline } = ensureBaseline("pr1", repo);
  put(repo, "fx/a.json", '{"v":2}\n');
  gitIn(repo, "commit", "-q", "-am", "re-record by hand");
  const out = runTurn({ sessionId: "pr1", baseline, stopDeadline: Date.now() + 8000 });
  const finding = out?.findings.find((f) => f.title.startsWith("fixtures-unchanged"));
  assert.equal(finding?.blocking, true);
  assert.match(finding?.detail ?? "", /^fx\/a\.json: a protected file changed in this session.*ratchet allow-protected --path "fx\/a\.json"/);
  // Granted with no file changed since: the next turn end runs the check again and it passes.
  allowProtected({ root: repo, glob: "fx/**", minutes: 30 });
  const allowed = runTurn({ sessionId: "pr1", baseline, stopDeadline: Date.now() + 8000 });
  assert.equal(allowed?.outcomes.find((o) => o.name === "fixtures-unchanged")?.status, "pass");
  assert.match(fs.readFileSync(projectFile(repo, "allowances.log"), "utf8"), /changes allowed by an open allowance: fx\/a\.json/);
});

test("init offers a protected folder only when no protected check covers it, and its trial passes on a clean tree and fails with changes", () => {
  const files = ["test/fixtures/a.json", "src/a.ts"];
  const offeredWith = (checks: { name: string; command: string; when?: string[] }[]): string[] => checkCandidates({ files, scripts: {}, hasTypescript: () => false, config: { checks }, offerBuiltins: true }).filter((c) => c.command === "builtin:protected").map((c) => c.name);
  assert.deepEqual(offeredWith([]), ["protected-test-fixtures"]);
  assert.deepEqual(offeredWith([{ name: "jest", command: "jest --testPathIgnorePatterns fixtures" }]), ["protected-test-fixtures"]);
  assert.deepEqual(offeredWith([{ name: "old", command: "builtin:protected", when: ["test/fixtures-old/**"] }]), ["protected-test-fixtures"]);
  assert.deepEqual(offeredWith([{ name: "all", command: "builtin:protected", when: ["**/fixtures/**"] }]), []);
  const repo = repoWith({ "test/fixtures/a.json": "{}\n" });
  const cand = { name: "p", command: "builtin:protected", when: ["test/fixtures/**"], from: "test/fixtures" };
  assert.equal(tryCheck({ root: repo, check: cand }).ok, true);
  put(repo, "test/fixtures/a.json", '{"x":1}\n');
  assert.equal(tryCheck({ root: repo, check: cand }).ok, false);
  assert.equal(runBuiltin({ command: "builtin:protected", root: repo, files: [] }).status, 0);
});

test("review of A3: the hint puts back a staged change and removes a new file, and the trial sees both sides of a rename", () => {
  assert.match(restoreHint("fx/a.json", "0123456789abcdef", true), /git restore --source=0123456789ab --staged --worktree -- "fx\/a\.json"/);
  assert.match(restoreHint("fx/n.json", "0123456789abcdef", false), /new in this session: remove it \(git rm --cached -- "fx\/n\.json"/);
  assert.deepEqual(statusBothPaths(["R  src/moved.json", "fx/my file.json", "?? fx/new.json", " M a.ts", ""]), ["src/moved.json", "fx/my file.json", "fx/new.json", "a.ts"]);
  assert.deepEqual(statusBothPaths([" R moved.json", "fx/a.json", ""]), ["moved.json", "fx/a.json"]);
  const repo = repoWith({ "fx/a.json": "{}\n", "fx/my file.json": "{}\n" });
  writeJson(projectFile(repo, "config.json"), { checks: [{ name: "fx", command: "builtin:protected", when: ["fx/**"] }] });
  const { baseline } = ensureBaseline("pr2", repo);
  put(repo, "fx/a.json", '{"v":2}\n');
  gitIn(repo, "add", "fx/a.json");
  put(repo, "fx/n.json", "{}\n");
  const out = runTurn({ sessionId: "pr2", baseline, stopDeadline: Date.now() + 8000 });
  const detail = out?.findings.find((f) => f.title.startsWith("fx"))?.detail ?? "";
  assert.match(detail, /fx\/a\.json: .*git restore --source=\w+ --staged --worktree -- "fx\/a\.json"/);
  assert.match(detail, /fx\/n\.json: .*new in this session/);
  // The hint really puts the staged change back.
  gitIn(repo, "restore", `--source=${baseline.head ?? ""}`, "--staged", "--worktree", "--", "fx/a.json");
  assert.equal(fs.readFileSync(path.join(repo, "fx/a.json"), "utf8"), "{}\n");
  fs.rmSync(path.join(repo, "fx/n.json"));
  gitIn(repo, "mv", "fx/my file.json", "moved.json");
  assert.equal(tryCheck({ root: repo, check: { name: "p", command: "builtin:protected", when: ["fx/**"], from: "fx" } }).ok, false);
});
