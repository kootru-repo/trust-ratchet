import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { lastJson } from "./parse.ts";
import type { Checked, ModelFn, Repro } from "./types.ts";

/** Where and how a reproduction test is run for one target. This is the language-specific part. */
export type ReproConfig = {
  /** Package folder, relative to the tree root, in which tests run. */
  pkg: string;
  /** A working copy of the same repository with dependencies installed. Omit when the tree under review has its own. */
  depsFrom?: string;
  /** Import aliases, relative to the package folder. */
  alias?: Record<string, string>;
  /** Interpreter for packs that need one. */
  python?: string;
};

export type RunOutcome = { outcome: "failed-assertion" | "passed" | "error"; output: string };
/** Runs one test file against a tree and says how it ended. */
export type TestRunner = (args: { root: string; code: string; name: string }) => RunOutcome;

export const TEST_DIR = "src/__ratchet__";
const CONFIG = "ratchet.vitest.config.mts";

const isLink = (p: string): boolean => {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Makes installed dependencies visible in an exported tree by linking node_modules, runs `work`, then removes the links.
 * The links exist only while a test runs, never while a model is reading the tree.
 */
export const withDeps = <T>({ root, pkg, depsFrom, work }: { root: string; pkg: string; depsFrom?: string; work: () => T }): T => {
  const made: string[] = [];
  try {
    if (depsFrom) {
      for (const rel of [...new Set(["node_modules", path.join(pkg, "node_modules")])]) {
        const link = path.resolve(root, rel);
        const target = path.resolve(depsFrom, rel);
        if (fs.existsSync(link) || !fs.existsSync(target)) continue;
        fs.symlinkSync(target, link, "junction");
        made.push(link);
      }
    }
    return work();
  } finally {
    // Remove the link itself. Never a recursive delete: that could follow the link into the real dependencies.
    for (const link of made) if (isLink(link)) fs.rmdirSync(link);
  }
};

/** Removes any leftover dependency link under a tree, so the tree can be deleted safely. */
export const dropDepLinks = ({ root, pkg }: { root: string; pkg: string }): void => {
  for (const rel of ["node_modules", path.join(pkg, "node_modules")]) {
    const link = path.resolve(root, rel);
    if (isLink(link)) fs.rmdirSync(link);
  }
};

const vitestConfig = ({ alias, setup }: { alias: Record<string, string>; setup: string[] }): string =>
  `import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
const dirname = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  test: { environment: "node", include: ["${TEST_DIR}/**/*.test.ts", "${TEST_DIR}/**/*.test.tsx"], setupFiles: ${JSON.stringify(setup)} },
  resolve: { alias: { ${Object.entries(alias)
    .map(([k, v]) => `${JSON.stringify(k)}: path.resolve(dirname, ${JSON.stringify(v)})`)
    .join(", ")} } },
});
`;

type VitestJson = { testResults?: { status?: string; message?: string; assertionResults?: { status?: string; fullName?: string; failureMessages?: string[] }[] }[] };

/** Pure: reads vitest's JSON report. Only a failed assertion counts as the bug showing itself. */
export const readVitest = (report: VitestJson, fallback: string): RunOutcome => {
  const files = report.testResults ?? [];
  const tests = files.flatMap((f) => f.assertionResults ?? []);
  const failed = tests.filter((t) => t.status === "failed");
  const messages = failed.flatMap((t) => t.failureMessages ?? []).join("\n");
  const fileErrors = files.map((f) => f.message ?? "").join("\n").trim();
  if (tests.length === 0) return { outcome: "error", output: (fileErrors || fallback).slice(0, 3000) };
  if (failed.length === 0) return { outcome: "passed", output: `${tests.length} test(s) passed` };
  // An import error, a missing mock or a typo also fails a test. Those are a broken test, not a reproduced bug.
  const asserted = /AssertionError|expected .* to |toBe|toEqual|toThrow|toHaveBeenCalled|toContain|toMatch/.test(messages);
  return { outcome: asserted ? "failed-assertion" : "error", output: messages.slice(0, 3000) };
};

/** A TestRunner for TypeScript packages that use vitest. It brings its own config, so it works on commits that had no tests. */
export const vitestRunner = (config: ReproConfig): TestRunner => ({ root, code, name }) => {
  const pkgDir = path.resolve(root, config.pkg);
  const testDir = path.join(pkgDir, TEST_DIR);
  const testFile = path.join(testDir, `${name}.test.ts`);
  const configFile = path.join(pkgDir, CONFIG);
  const reportFile = path.join(pkgDir, "ratchet.report.json");
  const setup = ["src/utils/__tests__/setup.ts"].filter((s) => fs.existsSync(path.join(pkgDir, s)));
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(testFile, code);
  fs.writeFileSync(configFile, vitestConfig({ alias: config.alias ?? {}, setup }));
  try {
    return withDeps({
      root,
      pkg: config.pkg,
      ...(config.depsFrom ? { depsFrom: config.depsFrom } : {}),
      work: () => {
        let text = "";
        try {
          text = execFileSync(`npx vitest run --config ${CONFIG} --reporter=json --outputFile=ratchet.report.json`, {
            cwd: pkgDir,
            shell: true,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 3 * 60_000,
            maxBuffer: 32 * 1024 * 1024,
          });
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; message?: string };
          text = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim() || (e.message ?? "");
        }
        if (!fs.existsSync(reportFile)) return { outcome: "error", output: text.slice(-3000) };
        return readVitest(JSON.parse(fs.readFileSync(reportFile, "utf8")) as VitestJson, text.slice(-3000));
      },
    });
  } finally {
    for (const f of [testFile, configFile, reportFile]) fs.rmSync(f, { force: true });
    fs.rmSync(testDir, { recursive: true, force: true });
  }
};

const reproPrompt = ({ check, language, guide, previous }: { check: Checked; language: string; guide: string; previous?: { code: string; output: string } }): string =>
  `A reviewer and a verifier agree that this ${language} code has a bug. Nobody has run anything yet. Your job is to write one test file that shows the bug by running the real code.

Finding: ${check.title}
Location: ${check.cite.file}:${check.cite.line}
Quoted line: ${check.cite.quote}
Verifier's explanation: ${check.explanation}

What the test must do:
- Import the real function or module and call it. Do not copy the logic into the test.
- Assert the CORRECT behaviour. On the code as it is now the assertion must FAIL because of the bug. After a correct fix it must pass.
- Fail only on that assertion. A test that fails on an import, a missing stub or a stray exception proves nothing and is discarded.
- Keep it to one or two tests.
${guide}

If the bug cannot be shown by a small unit test (it needs a real browser, a rendered interface, a long run or a live external service), say so. Do not force it.

You may only read files (Read, Grep, Glob) in the current working directory. You cannot run code. A program will run your test and report back.
${
  previous
    ? `\nYour previous test did not run cleanly. It did not reach a failed assertion. Fix the test, or declare the bug not reproducible this way.\n\nPrevious test:\n\`\`\`ts\n${previous.code}\n\`\`\`\n\nOutput from the run:\n${previous.output}\n`
    : ""
}
End your reply with one fenced json block and nothing after it:
\`\`\`json
{ "reproducible": true, "reason": "", "test": "the full test file as one string, or empty" }
\`\`\`
`;

const parseRepro = (text: string): { reproducible: boolean; reason: string; test: string } => {
  const raw = lastJson(text) as Record<string, unknown>;
  return { reproducible: raw.reproducible === true, reason: typeof raw.reason === "string" ? raw.reason : "", test: typeof raw.test === "string" ? raw.test : "" };
};

export type ReproArgs = { check: Checked; root: string; language: string; guide: string; model: ModelFn; runner: TestRunner; name: string; maxAttempts?: number };

/**
 * Tries to turn an argued finding into an executed one. At most `maxAttempts` model calls.
 * reproduced: the test ran and failed on an assertion. test-passed: the test ran and passed, which speaks against the finding.
 */
export const reproduce = async ({ check, root, language, guide, model, runner, name, maxAttempts = 2 }: ReproArgs): Promise<Repro> => {
  let previous: { code: string; output: string } | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let reply;
    try {
      reply = parseRepro(await model({ prompt: reproPrompt({ check, language, guide, ...(previous ? { previous } : {}) }), cwd: root, label: `repro ${check.cite.file}:${check.cite.line} #${attempt}` }));
    } catch (err) {
      return { status: "test-broken", reason: `reproducer failed: ${err instanceof Error ? err.message : String(err)}`, test: previous?.code ?? "", output: previous?.output ?? "", attempts: attempt };
    }
    if (!reply.reproducible || !reply.test.trim()) return { status: "not-attempted", reason: reply.reason || "the reproducer declined", test: "", output: "", attempts: attempt };
    const run = runner({ root, code: reply.test, name });
    if (run.outcome === "failed-assertion") return { status: "reproduced", reason: reply.reason, test: reply.test, output: run.output, attempts: attempt };
    if (run.outcome === "passed") return { status: "test-passed", reason: reply.reason, test: reply.test, output: run.output, attempts: attempt };
    previous = { code: reply.test, output: run.output };
  }
  return { status: "test-broken", reason: "the test never reached an assertion", test: previous?.code ?? "", output: previous?.output ?? "", attempts: maxAttempts };
};
