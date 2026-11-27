// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { allowedByTrailers, ciCheck, parseNameStatus, shellArg } from "../src/harness/cicheck.ts";
import { harnessCli } from "../src/harness/cli.ts";

process.env.RATCHET_CHILD = "";
const tmp = (name: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ratchet-${name}-`)));
process.env.RATCHET_HOME = tmp("ci-home");
const SOURCE = path.resolve(import.meta.dirname, "..");
const gitIn = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
const put = (repo: string, file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};
const said = (fn: () => number): { value: number; text: string } => {
  const lines: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    return { value: fn(), text: lines.join("\n") };
  } finally {
    console.log = log;
  }
};

// A project with its Ratchet config in the repository, as CI sees it.
const project = (): { repo: string; base: string } => {
  const repo = tmp("ci");
  gitIn(repo, "init", "-q", "-b", "main");
  gitIn(repo, "config", "core.autocrlf", "false");
  put(repo, ".ratchet/config.json", JSON.stringify({ checks: [
    { name: "lf", command: "builtin:lf", when: ["**/*.ts"] },
    { name: "fixtures", command: "builtin:protected", when: ["fx/**"] },
    { name: "fails", command: "node -e \"process.exit(3)\"", when: ["never/**"] },
  ] }));
  put(repo, ".ratchet/rules.json", JSON.stringify([{ id: "no-shared-c", kind: "ban-pattern", pattern: "\\bC\\.", files: ["**/*.ts"], message: "The shared config is gone.", fix: "Take the config you are given." }]));
  put(repo, "src/a.ts", "export const a = 1;\n");
  put(repo, "fx/rec.json", "{}\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  return { repo, base: gitIn(repo, "rev-parse", "HEAD").trim() };
};

test("trailer values become protected globs, with / for \\ and no leading ./", () => {
  assert.deepEqual(allowedByTrailers("fx/**\n\n.\\other\\x.json\n"), ["fx/**", "other/x.json"]);
  assert.deepEqual(allowedByTrailers("\n\n"), []);
});

test("a clean change passes, and committed changes since the base meet the file checks, the rules and the built-ins", () => {
  const { repo, base } = project();
  put(repo, "src/b.ts", "export const b = 2;\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "fine");
  assert.deepEqual(ciCheck({ root: repo, base }).findings, []);
  const hatch = ["as", "any"].join(" ");
  put(repo, "src/c.ts", `export const c = C.value ${hatch};\r\n`);
  put(repo, "fx/rec.json", "{\"v\":2}\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "bad");
  const r = ciCheck({ root: repo, base });
  const titles = r.findings.map((f) => `${f.kind}:${f.title}`).join("\n");
  assert.match(titles, /rule:/);
  assert.match(titles, /hatch:/);
  assert.match(titles, /lf fails/);
  assert.match(titles, /fixtures fails/);
  assert.deepEqual(r.ran.sort(), ["fixtures", "lf"]);
  // --checks narrows the project's checks; the file checks always run.
  const only = ciCheck({ root: repo, base, only: ["lf"] });
  assert.deepEqual(only.ran, ["lf"]);
  assert.ok(only.findings.some((f) => f.kind === "rule"));
});

test("a re-record is allowed by a trailer in the range, and the command exits 0, 1 or 2", () => {
  const { repo, base } = project();
  put(repo, "fx/rec.json", "{\"v\":2}\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "Re-record the fixture\n\nRatchet-Allow-Protected: fx/**");
  const r = ciCheck({ root: repo, base });
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.allowed, ["fx/**"]);
  assert.equal(said(() => harnessCli(["check", "--project", repo, "--base", base], SOURCE)).value, 0);
  put(repo, "src/d.ts", "export const d = C.x;\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "rule broken");
  const failed = said(() => harnessCli(["check", "--project", repo, "--base", base], SOURCE));
  assert.equal(failed.value, 1);
  assert.match(failed.text, /The shared config is gone/);
  assert.equal(said(() => harnessCli(["check", "--project", repo], SOURCE)).value, 2);
  assert.equal(said(() => harnessCli(["check", "--project", repo, "--base", "no-such-ref"], SOURCE)).value, 2);
});

test("a base that HEAD does not descend from is replaced by the merge base", () => {
  const { repo, base } = project();
  gitIn(repo, "switch", "-q", "-c", "side");
  put(repo, "src/side.ts", "export const s = 1;\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "side");
  gitIn(repo, "switch", "-q", "main");
  put(repo, "src/main.ts", "export const m = 1;\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "main");
  const r = ciCheck({ root: repo, base: "side" });
  assert.equal(r.base, base);
  assert.deepEqual(r.changed, ["src/main.ts"]);
});

test("review of the check: only real trailers allow, deletions and renames of protected files fail, renames keep their hatches, and file names are shell-safe", () => {
  assert.deepEqual(parseNameStatus("M\0src/a.ts\0D\0fx/gone.json\0R100\0fx/rec.json\0moved.json\0A\0new.ts\0"), { deleted: ["fx/gone.json"], renamed: [{ from: "fx/rec.json", to: "moved.json" }] });
  assert.equal(shellArg("a b'c.ts", "linux"), "'a b'\\''c.ts'");
  assert.equal(shellArg('a "b".ts', "win32"), '"a ""b"".ts"');
  const { repo, base } = project();
  put(repo, "fx/two.json", "{}\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "second fixture");
  const base2 = gitIn(repo, "rev-parse", "HEAD").trim();
  gitIn(repo, "commit", "-q", "--allow-empty", "-m", "Explain\n\nRatchet-Allow-Protected: fx/** is written in a sentence, not a trailer.\n\nSigned-off-by: t");
  fs.rmSync(path.join(repo, "fx/two.json"));
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "delete a fixture");
  const del = ciCheck({ root: repo, base: base2 });
  assert.deepEqual(del.allowed, []);
  assert.match(del.findings.map((f) => f.detail).join("\n"), /fx\/two\.json: a protected file changed/);
  const repo2 = project();
  const hatch = ["as", "any"].join(" ");
  put(repo2.repo, "src/h.ts", `export const h = 1 ${hatch};\n`);
  gitIn(repo2.repo, "add", "-A");
  gitIn(repo2.repo, "commit", "-q", "-m", "an old hatch");
  const b3 = gitIn(repo2.repo, "rev-parse", "HEAD").trim();
  gitIn(repo2.repo, "mv", "src/h.ts", "src/moved.ts");
  gitIn(repo2.repo, "mv", "fx/rec.json", "rec.json");
  gitIn(repo2.repo, "commit", "-q", "-m", "move");
  const mv = ciCheck({ root: repo2.repo, base: b3 });
  assert.equal(mv.findings.some((f) => f.kind === "hatch"), false);
  assert.match(mv.findings.map((f) => f.detail).join("\n"), /fx\/rec\.json: a protected file changed/);
  assert.deepEqual(ciCheck({ root: repo2.repo, base: b3, only: [] }).ran.sort(), ["fixtures", "lf"]);
  assert.equal(base.length, 40);
});
