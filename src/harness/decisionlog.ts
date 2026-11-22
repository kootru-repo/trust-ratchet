// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Append-only decision log (row 16, pstack's format): a header, a separator, then one row a decision with six
 * single-line cells: id, date, decision, why, evidence pointer, status. The id is `<session>:<n>`. A decision
 * `start <session>` opens a session; a row by a session other than the first row's needs an earlier start row.
 */

export const HEADER = ["id", "date", "decision", "why", "evidence", "status"] as const;
export type LogRow = { id: string; date: string; decision: string; why: string; evidence: string; status: string };
export type Problem = { line: number; problem: string };

const cellsOf = (line: string): string[] => {
  const t = line.trim();
  const inner = t.startsWith("|") ? t.slice(1) : t;
  return (inner.endsWith("|") ? inner.slice(0, -1) : inner).split("|").map((c) => c.trim());
};
const isSeparator = (line: string): boolean => /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);

export const renderRow = (r: LogRow): string => `| ${r.id} | ${r.date} | ${r.decision} | ${r.why} | ${r.evidence} | ${r.status} |`;
export const newLog = (): string => `| ${HEADER.join(" | ")} |\n|${HEADER.map(() => "---").join("|")}|\n`;

/** Pure: the rows of a log text with their line numbers (1-based), the header and separator left out. */
export const parseRows = (text: string): { line: number; cells: string[] }[] => {
  const out: { line: number; cells: string[] }[] = [];
  text.split(/\r?\n/).forEach((l, i) => {
    if (i < 2 || l.trim() === "") return;
    out.push({ line: i + 1, cells: cellsOf(l) });
  });
  return out;
};

const sessionOf = (id: string): string | null => /^([^:\s]+):\d+$/.exec(id)?.[1] ?? null;

/** Pure: the format problems of a log text: header, six cells, formula starts, ids, dates, sessions. */
export const checkFormat = (text: string): Problem[] => {
  const lines = text.split(/\r?\n/);
  const problems: Problem[] = [];
  if (cellsOf(lines[0] ?? "").join("|").toLowerCase() !== HEADER.join("|")) problems.push({ line: 1, problem: `header is not ${HEADER.join(", ")}` });
  if (!isSeparator(lines[1] ?? "")) problems.push({ line: 2, problem: "second line is not the header separator" });
  const started = new Set<string>();
  const ids = new Set<string>();
  let owner: string | null = null;
  for (const { line, cells } of parseRows(text)) {
    if (cells.length !== 6) {
      problems.push({ line, problem: `row has ${cells.length} cells, not 6` });
      continue;
    }
    const [id = "", date = "", decision = ""] = cells;
    cells.forEach((c, i) => {
      if (c === "") problems.push({ line, problem: `cell ${HEADER[i]} is empty` });
      else if (/^[=+\-@]/.test(c)) problems.push({ line, problem: `cell ${HEADER[i]} starts with ${c[0]} unquoted` });
    });
    if (ids.has(id)) problems.push({ line, problem: `id ${id} repeats` });
    ids.add(id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) problems.push({ line, problem: `date ${date} is not YYYY-MM-DD` });
    const session = sessionOf(id);
    if (session === null) {
      problems.push({ line, problem: `id ${id} is not <session>:<n>` });
      continue;
    }
    owner ??= session;
    const start = /^start (\S+)$/.exec(decision);
    if (start) started.add(start[1] ?? "");
    else if (session !== owner && !started.has(session)) problems.push({ line, problem: `session ${session} writes with no earlier start row naming it` });
  }
  return problems;
};

/** Pure: append-only. `next` must keep every line of `previous` unchanged and in place; only later lines may be new. */
export const checkAppendOnly = ({ previous, next }: { previous: string; next: string }): Problem[] => {
  const a = previous.split(/\r?\n/);
  while (a.length > 0 && a[a.length - 1] === "") a.pop();
  const b = next.split(/\r?\n/);
  const problems: Problem[] = [];
  a.forEach((l, i) => {
    if (b[i] !== l) problems.push({ line: i + 1, problem: b[i] === undefined ? "an earlier line was removed" : "an earlier line was changed" });
  });
  return problems;
};

const gitOk = (repo: string, args: string[]): boolean => {
  try {
    execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether an evidence pointer resolves in `repo`: `commit:<hash>` (or a bare hash of 7 to 40 hex) names a commit
 * that exists; `<path>` a file that exists inside the repo; `<path>:<n>` or `<path>:<n>-<m>` a line or lines in range.
 */
export const resolvePointer = ({ repo, pointer }: { repo: string; pointer: string }): { ok: boolean; why: string } => {
  const p = pointer.trim();
  const hash = /^(?:commit:)?([0-9a-f]{7,40})$/i.exec(p);
  if (hash) return gitOk(repo, ["cat-file", "-e", `${hash[1]}^{commit}`]) ? { ok: true, why: "commit exists" } : { ok: false, why: "no such commit" };
  const m = /^(?:path:)?(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(p);
  if (!m) return { ok: false, why: "not a pointer" };
  const full = path.resolve(repo, m[1] ?? "");
  const rel = path.relative(path.resolve(repo), full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { ok: false, why: "path is outside the repository" };
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return { ok: false, why: "no such file" };
  if (m[2] === undefined) return { ok: true, why: "file exists" };
  const from = Number(m[2]);
  const to = m[3] === undefined ? from : Number(m[3]);
  const total = fs.readFileSync(full, "utf8").split(/\r?\n/).length;
  if (from < 1 || to < from || to > total) return { ok: false, why: `line ${from}-${to} is outside 1-${total}` };
  return { ok: true, why: "lines in range" };
};

/** Every problem of a log text: format, and each evidence pointer resolved in `repo`. */
export const checkLog = ({ text, repo }: { text: string; repo: string }): Problem[] => {
  const problems = checkFormat(text);
  for (const { line, cells } of parseRows(text)) {
    const evidence = cells[4] ?? "";
    if (cells.length !== 6 || evidence === "") continue;
    const r = resolvePointer({ repo, pointer: evidence });
    if (!r.ok) problems.push({ line, problem: `evidence ${evidence}: ${r.why}` });
  }
  return problems.sort((x, y) => x.line - y.line);
};

/**
 * Appends one row to the log file (created with its header when missing). Refused, with nothing written, when the
 * result would not pass `checkLog` or would change an earlier line.
 */
export const appendRow = ({ file, repo, row }: { file: string; repo: string; row: LogRow }): { ok: boolean; problems: Problem[] } => {
  const previous = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : newLog();
  const next = `${previous.endsWith("\n") ? previous : `${previous}\n`}${renderRow(row)}\n`;
  const problems = [...checkAppendOnly({ previous, next }), ...checkLog({ text: next, repo })];
  if (problems.length > 0) return { ok: false, problems };
  fs.writeFileSync(file, next);
  return { ok: true, problems: [] };
};

/** Checks a log file against the copy last read (`previous` text, e.g. from git) and the repo. */
export const checkLogFile = ({ file, repo, previous }: { file: string; repo: string; previous?: string }): Problem[] => {
  const text = fs.readFileSync(file, "utf8");
  return [...(previous === undefined ? [] : checkAppendOnly({ previous, next: text })), ...checkLog({ text, repo })];
};
