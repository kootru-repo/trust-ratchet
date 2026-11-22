// SPDX-License-Identifier: AGPL-3.0-only
import type { ProjectConfig } from "./state.ts";

/**
 * The turn-end limits and how the loop corrects them. Everything here is pure: it reads turn records and a config
 * and says what the limits are, what the ceiling is, and whether to move. A person's value is the floor. The loop's
 * own value is kept apart (config.autoLimits) and the larger of the two is used, so the loop can only take back
 * what it added itself.
 */

/** The hook's own timeout for a Stop (install.ts) and the room left under it for writing the record. */
export const STOP_TIMEOUT_S = 200;
export const STOP_MARGIN_S = 30;
export const DEFAULT_TESTS = 3;
export const DEFAULT_BUDGET_S = 120;
export const BUDGET_STEP_S = 15;

export const OVER_COUNT = "over the limit of";
export const OUT_OF_BUDGET = "time budget used up";
export const CUT_BY_BUDGET = "cut short by the time budget of the turn checks";

export type SkipCause = "count" | "budget" | "cut";
/** Pure: why a command did not run, where the reason is one of the turn-end limits. Anything else is null. */
export const skipCause = (o: { status: string; note?: string }): SkipCause | null => {
  if (o.status !== "not-run") return null;
  const note = o.note ?? "";
  return note.startsWith(OVER_COUNT) ? "count" : note.startsWith(OUT_OF_BUDGET) ? "budget" : note.startsWith(CUT_BY_BUDGET) ? "cut" : null;
};

export type Limits = { tests: number; budgetS: number; floorTests: number; floorBudgetS: number };
/** Pure: the limits in force. The floor is the person's value or the default; the loop's value counts only above it. */
export const effectiveLimits = (config: ProjectConfig): Limits => {
  const floorTests = config.maxTestsPerStop ?? DEFAULT_TESTS;
  const floorBudgetS = config.budgetS?.stop ?? DEFAULT_BUDGET_S;
  return { floorTests, floorBudgetS, tests: Math.max(floorTests, config.autoLimits?.tests ?? 0), budgetS: Math.min(STOP_TIMEOUT_S - STOP_MARGIN_S, Math.max(floorBudgetS, config.autoLimits?.budgetS ?? 0)) };
};

export type RecordLike = { time: string; sessionId: string; outcomes: { kind: string; name: string; status: string; seconds: number; note?: string }[]; wallS?: number; fileS?: number };
export type TurnStat = { time: string; sessionId: string; ranSeconds: number; wallS: number; fileS: number; testSeconds: number[]; otherSeconds: number; overCount: string[]; outOfBudget: string[]; cut: string[]; /** Tests left unrun by a limit here and at the turn before it in the same session. */ stillOwed: string[] };

/**
 * Pure: one line of numbers per turn that ran something. A turn that ran nothing (every command already passed, or
 * nothing matched) says nothing about the limits and is left out: it would read as an empty budget and push a raise.
 */
export const turnStats = (records: RecordLike[]): TurnStat[] => {
  const before = new Map<string, Set<string>>();
  return records.flatMap((r) => {
    const ran = r.outcomes.filter((o) => o.seconds > 0);
    const owedNow = new Set(r.outcomes.filter((o) => o.kind === "test" && ["count", "budget"].includes(skipCause(o) ?? "")).map((o) => o.name));
    const owedBefore = before.get(r.sessionId) ?? new Set<string>();
    before.set(r.sessionId, owedNow);
    const skipped = (cause: SkipCause): string[] => r.outcomes.filter((o) => skipCause(o) === cause).map((o) => o.name);
    const stat: TurnStat = {
      time: r.time,
      sessionId: r.sessionId,
      ranSeconds: ran.reduce((s, o) => s + o.seconds, 0),
      wallS: r.wallS ?? ran.reduce((s, o) => s + o.seconds, 0),
      fileS: r.fileS ?? 0,
      testSeconds: ran.filter((o) => o.kind === "test").map((o) => o.seconds),
      otherSeconds: ran.filter((o) => o.kind !== "test").reduce((s, o) => s + o.seconds, 0),
      overCount: skipped("count"),
      outOfBudget: skipped("budget"),
      cut: skipped("cut"),
      stillOwed: [...owedNow].filter((n) => owedBefore.has(n)),
    };
    return ran.length > 0 || stat.cut.length > 0 || stat.outOfBudget.length > 0 ? [stat] : [];
  });
};

const quantile = (values: number[], q: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};

export type Ceiling = { tests: number; budgetS: number; why: string };
/**
 * Pure: how far the limits may go, from the project's own times. The budget may reach the hook's timeout less the
 * margin and less what the file checks take before the budget starts. The count may reach what fits in the budget
 * in force after the commands that are not tests, at the slow end of this project's tests, and never more than the
 * tests there are. Mapped tests and written tests each have the count, so one test of the count is paid for twice.
 */
export const ceiling = ({ stats, limits, mapped, written }: { stats: TurnStat[]; limits: Limits; mapped: number; written: number }): Ceiling => {
  const budgetS = Math.max(limits.floorBudgetS, Math.floor(STOP_TIMEOUT_S - STOP_MARGIN_S - quantile(stats.map((s) => s.fileS), 0.9)));
  const slowTest = quantile(stats.flatMap((s) => s.testSeconds), 0.9);
  const other = quantile(stats.map((s) => s.otherSeconds), 0.5);
  if (slowTest <= 0) return { tests: limits.floorTests, budgetS, why: "no test has been timed at a turn end yet, so the count stays at its floor" };
  // A count of c pays for c mapped tests and, beside them, for as many written tests as there are, up to c.
  const room = limits.budgetS - other;
  let fits = 0;
  while (fits < Math.max(mapped, written) && (fits + 1 + Math.min(fits + 1, written)) * slowTest <= room) fits += 1;
  const tests = Math.max(limits.floorTests, fits);
  return { tests, budgetS, why: `a slow test here takes ${slowTest.toFixed(1)} s, the other commands ${other.toFixed(1)} s, the budget is ${limits.budgetS} s${written > 0 ? `, and the ${written} written test(s) run beside the mapped ones` : ""}` };
};

export type Move = { tests: number; budgetS: number; what: string };
export type LastMove = { time: string; dir: "up" | "down" } | null;

/**
 * Pure: the one move of this pass, or null. Reads the last 10 turns that ran something.
 * Up: a test was left unrun at two turn ends running in at least half of them (one skip is paid back by the next
 * turn end, so it is no harm), and they used under 60 percent of the budget.
 * Down, never under the floor: a command was cut short by the budget in 2 of them.
 * A move needs new evidence: 3 turns recorded since the last move the same way, 5 since a move the other way.
 * The budget is never raised here: one Stop checks several repositories under one deadline, and what the others
 * need is not on record yet. A budget the loop holds can still come down.
 */
export const decide = ({ stats, limits, top, last, noRaise }: { stats: TurnStat[]; limits: Limits; top: Ceiling; last: LastMove; noRaise: boolean }): Move | null => {
  const window = stats.slice(-10);
  if (window.length < 5) return null;
  const since = last ? stats.filter((s) => s.time > last.time).length : Infinity;
  const cutTurns = window.filter((s) => s.cut.length > 0).length;
  const overTurns = window.filter((s) => s.stillOwed.length > 0).length;
  const use = quantile(window.map((s) => s.wallS), 0.9) / limits.budgetS;
  const may = (dir: "up" | "down"): boolean => !last || since >= (last.dir === dir ? 3 : 5);
  if (cutTurns >= 2 && may("down")) {
    if (limits.tests > limits.floorTests) return { tests: limits.tests - 1, budgetS: limits.budgetS, what: `the count of tests per turn end goes down from ${limits.tests} to ${limits.tests - 1}: a command was cut short by the time budget in ${cutTurns} of the last ${window.length} turns` };
    if (limits.budgetS > limits.floorBudgetS) {
      const next = Math.max(limits.floorBudgetS, limits.budgetS - BUDGET_STEP_S);
      return { tests: limits.tests, budgetS: next, what: `the time budget of the turn checks goes down from ${limits.budgetS} s to ${next} s: a command was cut short by it in ${cutTurns} of the last ${window.length} turns and the count is at its floor` };
    }
    return null;
  }
  if (noRaise || cutTurns > 0 || overTurns * 2 < window.length || use >= 0.6 || !may("up")) return null;
  const reason = `a test was left unrun at two turn ends running in ${overTurns} of the last ${window.length} turns, and those turns used ${Math.round(use * 100)} percent of the budget at their slow end`;
  if (limits.tests < top.tests) return { tests: limits.tests + 1, budgetS: limits.budgetS, what: `the count of tests per turn end goes up from ${limits.tests} to ${limits.tests + 1} (ceiling ${top.tests}: ${top.why}): ${reason}` };
  return null;
};

/** Pure: how many turn ends each test has been left unrun in a row, after one more turn. A test that ran starts again at none. */
export const nextWaits = (waits: Record<string, number>, outcomes: { kind: string; name: string; status: string; note?: string }[], mapped?: string[]): Record<string, number> => {
  // A test that is no longer mapped is no longer waiting.
  const out = Object.fromEntries(Object.entries(waits).filter(([name]) => !mapped || mapped.includes(name)));
  for (const o of outcomes) {
    if (o.kind !== "test") continue;
    const cause = skipCause(o);
    if (cause === "count" || cause === "budget") out[o.name] = (out[o.name] ?? 0) + 1;
    else delete out[o.name];
  }
  return out;
};

export type SessionEnd = { sessionId: string; turns: number; unrun: string[] };
/** Pure, the registered measure: per session, the tests still unrun (over the count or out of budget) at its last recorded turn. */
export const unrunAtEnd = (records: RecordLike[]): SessionEnd[] => {
  const by = new Map<string, RecordLike[]>();
  for (const r of [...records].sort((a, b) => a.time.localeCompare(b.time))) by.set(r.sessionId, [...(by.get(r.sessionId) ?? []), r]);
  return [...by.entries()].map(([sessionId, recs]) => {
    const lastRec = recs[recs.length - 1] as RecordLike;
    return { sessionId, turns: recs.length, unrun: lastRec.outcomes.filter((o) => o.kind === "test" && ["count", "budget"].includes(skipCause(o) ?? "")).map((o) => o.name) };
  });
};

export type Replay = { sessions: number; turns: number; unrunBefore: number; unrunAfter: number; extraRuns: number; extraSeconds: number; sessionsWithUnrun: number; sessionsWithUnrunAfter: number };
/**
 * Pure, an ESTIMATE: the same sessions with `extra` more tests allowed at every turn end, replayed per session in
 * order. A test the policy would have run early is taken as passed and not owed again until the record shows it ran
 * (its files changed). That is the kind reading: a file can change without the test being reached. Each extra run
 * is costed at that test's usual seconds, or the project's when it was never timed.
 */
export const replay = ({ records, extra }: { records: RecordLike[]; extra: number }): Replay => {
  const seconds = new Map<string, number[]>();
  for (const r of records) for (const o of r.outcomes) if (o.kind === "test" && o.seconds > 0) seconds.set(o.name, [...(seconds.get(o.name) ?? []), o.seconds]);
  const usual = quantile([...seconds.values()].flat(), 0.5);
  const out: Replay = { sessions: 0, turns: 0, unrunBefore: 0, unrunAfter: 0, extraRuns: 0, extraSeconds: 0, sessionsWithUnrun: 0, sessionsWithUnrunAfter: 0 };
  const by = new Map<string, RecordLike[]>();
  for (const r of [...records].sort((a, b) => a.time.localeCompare(b.time))) by.set(r.sessionId, [...(by.get(r.sessionId) ?? []), r]);
  for (const recs of by.values()) {
    out.sessions += 1;
    out.turns += recs.length;
    const early = new Set<string>();
    let left: string[] = [];
    for (const r of recs) {
      for (const o of r.outcomes) if (o.kind === "test" && o.seconds > 0) early.delete(o.name);
      const skipped = r.outcomes.filter((o) => o.kind === "test" && ["count", "budget"].includes(skipCause(o) ?? "")).map((o) => o.name);
      const owed = skipped.filter((n) => !early.has(n));
      for (const n of owed.slice(0, extra)) {
        early.add(n);
        out.extraRuns += 1;
        out.extraSeconds += quantile(seconds.get(n) ?? [], 0.5) || usual;
      }
      left = owed.slice(extra);
    }
    const before = (recs[recs.length - 1] as RecordLike).outcomes.filter((o) => o.kind === "test" && ["count", "budget"].includes(skipCause(o) ?? "")).length;
    out.unrunBefore += before;
    out.unrunAfter += left.length;
    if (before > 0) out.sessionsWithUnrun += 1;
    if (left.length > 0) out.sessionsWithUnrunAfter += 1;
  }
  out.extraSeconds = Math.round(out.extraSeconds);
  return out;
};

/** Pure: the limits as lines a person can read. */
export const renderLimits = ({ limits, top, stats, waits, ends, on }: { limits: Limits; top: Ceiling; stats: TurnStat[]; waits: Record<string, number>; ends: SessionEnd[]; on: boolean }): string => {
  const window = stats.slice(-10);
  const longest = Object.entries(waits).sort((a, b) => b[1] - a[1])[0];
  const withUnrun = ends.filter((e) => e.unrun.length > 0);
  return [
    "## Turn-end limits",
    "",
    `Tests per turn end: ${limits.tests} (floor ${limits.floorTests}, ceiling ${top.tests}). Time budget: ${limits.budgetS} s (floor ${limits.floorBudgetS} s; the loop does not raise it). ${on ? "The loop may move the count, one step a pass." : "The loop does not move the count here (off)."}`,
    `Ceiling: ${top.why}.`,
    window.length === 0
      ? "No turn has run a command yet."
      : `Last ${window.length} turn(s) that ran something: tests left over the count in ${window.filter((s) => s.overCount.length > 0).length} (at two turn ends running in ${window.filter((s) => s.stillOwed.length > 0).length}), out of budget before starting in ${window.filter((s) => s.outOfBudget.length > 0).length}, cut short by the budget in ${window.filter((s) => s.cut.length > 0).length}; the slow end of a turn check took ${quantile(window.map((s) => s.wallS), 0.9).toFixed(0)} s.`,
    longest ? `Waiting longest: ${longest[0]}, left unrun at ${longest[1]} turn end(s) in a row.` : "No test is waiting.",
    `Sessions on record: ${ends.length}; tests still unrun at a session's last recorded turn: ${withUnrun.reduce((s, e) => s + e.unrun.length, 0)} in ${withUnrun.length} session(s).`,
  ].join("\n");
};
