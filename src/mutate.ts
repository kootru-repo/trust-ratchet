// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import { runBounded } from "./harness/runtree.ts";

/**
 * `ratchet mutate` (D2): proof that a test bites. Small deliberate breaks (mutants) of one source file are made in
 * a temporary copy of the repository, never in the working tree, and the test command runs once per mutant. A test
 * that still passes with the code broken has "missed" it. In trio-mix-assistant, 21 of 21 breaks of the hold logic
 * were caught before its new model check was trusted.
 *
 * A break that leaves the file unable to parse proves nothing about the test, so it is skipped and counted apart.
 * Text inside strings, template literals and regular expressions is never broken.
 */
export type Mutant = { line: number; what: string; text: string };

const OPERATORS: { from: RegExp; to: string; what: string }[] = [
  { from: /<=/g, to: "<", what: "<= to <" },
  { from: /(?<![<=!>])<(?![=<])/g, to: "<=", what: "< to <=" },
  { from: />=/g, to: ">", what: ">= to >" },
  { from: /(?<![=>-])>(?![=>])/g, to: ">=", what: "> to >=" },
  { from: /===/g, to: "!==", what: "=== to !==" },
  { from: /!==/g, to: "===", what: "!== to ===" },
  { from: /&&/g, to: "||", what: "&& to ||" },
  { from: /\|\|/g, to: "&&", what: "|| to &&" },
  { from: /\btrue\b/g, to: "false", what: "true to false" },
  { from: /\bfalse\b/g, to: "true", what: "false to true" },
  { from: /(?<![\w.])(\d+)(?![\w.])/g, to: "", what: "constant +1" },
];

const codeLine = (l: string): boolean => {
  const t = l.trim();
  return t !== "" && !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("import ") && !t.startsWith("export type ") && !t.startsWith("type ");
};

/** Pure: the ranges of a line that are strings, template literals, regular expressions or a trailing comment. */
export const literalRanges = (line: string): [number, number][] => {
  const out: [number, number][] = [];
  let i = 0;
  let prev = "";
  while (i < line.length) {
    const ch = line.charAt(i);
    if (ch === "/" && line.charAt(i + 1) === "/") {
      out.push([i, line.length]);
      break;
    }
    const regexStart = ch === "/" && (prev === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || /\breturn\s*$/.test(line.slice(0, i)));
    if (ch === '"' || ch === "'" || ch === "`" || regexStart) {
      const close = ch;
      let j = i + 1;
      let inClass = false;
      while (j < line.length) {
        const c = line.charAt(j);
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (regexStart && c === "[") inClass = true;
        else if (regexStart && c === "]") inClass = false;
        else if (c === close && !inClass) break;
        j += 1;
      }
      out.push([i, Math.min(j + 1, line.length)]);
      i = j + 1;
      prev = close;
      continue;
    }
    if (ch.trim() !== "") prev = ch;
    i += 1;
  }
  return out;
};

/** Pure: the mutants of a file: each operator at each place it fits outside literals, plus each one-line guard dropped. */
export const mutants = (text: string): Mutant[] => {
  const lines = text.split("\n");
  const out: Mutant[] = [];
  const replaceLine = (i: number, line: string): string => [...lines.slice(0, i), line, ...lines.slice(i + 1)].join("\n");
  lines.forEach((line, i) => {
    if (!codeLine(line)) return;
    const literals = literalRanges(line);
    const inLiteral = (at: number): boolean => literals.some(([a, b]) => at >= a && at < b);
    for (const op of OPERATORS) {
      for (const m of line.matchAll(op.from)) {
        if (m.index === undefined || inLiteral(m.index)) continue;
        const to = op.what === "constant +1" ? String(Number(m[1]) + 1) : op.to;
        out.push({ line: i + 1, what: op.what, text: replaceLine(i, `${line.slice(0, m.index)}${to}${line.slice(m.index + m[0].length)}`) });
      }
    }
    if (/^\s*if\s*\(.*\)\s*(return|continue|break|throw)\b.*;\s*$/.test(line)) out.push({ line: i + 1, what: "guard dropped", text: replaceLine(i, "") });
  });
  return out;
};

/** Pure: at most `max` mutants, spread evenly over the file. */
export const sample = <T>(items: T[], max: number): T[] => {
  if (items.length <= max) return items;
  const step = items.length / max;
  return Array.from({ length: max }, (_, i) => items[Math.floor(i * step)] as T);
};

/** Does this text parse as the file it replaces? Type syntax is checked by stripping it, then the JavaScript by `node --check`. */
export const parses = (file: string, text: string): boolean => {
  let js = text;
  if (/\.(ts|mts|cts)$/.test(file)) {
    try {
      // Transform mode, as tsc and tsx accept enums, namespaces and parameter properties.
      js = stripTypeScriptTypes(text, { mode: "transform" });
    } catch {
      return false;
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-parse-"));
  try {
    const probe = path.join(dir, /\.(cjs|cts)$/.test(file) ? "probe.cjs" : "probe.mjs");
    fs.writeFileSync(probe, js);
    return spawnSync(process.execPath, ["--check", probe], { stdio: "ignore", windowsHide: true }).status === 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

export type MutateReport = { baseline: "pass" | "fail" | "timeout"; invalid: number; results: { line: number; what: string; outcome: "caught" | "missed" | "timeout" }[]; warnings: string[] };

const isNodeModules = (f: string): boolean => f.split("/").includes("node_modules");
const listFiles = (root: string): string[] => execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true }).split("\0").filter((f) => f !== "" && !isNodeModules(f));

type Copy = { dir: string; links: string[] };

/** Copies the repository's files (tracked and untracked, not ignored, outside node_modules) to a temporary folder, and links each package's node_modules. */
const copyTree = (root: string, copy: Copy): void => {
  const files = listFiles(root);
  for (const f of files) {
    const from = path.join(root, f);
    try {
      if (!fs.lstatSync(from).isFile()) continue;
    } catch {
      continue;
    }
    fs.mkdirSync(path.dirname(path.join(copy.dir, f)), { recursive: true });
    fs.copyFileSync(from, path.join(copy.dir, f));
  }
  const packageDirs = new Set(["", ...files.filter((f) => f === "package.json" || f.endsWith("/package.json")).map((f) => path.posix.dirname(f)).map((d) => (d === "." ? "" : d))]);
  for (const d of packageDirs) {
    const real = path.join(root, d, "node_modules");
    if (!fs.existsSync(real)) continue;
    const link = path.join(copy.dir, d, "node_modules");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(real, link, "junction");
    copy.links.push(link);
  }
};

/** Removes the copy. Each node_modules link is removed first and on its own, so a real folder is never followed. */
const removeTree = (copy: Copy): void => {
  for (const link of copy.links) {
    try {
      fs.unlinkSync(link);
    } catch {
      try {
        fs.rmdirSync(link);
      } catch {
        // A link that cannot be removed is left, with the copy around it: never follow it.
        return;
      }
    }
  }
  try {
    fs.rmSync(copy.dir, { recursive: true, force: true });
  } catch {
    // A test process still holding a file must not hide the report.
  }
};

/** Pure: why a test may not see the copy's sources: packages that tests can import by name load from the real tree. */
export const workspaceWarning = (rootPackage: string): string | null => {
  try {
    const pkg = JSON.parse(rootPackage) as { workspaces?: unknown };
    return pkg.workspaces ? "This repository uses npm workspaces: a test that imports a workspace package by name loads the real sources, not the broken copy, and every break reads as missed. Run mutate on a test that imports the file by path." : null;
  } catch {
    return null;
  }
};

export const mutate = ({ root, file, test, max = 20, timeoutS = 120 }: { root: string; file: string; test: string; max?: number; timeoutS?: number }): MutateReport => {
  const copy: Copy = { dir: fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-mutate-")), links: [] };
  try {
    copyTree(root, copy);
    const warnings: string[] = [];
    const rootPkg = path.join(root, "package.json");
    const ws = fs.existsSync(rootPkg) ? workspaceWarning(fs.readFileSync(rootPkg, "utf8")) : null;
    if (ws) warnings.push(ws);
    const target = path.join(copy.dir, file);
    const original = fs.readFileSync(target, "utf8");
    const run = (): "pass" | "fail" | "timeout" => {
      const r = runBounded({ command: test, cwd: copy.dir, timeoutMs: timeoutS * 1000, env: { ...process.env, RATCHET_CHILD: "1" } });
      return r.timedOut ? "timeout" : r.status === 0 ? "pass" : "fail";
    };
    const baseline = run();
    if (baseline !== "pass") return { baseline, invalid: 0, results: [], warnings };
    // The spread sample first, then the rest, each parse-checked only when its turn comes, until `max` have run.
    const all = mutants(original);
    const first = sample(all, max);
    const order = [...first, ...all.filter((m) => !first.includes(m))];
    let invalid = 0;
    const results: MutateReport["results"] = [];
    for (const m of order) {
      if (results.length >= max) break;
      if (!parses(file, m.text)) {
        invalid += 1;
        continue;
      }
      fs.writeFileSync(target, m.text);
      const r = run();
      results.push({ line: m.line, what: m.what, outcome: r === "pass" ? "missed" : r === "timeout" ? "timeout" : "caught" });
    }
    fs.writeFileSync(target, original);
    return { baseline: "pass", invalid, results, warnings };
  } finally {
    removeTree(copy);
  }
};

/** Pure: the report as lines a person reads. */
export const renderMutate = (file: string, r: MutateReport): string => {
  const warn = r.warnings.map((w) => `Note: ${w}`);
  if (r.baseline === "fail") return [`The test fails on the unbroken copy, so it cannot judge any break of ${file}. Make it pass first.`, ...warn].join("\n");
  if (r.baseline === "timeout") return [`The test ran out of time on the unbroken copy of ${file}. Give it more with --timeout, or pick a smaller test.`, ...warn].join("\n");
  if (r.results.length === 0) return [`${file} has no break that still parses${r.invalid > 0 ? ` (${r.invalid} would not parse)` : ""}, so nothing was tried.`, ...warn].join("\n");
  const caught = r.results.filter((x) => x.outcome === "caught");
  const timedOut = r.results.filter((x) => x.outcome === "timeout");
  const missed = r.results.filter((x) => x.outcome === "missed");
  const lines = [`${file}: the test caught ${caught.length + timedOut.length} of ${r.results.length} deliberate breaks${timedOut.length > 0 ? ` (${timedOut.length} by running out of time)` : ""}${r.invalid > 0 ? `; ${r.invalid} more would not parse and were skipped` : ""}${missed.length === 0 ? "." : ". It missed:"}`];
  for (const m of missed) lines.push(`  line ${m.line}: ${m.what}`);
  if (missed.length > 0) lines.push("Each missed break is behaviour no test pins down: add a test that fails for it, or say why the line does not matter.");
  return [...lines, ...warn].join("\n");
};

/** Pure: the exit code: 0 every break caught, 1 some missed, 3 the test fails or times out unbroken, 5 nothing to try. */
export const mutateExit = (r: MutateReport): number => (r.baseline !== "pass" ? 3 : r.results.length === 0 ? 5 : r.results.some((x) => x.outcome === "missed") ? 1 : 0);
