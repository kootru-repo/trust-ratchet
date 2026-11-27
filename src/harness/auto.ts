// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { forShell } from "../shellcmd.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isFixSubject } from "../history.ts";
import { census, countHatches } from "./cli.ts";
import { baselineStep, guardVerdicts, offUnseen, prevention, readBaseline, renderBaseline, renderPrevention, selfCheck } from "./insight.ts";
import { levelOf, renderLevel, SCHEME, type Level, type LevelFacts } from "./level.ts";
import { checkCandidates, hasTypescriptAt, readPackages, readPyprojects, readScripts, tryCheck } from "./checks.ts";
import { dropCorrection, fixFromCorrection, pendingCorrections } from "./corrections.ts";
import { logCorrection, logLessons } from "./lessons.ts";
import { featureMap, outcomes, parseLog } from "./outcomes.ts";
import { candidates, choose, DEFAULT_CAP, DEFAULT_SHAPES, type FixFile, type Judged, type Shape } from "./propose.ts";
import { matchesAny, ruleLines, type Rule } from "./rules.ts";
import { fileAtCommit, trackedFiles } from "./session.ts";
import { effective, home, normRoot, projectDir, projectFile, readConfig, readJson, readState, writeJson, writeText, type CheckCmd, type ProjectConfig } from "./state.ts";
import { isWritten, readRules } from "./turn.ts";
import { ceiling as limitCeiling, decide, effectiveLimits, renderLimits, turnStats, unrunAtEnd, type LastMove } from "./limits.ts";

/**
 * The autonomous loop. It runs after a turn, in its own process, and does four things without being asked:
 * learns (a rule from a fix, a test from a new test file), assesses (a ledger of what each rule and test did, the
 * verification level), improves (promotes what earned it, retires its own items that did not, lowers backlogs)
 * and reports. It can only tighten. It never raises a backlog or a ceiling, never changes the mode, never removes
 * or weakens anything a person added, never edits a file of the repository and never commits. Every change is
 * written to a log with what to do to undo it.
 */
export type AutoState = { root: string; /** Marks of the switch command, and how many contradictions of the measure were already told. */ onAt?: string; offBy?: string; contradictionsTold?: number; /** Written tests a session acted on: they hold a turn and are not put back on trial. */ guardsPromoted?: string[]; pointer?: string; recordPointer?: string; eventOffset?: number; skippedTests?: Record<string, string>; watched?: string[]; /** Checks tried and not kept, with the stamp of the file that suggested each. */ triedChecks?: Record<string, string>; /** The written tests: the commit read up to, and the fixes already tried. */ guardPointer?: string; guardTried?: string[]; /** The loop's last move of the turn-end limits. */ limitMove?: LastMove };
export type Tally = { fired: number; fixed: number; letGo: number };
/** open: the findings standing per session. stood: those already counted once as let go in that session. */
export type Ledger = { rules: Record<string, Tally>; open: Record<string, string[]>; stood?: Record<string, string[]>; /** The tally of a rule at the moment the loop promoted it. */ promoted?: Record<string, Tally> };
/** What the edit hook saw right after one edit: the rules that fire on that file now. */
export type EditEvent = { time: string; sessionId: string; file: string; rules: string[] };
export type RecordFile = { time: string; sessionId: string; mode: "advise" | "enforce"; held: boolean; findings: { kind: string; file?: string; title: string; blocking: boolean }[]; outcomes: { kind: string; name: string; status: string; seconds: number; note?: string }[]; wallS?: number; fileS?: number };
export type Change = { time: string; what: string; undo: string };

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi)$/;
/** A hand-run proof session has a made-up id. Only Claude Code's own sessions count as evidence. */
export const isRealSession = (id: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id);
const ruleOf = (title: string): string | null => /^rule ([a-z0-9-]+)/.exec(title)?.[1] ?? null;

const bumped = (rules: Record<string, Tally>, id: string, key: keyof Tally): Record<string, Tally> => ({ ...rules, [id]: { fired: 0, fixed: 0, letGo: 0, ...rules[id], [key]: (rules[id]?.[key] ?? 0) + 1 } });
const idOf = (key: string): string => key.split("\t")[0] ?? "";

/**
 * Pure: the ledger after one more turn record. A finding that was open in the session and is gone has been fixed.
 * One that stands when the turn is let go was not acted on; that is counted once per session and file, however
 * many turns it then stays.
 */
export const tally = (ledger: Ledger, rec: RecordFile): Ledger => {
  let rules = ledger.rules;
  const now = [...new Set(rec.findings.flatMap((f) => (f.kind === "rule" && ruleOf(f.title) ? [`${ruleOf(f.title)}\t${f.file ?? ""}`] : [])))];
  const before = ledger.open[rec.sessionId] ?? [];
  const stood = (ledger.stood?.[rec.sessionId] ?? []).filter((k) => now.includes(k));
  for (const key of before) if (!now.includes(key)) rules = bumped(rules, idOf(key), "fixed");
  for (const key of now) {
    if (!before.includes(key)) rules = bumped(rules, idOf(key), "fired");
    if (!rec.held && !stood.includes(key)) {
      rules = bumped(rules, idOf(key), "letGo");
      stood.push(key);
    }
  }
  return { ...ledger, rules, open: { ...ledger.open, [rec.sessionId]: now }, stood: { ...ledger.stood, [rec.sessionId]: stood } };
};

/**
 * Pure: the ledger after one edit. This is where a rule on trial is seen to work: it is told right after the edit
 * that broke it, and the next edit of that file either still has the finding or has fixed it.
 */
export const tallyEdit = (ledger: Ledger, ev: EditEvent): Ledger => {
  let rules = ledger.rules;
  const all = ledger.open[ev.sessionId] ?? [];
  const here = all.filter((k) => k.split("\t")[1] === ev.file);
  const now = [...new Set(ev.rules)].map((id) => `${id}\t${ev.file}`);
  for (const key of here) if (!now.includes(key)) rules = bumped(rules, idOf(key), "fixed");
  for (const key of now) if (!here.includes(key)) rules = bumped(rules, idOf(key), "fired");
  return { ...ledger, rules, open: { ...ledger.open, [ev.sessionId]: [...all.filter((k) => !here.includes(k)), ...now] } };
};

/**
 * Pure: what the ledger says to do with the rules the loop itself added. A person's rule is never touched.
 *
 * Promotion needs two occurrences that do not depend on each other: findings fixed in live sessions, plus past fix
 * commits other than the one the rule was written from (`evidence.support`). At least one must be live, and fixes
 * must outnumber the findings left standing. Never silence, never time.
 * Retirement: two findings left standing and none ever fixed.
 * Demotion: a rule the loop promoted goes back to trial when, since then, it was left standing at least twice and
 * more often than it was fixed. A rule that holds turns and is overruled is a false alarm until shown otherwise.
 */
export const verdicts = ({ rules, ledger }: { rules: Rule[]; ledger: Ledger }): { promote: string[]; retire: string[]; demote: string[] } => {
  const own = rules.filter((r) => r.origin === "auto");
  const trial = own.filter((r) => r.stage === "trial");
  const t = (id: string): Tally => ledger.rules[id] ?? { fired: 0, fixed: 0, letGo: 0 };
  const since = (id: string): Tally => {
    const at = ledger.promoted?.[id] ?? { fired: 0, fixed: 0, letGo: 0 };
    return { fired: t(id).fired - at.fired, fixed: t(id).fixed - at.fixed, letGo: t(id).letGo - at.letGo };
  };
  return {
    promote: trial.filter((r) => t(r.id).fixed >= 1 && t(r.id).fixed > t(r.id).letGo && t(r.id).fixed + (r.evidence?.support ?? 0) >= 2).map((r) => r.id),
    retire: trial.filter((r) => t(r.id).letGo >= 2 && t(r.id).fixed === 0).map((r) => r.id),
    demote: own.filter((r) => r.stage !== "trial" && since(r.id).letGo >= 2 && since(r.id).letGo > since(r.id).fixed).map((r) => r.id),
  };
};

/** Pure: every rule with what stands behind it. Precision is fixed over fixed plus left standing; with nothing seen there is none to state. */
export const renderEvidence = ({ rules, ledger }: { rules: Rule[]; ledger: Ledger }): string =>
  rules.length === 0
    ? "No rules."
    : rules
        .map((r) => {
          const t = ledger.rules[r.id] ?? { fired: 0, fixed: 0, letGo: 0 };
          const seen = t.fixed + t.letGo;
          const who = r.origin === "auto" ? (r.stage === "trial" ? "loop, on trial" : "loop, holds a turn") : "person, holds a turn";
          const proof = r.proof ? (r.from === "correction" ? "proven on a change after a chat correction" : `proven on fix ${r.proof.commit.slice(0, 8)}`) : "not proven on a past fix";
          return `${r.id} (${who}; ${proof}): live fired ${t.fired}, fixed ${t.fixed}, left standing ${t.letGo}${seen > 0 ? `, precision ${Math.round((100 * t.fixed) / seen)}%` : ""}${r.evidence ? `; ${r.evidence.support} other past fix(es) of ${r.evidence.read} read, ${r.evidence.standing} standing when written` : ""}`;
        })
        .join("\n");

/** One fix commit of the history, as the lines it took out and put in, per source file. */
export type PastFix = { commit: string; files: { file: string; removed: string[]; added: string[] }[] };

/** The fix commits among the last `max` commits, read by one git process. */
export const pastFixes = (root: string, max = 400): PastFix[] => {
  let out = "";
  try {
    out = git(root, ["log", `-${max}`, "--no-merges", "--no-renames", "-p", "-U0", "--format=%x01%H%x09%s"]);
  } catch {
    return [];
  }
  return out.split("\x01").filter(Boolean).flatMap((block) => {
    const head = block.slice(0, block.indexOf("\n"));
    const [commit = "", subject = ""] = head.split("\t");
    if (!reads_like_a_fix(subject)) return [];
    const files: PastFix["files"] = [];
    let now: PastFix["files"][number] | null = null;
    let inHunk = false;
    for (const l of block.slice(head.length + 1).split(/\r?\n/)) {
      const start = /^diff --git a\/(.+) b\/(.+)$/.exec(l);
      if (start) {
        now = SOURCE.test(start[2] ?? "") ? { file: start[2] ?? "", removed: [], added: [] } : null;
        if (now) files.push(now);
        inHunk = false;
      } else if (l.startsWith("@@")) inHunk = true;
      else if (now && inHunk && l.startsWith("-")) now.removed.push(l.slice(1));
      else if (now && inHunk && l.startsWith("+")) now.added.push(l.slice(1));
    }
    return files.length > 0 ? [{ commit, files }] : [];
  });
};

/**
 * Pure: how many past fixes, other than the one a rule was written from, took out a line the rule fires on and
 * put in none. Each is one more time the same fault was fixed by hand.
 */
export const supportOf = ({ rule, fixes, except }: { rule: Rule; fixes: PastFix[]; except?: string }): number =>
  fixes.filter((f) => {
    if (f.commit === except) return false;
    const mine = f.files.filter((x) => matchesAny(x.file, rule.files));
    const on = (pick: (x: PastFix["files"][number]) => string[]): number => mine.reduce((n, x) => n + ruleLines(rule, pick(x).join("\n")).length, 0);
    return mine.length > 0 && on((x) => x.removed) > 0 && on((x) => x.added) === 0;
  }).length;

/** Pure: a subject line that reads like a correction. Wider than the benchmark's rule on purpose: the proposer is strict, the trial stage is cheap. */
export const reads_like_a_fix = (subject: string): boolean => isFixSubject(subject) || /\b(fix\w*|bug\w*|crash\w*|wrong|broken|must not|cannot|no longer)\b/i.test(subject);

const git = (root: string, args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });

export const fixFiles = (root: string, commit: string): FixFile[] =>
  git(root, ["show", "--name-only", "--format=", commit])
    .split(/\r?\n/)
    .filter((f) => SOURCE.test(f))
    .map((file) => {
      const diff = git(root, ["diff", "-U0", `${commit}^`, commit, "--", file]).split(/\r?\n/);
      const side = (m: string): string[] => diff.filter((l) => l.startsWith(m) && !l.startsWith(m.repeat(3))).map((l) => l.slice(1));
      return { file, removed: side("-"), added: side("+"), after: fileAtCommit(root, commit, file) ?? "" };
    });

/**
 * The rule the changed files of one fix suggest, or null. `count` says how often a rule fires in the tree the
 * caller means: the working tree for the live loop, the tree of an old commit for a backtest.
 */
export const proposeFromFix = ({ fix, count, cap = DEFAULT_CAP, shapes = DEFAULT_SHAPES }: { fix: FixFile[]; count: (rule: Rule) => number; cap?: number; shapes?: readonly Shape[] }): Judged | null => {
  if (fix.length === 0 || fix.length > 8) return null;
  const judged: Judged[] = [];
  for (const f of fix) {
    for (const c of candidates(f, shapes).slice(0, 60)) {
      const rule: Rule = { id: "candidate", ...c };
      const on = (pick: (g: FixFile) => string): number => fix.reduce((n, g) => n + ruleLines(rule, pick(g)).length, 0);
      const onRemoved = on((g) => g.removed.join("\n"));
      const onAdded = on((g) => g.added.join("\n"));
      if (onRemoved === 0 || onAdded > 0) continue;
      judged.push({
        candidate: c,
        onRemoved,
        onAdded,
        leftByFix: fix.reduce((n, g) => n + (matchesAny(g.file, rule.files) ? ruleLines(rule, g.after).length : 0), 0),
        hits: count(rule),
        ...(c.was ? { wasStillUsed: count({ ...rule, kind: "ban-pattern", pattern: `(?<![\\w.])${c.was.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b` }) } : {}),
      });
    }
  }
  return choose({ judged, cap });
};

/** The rule one commit suggests, proven on that commit and counted in the working tree, or null. */
export const proposeFrom = ({ root, commit, cap = DEFAULT_CAP, exclude = [], shapes = DEFAULT_SHAPES }: { root: string; commit: string; cap?: number; exclude?: string[]; shapes?: readonly Shape[] }): Judged | null =>
  proposeFromFix({ fix: fixFiles(root, commit).filter((f) => !matchesAny(f.file, exclude)), count: (r) => Object.values(census(root, r)).reduce((a, b) => a + b, 0), cap, shapes });

/** Pure: the tracked files one file imports, by its own text. */
export const importsOf = ({ file, text, have }: { file: string; text: string; have: Set<string> }): string[] => {
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  const out = new Set<string>();
  const at = (base: string, name: string, exts: string[]): void => {
    for (const e of exts) {
      const p = path.posix.normalize(`${base ? `${base}/` : ""}${name}${e}`);
      if (have.has(p)) out.add(p);
    }
  };
  if (/\.pyi?$/.test(file)) {
    for (const m of text.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w., ]+))/gm)) {
      for (const full of (m[1] ?? m[2] ?? "").split(",").map((x) => x.trim().split(/\s+as\s+/)[0] ?? "").filter(Boolean)) {
        const name = full.split(".")[0] ?? "";
        at(dir, name, [".py"]);
        at(dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "", name, [".py"]);
        // a.b.c from the root of the repository, as a module or as a package
        at("", full.split(".").join("/"), [".py", "/__init__.py"]);
      }
    }
  } else {
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) at(dir, (m[1] ?? "").replace(/\.(ts|tsx|mts|js|mjs|cjs)$/, ""), [".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs", "", "/index.ts", "/index.js", "/index.mjs"]);
  }
  out.delete(file);
  return [...out];
};

/**
 * Pure: the files a test should run for: what it imports, and what those import, three steps deep. `read` gives the
 * text of a tracked file; without it only the test's own imports are followed. A test with no local import still
 * runs when it changes itself.
 */
export const whenFor = ({ test, text, files, read, depth = 3, max = 40 }: { test: string; text: string; files: string[]; read?: (file: string) => string | null; depth?: number; max?: number }): string[] => {
  const have = new Set(files);
  const out = new Set<string>([test]);
  let layer: { file: string; text: string }[] = [{ file: test, text }];
  for (let d = 0; d < depth && layer.length > 0; d += 1) {
    const next: { file: string; text: string }[] = [];
    for (const one of layer) {
      for (const f of importsOf({ file: one.file, text: one.text, have })) {
        if (out.has(f) || out.size >= max) continue;
        out.add(f);
        const body = read ? read(f) : null;
        if (body !== null) next.push({ file: f, text: body });
      }
    }
    layer = next;
  }
  return [...out];
};

export const isTestFile = (f: string): boolean => /(^|\/)test_[^/]+\.py$|\.test\.(ts|tsx|mts|mjs|js)$/.test(f);

const ramPercent = (): number => Math.round(100 * (1 - os.freemem() / os.totalmem()));

type Paths = { dir: string; state: string; ledger: string; log: string; notes: string; assess: string; lock: string; events: string };
const paths = (root: string): Paths => {
  const dir = projectDir(root);
  return { dir, state: path.join(dir, "auto.json"), ledger: path.join(dir, "ledger.json"), log: path.join(dir, "auto-log.jsonl"), notes: path.join(dir, "auto-notes.md"), assess: path.join(dir, "assess.jsonl"), lock: path.join(dir, "auto.lock"), events: path.join(dir, "events.jsonl") };
};

/** One loop at a time per project. A lock older than ten minutes was left by a process that died. */
const withLock = <T>(file: string, work: () => T): T | null => {
  try {
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age < 10 * 60_000) return null;
    fs.rmSync(file);
  } catch {
    // no lock: go on
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, String(process.pid), { flag: "wx" });
  } catch {
    return null;
  }
  try {
    return work();
  } finally {
    fs.rmSync(file, { force: true });
  }
};

/** The facts a verification level is computed from, read from the project's own files and history. */
export const gatherFacts = (root: string): LevelFacts => {
  const state = readState();
  const eff = effective(state, root);
  const rules = readRules(root);
  const config = readConfig(root);
  const files = trackedFiles(root);
  // A rule on trial holds nothing, so it neither proves a project ruled nor makes a folder watched.
  const holding = rules.filter((r) => r.stage !== "trial");
  const rows = featureMap({ files, rules: holding, config });
  const mine = rows.filter((r) => !matchesAny(`${r.folder}/x`, config.notOurs ?? []));
  const isWatched = (r: (typeof rows)[number]): boolean => r.rules.length + r.checks.length + r.tests.length + r.drivers.length > 0;
  const p = paths(root);
  let records: RecordFile[] = [];
  try {
    records = fs.readdirSync(path.join(p.dir, "records")).filter((f) => f.endsWith(".json")).sort().map((f) => readJson<RecordFile>(path.join(p.dir, "records", f), { time: "", sessionId: "", mode: "advise", held: false, findings: [], outcomes: [] }));
  } catch {
    records = [];
  }
  const sinceIso = state.projects[normRoot(root)]?.since ?? (eff.enabled ? state.since : undefined);
  const cut = sinceIso ? Date.parse(sinceIso) / 1000 : null;
  let log: ReturnType<typeof parseLog> = [];
  try {
    log = parseLog(git(root, ["log", "-400", "--no-merges", "--format=%x01%H%x09%ct%x09%s", "--name-only"]));
  } catch {
    log = [];
  }
  const part = (keep: (t: number) => boolean) => {
    const o = outcomes({ commits: log.filter((c) => keep(c.time)) });
    return { commits: o.commits, fixes: o.fixes };
  };
  // The folders, as the feature map cuts them, that a fix commit of the history read has touched.
  const folderOf = (f: string): string => (f.includes("/") ? f.split("/").slice(0, Math.min(2, f.split("/").length - 1)).join("/") : ".");
  const fixed = new Set(log.filter((c) => isFixSubject(c.subject)).flatMap((c) => c.files.filter((f) => SOURCE.test(f)).map(folderOf)));
  const fixFolders = mine.filter((r) => fixed.has(r.folder));
  return {
    on: eff.enabled,
    mode: eff.mode,
    rules: rules.length,
    provenRules: holding.filter((r) => r.proof).length,
    risenRules: rules.filter((r) => Object.entries(census(root, r)).some(([f, n]) => n > (r.baseline?.[f] ?? 0))).length,
    hatches: countHatches(root).total,
    ...(config.hatchCeiling === undefined ? {} : { hatchCeiling: config.hatchCeiling }),
    commands: (config.checks ?? []).length + (config.tests ?? []).length + (config.drivers ?? []).length,
    fixFolders: fixFolders.length,
    watchedFixFolders: fixFolders.filter(isWatched).length,
    folders: mine.length,
    watchedFolders: mine.filter(isWatched).length,
    records: records.filter((r) => isRealSession(r.sessionId)).map((r) => ({ time: r.time, mode: r.mode, failing: r.findings.some((f) => f.blocking), held: r.held })),
    ...((): { baseline?: { done: boolean; failing: number } } => {
      const b = readBaseline(root);
      return b ? { baseline: { done: b.done, failing: b.results.filter((r) => r.status === "fail").length } } : {};
    })(),
    before: part((t) => cut === null || t < cut),
    since: part((t) => cut !== null && t >= cut),
  };
};

const NO_RECORD: RecordFile = { time: "", sessionId: "", mode: "advise", held: false, findings: [], outcomes: [] };
/** The turn records of Claude Code's own sessions, oldest first. */
export const realRecords = (root: string): RecordFile[] => {
  const dir = path.join(paths(root).dir, "records");
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => readJson<RecordFile>(path.join(dir, f), NO_RECORD)).filter((r) => isRealSession(r.sessionId));
  } catch {
    return [];
  }
};
const readAssessments = (file: string): { time: string; level: number; scheme?: number }[] => {
  try {
    return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { time: string; level: number; scheme?: number });
  } catch {
    return [];
  }
};
const commitTimes = (root: string): { time: number; fix: boolean }[] => {
  try {
    return parseLog(git(root, ["log", "-400", "--no-merges", "--format=%x01%H%x09%ct%x09%s", "--name-only"])).map((c) => ({ time: c.time, fix: isFixSubject(c.subject) }));
  } catch {
    return [];
  }
};

export type AutoReport = { changes: Change[]; notes: string[]; level: Level | null; skipped?: string };

/** One pass of the loop for one project. Bounded: at most `maxCommits` commits read and `maxTests` tests timed. */
export const runAuto = ({ root, maxCommits = 20, maxTests = 3, backlog = false, now = () => new Date().toISOString(), memory = ramPercent }: { root: string; maxCommits?: number; maxTests?: number; backlog?: boolean; now?: () => string; /** Percent of memory in use: a test hands in its own, so it does not depend on the machine it runs on. */ memory?: () => number }): AutoReport => {
  const p = paths(root);
  const config = readConfig(root);
  if (!config.auto) return { changes: [], notes: [], level: null, skipped: "autonomy is off for this project (config.auto)" };
  const done = withLock(p.lock, (): AutoReport => {
    const changes: Change[] = [];
    const notes: string[] = [];
    const change = (what: string, undo: string): void => void changes.push({ time: now(), what, undo });
    const state = readJson<AutoState>(p.state, { root });
    state.root = root;
    if (!state.onAt) state.onAt = now();
    // The loop is on by the config: an older mark of an off command no longer says anything.
    delete state.offBy;
    const firstPass = state.pointer === undefined;
    const exclude = config.autoExclude ?? [];
    const rulesFile = projectFile(root, "rules.json");
    const configFile = projectFile(root, "config.json");

    // Rules and config are read again at every change and only the change is applied, so an edit a person makes
    // while a pass is running (rule add, init) is not written over.
    const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
    const editRules = (fn: (rules: Rule[]) => Rule[]): Rule[] => {
      const fresh = readRules(root);
      const next = fn(fresh);
      if (!same(next, fresh)) writeJson(rulesFile, next);
      return next;
    };
    const editConfig = (fn: (c: ProjectConfig) => ProjectConfig): ProjectConfig => {
      const fresh = readConfig(root);
      const next = fn(fresh);
      if (!same(next, fresh)) writeJson(configFile, next);
      return next;
    };
    // Files with uncommitted work are not tightened on: a count that falls there can come back with a checkout.
    let dirty: string[] = [];
    try {
      dirty = git(root, ["status", "--porcelain", "--no-renames"]).split(/\r?\n/).filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, ""));
    } catch {
      dirty = [];
    }

    // 1. Assess: bring the ledger up to date from the edits and the turn records not yet read, in the order they happened.
    let ledger = readJson<Ledger>(p.ledger, { rules: {}, open: {} });
    let recordNames: string[] = [];
    try {
      recordNames = fs.readdirSync(path.join(p.dir, "records")).filter((f) => f.endsWith(".json")).sort();
    } catch {
      recordNames = [];
    }
    const seen: ({ time: string; rec: RecordFile } | { time: string; ev: EditEvent })[] = [];
    for (const name of recordNames.filter((n) => !state.recordPointer || n > state.recordPointer)) {
      const rec = readJson<RecordFile | null>(path.join(p.dir, "records", name), null);
      if (rec && isRealSession(rec.sessionId)) seen.push({ time: rec.time, rec });
      state.recordPointer = name;
    }
    try {
      const text = fs.readFileSync(p.events, "utf8");
      const from = Math.min(state.eventOffset ?? 0, text.length);
      const whole = text.slice(from, text.lastIndexOf("\n") + 1);
      for (const line of whole.split("\n").filter(Boolean)) {
        try {
          const ev = JSON.parse(line) as EditEvent;
          if (isRealSession(ev.sessionId) && Array.isArray(ev.rules)) seen.push({ time: ev.time, ev });
        } catch {
          // a torn line: skip it
        }
      }
      state.eventOffset = from + whole.length;
    } catch {
      // no edit was seen yet
    }
    seen.sort((a, b) => a.time.localeCompare(b.time));
    for (const one of seen) ledger = "rec" in one ? tally(ledger, one.rec) : tallyEdit(ledger, one.ev);
    writeJson(p.ledger, ledger);

    // 2. Improve: act on the ledger, lower what has fallen.
    // The past fixes are read at most once a pass, and only when a rule needs them.
    let past: PastFix[] | null = null;
    const evidenceOf = (rule: Rule, standing: number, except?: string): NonNullable<Rule["evidence"]> => {
      past ??= pastFixes(root);
      return { support: supportOf({ rule, fixes: past, ...(except ? { except } : {}) }), standing, read: past.length };
    };
    // A trial rule written before evidence was kept gets it now, so the same bar applies to all.
    for (const r of readRules(root).filter((x) => x.origin === "auto" && x.stage === "trial" && !x.evidence)) {
      const evidence = evidenceOf(r, Object.values(census(root, r)).reduce((a, b) => a + b, 0), r.proof?.commit);
      editRules((rs) => rs.map((x) => (x.id === r.id && !x.evidence ? { ...x, evidence } : x)));
    }
    const v = verdicts({ rules: readRules(root), ledger });
    const own = (r: Rule, id: string): boolean => r.id === id && r.origin === "auto" && r.stage === "trial";
    for (const id of v.promote) {
      editRules((rs) => rs.map((r) => (own(r, id) ? (({ stage: _stage, ...rest }) => rest)(r) : r)));
      const t = ledger.rules[id] ?? { fired: 0, fixed: 0, letGo: 0 };
      const support = readRules(root).find((r) => r.id === id)?.evidence?.support ?? 0;
      ledger = { ...ledger, promoted: { ...ledger.promoted, [id]: { ...t } } };
      change(`rule ${id} promoted from trial: in live sessions it fired ${t.fired} time(s), was fixed ${t.fixed} time(s) and was left standing ${t.letGo} time(s); ${support} other past fix(es) took out the same fault. It now holds a turn.`, `ratchet rule remove --id ${id}`);
    }
    for (const id of v.demote) {
      const t = ledger.rules[id] ?? { fired: 0, fixed: 0, letGo: 0 };
      const at = ledger.promoted?.[id] ?? { fired: 0, fixed: 0, letGo: 0 };
      editRules((rs) => rs.map((r) => (r.id === id && r.origin === "auto" && r.stage !== "trial" ? { ...r, stage: "trial" as const } : r)));
      // The count starts again: back on trial it must earn its place a second time.
      ledger = { ...ledger, rules: { ...ledger.rules, [id]: { fired: 0, fixed: 0, letGo: 0 } }, promoted: Object.fromEntries(Object.entries(ledger.promoted ?? {}).filter(([k]) => k !== id)) };
      change(`rule ${id} put back on trial: since the loop promoted it, it was left standing ${t.letGo - at.letGo} time(s) and fixed ${t.fixed - at.fixed} time(s). It reports again and holds nothing.`, `set it to hold again: remove "stage" from rule ${id} in ${rulesFile}`);
    }
    if (v.promote.length + v.demote.length > 0) writeJson(p.ledger, ledger);
    for (const id of v.retire) {
      const gone = readRules(root).find((r) => own(r, id));
      editRules((rs) => rs.filter((r) => !own(r, id)));
      change(`rule ${id} retired: ${ledger.rules[id]?.letGo ?? 0} findings of it were left standing and none was ever fixed. It was the loop's own trial rule.`, `add it back: ${JSON.stringify(gone)}`);
    }
    for (const r of readRules(root)) {
      if (!r.baseline) continue;
      const nowCount = census(root, r);
      const fall = (base: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(base).map(([f, n]) => [f, dirty.includes(f) ? n : Math.min(n, nowCount[f] ?? 0)] as const).filter(([, n]) => n > 0));
      const sum = (b: Record<string, number>): number => Object.values(b).reduce((a, c) => a + c, 0);
      const was = sum(r.baseline);
      const is = sum(fall(r.baseline));
      if (is >= was) continue;
      editRules((rs) => rs.map((x) => (x.id === r.id && x.baseline ? { ...x, baseline: fall(x.baseline) } : x)));
      change(`backlog of rule ${r.id} lowered from ${was} to ${is}: siblings were fixed.`, "none needed: a backlog only falls");
    }
    const ceiling = readConfig(root).hatchCeiling;
    const hatches = countHatches(root).total;
    if (ceiling !== undefined && hatches < ceiling && !dirty.some((f) => SOURCE.test(f))) {
      editConfig((c) => (c.hatchCeiling !== undefined && hatches < c.hatchCeiling ? { ...c, hatchCeiling: hatches } : c));
      change(`escape hatch ceiling lowered from ${ceiling} to ${hatches}.`, "none needed: the ceiling only falls");
    }

    // 3. Learn rules: read the commits since the pointer; a correction whose change has a shape becomes a trial rule.
    let head = "";
    try {
      head = git(root, ["rev-parse", "HEAD"]).trim();
    } catch {
      head = "";
    }
    if (head && state.pointer && state.pointer !== head) {
      let commits: string[] = [];
      try {
        commits = git(root, ["log", "--no-merges", "--format=%H\t%s", `${state.pointer}..${head}`]).split(/\r?\n/).filter(Boolean).slice(0, maxCommits);
      } catch {
        commits = [];
      }
      for (const line of commits.reverse()) {
        const [hash = "", subject = ""] = line.split("\t");
        if (!reads_like_a_fix(subject)) continue;
        const pick = proposeFrom({ root, commit: hash, exclude });
        if (!pick) {
          notes.push(`fix ${hash.slice(0, 8)} read: its change has no shape a pattern can state, so no rule was written.`);
          continue;
        }
        const { shape: _shape, was: _was, ...body } = pick.candidate;
        const id = `auto-${hash.slice(0, 7)}`;
        const rule: Rule = { id, ...body, origin: "auto", stage: "trial", proof: { commit: hash, file: fixFiles(root, hash)[0]?.file ?? "", firedBefore: pick.onRemoved, firedAfter: pick.onAdded } };
        const found = census(root, rule);
        if (Object.keys(found).length > 0) rule.baseline = found;
        rule.evidence = evidenceOf(rule, pick.hits, hash);
        const known = (rs: Rule[]): boolean => rs.some((r) => r.id === id || r.pattern === rule.pattern);
        if (known(readRules(root))) continue;
        editRules((rs) => (known(rs) ? rs : [...rs, rule]));
        change(`rule ${id} written from fix ${hash.slice(0, 8)} (${subject.slice(0, 80)}), on trial: it reports and does not hold a turn. Pattern ${JSON.stringify(rule.pattern)} in ${rule.files.join(", ")}; proven on the fix (${pick.onRemoved} removed line(s), no added line); ${pick.hits} more in the tree, kept as backlog; ${rule.evidence.support} other past fix(es) of ${rule.evidence.read} read took out the same fault.`, `ratchet rule remove --id ${id}`);
      }
    }
    if (head) state.pointer = head;

    // 3b. Learn from a correction given in chat: what the session changed between the correction and the end of
    // that turn is read as a fix. It waits for the turn to end; one nobody ended is dropped after a day.
    for (const meta of pendingCorrections(root)) {
      const ended = recordNames.slice(-40).some((name) => {
        const rec = readJson<RecordFile | null>(path.join(p.dir, "records", name), null);
        return rec !== null && rec.sessionId === meta.sessionId && rec.time > meta.time && !rec.held;
      });
      if (!ended || !isRealSession(meta.sessionId)) {
        if (!isRealSession(meta.sessionId) || Date.parse(now()) - Date.parse(meta.time) > 86_400_000) {
          dropCorrection(root, meta.id);
          logCorrection({ root, time: meta.time, outcome: "dropped, its turn never ended" });
        }
        continue;
      }
      let fix: FixFile[] = [];
      try {
        fix = fixFromCorrection({ root, meta }).filter((f) => !matchesAny(f.file, exclude));
      } catch {
        fix = [];
      }
      dropCorrection(root, meta.id);
      let job = "";
      // Where written tests are on, the change is also kept for one: a change with no shape a pattern can state can still be tested.
      // Only the two texts of each file are kept. The words of the chat are not.
      if (config.autoGuards && fix.length > 0 && fix.length <= 3) {
        try {
          writeJson(path.join(p.dir, "guard-jobs", `${meta.id}.json`), { id: meta.id, time: meta.time, head: git(root, ["rev-parse", "HEAD"]).trim(), files: fix.map((f) => ({ file: f.file, before: f.before ?? "", after: f.after })) });
          job = ", kept for a written test";
        } catch {
          // No job, then: the rule path below still runs.
        }
      }
      const when = meta.time.slice(0, 16).replace("T", " ");
      if (fix.length === 0) {
        notes.push(`a correction given in chat at ${when} was followed by no change in a source file, so there was nothing to learn a rule from.`);
        logCorrection({ root, time: meta.time, outcome: "no change in a source file" });
        continue;
      }
      const pick = proposeFromFix({ fix, count: (r) => Object.values(census(root, r)).reduce((a, b) => a + b, 0) });
      if (!pick) {
        notes.push(`a correction given in chat at ${when} was followed by a change in ${fix.length} source file(s): the change has no shape a pattern can state, so no rule was written.`);
        logCorrection({ root, time: meta.time, outcome: `no shape a pattern can state${job}` });
        continue;
      }
      const { shape: _shape, was: _was, ...body } = pick.candidate;
      const id = `auto-chat-${meta.id.slice(-6)}`;
      const rule: Rule = { id, ...body, origin: "auto", stage: "trial", from: "correction", proof: { commit: `chat ${meta.time}`, file: fix[0]?.file ?? "", firedBefore: pick.onRemoved, firedAfter: pick.onAdded } };
      const found = census(root, rule);
      if (Object.keys(found).length > 0) rule.baseline = found;
      rule.evidence = evidenceOf(rule, pick.hits);
      const known = (rs: Rule[]): boolean => rs.some((r) => r.id === id || r.pattern === rule.pattern);
      if (known(readRules(root))) {
        logCorrection({ root, time: meta.time, outcome: `rule already known${job}` });
        continue;
      }
      editRules((rs) => (known(rs) ? rs : [...rs, rule]));
      logCorrection({ root, time: meta.time, outcome: `rule written${job}` });
      change(`rule ${id} written from what the session changed after a correction given in chat at ${when}, on trial: it reports and does not hold a turn. Pattern ${JSON.stringify(rule.pattern)} in ${rule.files.join(", ")}; it fires on ${pick.onRemoved} line(s) the session took out and on none it put in; ${pick.hits} more in the tree, kept as backlog.`, `ratchet rule remove --id ${id}`);
    }

    // 4. Learn tests: a test file nobody mapped is timed once and mapped if it passes quickly.
    const files = trackedFiles(root);
    const template = (test: string): string | undefined => (/\.pyi?$/.test(test) ? config.autoTest?.py : config.autoTest?.ts);
    const skipped = state.skippedTests ?? {};
    const stampOf = (test: string): string | null => {
      try {
        return String(fs.statSync(path.join(root, test)).mtimeMs);
      } catch {
        return null;
      }
    };
    const mappedNow = (readConfig(root).tests ?? []).map((t) => t.command);
    const fresh = files.filter((f) => isTestFile(f) && !matchesAny(f, exclude) && !mappedNow.some((c) => c.includes(f)));
    let timed = 0;
    for (const test of fresh) {
      const form = template(test);
      const stamp = stampOf(test);
      if (!form || stamp === null) continue;
      // The loop learns from what is new. The tests that were there when it was switched on are not swept, unless
      // a person asks for the backlog: they are tried when their file changes.
      if (firstPass && !backlog) {
        skipped[test] = `${stamp} was here before the loop was switched on`;
        continue;
      }
      if (skipped[test]?.startsWith(stamp) && !(backlog && skipped[test]?.includes("was here before"))) continue;
      if (timed >= maxTests) break;
      if (memory() >= 90) {
        notes.push(`memory is at ${memory()}%: no test was timed this pass.`);
        break;
      }
      timed += 1;
      const command = form.split("{test}").join(test);
      const started = Date.now();
      let ok = true;
      try {
        // Without a shell where the command is plain words, so the time limit ends the test itself and not only a shell around it.
        const words = /[&|<>"'%$]/.test(command) ? null : command.split(/\s+/).filter(Boolean);
        const opts = { cwd: root, stdio: "ignore" as const, timeout: 60_000, windowsHide: true, env: { ...process.env, RATCHET_CHILD: "1" } };
        if (words && words[0]) execFileSync(words[0], words.slice(1), opts);
        else execFileSync(forShell(command), { ...opts, shell: true });
      } catch {
        ok = false;
      }
      const seconds = (Date.now() - started) / 1000;
      if (!ok || seconds > 30) {
        skipped[test] = `${stamp} ${ok ? `took ${Math.round(seconds)} s, over the 30 s limit` : "failed or timed out when run alone"}`;
        notes.push(`test ${test} not mapped: it ${ok ? `took ${Math.round(seconds)} s` : "failed or timed out when run alone"}. It is tried again when the file changes.`);
        continue;
      }
      let text = "";
      try {
        text = fs.readFileSync(path.join(root, test), "utf8");
      } catch {
        text = "";
      }
      // A name a person's entry already has is never taken over: the folder is added to it, and failing that the test is left.
      const short = test.replace(/^.*\//, "").replace(/\.(py|ts|tsx|mts|mjs|js)$/, "");
      const taken = (c: ProjectConfig, n: string): boolean => (c.tests ?? []).some((t) => t.name === n && t.origin !== "auto");
      const before = readConfig(root);
      const name = taken(before, short) ? `${short}@${test.includes("/") ? test.slice(0, test.lastIndexOf("/")) : "."}` : short;
      if (taken(before, name)) {
        skipped[test] = `${stamp} a person's test entry already has its name`;
        continue;
      }
      const readTracked = (f: string): string | null => {
        try {
          return fs.readFileSync(path.join(root, f), "utf8");
        } catch {
          return null;
        }
      };
      const entry: CheckCmd = { name, when: whenFor({ test, text, files, read: readTracked }), command, timeoutS: Math.max(10, Math.ceil(seconds * 3)), origin: "auto" };
      editConfig((c) => (taken(c, name) ? c : { ...c, tests: [...(c.tests ?? []).filter((t) => t.name !== name), entry] }));
      change(`test ${name} mapped: it passed alone in ${seconds.toFixed(1)} s and runs when one of ${entry.when?.join(", ")} changes.`, `remove the entry named ${name} from tests in ${configFile}`);
    }

    // 4a. Widen: a test the loop mapped earlier now reaches more files through its imports than its entry names.
    // Only the loop's own entries, and only by adding files, so the test runs more often and never less.
    const widened: string[] = [];
    const widenedUndo: string[] = [];
    for (const t of readConfig(root).tests ?? []) {
      const test = t.when?.[0];
      if (t.origin !== "auto" || !test || t.name.startsWith("guard-") || !files.includes(test) || !isTestFile(test)) continue;
      let text = "";
      try {
        text = fs.readFileSync(path.join(root, test), "utf8");
      } catch {
        continue;
      }
      const read = (f: string): string | null => {
        try {
          return fs.readFileSync(path.join(root, f), "utf8");
        } catch {
          return null;
        }
      };
      const more = whenFor({ test, text, files, read }).filter((f) => !t.when?.includes(f));
      if (more.length === 0) continue;
      editConfig((c) => ({ ...c, tests: (c.tests ?? []).map((x) => (x.name === t.name && x.origin === "auto" ? { ...x, when: [...(x.when ?? []), ...more.filter((f) => !x.when?.includes(f))] } : x)) }));
      widened.push(`${t.name} +${more.length}`);
      widenedUndo.push(`${t.name}: ${more.join(", ")}`);
    }
    if (widened.length > 0) change(`${widened.length} test(s) the loop mapped now also run when a file they import changes: ${widened.slice(0, 12).join(", ")}${widened.length > 12 ? ", ..." : ""}.`, `in ${configFile} remove from the "when" list of each entry the files added: ${widenedUndo.join("; ")}`);

    // A test the loop mapped that keeps failing for reasons outside the session, or cannot run, is taken out again
    // (its own items only). A test that was merely not reached, by the cap or the time budget, is not counted. It is
    // tried again only when its file changes, so it cannot swing in and out.
    const elsewhere: Record<string, number> = {};
    for (const name of recordNames.slice(-30)) {
      const rec = readJson<RecordFile | null>(path.join(p.dir, "records", name), null);
      for (const o of rec?.outcomes ?? []) {
        const broken = o.status === "fail-elsewhere" || (o.status === "not-run" && /^(did not finish|could not run)/.test(o.note ?? ""));
        if (o.kind === "test" && broken) elsewhere[o.name] = (elsewhere[o.name] ?? 0) + 1;
      }
    }
    for (const t of (readConfig(root).tests ?? []).filter((x) => x.origin === "auto" && (elsewhere[x.name] ?? 0) >= 3)) {
      editConfig((c) => ({ ...c, tests: (c.tests ?? []).filter((x) => !(x.name === t.name && x.origin === "auto")) }));
      const file = files.find((f) => t.command.includes(f));
      if (file) skipped[file] = `${stampOf(file) ?? ""} was mapped and taken out again`;
      change(`test ${t.name} unmapped: in ${elsewhere[t.name]} recent turns it failed for reasons outside the session or could not run. It was mapped by the loop.`, `add it back to tests in ${configFile}: ${JSON.stringify(t)}`);
    }
    state.skippedTests = skipped;

    // 4b. Find a check: a type-check or lint the project could run and does not. One is tried a pass. It is mapped
    // only when it ran clean and left the working tree as it was; one that did not is tried again when the file
    // that suggested it changes.
    const triedChecks = state.triedChecks ?? {};
    for (const cand of checkCandidates({ files, scripts: readScripts(root), packages: readPackages(root, files, exclude), pyprojects: readPyprojects(root, files, exclude), hasTypescript: hasTypescriptAt(root), config: readConfig(root), exclude })) {
      const stamp = stampOf(cand.from) ?? "";
      if (triedChecks[cand.name] === stamp) continue;
      if (memory() >= 90) break;
      const trial = tryCheck({ root, check: cand });
      if (trial.ok) {
        const { from: _from, ...entry } = cand;
        editConfig((c) => ((c.checks ?? []).some((x) => x.name === entry.name) ? c : { ...c, checks: [...(c.checks ?? []), { ...entry, timeoutS: Math.max(30, Math.ceil(trial.seconds * 3)) }] }));
        change(`check ${entry.name} found and mapped: "${entry.command}" ran clean in ${trial.seconds.toFixed(1)} s and left the working tree as it was. It runs when one of ${entry.when?.join(", ")} changes.`, `remove the entry named ${entry.name} from checks in ${configFile}`);
      } else {
        triedChecks[cand.name] = stamp;
        notes.push(`check "${cand.command}" was tried and not mapped: ${trial.why}. It is tried again when ${cand.from} changes.`);
      }
      break;
    }
    state.triedChecks = triedChecks;
    const rules = readRules(root);
    const cfg = readConfig(root);

    // 5. Coverage: name the folders that lost their watch or arrived with none.
    const rows = featureMap({ files, rules, config: cfg });
    const watched = rows.filter((r) => r.rules.length + r.checks.length + r.tests.length + r.drivers.length > 0).map((r) => r.folder);
    const bareNow = rows.filter((r) => !watched.includes(r.folder) && !matchesAny(`${r.folder}/x`, cfg.notOurs ?? [])).map((r) => r.folder);
    const known = new Set([...(state.watched ?? []), ...(state as { bare?: string[] }).bare ?? []]);
    for (const folder of bareNow.filter((f) => !known.has(f))) notes.push(`folder ${folder} has source files and nothing watches it beyond syntax and escape hatches.`);
    for (const folder of (state.watched ?? []).filter((f) => bareNow.includes(f))) notes.push(`folder ${folder} was watched and is not any more.`);
    state.watched = watched;
    (state as { bare?: string[] }).bare = bareNow;
    writeJson(p.state, state);

    // 6. Assess: the level, appended to the history so a fall is visible.
    // 5b. The tests the harness wrote itself are on trial, like its rules: they report and do not hold a turn.
    // One that a session acted on (it failed, then passed) may hold from then on. One left failing in two
    // sessions and never acted on is taken out again. A person's test is never touched.
    {
      const written = (readConfig(root).tests ?? []).filter(isWritten);
      const promotedBefore = readJson<AutoState>(p.state, { root }).guardsPromoted ?? [];
      const verdict = guardVerdicts({ records: realRecords(root), names: written.map((t) => t.name) });
      const toTrial = written.filter((t) => t.stage !== "trial" && !promotedBefore.includes(t.name) && !verdict.promote.includes(t.name)).map((t) => t.name);
      if (toTrial.length > 0) {
        editConfig((c) => ({ ...c, tests: (c.tests ?? []).map((t) => (isWritten(t) && toTrial.includes(t.name) ? { ...t, stage: "trial" as const } : t)) }));
        change(`${toTrial.length} test(s) the harness wrote are on trial from now on: a failure is reported and does not hold a turn (${toTrial.join(", ")}).`, `remove "stage" from those entries in ${configFile}`);
      }
      for (const name of verdict.promote.filter((n) => !promotedBefore.includes(n))) {
        editConfig((c) => ({ ...c, tests: (c.tests ?? []).map((t) => (isWritten(t) && t.name === name ? (({ stage: _stage, ...rest }) => rest)(t) : t)) }));
        writeJson(p.state, { ...readJson<AutoState>(p.state, { root }), guardsPromoted: [...new Set([...(readJson<AutoState>(p.state, { root }).guardsPromoted ?? []), name])] });
        change(`written test ${name} promoted from trial: it failed at a turn end and passed later in the same session, so a session acted on it. It can hold a turn now.`, `add "stage": "trial" to the entry named ${name} in ${configFile}`);
      }
      for (const name of verdict.retire) {
        const entry = written.find((t) => t.name === name);
        if (!entry) continue;
        editConfig((c) => ({ ...c, tests: (c.tests ?? []).filter((t) => !(isWritten(t) && t.name === name)) }));
        change(`written test ${name} taken out: it was still failing when a session's last turn was let go, in two sessions or more, and was never acted on.`, `add this entry back to tests in ${configFile}: ${JSON.stringify(entry)}`);
      }
    }
    // 5c. The turn-end limits. The ceiling is worked out again at every pass from the recorded times. A value of
    // the loop above the ceiling comes down to it at once. Where the project has the moves on, the limits move
    // one step a pass. A person's value is the floor and is never written by the loop.
    let limitsText = "";
    {
      const cfg = readConfig(root);
      const stats = turnStats(realRecords(root));
      const limits = effectiveLimits(cfg);
      const tests = cfg.tests ?? [];
      const top = limitCeiling({ stats, limits, mapped: tests.filter((t) => !isWritten(t)).length, written: tests.filter(isWritten).length });
      const undo = `set "autoLimits" in ${configFile} back to ${JSON.stringify(cfg.autoLimits ?? {})}`;
      const setLimits = (next: { tests: number; budgetS: number }): void => {
        editConfig((c) => {
          const own = { ...(next.tests > limits.floorTests ? { tests: next.tests } : {}), ...(next.budgetS > limits.floorBudgetS ? { budgetS: next.budgetS } : {}) };
          const { autoLimits: _old, ...rest } = c;
          return Object.keys(own).length > 0 ? { ...rest, autoLimits: own } : rest;
        });
      };
      const lastStat = stats[stats.length - 1]?.time ?? now();
      if (limits.tests > top.tests || limits.budgetS > top.budgetS) {
        const next = { tests: Math.min(limits.tests, top.tests), budgetS: Math.min(limits.budgetS, top.budgetS) };
        setLimits(next);
        writeJson(p.state, { ...readJson<AutoState>(p.state, { root }), limitMove: { time: lastStat, dir: "down" } });
        change(`the turn-end limits come down to their ceiling, which fell: ${limits.tests} test(s) and ${limits.budgetS} s become ${next.tests} and ${next.budgetS} s (${top.why}).`, undo);
      } else if (cfg.autoLimitsOn) {
        const move = decide({ stats, limits, top, last: readJson<AutoState>(p.state, { root }).limitMove ?? null, noRaise: cfg.noFullRuns === true });
        if (move) {
          setLimits(move);
          writeJson(p.state, { ...readJson<AutoState>(p.state, { root }), limitMove: { time: lastStat, dir: move.tests < limits.tests || move.budgetS < limits.budgetS ? "down" : "up" } });
          change(`${move.what}.`, undo);
        }
      }
      const after = effectiveLimits(readConfig(root));
      limitsText = renderLimits({ limits: after, top, stats, waits: readJson<Record<string, number>>(path.join(p.dir, "waits.json"), {}), ends: unrunAtEnd(realRecords(root)), on: cfg.autoLimitsOn === true });
    }
    // 6. A project no session has edited yet has no checked turn. Its mapped commands are run on the tree as it is,
    // a few a pass, as a baseline with its own record. Never where full runs are forbidden.
    if (realRecords(root).length === 0 && !config.noFullRuns && !readBaseline(root)?.done) {
      const step = baselineStep({ root, max: 5, minutes: 3, now, memory });
      if (step.note) notes.push(step.note);
      if (step.baseline && step.ran > 0) notes.push(step.baseline.done ? renderBaseline(step.baseline) : `baseline run: ${step.baseline.results.length} mapped command(s) run so far; it goes on at the next pass.`);
    }
    const level = levelOf(gatherFacts(root));
    // 7. The measure is checked against what followed it. A contradiction is told once.
    const check = selfCheck({ assessments: readAssessments(p.assess), commits: commitTimes(root), scheme: SCHEME });
    if (check.contradictions.length > (state.contradictionsTold ?? 0)) {
      notes.push(`the level is contradicted by what followed: ${check.contradictions.slice(state.contradictionsTold ?? 0).join("; ")}.`);
      writeJson(p.state, { ...readJson<AutoState>(p.state, { root }), contradictionsTold: check.contradictions.length });
    }
    const history = (() => {
      try {
        return fs.readFileSync(p.assess, "utf8").trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    })();
    const read = history.length ? (JSON.parse(history[history.length - 1] ?? "{}") as { level?: number; scheme?: number }) : {};
    // A level computed under another scheme is another measure: it is said once, and not compared.
    const last = (read.scheme ?? 1) === SCHEME ? read : {};
    if (read.level !== undefined && (read.scheme ?? 1) !== SCHEME) notes.push(`the level is computed by scheme ${SCHEME} from now on (it was scheme ${read.scheme ?? 1}, level ${read.level}); under the new scheme it is ${level.level} (${level.name}). The measure changed, so the two numbers cannot be compared; whether the project also changed is not read from them.`);
    if (last.level !== undefined && level.level < last.level) notes.push(`the verification level FELL from ${last.level} to ${level.level}: ${level.next.join("; ")}.`);
    if (last.level !== undefined && level.level > last.level) notes.push(`the verification level rose from ${last.level} to ${level.level} (${level.name}).`);
    fs.appendFileSync(p.assess, `${JSON.stringify({ time: now(), scheme: SCHEME, level: level.level, name: level.name, met: level.requirements.filter((r) => r.met).length, of: level.requirements.length, rules: rules.length, trial: rules.filter((r) => r.stage === "trial").length, tests: (cfg.tests ?? []).length, watched: watched.length, folders: rows.length })}\n`);

    for (const c of changes) fs.appendFileSync(p.log, `${JSON.stringify(c)}\n`);
    if (changes.length + notes.length > 0) {
      const text = [`## ${now()}`, ...changes.map((c) => `- CHANGED: ${c.what} Undo: ${c.undo}`), ...notes.map((n) => `- noted: ${n}`), ""].join("\n");
      fs.appendFileSync(p.notes, `${text}\n`);
    }
    writeText(path.join(p.dir, "level.md"), `${renderLevel({ root: normRoot(root), level })}\n`);
    writeText(path.join(p.dir, "evidence.md"), `${[renderEvidence({ rules, ledger }), renderPrevention(prevention(realRecords(root))), check.text, limitsText, ...((b) => (b ? [renderBaseline(b)] : []))(readBaseline(root))].join("\n\n")}\n`);
    // The lesson card's log, only where it is switched on: one line of its numbers and the page.
    try {
      logLessons({ root, time: now() });
    } catch {
      // The card is a reading. A fault in it never fails the pass.
    }
    return { changes, notes, level };
  });
  return done ?? { changes: [], notes: [], level: null, skipped: "another pass of the loop holds the lock" };
};

/** The lines of the loop's notes that no session has been told yet, and a mark that they now have been. */
export const unseenNotes = (root: string): string => {
  const p = paths(root);
  try {
    const text = fs.readFileSync(p.notes, "utf8");
    const seen = Number(readJson<{ seen?: number }>(path.join(p.dir, "auto-seen.json"), {}).seen ?? 0);
    writeJson(path.join(p.dir, "auto-seen.json"), { seen: text.length });
    return text.slice(seen).trim();
  } catch {
    return "";
  }
};

/** Every project the harness knows, with the last assessment of each. */
export const allAssessments = (): { root: string; last: Record<string, unknown>; history: Record<string, unknown>[]; level: string; changes: string; evidence: string }[] => {
  const base = path.join(home(), "projects");
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(base);
  } catch {
    return [];
  }
  return dirs.flatMap((d) => {
    const st = readJson<AutoState | null>(path.join(base, d, "auto.json"), null);
    if (!st?.root) return [];
    let history: Record<string, unknown>[] = [];
    let level = "";
    let changes = "";
    let evidence = "";
    try {
      history = fs.readFileSync(path.join(base, d, "assess.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      level = fs.readFileSync(path.join(base, d, "level.md"), "utf8");
    } catch {
      history = [];
    }
    try {
      changes = fs.readFileSync(path.join(base, d, "auto-notes.md"), "utf8").slice(-6000);
    } catch {
      changes = "";
    }
    try {
      evidence = fs.readFileSync(path.join(base, d, "evidence.md"), "utf8");
    } catch {
      evidence = "";
    }
    const warning = offUnseen(st.root);
    return [{ root: st.root, last: history[history.length - 1] ?? {}, history, level, changes, evidence, ...(warning ? { warning } : {}) }];
  });
};
