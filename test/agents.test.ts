// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { agentFiles, appendEvent, fold, parseEvent, readLedger, running, withEdit, withStart, withStop, type Ledger } from "../src/harness/agents.ts";
import { handle } from "../src/harness/hook.ts";
import { EVENTS } from "../src/harness/install.ts";
import { sessionDir } from "../src/harness/session.ts";
import { setSwitch } from "../src/harness/state.ts";

const tmp = (name: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ratchet-${name}-`)));
const gitIn = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
const put = (repo: string, file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};
const newRepo = (): string => {
  const repo = tmp("agents");
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, "a.ts", "export const a = 1;\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  return repo;
};
const empty: Ledger = { agents: {}, own: {} };

test("an edit with an agent id is the agent's, one without is the session's own", () => {
  let l = withEdit(empty, { file: "a.ts", now: 10 });
  l = withEdit(l, { file: "b.ts", agentId: "ag1", agentType: "general-purpose", now: 20 });
  l = withEdit(l, { file: "b.ts", agentId: "ag1", now: 30 });
  l = withEdit(l, { file: "a.ts", now: 40 });
  assert.deepEqual(l.own, { "a.ts": 40 });
  assert.deepEqual(l.agents.ag1, { started: 20, files: ["b.ts"], type: "general-purpose" });
});

test("at its stop, an agent also owns what changed while it ran that the session did not write itself", () => {
  let l = withEdit(empty, { file: "own-before.ts", now: 5 });
  l = withStart(l, { agentId: "ag1", agentType: "worker", now: 100, changed: [{ file: "own-before.ts", hash: "h1" }, { file: "same.ts", hash: "s" }] });
  l = withEdit(l, { file: "edited.ts", agentId: "ag1", now: 110 });
  l = withEdit(l, { file: "mine.ts", now: 120 });
  const changed = [{ file: "own-before.ts", hash: "h1" }, { file: "same.ts", hash: "s" }, { file: "edited.ts", hash: "e" }, { file: "mine.ts", hash: "m" }, { file: "by-shell.ts", hash: "b" }];
  assert.deepEqual(agentFiles("ag1", l, changed, 130), ["edited.ts", "by-shell.ts"]);
  assert.equal(running(l, 130).length, 1);
  l = withStop(l, { agentId: "ag1", now: 200, changed });
  assert.deepEqual(l.agents.ag1?.files, ["edited.ts", "by-shell.ts"]);
  assert.equal(l.agents.ag1?.stopped, 200);
  assert.equal(running(l, 210).length, 0);
  assert.deepEqual(withStop(l, { agentId: "ghost", now: 300, changed }), l);
});

test("with two agents at once, neither is given the other's edits, and a shell write is nobody's", () => {
  let l = withStart(empty, { agentId: "A", now: 100, changed: [] });
  l = withStart(l, { agentId: "B", now: 110, changed: [] });
  l = withEdit(l, { file: "a.ts", agentId: "A", now: 120 });
  l = withEdit(l, { file: "b.ts", agentId: "B", now: 130 });
  const changed = [{ file: "a.ts", hash: "1" }, { file: "b.ts", hash: "2" }, { file: "shell.ts", hash: "3" }];
  l = withStop(l, { agentId: "A", now: 200, changed });
  assert.deepEqual(l.agents.A?.files, ["a.ts"]);
  l = withStop(l, { agentId: "B", now: 210, changed });
  assert.deepEqual(l.agents.B?.files, ["b.ts"]);
});

test("an agent whose stop never came stops overlapping later agents once it has expired", () => {
  const hour = 60 * 60 * 1000;
  let l = withStart(empty, { agentId: "ghost", now: 0, changed: [] });
  l = withStart(l, { agentId: "A", now: 5 * hour, changed: [] });
  l = withStop(l, { agentId: "A", now: 5 * hour + 10, changed: [{ file: "x.ts", hash: "1" }] });
  assert.deepEqual(l.agents.A?.files, ["x.ts"]);
});

test("an agent id used again after its stop starts afresh, and one with no stop expires", () => {
  let l = withStart(empty, { agentId: "ag1", now: 0, changed: [] });
  l = withEdit(l, { file: "old.ts", agentId: "ag1", now: 5 });
  l = withStop(l, { agentId: "ag1", now: 10, changed: [{ file: "old.ts", hash: "o" }] });
  l = withStart(l, { agentId: "ag1", now: 1000, changed: [{ file: "old.ts", hash: "o" }] });
  assert.deepEqual({ files: l.agents.ag1?.files, started: l.agents.ag1?.started, stopped: l.agents.ag1?.stopped }, { files: [], started: 1000, stopped: undefined });
  assert.equal(running(l, 1000 + 59 * 60 * 1000).length, 1);
  assert.equal(running(l, 1000 + 61 * 60 * 1000).length, 0);
});

test("the log is read line by line: a torn, foreign or ill-typed line is skipped, never thrown on", () => {
  assert.equal(parseEvent("{not json"), null);
  assert.equal(parseEvent('{"agents":null}'), null);
  assert.equal(parseEvent('{"kind":"start","at":1,"agentId":"x","changed":null}'), null);
  assert.equal(parseEvent('{"kind":"edit","at":"1","file":"a.ts"}'), null);
  assert.deepEqual(parseEvent('{"kind":"edit","at":1,"file":"a.ts","agentId":"x"}'), { kind: "edit", at: 1, file: "a.ts", agentId: "x" });
  assert.deepEqual(fold([{ kind: "start", at: 1, agentId: "x", changed: [] }, { kind: "edit", at: 2, file: "a.ts", agentId: "x" }]).agents.x?.files, ["a.ts"]);
  process.env.RATCHET_HOME = tmp("home");
  const repo = newRepo();
  appendEvent("s9", repo, { kind: "edit", at: 1, file: "a.ts" });
  fs.appendFileSync(path.join(sessionDir("s9"), fs.readdirSync(sessionDir("s9"))[0] ?? "x"), '{"kind":"edit","at":2,"fi\n');
  appendEvent("s9", repo, { kind: "edit", at: 3, file: "b.ts", agentId: "ag" });
  const ledger = readLedger("s9", repo);
  assert.deepEqual(ledger.own, { "a.ts": 1 });
  assert.deepEqual(ledger.agents.ag?.files, ["b.ts"]);
});

test("the hooks record a subagent's edits, the session's own and its start and stop, even when it starts before any edit", () => {
  process.env.RATCHET_HOME = tmp("home");
  delete process.env.RATCHET_CHILD;
  const repo = newRepo();
  setSwitch({ root: repo, enabled: true });
  handle("SubagentStart", { session_id: "s1", cwd: repo, agent_id: "ag1", agent_type: "worker" });
  assert.equal(running(readLedger("s1", repo), Date.now()).length, 1);
  put(repo, "b.ts", "export const b = 2;\n");
  handle("PostToolUse", { session_id: "s1", cwd: repo, tool_name: "Write", tool_input: { file_path: path.join(repo, "b.ts") }, agent_id: "ag1", agent_type: "worker" });
  put(repo, "a.ts", "export const a = 3;\n");
  handle("PostToolUse", { session_id: "s1", cwd: repo, tool_name: "Edit", tool_input: { file_path: path.join(repo, "a.ts") } });
  put(repo, "c.ts", "export const c = 4;\n");
  let ledger = readLedger("s1", repo);
  assert.deepEqual(Object.keys(ledger.own), ["a.ts"]);
  assert.deepEqual(ledger.agents.ag1?.files, ["b.ts"]);
  handle("SubagentStop", { session_id: "s1", cwd: repo, agent_id: "ag1" });
  ledger = readLedger("s1", repo);
  assert.deepEqual(ledger.agents.ag1?.files, ["b.ts", "c.ts"]);
  assert.equal(typeof ledger.agents.ag1?.stopped, "number");
  assert.deepEqual(EVENTS.filter((e) => e.event.startsWith("Subagent")).map((e) => [e.event, e.timeout]), [["SubagentStart", 30], ["SubagentStop", 30]]);
});
