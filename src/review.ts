import { checkCite } from "./cite.ts";
import { gatherContext } from "./context.ts";
import { parseSpecialist, parseVerifier } from "./parse.ts";
import type { Patch } from "./history.ts";
import { ident } from "./ident.ts";
import { applyMustNot, budgetFor, budgetLine, diffSize, guidesBlock, judgeVerifierReading, lookedBeyond, mustNotBlock, PROPERTY_GUIDE, verifierReadLine, type ReviewOptions, escalation, maskDiffComments } from "./options.ts";
import { judgeReading, openedFiles } from "./reading.ts";
import { packFor } from "./packs/index.ts";
import { specialistPrompt, verifierPrompt } from "./prompts.ts";
import { reproduce, type TestRunner } from "./repro.ts";
import { triage } from "./triage.ts";
import type { Check, Checked, Concern, Dismissal, Fact, ModelFn, Reading, ReviewResult, ToolUse } from "./types.ts";

export type ReviewArgs = {
  root: string;
  file: string;
  model: ModelFn;
  facts?: Fact[];
  maxChecks?: number;
  /** When given, each confirmed finding is turned into a test and run. */
  repro?: { pkg: string; runner: TestRunner };
  /** Specialists the target adds to the pack's own choice (for example "sourcing"). */
  extras?: string[];
  /** Specialists to leave out. Used by the retirement run to measure what is lost without one. */
  without?: string[];
  /** How many locally proven dismissals to send to a verifier anyway. A specialist's own word that something is safe is otherwise never checked. */
  auditLocal?: number;
  /**
   * How many other files each specialist must show it read. 0 switches the rule off. The number is lowered to what
   * exists: a file with one importer and no local imports can only require one.
   */
  requireReads?: number;
  /** Review the file as a change. The commit message goes to the intent specialist only. */
  patch?: Patch;
  /** Mechanisms that are off unless asked for (see options.ts). */
  options?: ReviewOptions;
};

const verifyOne = async ({ check, root, model, facts, language, reads = 0, addenda = "" }: { check: Check; root: string; model: ModelFn; facts: Fact[]; language: string; reads?: number; addenda?: string }): Promise<Checked> => {
  const base = { ...check, proof: [], explanation: "", callSites: [], guard: "" };
  let reply;
  let tools: ToolUse[] | null = null;
  try {
    reply = parseVerifier(await model({ prompt: verifierPrompt({ check, facts, language, addenda: `${addenda}${reads > 0 ? verifierReadLine(reads) : ""}` }), cwd: root, label: `verify ${check.cite.file}:${check.cite.line}`, onTools: (t) => (tools = t) }));
  } catch (err) {
    return { ...base, verdict: "unproven", downgraded: `verifier failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const out: Checked = { ...check, ...reply };
  if (reply.verdict === "unproven") return out;
  // S5, only when asked for: a verdict from a verifier that did not read beyond the cited file is not kept.
  const readingOk = judgeVerifierReading({ others: tools === null ? null : lookedBeyond({ tools, root, cited: check.cite.file }), required: reads });
  if (!readingOk.ok) return { ...out, verdict: "unproven", downgraded: `verifier said ${reply.verdict} after looking ${readingOk.others} time(s) beyond the cited file where ${reads} are required` };
  // The symmetrical rule, enforced by a program: a verdict stands only on quotes that are really in the tree.
  if (reply.proof.length === 0) return { ...out, verdict: "unproven", downgraded: `verifier said ${reply.verdict} without citing any code` };
  for (const p of reply.proof) {
    const res = checkCite({ root, cite: p });
    if (!res.ok) return { ...out, verdict: "unproven", downgraded: `verifier said ${reply.verdict} but a proof citation failed (${p.file}:${p.line}: ${res.reason})` };
  }
  return out;
};

/** Pure: the lines of `file` that a deterministic check reported on. Facts name them as `<file>:<line> <message>`. */
export const factLines = ({ facts, file }: { facts: Fact[]; file: string }): Set<number> =>
  new Set(
    facts
      .filter((f) => f.ran !== false && f.exitCode !== 0)
      .flatMap((f) => f.tail.split(/\r?\n/))
      .map((l) => l.trim().replace(/\\/g, "/").replace(/^\.\//, ""))
      .flatMap((l) => (l.startsWith(`${file}:`) ? [Number.parseInt(l.slice(file.length + 1), 10)] : []))
      .filter((n) => Number.isFinite(n)),
  );

/** Reviews one file: plan, parallel specialists (concerns and dismissals), triage, one verifier per surviving candidate. */
export const reviewFile = async ({ root, file, model, facts = [], maxChecks = 40, repro, extras = [], without = [], auditLocal = 0, requireReads = 0, patch, options = {} }: ReviewArgs): Promise<ReviewResult> => {
  const pack = packFor(file);
  const context = gatherContext({ root, file, pack });
  const specialists = pack.pickSpecialists({ file, content: context.content, extras }).filter((s) => !without.includes(s.id));
  const errors: string[] = [];
  let modelCalls = 0;
  const budget = options.budget ? `\n${budgetLine(budgetFor({ fileLines: context.content.split(/\r?\n/).length, ...(patch ? { diffLines: diffSize(patch.diff) } : {}) }))}\n` : "";
  const addenda = `${budget}${guidesBlock(options.guides ?? [])}${mustNotBlock({ mustNot: options.mustNotFlag ?? [], file })}`;

  const available = new Set([...context.importers, ...(context.imports ?? [])]).size;
  const required = Math.min(requireReads, available);
  const shown = new Set((context.uses ?? []).map((u) => `${u.file}:${u.line}`));
  const reading: Reading[] = [];

  const outputs = await Promise.all(
    specialists.map(async (specialist) => {
      const ask = async (rejected?: string) => {
        modelCalls += 1;
        let tools: ToolUse[] | null = null;
        const text = await model({
          prompt: specialistPrompt({ specialist, file, context, facts, language: pack.language, ...(patch ? { patch: options.maskComments ? { ...patch, diff: maskDiffComments({ diff: patch.diff, language: pack.language }) } : patch } : {}), ...(options.messageToAll ? { messageToAll: true } : {}), ...(required > 0 ? { read: { required, ...(rejected ? { rejected } : {}) } } : {}), ...(addenda ? { addenda } : {}) }),
          cwd: root,
          label: `${specialist.id} ${file}${rejected ? " #2" : ""}`,
          onTools: (t) => (tools = t),
        });
        const out = parseSpecialist({ text, specialist: specialist.id });
        const opened = tools === null ? null : openedFiles({ tools, root });
        const verdict = judgeReading({ reads: out.reads ?? [], file, shown, opened, matches: (cite) => checkCite({ root, cite }), required });
        const others = opened === null ? null : [...opened].filter((f) => f !== file).length;
        return { out, verdict, others };
      };
      try {
        let got = await ask();
        let retried = false;
        if (required > 0 && !got.verdict.ok) {
          // One second attempt, told why the first was thrown away. No session is shared: it starts from nothing.
          retried = true;
          const why = `it showed ${got.verdict.verified.length} checked read(s) of other files where ${required} are required${got.verdict.rejected[0] ? ` (for example ${got.verdict.rejected[0].cite.file}: ${got.verdict.rejected[0].reason})` : ""}`;
          try {
            got = await ask(why);
          } catch (err) {
            errors.push(`${specialist.id} #2: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        reading.push({ specialist: specialist.id, opened: got.others, verified: got.verdict.verified.length, required, retried });
        return got.out;
      } catch (err) {
        errors.push(`${specialist.id}: ${err instanceof Error ? err.message : String(err)}`);
        return { concerns: [], dismissed: [] };
      }
    }),
  );
  const candidates: Concern[] = outputs.flatMap((o) => o.concerns);
  const dismissals: Dismissal[] = outputs.flatMap((o) => o.dismissed);

  const triaged = triage({ concerns: candidates, dismissals, cite: (cite) => checkCite({ root, cite }), maxChecks });
  const { unchecked, local } = triaged;
  // S14, only when cases are given: a place a person ruled a false alarm is dropped by a program, not argued again.
  const ruled = applyMustNot({ checks: triaged.checks, mustNot: options.mustNotFlag ?? [] });
  const checks = ruled.kept;
  const dropped = [...triaged.dropped, ...ruled.dropped];
  // The sample is chosen by a hash of the cited text: stable from run to run, and not chosen by any model.
  const taken = (l: Check): boolean => checks.some((c) => c.cite.file === l.cite.file && Math.abs(c.cite.line - l.cite.line) <= 1);
  // A dismissal on a line a deterministic check reported is never taken on the specialist's word: a program and a
  // model disagree there, and a verifier settles it. These do not count against the sample.
  const flagged = factLines({ facts, file });
  const contested = local.filter((l) => !taken(l) && l.cite.file === file && flagged.has(l.cite.line));
  const sample = local
    .filter((l) => !taken(l) && !contested.includes(l))
    .sort((a, b) => ident(a.cite).localeCompare(ident(b.cite)))
    .slice(0, auditLocal);
  // One check per line is enough.
  const audit = [...contested, ...sample].filter((l, i, all) => all.findIndex((o) => o.cite.file === l.cite.file && o.cite.line === l.cite.line) === i);
  const toVerify = [...checks, ...audit];
  modelCalls += toVerify.length;
  const checked = await Promise.all(toVerify.map((check) => verifyOne({ check, root, model, facts, language: pack.language, reads: options.verifierReads ?? 0, addenda: `${budget}${guidesBlock(options.guides ?? [])}` })));

  // S1, only when asked for: one sampled dismissal that was wrong means the specialists' word is not good enough here,
  // so every other local dismissal of this review goes to a verifier too (up to the same limit as other checks).
  let escalated = 0;
  if (options.escalateLocal) {
    const sampledWrong = checked.some((c) => c.verdict === "confirmed" && sample.some((l) => l.cite.file === c.cite.file && l.cite.line === c.cite.line));
    const more = escalation({ local: local.filter((l) => !taken(l)), verified: audit, anyWrong: sampledWrong, max: maxChecks });
    escalated = more.length;
    modelCalls += more.length;
    checked.push(...(await Promise.all(more.map((check) => verifyOne({ check, root, model, facts, language: pack.language, reads: options.verifierReads ?? 0, addenda: `${budget}${guidesBlock(options.guides ?? [])}` })))));
  }

  if (repro) {
    // Model calls run in parallel, test runs one at a time: a test run links dependencies into the tree.
    for (const c of checked.filter((x) => x.verdict === "confirmed")) {
      c.repro = await reproduce({ check: c, root, language: pack.language, guide: `${pack.testGuide(repro.pkg)}${options.property ? `\n${PROPERTY_GUIDE}` : ""}`, model, runner: repro.runner, name: "ratchet_" + ident(c.cite) });
      modelCalls += c.repro.attempts;
    }
  }

  return { file, specialists: specialists.map((s) => s.id), facts, candidates, dismissals, dropped, unchecked, checked, modelCalls, errors, localDismissals: local.length, localAudited: audit.length + escalated, reading, patch: patch !== undefined };
};
