import { execFileSync } from "node:child_process";
import { forShell } from "./shellcmd.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Case, CaseFile, Score } from "./bench.ts";
import { exportTree } from "./git.ts";
import { fixDiff, hunkPairs, squash } from "./history.ts";
import { ident } from "./ident.ts";
import { packFor } from "./packs/index.ts";
import { dropDepLinks, withDeps, type ReproConfig } from "./repro.ts";
import type { ReviewResult } from "./types.ts";

/**
 * A guard is a check that a program runs: a test, or a command such as a lint rule. It is code, never prose.
 *
 * scope "case": a regression test for one known bug. It proves that bug cannot come back. It says nothing about a class.
 * scope "class": a rule meant to catch a whole class of bug. Only this kind can retire a specialist.
 */
export type Guard = {
  id: string;
  title: string;
  scope: "case" | "class";
  /**
   * "lint": a lint configuration run on the reviewed file. It is judged on the lines the fix changed, not on the whole
   * file: a rule proves itself when it reports on those lines before the fix and reports less on them after it.
   */
  kind: "test" | "command" | "lint";
  /** For kind "lint": the lint configuration file, relative to the guards folder. */
  configFile?: string;
  /** For kind "test": the test file, relative to the guards folder. */
  testFile?: string;
  /** For kind "command": run in the package folder. {file} is replaced by the reviewed file, relative to that folder. Exit 0 means clean. */
  command?: string;
  /** For scope "case": the benchmark case this guard was made from. */
  caseId?: string;
  finding?: string;
  specialist?: string;
};

export type GuardFile = { target: string; guards: Guard[] };

export type Outcome = "fails" | "passes" | "error";
export type LintDetail = {
  /** Reports on the lines the fix changed, in the buggy file and in the fixed file. */
  onFixBefore: number;
  onFixAfter: number;
  /** Reports on the buggy lines that the fix made go away. */
  resolved: number;
  /** Reports on the fixed lines that were not there before: the fix itself breaks the rule. */
  introduced: number;
  /** Reports left in the whole file after the fix. */
  backlog: number;
  /** What the rule said, for a person to read against the fix. */
  messages: string[];
};

export type Proof = {
  guard: string;
  caseId: string;
  before: Outcome;
  after: Outcome;
  proven: boolean;
  /** Lint guards only. */
  detail?: LintDetail;
};

type Report = { line: number; rule: string; message: string };

/**
 * Pure: judges a lint guard from what it reported on the buggy and the fixed file.
 * A report is identified by its rule, its message and the text of its line, so a line that merely moved is the same
 * report. The rule catches the bug when a report on the buggy lines is gone after the fix. It is noisy when the fixed
 * lines carry a report that was not there before. A report that sits on the changed lines before and after, unchanged,
 * is neither: the rule was talking about something else.
 */
export const judgeLint = ({ diff, before, after, beforeText, afterText }: { diff: string; before: Report[] | null; after: Report[] | null; beforeText: string; afterText: string }): Pick<Proof, "before" | "after" | "proven" | "detail"> => {
  if (before === null || after === null) return { before: before === null ? "error" : "passes", after: after === null ? "error" : "passes", proven: false };
  const pairs = hunkPairs(diff);
  const keyOf = (text: string) => {
    const lines = text.split(/\r?\n/);
    return (v: Report): string => `${v.rule}|${v.message}|${squash(lines[v.line - 1] ?? "")}`;
  };
  const keyB = keyOf(beforeText);
  const keyA = keyOf(afterText);
  const tally = (vs: Report[], key: (v: Report) => string): Map<string, number> => vs.reduce((m, v) => m.set(key(v), (m.get(key(v)) ?? 0) + 1), new Map<string, number>());
  const countB = tally(before, keyB);
  const countA = tally(after, keyA);
  const onB = before.filter((v) => pairs.some((p) => v.line >= p.before.from && v.line <= p.before.to));
  const onA = after.filter((v) => pairs.some((p) => v.line >= p.after.from && v.line <= p.after.to));
  const gone = onB.filter((v) => (countB.get(keyB(v)) ?? 0) > (countA.get(keyB(v)) ?? 0));
  const fresh = onA.filter((v) => (countA.get(keyA(v)) ?? 0) > (countB.get(keyA(v)) ?? 0));
  const b: Outcome = gone.length > 0 ? "fails" : "passes";
  const a: Outcome = fresh.length === 0 ? "passes" : "fails";
  const say = (tag: string, v: Report, key: (v: Report) => string): string => `${tag} line ${v.line}: ${v.message} [${key(v).split("|").slice(2).join("|").slice(0, 100)}]`;
  return {
    before: b,
    after: a,
    proven: isProven(b, a),
    detail: { onFixBefore: onB.length, onFixAfter: onA.length, resolved: gone.length, introduced: fresh.length, backlog: after.length, messages: [...gone.map((v) => say("gone", v, keyB)), ...fresh.map((v) => say("new", v, keyA))] },
  };
};

/** Pure: a guard is proven on a case when it fails on the tree with the bug and passes on the tree with the fix. */
export const isProven = (before: Outcome, after: Outcome): boolean => before === "fails" && after === "passes";

export const runGuard = ({ guard, guardsDir, root, config, file }: { guard: Guard; guardsDir: string; root: string; config: ReproConfig; file: string }): Outcome => {
  if (guard.kind === "test") {
    if (!guard.testFile) return "error";
    const code = fs.readFileSync(path.join(guardsDir, guard.testFile), "utf8");
    const run = packFor(file).runner(config)({ root, code, name: `guard_${guard.id.replace(/[^A-Za-z0-9_]/g, "_")}` });
    return run.outcome === "failed-assertion" ? "fails" : run.outcome === "passed" ? "passes" : "error";
  }
  if (!guard.command) return "error";
  const pkgDir = path.resolve(root, config.pkg);
  const rel = path.relative(pkgDir, path.resolve(root, file)).split(path.sep).join("/");
  if (!fs.existsSync(path.resolve(root, file))) return "error";
  return withDeps({
    root,
    pkg: config.pkg,
    ...(config.depsFrom ? { depsFrom: config.depsFrom } : {}),
    work: (): Outcome => {
      try {
        execFileSync(forShell(guard.command?.split("{file}").join(rel) ?? ""), { cwd: pkgDir, shell: true, stdio: ["ignore", "pipe", "pipe"], timeout: 5 * 60_000, maxBuffer: 32 * 1024 * 1024 });
        return "passes";
      } catch (err) {
        // Exit 1 is the usual "found something". Anything else (crash, timeout) is a broken guard, not a catch.
        // A shell also exits 1 when the command does not exist, so that message is checked for as well.
        const e = err as { status?: number | null; stderr?: Buffer | string };
        const missing = /is not recognized as an internal or external command|command not found|No such file or directory/i.test(String(e.stderr ?? ""));
        return e.status === 1 && !missing ? "fails" : "error";
      }
    },
  });
};

type Saved = { score: Score; review: ReviewResult };
const loadResult = (resultsDir: string, id: string): Saved | null => {
  const f = path.join(resultsDir, `${id}.json`);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as Saved) : null;
};

/**
 * Turns reproduction tests from a benchmark run into case guards. Only a test that failed on the buggy tree,
 * sits on the lines the real fix changed, and passed after the fix is promoted.
 */
export const promote = ({ caseFile, resultsDir, guardsDir }: { caseFile: CaseFile; resultsDir: string; guardsDir: string }): GuardFile => {
  const file = path.join(guardsDir, "guards.json");
  const data: GuardFile = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as GuardFile) : { target: caseFile.target, guards: [] };
  fs.mkdirSync(guardsDir, { recursive: true });
  for (const c of caseFile.cases) {
    const saved = loadResult(resultsDir, `${c.id}-bug`);
    if (!saved) continue;
    for (const x of saved.review.checked) {
      if (x.repro?.status !== "reproduced" || x.repro.afterFix !== "passes") continue;
      const id = `case-${c.id}-${ident(x.cite)}`;
      if (data.guards.some((g) => g.id === id)) continue;
      const testFile = `${id}${c.file.endsWith(".py") ? ".py" : ".test.ts"}`;
      fs.writeFileSync(path.join(guardsDir, testFile), x.repro.test);
      data.guards.push({ id, title: x.title, scope: "case", kind: "test", testFile, caseId: c.id, finding: ident(x.cite), specialist: x.specialist });
    }
  }
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  return data;
};

/**
 * Runs every guard on real trees, with no model. A case guard runs on its own case. A class guard runs on every case.
 * Safe to stop and start again: finished pairs are kept in proofs.json.
 */
export const prove = ({ caseFile, guards, guardsDir, log }: { caseFile: CaseFile; guards: GuardFile; guardsDir: string; log: (line: string) => void }): Proof[] => {
  const config = caseFile.repro;
  if (!config) throw new Error("the cases file has no repro settings; a guard cannot be run without them");
  const proofFile = path.join(guardsDir, "proofs.json");
  const proofs: Proof[] = fs.existsSync(proofFile) ? (JSON.parse(fs.readFileSync(proofFile, "utf8")) as Proof[]) : [];
  const work = path.join(os.tmpdir(), "ratchet-work");
  const wanted = (c: Case): Guard[] => guards.guards.filter((g) => (g.scope === "class" || g.caseId === c.id) && !proofs.some((p) => p.guard === g.id && p.caseId === c.id));
  for (const c of caseFile.cases) {
    const todo = wanted(c);
    if (todo.length === 0) continue;
    const trees = { before: path.join(work, `guard-${c.id}-before`), after: path.join(work, `guard-${c.id}-after`) };
    exportTree({ repo: caseFile.repo, commit: `${c.fix}^`, dest: trees.before, paths: caseFile.paths });
    exportTree({ repo: caseFile.repo, commit: c.fix, dest: trees.after, paths: caseFile.paths });
    try {
      for (const g of todo) {
        if (g.kind === "lint") {
          const lint = packFor(c.file).lint?.(config);
          const configCode = g.configFile ? fs.readFileSync(path.join(guardsDir, g.configFile), "utf8") : "";
          const run = (root: string): Report[] | null => (lint && configCode ? lint({ root, file: c.file, configCode }) : null);
          const text = (root: string): string => (fs.existsSync(path.join(root, c.file)) ? fs.readFileSync(path.join(root, c.file), "utf8") : "");
          const judged = judgeLint({ diff: fixDiff({ repo: caseFile.repo, fix: c.fix, file: c.file }), before: run(trees.before), after: run(trees.after), beforeText: text(trees.before), afterText: text(trees.after) });
          proofs.push({ guard: g.id, caseId: c.id, ...judged });
          log(`${g.id} on ${c.id}: before=${judged.before} after=${judged.after}${judged.detail ? ` (on the fixed lines ${judged.detail.onFixBefore} -> ${judged.detail.onFixAfter}; gone ${judged.detail.resolved}, new ${judged.detail.introduced}; ${judged.detail.backlog} left in the file)` : ""}`);
          fs.writeFileSync(proofFile, JSON.stringify(proofs, null, 2) + "\n");
          continue;
        }
        const before = runGuard({ guard: g, guardsDir, root: trees.before, config, file: c.file });
        const after = runGuard({ guard: g, guardsDir, root: trees.after, config, file: c.file });
        proofs.push({ guard: g.id, caseId: c.id, before, after, proven: isProven(before, after) });
        log(`${g.id} on ${c.id}: before=${before} after=${after}`);
        fs.writeFileSync(proofFile, JSON.stringify(proofs, null, 2) + "\n");
      }
    } finally {
      for (const t of Object.values(trees)) {
        dropDepLinks({ root: t, pkg: config.pkg });
        fs.rmSync(t, { recursive: true, force: true });
      }
    }
  }
  return proofs;
};

export type GuardReport = {
  guard: Guard;
  /** Cases where the guard fails before the fix and passes after it. */
  catches: string[];
  /** Cases where it fails even after the fix: noise, or a different real problem. */
  noisy: string[];
  /** Cases where it could not run. */
  broken: string[];
  status: "proven" | "not proven" | "broken";
  /** Lint guards: reports remaining across the fixed files. A rule cannot be switched on until this backlog is cleared. */
  backlog?: number;
};

/** Pure: what the proofs say about each guard. */
export const judgeGuards = ({ guards, proofs }: { guards: Guard[]; proofs: Proof[] }): GuardReport[] =>
  guards.map((guard) => {
    const mine = proofs.filter((p) => p.guard === guard.id);
    const catches = mine.filter((p) => p.proven).map((p) => p.caseId);
    const noisy = mine.filter((p) => p.after === "fails").map((p) => p.caseId);
    const broken = mine.filter((p) => p.before === "error" || p.after === "error").map((p) => p.caseId);
    const status = catches.length > 0 ? "proven" : mine.length > 0 && broken.length === mine.length ? "broken" : "not proven";
    const backlog = mine.some((p) => p.detail) ? mine.reduce((a, p) => a + (p.detail?.backlog ?? 0), 0) : undefined;
    return { guard, catches, noisy, broken, status, ...(backlog === undefined ? {} : { backlog }) };
  });

export type Retirement = {
  specialist: string;
  cases: { id: string; baseline: boolean; without: boolean; classGuard: boolean; caseGuard: boolean }[];
  recallBaseline: number;
  recallWithout: number;
  recallWithoutPlusClassGuards: number;
  /** Bugs lost by switching the specialist off that no class guard catches. */
  lost: string[];
  retirable: boolean;
  reason: string;
};

/**
 * Pure: can a specialist be switched off? Compares the benchmark with it on, with it off, and with it off plus class guards.
 * Case guards are shown but never counted: a test written for one bug proves nothing about the next bug of that class.
 */
export const judgeRetirement = ({
  specialist,
  caseIds,
  baseline,
  without,
  reports,
}: {
  specialist: string;
  caseIds: string[];
  baseline: Map<string, boolean>;
  without: Map<string, boolean>;
  reports: GuardReport[];
}): Retirement => {
  const caught = (scope: "class" | "case", id: string): boolean => reports.some((r) => r.guard.scope === scope && r.catches.includes(id));
  const missing = caseIds.filter((id) => !baseline.has(id) || !without.has(id));
  const cases = caseIds.map((id) => ({ id, baseline: baseline.get(id) ?? false, without: without.get(id) ?? false, classGuard: caught("class", id), caseGuard: caught("case", id) }));
  const n = (f: (c: (typeof cases)[number]) => boolean): number => cases.filter(f).length;
  const lost = cases.filter((c) => c.baseline && !c.without && !c.classGuard).map((c) => c.id);
  const noisy = reports.filter((r) => r.guard.scope === "class" && r.noisy.length > 0).map((r) => r.guard.id);
  const anyClassGuardHelps = cases.some((c) => c.classGuard);
  const retirable = missing.length === 0 && lost.length === 0 && anyClassGuardHelps && noisy.length === 0;
  const reason =
    missing.length > 0
      ? `no result for: ${missing.join(", ")}`
      : lost.length > 0
        ? `switching it off loses ${lost.length} bug(s) that no class guard catches: ${lost.join(", ")}`
        : !anyClassGuardHelps
          ? "no class guard catches any benchmark bug, so nothing has replaced this specialist. Losing no bug on this benchmark only shows the other specialists overlap with it here."
          : noisy.length > 0
            ? `a class guard still fails after the real fix: ${noisy.join(", ")}`
            : "every bug it helped find is still found without it or caught by a class guard";
  return {
    specialist,
    cases,
    recallBaseline: n((c) => c.baseline),
    recallWithout: n((c) => c.without),
    recallWithoutPlusClassGuards: n((c) => c.without || c.classGuard),
    lost,
    retirable,
    reason,
  };
};

export const hitMap = ({ caseFile, resultsDir }: { caseFile: CaseFile; resultsDir: string }): Map<string, boolean> => {
  const out = new Map<string, boolean>();
  for (const c of caseFile.cases) {
    const saved = loadResult(resultsDir, `${c.id}-bug`);
    if (saved) out.set(c.id, saved.score.confirmedHit);
  }
  return out;
};

const yes = (b: boolean): string => (b ? "yes" : "no");

export const renderGuards = (reports: GuardReport[]): string =>
  [
    "# Guard proof",
    "",
    "A guard is proven on a case when it fails on the tree with the bug and passes on the tree with the real fix. No model is involved in this table.",
    "",
    "| guard | scope | kind | status | catches | still fails after the fix | could not run | reports left in fixed files |",
    "|---|---|---|---|---|---|---|---|",
    ...reports.map((r) => `| ${r.guard.id} | ${r.guard.scope} | ${r.guard.kind} | ${r.status} | ${r.catches.join(", ") || "-"} | ${r.noisy.join(", ") || "-"} | ${r.broken.join(", ") || "-"} | ${r.backlog ?? "-"} |`),
    "",
    `Proven: ${reports.filter((r) => r.status === "proven").length} of ${reports.length}. Class guards proven: ${reports.filter((r) => r.status === "proven" && r.guard.scope === "class").length}.`,
    "",
  ].join("\n");

export const renderRetirement = (r: Retirement): string =>
  [
    `# Retirement run: ${r.specialist}`,
    "",
    `Verdict: ${r.retirable ? "RETIRABLE on this benchmark" : "KEEP"}. ${r.reason}.`,
    "",
    `- Bugs confirmed with every specialist on: ${r.recallBaseline} of ${r.cases.length}`,
    `- Bugs confirmed with ${r.specialist} off: ${r.recallWithout} of ${r.cases.length}`,
    `- With ${r.specialist} off, plus class guards: ${r.recallWithoutPlusClassGuards} of ${r.cases.length}`,
    "",
    "Two runs of the same benchmark differ by chance as well as by the specialist. One lost or gained case is within that noise.",
    "A case guard is a regression test for one bug. It is listed but does not count towards retirement.",
    "",
    "| case | all on | specialist off | class guard catches | case guard catches |",
    "|---|---|---|---|---|",
    ...r.cases.map((c) => `| ${c.id} | ${yes(c.baseline)} | ${yes(c.without)} | ${yes(c.classGuard)} | ${yes(c.caseGuard)} |`),
    "",
  ].join("\n");
