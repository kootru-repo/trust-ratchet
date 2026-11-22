// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { escapeRegExp, type LintRunner, type Pack, type Violation } from "../pack.ts";
import { pickSpecialists } from "../plan.ts";
import { TEST_DIR, vitestRunner, withDeps, type ReproConfig } from "../repro.ts";

const names = (clause: string): string[] =>
  clause
    .replace(/[{}]/g, ",")
    .split(",")
    .map((p) => p.trim().replace(/^type\s+/, ""))
    .map((p) => (/\bas\s+(\w+)$/.exec(p)?.[1] ?? p).trim())
    .filter((p) => /^[A-Za-z_$][\w$]*$/.test(p));

/** Pure: the local names an importing file gives to what it imports from `file`. */
export const tsImportedNames = (importerText: string, file: string): string[] => {
  const base = escapeRegExp(path.basename(file).replace(/\.tsx?$/, ""));
  const re = new RegExp(`import\\s+(?:type\\s+)?([^;"']*?)\\s+from\\s+["'][^"']*/${base}["']`, "g");
  return [...new Set([...importerText.matchAll(re)].flatMap((m) => names(m[1] ?? "")))];
};

const SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

export const tsLocalImports = ({ root, file, content, pkg }: { root: string; file: string; content: string; pkg: string }): string[] => {
  const dir = path.dirname(path.resolve(root, file));
  const out = new Set<string>();
  for (const m of content.matchAll(/from\s+["']([^"']+)["']/g)) {
    const spec = m[1] ?? "";
    const base = spec.startsWith(".") ? path.resolve(dir, spec) : spec.startsWith("~/") ? path.resolve(root, pkg, "src", spec.slice(2)) : null;
    if (!base) continue;
    const hit = SUFFIXES.map((s) => base + s).find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
    if (hit) out.add(path.relative(path.resolve(root), hit).split(path.sep).join("/"));
  }
  return [...out].slice(0, 12);
};

type EslintFile = { messages?: { line?: number; ruleId?: string | null; message?: string; fatal?: boolean }[] };

/** Pure: reads ESLint's JSON report. A fatal message (a parse or config failure) means the run told us nothing. */
export const readEslint = (text: string): Violation[] | null => {
  let files: EslintFile[];
  try {
    files = JSON.parse(text) as EslintFile[];
  } catch {
    return null;
  }
  if (!Array.isArray(files)) return null;
  const messages = files.flatMap((f) => f.messages ?? []);
  if (messages.some((m) => m.fatal === true)) return null;
  return messages.map((m) => ({ line: m.line ?? 0, rule: m.ruleId ?? "", message: m.message ?? "" }));
};

const LINT_CONFIG = "ratchet.eslint.config.mjs";

/** Runs ESLint on one file with a configuration supplied by the guard, not the repository's own. */
export const eslintRunner = (config: ReproConfig): LintRunner => ({ root, file, configCode }) => {
  const pkgDir = path.resolve(root, config.pkg);
  const rel = path.relative(pkgDir, path.resolve(root, file)).split(path.sep).join("/");
  const configFile = path.join(pkgDir, LINT_CONFIG);
  const reportFile = path.join(pkgDir, "ratchet.eslint.json");
  if (!fs.existsSync(path.resolve(root, file))) return null;
  fs.writeFileSync(configFile, configCode);
  try {
    return withDeps({
      root,
      pkg: config.pkg,
      ...(config.depsFrom ? { depsFrom: config.depsFrom } : {}),
      work: () => {
        try {
          execFileSync(`npx eslint --no-warn-ignored -c ${LINT_CONFIG} --format json -o ratchet.eslint.json "${rel}"`, { cwd: pkgDir, shell: true, stdio: ["ignore", "pipe", "pipe"], timeout: 5 * 60_000, maxBuffer: 64 * 1024 * 1024 });
        } catch {
          // ESLint exits 1 when it reports anything. The report file decides.
        }
        return fs.existsSync(reportFile) ? readEslint(fs.readFileSync(reportFile, "utf8")) : null;
      },
    });
  } finally {
    fs.rmSync(configFile, { force: true });
    fs.rmSync(reportFile, { force: true });
  }
};

export const typescriptPack: Pack = {
  name: "typescript",
  language: "TypeScript",
  handles: (file) => /\.(tsx?|mts|cts)$/.test(file),
  isSource: (name) => /\.tsx?$/.test(name) && !name.endsWith(".d.ts"),
  packageMarkers: ["package.json"],
  importerPattern: (file) => new RegExp(`from\\s+["'][^"']*/${escapeRegExp(path.basename(file).replace(/\.tsx?$/, ""))}["']`),
  importedNames: tsImportedNames,
  localImports: tsLocalImports,
  pickSpecialists: ({ file, content }) => pickSpecialists({ file, content }),
  defaultChecks: () => [],
  runner: vitestRunner,
  lint: eslintRunner,
  testGuide: (pkg) =>
    `- Write one vitest test file. It will be saved as ${pkg}/${TEST_DIR}/<name>.test.ts. Import package code with a relative path from there (for example "../utils/x") or with the package's own alias if existing tests use one.
- Assert with expect(...). If the bug shows as a thrown error, assert that the call does not throw (expect(() => f()).not.toThrow()), so the failure is an assertion.
- Environment is node, with no DOM. Mock what the module needs at import time with vi.mock or vi.hoisted (for example a global window object). Read the existing tests under ${pkg} to see how this codebase does it.
- "test" in your reply is the full test file.`,
};
