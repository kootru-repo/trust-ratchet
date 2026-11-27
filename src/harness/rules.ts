// SPDX-License-Identifier: AGPL-3.0-only
import { escapeRegExp } from "../pack.ts";

/**
 * A correction turned into a program (T2). `fix` is required: the message the agent reads must say what to do (T7).
 * `baseline` lets a rule be switched on over a backlog (T3): a file's count may fall, never rise.
 */
export type Rule = {
  id: string;
  /** ban-pattern: a regular expression on any line. ban-import: the same, on import lines only (T5). ban-api: a literal name such as os.system, matched as a whole name outside comment lines (T4). */
  kind: "ban-pattern" | "ban-import" | "ban-api";
  pattern: string;
  /** "statement": the pattern is tried on each whole statement, joined over the lines its brackets span, so a call written over several lines is seen. Absent: line by line. */
  scope?: "line" | "statement";
  /** Globs relative to the repository root, forward slashes. `**` crosses folders. */
  files: string[];
  message: string;
  fix: string;
  /** firedBefore: lines the fix commit removed that the rule fires on. firedAfter: lines it added that the rule fires on (0 for a proven rule). */
  proof?: { commit: string; file: string; firedBefore: number; firedAfter: number };
  baseline?: Record<string, number>;
  /** "auto": the autonomous loop wrote it from a fix. Absent: a person did. The loop only ever changes its own. */
  origin?: "auto";
  /** For a rule the loop wrote: past fix commits, other than its own, that took out a line it fires on (support), the places it fired in the tree when written (standing), and the fix commits read. */
  evidence?: { support: number; standing: number; read: number };
  /** "correction": written from what a session changed after a correction given in chat, not from a fix commit. Weaker evidence: the change holds the whole turn. */
  from?: "correction";
  /** "trial": it reports and never holds a turn, until the ledger shows a finding of it was fixed. */
  stage?: "trial";
};

export type Finding = {
  kind: "syntax" | "rule" | "hatch" | "comment" | "check" | "test" | "driver";
  /** Relative to the repository root. */
  file?: string;
  title: string;
  detail: string;
  fix: string;
  /** False for a fact that is reported but may not hold the turn: an inherited failure, or a check that could not run. */
  blocking: boolean;
};

/** Pure: a glob as a regular expression over a forward-slash path. */
export const globToRegExp = (glob: string): RegExp => {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] as string;
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      out += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += escapeRegExp(c);
  }
  return new RegExp(`^${out}$`);
};

// A glob that starts with ! takes files out again, for example ["pkg/*.py", "!pkg/test_*.py"].
export const matchesAny = (file: string, globs: string[]): boolean =>
  globs.some((g) => !g.startsWith("!") && globToRegExp(g).test(file)) && !globs.some((g) => g.startsWith("!") && globToRegExp(g.slice(1)).test(file));

const CR_ESCAPE = /^\\(r|x0[dD]|u000[dD]|c[mM]|0?15(?![0-9]))/;
const OPTIONAL = /^(\?|\*|\{0[,}])/;

const LF_ESCAPE = /^\\(n|x0[aA]|u000[aA]|c[jJ]|0?12(?![0-9]))/;

/**
 * Pure: must every match of this pattern (compiled with no flags) contain a carriage return? A CR is the character
 * itself or an escape (\r, \x0d, \u000d, \cM, \015). Only a plain case counts, so a working rule is never refused:
 * a CR, or a class of nothing but CR and LF ([\r\n]), at the top level of the pattern, not followed by ?, * or {0,.
 * A CR in a group, in a class with other members ([ \t\r]) or a negated one, or in a pattern with a top-level |
 * does not count. Backslashes are read in pairs, so \\r is a backslash and an r.
 */
export const matchesCarriageReturn = (pattern: string): boolean => {
  let cls: { negated: boolean; cr: boolean; other: boolean } | null = null;
  let depth = 0;
  let alternation = false;
  let required = false;
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    const rest = pattern.slice(i);
    if (cls === null && ch === "[") {
      cls = { negated: pattern[i + 1] === "^", cr: false, other: false };
      i += cls.negated ? 2 : 1;
      continue;
    }
    if (cls !== null && ch === "]") {
      if (cls.cr && !cls.other && !cls.negated && depth === 0 && !OPTIONAL.test(pattern.slice(i + 1))) required = true;
      cls = null;
      i += 1;
      continue;
    }
    if (cls === null && (ch === "(" || ch === ")" || ch === "|")) {
      if (ch === "(") depth += 1;
      else if (ch === ")") depth = Math.max(0, depth - 1);
      else if (depth === 0) alternation = true;
      i += 1;
      continue;
    }
    const cr = ch === "\\" ? CR_ESCAPE.exec(rest) : null;
    const lf = ch === "\\" && cr === null ? LF_ESCAPE.exec(rest) : null;
    const len = cr ? cr[0].length : lf ? lf[0].length : ch === "\\" ? 2 : 1;
    const isCr = cr !== null || ch === "\r";
    if (cls !== null) {
      if (isCr) cls.cr = true;
      else if (lf === null && ch !== "\n") cls.other = true;
    } else if (isCr && depth === 0 && !OPTIONAL.test(pattern.slice(i + len))) required = true;
    i += len;
  }
  return required && !alternation;
};

/** Pure: what is wrong with a rule as written, or nothing. */
export const ruleProblems = (rule: Partial<Rule>): string[] => {
  const out: string[] = [];
  if (!rule.id || !/^[a-z0-9][a-z0-9-]*$/.test(rule.id)) out.push("id must be lower case letters, digits and hyphens");
  if (rule.kind !== "ban-pattern" && rule.kind !== "ban-import" && rule.kind !== "ban-api") out.push("kind must be ban-pattern, ban-import or ban-api");
  if (!rule.pattern) out.push("pattern is missing");
  else if (rule.kind !== "ban-api") {
    try {
      new RegExp(rule.pattern);
    } catch (e) {
      out.push(`pattern is not a regular expression: ${(e as Error).message}`);
    }
    if (matchesCarriageReturn(rule.pattern)) out.push("pattern looks for a carriage return, which a rule never sees: files are split into lines on \\r?\\n first. Use a check that reads bytes instead, such as the built-in LF line-endings check");
  }
  if (rule.scope !== undefined && rule.scope !== "line" && rule.scope !== "statement") out.push("scope must be line or statement");
  if (!rule.files || rule.files.length === 0) out.push("files is missing: name the globs the rule covers");
  if (!rule.message?.trim()) out.push("message is missing");
  if (!rule.fix?.trim()) out.push("fix is missing: a rule must say what to do instead");
  return out;
};

const IMPORT_LINE = /^\s*(import\b|from\s+\S+\s+import\b|export\s.*\bfrom\b|.*\brequire\s*\()/;
const COMMENT_LINE = /^\s*(\/\/|#|\*|\/\*)/;

/**
 * Pure: a file as statements. A statement runs on while a bracket opened in it is still open (40 lines at most).
 * Brackets inside strings are counted too: this is a reader for rules, not a parser.
 */
export const statements = (content: string): { line: number; text: string }[] => {
  const lines = content.split(/\r?\n/);
  const out: { line: number; text: string }[] = [];
  let i = 0;
  while (i < lines.length) {
    const start = i;
    let depth = 0;
    let text = "";
    do {
      const l = lines[i] as string;
      text += (text ? " " : "") + l.trim();
      for (const ch of l) depth += "([{".includes(ch) ? 1 : ")]}".includes(ch) ? -1 : 0;
      i += 1;
    } while (depth > 0 && i < lines.length && i - start < 40);
    out.push({ line: start + 1, text });
  }
  return out;
};

/** Pure: the 1-based lines of `content` the rule fires on (for a statement rule, the line each statement starts on). */
export const ruleLines = (rule: Rule, content: string): number[] => {
  const re = rule.kind === "ban-api" ? new RegExp(`(?<![\\w.])${escapeRegExp(rule.pattern)}(?![\\w])`) : new RegExp(rule.pattern);
  const out: number[] = [];
  const units = rule.scope === "statement" ? statements(content) : content.split(/\r?\n/).map((text, i) => ({ line: i + 1, text }));
  for (const { line, text } of units) {
    if (rule.kind === "ban-import" && !IMPORT_LINE.test(text)) continue;
    if (rule.kind === "ban-api" && COMMENT_LINE.test(text)) continue;
    if (re.test(text)) out.push(line);
  }
  return out;
};

/** Pure: the rules a file breaks. A count at or under the file's baseline is the backlog, not a finding. */
export const judgeRules = ({ rules, file, content }: { rules: Rule[]; file: string; content: string }): Finding[] =>
  rules.flatMap((rule): Finding[] => {
    if (!matchesAny(file, rule.files)) return [];
    const lines = ruleLines(rule, content);
    const allowed = rule.baseline?.[file] ?? 0;
    if (lines.length <= allowed) return [];
    const where = `line${lines.length === 1 ? "" : "s"} ${lines.slice(0, 12).join(", ")}`;
    const backlog = allowed > 0 ? ` The file had ${allowed} when the rule was added and now has ${lines.length}: the count may fall, never rise.` : "";
    const trial = rule.stage === "trial";
    return [{ kind: "rule", file, title: `rule ${rule.id}, ${where}`, detail: `${rule.message}${backlog}${trial ? " (This rule is on trial: written by the harness from a past fix. It is reported and does not hold the turn.)" : ""}`, fix: rule.fix, blocking: !trial }];
  });

type HatchSet = { files: RegExp; patterns: { name: string; re: RegExp }[] };
/** Ways of switching a check off instead of fixing what it found (T6). */
export const HATCHES: HatchSet[] = [
  {
    files: /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/,
    patterns: [
      { name: "@ts-ignore", re: /@ts-ignore/ },
      { name: "@ts-expect-error", re: /@ts-expect-error/ },
      { name: "@ts-nocheck", re: /@ts-nocheck/ },
      { name: "eslint-disable", re: /eslint-disable/ },
      { name: "as any", re: /\bas\s+any\b/ },
      { name: "as unknown as", re: /\bas\s+unknown\s+as\b/ },
      { name: "skipped or only test", re: /\b(it|test|describe)\.(skip|only|todo)\s*\(/ },
    ],
  },
  {
    files: /\.pyi?$/,
    patterns: [
      { name: "type: ignore", re: /#\s*type:\s*ignore/ },
      { name: "noqa", re: /#\s*noqa\b/ },
      { name: "pylint: disable", re: /#\s*pylint:\s*disable/ },
      { name: "pragma: no cover", re: /#\s*pragma:\s*no cover/ },
      { name: "skipped test", re: /@(pytest\.mark\.(skip|skipif|xfail)|unittest\.skip)/ },
    ],
  },
];

export type Hatch = { name: string; line: number; text: string };

/** Pure: every escape hatch in a file. */
export const findHatches = (file: string, content: string): Hatch[] => {
  const set = HATCHES.find((h) => h.files.test(file));
  if (!set) return [];
  const out: Hatch[] = [];
  content.split(/\r?\n/).forEach((line, i) => {
    for (const p of set.patterns) if (p.re.test(line)) out.push({ name: p.name, line: i + 1, text: line.trim() });
  });
  return out;
};

/** Pure: the hatches in `now` that were not in the file before, matched by the text of their line. */
export const newHatches = ({ now, before }: { now: Hatch[]; before: string[] }): Hatch[] => {
  const left = new Map<string, number>();
  for (const t of before) left.set(t, (left.get(t) ?? 0) + 1);
  return now.filter((h) => {
    const n = left.get(h.text) ?? 0;
    if (n > 0) left.set(h.text, n - 1);
    return n === 0;
  });
};

export const judgeHatches = ({ file, content, before }: { file: string; content: string; before: string[] }): Finding[] => {
  const added = newHatches({ now: findHatches(file, content), before });
  if (added.length === 0) return [];
  return [
    {
      kind: "hatch",
      file,
      title: `${added.length} escape hatch${added.length === 1 ? "" : "es"} added: ${added.slice(0, 8).map((h) => `${h.name} (line ${h.line})`).join(", ")}`,
      detail: "This session added a way of switching a check off. A switched-off check reads to the next reader as permission to do the same.",
      fix: "Remove it and fix what the check reported. If the check itself is wrong, say so to the user in your reply and leave the hatch for them to accept.",
      blocking: true,
    },
  ];
};

/** Pure: the facts as the agent reads them. Each one names its fix. */
export const renderFindings = ({ findings, heading }: { findings: Finding[]; heading: string }): string =>
  [
    heading,
    ...findings.map((f, i) => {
      const body = f.detail.includes("\n") ? `\n${f.detail.split("\n").map((l) => `   ${l}`).join("\n")}\n  ` : ` ${f.detail}`;
      return `${i + 1}. ${f.file ? `${f.file}: ` : ""}${f.title}.${body} Fix: ${f.fix}`;
    }),
  ].join("\n");
