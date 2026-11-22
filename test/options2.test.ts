// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import { escalation, maskDiffComments } from "../src/options.ts";
import { specialistPrompt } from "../src/prompts.ts";

test("S3: comments are hidden in the diff a reviewer is shown, code and headers are kept", () => {
  const diff = ["--- a/x.ts", "+++ b/x.ts", "@@ -1,4 +1,4 @@", " // safe: checked above", "+const u = `http://a/b`; // never null here", "-const v = 1;", " const w = a // b"].join("\n");
  assert.deepEqual(maskDiffComments({ diff, language: "TypeScript" }).split("\n"), ["--- a/x.ts", "+++ b/x.ts", "@@ -1,4 +1,4 @@", " // (comment hidden)", "+const u = `http://a/b`; // (comment hidden)", "-const v = 1;", " const w = a // (comment hidden)"]);
  const py = ["+x = 1  # cannot be None", "+# the caller checks", "+y = '#fff'"].join("\n");
  assert.deepEqual(maskDiffComments({ diff: py, language: "Python" }).split("\n"), ["+x = 1  # (comment hidden)", "+# (comment hidden)", "+y = '#fff'"]);
});

test("S3: the commit message goes to intent only, unless the bias is being measured", () => {
  const base = { file: "x.ts", context: { pkg: ".", importers: [], content: "" }, facts: [], language: "TypeScript", patch: { diff: "+a", message: "THE-MESSAGE" } };
  const spec = (id: string) => ({ id, focus: "f", lookFor: "l" });
  const prompt = (id: string, all: boolean): string => specialistPrompt({ ...base, specialist: spec(id), ...(all ? { messageToAll: true } : {}) });
  assert.match(prompt("intent", false), /THE-MESSAGE/);
  assert.doesNotMatch(prompt("async", false), /THE-MESSAGE/);
  assert.match(prompt("async", true), /THE-MESSAGE/);
});

test("S1: one wrong sampled dismissal sends every other local dismissal to a verifier, none wrong sends nothing", () => {
  const at = (line: number) => ({ cite: { file: "x.ts", line } });
  const local = [at(1), at(2), at(2), at(3), at(4)];
  assert.deepEqual(escalation({ local, verified: [at(1)], anyWrong: false, max: 40 }), []);
  assert.deepEqual(escalation({ local, verified: [at(1)], anyWrong: true, max: 40 }).map((l) => l.cite.line), [2, 3, 4]);
  assert.deepEqual(escalation({ local, verified: [at(1)], anyWrong: true, max: 2 }).map((l) => l.cite.line), [2, 3]);
});
