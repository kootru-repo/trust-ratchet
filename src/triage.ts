import type { CiteResult } from "./cite.ts";
import type { Check, Cite, Concern, Dismissal, Dropped, Severity } from "./types.ts";

const RANK: Record<Severity, number> = { critical: 0, major: 1, minor: 2 };
/** Two candidates in the same file this close together are treated as one. */
export const MERGE_LINES = 1;

export type TriageResult = { checks: Check[]; unchecked: Check[]; dropped: Dropped[]; local: Check[] };

const near = (a: Cite, b: Cite): boolean => a.file === b.file && Math.abs(a.line - b.line) <= MERGE_LINES;

/**
 * Decides what goes to a verifier. No model is involved.
 * - A candidate whose quote is not in the file is dropped.
 * - A dismissal proven locally is dropped. A dismissal resting on an assumption is promoted to a check.
 * - Nothing is passed through as "obviously a bug": every surviving candidate must be verified.
 * - Order matters only when there are more candidates than `maxChecks`. It does not trust the severity a specialist
 *   gave its own claim: on the benchmark both lost bugs had been rated minor. Candidates that two specialists
 *   reached come first, then each specialist takes turns, so a promoted dismissal is not pushed to the back.
 */
export const triage = ({
  concerns,
  dismissals,
  cite,
  maxChecks,
}: {
  concerns: Concern[];
  dismissals: Dismissal[];
  cite: (c: Cite) => CiteResult;
  maxChecks: number;
}): TriageResult => {
  const dropped: Dropped[] = [];
  const checks: Check[] = [];
  const local: Check[] = [];

  const add = (next: Check): void => {
    const twin = checks.find((c) => near(c.cite, next.cite));
    if (!twin) {
      checks.push(next);
      return;
    }
    // Same spot seen twice: keep one check, the stronger claim, and remember who agreed.
    if (!twin.specialist.split("+").includes(next.specialist)) twin.specialist += `+${next.specialist}`;
    if (RANK[next.severity] < RANK[twin.severity] || (twin.origin === "dismissal" && next.origin === "concern")) {
      Object.assign(twin, { ...next, specialist: twin.specialist });
    }
  };

  for (const c of concerns) {
    const res = cite(c.cite);
    if (!res.ok) dropped.push({ title: c.title, specialist: c.specialist, reason: `citation failed: ${res.reason}` });
    else add({ origin: "concern", specialist: c.specialist, title: c.title, severity: c.severity, cite: c.cite, claim: c.reasoning });
  }
  for (const d of dismissals) {
    const res = cite(d.cite);
    if (!res.ok) dropped.push({ title: d.title, specialist: d.specialist, reason: `citation failed: ${res.reason}` });
    else if (d.proof === "local") {
      dropped.push({ title: d.title, specialist: d.specialist, reason: "dismissed with local proof" });
      local.push({ origin: "local-dismissal", specialist: d.specialist, title: d.title, severity: "minor", cite: d.cite, claim: d.reasoning });
    }
    else add({ origin: "dismissal", specialist: d.specialist, title: d.title, severity: "minor", cite: d.cite, claim: d.reasoning });
  }

  const agreed = (c: Check): number => c.specialist.split("+").length;
  const taken = new Map<string, number>();
  const turn = new Map<Check, number>();
  for (const c of checks) {
    const owner = c.specialist.split("+")[0] ?? "";
    const n = taken.get(owner) ?? 0;
    turn.set(c, n);
    taken.set(owner, n + 1);
  }
  checks.sort((a, b) => agreed(b) - agreed(a) || (turn.get(a) ?? 0) - (turn.get(b) ?? 0) || RANK[a.severity] - RANK[b.severity]);
  return { checks: checks.slice(0, maxChecks), unchecked: checks.slice(maxChecks), dropped, local };
};
