// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";

/** The orchestrator's record of what a worker handed over. */
export type Handover = { task: string; author: string; patchId: string; base: string; files: string[]; /** The files and folders (ending in /) the worker was allowed to write. */ allow?: string[] };

/** exit: on the patched tree. baseExit: the same command on the base commit, when the command exists there. */
export type Check = { command: string; exit: number; baseExit?: number; /** The orchestrator's own test of the task (the worker's test, a hidden spec): it failing is always a reason, even when it also fails on the base (a new file's test does). */ mustPass?: boolean };

/** What a verifier reported, with the checks the ORCHESTRATOR ran on the patched tree (a verifier's own claim to have run something is not a check). */
export type Verdict = { verifier: string; patchId: string; status: "PASS" | "ISSUES" | "BLOCKED"; method: string; checks: Check[] };

export type Acceptance = { ok: boolean; reasons: string[]; notes: string[] };

/** pstack, autopilot-full: "A verdict covers one patch". The id of a patch is the hash of its text. */
export const patchId = (diff: string): string => createHash("sha256").update(diff.replace(/\r\n/g, "\n")).digest("hex").slice(0, 16);

/**
 * pstack, autopilot-full: "nothing merges until your swarm, which never wrote the code, has proven the code that lands";
 * "A verdict covers one patch and green CI covers one head."; "A disabled or soft-failed check always comes out."
 * Every reason is a fact a program checked; an empty list of reasons is the only way to ok.
 * pstack, poteto-mode worker: a fault the base already has is reported and not held. A check that fails on the base commit too is a note, not a reason;
 * but a patch with no check that passes on its tree proves nothing, so that is a reason.
 */
export const acceptVerdict = (handover: Handover, verdict: Verdict, diffNow: string): Acceptance => {
  const reasons: string[] = [];
  const outside = (handover.allow ?? []).length === 0 ? [] : handover.files.filter((f) => !handover.allow?.some((a) => (a.endsWith("/") ? f.startsWith(a) : f === a)));
  if (outside.length > 0) reasons.push(`the patch touches files outside the worker's set: ${outside.join(", ")}`);
  if (verdict.verifier === handover.author) reasons.push("the verifier is the session that wrote the patch");
  if (verdict.patchId !== handover.patchId) reasons.push(`the verdict covers patch ${verdict.patchId}, not ${handover.patchId}`);
  if (patchId(diffNow) !== verdict.patchId) reasons.push("the patch was changed after the verdict");
  if (verdict.status !== "PASS") reasons.push(`the verdict is ${verdict.status}, not PASS`);
  if (!verdict.method.trim()) reasons.push("the verdict names no method");
  if (verdict.checks.length === 0) reasons.push("no check was run on the patched tree");
  const notes: string[] = [];
  for (const c of verdict.checks) {
    if (c.exit === 0) continue;
    if (c.mustPass === true) reasons.push(`required check failed with exit ${c.exit}: ${c.command}`);
    else if (c.baseExit !== undefined && c.baseExit !== 0) notes.push(`check fails on the base commit too (exit ${c.baseExit}), not held: ${c.command}`);
    else reasons.push(`check failed with exit ${c.exit}${c.baseExit === 0 ? " and passes on the base commit" : ""}: ${c.command}`);
  }
  if (verdict.checks.length > 0 && !verdict.checks.some((c) => c.exit === 0)) reasons.push("no check passed on the patched tree");
  return { ok: reasons.length === 0, reasons, notes };
};

export type Result = { gap: false; status: "PASS" | "ISSUES" | "BLOCKED"; heads: string[]; method: string } | { gap: true; reason: string };

/**
 * pstack, skills/swarm: drop results lacking the named SHAs and method, and count a gap as not passed.
 * The worker's report ends with one JSON object: { "status", "heads": [...], "method" }.
 */
export const parseResult = (text: string): Result => {
  const start = text.lastIndexOf('{"status"');
  const from = start >= 0 ? start : text.lastIndexOf("{");
  if (from < 0) return { gap: true, reason: "the report holds no JSON result" };
  let value: unknown;
  try {
    value = JSON.parse(text.slice(from, text.lastIndexOf("}") + 1));
  } catch {
    return { gap: true, reason: "the JSON result does not parse" };
  }
  if (typeof value !== "object" || value === null) return { gap: true, reason: "the result is not an object" };
  const v = value as { status?: unknown; heads?: unknown; method?: unknown };
  if (v.status !== "PASS" && v.status !== "ISSUES" && v.status !== "BLOCKED") return { gap: true, reason: "the result has no status of PASS, ISSUES or BLOCKED" };
  if (!Array.isArray(v.heads) || v.heads.length === 0 || !v.heads.every((h) => typeof h === "string" && /^[0-9a-f]{7,40}$/.test(h))) return { gap: true, reason: "the result names no heads (commit ids) it judged" };
  if (typeof v.method !== "string" || !v.method.trim()) return { gap: true, reason: "the result names no method" };
  return { gap: false, status: v.status, heads: v.heads as string[], method: v.method };
};
