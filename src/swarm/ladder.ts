import { decideLaunch, DEFAULT_LIMITS, type Limits, type Machine } from "./launchgate.ts";

/** SCALE_PLAN T4: 1 worker, then 2, then 3 and 4 only when no other project shares the machine. Pure. */
export type Step = 1 | 2 | 3 | 4;
export type RunRecord = {
  step: Step;
  /** The run finished all its work orders. */
  completed: boolean;
  /** Count of gaps (a missing result, an unread file) in the record. */
  gaps: number;
  /** Patches integrated without a verified verdict. */
  unverifiedPatches: number;
};
export type StepDecision = { allowed: true } | { allowed: false; reasons: string[] };

export type StepRequest = {
  requested: Step;
  records: RunRecord[];
  /** Machine now; `workers` is how many of this run's workers already run (normally 0). */
  machine: Machine;
  limits?: Limits;
  /** From the process census: another project has processes on the machine. null means unknown, treated as shared. */
  otherProjectShares: boolean | null;
  /** The step would use the second page server. */
  usesSecondServer?: boolean;
};

/** Why a step's latest run record does not allow the next step (empty when clean). */
export const stepProblems = (records: RunRecord[], step: Step): string[] => {
  const mine = records.filter((r) => r.step === step);
  const last = mine[mine.length - 1];
  if (last === undefined) return [`no run record for step ${step}`];
  const why: string[] = [];
  if (!last.completed) why.push(`step ${step} run did not complete`);
  if (last.gaps > 0) why.push(`step ${step} run record has ${last.gaps} gaps`);
  if (last.unverifiedPatches > 0) why.push(`step ${step} run has ${last.unverifiedPatches} unverified patches`);
  return why;
};

/** The highest step whose own record and every step below it are clean (0 when none). */
export const passedStep = (records: RunRecord[]): number => {
  let top = 0;
  for (const s of [1, 2, 3, 4] as const) {
    if (stepProblems(records, s).length > 0) break;
    top = s;
  }
  return top;
};

export const decideStep = (q: StepRequest): StepDecision => {
  const reasons: string[] = [];
  const n = q.requested;
  if (n > 1 && passedStep(q.records) < n - 1) {
    const lower = (n - 1) as Step;
    const why = stepProblems(q.records, lower);
    reasons.push(...(why.length > 0 ? why : [`step ${n - 1} is not clean, so step ${n} cannot run`]));
  }
  if (n >= 3 && q.otherProjectShares !== false) {
    reasons.push(q.otherProjectShares === null ? `step ${n} needs the census to show no other project shares the machine; it is unknown` : `another project shares the machine; step ${n} needs it alone`);
  }
  if (n > 1 && q.usesSecondServer === true) reasons.push("the second page server is only for a step with one worker");
  // The ladder decides the worker count; the launch gate keeps the RAM, CPU and process limits.
  const base = q.limits ?? DEFAULT_LIMITS;
  const gate = decideLaunch({ ...q.machine, workers: q.machine.workers + n - 1 }, { ...base, maxWorkers: Math.max(base.maxWorkers, n) });
  if (!gate.start) reasons.push(...gate.reasons);
  return reasons.length === 0 ? { allowed: true } : { allowed: false, reasons };
};
