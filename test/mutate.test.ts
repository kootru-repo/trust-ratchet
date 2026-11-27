// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { literalRanges, mutants, mutate, mutateExit, parses, renderMutate, sample, workspaceWarning } from "../src/mutate.ts";

const tmp = (): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-mut-")));
const gitIn = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
const put = (repo: string, file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};

const SRC = [
  "// a comment with < and 3 is not a mutant",
  "export const clamp = (x, max) => {",
  "  if (x < 0) return null;",
  '  return x >= max ? "max" : x;',
  "};",
  "",
].join("\n");

test("mutants: each operator once per code line, and a one-line guard dropped; comments are left alone", () => {
  const ms = mutants(SRC);
  const seen = ms.map((m) => `${m.line}:${m.what}`);
  assert.deepEqual(seen, ["3:< to <=", "3:constant +1", "3:guard dropped", "4:>= to >"]);
  assert.match(ms.find((m) => m.what === "< to <=")?.text ?? "", /if \(x <= 0\) return null;/);
  assert.match(ms.find((m) => m.what === "constant +1")?.text ?? "", /if \(x < 1\) return null;/);
  assert.deepEqual(sample([1, 2, 3, 4, 5, 6], 3), [1, 3, 5]);
});

test("a strong test catches every break, a weak one is named for what it misses, and the working tree is never touched", () => {
  const repo = tmp();
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, "src/clamp.mjs", SRC);
  const strong = "import assert from 'node:assert/strict'; import { clamp } from '../src/clamp.mjs'; assert.equal(clamp(-1, 5), null); assert.equal(clamp(0, 5), 0); assert.equal(clamp(0.5, 5), 0.5); assert.equal(clamp(5, 5), 'max'); assert.equal(clamp(4, 5), 4);\n";
  put(repo, "test/strong.mjs", strong);
  put(repo, "test/weak.mjs", "import assert from 'node:assert/strict'; import { clamp } from '../src/clamp.mjs'; assert.equal(clamp(9, 5), 'max');\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  const before = fs.readFileSync(path.join(repo, "src/clamp.mjs"), "utf8");
  const good = mutate({ root: repo, file: "src/clamp.mjs", test: "node test/strong.mjs", timeoutS: 60 });
  assert.equal(good.baseline, "pass");
  assert.deepEqual(good.results.map((r) => r.outcome), ["caught", "caught", "caught", "caught"]);
  assert.match(renderMutate("src/clamp.mjs", good), /caught 4 of 4 deliberate breaks\./);
  const weak = mutate({ root: repo, file: "src/clamp.mjs", test: "node test/weak.mjs", timeoutS: 60 });
  const text = renderMutate("src/clamp.mjs", weak);
  assert.match(text, /It missed:\n {2}line 3: < to <=/);
  assert.match(text, /add a test that fails for it/);
  assert.equal(fs.readFileSync(path.join(repo, "src/clamp.mjs"), "utf8"), before);
  assert.equal(gitIn(repo, "status", "--porcelain"), "");
  const broken = mutate({ root: repo, file: "src/clamp.mjs", test: "node -e \"process.exit(1)\"", timeoutS: 60 });
  assert.equal(broken.baseline, "fail");
  assert.match(renderMutate("src/clamp.mjs", broken), /fails on the unbroken copy/);
});

test("the copy links node_modules and removing it leaves the real folder whole", () => {
  const repo = tmp();
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, "src/a.mjs", "export const a = 1 < 2;\n");
  put(repo, "node_modules/dep/index.mjs", "export const dep = true;\n");
  put(repo, ".gitignore", "node_modules\n");
  put(repo, "t.mjs", "import { dep } from './node_modules/dep/index.mjs'; import { a } from './src/a.mjs'; if (!dep || !a) process.exit(1);\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  const r = mutate({ root: repo, file: "src/a.mjs", test: "node t.mjs", timeoutS: 60 });
  assert.equal(r.baseline, "pass");
  assert.ok(r.results.some((x) => x.outcome === "caught"));
  assert.equal(fs.existsSync(path.join(repo, "node_modules/dep/index.mjs")), true);
});

test("review of D2: literals are never broken, every match on a line counts, breaks that do not parse are skipped, and exit codes say what happened", () => {
  const line = 'const xs: Array<string> = []; if (a < b && s === "limit < 3") x = /\d{2}/.test(t);';
  const ms = mutants(`${line}\n`);
  const whats = ms.map((m) => m.what);
  assert.ok(whats.includes("< to <="));
  assert.ok(ms.some((m) => m.text.includes("a <= b")), "the real a < b is broken");
  assert.ok(ms.every((m) => m.text.includes('"limit < 3"') && m.text.includes("/\d{2}/")), "strings and regular expressions stay as they were");
  assert.deepEqual(literalRanges('f("a<b", /x{2}/, `t`) // c < d').map(([a, b]) => [a, b]), [[2, 7], [9, 15], [17, 20], [22, 30]]);
  assert.equal(parses("x.ts", "const a: Array<string> = [];\n"), true);
  assert.equal(parses("x.ts", "const a: Array<=string> = [];\n"), false);
  assert.equal(parses("e.ts", "enum E { A = 1 }\nexport const b = E.A < 2;\n"), true);
  assert.equal(parses("e.ts", "enum E { A = 1 }\nexport const b = E.A <= ;\n"), false);
  assert.equal(parses("x.mjs", "export const a = 1 <= 2;\n"), true);
  assert.equal(parses("x.mjs", "export const a = 1 <= ;\n"), false);
  const base = { invalid: 0, warnings: [] };
  assert.equal(mutateExit({ ...base, baseline: "fail", results: [] }), 3);
  assert.equal(mutateExit({ ...base, baseline: "timeout", results: [] }), 3);
  assert.equal(mutateExit({ ...base, baseline: "pass", results: [] }), 5);
  assert.equal(mutateExit({ ...base, baseline: "pass", results: [{ line: 1, what: "x", outcome: "missed" }] }), 1);
  assert.equal(mutateExit({ ...base, baseline: "pass", results: [{ line: 1, what: "x", outcome: "timeout" }] }), 0);
  assert.match(renderMutate("f.ts", { ...base, baseline: "pass", invalid: 2, results: [{ line: 1, what: "x", outcome: "timeout" }] }), /caught 1 of 1 deliberate breaks \(1 by running out of time\); 2 more would not parse and were skipped\./);
  assert.match(renderMutate("f.ts", { ...base, baseline: "timeout", results: [] }), /ran out of time on the unbroken copy/);
  assert.match(workspaceWarning(JSON.stringify({ workspaces: ["packages/*"] })) ?? "", /npm workspaces/);
  assert.equal(workspaceWarning("{}"), null);
});

test("review of D2: a node_modules folder that is not ignored is linked, not copied, and the run still cleans up", () => {
  const repo = tmp();
  gitIn(repo, "init", "-q", "-b", "main");
  put(repo, "src/a.mjs", "export const a = 1 < 2;\n");
  put(repo, "node_modules/dep/index.mjs", "export const dep = true;\n");
  put(repo, "t.mjs", "import { dep } from './node_modules/dep/index.mjs'; import { a } from './src/a.mjs'; if (!dep || !a) process.exit(1);\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  const r = mutate({ root: repo, file: "src/a.mjs", test: "node t.mjs", timeoutS: 60 });
  assert.equal(r.baseline, "pass");
  assert.equal(fs.readFileSync(path.join(repo, "node_modules/dep/index.mjs"), "utf8"), "export const dep = true;\n");
});
