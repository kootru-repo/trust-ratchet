// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { countVerdict } from "../src/harness/mergeclass.ts";
import { makeVerifier, type ClaudeCall } from "../src/swarm/verifier.ts";
import { patchId, type Handover } from "../src/swarm/verdict.ts";
import { diffTo, fixtureRepo, git, tmp } from "./fixture.ts";

const pass = (head: string): string => `looked\n{"status":"PASS","heads":["${head.slice(0, 7)}"],"method":"read the diff"}`;
const handover = (diff: string, base: string, author = "worker-t1"): Handover => ({ task: "t1", author, patchId: patchId(diff), base, files: ["a.txt"], allow: ["a.txt"] });
const setup = (claude: (head: string) => ClaudeCall, checks = ["node check.js"]) => {
  const { repo, head } = fixtureRepo();
  const verify = makeVerifier({ repo, workDir: tmp(), checks, claude: claude(head), env: { ANTHROPIC_API_KEY: "k", PATH: process.env.PATH } });
  return { repo, head, verify };
};

test("VERIFIED on a passing patch; the verdict counts; the target is untouched; no API key reaches claude", async () => {
  let seenEnv: Record<string, string> = {};
  let seenCwd = "";
  const s = setup((head) => async (r) => {
    seenEnv = r.env;
    seenCwd = r.cwd;
    return pass(head);
  });
  const diff = diffTo(s.repo, "ok and more\n");
  const v = await s.verify(handover(diff, s.head), diff);
  assert.equal(v.verdict, "VERIFIED");
  assert.equal(v.status, "PASS");
  assert.deepEqual(v.checks, [{ command: "node check.js", exit: 0 }]);
  assert.equal(seenEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(seenEnv.RATCHET_SWARM_ROLE, "verifier");
  assert.equal(seenEnv.RATCHET_SWARM_ALLOW, "");
  assert.notEqual(path.resolve(seenCwd), path.resolve(s.repo));
  assert.ok(fs.existsSync(v.evidence[0] ?? ""));
  assert.equal(countVerdict({ author: "worker-t1", verifier: v.verifier, patchId: v.patchId, verdict: v.verdict, evidence: v.evidence }, patchId(diff)).counted, true);
  assert.equal(git(s.repo, ["status", "--porcelain"]), "");
  assert.equal(fs.existsSync(seenCwd), false);
});

test("a failing check is NOT VERIFIED whatever the session says", async () => {
  const s = setup((head) => async () => pass(head));
  const diff = diffTo(s.repo, "bad\n");
  const v = await s.verify(handover(diff, s.head), diff);
  assert.equal(v.verdict, "NOT VERIFIED");
  assert.equal(v.checks[0]?.exit, 1);
  assert.equal(v.checks[0]?.baseExit, 0);
});

test("a verifier that writes a file is INCONCLUSIVE (K14)", async () => {
  const s = setup((head) => async (r) => {
    fs.writeFileSync(path.join(r.cwd, "new.txt"), "x");
    return pass(head);
  });
  const diff = diffTo(s.repo, "ok again\n");
  const v = await s.verify(handover(diff, s.head), diff);
  assert.equal(v.verdict, "INCONCLUSIVE");
  assert.match(v.method, /wrote/);
});

test("claude failure, unusable output and a patch that does not apply are INCONCLUSIVE", async () => {
  const bad = setup(() => async () => {
    throw new Error("boom");
  });
  const diff = diffTo(bad.repo, "ok x\n");
  assert.equal((await bad.verify(handover(diff, bad.head), diff)).verdict, "INCONCLUSIVE");
  const junk = setup(() => async () => "no json here");
  assert.equal((await junk.verify(handover(diff, junk.head), diff)).verdict, "INCONCLUSIVE");
  const stale = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-zzz\n+yyy\n";
  const v = await junk.verify(handover(stale, junk.head), stale);
  assert.equal(v.verdict, "INCONCLUSIVE");
  assert.equal(v.status, "BLOCKED");
});

test("the verifier id differs from the author even when the author has the verifier name", async () => {
  const s = setup((head) => async () => pass(head));
  const diff = diffTo(s.repo, "ok q\n");
  const v = await s.verify(handover(diff, s.head, "verifier-t1"), diff);
  assert.notEqual(v.verifier, "verifier-t1");
});

test("a check that fails on the base too is not held", async () => {
  const s = setup((head) => async () => pass(head), ["node check.js", "node -e \"process.exit(3)\""]);
  const diff = diffTo(s.repo, "ok z\n");
  const v = await s.verify(handover(diff, s.head), diff);
  assert.equal(v.checks[1]?.baseExit, 3);
  assert.equal(v.verdict, "VERIFIED");
});
