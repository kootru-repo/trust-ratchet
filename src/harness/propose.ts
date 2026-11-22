// SPDX-License-Identifier: AGPL-3.0-only
import { statements, type Rule } from "./rules.ts";

/**
 * Rule proposals written by a program from one fix commit (T2, made autonomous). A proposal is only a candidate:
 * the caller proves it on the fix (it must fire on a line the fix removed and on none it added) and counts it in
 * the tree before anything is stored. Nothing here judges; it only writes down what the fix changed, as a pattern.
 */
export const ALL_SHAPES = ["keyword-added", "name-swapped", "keyword-removed", "constant-swapped", "import-swapped", "await-added", "operator-swapped"] as const;
export type Shape = (typeof ALL_SHAPES)[number];
/** The shapes the loop uses when nothing else is said: those that caught a later fix on history they were not tuned on. */
export const DEFAULT_SHAPES: readonly Shape[] = ["keyword-added", "name-swapped"];
/** A pattern that fires in more places than this names a habit, not a fault. Taken from the backtest. */
export const DEFAULT_CAP = 25;
export type FixFile = { file: string; removed: string[]; added: string[]; after: string; /** The text before, where the change is not a commit. */ before?: string };
export type Candidate = Pick<Rule, "kind" | "pattern" | "files" | "message" | "fix"> & { scope?: "statement"; shape: Shape; /** name-swapped: the name the fix replaced. */ was?: string };

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A comment after the code is not part of the statement the fix changed.
const squash = (s: string): string => s.replace(/\s{2,}#\s.*$|\s+\/\/\s.*$/, "").replace(/\s+/g, " ").trim();
const ext = (file: string): string => /\.[A-Za-z]+$/.exec(file)?.[0] ?? "";
const dirGlob = (file: string): string => `${file.includes("/") ? `${file.slice(0, file.lastIndexOf("/"))}/` : ""}*${ext(file)}`;
const topGlob = (file: string): string => (file.includes("/") ? `${file.split("/")[0]}/**/*${ext(file)}` : `*${ext(file)}`);
const KWARG = /,\s*(\w+)\s*=\s*("[^"]*"|'[^']*'|[\w.]+)/g;
const WORDS = new Set(["if", "for", "while", "return", "print", "and", "or", "not", "in", "is", "def", "class", "function", "switch", "catch", "typeof", "await", "new", "raise", "assert", "with", "elif", "else", "lambda", "yield", "except", "import", "from"]);

/** The name of the call that encloses position `at`: the nearest bracket opened before it and still open there. */
const calleeAt = (text: string, at: number): string | null => {
  let depth = 0;
  for (let i = at - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === ")" || ch === "]" || ch === "}") depth += 1;
    else if (ch === "(" || ch === "[" || ch === "{") {
      if (depth > 0) depth -= 1;
      else return ch === "(" ? (/([A-Za-z_][\w.]*)$/.exec(text.slice(0, i))?.[1] ?? null) : null;
    }
  }
  return null;
};

/** Shape 1: the fix added keyword arguments to a call and changed nothing else in that statement. */
const keywordAdded = (f: FixFile): Candidate[] => {
  const out: Candidate[] = [];
  const before = statements(f.removed.join("\n")).map((s) => squash(s.text)).filter(Boolean);
  for (const a of statements(f.added.join("\n")).map((s) => squash(s.text)).filter(Boolean)) {
    for (const r of before) {
      const fresh = [...a.matchAll(KWARG)].filter((m) => !new RegExp(`\\b${m[1]}\\s*=`).test(r));
      if (fresh.length === 0) continue;
      let stripped = a;
      for (const m of fresh) stripped = stripped.replace(m[0], "");
      if (squash(stripped) !== r) continue;
      const first = fresh[0];
      const callee = first?.index === undefined ? null : calleeAt(a, first.index);
      if (!first || !callee || WORDS.has(callee)) continue;
      const added = fresh.map((m) => `${m[1]}=${m[2]}`).join(", ");
      const make = (trigger: string | null): Candidate => ({
        shape: "keyword-added",
        kind: "ban-pattern",
        scope: "statement",
        pattern: `${esc(callee)}\\(${trigger ? `(?=.*\\b${esc(trigger)}\\b)` : ""}(?!.*\\b${first[1]}=)`,
        files: [topGlob(f.file)],
        message: `A fix had to add ${added} to a call of ${callee}${trigger ? ` that has ${trigger}` : ""}: the same call without ${first[1]}= has the same fault`,
        fix: `Add ${added} to the call, as the fix did.`,
      });
      // The narrower forms name one argument the faulty call already had: the fault may depend on it.
      const had = [...r.matchAll(/\b(\w+)\s*=\s*(True|False|None|true|false|null|"[^"]*"|'[^']*'|\d+)/g)].map((m) => `${m[1]}=${m[2]}`);
      out.push(make(null), ...[...new Set(had)].map((t) => make(t)));
    }
  }
  return out;
};

const tokens = (line: string): string[] => line.match(/[A-Za-z_][\w.]*|"[^"]*"|'[^']*'|\S/g) ?? [];

/** Shape 2: one line was replaced by the same line with one name changed (an exception class, a function, a constant). */
const nameSwapped = (f: FixFile): Candidate[] => {
  const out: Candidate[] = [];
  for (const r of f.removed) {
    for (const a of f.added) {
      const tr = tokens(r);
      const ta = tokens(a);
      if (tr.length !== ta.length || tr.length < 3) continue;
      const diff = tr.map((t, i) => (t === ta[i] ? -1 : i)).filter((i) => i >= 0);
      const at = diff[0];
      if (diff.length !== 1 || at === undefined) continue;
      const was = tr[at] ?? "";
      const now = ta[at] ?? "";
      if (!/^[A-Za-z_][\w.]*$/.test(was) || !/^[A-Za-z_][\w.]*$/.test(now)) continue;
      const prev = tr[at - 1] ?? "";
      // A renamed variable is not a fault class. The name must be called, raised, thrown, built or caught on that line.
      if (tr[at + 1] !== "(" && !/^(raise|throw|new|except|catch)$/.test(prev)) continue;
      const lead = at > 0 && /^[A-Za-z_]\w*$/.test(tr[at - 1] ?? "") ? `\\b${esc(tr[at - 1] ?? "")}\\s+` : "(?<![\\w.])";
      const call = tr[at + 1] === "(" ? "\\(" : "\\b";
      const say = (text: string | null): Candidate => ({
        shape: "name-swapped",
        was,
        kind: "ban-pattern",
        pattern: `${lead}${esc(was)}${call}${text ? `.*${esc(text)}` : ""}`,
        files: [dirGlob(f.file)],
        message: `A fix replaced ${was} by ${now} here${text ? ` on a line that says "${text}"` : ""}: ${was} in the same place has the same fault`,
        fix: `Use ${now}, as the fix did.`,
      });
      // A string on the line says what the line is about. Its shorter word runs are tried too: the fault is rarely tied to one exact sentence.
      const words = (tr.find((t, i) => i > at && /^["'][^"']*[A-Za-z]{3,} [A-Za-z]{2,}/.test(t)) ?? "").replace(/^["']|["']$/g, "").match(/[A-Za-z]+/g) ?? [];
      const runs: string[] = [];
      for (let n = Math.min(words.length, 5); n >= 2; n -= 1) for (let i = 0; i + n <= words.length; i += 1) runs.push(words.slice(i, i + n).join(" "));
      out.push(say(null), ...runs.filter((run) => r.includes(run)).map((run) => say(run)));
    }
  }
  return out;
};

const CONST = /^(True|False|None|true|false|null|undefined|"[^"]*"|'[^']*')$/;
const isScript = (file: string): boolean => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file);

/** Shape 3: the fix took keyword arguments out of a call and changed nothing else in that statement. */
const keywordRemoved = (f: FixFile): Candidate[] => {
  const out: Candidate[] = [];
  const after = statements(f.added.join("\n")).map((x) => squash(x.text)).filter(Boolean);
  for (const r of statements(f.removed.join("\n")).map((x) => squash(x.text)).filter(Boolean)) {
    for (const a of after) {
      const gone = [...r.matchAll(KWARG)].filter((m) => !new RegExp(`\\b${m[1]}\\s*=`).test(a));
      if (gone.length === 0) continue;
      let stripped = r;
      for (const m of gone) stripped = stripped.replace(m[0], "");
      if (squash(stripped) !== a) continue;
      const first = gone[0];
      const callee = first?.index === undefined ? null : calleeAt(r, first.index);
      if (!first || !callee || WORDS.has(callee)) continue;
      const make = (value: string | null): Candidate => ({
        shape: "keyword-removed",
        kind: "ban-pattern",
        scope: "statement",
        pattern: `${esc(callee)}\\((?=.*\\b${first[1]}\\s*=${value ? `\\s*${esc(value)}(?![\\w.])` : ""})`,
        files: [topGlob(f.file)],
        message: `A fix had to take ${first[1]}=${value ?? "..."} out of a call of ${callee}: the same call with it has the same fault`,
        fix: `Take ${first[1]}= out of the call, as the fix did.`,
      });
      out.push(...(CONST.test(first[2] ?? "") ? [make(first[2] ?? null)] : []), make(null));
    }
  }
  return out;
};

/** The one place two token lists of equal length differ, or -1. */
const oneDiff = (tr: string[], ta: string[]): number => {
  if (tr.length !== ta.length || tr.length < 3) return -1;
  const diff = tr.map((t, i) => (t === ta[i] ? -1 : i)).filter((i) => i >= 0);
  return diff.length === 1 ? (diff[0] ?? -1) : -1;
};

/** Shape 4: one keyword argument of a call got another constant (True for False, one string for another). */
const constantSwapped = (f: FixFile): Candidate[] => {
  const out: Candidate[] = [];
  for (const r of f.removed) {
    for (const a of f.added) {
      const tr = tokens(r);
      const at = oneDiff(tr, tokens(a));
      const was = tr[at] ?? "";
      const now = tokens(a)[at] ?? "";
      const kw = tr[at - 2] ?? "";
      if (at < 2 || !CONST.test(was) || !CONST.test(now) || tr[at - 1] !== "=" || !/^[A-Za-z_]\w*$/.test(kw)) continue;
      const where = new RegExp(`\\b${esc(kw)}\\s*=\\s*${esc(was)}`).exec(r);
      const callee = where ? calleeAt(r, where.index) : null;
      if (!callee || WORDS.has(callee)) continue;
      out.push({
        shape: "constant-swapped",
        kind: "ban-pattern",
        scope: "statement",
        pattern: `${esc(callee)}\\((?=.*\\b${esc(kw)}\\s*=\\s*${esc(was)}(?![\\w.]))`,
        files: [topGlob(f.file)],
        message: `A fix changed ${kw}=${was} to ${kw}=${now} in a call of ${callee}: the same call with ${kw}=${was} has the same fault`,
        fix: `Use ${kw}=${now}, as the fix did.`,
      });
    }
  }
  return out;
};

const MODULE = [/^\s*from\s+([\w.]+)\s+import\s+(.+)$/, /^\s*import\s+(.+?)\s+from\s+["']([^"']+)["'];?\s*$/];

/** Shape 5: the same names are imported, from another module. */
const importSwapped = (f: FixFile): Candidate[] => {
  const out: Candidate[] = [];
  const read = (line: string): { module: string; names: string } | null => {
    const py = MODULE[0]?.exec(line);
    if (py) return { module: py[1] ?? "", names: squash(py[2] ?? "") };
    const js = MODULE[1]?.exec(line);
    return js ? { module: js[2] ?? "", names: squash(js[1] ?? "") } : null;
  };
  for (const r of f.removed) {
    const was = read(r);
    if (!was) continue;
    for (const a of f.added) {
      const now = read(a);
      if (!now || now.names !== was.names || now.module === was.module) continue;
      out.push({
        shape: "import-swapped",
        kind: "ban-import",
        pattern: isScript(f.file) ? `from\\s+["']${esc(was.module)}["']` : `\\bfrom\\s+${esc(was.module)}\\s+import\\b`,
        files: [topGlob(f.file)],
        message: `A fix moved the import of ${was.names} from ${was.module} to ${now.module}: an import from ${was.module} here may have the same fault`,
        fix: `Import from ${now.module}, as the fix did.`,
      });
    }
  }
  return out;
};

/** Shape 6: the fix put await before a call and changed nothing else on the line. */
const awaitAdded = (f: FixFile): Candidate[] => {
  if (!isScript(f.file)) return [];
  const out: Candidate[] = [];
  const before = new Set(f.removed.map(squash).filter(Boolean));
  for (const a of f.added.map(squash)) {
    for (const m of a.matchAll(/\bawait\s+([A-Za-z_][\w.]*)\s*\(/g)) {
      const without = squash(`${a.slice(0, m.index)}${a.slice(m.index ?? 0).replace(/^await\s+/, "")}`);
      const name = m[1] ?? "";
      if (!before.has(without) || WORDS.has(name)) continue;
      out.push({
        shape: "await-added",
        kind: "ban-pattern",
        pattern: `(?<!await\\s)(?<!function\\s)(?<!async\\s)(?<![\\w.])${esc(name)}\\(`,
        files: [dirGlob(f.file)],
        message: `A fix had to put await before a call of ${name}: the same call without await has the same fault`,
        fix: `Await the call, as the fix did.`,
      });
    }
  }
  return out;
};

/** Shape 7: a loose comparison was made strict and nothing else changed on the line. */
const operatorSwapped = (f: FixFile): Candidate[] => {
  if (!isScript(f.file)) return [];
  const out: Candidate[] = [];
  const before = new Set(f.removed.map(squash).filter(Boolean));
  for (const a of f.added.map(squash)) {
    for (const [strict, loose, pattern] of [["===", "==", "(?<![=!<>])==(?!=)"], ["!==", "!=", "!=(?!=)"]] as const) {
      for (let i = a.indexOf(strict); i >= 0; i = a.indexOf(strict, i + 1)) {
        if (!before.has(squash(`${a.slice(0, i)}${loose}${a.slice(i + strict.length)}`))) continue;
        out.push({ shape: "operator-swapped", kind: "ban-pattern", pattern, files: [dirGlob(f.file)], message: `A fix changed ${loose} to ${strict} here: ${loose} in the same folder may have the same fault`, fix: `Use ${strict}, as the fix did.` });
      }
    }
  }
  return out;
};

const MAKERS: Record<Shape, (f: FixFile) => Candidate[]> = { "keyword-added": keywordAdded, "name-swapped": nameSwapped, "keyword-removed": keywordRemoved, "constant-swapped": constantSwapped, "import-swapped": importSwapped, "await-added": awaitAdded, "operator-swapped": operatorSwapped };

/** Pure: every candidate rule one changed file of a fix suggests, most specific shape first. */
export const candidates = (f: FixFile, shapes: readonly Shape[] = DEFAULT_SHAPES): Candidate[] => {
  const seen = new Set<string>();
  return ALL_SHAPES.filter((x) => shapes.includes(x))
    .flatMap((x) => MAKERS[x](f))
    .filter((c) => (seen.has(c.pattern) ? false : (seen.add(c.pattern), true)));
};

export type Judged = { candidate: Candidate; onRemoved: number; onAdded: number; /** Lines it fires on in the fixed files as the fix left them. */ leftByFix: number; hits: number; /** name-swapped: how often the replaced name is still used in the rule's files. 0 means it was renamed away. */ wasStillUsed?: number };

/**
 * Pure: the one candidate to keep, or null. It must be proven (fires on a removed line, on no added line) and its
 * hits in the tree must be at most `cap`: a pattern that fires all over a codebase names a habit, not a fault.
 * A candidate that fires on nothing the fix left standing in the files it touched comes first: the fixer saw those
 * lines and kept them, so a pattern that fires on them is probably too wide. Then the widest wins: it covers the
 * most siblings while staying under the cap. A rule kept this way is still only on trial.
 */
export const choose = ({ judged, cap }: { judged: Judged[]; cap: number }): Judged | null => {
  const ok = judged.filter((j) => j.onRemoved > 0 && j.onAdded === 0 && j.hits <= cap && (j.candidate.shape !== "name-swapped" || (j.wasStillUsed ?? 0) > 0) && (j.candidate.shape !== "import-swapped" || j.hits > 0));
  const order: readonly string[] = ALL_SHAPES;
  ok.sort((a, b) => Number(a.leftByFix > 0) - Number(b.leftByFix > 0) || order.indexOf(a.candidate.shape) - order.indexOf(b.candidate.shape) || b.hits - a.hits || a.candidate.pattern.length - b.candidate.pattern.length);
  return ok[0] ?? null;
};
