// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { builtinName, countCr, lfCheck, lfVerdict, parseAttrs, parseIndexEol, runBuiltin } from "../src/harness/builtins.ts";
import { checkCandidates, tryCheck } from "../src/harness/checks.ts";
import { ensureBaseline } from "../src/harness/session.ts";
import { projectFile, writeJson } from "../src/harness/state.ts";
import { runTurn } from "../src/harness/turn.ts";

process.env.RATCHET_CHILD = "";
process.env.RATCHET_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-bi-home-")));
const tmp = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-bi-")));
const gitIn = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
const put = (repo: string, file: string, text: string | Buffer): void => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};
const repoWith = (files: Record<string, string>, autocrlf = "false"): string => {
  const repo = tmp();
  gitIn(repo, "init", "-q", "-b", "main");
  gitIn(repo, "config", "core.autocrlf", autocrlf);
  for (const [f, text] of Object.entries(files)) put(repo, f, text);
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  return repo;
};
const none = { text: "unspecified", eol: "unspecified" };

test("a built-in check is named builtin:<name>, and anything else is a shell command", () => {
  assert.equal(builtinName("builtin:lf"), "lf");
  assert.equal(builtinName(" builtin:lf "), "lf");
  assert.equal(builtinName("npm run -s lint"), null);
  assert.equal(builtinName("builtin:lf && rm x"), null);
  const unknown = runBuiltin({ command: "builtin:nope", root: ".", files: [] });
  assert.equal(unknown.status, 127);
  assert.match(unknown.output, /command not found.*builtin:lf/);
});

test("a file is judged by the form git will store: CR LF fails only when nothing turns it into LF, and binary or eol=crlf files are left alone", () => {
  const crlf = Buffer.from("a\r\nb\r\n");
  assert.equal(lfVerdict({ bytes: Buffer.from("a\nb\n"), attrs: none, autocrlf: "" }), "ok");
  assert.equal(lfVerdict({ bytes: crlf, attrs: none, autocrlf: "" }), "cr");
  assert.equal(lfVerdict({ bytes: crlf, attrs: none, autocrlf: "false" }), "cr");
  assert.equal(lfVerdict({ bytes: Buffer.from("a\rb"), attrs: none, autocrlf: "" }), "cr");
  assert.equal(lfVerdict({ bytes: crlf, attrs: none, autocrlf: "true" }), "ok");
  assert.equal(lfVerdict({ bytes: crlf, attrs: none, autocrlf: "input" }), "ok");
  assert.equal(lfVerdict({ bytes: crlf, attrs: { text: "auto", eol: "unspecified" }, autocrlf: "" }), "ok");
  assert.equal(lfVerdict({ bytes: crlf, attrs: { text: "set", eol: "lf" }, autocrlf: "" }), "ok");
  assert.equal(lfVerdict({ bytes: crlf, attrs: { text: "unspecified", eol: "crlf" }, autocrlf: "" }), "skip");
  assert.equal(lfVerdict({ bytes: crlf, attrs: { text: "unset", eol: "unspecified" }, autocrlf: "" }), "skip");
  assert.equal(lfVerdict({ bytes: Buffer.from([0x50, 0x00, 0x0d, 0x0a]), attrs: none, autocrlf: "" }), "skip");
  // With autocrlf on, a file marked -text is still stored as it is.
  assert.equal(lfVerdict({ bytes: crlf, attrs: { text: "unset", eol: "unspecified" }, autocrlf: "true" }), "skip");
});

test("git check-attr -z output becomes attributes per file", () => {
  const map = parseAttrs("a.ts\0text\0auto\0a.ts\0eol\0lf\0b.bat\0text\0unspecified\0b.bat\0eol\0crlf\0");
  assert.deepEqual(map.get("a.ts"), { text: "auto", eol: "lf" });
  assert.deepEqual(map.get("b.bat"), { text: "unspecified", eol: "crlf" });
});

test("the LF check names each CR LF file with a count and the fix, and respects .gitattributes", () => {
  const repo = repoWith({ ".gitattributes": "*.bat eol=crlf\n*.bin -text\n", "ok.ts": "a\n" });
  put(repo, "bad.ts", "a\r\nb\r\nc\n");
  put(repo, "run.bat", "echo\r\n");
  put(repo, "blob.bin", "x\r\n");
  const out = lfCheck({ root: repo, files: ["ok.ts", "bad.ts", "run.bat", "blob.bin", "gone.ts"] });
  assert.equal(out.status, 1);
  assert.deepEqual(out.output.split("\n").map((l) => l.split(":")[0]), ["bad.ts"]);
  assert.match(out.output, /bad\.ts: 2 lines end in CR LF.*newline="\\n"/);
  assert.deepEqual(lfCheck({ root: repo, files: ["ok.ts", "run.bat"] }), { status: 0, output: "" });
  // core.autocrlf=true stores LF whatever the working copy has.
  const win = repoWith({ "ok.ts": "a\n" }, "true");
  put(win, "w.ts", "a\r\n");
  assert.equal(lfCheck({ root: win, files: ["w.ts"] }).status, 0);
});

test("at the turn end, builtin:lf holds the turn for a CR LF file the session wrote and ignores files it did not touch", () => {
  const repo = repoWith({ "old.ts": "x\r\n", "a.ts": "export const a = 1;\n" });
  writeJson(projectFile(repo, "config.json"), { checks: [{ name: "lf-line-endings", command: "builtin:lf", when: ["**/*.ts"] }] });
  const { baseline } = ensureBaseline("lf1", repo);
  put(repo, "a.ts", "export const a = 1;\r\nexport const b = 2;\r\n");
  const out = runTurn({ sessionId: "lf1", baseline, stopDeadline: Date.now() + 8000 });
  const lf = out?.outcomes.find((o) => o.name === "lf-line-endings");
  assert.equal(lf?.status, "fail");
  const finding = out?.findings.find((f) => f.title.startsWith("lf-line-endings"));
  assert.equal(finding?.blocking, true);
  assert.match(finding?.detail ?? "", /^a\.ts: 2 lines end in CR LF/);
  assert.doesNotMatch(finding?.detail ?? "", /old\.ts/);
  put(repo, "a.ts", "export const a = 1;\nexport const b = 2;\n");
  const fixed = runTurn({ sessionId: "lf1", baseline, stopDeadline: Date.now() + 8000 });
  assert.equal(fixed?.outcomes.find((o) => o.name === "lf-line-endings")?.status, "pass");
});

test("discovery offers builtin:lf unless the config has an LF check, and its trial keeps it only when no covered file is stored with CR", () => {
  const offered = checkCandidates({ files: [], scripts: {}, hasTypescript: () => false, config: {}, offerBuiltins: true });
  assert.deepEqual(offered.map((c) => [c.name, c.command]), [["lf-line-endings", "builtin:lf"]]);
  assert.deepEqual(checkCandidates({ files: [], scripts: {}, hasTypescript: () => false, config: {} }), []);
  for (const mine of [{ name: "lf-line-endings", command: "node tools/check_lf.mjs" }, { name: "eol", command: "builtin:lf" }, { name: "x", command: "node scripts/check_lf.mjs" }]) {
    assert.deepEqual(checkCandidates({ files: [], scripts: {}, hasTypescript: () => false, config: { checks: [mine] }, offerBuiltins: true }), [], mine.name);
  }
  const cand = { name: "lf-line-endings", command: "builtin:lf", when: ["**/*.ts"], from: ".gitattributes" };
  const clean = repoWith({ "a.ts": "x\n", "notes.txt": "y\r\n" });
  assert.equal(tryCheck({ root: clean, check: cand }).ok, true);
  const dirty = repoWith({ "a.ts": "x\r\n" });
  const trial = tryCheck({ root: dirty, check: cand });
  assert.equal(trial.ok, false);
  assert.match(trial.why, /fails it today/);
});

test("review of A2: CR LF already stored stays under text=auto or autocrlf, a bare CR is never converted, and git booleans are read as booleans", () => {
  const crlf = Buffer.from("a\r\nb\r\n");
  assert.equal(lfVerdict({ bytes: crlf, attrs: { text: "auto", eol: "unspecified" }, autocrlf: "", indexEol: "crlf" }), "cr");
  assert.equal(lfVerdict({ bytes: crlf, attrs: none, autocrlf: "true", indexEol: "mixed" }), "cr");
  assert.equal(lfVerdict({ bytes: crlf, attrs: { text: "set", eol: "unspecified" }, autocrlf: "", indexEol: "crlf" }), "ok");
  assert.equal(lfVerdict({ bytes: Buffer.from("a\rb\r"), attrs: { text: "auto", eol: "unspecified" }, autocrlf: "true" }), "cr");
  assert.deepEqual(countCr(Buffer.from("a\r\nb\rc\r\n")), { crlf: 2, bare: 1 });
  assert.deepEqual([...parseIndexEol("i/crlf  w/crlf  attr/text=auto  \tsub dir/é x.md\0i/lf    w/lf    attr/                 \ta.ts\0").entries()], [["sub dir/é x.md", "crlf"], ["a.ts", "lf"]]);
  // In a real repository: stored with CR LF before text=auto was set, then edited, keeps CR LF; autocrlf=yes counts as true.
  const repo = repoWith({ "keep.md": "a\r\n" });
  put(repo, ".gitattributes", "*.md text=auto\n");
  gitIn(repo, "add", ".gitattributes");
  gitIn(repo, "commit", "-q", "-m", "attributes");
  put(repo, "keep.md", "a\r\nb\r\n");
  assert.match(lfCheck({ root: repo, files: ["keep.md"] }).output, /keep\.md: 2 lines end in CR LF/);
  const yes = repoWith({ "ok.ts": "a\n" }, "yes");
  put(yes, "w.ts", "a\r\n");
  assert.equal(lfCheck({ root: yes, files: ["w.ts"] }).status, 0);
  put(yes, "bare.ts", "a\rb\n");
  assert.match(lfCheck({ root: yes, files: ["bare.ts"] }).output, /bare\.ts: 1 bare CR \(a CR with no LF after it\)/);
});

test("review of A2: folders and symbolic links are not judged, and the check stops at its deadline", () => {
  const repo = repoWith({ "a.ts": "x\n" });
  fs.mkdirSync(path.join(repo, "dir.md"));
  put(repo, "target.md", "t\r\n");
  let linked = true;
  try {
    fs.symlinkSync(path.join(repo, "target.md"), path.join(repo, "link.md"));
  } catch {
    linked = false;
  }
  const files = ["dir.md", ...(linked ? ["link.md"] : [])];
  assert.deepEqual(lfCheck({ root: repo, files }), { status: 0, output: "" });
  put(repo, "late.ts", "y\r\n");
  assert.deepEqual(lfCheck({ root: repo, files: ["late.ts"], deadline: Date.now() - 1 }), { status: 124, output: "builtin:lf ran out of time" });
});

test("review of A2: the stored form is read for thousands of files, and a built-in that runs out of time at a turn end is not run, not a failure", () => {
  const files: Record<string, string> = { "keep.md": "a\r\n" };
  for (let i = 0; i < 3000; i += 1) files[`docs/a-fairly-long-folder-name/page-${i}.md`] = "x\n";
  const repo = repoWith(files);
  put(repo, ".gitattributes", "*.md text=auto\n");
  gitIn(repo, "add", ".gitattributes");
  gitIn(repo, "commit", "-q", "-m", "attributes");
  assert.match(lfCheck({ root: repo, files: Object.keys(files) }).output, /^keep\.md: 1 line ends in CR LF/);
  const small = repoWith({ "a.ts": "x\n" });
  writeJson(projectFile(small, "config.json"), { checks: [{ name: "lf-line-endings", command: "builtin:lf", when: ["**/*.ts"], timeoutS: 0 }] });
  const { baseline } = ensureBaseline("lf2", small);
  put(small, "a.ts", "y\r\n");
  const out = runTurn({ sessionId: "lf2", baseline, stopDeadline: Date.now() + 8000 });
  assert.equal(out?.outcomes.find((o) => o.name === "lf-line-endings")?.status, "not-run");
  assert.equal(out?.findings.some((f) => f.title.startsWith("lf-line-endings")), false);
});
