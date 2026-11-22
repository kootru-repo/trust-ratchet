// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createWorktree } from "../src/swarm/worktree.ts";
import { fixtureRepo, git, tmp } from "./fixture.ts";

test("worktrees are separate, leave the target untouched and are removed", () => {
  const { repo, head } = fixtureRepo();
  const dir = tmp();
  const branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const a = createWorktree(repo, head, dir, "w1");
  const b = createWorktree(repo, "HEAD", dir, "w2");
  assert.notEqual(a.path, b.path);
  assert.equal(fs.readFileSync(path.join(a.path, "a.txt"), "utf8"), "ok\n");
  fs.writeFileSync(path.join(a.path, "a.txt"), "changed\n");
  assert.equal(fs.readFileSync(path.join(b.path, "a.txt"), "utf8"), "ok\n");
  assert.equal(fs.readFileSync(path.join(repo, "a.txt"), "utf8"), "ok\n");
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  assert.equal(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]), branch);
  a.remove();
  a.remove();
  b.remove();
  assert.equal(fs.existsSync(a.path), false);
  assert.equal(fs.existsSync(b.path), false);
  assert.equal(git(repo, ["worktree", "list"]).trim().split("\n").length, 1);
});

test("a bad name or base is refused", () => {
  const { repo, head } = fixtureRepo();
  assert.throws(() => createWorktree(repo, head, tmp(), "../x"));
  assert.throws(() => createWorktree(repo, "nosuchref", tmp(), "w"));
});
