import fs from "node:fs";
import path from "node:path";
import type { Cite } from "./types.ts";

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Lines either side of the cited line in which the quote may start. */
export const CITE_SLACK = 3;
/** A quote shorter than this proves nothing: "}" matches everywhere. */
export const MIN_QUOTE = 6;

export type CiteResult = { ok: true } | { ok: false; reason: string };

/** Pure check: does `quote` appear in `text` near `line`? Whitespace differences are ignored. */
export const quoteMatches = ({ text, line, quote }: { text: string; line: number; quote: string }): CiteResult => {
  const want = squash(quote);
  if (want.length < MIN_QUOTE) return { ok: false, reason: `quote shorter than ${MIN_QUOTE} characters` };
  const lines = text.split(/\r?\n/);
  if (!Number.isInteger(line) || line < 1 || line > lines.length) return { ok: false, reason: `line ${line} is outside the file (${lines.length} lines)` };
  const extra = quote.split(/\r?\n/).length - 1;
  const from = Math.max(0, line - 1 - CITE_SLACK);
  const to = Math.min(lines.length, line + CITE_SLACK + extra);
  const window = squash(lines.slice(from, to).join(" "));
  return window.includes(want) ? { ok: true } : { ok: false, reason: `quote not found within ${CITE_SLACK} lines of line ${line}` };
};

/**
 * Pure: the line on which the quote really starts, searching outward from the cited line within the allowed slack.
 * Returns null when the quote is not there. A model's line number can be off by a few lines; the quote cannot.
 */
export const locateQuote = ({ text, line, quote }: { text: string; line: number; quote: string }): number | null => {
  const want = squash(quote);
  if (want.length < MIN_QUOTE) return null;
  const lines = text.split(/\r?\n/);
  const span = quote.split(/\r?\n/).length;
  const startsAt = (n: number): boolean => {
    if (n < 1 || n > lines.length) return false;
    const first = squash(lines[n - 1] ?? "");
    if (first === "") return false;
    const joined = squash(lines.slice(n - 1, n - 1 + span + 1).join(" "));
    // The quote must begin on this line: either the line holds its start, or the quote starts inside the line.
    const head = want.slice(0, Math.min(want.length, Math.max(MIN_QUOTE, first.length)));
    return joined.includes(want) && (first.includes(head) || first.includes(want));
  };
  for (let d = 0; d <= CITE_SLACK; d += 1) {
    if (startsAt(line - d)) return line - d;
    if (d > 0 && startsAt(line + d)) return line + d;
  }
  return null;
};

/** Mechanical check that a citation points at text that is really in the tree. No model is involved. */
export const checkCite = ({ root, cite }: { root: string; cite: Cite }): CiteResult => {
  const full = path.resolve(root, cite.file);
  const rel = path.relative(path.resolve(root), full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return { ok: false, reason: `path leaves the tree: ${cite.file}` };
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return { ok: false, reason: `no such file: ${cite.file}` };
  return quoteMatches({ text: fs.readFileSync(full, "utf8"), line: cite.line, quote: cite.quote });
};
