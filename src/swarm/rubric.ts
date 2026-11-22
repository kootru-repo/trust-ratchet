// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Verifier-held rules. A judgment rule is turned into a rubric of yes/no questions that an independent session answers; a program refuses
 * unless every answer is "yes" AND the verifier's own tool trace holds the evidence each question names. The verifier is never believed on its word.
 */
export type Evidence = { kind: "command"; match: string; outputMatch?: string } | { kind: "file"; path: string };

export type Question = { id: string; ask: string; evidence: Evidence[] };

export type Rubric = { id: string; rule: string; questions: Question[] };

export type Answer = { id: string; answer: "yes" | "no"; note?: string };

/** One tool call of the verifier's session, as read back from its transcript. */
export type Call = { tool: string; command?: string; file?: string; output: string };

export type Judgment = { ok: boolean; reasons: string[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The verifier's report ends with one JSON object: { "answers": [ { "id", "answer": "yes" | "no", "note" } ] }. */
export const parseAnswers = (text: string): Answer[] | null => {
  const from = text.lastIndexOf('{"answers"');
  if (from < 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(from, text.lastIndexOf("}") + 1));
  } catch {
    return null;
  }
  if (!isRecord(value) || !Array.isArray(value.answers)) return null;
  const out: Answer[] = [];
  for (const a of value.answers) {
    if (!isRecord(a) || typeof a.id !== "string" || (a.answer !== "yes" && a.answer !== "no")) return null;
    out.push({ id: a.id, answer: a.answer, ...(typeof a.note === "string" ? { note: a.note } : {}) });
  }
  return out;
};

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (isRecord(p) && typeof p.text === "string" ? p.text : "")).join("\n");
};

/** The calls of a session, in order, from its transcript (one JSON object per line). A call with no result keeps an empty output. */
export const callsOfTranscript = (jsonl: string): Call[] => {
  const calls: Call[] = [];
  const byId = new Map<string, Call>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(row) || !isRecord(row.message) || !Array.isArray(row.message.content)) continue;
    for (const part of row.message.content) {
      if (!isRecord(part)) continue;
      if (part.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string") {
        const input = isRecord(part.input) ? part.input : {};
        const call: Call = { tool: part.name, output: "", ...(typeof input.command === "string" ? { command: input.command } : {}), ...(typeof input.file_path === "string" ? { file: input.file_path } : {}) };
        calls.push(call);
        byId.set(part.id, call);
      } else if (part.type === "tool_result" && typeof part.tool_use_id === "string") {
        const call = byId.get(part.tool_use_id);
        if (!call) continue;
        const result = isRecord(row.toolUseResult) ? row.toolUseResult : {};
        const stdout = typeof result.stdout === "string" ? result.stdout : "";
        const stderr = typeof result.stderr === "string" ? result.stderr : "";
        call.output = stdout || stderr ? `${stdout}\n${stderr}` : textOf(part.content);
      }
    }
  }
  return calls;
};

const slashes = (s: string): string => s.replace(/\\/g, "/");

const satisfied = (e: Evidence, calls: Call[], exists: (path: string) => boolean): boolean => {
  if (e.kind === "file") return exists(e.path);
  const command = new RegExp(e.match, "i");
  const output = e.outputMatch ? new RegExp(e.outputMatch, "i") : null;
  return calls.some((c) => c.tool === "Bash" && c.command !== undefined && command.test(slashes(c.command)) && (output === null || output.test(c.output)));
};

const describe = (e: Evidence): string => (e.kind === "file" ? `a file ${e.path}` : `a command matching /${e.match}/${e.outputMatch ? ` with output matching /${e.outputMatch}/` : ""}`);

/** The only way to ok: every question answered, every answer yes, and the trace holds the evidence behind each yes. */
export const judgeRubric = (rubric: Rubric, answers: Answer[] | null, calls: Call[], exists: (path: string) => boolean): Judgment => {
  const reasons: string[] = [];
  if (answers === null) return { ok: false, reasons: [`rubric ${rubric.id}: the report holds no parseable answers`] };
  const known = new Set(rubric.questions.map((q) => q.id));
  for (const a of answers) if (!known.has(a.id)) reasons.push(`rubric ${rubric.id}: an answer to a question that is not in the rubric: ${a.id}`);
  for (const q of rubric.questions) {
    const given = answers.filter((a) => a.id === q.id);
    if (given.length === 0) {
      reasons.push(`${q.id} is not answered: ${q.ask}`);
      continue;
    }
    if (given.length > 1) reasons.push(`${q.id} is answered more than once`);
    const a = given[0];
    if (!a) continue;
    if (a.answer === "no") {
      reasons.push(`${q.id} is answered no: ${q.ask}${a.note ? ` (${a.note})` : ""}`);
      continue;
    }
    for (const e of q.evidence) if (!satisfied(e, calls, exists)) reasons.push(`${q.id} is answered yes but the session's trace holds no ${describe(e)}`);
  }
  return { ok: reasons.length === 0, reasons };
};
