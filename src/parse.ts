import type { Cite, Concern, Dismissal, Severity, SpecialistOutput, Verdict } from "./types.ts";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Returns the last JSON object in a model reply: the last fenced json block, or the last balanced {...}. */
export const lastJson = (text: string): unknown => {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  for (const body of fences.reverse()) {
    try {
      return JSON.parse(body);
    } catch {
      // try the next candidate
    }
  }
  for (let start = text.lastIndexOf("{"); start >= 0; start = text.lastIndexOf("{", start - 1)) {
    try {
      const parsed: unknown = JSON.parse(text.slice(start, text.lastIndexOf("}") + 1));
      if (isRec(parsed)) return parsed;
    } catch {
      // keep walking left
    }
    if (start === 0) break;
  }
  throw new Error("no JSON object in the reply");
};

const toCite = (v: Rec): Cite | null => {
  const line = typeof v.line === "number" ? v.line : Number.parseInt(str(v.line), 10);
  const file = str(v.file).replace(/\\/g, "/");
  const quote = str(v.quote);
  return file && quote && Number.isInteger(line) ? { file, line, quote } : null;
};

const toSeverity = (v: unknown): Severity => (v === "critical" || v === "major" || v === "minor" ? v : "minor");

/** Reads a specialist reply. Entries without a usable citation are discarded here, before anything else sees them. */
export const parseSpecialist = ({ text, specialist }: { text: string; specialist: string }): SpecialistOutput => {
  const raw = lastJson(text);
  if (!isRec(raw)) throw new Error("reply is not an object");
  const concerns: Concern[] = [];
  for (const item of list(raw.concerns)) {
    if (!isRec(item)) continue;
    const cite = toCite(item);
    if (!cite || !str(item.title)) continue;
    concerns.push({ specialist, title: str(item.title), severity: toSeverity(item.severity), cite, reasoning: str(item.reasoning) });
  }
  const dismissed: Dismissal[] = [];
  for (const item of list(raw.dismissed)) {
    if (!isRec(item)) continue;
    const cite = toCite(item);
    if (!cite || !str(item.title)) continue;
    // Anything not explicitly proven locally is treated as an assumption.
    dismissed.push({ specialist, title: str(item.title), cite, proof: item.proof === "local" ? "local" : "assumed", reasoning: str(item.reasoning) });
  }
  const reads = list(raw.read).flatMap((item) => {
    const cite = isRec(item) ? toCite(item) : null;
    return cite ? [cite] : [];
  });
  return { concerns, dismissed, reads };
};

export type VerifierReply = { verdict: Verdict; proof: Cite[]; explanation: string; callSites: string[]; guard: string };

export const parseVerifier = (text: string): VerifierReply => {
  const raw = lastJson(text);
  if (!isRec(raw)) throw new Error("reply is not an object");
  const verdict: Verdict = raw.verdict === "confirmed" || raw.verdict === "refuted" ? raw.verdict : "unproven";
  const proof = list(raw.proof).flatMap((p) => {
    const cite = isRec(p) ? toCite(p) : null;
    return cite ? [cite] : [];
  });
  return { verdict, proof, explanation: str(raw.explanation), callSites: list(raw.callSites).map(str).filter(Boolean), guard: str(raw.guard) };
};
