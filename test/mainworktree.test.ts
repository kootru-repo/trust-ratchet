import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { effective, mainOfWorktree, normRoot, projectDir, projectFile, readState, setSwitch, writeJson } from "../src/harness/state.ts";

process.env.RATCHET_CHILD = "";
const tmp = (name: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ratchet-${name}-`)));
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("a linked worktree is the same project as its main repository (probe P3)", () => {
  process.env.RATCHET_HOME = tmp("home");
  const main = tmp("main");
  git(main, "init", "-q");
  fs.writeFileSync(path.join(main, "a.txt"), "a");
  git(main, "add", "a.txt");
  git(main, "commit", "-q", "-m", "one");
  const wt = path.join(tmp("wtparent"), "agent-1");
  git(main, "worktree", "add", "-q", wt);

  assert.equal(path.resolve(mainOfWorktree(wt)).toLowerCase(), path.resolve(main).toLowerCase());
  assert.equal(normRoot(wt), normRoot(main));
  assert.equal(projectDir(wt), projectDir(main));

  setSwitch({ root: main, enabled: true, mode: "enforce" });
  assert.deepEqual(effective(readState(), wt), { enabled: true, mode: "enforce" });
  writeJson(projectFile(main, "config.json"), { checks: [] });
  assert.equal(projectFile(wt, "config.json"), projectFile(main, "config.json"));
});

test("a normal repository, a plain folder and a missing path are returned as given", () => {
  const plain = tmp("plain");
  assert.equal(mainOfWorktree(plain), plain);
  const repo = tmp("repo");
  git(repo, "init", "-q");
  assert.equal(mainOfWorktree(repo), repo);
  const missing = path.join(plain, "nope");
  assert.equal(mainOfWorktree(missing), missing);
});
