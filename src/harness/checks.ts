// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { forShell } from "../shellcmd.ts";
import fs from "node:fs";
import path from "node:path";
import { builtinName, LF_WHEN, protectedFolders, runBuiltin, trialScope } from "./builtins.ts";
import { matchesAny } from "./rules.ts";
import type { CheckCmd, ProjectConfig } from "./state.ts";

/**
 * The loop finds a check (T9 made autonomous): a type-check for a folder with a tsconfig, or a lint or type-check
 * script of the root package. A check is only a candidate here. The loop maps it after it has run once, ended
 * clean, and left the working tree exactly as it was. A script that rewrites files is never a candidate.
 */
export type CheckCandidate = CheckCmd & { /** The file whose presence suggests the check; a change of it lets a failed trial be tried again. */ from: string };

const slug = (dir: string): string => (dir === "." ? "root" : dir.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, ""));
const REWRITES = /--fix\b|--write\b|--apply(-unsafe)?\b|:fix\b|:write\b|\s-w\b|\b(prettier|black|isort)\b(?!.*--check)|\bsed\b|\brm\b|(^|[^>=-])(\d|&)?>\s*(?!&|\/dev\/null\b|[Nn][Uu][Ll]\b)\S/;
const CHECK_ONLY = /--check\b|--diff\b|--dry-run\b|\bbiome\s+(check|ci|format|lint)\b/;

/**
 * Pure: is a word of a command a formatter: "format", "fmt", "clang-format", "./bin/clang-format"? A flag
 * ("--format", "--output-format=github") or a path ending in a folder named format ("src/format") is not.
 */
const formatterWord = (word: string): boolean => !word.startsWith("-") && (/^([\w.]+-)?(format|fmt)$/.test(word) || /\/[\w.]+-(format|fmt)$/.test(word));

/** Pure: a script body is a check when it cannot rewrite files. A formatter counts only in its check-only form. */
export const checkOnly = (body: string): boolean => !REWRITES.test(body) && (!commandWords(body).some(formatterWord) || CHECK_ONLY.test(body));

/** Pure: the words of a command, without quotes or brackets around them, with / for \ and no .exe or .cmd. */
const commandWords = (body: string): string[] => body.split(/[\s;&|]+/).map((w) => w.replace(/^["'(]+|["')]+$/g, "").replace(/\\/g, "/").replace(/\.(exe|cmd|bat)$/i, ""));

/** A package found in the tracked files: its folder ("." for the root) and its scripts. */
export type PackageScripts = { dir: string; scripts: Record<string, string> };
/** A pyproject.toml found in the tracked files: its folder and its text. */
export type PyProject = { dir: string; text: string };

const SCRIPT_KINDS = [["lint", "lint"], ["check", "check"], ["typecheck", "types"], ["check-types", "types"], ["type-check", "types"], ["format:check", "format"], ["fmt:check", "format"]] as const;
const JS_FILES = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];
const LINT_CONFIG = /(^|\/)(biome\.jsonc?|\.eslintrc(\.[a-z]+)?|eslint\.config\.[a-z]+|\.prettierrc(\.[a-z]+)?|prettier\.config\.[a-z]+)$/;

/** Pure: the tracked manifests a discovery may read, up to four path parts deep, outside node_modules and the excluded globs. */
export const manifests = (files: string[], name: string, exclude: string[] = []): string[] => files.filter((x) => (x === name || x.endsWith(`/${name}`)) && !x.split("/").includes("node_modules") && x.split("/").length <= 4 && !matchesAny(x, exclude));

const inDir = (dir: string, file: string): boolean => dir === "." || file.startsWith(`${dir}/`);
const runIn = (dir: string, command: string): string => (dir === "." ? command : `cd ${dir} && ${command}`);
/** Does a configured command run in this folder: at the root, no cd; elsewhere, a cd into it. */
const inFolder = (command: string, dir: string): boolean => (dir === "." ? !/\bcd\s/.test(command) : command.includes(`cd ${dir} `) || command.includes(`cd ${dir}&`));
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Does a command run this npm script by its whole name ("check" is not "check-types")? */
const runsScript = (command: string, name: string): boolean => new RegExp(`npm run(?: -s)? ${escapeRe(name)}(?=$|[\\s;&|])`).test(command);

/** Pure: the checks the tracked files and the packages' scripts suggest, minus those the config already has. */
export const checkCandidates = ({ files, scripts, packages = [], pyprojects = [], hasTypescript, config, exclude = [], offerBuiltins = false }: { files: string[]; scripts: Record<string, string>; packages?: PackageScripts[]; pyprojects?: PyProject[]; hasTypescript: (dir: string) => boolean; config: ProjectConfig; exclude?: string[]; /** Offer the built-in checks: LF line endings, and protected folders of recorded references. Each is kept only after its trial. */ offerBuiltins?: boolean }): CheckCandidate[] => {
  const have = config.checks ?? [];
  const out: CheckCandidate[] = [];
  for (const f of manifests(files, "tsconfig.json", exclude)) {
    const dir = path.posix.dirname(f);
    if (!hasTypescript(dir)) continue;
    // A person's type-check of the same folder, however it is spelled, is the check of that folder.
    if (have.some((c) => /\btsc\b/.test(c.command) && (dir === "." ? !/\bcd\s/.test(c.command) : c.command.includes(`cd ${dir} `) || c.command.includes(`cd ${dir}&`) || c.command.includes(`-p ${dir}`)))) continue;
    if (have.some((c) => inFolder(c.command, dir) && ["check", "check-types", "typecheck", "type-check", "tsc"].some((s) => runsScript(c.command, s)))) continue;
    const prefix = dir === "." ? "" : `${dir}/`;
    out.push({ name: `types-${slug(dir)}`, command: `${runIn(dir, "npx --no-install tsc --noEmit -p .")}`, when: [`${prefix}**/*.ts`, `${prefix}**/*.tsx`, `${prefix}**/*.mts`, `${prefix}*.ts`], timeoutS: 120, origin: "auto", from: f });
  }
  const lintConfigs = files.filter((f) => LINT_CONFIG.test(f) && !f.split("/").includes("node_modules"));
  for (const pkg of [{ dir: ".", scripts }, ...packages.filter((p) => p.dir !== ".")]) {
    const prefix = pkg.dir === "." ? "" : `${pkg.dir}/`;
    for (const [name, named] of SCRIPT_KINDS) {
      const body = pkg.scripts[name];
      if (!body || !checkOnly(body)) continue;
      // A "check" script that only runs the compiler is that folder's type-check.
      const kind = named === "check" && /\btsc\b/.test(body) && !/\b(biome|eslint|prettier|ruff)\b/.test(body) ? "types" : named;
      const command = runIn(pkg.dir, `npm run -s ${name}`);
      if (have.some((c) => inFolder(c.command, pkg.dir) && runsScript(c.command, name))) continue;
      if (kind === "types" && (out.some((c) => c.name === `types-${slug(pkg.dir)}` || c.name === `types-${slug(pkg.dir)}-script`) || have.some((c) => /\btsc\b/.test(c.command) && inFolder(c.command, pkg.dir)))) continue;
      // A lint config above the package (trio keeps biome.json one folder up) changes what the lint finds.
      const above = lintConfigs.filter((f) => !inDir(pkg.dir, f) && inDir(path.posix.dirname(f), pkg.dir));
      const own = lintConfigs.filter((f) => pkg.dir !== "." && inDir(pkg.dir, f));
      out.push({ name: `${kind}-${slug(pkg.dir)}-script`, command, when: [...JS_FILES.map((e) => `${prefix}**/*.${e}`), ...(kind === "types" ? [] : [...above, ...own])], timeoutS: 120, origin: "auto", from: `${prefix}package.json` });
    }
  }
  for (const py of pyprojects) {
    const prefix = py.dir === "." ? "" : `${py.dir}/`;
    if (matchesAny(`${prefix}pyproject.toml`, exclude)) continue;
    for (const [tool, command] of [["ruff", "python -m ruff check ."], ["mypy", "python -m mypy ."]] as const) {
      if (!new RegExp(`^\\[tool\\.${tool}\\b`, "m").test(py.text)) continue;
      // ruff at the root reads each folder's own settings, so it covers every folder; mypy is per folder.
      if (have.some((c) => new RegExp(`\\b${tool}\\b`).test(c.command) && (inFolder(c.command, py.dir) || (tool === "ruff" && inFolder(c.command, "."))))) continue;
      out.push({ name: `${tool}-${slug(py.dir)}`, command: runIn(py.dir, command), when: [`${prefix}**/*.py`, `${prefix}**/*.pyi`, `${prefix}pyproject.toml`], timeoutS: 120, origin: "auto", from: `${prefix}pyproject.toml` });
    }
  }
  if (offerBuiltins && !have.some((c) => builtinName(c.command) === "lf" || /\blf\b|line-endings|check_lf/i.test(`${c.name} ${c.command}`))) out.push({ name: "lf-line-endings", command: "builtin:lf", when: LF_WHEN, timeoutS: 30, origin: "auto", from: ".gitattributes" });
  // A folder that holds a recorded reference (fixtures, snapshots, golden files) is protected, unless a check already covers it.
  if (offerBuiltins) {
    for (const dir of protectedFolders(files.filter((f) => !matchesAny(f, exclude)))) {
      if (have.some((c) => builtinName(c.command) === "protected" && matchesAny(`${dir}/x`, c.when ?? []))) continue;
      out.push({ name: `protected-${slug(dir)}`, command: "builtin:protected", when: [`${dir}/**`], timeoutS: 30, origin: "auto", from: dir });
    }
  }
  // One entry per name: format:check and fmt:check in one package are the same check.
  return out.filter((c, i) => !have.some((h) => h.name === c.name) && out.findIndex((o) => o.name === c.name) === i);
};

/** Pure: every path in `git status --porcelain=v1 -z` records, both sides of a rename or copy (whose original path is a record of its own, with no status). */
export const statusBothPaths = (records: string[]): string[] => {
  const out: string[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const entry = records[i] ?? "";
    if (entry.length < 4) continue;
    out.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) {
      i += 1;
      if (records[i]) out.push(records[i] ?? "");
    }
  }
  return out;
};

const status = (root: string): string => execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });

/** Runs a candidate once. It is kept only when it ended clean in time and the working tree is as it was before. */
export const tryCheck = ({ root, check }: { root: string; check: CheckCandidate }): { ok: boolean; seconds: number; why: string } => {
  const before = status(root);
  const started = Date.now();
  let ok = true;
  // A built-in check is tried on every tracked file it covers, or, for one about changes, on the files changed now.
  if (builtinName(check.command) !== null) {
    const git = (args: string[]): string[] => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true }).split("\0");
    const listed = trialScope(check.command) === "changed" ? statusBothPaths(git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])) : git(["ls-files", "-z"]);
    const files = listed.filter((f) => f !== "" && matchesAny(f, check.when ?? ["**"]));
    ok = runBuiltin({ command: check.command, root, files, deadline: started + (check.timeoutS ?? 120) * 1000, spec: { ...(check.build ? { build: check.build } : {}), ...(check.into ? { into: check.into } : {}) } }).status === 0;
    const seconds = (Date.now() - started) / 1000;
    if (status(root) !== before) return { ok: false, seconds, why: "it changed files in the working tree" };
    return { ok, seconds, why: ok ? "it ran clean" : "a file it covers fails it today, or it could not run" };
  }
  try {
    execFileSync(forShell(check.command), { cwd: root, shell: true, stdio: "ignore", timeout: (check.timeoutS ?? 120) * 1000, windowsHide: true, env: { ...process.env, RATCHET_CHILD: "1" } });
  } catch {
    ok = false;
  }
  const seconds = (Date.now() - started) / 1000;
  if (status(root) !== before) return { ok: false, seconds, why: "it changed files in the working tree" };
  return { ok, seconds, why: ok ? "it ran clean" : "it did not end clean on the tree as it is, or ran out of time" };
};

export const readScripts = (root: string): Record<string, string> => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return {};
  }
};

/** The scripts of every tracked package.json a discovery may read, the root's included. */
export const readPackages = (root: string, files: string[], exclude: string[] = []): PackageScripts[] =>
  manifests(files, "package.json", exclude).map((f) => {
    try {
      return { dir: path.posix.dirname(f), scripts: (JSON.parse(fs.readFileSync(path.join(root, f), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {} };
    } catch {
      return { dir: path.posix.dirname(f), scripts: {} };
    }
  });

/** Every tracked pyproject.toml a discovery may read. */
export const readPyprojects = (root: string, files: string[], exclude: string[] = []): PyProject[] =>
  manifests(files, "pyproject.toml", exclude).flatMap((f) => {
    try {
      return [{ dir: path.posix.dirname(f), text: fs.readFileSync(path.join(root, f), "utf8") }];
    } catch {
      return [];
    }
  });

/** Is there a TypeScript compiler this folder can run without downloading one? */
export const hasTypescriptAt = (root: string) => (dir: string): boolean => {
  let at = path.resolve(root, dir);
  const top = path.resolve(root);
  for (;;) {
    if (fs.existsSync(path.join(at, "node_modules", "typescript", "package.json"))) return true;
    if (at === top || path.dirname(at) === at) return false;
    at = path.dirname(at);
  }
};
