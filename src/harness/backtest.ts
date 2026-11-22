import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { fixFiles, proposeFromFix, reads_like_a_fix } from "./auto.ts";
import { DEFAULT_CAP, DEFAULT_SHAPES, type Shape } from "./propose.ts";
import { matchesAny, ruleLines, statements, type Rule } from "./rules.ts";
import { writeJson } from "./state.ts";

/**
 * A walk-forward backtest of the loop's rule learning on a repository's own history. It walks the commits oldest
 * first. At each fix commit it writes the rule the loop would have written, counting hits in the tree of that
 * commit, never a later one. Every rule already written is then tried on each later commit:
 *
 *   caught          a line the rule fires on, written after the rule existed, was removed by a later fix commit.
 *                   The rule would have reported that fault at the edit that wrote it.
 *   backlog fixed   the same, for a line that was already there when the rule was written.
 *   never fixed     a line the rule fires on, written after the rule existed, that no fix removed by the end of the
 *                   walk. This bounds the false alarms from above: some of these are faults nobody fixed yet.
 *   removed otherwise   such a line removed by a commit that is not a fix.
 *
 * It is a reading of history, not a trial: nobody saw the reports, so it cannot say a fault would have been avoided,
 * only that it would have been named.
 */
export type BtRule = { id: string; shape: string; pattern: string; files: string[]; rule: Rule; at: number; commit: string; hitsWhenWritten: number; flagged: number; caught: number; caughtIn: string[]; backlogFixed: number; /** Lines already there when the rule was written, taken out later by a commit that is not a fix: siblings cleaned up. */ backlogRemoved?: number; removedOtherwise: number; live: Record<string, number> };
export type BtState = { key: string; next: number; total: number; fixes: number; skipped: number; rules: BtRule[]; done: boolean };
export type BtArgs = { root: string; max?: number; from?: number; to?: number; cap?: number; shapes?: readonly Shape[]; exclude?: string[]; minutes?: number; statePath?: string; resume?: boolean; /** The share of memory in use, 0 to 1 (the machine's own, unless a test names one). */ memory?: () => number };

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi)$/;
const git = (root: string, args: string[], input?: string): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, windowsHide: true, stdio: ["pipe", "pipe", "ignore"], ...(input === undefined ? {} : { input }) });
const tryGit = (root: string, args: string[]): string | null => {
  try {
    return git(root, args);
  } catch {
    return null;
  }
};

/** Pure: the text of every unit (line or statement) of `content` the rule fires on. */
export const firing = (rule: Rule, content: string): string[] => {
  if (content === "") return [];
  const lines = ruleLines(rule, content);
  if (lines.length === 0) return [];
  const text = new Map<number, string>(rule.scope === "statement" ? statements(content).map((s) => [s.line, s.text] as const) : content.split(/\r?\n/).map((t, i) => [i + 1, t] as const));
  return lines.map((n) => (text.get(n) ?? "").replace(/\s+/g, " ").trim());
};

/**
 * Pure: one rule, one file, one commit. `live` holds the firing lines written after the rule existed. A line that
 * stops firing while another starts is an edit in place and keeps its standing; only the surplus is new or gone.
 */
export const step = ({ live, before, after, isFix }: { live: Record<string, number>; before: string[]; after: string[]; isFix: boolean }): { live: Record<string, number>; flagged: number; caught: number; backlogFixed: number; backlogRemoved: number; removedOtherwise: number } => {
  const next = { ...live };
  const count = (list: string[]): Map<string, number> => list.reduce((m, t) => m.set(t, (m.get(t) ?? 0) + 1), new Map<string, number>());
  const b = count(before);
  const a = count(after);
  const gone: string[] = [];
  const fresh: string[] = [];
  for (const [t, n] of b) for (let i = 0; i < n - (a.get(t) ?? 0); i += 1) gone.push(t);
  for (const [t, n] of a) for (let i = 0; i < n - (b.get(t) ?? 0); i += 1) fresh.push(t);
  const drop = (t: string): boolean => {
    if ((next[t] ?? 0) <= 0) return false;
    next[t] = (next[t] ?? 0) - 1;
    if (next[t] === 0) delete next[t];
    return true;
  };
  const out = { live: next, flagged: 0, caught: 0, backlogFixed: 0, backlogRemoved: 0, removedOtherwise: 0 };
  const edits = Math.min(gone.length, fresh.length);
  for (let i = 0; i < edits; i += 1) if (drop(gone[i] as string)) next[fresh[i] as string] = (next[fresh[i] as string] ?? 0) + 1;
  for (const t of gone.slice(edits)) {
    const wasNew = drop(t);
    if (!isFix) {
      if (wasNew) out.removedOtherwise += 1;
      else out.backlogRemoved += 1;
    }
    else if (wasNew) out.caught += 1;
    else out.backlogFixed += 1;
  }
  for (const t of fresh.slice(edits)) {
    next[t] = (next[t] ?? 0) + 1;
    out.flagged += 1;
  }
  return out;
};

/** The files of a commit's tree that match the globs, with their contents, read by one git process. */
const treeFiles = (root: string, commit: string, globs: string[], names: string[]): Map<string, string> => {
  const wanted = names.filter((f) => SOURCE.test(f) && matchesAny(f, globs));
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;
  const raw = execFileSync("git", ["-C", root, "cat-file", "--batch"], { input: wanted.map((f) => `${commit}:${f}`).join("\n") + "\n", maxBuffer: 2 * 1024 * 1024 * 1024, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  let at = 0;
  for (const f of wanted) {
    const eol = raw.indexOf(10, at);
    if (eol < 0) break;
    const head = raw.subarray(at, eol).toString("utf8");
    at = eol + 1;
    if (head.endsWith(" missing")) continue;
    const size = Number(head.split(" ")[2] ?? 0);
    const body = raw.subarray(at, at + size);
    at += size + 1;
    // A file with a zero byte is not text; a very large one is data.
    if (size < 1_500_000 && !body.includes(0)) out.set(f, body.toString("utf8"));
  }
  return out;
};

const memoryShare = (): number => 1 - os.freemem() / os.totalmem();

/** Runs, or goes on with, one backtest. It stops at the time limit with its state saved; call again with resume. */
export const backtest = ({ root, max = 400, from = 0, to, cap = DEFAULT_CAP, shapes = DEFAULT_SHAPES, exclude = [], minutes = 20, statePath, resume = false, memory = memoryShare }: BtArgs): BtState => {
  const all = git(root, ["log", "--no-merges", "--reverse", "--format=%H\t%s", `-${Math.max(1, max)}`, "HEAD"]).split(/\r?\n/).filter(Boolean);
  // git applies -N before --reverse: these are the newest `max` commits, oldest first.
  const commits = all.slice(from, to ?? all.length).map((l) => ({ hash: l.slice(0, l.indexOf("\t")), subject: l.slice(l.indexOf("\t") + 1) }));
  const key = JSON.stringify({ max, from, to: to ?? null, cap, shapes: [...shapes].sort(), exclude, head: commits[commits.length - 1]?.hash ?? "" });
  const saved = resume && statePath && fs.existsSync(statePath) ? (JSON.parse(fs.readFileSync(statePath, "utf8")) as BtState) : null;
  const state: BtState = saved && saved.key === key ? saved : { key, next: 0, total: commits.length, fixes: 0, skipped: 0, rules: [], done: false };
  const started = Date.now();
  const save = (): void => {
    if (statePath) writeJson(statePath, state);
  };
  while (state.next < commits.length) {
    if ((Date.now() - started) / 60_000 >= minutes || memory() >= 0.9) break;
    const { hash, subject } = commits[state.next] as { hash: string; subject: string };
    const isFix = reads_like_a_fix(subject);
    const changed = (tryGit(root, ["show", "-M", "--name-status", "--format=", hash]) ?? "").split(/\r?\n/).filter(Boolean).map((l) => l.split("\t")).map((c) => ({ status: (c[0] ?? "")[0] ?? "", was: c[1] ?? "", now: c[2] ?? c[1] ?? "" })).filter((c) => SOURCE.test(c.now) || SOURCE.test(c.was));
    if (changed.length > 60) {
      state.skipped += 1;
    } else {
      // 1. Every rule written so far is tried on what this commit changed.
      for (const c of changed) {
        const rules = state.rules.filter((r) => matchesAny(c.now, r.files) || matchesAny(c.was, r.files));
        if (rules.length === 0) continue;
        const before = c.status === "A" ? "" : (tryGit(root, ["show", `${hash}^:${c.was}`]) ?? "");
        const after = c.status === "D" ? "" : (tryGit(root, ["show", `${hash}:${c.now}`]) ?? "");
        for (const r of rules) {
          const prefix = (f: string): string => `${f}\t`;
          const mine = (f: string): Record<string, number> => Object.fromEntries(Object.entries(r.live).filter(([k]) => k.startsWith(prefix(f))).map(([k, n]) => [k.slice(prefix(f).length), n]));
          const result = step({ live: mine(c.was), before: matchesAny(c.was, r.files) ? firing(r.rule, before) : [], after: matchesAny(c.now, r.files) ? firing(r.rule, after) : [], isFix });
          for (const k of Object.keys(r.live)) if (k.startsWith(prefix(c.was))) delete r.live[k];
          for (const [t, n] of Object.entries(result.live)) r.live[`${prefix(c.now)}${t}`] = n;
          r.flagged += result.flagged;
          r.caught += result.caught;
          if (result.caught > 0) r.caughtIn.push(hash.slice(0, 8));
          r.backlogFixed += result.backlogFixed;
          r.backlogRemoved = (r.backlogRemoved ?? 0) + result.backlogRemoved;
          r.removedOtherwise += result.removedOtherwise;
        }
      }
      // 2. A fix commit may write a rule, counted in its own tree.
      if (isFix) {
        state.fixes += 1;
        let fix: ReturnType<typeof fixFiles> = [];
        try {
          fix = fixFiles(root, hash).filter((f) => !matchesAny(f.file, exclude));
        } catch {
          fix = [];
        }
        if (fix.length > 0 && fix.length <= 8) {
          let names: string[] | null = null;
          const cache = new Map<string, Map<string, string>>();
          const count = (rule: Rule): number => {
            names ??= git(root, ["ls-tree", "-r", "--name-only", hash]).split(/\r?\n/).filter(Boolean);
            const k = rule.files.join("|");
            if (!cache.has(k)) cache.set(k, treeFiles(root, hash, rule.files, names));
            let n = 0;
            for (const text of (cache.get(k) as Map<string, string>).values()) n += ruleLines(rule, text).length;
            return n;
          };
          const pick = proposeFromFix({ fix, count, cap, shapes });
          if (pick && !state.rules.some((r) => r.pattern === pick.candidate.pattern && r.files.join() === pick.candidate.files.join())) {
            const { shape, was: _was, ...body } = pick.candidate;
            state.rules.push({ id: `bt-${hash.slice(0, 7)}`, shape, pattern: body.pattern, files: body.files, rule: { id: `bt-${hash.slice(0, 7)}`, ...body }, at: state.next, commit: hash, hitsWhenWritten: pick.hits, flagged: 0, caught: 0, caughtIn: [], backlogFixed: 0, removedOtherwise: 0, live: {} });
          }
        }
      }
    }
    state.next += 1;
    if (state.next % 20 === 0) save();
  }
  state.done = state.next >= commits.length;
  save();
  return state;
};

export type BtSummary = { commits: number; fixes: number; skipped: number; rules: number; caught: number; backlogFixed: number; backlogRemoved: number; flagged: number; neverFixed: number; removedOtherwise: number; byShape: Record<string, { rules: number; caught: number; neverFixed: number; backlogFixed: number }> };

/** Pure: the totals of a backtest, and the same per shape. */
export const summarize = (state: BtState): BtSummary => {
  const never = (r: BtRule): number => Object.values(r.live).reduce((a, b) => a + b, 0);
  const sum = (pick: (r: BtRule) => number, rules: BtRule[] = state.rules): number => rules.reduce((n, r) => n + pick(r), 0);
  const byShape: BtSummary["byShape"] = {};
  for (const shape of new Set(state.rules.map((r) => r.shape))) {
    const rules = state.rules.filter((r) => r.shape === shape);
    byShape[shape] = { rules: rules.length, caught: sum((r) => r.caught, rules), neverFixed: sum(never, rules), backlogFixed: sum((r) => r.backlogFixed, rules) };
  }
  return { commits: state.next, fixes: state.fixes, skipped: state.skipped, rules: state.rules.length, caught: sum((r) => r.caught), backlogFixed: sum((r) => r.backlogFixed), backlogRemoved: sum((r) => r.backlogRemoved ?? 0), flagged: sum((r) => r.flagged), neverFixed: sum(never), removedOtherwise: sum((r) => r.removedOtherwise), byShape };
};

export const renderBacktest = ({ root, state }: { root: string; state: BtState }): string => {
  const s = summarize(state);
  return [
    `Backtest of ${root}: ${s.commits} of ${state.total} commits read${state.done ? "" : " (not finished: run again with --resume)"}, ${s.fixes} read like a fix, ${s.skipped} skipped as bulk changes.`,
    `Rules the loop would have written: ${s.rules}. Later faults they would have named when written: ${s.caught}. Lines already there when a rule was written: ${s.backlogFixed} taken out later by a fix, ${s.backlogRemoved} by a commit that is not a fix.`,
    `Lines they flagged after being written: ${s.flagged}. Of these never fixed by the end: ${s.neverFixed} (the upper bound on false alarms); removed by a commit that is not a fix: ${s.removedOtherwise}.`,
    ...Object.entries(s.byShape).map(([shape, v]) => `  ${shape}: ${v.rules} rules, ${v.caught} caught, ${v.backlogFixed} backlog fixed, ${v.neverFixed} never fixed`),
    ...state.rules.filter((r) => r.caught > 0).map((r) => `  caught by ${r.id} (${r.shape}) ${JSON.stringify(r.pattern)} in ${r.files.join(", ")}: fixes ${r.caughtIn.join(", ")}`),
    "This reads history. It says a fault would have been named at the edit that wrote it, not that it would have been avoided.",
  ].join("\n");
};
