import { execFileSync } from "node:child_process";
import { outcomes, parseLog, type Commit } from "./outcomes.ts";

/** The row 17 instrument: outcomes read from git history by program, and a verdict on a set of alternating runs. */

export type HistoryOutcomes = {
  /** Commits counted: no claim is made without it. */
  n: number;
  fixes: number;
  reverts: number;
  fixOfFix: number;
  /** Shares; null when the count they divide by is 0. */
  fixShare: number | null;
  fixOfFixShare: number | null;
  revertShare: number | null;
};

const share = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole);

/** Pure: the three numbers and their shares from commits already read. */
export const historyOutcomesOf = ({ commits, days = 14 }: { commits: Commit[]; days?: number }): HistoryOutcomes => {
  const o = outcomes({ commits, days });
  return {
    n: o.commits,
    fixes: o.fixes,
    reverts: o.reverts,
    fixOfFix: o.fixOfFix,
    fixShare: share(o.fixes, o.commits),
    fixOfFixShare: share(o.fixOfFix, o.fixes),
    revertShare: share(o.reverts, o.commits),
  };
};

/** Reads the log of `repo` (optionally one `program` path and a `since` date) and computes the outcomes. */
export const historyOutcomes = ({ repo, program, since, days }: { repo: string; program?: string; since?: string; days?: number }): HistoryOutcomes => {
  const args = ["-C", repo, "log", "--format=%x01%H%x09%ct%x09%s", "--name-only"];
  if (since !== undefined) args.push(`--since=${since}`);
  if (program !== undefined) args.push("--", program);
  const out = execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return historyOutcomesOf({ commits: parseLog(out), days });
};

export const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? (s[mid] ?? NaN) : ((s[mid - 1] ?? NaN) + (s[mid] ?? NaN)) / 2;
};

export type Range = { min: number; max: number };
export const rangeOf = (xs: number[]): Range => ({ min: Math.min(...xs), max: Math.max(...xs) });

export type Word = "faster" | "slower" | "no measurable difference" | "inconclusive";
export type Verdict = {
  word: Word;
  /** Runs on each side: every verdict carries it. */
  nBase: number;
  nCandidate: number;
  medianBase: number | null;
  medianCandidate: number | null;
  rangeBase: Range | null;
  rangeCandidate: Range | null;
  /** Absolute gap of medians and the run-to-run variation it was compared with. */
  gap: number | null;
  variation: number | null;
  reason: string;
};

export const MIN_RUNS_PER_SIDE = 5;

/**
 * Pure: the word for two sets of alternating runs of a number where lower is better (a time, a size).
 * `base` is the reference side and `candidate` the side that changed. A gap of medians no larger than the larger
 * of the two ranges is "no measurable difference". Fewer than `minRuns` a side, a value that is not a finite
 * number, or an error count above zero makes it "inconclusive": never a claim without n.
 */
export const verdict = ({ base, candidate, errors = 0, minRuns = MIN_RUNS_PER_SIDE }: { base: number[]; candidate: number[]; errors?: number; minRuns?: number }): Verdict => {
  const blank = (reason: string): Verdict => ({ word: "inconclusive", nBase: base.length, nCandidate: candidate.length, medianBase: null, medianCandidate: null, rangeBase: null, rangeCandidate: null, gap: null, variation: null, reason });
  if (base.length < minRuns || candidate.length < minRuns) return blank(`fewer than ${minRuns} runs a side (${base.length} and ${candidate.length})`);
  if (![...base, ...candidate].every((x) => Number.isFinite(x))) return blank("a run has no finite value");
  if (errors > 0) return blank(`${errors} runs errored`);
  const mb = median(base);
  const mc = median(candidate);
  const rb = rangeOf(base);
  const rc = rangeOf(candidate);
  const gap = Math.abs(mc - mb);
  const variation = Math.max(rb.max - rb.min, rc.max - rc.min);
  const common = { nBase: base.length, nCandidate: candidate.length, medianBase: mb, medianCandidate: mc, rangeBase: rb, rangeCandidate: rc, gap, variation };
  if (gap <= variation) return { word: "no measurable difference", ...common, reason: `gap ${gap} is within the run-to-run range ${variation}` };
  return { word: mc < mb ? "faster" : "slower", ...common, reason: `gap ${gap} is beyond the run-to-run range ${variation}` };
};

export const renderVerdict = (label: string, v: Verdict): string =>
  v.word === "inconclusive"
    ? `${label}: inconclusive (n ${v.nBase} and ${v.nCandidate}): ${v.reason}.`
    : `${label}: ${v.word} (n ${v.nBase} and ${v.nCandidate}; medians ${v.medianBase} and ${v.medianCandidate}; ranges ${v.rangeBase?.min}-${v.rangeBase?.max} and ${v.rangeCandidate?.min}-${v.rangeCandidate?.max}).`;
