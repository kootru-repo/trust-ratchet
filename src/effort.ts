import fs from "node:fs";
import path from "node:path";

/** One saved model call, as written by the model wrapper. */
export type Transcript = { label: string; cwd?: string; tools?: { name: string; target: string }[]; turns?: unknown; usage?: unknown; durationMs?: unknown };

export type Role = "specialist" | "verify" | "repro";
/** `otherFiles`: mean number of files opened with Read besides the one the call was about. Null when no call recorded its tools. */
export type EffortRow = { role: Role; calls: number; meanTurns: number; otherFiles: number | null; noReads: number; tokensIn: number; tokensOut: number; seconds: number };

const norm = (p: string): string => p.replace(/\\/g, "/").toLowerCase();
/** Pure: distinct files a call opened, leaving out the file named in its label. */
export const otherFilesOpened = (r: Transcript): number | null => {
  if (!r.tools) return null;
  const about = norm((r.label.split(" ")[1] ?? "").replace(/:\d+$/, ""));
  const read = new Set(r.tools.filter((t) => t.name === "Read" && t.target).map((t) => norm(t.target)));
  return [...read].filter((p) => about === "" || !p.endsWith(about)).length;
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const roleOf = (label: string): Role => (label.startsWith("verify ") ? "verify" : label.startsWith("repro ") ? "repro" : "specialist");

/**
 * Pure: how much work each kind of call did. A turn is one model step; a call that reads no file takes very few.
 * Input tokens include cached ones, so the number reflects how much the reviewer actually had in front of it.
 */
export const summarizeEffort = (records: Transcript[]): { rows: EffortRow[]; verificationShare: number | null } => {
  const rows = (["specialist", "verify", "repro"] as const).map((role) => {
    const mine = records.filter((r) => roleOf(r.label) === role);
    const usage = mine.map((r) => (typeof r.usage === "object" && r.usage !== null ? (r.usage as Record<string, unknown>) : {}));
    return {
      role,
      calls: mine.length,
      meanTurns: mine.length ? mine.reduce((a, r) => a + num(r.turns), 0) / mine.length : 0,
      otherFiles: ((counts) => (counts.length ? counts.reduce((a, n) => a + n, 0) / counts.length : null))(mine.map(otherFilesOpened).filter((n): n is number => n !== null)),
      noReads: mine.filter((r) => otherFilesOpened(r) === 0).length,
      tokensIn: usage.reduce((a, u) => a + num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens), 0),
      tokensOut: usage.reduce((a, u) => a + num(u.output_tokens), 0),
      seconds: Math.round(mine.reduce((a, r) => a + num(r.durationMs), 0) / 1000),
    };
  });
  const total = rows.reduce((a, r) => a + r.tokensIn + r.tokensOut, 0);
  const verification = rows.filter((r) => r.role !== "specialist").reduce((a, r) => a + r.tokensIn + r.tokensOut, 0);
  return { rows, verificationShare: total === 0 ? null : verification / total };
};

export const readTranscripts = (dir: string): Transcript[] =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Transcript)
    : [];

export const renderEffort = (records: Transcript[]): string => {
  const { rows, verificationShare } = summarizeEffort(records);
  return [
    "# Reviewer effort",
    "",
    records.length === 0 ? "No transcripts found. Runs made before 2026-11-19 did not save them." : `${records.length} model calls.`,
    "",
    "| kind of call | calls | mean turns | mean other files opened | calls that opened no other file | tokens in | tokens out | seconds |",
    "|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.role} | ${r.calls} | ${r.meanTurns.toFixed(1)} | ${r.otherFiles === null ? "not recorded" : r.otherFiles.toFixed(1)} | ${r.otherFiles === null ? "-" : r.noReads} | ${r.tokensIn} | ${r.tokensOut} | ${r.seconds} |`),
    "",
    `Share of tokens spent on verification and reproduction: ${verificationShare === null ? "unknown" : `${Math.round(100 * verificationShare)}%`}.`,
    "A mean of one or two turns means the reviewers answered from the prompt alone and read almost nothing else.",
    "",
  ].join("\n");
};
