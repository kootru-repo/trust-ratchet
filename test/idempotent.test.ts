import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { judgeComments } from "../src/harness/comments.ts";
import { decide, runHook, type Context } from "../src/swarm/guard.ts";
import { applyPatch } from "../src/swarm/patch.ts";
import { disagreements, type Traces } from "../src/swarm/differential.ts";
import { judgeRubric, type Rubric } from "../src/swarm/rubric.ts";
import { acceptVerdict, parseResult, patchId, type Handover, type Verdict } from "../src/swarm/verdict.ts";

/** The owner's rule, 2026-11-21 (from the talk on agent products): "retrying a call shouldn't make a change twice". Each operation run twice with the same input gives the same result and the same effect. */
const twice = <T>(f: () => T): [T, T] => [f(), f()];

const root = process.platform === "win32" ? "C:/work/app" : "/work/app";
const ctx: Context = { role: "worker", root, allow: ["town/a.js"], hold: false };

test("idempotent: the guard decides the same on a replayed call", () => {
  for (const call of [{ tool: "Edit", file: `${root}/town/a.js` }, { tool: "Edit", file: `${root}/town/b.js` }, { tool: "Bash", command: "git add -A" }, { tool: "Bash", command: "git status" }]) {
    const [a, b] = twice(() => decide(ctx, call));
    assert.deepEqual(a, b);
  }
});

test("idempotent: a hook replayed for one tool call prints the same and writes one record, never two", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-idem-"));
  const log = path.join(dir, "refusals.jsonl");
  const env = { RATCHET_SWARM_ROLE: "worker", RATCHET_SWARM_ROOT: root, RATCHET_SWARM_ALLOW: "town/a.js", RATCHET_SWARM_LOG: log };
  const payload = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git add -A" }, session_id: "s", agent_id: "a", tool_use_id: "toolu_1" });
  const [x, y] = twice(() => runHook(payload, env));
  assert.equal(x, y);
  assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 1);
  runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push" }, session_id: "s", tool_use_id: "toolu_2" }), env);
  assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 2, "a different call is a different record");
});

const diff = "diff --git a/x b/x\n+one\n";
const handover: Handover = { task: "t", author: "w", patchId: patchId(diff), base: "abc1234", files: ["x"], allow: ["x"] };
const verdict: Verdict = { verifier: "v", patchId: patchId(diff), status: "PASS", method: "ran it", checks: [{ command: "c", exit: 0 }] };

test("idempotent: judging the same verdict, rubric, report, comments and traces twice gives the same answer", () => {
  assert.deepEqual(...twice(() => acceptVerdict(handover, verdict, diff)));
  assert.deepEqual(...twice(() => parseResult('{"status":"PASS","heads":["abc1234"],"method":"x"}')));
  const rubric: Rubric = { id: "r", rule: "x", questions: [{ id: "q1", ask: "ran?", evidence: [{ kind: "command", match: "node" }] }] };
  assert.deepEqual(...twice(() => judgeRubric(rubric, [{ id: "q1", answer: "yes" }], [{ tool: "Bash", command: "node a", output: "" }], () => false)));
  assert.deepEqual(...twice(() => judgeComments({ file: "a.ts", content: "// x\nconst a = 1;\n", before: [], config: { mode: "ban" } })));
  const scripts = [{ id: "s", steps: [{ fn: "f", args: [1] }] }];
  const a: Traces = { s: [{ value: "1" }] };
  const b: Traces = { s: [{ value: "2" }] };
  assert.deepEqual(...twice(() => disagreements({ scripts, a, b })));
});

const gitIn = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
const treeHash = (repo: string): string => fs.readFileSync(path.join(repo, "a.txt"), "utf8");

test("idempotent: integrating a patch twice leaves the tree as integrating it once did; a patch that fits neither way changes nothing", () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-patch-repo-")));
  gitIn(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "start");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
  const patch = gitIn(repo, "diff");
  gitIn(repo, "checkout", "--", "a.txt");
  assert.equal(treeHash(repo), "one\ntwo\n");
  const first = applyPatch(repo, patch);
  assert.equal(first.state, "applied");
  const afterOnce = treeHash(repo);
  const second = applyPatch(repo, patch);
  assert.equal(second.state, "already");
  assert.equal(treeHash(repo), afterOnce, "the second integration changed nothing");
  fs.writeFileSync(path.join(repo, "a.txt"), "completely different\n");
  const stranger = applyPatch(repo, patch);
  assert.equal(stranger.state, "conflict");
  assert.equal(treeHash(repo), "completely different\n", "a conflict changes nothing");
});
