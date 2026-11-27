// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { tryCheck } from "../src/harness/checks.ts";
import { buildCommand, driftOf, generatedCheck, sameContent } from "../src/harness/generated.ts";
import { ensureBaseline } from "../src/harness/session.ts";
import { projectFile, writeJson } from "../src/harness/state.ts";
import { runTurn } from "../src/harness/turn.ts";

process.env.RATCHET_CHILD = "";
const tmp = (name: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ratchet-${name}-`)));
process.env.RATCHET_HOME = tmp("gen-home");
const gitIn = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
const put = (repo: string, file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};
// The "build": upper-cases every file of src/ into the folder it is given, a .js for each .src, under js/ for nested ones.
const BUILD = "const fs=require('fs'),p=require('path');const out=process.argv[2];for(const f of fs.readdirSync('src')){const to=p.join(out,f.startsWith('n-')?'js':'',f.replace('.src','.js'));fs.mkdirSync(p.dirname(to),{recursive:true});fs.writeFileSync(to,fs.readFileSync(p.join('src',f),'utf8').toUpperCase())}\n";
const SPEC = { build: "node build.cjs {out}", into: "static" };
const repoWith = (files: Record<string, string>): string => {
  const repo = tmp("gen");
  gitIn(repo, "init", "-q", "-b", "main");
  gitIn(repo, "config", "core.autocrlf", "false");
  for (const [f, text] of Object.entries({ "build.cjs": BUILD, ...files })) put(repo, f, text);
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  return repo;
};

test("drift: a built file missing or different, CR LF equal to LF for text only, and committed files of a built kind no longer made", () => {
  const built = new Map([["a.js", Buffer.from("A\n")], ["b.js", Buffer.from("B\n")], ["c.js", Buffer.from("C\n")]]);
  const have: Record<string, Buffer> = { "a.js": Buffer.from("A\r\n"), "b.js": Buffer.from("old\n") };
  assert.deepEqual(driftOf({ built, committed: (rel) => have[rel] ?? null, committedFiles: ["a.js", "b.js", "old.js", "site.css"] }), { missing: ["c.js"], differ: ["b.js"], extra: ["old.js"] });
  assert.equal(sameContent(Buffer.from([0x89, 0xff, 1]), Buffer.from([0x89, 0xfe, 1])), false);
  assert.equal(sameContent(Buffer.from([0, 13, 10]), Buffer.from([0, 10])), false);
  assert.equal(sameContent(Buffer.from("x\r\ny"), Buffer.from("x\ny")), true);
});

test("{out} becomes one quoted path, also where the config quoted it, and a build without it is refused", () => {
  assert.equal(buildCommand("tsc --outDir {out}", "C:\\Temp\\my dir"), 'tsc --outDir "C:\\Temp\\my dir"');
  assert.equal(buildCommand('tsc --outDir "{out}"', "/t/a b"), 'tsc --outDir "/t/a b"');
  assert.equal(buildCommand("tsc --outDir '{out}'", "/t/a b"), 'tsc --outDir "/t/a b"');
  assert.equal(buildCommand("tsc -p .", "/t/x"), null);
});

test("the check builds into a temporary folder, never the tree, names the drift, the sources and how to rebuild, and reports a build that writes into the tree", () => {
  const repo = repoWith({ "src/a.src": "hello\n", "src/n-b.src": "nested\n", "static/a.js": "HELLO\n", "static/js/n-b.js": "NESTED\n", "static/old.js": "OLD\n", "static/site.css": "x\n" });
  const first = generatedCheck({ root: repo, files: ["src/a.src"], spec: SPEC });
  assert.equal(first.status, 1);
  assert.match(first.output, /^static\/old\.js: is no longer built from its sources/m);
  assert.doesNotMatch(first.output, /site\.css/);
  fs.rmSync(path.join(repo, "static/old.js"));
  gitIn(repo, "commit", "-q", "-am", "drop old");
  assert.deepEqual(generatedCheck({ root: repo, files: ["src/a.src"], spec: SPEC }), { status: 0, output: "" });
  put(repo, "src/a.src", "changed\n");
  put(repo, "src/c.src", "new\n");
  const out = generatedCheck({ root: repo, files: ["src/a.src", "src/c.src"], spec: SPEC });
  assert.match(out.output, /^static\/a\.js: differs from what its sources build \(sources changed here: src\/a\.src, src\/c\.src\)\. Rebuild with: node build\.cjs static$/m);
  assert.match(out.output, /^static\/c\.js: is built from its sources but missing/m);
  assert.equal(fs.readFileSync(path.join(repo, "static/a.js"), "utf8"), "HELLO\n");
  const intoTree = { build: "node build.cjs static && node -e 0 {out}", into: "static" };
  assert.match(generatedCheck({ root: repo, files: ["src/a.src"], spec: intoTree }).output, /the build changed files in the working tree/);
  gitIn(repo, "checkout", "--", "static");
  fs.rmSync(path.join(repo, "static/c.js"), { force: true });
  assert.equal(tryCheck({ root: repo, check: { name: "g", command: "builtin:generated", when: ["src/**"], from: "src", ...intoTree } }).ok, false);
  assert.equal(generatedCheck({ root: repo, files: [], spec: { build: "node build.cjs static", into: "static" } }).status, 127);
  assert.equal(generatedCheck({ root: repo, files: [], spec: {} }).status, 127);
  assert.match(generatedCheck({ root: repo, files: ["src/a.src"], spec: { build: "node -e 0 {out}", into: "static" } }).output, /the build wrote nothing into \{out\}/);
  assert.match(generatedCheck({ root: repo, files: ["src/a.src"], spec: { build: 'node -e "process.exit(2)" {out}', into: "static" } }).output, /^src\/a\.src: the build of the generated files fails/);
  assert.equal(generatedCheck({ root: repo, files: ["src/a.src"], spec: SPEC, deadline: Date.now() + 500 }).status, 124);
});

test("at a turn end, drift older than the session does not hold; drift after the check passed in the session holds; a hand edit of the output runs it again", () => {
  const stale = repoWith({ "src/a.src": "hello\n", "static/a.js": "STALE\n" });
  writeJson(projectFile(stale, "config.json"), { checks: [{ name: "js-in-sync", command: "builtin:generated", when: ["src/**"], timeoutS: 60, ...SPEC }] });
  const b0 = ensureBaseline("g0", stale).baseline;
  put(stale, "src/a.src", "hello\n\n");
  const old = runTurn({ sessionId: "g0", baseline: b0, stopDeadline: Date.now() + 20000 });
  const oldFinding = old?.findings.find((f) => f.title.startsWith("js-in-sync"));
  assert.equal(oldFinding?.blocking, false);
  assert.match(oldFinding?.detail ?? "", /not known to have passed before this session/);

  const repo = repoWith({ "src/a.src": "hello\n", "static/a.js": "HELLO\n" });
  writeJson(projectFile(repo, "config.json"), { checks: [{ name: "js-in-sync", command: "builtin:generated", when: ["src/**"], timeoutS: 60, ...SPEC }] });
  const { baseline } = ensureBaseline("g1", repo);
  put(repo, "src/a.src", "bye\n");
  put(repo, "static/a.js", "BYE\n");
  assert.equal(runTurn({ sessionId: "g1", baseline, stopDeadline: Date.now() + 20000 })?.outcomes.find((o) => o.name === "js-in-sync")?.status, "pass");
  put(repo, "static/a.js", "BYE, BY HAND\n");
  const hand = runTurn({ sessionId: "g1", baseline, stopDeadline: Date.now() + 20000 });
  const finding = hand?.findings.find((f) => f.title.startsWith("js-in-sync"));
  assert.equal(finding?.blocking, true);
  assert.match(finding?.detail ?? "", /static\/a\.js: differs/);
});
