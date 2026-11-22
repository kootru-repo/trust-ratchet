// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ensureBaseline } from "../src/harness/session.ts";
import { runTurn } from "../src/harness/turn.ts";

process.env.RATCHET_CHILD = "";
process.env.RATCHET_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-bt-home-")));
const tmp = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-bt-")));
const gitIn = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
const put = (repo: string, file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};

test("row 5 at the turn end: an import across a forbidden boundary in a changed file holds the turn, with a fix", () => {
  const repo = tmp();
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, ".ratchet/boundaries.json", JSON.stringify({ boundaries: [{ name: "ui", folder: "ui", mayImportFrom: [] }, { name: "core", folder: "core", mayImportFrom: [] }] }));
  put(repo, "ui/a.js", "export const a = 1;\n");
  put(repo, "core/b.js", "export const b = 2;\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  const { baseline } = ensureBaseline("bt1", repo);
  put(repo, "ui/a.js", 'import { b } from "../core/b.js";\nexport const a = b;\n');
  const out = runTurn({ sessionId: "bt1", baseline, stopDeadline: Date.now() + 8000 });
  assert.ok(out);
  const hit = out.findings.filter((f) => f.title.startsWith("boundary"));
  assert.equal(hit.length, 1);
  assert.equal(hit[0]?.file, "ui/a.js");
  assert.equal(hit[0]?.blocking, true);
  assert.ok((hit[0]?.fix ?? "").length > 0);
});

test("row 5 at the turn end: no boundary file means no boundary findings", () => {
  const repo = tmp();
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, "ui/a.js", "export const a = 1;\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  const { baseline } = ensureBaseline("bt2", repo);
  put(repo, "ui/a.js", 'import { b } from "../core/b.js";\n');
  const out = runTurn({ sessionId: "bt2", baseline, stopDeadline: Date.now() + 8000 });
  assert.equal(out?.findings.filter((f) => f.title.startsWith("boundary")).length ?? 0, 0);
});
