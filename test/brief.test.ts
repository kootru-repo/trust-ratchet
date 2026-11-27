// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { briefText, redact } from "../src/harness/brief.ts";
import { codeqlWorkflow, withBlameIgnore } from "../src/harness/ciinit.ts";
import { harnessCli } from "../src/harness/cli.ts";

const tmp = (name: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ratchet-${name}-`)));
const SOURCE = path.resolve(import.meta.dirname, "..");
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
const SHA = "0123456789abcdef0123456789abcdef01234567";

test("the brief carries the house rules, the protected paths, how to rebuild generated files, the checks and the rules", () => {
  const text = briefText({
    config: { checks: [{ name: "fx", command: "builtin:protected", when: ["test/fixtures/**"] }, { name: "js", command: "builtin:generated", when: ["web/src/**"], build: "cd web && tsc --outDir {out}", into: "static" }, { name: "types", command: "npx tsc --noEmit" }, { name: "lf", command: "builtin:lf" }] },
    rules: [{ id: "no-shared-config", kind: "ban-pattern", pattern: "\bC\.", files: ["src/**"], message: "The shared config is gone.", fix: "Take the config you were given." }],
  });
  assert.match(text, /LF line endings/);
  assert.match(text, /Never change these recorded references: test\/fixtures\/\*\*/);
  assert.match(text, /Files under static are built from web\/src\/\*\*: rebuild them with cd web && tsc --outDir static/);
  assert.match(text, /types: npx tsc --noEmit/);
  assert.doesNotMatch(text, /lf: builtin:lf/);
  assert.match(text, /no-shared-config: The shared config is gone\. Fix: Take the config you were given\./);
  assert.doesNotMatch(briefText({ config: {}, rules: [] }), /recorded references|Project rules|run these/);
});

test("ci codeql writes a pinned workflow outside ci-ok, ci blame-ignore lists a commit once, and status --brief prints the brief", () => {
  process.env.RATCHET_HOME = tmp("home");
  const repo = tmp("d4");
  execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
  const yml = codeqlWorkflow();
  for (const m of yml.matchAll(/uses: (\S+)/g)) assert.match(m[1] ?? "", /@[0-9a-f]{40}$/);
  assert.equal(said(() => harnessCli(["ci", "codeql", "--project", repo], SOURCE)).value, 0);
  assert.equal(fs.readFileSync(path.join(repo, ".github/workflows/codeql.yml"), "utf8"), yml);
  assert.equal(said(() => harnessCli(["ci", "codeql", "--project", repo], SOURCE)).value, 1);
  assert.equal(said(() => harnessCli(["ci", "blame-ignore", "--project", repo, "--commit", "abc"], SOURCE)).value, 1);
  assert.equal(said(() => harnessCli(["ci", "blame-ignore", "--project", repo, "--commit", SHA, "--note", "biome"], SOURCE)).value, 0);
  said(() => harnessCli(["ci", "blame-ignore", "--project", repo, "--commit", SHA], SOURCE));
  const file = fs.readFileSync(path.join(repo, ".git-blame-ignore-revs"), "utf8");
  assert.equal(file.split("\n").filter((l) => l === SHA).length, 1);
  assert.match(file, /# biome\n/);
  assert.equal(withBlameIgnore("x", SHA, "n"), `x\n# n\n${SHA}\n`);
  assert.match(said(() => harnessCli(["status", "--project", repo, "--brief"], SOURCE)).text, /House rules for this repository/);
  assert.doesNotMatch(said(() => harnessCli(["status", "--project", repo], SOURCE)).text, /House rules/);
});

test("review of D4: secrets in commands are left out, incomplete generated entries read well, and blame-ignore takes any case and keeps CR LF", () => {
  const text = briefText({ config: { checks: [{ name: "t", command: "API_TOKEN=abc123 DEBUG='x y' npm test" }, { name: "g", command: "builtin:generated", into: "static" }, { name: "h", command: "builtin:generated" }] }, rules: [] });
  assert.match(text, /t: API_TOKEN=… DEBUG=… npm test/);
  assert.doesNotMatch(text, /abc123|x y/);
  assert.match(text, /- Files under static are built: rebuild them after changing the sources\./);
  assert.equal(text.split("\n").filter((l) => l.includes("Files under")).length, 1);
  assert.equal(redact("cd app && FOO=1 npm run lint"), "cd app && FOO=… npm run lint");
  assert.equal(redact("npm test --token=abc -k=\"x y\" --flag"), "npm test --token=… -k=… --flag");
  const upper = SHA.toUpperCase();
  assert.equal(withBlameIgnore(`# x\r\n${SHA}\r\n`, upper, "again"), `# x\r\n${SHA}\r\n`);
  assert.equal(withBlameIgnore("# x\r\n", upper, "n"), `# x\r\n# n\r\n${SHA}\r\n`);
  assert.match(codeqlWorkflow(), /actions: read\n {6}contents: read\n {6}security-events: write/);
  assert.match(codeqlWorkflow(), /codeql-action\/init@915412ff23e8b7659517e607487dbeae018f2934 # v4\.39\.5/);
  const outside = tmp("nogit");
  assert.match(said(() => harnessCli(["status", "--project", outside, "--brief"], SOURCE)).text, /No git repository here, so there is no brief/);
});
