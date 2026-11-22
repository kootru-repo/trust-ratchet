import { createHash } from "node:crypto";
import { MIN_RUNS_PER_SIDE, median, verdict, type Verdict } from "./outcomes2.ts";

/** the proof plan row 19 and 6c rows 1 and 19. Pure: no clock, no file, no process. */

/** The exit condition, a checkable predicate over one measured number (lower is better, e.g. failures). */
export type ExitPredicate = { metric: string; op: "<=" | "=="; target: number };
export type Budget = {
  /** Effort: most iterations in the cycle. */
  maxIterations: number;
  /** Risk: size of one proposed change. */
  maxFiles: number;
  maxLines: number;
  /** Consecutive attempts that did not help before the cycle pivots. */
  plateauAfter: number;
};
export type Patch = { files: number; lines: number };
export type ResetRecord = { attempt: number; runId: string; base: string; cleared: string[] };
export type Ending = { kind: "done" | "stopped" | "condition-changed"; reason: string };

export type CycleState = {
  predicate: ExitPredicate;
  /** Hash fixed before iteration 1; a different predicate is refused. */
  predicateHash: string;
  budget: Budget;
  iteration: number;
  kept: number;
  discarded: number;
  noHelpInARow: number;
  pivots: number;
  /** Median of the last kept side, null before any claim. */
  best: number | null;
  attempt: number;
  resets: ResetRecord[];
  ended: Ending | null;
};

export const hashPredicate = (p: ExitPredicate): string => createHash("sha256").update(JSON.stringify([p.metric, p.op, p.target])).digest("hex").slice(0, 16);

export const meets = (p: ExitPredicate, value: number): boolean => Number.isFinite(value) && (p.op === "<=" ? value <= p.target : value === p.target);

export const startCycle = (predicate: ExitPredicate, budget: Budget): CycleState => {
  if (!Number.isFinite(predicate.target)) throw new Error("the exit predicate needs a finite target");
  if (budget.maxIterations < 1 || budget.maxFiles < 1 || budget.maxLines < 1 || budget.plateauAfter < 1) throw new Error("every budget field must be at least 1");
  return { predicate, predicateHash: hashPredicate(predicate), budget, iteration: 0, kept: 0, discarded: 0, noHelpInARow: 0, pivots: 0, best: null, attempt: 1, resets: [], ended: null };
};

export type Action = "keep" | "discard" | "pivot" | "done" | "stop" | "refuse";
export type StepInput = {
  /** The predicate as the caller holds it now; must match the one recorded. */
  predicate: ExitPredicate;
  /** Alternating runs of the metric on the reference and on the changed build. */
  base: number[];
  candidate: number[];
  errors?: number;
  patch: Patch;
};
export type StepResult = { state: CycleState; action: Action; reason: string; verdict: Verdict | null };

const end = (s: CycleState, action: Action, ending: Ending, v: Verdict | null): StepResult => ({ state: { ...s, ended: ending }, action, reason: ending.reason, verdict: v });

/**
 * One iteration. Order: ended cycle, changed predicate, size budget, effort budget, measured verdict.
 * keep only on a "faster" verdict with n; anything else, including inconclusive, discards. A plateau returns
 * "pivot": the cycle never stops on it and never relaxes the predicate.
 */
export const step = (s: CycleState, input: StepInput): StepResult => {
  if (s.ended) return { state: s, action: "refuse", reason: `cycle already ended: ${s.ended.reason}`, verdict: null };
  if (hashPredicate(input.predicate) !== s.predicateHash) {
    return end(s, "refuse", { kind: "condition-changed", reason: `exit predicate changed from ${JSON.stringify(s.predicate)} to ${JSON.stringify(input.predicate)}` }, null);
  }
  if (s.iteration >= s.budget.maxIterations) return end(s, "stop", { kind: "stopped", reason: `effort budget spent: ${s.budget.maxIterations} iterations` }, null);
  if (input.patch.files > s.budget.maxFiles || input.patch.lines > s.budget.maxLines) {
    return end(s, "stop", { kind: "stopped", reason: `risk budget: patch of ${input.patch.files} files and ${input.patch.lines} lines exceeds ${s.budget.maxFiles} files and ${s.budget.maxLines} lines; no patch` }, null);
  }
  const v = verdict({ base: input.base, candidate: input.candidate, errors: input.errors ?? 0, minRuns: MIN_RUNS_PER_SIDE });
  const iteration = s.iteration + 1;
  if (v.word === "faster") {
    const value = median(input.candidate);
    const next: CycleState = { ...s, iteration, kept: s.kept + 1, noHelpInARow: 0, best: value };
    if (meets(s.predicate, value)) return end(next, "done", { kind: "done", reason: `${s.predicate.metric} ${s.predicate.op} ${s.predicate.target} met: median ${value} (n ${v.nCandidate})` }, v);
    return { state: next, action: "keep", reason: `advanced: ${v.reason}`, verdict: v };
  }
  const noHelpInARow = s.noHelpInARow + 1;
  const base: CycleState = { ...s, iteration, discarded: s.discarded + 1, noHelpInARow };
  if (noHelpInARow >= s.budget.plateauAfter) {
    return { state: { ...base, noHelpInARow: 0, pivots: s.pivots + 1 }, action: "pivot", reason: `plateau after ${noHelpInARow} attempts that did not help: pivot, finish condition unchanged`, verdict: v };
  }
  return { state: base, action: "discard", reason: `discarded, did not help: ${v.word} (${v.reason})`, verdict: v };
};

/**
 * A second attempt (after a pivot) must be independent: a new run id, the same recorded base, and a list of what
 * was cleared. Refused when it reuses the previous run, clears nothing or starts from another base.
 */
export const resetForAttempt = (s: CycleState, r: { runId: string; base: string; cleared: string[] }): { ok: true; state: CycleState } | { ok: false; reason: string } => {
  const prev = s.resets[s.resets.length - 1];
  if (r.cleared.length === 0) return { ok: false, reason: "reset clears no state, the second attempt would not be independent" };
  if (prev && prev.runId === r.runId) return { ok: false, reason: `run ${r.runId} was already used by attempt ${prev.attempt}` };
  if (prev && prev.base !== r.base) return { ok: false, reason: `base ${r.base} differs from the recorded base ${prev.base}` };
  const rec: ResetRecord = { attempt: s.attempt + 1, runId: r.runId, base: r.base, cleared: r.cleared };
  return { ok: true, state: { ...s, attempt: s.attempt + 1, resets: [...s.resets, rec] } };
};
