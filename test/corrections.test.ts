import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runAuto, type RecordFile } from "../src/harness/auto.ts";
import { fixFromCorrection, looksLikeCorrection, noteCorrection, pendingCorrections, sides } from "../src/harness/corrections.ts";
import { handle } from "../src/harness/hook.ts";
import { projectDir, projectFile, writeJson } from "../src/harness/state.ts";
import { readRules } from "../src/harness/turn.ts";

// The hook stays silent inside a child of the harness; these tests drive it directly, also when the loop runs them.
process.env.RATCHET_CHILD = "";
const tmp = (name: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ratchet-${name}-`)));
const gitIn = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
const put = (repo: string, file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};
const SESSION = "0a1b2c3d-1111-2222-3333-444455556666";
const bad = (n: string): string => `import subprocess\ndef go():\n    return subprocess.run(["${n}"], capture_output=True, text=True)\n`;
const good = (n: string): string => `import subprocess\ndef go():\n    return subprocess.run(["${n}"], capture_output=True, text=True, encoding="utf-8")\n`;
const repoWith = (): string => {
  const repo = tmp("corr");
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, "tools/a.py", bad("a"));
  put(repo, "tools/b.py", bad("b"));
  put(repo, "tools/plain.py", "import subprocess\n" + 'subprocess.run(["x"], capture_output=True)\n'.repeat(30));
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "add");
  return repo;
};

test("a prompt is read as a correction by its wording, and a command or a pasted block is not", () => {
  for (const yes of ["No, that is the wrong file", "I asked u to solution all weak", "You are asking me for options, and i gave u the lessons", "dont touch the brain package", "Why did you delete the test", "That's not what I meant", "please redo it, you forgot the encoding"]) assert.equal(looksLikeCorrection(yes), true, yes);
  for (const no of ["Resume work on ratchet", "/goal close all six gaps", "Run ratchet init for dojo", "<pasted_content>no</pasted_content>", "ok", "x".repeat(900)]) assert.equal(looksLikeCorrection(no), false, no);
});

test("the two sides of a diff are read after its header, so a removed line that starts with dashes is kept", () => {
  assert.deepEqual(sides("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1 @@\n--- a rule\n-old\n+new\n"), { removed: ["-- a rule", "old"], added: ["new"] });
});

test("what a session changes after a correction is read as a fix: against the copy for a file with uncommitted work, against the head for the rest", () => {
  process.env.RATCHET_HOME = tmp("home");
  const repo = repoWith();
  // At the moment of the correction: c.py is new and faulty (uncommitted), a.py is as committed.
  put(repo, "tools/c.py", bad("c"));
  const meta = noteCorrection({ root: repo, sessionId: SESSION, prompt: "No, you forgot the encoding.\nsecond line of the prompt", now: "2026-11-20T10:00:00.000Z" });
  assert.deepEqual(meta?.dirty, ["tools/c.py"]);
  assert.equal(meta?.excerpt, "No, you forgot the encoding. second line of the prompt");
  assert.equal(pendingCorrections(repo).length, 1);
  // The session then mends both.
  put(repo, "tools/c.py", good("c"));
  put(repo, "tools/a.py", good("a"));
  const fix = fixFromCorrection({ root: repo, meta: meta as NonNullable<typeof meta> });
  assert.deepEqual(fix.map((f) => f.file).sort(), ["tools/a.py", "tools/c.py"]);
  for (const f of fix) {
    assert.match(f.removed.join("\n"), /text=True\)$/);
    assert.match(f.added.join("\n"), /encoding="utf-8"/);
  }
});

test("the prompt hook says nothing, keeps a correction only where the loop is on, and the loop turns it into a rule on trial once the turn has ended", () => {
  process.env.RATCHET_HOME = tmp("home");
  const repo = repoWith();
  writeJson(path.join(process.env.RATCHET_HOME, "state.json"), { enabled: true, mode: "enforce", projects: {} });
  // The loop is off here: nothing is kept.
  assert.equal(handle("UserPromptSubmit", { session_id: SESSION, cwd: repo, prompt: "No, that is wrong" }), null);
  assert.equal(pendingCorrections(repo).length, 0);
  writeJson(projectFile(repo, "config.json"), { auto: true });
  runAuto({ root: repo });
  put(repo, "tools/c.py", bad("c"));
  assert.equal(handle("UserPromptSubmit", { session_id: SESSION, cwd: repo, prompt: "Resume work" }), null);
  assert.equal(pendingCorrections(repo).length, 0);
  assert.equal(handle("UserPromptSubmit", { session_id: SESSION, cwd: repo, prompt: "No, you forgot the encoding" }), null);
  const [meta] = pendingCorrections(repo);
  assert.equal(meta?.sessionId, SESSION);
  put(repo, "tools/c.py", good("c"));
  // The turn has not ended: the loop waits.
  assert.equal(runAuto({ root: repo }).changes.length, 0);
  assert.equal(pendingCorrections(repo).length, 1);
  const rec: RecordFile = { time: new Date(Date.now() + 1000).toISOString(), sessionId: SESSION, mode: "enforce", held: false, findings: [], outcomes: [] };
  writeJson(path.join(projectDir(repo), "records", "9001.json"), rec);
  const pass = runAuto({ root: repo, now: () => new Date(Date.now() + 2000).toISOString() });
  const rule = readRules(repo).find((r) => r.from === "correction");
  assert.equal(rule?.stage, "trial");
  assert.equal(rule?.origin, "auto");
  assert.match(rule?.proof?.commit ?? "", /^chat /);
  assert.deepEqual(rule?.baseline, { "tools/a.py": 1, "tools/b.py": 1 });
  assert.ok(pass.changes.some((c) => /after a correction given in chat/.test(c.what)));
  // The words of the prompt are nowhere in what a session or the dashboard is given.
  assert.equal(JSON.stringify(pass).includes("forgot"), false);
  assert.equal(fs.readFileSync(path.join(projectDir(repo), "auto-notes.md"), "utf8").includes("forgot"), false);
  assert.equal(pendingCorrections(repo).length, 0);
  // The lesson card's log is off here: the outcome of the correction is kept nowhere.
  assert.equal(fs.existsSync(path.join(projectDir(repo), "corrections.jsonl")), false);
});

test("where written tests are on, the change after a correction is kept for one as two texts per file, without the words of the chat", () => {
  process.env.RATCHET_HOME = tmp("home");
  const repo = repoWith();
  writeJson(path.join(process.env.RATCHET_HOME, "state.json"), { enabled: true, mode: "enforce", projects: {} });
  writeJson(projectFile(repo, "config.json"), { auto: true, autoGuards: true, lessonsLog: true });
  runAuto({ root: repo, memory: () => 10 });
  put(repo, "tools/c.py", bad("c"));
  handle("UserPromptSubmit", { session_id: SESSION, cwd: repo, prompt: "No, you forgot the SECRETWORD encoding" });
  put(repo, "tools/c.py", good("c"));
  const rec: RecordFile = { time: new Date(Date.now() + 1000).toISOString(), sessionId: SESSION, mode: "enforce", held: false, findings: [], outcomes: [] };
  writeJson(path.join(projectDir(repo), "records", "9001.json"), rec);
  runAuto({ root: repo, memory: () => 10, now: () => new Date(Date.now() + 2000).toISOString() });
  // The lesson card's log is on here: the outcome is kept as one line, with no word of the chat.
  const kept = fs.readFileSync(path.join(projectDir(repo), "corrections.jsonl"), "utf8");
  assert.equal(kept.trim().split(/\r?\n/).length, 1);
  assert.match(kept, /"outcome":"rule written, kept for a written test"/);
  assert.equal(kept.includes("SECRETWORD"), false);
  const dir = path.join(projectDir(repo), "guard-jobs");
  const names = fs.readdirSync(dir);
  assert.equal(names.length, 1);
  const text = fs.readFileSync(path.join(dir, names[0] ?? ""), "utf8");
  const job = JSON.parse(text) as { files: { file: string; before: string; after: string }[] };
  assert.deepEqual(job.files.map((f) => f.file), ["tools/c.py"]);
  assert.equal(job.files[0]?.before, bad("c"));
  assert.equal(job.files[0]?.after, good("c"));
  assert.equal(text.includes("SECRETWORD"), false);
  assert.equal(text.includes("forgot"), false);
});
