// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Row 15, plan item 20: where a session's tokens go. Pure: reads transcript text (JSONL) and says how many tokens
 * were spent on verification and on the rest, with and without the subagents' transcripts.
 *
 * The rule, stated once (RULE below): an assistant message is one unit. Its tokens are input + output + cache
 * creation + cache read of its `usage`, counted once per message id (a message written over several lines keeps
 * its last non-empty usage). A unit is "verification" when it holds a Bash tool call whose command matches one of
 * the project's verification patterns (its mapped checks, tests and drivers). Every other unit is "other". Cache
 * reads are also reported on their own, because they dominate and say little about work done.
 */
export const RULE =
  "A unit is one assistant message (counted once per id). It counts as verification when it holds a Bash tool call whose command matches a verification pattern; otherwise as other. Tokens = input + output + cache creation + cache read.";

export type Kind = "verification" | "other";
export type Split = { verification: number; other: number; total: number; cacheRead: number; units: number };
export type TokenReport = { rule: string; main: Split; subagents: Split; withSubagents: Split; verificationShare: number | null; verificationShareMain: number | null; skipped: number };
export type Transcript = { name: string; text: string };
export type Unit = { id: string; tokens: number; cacheRead: number; kind: Kind };

const empty = (): Split => ({ verification: 0, other: 0, total: 0, cacheRead: 0, units: 0 });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

const runsVerification = (c: unknown, verification: RegExp[]): boolean => {
  if (!isObj(c) || c.type !== "tool_use" || c.name !== "Bash" || !isObj(c.input)) return false;
  const command = c.input.command;
  return typeof command === "string" && verification.some((re) => re.test(command));
};

/** Pure: the units of one transcript, and how many lines could not be read as JSON. */
export const unitsOf = (text: string, verification: RegExp[]): { units: Unit[]; skipped: number } => {
  const byId = new Map<string, Unit>();
  let skipped = 0;
  let anon = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    if (!isObj(row) || row.type !== "assistant" || !isObj(row.message)) continue;
    const msg = row.message;
    const usage = isObj(msg.usage) ? msg.usage : {};
    const cacheRead = num(usage.cache_read_input_tokens);
    const tokens = num(usage.input_tokens) + num(usage.output_tokens) + num(usage.cache_creation_input_tokens) + cacheRead;
    const content = Array.isArray(msg.content) ? msg.content : [];
    const kind: Kind = content.some((c) => runsVerification(c, verification)) ? "verification" : "other";
    const id = typeof msg.id === "string" && msg.id !== "" ? msg.id : `anon-${anon++}`;
    const prev = byId.get(id);
    byId.set(id, {
      id,
      tokens: tokens > 0 ? tokens : (prev?.tokens ?? 0),
      cacheRead: tokens > 0 ? cacheRead : (prev?.cacheRead ?? 0),
      kind: prev?.kind === "verification" || kind === "verification" ? "verification" : "other",
    });
  }
  return { units: [...byId.values()], skipped };
};

const add = (s: Split, units: Unit[]): Split => {
  const out = { ...s };
  for (const u of units) {
    out[u.kind] += u.tokens;
    out.total += u.tokens;
    out.cacheRead += u.cacheRead;
    out.units++;
  }
  return out;
};
const sum = (a: Split, b: Split): Split => ({ verification: a.verification + b.verification, other: a.other + b.other, total: a.total + b.total, cacheRead: a.cacheRead + b.cacheRead, units: a.units + b.units });
const share = (s: Split): number | null => (s.total === 0 ? null : s.verification / s.total);

/** Pure: the token split of a session. `patterns` are regular expression sources for verification commands. */
export const countTokens = ({ main, subagents = [], patterns }: { main: string; subagents?: Transcript[]; patterns: string[] }): TokenReport => {
  const res = patterns.map((p) => new RegExp(p));
  const m = unitsOf(main, res);
  let sub = empty();
  let skipped = m.skipped;
  for (const t of subagents) {
    const u = unitsOf(t.text, res);
    skipped += u.skipped;
    sub = add(sub, u.units);
  }
  const mainSplit = add(empty(), m.units);
  const both = sum(mainSplit, sub);
  return { rule: RULE, main: mainSplit, subagents: sub, withSubagents: both, verificationShare: share(both), verificationShareMain: share(mainSplit), skipped };
};

const pct = (v: number | null): string => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
/** Pure: the printed lines, with and without subagents. */
export const renderTokens = (r: TokenReport): string[] => [
  `rule: ${r.rule}`,
  `main session: ${r.main.total} tokens in ${r.main.units} messages, verification ${r.main.verification} (${pct(r.verificationShareMain)}), other ${r.main.other}`,
  `subagents: ${r.subagents.total} tokens in ${r.subagents.units} messages, verification ${r.subagents.verification}, other ${r.subagents.other}`,
  `with subagents: ${r.withSubagents.total} tokens, verification ${r.withSubagents.verification} (${pct(r.verificationShare)}), other ${r.withSubagents.other}; cache reads ${r.withSubagents.cacheRead}`,
  ...(r.skipped > 0 ? [`${r.skipped} transcript lines could not be read as JSON and were skipped`] : []),
];

type Fs = Pick<typeof import("node:fs"), "existsSync" | "readdirSync" | "readFileSync">;
/** Reads a session transcript and the transcripts under `<session>/subagents/`. Not pure: reads the disk. */
export const readSession = (fs: Fs, join: (...p: string[]) => string, transcript: string): { main: string; subagents: Transcript[] } => {
  const dir = join(transcript.replace(/\.jsonl$/, ""), "subagents");
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort() : [];
  return { main: fs.readFileSync(transcript, "utf8"), subagents: names.map((f) => ({ name: f, text: fs.readFileSync(join(dir, f), "utf8") })) };
};
