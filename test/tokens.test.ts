import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { countTokens, readSession, renderTokens } from "../src/harness/tokens.ts";

const msg = (id: string, usage: [number, number, number, number], command?: string): string =>
  JSON.stringify({
    type: "assistant",
    message: {
      id,
      usage: { input_tokens: usage[0], output_tokens: usage[1], cache_creation_input_tokens: usage[2], cache_read_input_tokens: usage[3] },
      content: command === undefined ? [{ type: "text", text: "hi" }] : [{ type: "tool_use", name: "Bash", input: { command } }],
    },
  });
const P = ["^npm test", "check-types"];

test("tokens split by kind, verification matched by command", () => {
  const main = [msg("a", [10, 20, 30, 40], "npm test -- x"), msg("b", [1, 2, 3, 4]), msg("c", [5, 5, 0, 0], "ls")].join("\n");
  const r = countTokens({ main, patterns: P });
  assert.equal(r.main.verification, 100);
  assert.equal(r.main.other, 20);
  assert.equal(r.main.total, 120);
  assert.equal(r.main.cacheRead, 44);
  assert.equal(r.main.units, 3);
});

test("a message written over several lines is counted once, with its last usage", () => {
  const main = [msg("a", [1, 1, 0, 0]), msg("a", [10, 10, 0, 0], "npm test")].join("\n");
  const r = countTokens({ main, patterns: P });
  assert.equal(r.main.units, 1);
  assert.equal(r.main.verification, 20);
});

test("subagents are counted apart and together; a command only in a subagent counts as verification", () => {
  const main = msg("a", [100, 0, 0, 0]);
  const sub = [
    { name: "s1.jsonl", text: msg("x", [50, 0, 0, 0], "npm run check-types") },
    { name: "s2.jsonl", text: msg("y", [25, 0, 0, 0]) },
  ];
  const r = countTokens({ main, subagents: sub, patterns: P });
  assert.equal(r.main.verification, 0);
  assert.equal(r.subagents.verification, 50);
  assert.equal(r.withSubagents.total, 175);
  assert.equal(r.verificationShareMain, 0);
  assert.equal(r.verificationShare, 50 / 175);
  const lines = renderTokens(r).join("\n");
  assert.match(lines, /main session: 100/);
  assert.match(lines, /with subagents: 175/);
});

test("unreadable lines are skipped and reported; no assistant message gives no share", () => {
  const r = countTokens({ main: `not json\n${JSON.stringify({ type: "user", message: { content: "hi" } })}`, patterns: P });
  assert.equal(r.skipped, 1);
  assert.equal(r.verificationShare, null);
  assert.match(renderTokens(r).join("\n"), /1 transcript lines could not be read/);
});

test("readSession reads the main transcript and the subagents folder beside it", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-tok-")));
  try {
    fs.writeFileSync(path.join(dir, "sess.jsonl"), msg("a", [1, 0, 0, 0]));
    fs.mkdirSync(path.join(dir, "sess", "subagents"), { recursive: true });
    fs.writeFileSync(path.join(dir, "sess", "subagents", "agent-1.jsonl"), msg("b", [2, 0, 0, 0], "npm test"));
    const s = readSession(fs, path.join, path.join(dir, "sess.jsonl"));
    assert.equal(s.subagents.length, 1);
    assert.equal(countTokens({ main: s.main, subagents: s.subagents, patterns: P }).withSubagents.total, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
