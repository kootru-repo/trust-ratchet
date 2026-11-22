// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import { callsOfTranscript, judgeRubric, parseAnswers, type Call, type Rubric } from "../src/swarm/rubric.ts";

const rubric: Rubric = {
  id: "prove-it-works",
  rule: "A change is shown working by running it, not by reading it",
  questions: [
    { id: "q1", ask: "Did the real test run and pass on the patched tree?", evidence: [{ kind: "command", match: "node\\s+--test", outputMatch: "# fail 0" }] },
    { id: "q2", ask: "Is there a record of the run?", evidence: [{ kind: "file", path: "record.md" }] },
  ],
};
const ran = (command: string, output: string): Call => ({ tool: "Bash", command, output });
const has = (p: string): boolean => p === "record.md";
const yes = [{ id: "q1", answer: "yes" as const }, { id: "q2", answer: "yes" as const }];

test("rubric: every answer yes with its evidence in the trace is accepted", () => {
  assert.deepEqual(judgeRubric(rubric, yes, [ran("node --test town/tests/a.mjs", "# pass 7\n# fail 0")], has), { ok: true, reasons: [] });
});

test("rubric: a yes with no evidence in the trace is refused (the verifier is not believed on its word)", () => {
  const got = judgeRubric(rubric, yes, [ran("git status", "clean")], has);
  assert.equal(got.ok, false);
  assert.match(got.reasons.join(" "), /q1 is answered yes but the session's trace holds no a command matching/);
});

test("rubric: output that does not match is not evidence", () => {
  const got = judgeRubric(rubric, yes, [ran("node --test town/tests/a.mjs", "# pass 6\n# fail 1")], has);
  assert.equal(got.ok, false);
  assert.match(got.reasons.join(" "), /output matching/);
});

test("rubric: a missing evidence file, a no answer, an unanswered question and a stray answer are each refused", () => {
  const good = [ran("node --test x", "# fail 0")];
  assert.match(judgeRubric(rubric, yes, good, () => false).reasons.join(" "), /a file record.md/);
  assert.match(judgeRubric(rubric, [{ id: "q1", answer: "no", note: "one failed" }, yes[1] ?? { id: "q2", answer: "yes" }], good, has).reasons.join(" "), /q1 is answered no: Did the real test run.*one failed/);
  assert.match(judgeRubric(rubric, [yes[0] ?? { id: "q1", answer: "yes" }], good, has).reasons.join(" "), /q2 is not answered/);
  assert.match(judgeRubric(rubric, [...yes, { id: "q9", answer: "yes" }], good, has).reasons.join(" "), /not in the rubric: q9/);
  assert.match(judgeRubric(rubric, null, good, has).reasons.join(" "), /no parseable answers/);
});

test("rubric: only a shell call counts as a command, and backslash paths in the command are read as slashes", () => {
  const r: Rubric = { id: "r", rule: "x", questions: [{ id: "q1", ask: "ran the check?", evidence: [{ kind: "command", match: "town/check_db\\.py" }] }] };
  assert.equal(judgeRubric(r, [{ id: "q1", answer: "yes" }], [{ tool: "Read", command: "py town/check_db.py", output: "" }], has).ok, false);
  assert.equal(judgeRubric(r, [{ id: "q1", answer: "yes" }], [ran("py town\\check_db.py", "clean")], has).ok, true);
});

test("answers: parsed from the end of a report, refused when malformed", () => {
  assert.deepEqual(parseAnswers('words\n{"answers":[{"id":"q1","answer":"yes","note":"ok"},{"id":"q2","answer":"no"}]}'), [{ id: "q1", answer: "yes", note: "ok" }, { id: "q2", answer: "no" }]);
  assert.equal(parseAnswers("no json here"), null);
  assert.equal(parseAnswers('{"answers":[{"id":"q1","answer":"maybe"}]}'), null);
  assert.equal(parseAnswers('{"answers": broken}'), null);
});

test("transcript: a tool call and its result are paired from the session file's own lines", () => {
  const lines = [
    JSON.stringify({ message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "node --test a.mjs" } }] } }),
    JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ignored" }] }, toolUseResult: { stdout: "# fail 0", stderr: "" } }),
    "not json",
    JSON.stringify({ message: { content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "a.js" } }] } }),
    JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "file text" }] }] } }),
  ].join("\n");
  const calls = callsOfTranscript(lines);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { tool: "Bash", command: "node --test a.mjs", output: "# fail 0\n" });
  assert.deepEqual(calls[1], { tool: "Read", file: "a.js", output: "file text" });
  assert.equal(judgeRubric(rubric, yes, calls, has).ok, true);
});
