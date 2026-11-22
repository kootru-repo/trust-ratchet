// SPDX-License-Identifier: AGPL-3.0-only
import { findHatches, type Finding } from "./rules.ts";

/**
 * The no-comments constraint (plan 6a.2). The talk: agents use comments "as a place to write down their justifications for not doing the right thing",
 * so most comments are banned and the few that stay are on a list. Only comments the SESSION added are ever charged.
 */
export type CommentsMode = "off" | "excuses" | "ban";
export type CommentsConfig = { mode?: CommentsMode; /** Regular expression sources: a comment matching one is on the project's allowed list (its own tags). */ allow?: string[] };

export type Comment = { line: number; text: string; doc: boolean };

const JS_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const PY_FILE = /\.pyi?$/;
const REGEX_PREV = "(,=:[!&|?{};+-*%<>~^";

/** Comments of a JavaScript or TypeScript file. Strings, template literals and regular expression literals are skipped, so `//` in a URL is not a comment. */
const jsComments = (content: string): Comment[] => {
  const out: Comment[] = [];
  const lines = content.split(/\r?\n/);
  let block: { doc: boolean } | null = null;
  let template = false;
  lines.forEach((raw, i) => {
    let at = 0;
    let prev = "";
    if (block) {
      const end = raw.indexOf("*/");
      out.push({ line: i + 1, text: raw.slice(0, end < 0 ? raw.length : end).replace(/^\s*\*?\s?/, "").trim(), doc: block.doc });
      if (end < 0) return;
      block = null;
      at = end + 2;
    }
    while (at < raw.length) {
      const c = raw[at] ?? "";
      if (template) {
        if (c === "\\") at += 2;
        else {
          if (c === "`") template = false;
          at++;
        }
        continue;
      }
      if (c === "'" || c === '"') {
        let j = at + 1;
        while (j < raw.length && raw[j] !== c) j += raw[j] === "\\" ? 2 : 1;
        at = j + 1;
        prev = c;
        continue;
      }
      if (c === "`") {
        template = true;
        at++;
        continue;
      }
      if (c === "/" && raw[at + 1] === "/") {
        out.push({ line: i + 1, text: raw.slice(at + 2).trim(), doc: false });
        return;
      }
      if (c === "/" && raw[at + 1] === "*") {
        const end = raw.indexOf("*/", at + 2);
        const doc = raw[at + 2] === "*" && raw[at + 3] !== "/";
        const body = raw.slice(at + 2, end < 0 ? raw.length : end).replace(/^\*\s?/, "").trim();
        out.push({ line: i + 1, text: body, doc });
        if (end < 0) {
          block = { doc };
          return;
        }
        at = end + 2;
        continue;
      }
      if (c === "/" && (prev === "" || REGEX_PREV.includes(prev))) {
        let j = at + 1;
        let inClass = false;
        while (j < raw.length && (raw[j] !== "/" || inClass)) {
          if (raw[j] === "\\") j++;
          else if (raw[j] === "[") inClass = true;
          else if (raw[j] === "]") inClass = false;
          j++;
        }
        at = j + 1;
        prev = "/";
        continue;
      }
      if (c.trim() !== "") prev = c;
      at++;
    }
  });
  return out;
};

/** Comments of a Python file. A triple-quoted string (a docstring) is a string, not a comment. */
const pyComments = (content: string): Comment[] => {
  const out: Comment[] = [];
  let triple: string | null = null;
  content.split(/\r?\n/).forEach((raw, i) => {
    let at = 0;
    while (at < raw.length) {
      if (triple) {
        const end = raw.indexOf(triple, at);
        if (end < 0) return;
        at = end + 3;
        triple = null;
        continue;
      }
      const c = raw[at] ?? "";
      if (c === "#") {
        out.push({ line: i + 1, text: raw.slice(at + 1).trim(), doc: false });
        return;
      }
      if (c === "'" || c === '"') {
        if (raw.startsWith(c.repeat(3), at)) {
          triple = c.repeat(3);
          at += 3;
          continue;
        }
        let j = at + 1;
        while (j < raw.length && raw[j] !== c) j += raw[j] === "\\" ? 2 : 1;
        at = j + 1;
        continue;
      }
      at++;
    }
  });
  return out;
};

/** Pure: the comment lines of a file, with their text. Other file types have none. */
export const findComments = (file: string, content: string): Comment[] => (JS_FILE.test(file) ? jsComments(content) : PY_FILE.test(file) ? pyComments(content) : []);

const LEGAL = /\b(licen[sc]e|copyright|SPDX-License-Identifier)\b|\(c\)\s*\d{4}/i;
const LINK = /(https?:\/\/\S*\/(issues|pull|pulls|rfc|rfcs)\/\S*|\bRFC\s?\d+\b)/i;
const KEEP = /\b(prettier-ignore|istanbul ignore)\b/;
const EXCUSE = /\b(workaround|hack|for now|temporar(y|ily)|quick fix|safe because|todo|fixme|xxx|should be fine)\b/i;
const CLAIM = /\b(do not|don't|never)\s+(remove|change|touch|delete|edit|move|rename)\b|\bmust not be (removed|changed)\b|\b(talk to|ask)\b.*\bbefore (changing|removing|editing|touching)\b/i;

/** Pure: pstack's keep list as far as a program can decide it, plus the project's own tags. */
export const isAllowed = ({ file, comment, lines, config }: { file: string; comment: Comment; lines: string[]; config: CommentsConfig }): boolean => {
  if (comment.text === "" && !comment.doc) return true;
  if (comment.line === 1 && /^!/.test(comment.text)) return true;
  if (comment.line <= 20 && LEGAL.test(comment.text)) return true;
  if (LINK.test(comment.text) || KEEP.test(comment.text)) return true;
  if (findHatches(file, lines[comment.line - 1] ?? "").length > 0) return true;
  if (comment.doc) {
    const next = lines.slice(comment.line).find((l) => l.trim() !== "" && !/^\s*(\*|\/\*)/.test(l));
    if (next !== undefined && /^\s*export\b/.test(next)) return true;
  }
  return (config.allow ?? []).some((source) => {
    try {
      return new RegExp(source).test(comment.text);
    } catch {
      return false;
    }
  });
};

/** Pure: the comments in `now` that were not in the file before, matched by their text (a comment moved by an edit of the lines around it is not new). */
export const newComments = ({ now, before }: { now: Comment[]; before: string[] }): Comment[] => {
  const left = new Map<string, number>();
  for (const t of before) left.set(t, (left.get(t) ?? 0) + 1);
  return now.filter((c) => {
    const n = left.get(c.text) ?? 0;
    if (n > 0) left.set(c.text, n - 1);
    return n === 0;
  });
};

const SAY_IT_IN_CODE = "Say it in the code: a name, a type, a test. Then delete the comment.";
const ENCODE_IT = "Encode it as a check (`ratchet rule add`, or a test), then delete the comment.";

/** `before` is the text of every comment the file held at the session's baseline, or null when that is not known: then nothing is charged. */
export const judgeComments = ({ file, content, before, config }: { file: string; content: string; before: string[] | null; config: CommentsConfig }): Finding[] => {
  const mode = config.mode ?? "off";
  if (mode === "off" || before === null) return [];
  const all = findComments(file, content);
  if (all.length === 0) return [];
  const lines = content.split(/\r?\n/);
  const added = newComments({ now: all, before }).filter((c) => !isAllowed({ file, comment: c, lines, config }));
  const charged = mode === "ban" ? added : added.filter((c) => EXCUSE.test(c.text));
  if (charged.length === 0) return [];
  const claims = charged.filter((c) => CLAIM.test(c.text));
  const where = charged.slice(0, 8).map((c) => c.line).join(", ");
  const kind = mode === "ban" ? "comment line" : "comment that argues for a shortcut";
  return [
    {
      kind: "comment",
      file,
      title: `${charged.length} ${kind}${charged.length === 1 ? "" : "s"} added (line${charged.length === 1 ? "" : "s"} ${where})`,
      detail: `Comments are where an agent writes down why it did not do the right thing, and a comment is not enforced by anything. This session added ${charged.length}: ${charged.slice(0, 2).map((c) => `"${c.text.slice(0, 70)}"`).join(", ")}.`,
      fix: claims.length > 0 && claims.length === charged.length ? ENCODE_IT : claims.length > 0 ? `${SAY_IT_IN_CODE} For the one that says not to change something: ${ENCODE_IT}` : SAY_IT_IN_CODE,
      blocking: mode === "ban",
    },
  ];
};
