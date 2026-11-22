import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportTree, fixedRanges, inRanges, type Range } from "./git.ts";
import { commitPatch, fixDiff, linesWith, removedTexts } from "./history.ts";
import { ident } from "./ident.ts";
import { runChecks, type CheckSpec } from "./layer0.ts";
import { packFor } from "./packs/index.ts";
import { dropDepLinks, type ReproConfig } from "./repro.ts";
import { reviewFile } from "./review.ts";
import { locateQuote } from "./cite.ts";
import type { GuardFile } from "./guard.ts";
import type { Cite, Fact, ModelFn, ReviewResult } from "./types.ts";
import { writeReview } from "./vault.ts";
import { parseGuide, type Guide, type ReviewOptions } from "./options.ts";
import { execFileSync } from "node:child_process";
import { generatedGuides, parseLog } from "./harness/outcomes.ts";
import { matchesAny } from "./harness/rules.ts";

/**
 * The generated notes a reviewer of this case may fairly see: written from the history that existed before the
 * commit that wrote the bug. The fix of the bug is later than that commit, so it cannot be among them.
 */
export const guidesAsOf = ({ repo, rev, file }: { repo: string; rev: string; file: string }): Guide[] => {
  const git = (args: string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const log = parseLog(git(["log", "-1000", "--no-merges", "--format=%x01%H%x09%ct%x09%s", "--name-only", `${rev}^`]));
  const files = git(["ls-tree", "-r", "--name-only", `${rev}^`]).split(/\r?\n/).filter(Boolean);
  return generatedGuides({ commits: log, rules: [], files, depth: 4 })
    .map((n) => parseGuide(n.name, n.text))
    .filter((g) => matchesAny(file, g.applies));
};

/**
 * `intro`: the commit that wrote the faulty lines. When set, the case is reviewed in patch mode: the tree as that
 * commit left it, with its diff and message, which is how a review happens in practice.
 */
export type Case = { id: string; fix: string; file: string; note: string; intro?: string };
export type CaseFile = { target: string; repo: string; paths: string[]; repro?: ReproConfig; extras?: string[]; checks?: CheckSpec[]; cases: Case[] };

/** The commit whose tree the reviewer sees. */
export const caseCommit = (c: Case, kind: "bug" | "control"): string => (kind === "control" ? c.fix : (c.intro ?? `${c.fix}^`));

/**
 * The lines that count as "the bug" in the reviewed tree. Whole-file mode: the lines the fix changed. Patch mode: the
 * tree is older than the fix, so line numbers do not carry over; the lines are found by the text the fix removed.
 */
export const caseRanges = ({ caseFile, c, kind, root }: { caseFile: CaseFile; c: Case; kind: "bug" | "control"; root: string }): Range[] => {
  if (kind === "control") return [];
  if (!c.intro) return fixedRanges({ repo: caseFile.repo, fix: c.fix, file: c.file });
  const full = path.resolve(root, c.file);
  if (!fs.existsSync(full)) return [];
  return linesWith({ text: fs.readFileSync(full, "utf8"), wanted: removedTexts(fixDiff({ repo: caseFile.repo, fix: c.fix, file: c.file })) });
};

/**
 * A finding counts as a hit only if its quoted text starts on a line the real fix changed (for an insertion, one of
 * the two lines around it). An earlier rule allowed 5 lines either side and counted neighbouring, unrelated findings.
 */
export const HIT_SLACK = 0;
/** Findings this close to the fix, but not on it, are reported apart as "near". They may be a different issue. */
export const NEAR_SLACK = 5;

export type Score = {
  id: string;
  kind: "bug" | "control";
  file: string;
  /** Lines of the buggy file that the real fix changed. Empty for a control. */
  ranges: Range[];
  /** A specialist raised a concern, or dismissed one on an unchecked assumption, on the fixed lines. */
  candidateHit: boolean;
  /** A specialist looked at the fixed lines and ruled them fine, citing local proof. It saw the spot and missed the bug. */
  dismissedHit: boolean;
  /** Nothing on the fixed lines, but something within NEAR_SLACK lines. Possibly a different issue. */
  nearOnly: boolean;
  /** Candidates on the fixed lines that never reached a verifier. */
  uncheckedHit: boolean;
  /** A verifier confirmed a finding on the fixed lines. */
  confirmedHit: boolean;
  /** A failing test showed the bug on the fixed lines. The strongest result. */
  reproducedHit: boolean;
  /**
   * A test failed on the buggy tree and passes on the tree after the real fix. This does not depend on line numbers:
   * the test shows by execution that the finding is the bug the fix removed. The strongest result in the benchmark.
   */
  guardProven: boolean;
  confirmed: number;
  /** Confirmed findings away from the fixed lines. Not known to be wrong: nobody has checked them. */
  confirmedElsewhere: number;
  reproduced: number;
  testPassed: number;
  testBroken: number;
  notAttempted: number;
  modelCalls: number;
  seconds: number;
  errors: number;
  /** Dismissals a specialist called proven by the code it read; how many of those a verifier looked at; how many it found to be bugs. */
  localDismissals?: number;
  localAudited?: number;
  localOverturned?: number;
  /** Deterministic checks that ran, and that could not run, before the review. */
  checksRan?: number;
  checksBroken?: number;
  /** Specialist calls under the reading rule: how many there were, how many passed it, how many needed a second attempt. */
  readRequired?: number;
  readPassed?: number;
  readRetried?: number;
  patch?: boolean;
};

export type Locate = (cite: Cite) => number | null;

export const score = ({ id, kind, ranges, review, seconds, locate }: { id: string; kind: "bug" | "control"; ranges: Range[]; review: ReviewResult; seconds: number; locate: Locate }): Score => {
  // The quote's real line, not the line number the model wrote down.
  const at = (cite: Cite): number => locate(cite) ?? cite.line;
  const onFix = (cite: Cite): boolean => cite.file === review.file && inRanges({ line: at(cite), ranges, slack: HIT_SLACK });
  const near = (cite: Cite): boolean => cite.file === review.file && inRanges({ line: at(cite), ranges, slack: NEAR_SLACK });
  const confirmed = review.checked.filter((c) => c.verdict === "confirmed");
  const hits = confirmed.filter((c) => onFix(c.cite));
  const raised = [...review.candidates, ...review.dismissals.filter((d) => d.proof === "assumed")];
  const candidateHit = raised.some((c) => onFix(c.cite));
  const status = (s: string): number => confirmed.filter((c) => c.repro?.status === s).length;
  return {
    id,
    kind,
    file: review.file,
    ranges,
    candidateHit,
    dismissedHit: !candidateHit && review.dismissals.some((d) => d.proof === "local" && onFix(d.cite)),
    nearOnly: !candidateHit && raised.some((c) => near(c.cite)),
    uncheckedHit: review.unchecked.some((c) => onFix(c.cite)),
    confirmedHit: hits.length > 0,
    reproducedHit: hits.some((c) => c.repro?.status === "reproduced"),
    guardProven: confirmed.some((c) => c.repro?.status === "reproduced" && c.repro.afterFix === "passes"),
    confirmed: confirmed.length,
    confirmedElsewhere: confirmed.length - hits.length,
    reproduced: status("reproduced"),
    testPassed: status("test-passed"),
    testBroken: status("test-broken"),
    notAttempted: status("not-attempted"),
    modelCalls: review.modelCalls,
    seconds,
    errors: review.errors.length,
    localDismissals: review.localDismissals ?? review.dismissals.filter((d) => d.proof === "local").length,
    localAudited: review.localAudited ?? 0,
    localOverturned: review.checked.filter((c) => c.origin === "local-dismissal" && c.verdict === "confirmed").length,
    checksRan: review.facts.filter((f) => f.ran !== false).length,
    checksBroken: review.facts.filter((f) => f.ran === false).length,
    readRequired: (review.reading ?? []).filter((r) => r.required > 0).length,
    readPassed: (review.reading ?? []).filter((r) => r.required > 0 && r.verified >= r.required).length,
    readRetried: (review.reading ?? []).filter((r) => r.retried).length,
    patch: review.patch === true,
  };
};

const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${n} of ${d} (${Math.round((100 * n) / d)}%)`);

export const summarize = ({ scores, model, repro }: { scores: Score[]; model: string; repro: boolean }): string => {
  const bugs = scores.filter((s) => s.kind === "bug");
  const controls = scores.filter((s) => s.kind === "control");
  const sum = (xs: Score[], f: (s: Score) => number): number => xs.reduce((a, s) => a + f(s), 0);
  const yes = (b: boolean): string => (b ? "yes" : "no");
  return [
    "# Ratchet benchmark",
    "",
    `Model: ${model}. Cases scored: ${scores.length}. Model calls: ${sum(scores, (s) => s.modelCalls)}. Wall time: ${Math.round(sum(scores, (s) => s.seconds) / 60)} min. Reproduction step: ${repro ? "on" : "off"}.`,
    "",
    "Each bug case is a real fix commit. The reviewer sees the tree one commit before the fix, with no git history, confined to that tree, and is told only which file to review.",
    "A hit means a finding whose quoted text starts on a line the real fix changed. Each control is the same file just after the fix.",
    "A hit is still positional: it shows the reviewer pointed at the right line, not that it named the right fault. Only a ruling or a reproduction settles that.",
    "",
    `- Bugs raised by a specialist on the fixed lines: ${pct(bugs.filter((s) => s.candidateHit).length, bugs.length)}`,
    `- Bugs where a specialist looked at the fixed lines and ruled them fine: ${bugs.filter((s) => s.dismissedHit).length}`,
    `- Bugs with a candidate only near the fix (within ${NEAR_SLACK} lines; may be the same fault cited on a neighbouring line, or a different issue): ${bugs.filter((s) => s.nearOnly).length}`,
    `- Bugs raised on the fixed lines that never reached a verifier: ${bugs.filter((s) => s.uncheckedHit && !s.confirmedHit).length}`,
    `- Bugs confirmed by a verifier: ${pct(bugs.filter((s) => s.confirmedHit).length, bugs.length)}`,
    ...(repro
      ? [
          `- Bugs reproduced by a failing test: ${pct(bugs.filter((s) => s.reproducedHit).length, bugs.length)}`,
          `- Bugs shown by execution, wherever the finding was cited (test fails before the real fix, passes after): ${pct(bugs.filter((s) => s.guardProven).length, bugs.length)}`,
          `- All confirmed findings, bug cases: ${sum(bugs, (s) => s.confirmed)}. Reproduced ${sum(bugs, (s) => s.reproduced)}, test passed ${sum(bugs, (s) => s.testPassed)}, test broken ${sum(bugs, (s) => s.testBroken)}, no test attempted ${sum(bugs, (s) => s.notAttempted)}.`,
        ]
      : []),
    `- Confirmed findings away from the fixed lines, bug cases: ${sum(bugs, (s) => s.confirmedElsewhere)} (nobody has checked these: real bugs or false alarms)`,
    `- Controls with at least one confirmed finding: ${pct(controls.filter((s) => s.confirmed > 0).length, controls.length)} (${sum(controls, (s) => s.confirmed)} findings; same caveat)`,
    `- Dismissals a specialist called proven by local code: ${sum(scores, (s) => s.localDismissals ?? 0)}. Sent to a verifier anyway: ${sum(scores, (s) => s.localAudited ?? 0)}. Found to be bugs: ${sum(scores, (s) => s.localOverturned ?? 0)}.`,
    `- Specialists required to read other files: ${sum(scores, (s) => s.readRequired ?? 0)}. Passed the check: ${sum(scores, (s) => s.readPassed ?? 0)}. Needed a second attempt: ${sum(scores, (s) => s.readRetried ?? 0)}.`,
    `- Deterministic checks before the review: ${sum(scores, (s) => s.checksRan ?? 0)} ran, ${sum(scores, (s) => s.checksBroken ?? 0)} could not run.`,
    `- Cases reviewed as a patch (the commit that wrote the bug, with its diff and message): ${scores.filter((s) => s.patch === true).length} of ${scores.length}`,
    `- Cases with a reviewer error: ${scores.filter((s) => s.errors > 0).length}`,
    "",
    "| case | kind | raised | confirmed on fix | reproduced on fix | guard proven | confirmed elsewhere | calls | s |",
    "|---|---|---|---|---|---|---|---|---|",
    ...scores.map((s) => {
      const b = s.kind === "bug";
      return `| ${s.id} | ${s.kind} | ${b ? yes(s.candidateHit) : "-"} | ${b ? yes(s.confirmedHit) : "-"} | ${b && repro ? yes(s.reproducedHit) : "-"} | ${b && repro ? yes(s.guardProven) : "-"} | ${s.confirmedElsewhere} | ${s.modelCalls} | ${s.seconds} |`;
    }),
    "",
  ].join("\n");
};

/** Looks a quote up in a tree on disk. */
export const locator = (root: string): Locate => {
  const cache = new Map<string, string | null>();
  return (cite) => {
    if (!cache.has(cite.file)) {
      const full = path.resolve(root, cite.file);
      cache.set(cite.file, fs.existsSync(full) && fs.statSync(full).isFile() ? fs.readFileSync(full, "utf8") : null);
    }
    const text = cache.get(cite.file);
    return text ? locateQuote({ text, line: cite.line, quote: cite.quote }) : null;
  };
};

/** Recomputes the score of every saved review under the current rule. Exports each tree again; calls no model. */
export const rescoreBench = ({ caseFile, resultsDir, modelName, repro }: { caseFile: CaseFile; resultsDir: string; modelName: string; repro: boolean }): string => {
  const work = path.join(os.tmpdir(), "ratchet-work");
  const scores: Score[] = [];
  for (const c of caseFile.cases) {
    for (const kind of ["bug", "control"] as const) {
      const id = `${c.id}-${kind}`;
      const file = path.join(resultsDir, `${id}.json`);
      if (!fs.existsSync(file)) continue;
      const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { score: Score; review: ReviewResult };
      const dest = path.join(work, `rescore-${id}`);
      exportTree({ repo: caseFile.repo, commit: caseCommit(c, kind), dest, paths: caseFile.paths });
      const ranges = caseRanges({ caseFile, c, kind, root: dest });
      const pending = kind === "bug" && caseFile.repro ? saved.review.checked.filter((x) => x.repro?.status === "reproduced" && !x.repro.afterFix) : [];
      if (pending.length > 0 && caseFile.repro) {
        const fixed = path.join(work, `rescore-${id}-fixed`);
        exportTree({ repo: caseFile.repo, commit: c.fix, dest: fixed, paths: caseFile.paths });
        const runner = packFor(c.file).runner(caseFile.repro);
        for (const x of pending) {
          if (!x.repro) continue;
          const run = runner({ root: fixed, code: x.repro.test, name: `ratchet_${ident(x.cite)}` });
          x.repro.afterFix = run.outcome === "passed" ? "passes" : run.outcome === "failed-assertion" ? "still-fails" : "error";
        }
        dropDepLinks({ root: fixed, pkg: caseFile.repro.pkg });
        fs.rmSync(fixed, { recursive: true, force: true });
      }
      const s = score({ id, kind, ranges, review: saved.review, seconds: saved.score.seconds, locate: locator(dest) });
      fs.rmSync(dest, { recursive: true, force: true });
      fs.writeFileSync(file, JSON.stringify({ score: s, review: saved.review }, null, 2));
      scores.push(s);
    }
  }
  const summary = summarize({ scores, model: modelName, repro });
  fs.writeFileSync(path.join(resultsDir, "SUMMARY.md"), summary);
  return summary;
};

/**
 * Runs the class lint guards on the file and reports what they said as facts. This is how a guard that was earned
 * from a past bug reaches the next review: as a deterministic result the reviewers read before they start.
 */
export const guardFacts = ({ guardsDir, root, config, file }: { guardsDir: string; root: string; config: ReproConfig; file: string }): Fact[] => {
  const guardFile = path.join(guardsDir, "guards.json");
  if (!fs.existsSync(guardFile)) return [];
  const lint = packFor(file).lint?.(config);
  return (JSON.parse(fs.readFileSync(guardFile, "utf8")) as GuardFile).guards
    .filter((g) => g.scope === "class" && g.kind === "lint" && g.configFile)
    .map((g) => {
      const command = `lint rule ${g.id}: ${g.title}`;
      const found = lint ? lint({ root, file, configCode: fs.readFileSync(path.join(guardsDir, g.configFile ?? ""), "utf8") }) : null;
      if (found === null) return { command, exitCode: 2, tail: "", ran: false };
      return { command, exitCode: found.length === 0 ? 0 : 1, tail: found.slice(0, 25).map((v) => `${file}:${v.line} ${v.message}`).join("\n"), ran: true };
    });
};

export type BenchArgs = {
  caseFile: CaseFile;
  resultsDir: string;
  model: ModelFn;
  modelName: string;
  limit: number;
  controls: boolean;
  repro: boolean;
  only?: string;
  without?: string[];
  vault?: string;
  /** Locally proven dismissals to verify per case. */
  auditLocal?: number;
  /** Other files each specialist must show it read. */
  requireReads?: number;
  /** The optional review mechanisms (options.ts), per reviewed file. Off unless given. */
  optionsFor?: (file: string) => ReviewOptions;
  /** S12: add the notes generated from the history before each bug was written. */
  generatedGuides?: boolean;
  /** A guards folder: its class lint guards run before each review and reach the reviewers as facts. */
  guardsDir?: string;
  log: (line: string) => void;
};

/** Runs the cases that have no saved result yet, one at a time, saving after each. Safe to stop and start again. */
export const runBench = async ({ caseFile, resultsDir, model, modelName, limit, controls, repro, only, without, vault, auditLocal = 0, requireReads = 0, guardsDir, optionsFor, generatedGuides: withNotes = false, log }: BenchArgs): Promise<string> => {
  fs.mkdirSync(resultsDir, { recursive: true });
  const work = path.join(os.tmpdir(), "ratchet-work");
  const config = repro ? caseFile.repro : undefined;
  if (repro && !config) throw new Error("the cases file has no repro settings");
  const jobs = caseFile.cases.filter((c) => !only || c.id === only).flatMap((c) => [{ c, kind: "bug" as const }, ...(controls ? [{ c, kind: "control" as const }] : [])]);
  const checks = caseFile.checks ?? [];
  let ran = 0;
  for (const { c, kind } of jobs) {
    const id = `${c.id}-${kind}`;
    const out = path.join(resultsDir, `${id}.json`);
    if (fs.existsSync(out)) continue;
    if (ran >= limit) break;
    ran += 1;
    const dest = path.join(work, id);
    const runner = config ? packFor(c.file).runner(config) : undefined;
    const commit = caseCommit(c, kind);
    exportTree({ repo: caseFile.repo, commit, dest, paths: caseFile.paths });
    const started = Date.now();
    // Layer 0: the type checker and the linter speak first; the reviewers get what they said as facts.
    const facts = [
      ...(checks.length > 0 && caseFile.repro ? runChecks({ root: dest, config: caseFile.repro, checks, file: c.file }) : []),
      ...(guardsDir && caseFile.repro ? guardFacts({ guardsDir, root: dest, config: caseFile.repro, file: c.file }) : []),
    ];
    for (const f of facts) log(`${id}: check ${f.ran === false ? "could not run" : f.exitCode === 0 ? "passed" : "reported problems"}: ${f.command.slice(0, 70)}`);
    const patch = kind === "bug" && c.intro ? commitPatch({ repo: caseFile.repo, rev: c.intro, file: c.file }) : undefined;
    log(`${id}: reviewing ${c.file}${patch ? " as a patch" : ""}`);
    const base = optionsFor ? optionsFor(c.file) : {};
    const notes = withNotes && c.intro ? guidesAsOf({ repo: caseFile.repo, rev: c.intro, file: c.file }) : [];
    if (withNotes) log(`${id}: ${notes.length} generated note(s) from the history before ${c.intro ?? "(no commit)"}`);
    const options: ReviewOptions = notes.length > 0 ? { ...base, guides: [...(base.guides ?? []), ...notes] } : base;
    const review = await reviewFile({ root: dest, file: c.file, model, facts, auditLocal, requireReads, options, ...(patch ? { patch } : {}), ...(config && runner ? { repro: { pkg: config.pkg, runner } } : {}), ...(caseFile.extras ? { extras: caseFile.extras } : {}), ...(without ? { without } : {}) });
    const ranges = caseRanges({ caseFile, c, kind, root: dest });
    const locate = locator(dest);

    // Guard proof: a test that failed on the buggy tree should pass on the tree after the real fix.
    if (kind === "bug" && runner && config) {
      const hits = review.checked.filter((x) => x.repro?.status === "reproduced");
      if (hits.length > 0) {
        const fixed = path.join(work, `${id}-fixed`);
        exportTree({ repo: caseFile.repo, commit: c.fix, dest: fixed, paths: caseFile.paths });
        for (const x of hits) {
          if (!x.repro) continue;
          const run = runner({ root: fixed, code: x.repro.test, name: `ratchet_${ident(x.cite)}` });
          x.repro.afterFix = run.outcome === "passed" ? "passes" : run.outcome === "failed-assertion" ? "still-fails" : "error";
        }
        dropDepLinks({ root: fixed, pkg: config.pkg });
        fs.rmSync(fixed, { recursive: true, force: true });
      }
    }

    const seconds = Math.round((Date.now() - started) / 1000);
    const s = score({ id, kind, ranges, review, seconds, locate });
    fs.writeFileSync(out, JSON.stringify({ score: s, review }, null, 2));
    if (vault && kind === "bug") writeReview({ vault, review, meta: { target: caseFile.target, commit, model: modelName, when: new Date(started).toISOString() } });
    if (config) dropDepLinks({ root: dest, pkg: config.pkg });
    fs.rmSync(dest, { recursive: true, force: true });
    log(`${id}: ${kind === "bug" ? `raised=${s.candidateHit} confirmed=${s.confirmedHit}${repro ? ` reproduced=${s.reproducedHit} guard=${s.guardProven}` : ""}` : `confirmed=${s.confirmed}`} in ${seconds}s`);
  }
  const scores = fs
    .readdirSync(resultsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => (JSON.parse(fs.readFileSync(path.join(resultsDir, f), "utf8")) as { score: Score }).score);
  const summary = summarize({ scores, model: modelName, repro });
  fs.writeFileSync(path.join(resultsDir, "SUMMARY.md"), summary);
  return summary;
};
