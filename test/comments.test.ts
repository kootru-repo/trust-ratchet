import assert from "node:assert/strict";
import { test } from "node:test";
import { findComments, judgeComments, type CommentsConfig } from "../src/harness/comments.ts";

const ban = { mode: "ban" as const };
const judge = (file: string, content: string, before: string = "", config: CommentsConfig = ban) => judgeComments({ file, content, before: findComments(file, before).map((c) => c.text), config });
const texts = (file: string, content: string): string[] => findComments(file, content).map((c) => c.text);

test("comments: planted faults are reported at the edit and hold the turn (6a.2)", () => {
  const five = ["export const f = (x: number): number => {", "  // add one to x", "  // because the caller counts from zero", "  // and the loop needs it", "  // do not forget", "  // see below", "  return x + 1;", "};"].join("\n");
  const got = judge("town/a.ts", five, "export const f = (x: number): number => x;\n");
  assert.equal(got.length, 1);
  assert.equal(got[0]?.blocking, true);
  assert.match(got[0]?.title ?? "", /5 comment lines added/);
  assert.match(got[0]?.fix ?? "", /Say it in the code: a name, a type, a test\. Then delete the comment\./);
  const excuse = judge("town/b.py", "x = 1  # quick fix for now, safe because the timer fires first\n", "x = 1\n", { mode: "excuses" });
  assert.equal(excuse.length, 1);
  assert.equal(excuse[0]?.blocking, false);
});

test("comments: a comment that claims a constraint gets the other message", () => {
  const got = judge("a.ts", "// do not remove this, talk to Sam before changing it\nexport const x = 1;\n", "export const x = 1;\n");
  assert.match(got[0]?.fix ?? "", /^Encode it as a check \(`ratchet rule add`, or a test\), then delete the comment\.$/);
});

test("comments: in excuses mode an ordinary comment is quiet and an excuse is reported", () => {
  const cfg = { mode: "excuses" as const };
  assert.deepEqual(judge("a.ts", "// returns the sum\nexport const s = 1;\n", "export const s = 1;\n", cfg), []);
  assert.equal(judge("a.ts", "// TODO fix later\nconst s = 1;\n", "const s = 1;\n", cfg).length, 1);
});

test("comments: must not fire when nothing was added, or the comment was already there (moved by an edit around it)", () => {
  const before = "// why this is here\nconst a = 1;\nconst b = 2;\n";
  assert.deepEqual(judge("a.ts", before, before), []);
  assert.deepEqual(judge("a.ts", "const b = 2;\n// why this is here\nconst a = 1;\nconst c = 3;\n", before), []);
});

test("comments: must not fire on the allowed list: licence header, doc comment on an exported name, issue link, prettier-ignore, shebang", () => {
  const ok = ["#!/usr/bin/env node", "// Copyright 2026 Someone. SPDX-License-Identifier: MIT", "", "/** The sum. */", "export const sum = 1;", "// see https://github.com/o/r/issues/12", "// prettier-ignore", "const m = [1,0,0, 0,1,0];"].join("\n");
  assert.deepEqual(judge("a.js", ok, ""), []);
});

test("comments: a doc comment on something that is not exported is charged", () => {
  assert.equal(judge("a.ts", "/** The sum. */\nconst sum = 1;\n", "const sum = 1;\n").length, 1);
});

test("comments: a project's own tags are on its allowed list (for example # op: and {cid: ...})", () => {
  const cfg = { mode: "ban" as const, allow: ["^op:", "\\{cid:"] };
  assert.deepEqual(judge("a.py", "x = sorted(y)  # op: ordering the ids is the rule\nk = 3  # {cid: K12}\n", "x = 1\nk = 2\n", cfg), []);
  assert.equal(judge("a.py", "x = 1  # something else\n", "x = 1\n", cfg).length, 1);
});

test("comments: must not fire on // in a string or URL, # in a string or colour, a docstring, or a regular expression", () => {
  assert.deepEqual(texts("a.ts", 'const u = "https://x.test/a"; const v = \'//no\'; const t = `a // b ${1} # c`;\n'), []);
  assert.deepEqual(texts("a.ts", "const r = /\\/\\/ not a comment/; const q = x / y; const z = a /b/ c;\n").filter((t) => t.startsWith("not")), []);
  assert.deepEqual(texts("a.py", 'colour = "#ff0000"\nother = \'#00ff00\'\n'), []);
  assert.deepEqual(texts("a.py", 'def f():\n    """Says what f does.\n    # not a comment either\n    """\n    return 1\n'), []);
});

test("comments: block comments count line by line, and real ones after code on a line are found", () => {
  assert.deepEqual(texts("a.ts", "/*\n * first\n * second\n */\nconst a = 1; // trailing\n"), ["", "first", "second", "", "trailing"]);
  assert.equal(judge("a.ts", "const a = 1; // trailing remark\n", "const a = 1;\n").length, 1);
});

test("comments: escape hatches are the hatch check's, not charged twice", () => {
  assert.deepEqual(judge("a.ts", `// @ts-${"ignore"}\nconst a: number = 1;\n`, ""), []);
  assert.deepEqual(judge("a.py", "import x  # noqa\n", ""), []);
});

test("comments: off mode, an unknown baseline and other file types charge nothing", () => {
  assert.deepEqual(judge("a.ts", "// new\n", "", { mode: "off" }), []);
  assert.deepEqual(judgeComments({ file: "a.ts", content: "// new\n", before: null, config: ban }), []);
  assert.deepEqual(judge("a.md", "<!-- new -->\n# heading\n", ""), []);
  assert.deepEqual(judge("a.css", "/* new */\n", ""), []);
});

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { takeBaseline } from "../src/harness/session.ts";
import { fileFindings } from "../src/harness/turn.ts";

const gitIn = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
const repoWith = (files: Record<string, string>): string => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-comments-")));
  gitIn(repo, "init", "-q", "-b", "main");
  for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(repo, f), text);
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "start");
  return repo;
};

test("comments: against a real session baseline only what the session added is charged; the old comments of a project full of them are never charged", () => {
  const repo = repoWith({ "a.ts": "// old remark one\nexport const a = 1;\n// old remark two\nexport const b = 2;\n", "dirty.ts": "// kept before the session\nconst d = 1;\n" });
  fs.writeFileSync(path.join(repo, "dirty.ts"), "// kept before the session\nconst d = 1;\n// added before the session began\n");
  const baseline = takeBaseline(repo);
  const cfg: CommentsConfig = { mode: "ban" };
  fs.writeFileSync(path.join(repo, "a.ts"), "// old remark one\nexport const a = 1;\n// old remark two\nexport const b = 2;\n// a new remark\nexport const c = 3;\n");
  fs.writeFileSync(path.join(repo, "dirty.ts"), "// kept before the session\nconst d = 1;\n// added before the session began\n// added by the session\n");
  fs.writeFileSync(path.join(repo, "fresh.ts"), "// all new in a new file\nexport const f = 1;\n");
  const on = (file: string) => fileFindings({ baseline, file, rules: [], comments: cfg }).findings.filter((f) => f.kind === "comment");
  assert.equal(on("a.ts").length, 1);
  assert.match(on("a.ts")[0]?.title ?? "", /1 comment line added \(line 5\)/);
  assert.equal(on("dirty.ts").length, 1, "the comment already in the dirty file at the baseline is not charged, the new one is");
  assert.match(on("dirty.ts")[0]?.title ?? "", /1 comment line added \(line 4\)/);
  assert.equal(on("fresh.ts").length, 1);
  const off = fileFindings({ baseline, file: "a.ts", rules: [], comments: { mode: "off" } });
  assert.equal(off.findings.filter((f) => f.kind === "comment").length, 0);
  assert.ok(!off.ran.some((r) => r.startsWith("comments")), "the check is not listed as run while it is off");
  assert.ok(fileFindings({ baseline, file: "a.ts", rules: [], comments: cfg }).ran.includes("comments (ban)"));
});

test("comments: a baseline taken before the check existed charges nothing for a dirty file (not known is never guilty)", () => {
  const repo = repoWith({ "a.ts": "const a = 1;\n" });
  fs.writeFileSync(path.join(repo, "a.ts"), "// existing\nconst a = 1;\n");
  const baseline = takeBaseline(repo);
  const dirty = baseline.dirty["a.ts"];
  assert.ok(dirty);
  delete dirty.comments;
  fs.writeFileSync(path.join(repo, "a.ts"), "// existing\n// another\nconst a = 1;\n");
  assert.deepEqual(fileFindings({ baseline, file: "a.ts", rules: [], comments: { mode: "ban" } }).findings.filter((f) => f.kind === "comment"), []);
});
