// SPDX-License-Identifier: AGPL-3.0-only
import { countVerdict, type VerdictRecord } from "../harness/mergeclass.ts";
import { applyPatch } from "./patch.ts";
import { patchId } from "./verdict.ts";

export type ApplyResult = { state: "applied" | "already" | "conflict" | "refused"; reasons: string[] };

/** a patch lands in the target tree only when a counted verdict covers the id of this very patch. Otherwise nothing is touched. */
export const applyAccepted = (tree: string, diff: string, verdict: VerdictRecord): ApplyResult => {
  const counted = countVerdict(verdict, patchId(diff));
  if (!counted.counted) return { state: "refused", reasons: counted.reasons };
  const r = applyPatch(tree, diff);
  return { state: r.state, reasons: [r.message] };
};
