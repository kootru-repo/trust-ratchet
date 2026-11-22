// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { historyOutcomes, renderVerdict, verdict } from "../src/harness/outcomes2.ts";

const tmp = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-o17-")));
const gitIn = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
const commitFile = (repo: string, file: string, text: string, message: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
  gitIn(repo, "add", file);
  gitIn(repo, "commit", "-q", "-m", message);
};

test("fix share, fixes of a fix and reverts are computed from a fixture repository, per program", () => {
  const repo = tmp();
  gitIn(repo, "init", "-q");
  commitFile(repo, "app/a.ts", "export const a = 1;\n", "add a");
  commitFile(repo, "app/a.ts", "export const a = 2;\n", "fix crash in a");
  commitFile(repo, "app/a.ts", "export const a = 3;\n", "fix a again");
  commitFile(repo, "lib/b.ts", "export const b = 1;\n", "add b");
  commitFile(repo, "lib/b.ts", "export const b = 2;\n", "Revert \"add b\"");
  const all = historyOutcomes({ repo });
  assert.equal(all.n, 5);
  assert.equal(all.fixes, 2);
  assert.equal(all.fixOfFix, 1);
  assert.equal(all.reverts, 1);
  assert.equal(all.fixShare, 0.4);
  assert.equal(all.revertShare, 0.2);
  const app = historyOutcomes({ repo, program: "app" });
  assert.deepEqual({ n: app.n, fixes: app.fixes, reverts: app.reverts }, { n: 3, fixes: 2, reverts: 0 });
});

test("a repository with no commits in scope gives n 0 and no share, never a number", () => {
  const repo = tmp();
  gitIn(repo, "init", "-q");
  commitFile(repo, "x.ts", "1;\n", "add x");
  const none = historyOutcomes({ repo, program: "nothing-here" });
  assert.equal(none.n, 0);
  assert.equal(none.fixShare, null);
  assert.equal(none.revertShare, null);
});

test("a planted slowdown reads slower, a faster candidate faster, equal sets no measurable difference", () => {
  const clean = [100, 102, 99, 101, 100, 103];
  const slow = [140, 142, 139, 141, 140, 143];
  const fast = [60, 62, 59, 61, 60, 63];
  assert.equal(verdict({ base: clean, candidate: slow }).word, "slower");
  assert.equal(verdict({ base: clean, candidate: fast }).word, "faster");
  const same = verdict({ base: clean, candidate: [101, 100, 102, 99, 103, 100] });
  assert.equal(same.word, "no measurable difference");
  assert.equal(same.nBase, 6);
  assert.equal(same.medianBase, 100.5);
  assert.deepEqual(same.rangeBase, { min: 99, max: 103 });
});

test("a gap smaller than the run-to-run range is no measurable difference, even when the medians differ", () => {
  const noisy = [80, 120, 100, 90, 110];
  const shifted = [85, 125, 105, 95, 115];
  const v = verdict({ base: noisy, candidate: shifted });
  assert.equal(v.word, "no measurable difference");
  assert.equal(v.gap, 5);
  assert.equal(v.variation, 40);
});

test("fewer than 5 runs a side, an error, or a missing number is inconclusive and says so with n", () => {
  const ok = [1, 2, 3, 4, 5];
  assert.equal(verdict({ base: [1, 2, 3, 4], candidate: ok }).word, "inconclusive");
  assert.equal(verdict({ base: ok, candidate: ok, errors: 1 }).word, "inconclusive");
  assert.equal(verdict({ base: ok, candidate: [1, 2, 3, 4, Number.NaN] }).word, "inconclusive");
  const line = renderVerdict("frame ms", verdict({ base: [1, 2], candidate: ok }));
  assert.match(line, /inconclusive \(n 2 and 5\)/);
  assert.match(renderVerdict("frame ms", verdict({ base: [100, 101, 100, 102, 100], candidate: [150, 151, 150, 152, 150] })), /slower \(n 5 and 5;/);
});
