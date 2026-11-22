// SPDX-License-Identifier: AGPL-3.0-only
import { parseResult, type Result } from "./verdict.ts";

/** What one required slice came back with: the worker's report text, absent when the worker never returned or was stuck. */
export type Returned = {
  report?: string;
  /** The orchestrator's own record of a verified patch (program-made, never the worker's claim). It stands in for a JSON line the worker was never asked to write. */
  verdict?: { status: "PASS" | "ISSUES" | "BLOCKED"; heads: string[]; method: string };
};

export type SliceLine = { slice: string; record: Result };

export type Coverage = {
  /** Every required slice with its record or its gap, in the order written before the fan-out. */
  lines: SliceLine[];
  gaps: string[];
  /** True only when every required slice has a record and every one passed. A gap is never a pass. */
  allPass: boolean;
  /** True when at least one slice returned: the run goes on with N-1, the gaps noted. */
  mayProceed: boolean;
  note: string;
};

/**
 * the run's list of required slices is written before the fan-out; a missing or unparseable
 * result is a recorded gap, never a pass; the run proceeds with N-1 and says so. A result for a slice that
 * was not required is ignored.
 */
export const coverage = (required: string[], returned: Record<string, Returned>): Coverage => {
  const unique = [...new Set(required)];
  const lines: SliceLine[] = unique.map((slice) => {
    const r = Object.prototype.hasOwnProperty.call(returned, slice) ? returned[slice] : undefined;
    if (r?.verdict !== undefined) return { slice, record: { gap: false as const, ...r.verdict } };
    if (r === undefined || r.report === undefined) return { slice, record: { gap: true as const, reason: "the worker returned no result" } };
    return { slice, record: parseResult(r.report) };
  });
  const gaps = lines.filter((l) => l.record.gap).map((l) => l.slice);
  const passed = lines.filter((l) => !l.record.gap && l.record.status === "PASS").length;
  const answered = lines.length - gaps.length;
  const note = gaps.length === 0 ? `all ${lines.length} slices have a record` : `proceeding with ${answered} of ${lines.length}; gaps: ${gaps.join(", ")}`;
  return { lines, gaps, allPass: lines.length > 0 && passed === lines.length, mayProceed: answered > 0, note };
};
