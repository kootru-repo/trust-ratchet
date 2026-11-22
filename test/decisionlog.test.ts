// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appendRow, checkAppendOnly, checkLog, checkLogFile, renderRow, type LogRow } from "../src/harness/decisionlog.ts";

const tmp = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-dl-")));
const gitIn = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });

const fixture = (): { repo: string; hash: string; log: string } => {
  const repo = tmp();
  gitIn(repo, "init", "-q");
  fs.writeFileSync(path.join(repo, "a.ts"), "one\ntwo\nthree\n");
  gitIn(repo, "add", "a.ts");
  gitIn(repo, "commit", "-q", "-m", "first");
  return { repo, hash: gitIn(repo, "rev-parse", "HEAD").trim(), log: path.join(repo, "LOG.md") };
};
const row = (over: Partial<LogRow>): LogRow => ({ id: "s1:1", date: "2026-11-21", decision: "use a median", why: "ranges overlap", evidence: "a.ts", status: "open", ...over });

test("good rows append and the log checks clean; pointers to a commit, a file and a line in range all resolve", () => {
  const { repo, hash, log } = fixture();
  assert.equal(appendRow({ file: log, repo, row: row({}) }).ok, true);
  assert.equal(appendRow({ file: log, repo, row: row({ id: "s1:2", evidence: `commit:${hash}` }) }).ok, true);
  assert.equal(appendRow({ file: log, repo, row: row({ id: "s1:3", evidence: "a.ts:2-3" }) }).ok, true);
  assert.deepEqual(checkLogFile({ file: log, repo }), []);
});

test("a planted row with a dead pointer is reported, and is refused by append", () => {
  const { repo, log } = fixture();
  const text = `| id | date | decision | why | evidence | status |\n|---|---|---|---|---|---|\n${renderRow(row({ evidence: "missing.ts" }))}\n${renderRow(row({ id: "s1:2", evidence: "a.ts:9" }))}\n${renderRow(row({ id: "s1:3", evidence: "abcdef1234" }))}\n`;
  const problems = checkLog({ text, repo });
  assert.equal(problems.length, 3);
  assert.match(problems[0]?.problem ?? "", /no such file/);
  assert.match(problems[1]?.problem ?? "", /outside 1-/);
  assert.match(problems[2]?.problem ?? "", /no such commit/);
  const r = appendRow({ file: log, repo, row: row({ evidence: "nope.md" }) });
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(log), false);
});

test("a planted edit of an old row is reported; a pure append is not", () => {
  const { repo, log } = fixture();
  appendRow({ file: log, repo, row: row({}) });
  const previous = fs.readFileSync(log, "utf8");
  fs.writeFileSync(log, previous.replace("use a median", "use a mean"));
  const problems = checkLogFile({ file: log, repo, previous });
  assert.equal(problems.length, 1);
  assert.match(problems[0]?.problem ?? "", /changed/);
  assert.deepEqual(checkAppendOnly({ previous, next: `${previous}${renderRow(row({ id: "s1:2" }))}\n` }), []);
  assert.match(checkAppendOnly({ previous, next: previous.split("\n").slice(0, 2).join("\n") })[0]?.problem ?? "", /removed/);
});

test("a row with five cells, a cell starting with = unquoted, and a second session with no start row are each reported", () => {
  const { repo } = fixture();
  const head = "| id | date | decision | why | evidence | status |\n|---|---|---|---|---|---|\n";
  assert.match(checkLog({ text: `${head}| s1:1 | 2026-11-21 | d | w | a.ts |\n`, repo })[0]?.problem ?? "", /5 cells/);
  assert.match(checkLog({ text: `${head}${renderRow(row({ why: "=SUM(A1)" }))}\n`, repo })[0]?.problem ?? "", /starts with =/);
  assert.equal(checkLog({ text: `${head}${renderRow(row({ why: "\"=SUM(A1)\"" }))}\n`, repo }).length, 0);
  const second = `${head}${renderRow(row({}))}\n${renderRow(row({ id: "s2:1" }))}\n`;
  assert.match(checkLog({ text: second, repo })[0]?.problem ?? "", /no earlier start row/);
  const started = `${head}${renderRow(row({}))}\n${renderRow(row({ id: "s1:2", decision: "start s2" }))}\n${renderRow(row({ id: "s2:1" }))}\n`;
  assert.deepEqual(checkLog({ text: started, repo }), []);
});

test("a bad header is reported", () => {
  const { repo } = fixture();
  assert.match(checkLog({ text: "| id | when |\n|---|---|\n", repo })[0]?.problem ?? "", /header/);
});
