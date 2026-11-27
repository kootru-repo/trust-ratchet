// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { callerWorkflow, otherLock, parseLsRemote, planCi, readNodeVersion, rulesetJson } from "../src/harness/ciinit.ts";
import { harnessCli, HARNESS_COMMANDS } from "../src/harness/cli.ts";

const tmp = (name: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ratchet-${name}-`)));
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
const SHA = "0123456789abcdef0123456789abcdef01234567";

test("the plan takes the package with a test script, the root first, then the shallowest, and its lint and type-check scripts", () => {
  const plan = planCi({ packages: [{ dir: "app/web", scripts: { test: "vitest" }, hasLock: true }, { dir: "app/ts", scripts: { test: "node --test", check: "tsc --noEmit", lint: "biome check ." }, hasLock: true }, { dir: ".", scripts: { test: 'echo "Error: no test specified" && exit 1' }, hasLock: false }] });
  assert.deepEqual(plan, { workingDirectory: "app/ts", nodeVersion: "22", os: ["ubuntu-latest"], install: "npm ci", lint: "npm run -s lint", check: "npm run -s check", test: "npm test" });
  assert.equal(planCi({ packages: [{ dir: ".", scripts: { build: "tsc" }, hasLock: false }] }), null);
  assert.equal(planCi({ packages: [{ dir: ".", scripts: { test: "jest", "check-types": "tsc" }, hasLock: false }], nodeVersion: "20", os: ["windows-latest"] })?.install, "npm install");
});

test("the caller pins the gate to a commit, keeps ci-ok, and the ruleset requires ci-ok with no bypass", () => {
  const plan = planCi({ packages: [{ dir: ".", scripts: { test: "node --test", lint: "eslint ." }, hasLock: true }], os: ["ubuntu-latest", "windows-latest"] });
  assert.ok(plan);
  const yml = callerWorkflow({ plan, sha: SHA, tag: "v0.2.0" });
  assert.match(yml, /uses: kootru-repo\/trust-ratchet\/\.github\/workflows\/gate\.yml@0123456789abcdef0123456789abcdef01234567 # v0\.2\.0/);
  assert.match(yml, /os-matrix: "\[\\"ubuntu-latest\\",\\"windows-latest\\"\]"/);
  assert.match(yml, /lint-command: "npm run -s lint"/);
  assert.match(yml, /ci-ok:\n {4}if: always\(\)\n {4}needs: \[gate\]/);
  const rules = JSON.parse(rulesetJson()) as { bypass_actors: unknown[]; rules: { type: string; parameters?: { required_status_checks: { context: string }[] } }[] };
  assert.deepEqual(rules.bypass_actors, []);
  assert.deepEqual(rules.rules.map((r) => r.type), ["deletion", "non_fast_forward", "required_status_checks"]);
  assert.deepEqual(rules.rules[2]?.parameters?.required_status_checks[0], { context: "ci-ok", integration_id: 15368 });
  assert.match(yml, /^on:\n {2}push:\n {2}pull_request:\n {2}merge_group:\n/m);
});

test("ratchet ci init writes the caller with the commit given, refuses without a test script or over an existing file, and pushes nothing", () => {
  process.env.RATCHET_HOME = tmp("home");
  assert.ok(HARNESS_COMMANDS.has("ci"));
  const repo = tmp("ci");
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, "package.json", JSON.stringify({ scripts: { build: "tsc" } }));
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  assert.match(said(() => harnessCli(["ci", "init", "--project", repo, "--ref", SHA, "--skip-ref-check"], SOURCE)).text, /No package\.json with a test script/);
  put(repo, "app/package.json", JSON.stringify({ scripts: { test: "node --test", typecheck: "tsc" } }));
  put(repo, "app/package-lock.json", "{}");
  put(repo, ".nvmrc", "v20.11.1\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "app");
  assert.equal(said(() => harnessCli(["ci", "init", "--project", repo, "--ref", "nope", "--skip-ref-check"], SOURCE)).value, 1);
  const out = said(() => harnessCli(["ci", "init", "--project", repo, "--ref", SHA, "--tag", "v0.2.0", "--os", "ubuntu-latest,macos-latest", "--skip-ref-check"], SOURCE));
  assert.equal(out.value, 0);
  const yml = fs.readFileSync(path.join(repo, ".github/workflows/ci.yml"), "utf8");
  assert.match(yml, /working-directory: "app"/);
  assert.match(yml, /node-version: "20\.11\.1"/);
  assert.match(yml, /check-command: "npm run -s typecheck"/);
  assert.match(out.text, /gh api repos\/\{owner\}\/\{repo\}\/rulesets -X POST --input/);
  assert.match(out.text, /Nothing was committed or pushed/);
  assert.equal(gitIn(repo, "log", "--oneline").trim().split("\n").length, 2);
  assert.equal(said(() => harnessCli(["ci", "init", "--project", repo, "--ref", SHA, "--skip-ref-check"], SOURCE)).value, 1);
});

// In the development repository the shipped copy is under public/; in the public repository it is the only copy.
test("the gate the self-test calls is the same file the public repository ships", { skip: !fs.existsSync(path.join(SOURCE, "public/.github/workflows/gate.yml")) }, () => {
  assert.equal(fs.readFileSync(path.join(SOURCE, ".github/workflows/gate.yml"), "utf8"), fs.readFileSync(path.join(SOURCE, "public/.github/workflows/gate.yml"), "utf8"));
});

test("review of B1: ls-remote lines, Node versions, other lock files, the note for a hand-given commit, and --force", () => {
  const a = "1111111111111111111111111111111111111111";
  const b = "2222222222222222222222222222222222222222";
  assert.equal(parseLsRemote(`${a}\trefs/tags/v1\n${b}\trefs/tags/v1^{}\n`), b);
  assert.equal(parseLsRemote(`${a}\trefs/tags/v1\n`), a);
  assert.equal(parseLsRemote(""), null);
  assert.equal(otherLock(["app/pnpm-lock.yaml"], "app"), "pnpm-lock.yaml");
  assert.equal(otherLock(["yarn.lock", "app/package-lock.json"], "app"), null);
  const repo = tmp("ci2");
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, "package.json", JSON.stringify({ scripts: { test: "node --test" } }));
  put(repo, ".nvmrc", "lts/*\n");
  put(repo, "yarn.lock", "");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  assert.equal(readNodeVersion(repo), undefined);
  assert.match(said(() => harnessCli(["ci", "init", "--project", repo, "--ref", SHA, "--skip-ref-check"], SOURCE)).text, /yarn.lock is there/);
  fs.rmSync(path.join(repo, "yarn.lock"));
  gitIn(repo, "commit", "-q", "-am", "npm");
  assert.equal(said(() => harnessCli(["ci", "init", "--project", repo, "--ref", SHA, "--skip-ref-check"], SOURCE)).value, 0);
  assert.match(fs.readFileSync(path.join(repo, ".github/workflows/ci.yml"), "utf8"), /@0123456789abcdef0123456789abcdef01234567 # 0123456789ab$/m);
  assert.equal(said(() => harnessCli(["ci", "init", "--project", repo, "--ref", SHA, "--tag", "v9.9.9", "--skip-ref-check", "--force"], SOURCE)).value, 0);
  assert.match(fs.readFileSync(path.join(repo, ".github/workflows/ci.yml"), "utf8"), /# v9.9.9$/m);
});
