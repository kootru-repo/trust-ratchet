// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ownFiles, pathsIn, pendingForAgents, samePath, withEdit, withStart, withStop, type Ledger } from "../src/harness/agents.ts";
import { handle } from "../src/harness/hook.ts";
import type { Finding } from "../src/harness/rules.ts";
import { setSwitch } from "../src/harness/state.ts";

const tmp = (name: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ratchet-${name}-`)));
const gitIn = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
const put = (repo: string, file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};
const finding = (over: Partial<Finding>): Finding => ({ kind: "check", title: "t", detail: "", fix: "f", blocking: true, ...over });
const blocks = (fs2: Finding[], own: string[], busy: string[]): boolean[] => pendingForAgents({ findings: fs2, own, busy, running: true }).map((f) => f.blocking);

test("paths are read from a check's output on segment boundaries, and a path printed from a package folder matches its repository path", () => {
  assert.deepEqual(pathsIn("src\\mine.ts(3,1): error TS2322\n./app/x.json:4:2 bad"), ["src/mine.ts", "app/x.json"]);
  assert.equal(samePath("src/x.ts", "app/ts/src/x.ts"), true);
  assert.equal(samePath("data.ts", "a.ts"), false);
  assert.equal(samePath("app/ts/a.ts", "a.ts"), true);
});

test("with an agent running, a failure is pending only when it names an agent's file and none of the session's; the command in the title does not count", () => {
  const own = ["mine.ts", "app/ts/src/x.ts"];
  const busy = ["half.ts"];
  assert.deepEqual(blocks([finding({ kind: "syntax", file: "mine.ts" })], own, busy), [true]);
  assert.deepEqual(blocks([finding({ title: 'types fails (tsc "half.ts" "mine.ts")', detail: "half.ts(1,1): error TS1005" })], own, busy), [false]);
  assert.deepEqual(blocks([finding({ detail: "data.ts(1,1): error; half.ts(2,2): error" })], ["a.ts"], busy), [false]);
  assert.deepEqual(blocks([finding({ detail: "half.ts(1,1) and src/x.ts(2,2)" })], own, busy), [true]);
  assert.deepEqual(blocks([finding({ title: "tests fail", detail: "3 of 40 failed" })], own, busy), [true]);
  assert.deepEqual(blocks([finding({ detail: "half.ts(1,1)" })], own, []), [true]);
  assert.match(pendingForAgents({ findings: [finding({ detail: "half.ts(1,1)" })], own, busy, running: true })[0]?.detail ?? "", /Pending: a background agent of this session is still editing half\.ts/);
  const same = [finding({ detail: "half.ts(1,1)" })];
  assert.equal(pendingForAgents({ findings: same, own, busy, running: false }), same);
});

test("the session's own files include changed files no agent claims, and an edit logged after an agent's stop keeps it stopped", () => {
  const ledger: Ledger = { agents: {}, own: { "a.ts": 1 } };
  assert.deepEqual(ownFiles({ ledger, changed: ["a.ts", "by-sed.ts", "half.ts"], agentClaims: ["half.ts"] }).sort(), ["a.ts", "by-sed.ts"]);
  let l = withStart({ agents: {}, own: {} }, { agentId: "ag", now: 1, changed: [] });
  l = withStop(l, { agentId: "ag", now: 2, changed: [] });
  l = withEdit(l, { file: "late.ts", agentId: "ag", now: 3 });
  assert.deepEqual({ stopped: l.agents.ag?.stopped, files: l.agents.ag?.files }, { stopped: 2, files: ["late.ts"] });
});

test("at the turn end: the agent's broken file is pending once, holds if pending again unchanged, the session's own broken file holds, and all hold after the stop", () => {
  process.env.RATCHET_HOME = tmp("home");
  delete process.env.RATCHET_CHILD;
  const repo = tmp("blame");
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, "a.json", "{}\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  setSwitch({ root: repo, enabled: true, mode: "enforce" });
  type Out = { decision?: string; reason?: string; systemMessage?: string } | null;
  const stop = (): Out => handle("Stop", { session_id: "b1", cwd: repo }) as Out;
  handle("SessionStart", { session_id: "b1", cwd: repo });
  handle("SubagentStart", { session_id: "b1", cwd: repo, agent_id: "ag1" });
  put(repo, "half.json", "{ not yet");
  handle("PostToolUse", { session_id: "b1", cwd: repo, tool_name: "Write", tool_input: { file_path: path.join(repo, "half.json") }, agent_id: "ag1" });
  const first = stop();
  assert.notEqual(first?.decision, "block");
  assert.match(first?.systemMessage ?? "", /Pending: a background agent of this session is still editing half\.json/);
  const again = stop();
  assert.equal(again?.decision, "block");
  assert.match(again?.reason ?? "", /half\.json/);
  put(repo, "mine.json", "{ broken");
  const sed = stop();
  assert.equal(sed?.decision, "block");
  assert.match(sed?.reason ?? "", /mine\.json/);
  handle("SubagentStop", { session_id: "b1", cwd: repo, agent_id: "ag1" });
  put(repo, "mine.json", "{}\n");
  // Two holds are used, so the turn is let go with the failure stated: as failing, no longer pending.
  const after = stop();
  assert.notEqual(after?.decision, "block");
  assert.match(after?.systemMessage ?? "", /1 failing.*after 2 holds/s);
  assert.match(after?.systemMessage ?? "", /half\.json/);
  assert.doesNotMatch(after?.systemMessage ?? "", /Pending/);
});
