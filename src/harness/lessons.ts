import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { realRecords, type RecordFile } from "./auto.ts";
import { census, countHatches } from "./cli.ts";
import { pendingCorrections } from "./corrections.ts";
import { findingKey, prevention } from "./insight.ts";
import { atLeast } from "./level.ts";
import { unrunAtEnd } from "./limits.ts";
import { outcomes, parseLog, type Outcomes } from "./outcomes.ts";
import { HATCHES, type Rule } from "./rules.ts";
import { trackedFiles } from "./session.ts";
import { effective, normRoot, projectDir, readConfig, readState, type ProjectConfig } from "./state.ts";
import { isWritten, readRules } from "./turn.ts";

/**
 * The lesson card (criteria C1 to C10 of AUDIT.md). The nineteen lessons of
 * the talk named in the Ratchet README, each with two cells kept apart: what is in use in this project, and
 * what effect is measured. It reads what the harness already keeps and counts with the functions that already count.
 * It never says a lesson is met, and a mechanism in use with no effect on record says exactly that.
 */

/** The hatches that are comments (C4): the talk's point is the comment as an excuse, not every way of switching a check off. */
export const COMMENT_FORMS = HATCHES.flatMap((h) => h.patterns.map((p) => p.name)).filter((n) => /^@|:|disable|noqa/.test(n)); // by the shape of the name: the casts and the skipped tests of that table are not comments, and spelling a name here would read as a hatch of this file
/** The outcome shares of two stretches are compared only when each holds this many commits (the convention of the level's self check). */
export const MIN_COMMITS = 20;

export type Effect = "shown" | "not in use" | "none yet" | "too little history" | "measured" | "shared" | "not measured";
export type LessonRow = { n: number; lesson: string; at: string; audit: string; inUse: boolean | null; use: string; effect: Effect; effectText: string };
export type Snapshot = { time: string; rules: number; proven: number; trial: number; written: number; backlogStored: number; backlogNow: number; commentForms: number; hatches: number; tests: number; drivers: number; records: number; strong: number; advised: number; holding: number; unrun: number; commitsSince: number; fixesSince: number };
export type LessonFacts = {
  rules: Rule[];
  config: ProjectConfig;
  records: RecordFile[];
  /** The folders at the top of the repository: a banned import that names one of them is a boundary inside the repository (C3). */
  topFolders: string[];
  /** Per rule id, how often it fires in the tree now. */
  census: Record<string, number>;
  hatches: { total: number; byName: Record<string, number> };
  sinceDate: string | null;
  before: Outcomes | null;
  since: Outcomes | null;
  snapshots: Snapshot[];
  corrections: { time: string; outcome: string }[];
  correctionsWaiting: number;
  shown: { time: string; agent: boolean }[];
  logOn: boolean;
};

type Acted = { strong: number; advised: number; holding: number };
const ZERO: Acted = { strong: 0, advised: 0, holding: 0 };
const plus = (a: Acted, b: Partial<Acted>): Acted => ({ strong: a.strong + (b.strong ?? 0), advised: a.advised + (b.advised ?? 0), holding: a.holding + (b.holding ?? 0) });

/** Pure: which lesson a rule counts for, and no other (C3). */
export const ruleLesson = (rule: Rule, topFolders: string[]): 2 | 4 | 5 => {
  if (rule.kind === "ban-api") return 4;
  if (rule.kind !== "ban-import") return 2;
  const name = rule.pattern.replace(/^\^/, "").replace(/\\/g, "");
  const first = name.split("/")[0] ?? "";
  return name.startsWith(".") || name.startsWith("/") || topFolders.includes(first) ? 5 : 4;
};

/**
 * Pure: the findings that stood at one turn end and were gone at a later one of the same session, kept by finding
 * kind and rule, split by whether the finding could hold the turn. The same walk as `prevention`, which has the totals.
 */
export const actedOn = (records: RecordFile[]): { key: string; advised: number; holding: number }[] => {
  const bySession = new Map<string, RecordFile[]>();
  for (const r of [...records].sort((a, b) => a.time.localeCompare(b.time))) bySession.set(r.sessionId, [...(bySession.get(r.sessionId) ?? []), r]);
  const out = new Map<string, { advised: number; holding: number }>();
  for (const turns of bySession.values()) {
    let open = new Map<string, { blocking: boolean; group: string }>();
    for (const turn of turns) {
      const now = new Map(turn.findings.map((f) => [findingKey(f), { blocking: f.blocking, group: f.kind === "rule" ? `rule ${/^rule ([^,]+),/.exec(f.title)?.[1] ?? "?"}` : f.kind === "hatch" ? `hatch ${f.title}` : f.kind }]));
      for (const [key, was] of open) {
        if (now.has(key)) continue;
        const t = out.get(was.group) ?? { advised: 0, holding: 0 };
        out.set(was.group, was.blocking ? { ...t, holding: t.holding + 1 } : { ...t, advised: t.advised + 1 });
      }
      open = now;
    }
  }
  return [...out].map(([key, v]) => ({ key, ...v }));
};

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const list = (xs: string[], max = 6): string => (xs.length === 0 ? "none" : xs.length > max ? `${xs.slice(0, max).join(", ")} and ${xs.length - max} more` : xs.join(", "));
const day = (t: string): string => t.slice(0, 10);

/** Pure: an effect cell from the three counts. Only the first two are effect; the third is compliance (C2). */
const effectOf = (a: Acted, nothing: string): { effect: Effect; effectText: string } => ({
  effect: a.strong + a.advised > 0 ? "shown" : "none yet",
  effectText: `${a.strong + a.advised > 0 ? `failed then passed in one session: ${a.strong}; gone while it could not hold the turn: ${a.advised}` : nothing}${a.holding > 0 ? `. Gone while it could hold the turn: ${a.holding} (compliance, not counted as effect)` : ""}`,
});

/** Pure: the card's numbers as one line of the log. */
export const snapshotOf = (f: LessonFacts, time: string): Snapshot => {
  const p = prevention(f.records);
  const tests = f.config.tests ?? [];
  return {
    time,
    rules: f.rules.length,
    proven: f.rules.filter((r) => r.proof).length,
    trial: f.rules.filter((r) => r.stage === "trial").length,
    written: tests.filter(isWritten).length,
    backlogStored: sum(f.rules.map((r) => sum(Object.values(r.baseline ?? {})))),
    backlogNow: sum(f.rules.map((r) => f.census[r.id] ?? 0)),
    commentForms: sum(COMMENT_FORMS.map((n) => f.hatches.byName[n] ?? 0)),
    hatches: f.hatches.total,
    tests: tests.length,
    drivers: (f.config.drivers ?? []).length,
    records: f.records.length,
    strong: sum(p.turned.map((t) => t.times)),
    advised: p.advisedActedOn,
    holding: p.holdingActedOn,
    unrun: sum(unrunAtEnd(f.records).map((e) => e.unrun.length)),
    commitsSince: f.since?.commits ?? 0,
    fixesSince: f.since?.fixes ?? 0,
  };
};

/** Pure: the nineteen rows. */
export const lessonCard = (f: LessonFacts): LessonRow[] => {
  const tests = f.config.tests ?? [];
  const written = tests.filter(isWritten);
  const mapped = tests.filter((t) => !isWritten(t));
  const checks = f.config.checks ?? [];
  const drivers = f.config.drivers ?? [];
  const p = prevention(f.records);
  const acted = actedOn(f.records);

  // C3: every rule, test and driver counts for one lesson. What is no longer in the config counts where its kind puts it.
  const lessonOfRule = new Map(f.rules.map((r) => [r.id, ruleLesson(r, f.topFolders)]));
  const by: Record<number, Acted> = { 2: ZERO, 4: ZERO, 5: ZERO, 6: ZERO, 10: ZERO, 12: ZERO };
  const add = (n: number, b: Partial<Acted>): void => {
    by[n] = plus(by[n] ?? ZERO, b);
  };
  const writtenNames = new Set(written.map((t) => t.name));
  const driverNames = new Set(drivers.map((d) => d.name));
  for (const t of p.turned) add(writtenNames.has(t.name) || t.name.startsWith("guard-") ? 2 : driverNames.has(t.name) ? 12 : 10, { strong: t.times });
  for (const a of acted) {
    const rule = /^rule (.+)$/.exec(a.key)?.[1];
    if (rule !== undefined) add(lessonOfRule.get(rule) ?? 2, a);
    else if (a.key.startsWith("hatch ")) {
      // A hatch finding names what was added. One that names a comment form is lesson 6; another hatch is no lesson of the talk.
      if (COMMENT_FORMS.some((n) => a.key.includes(n))) add(6, a);
    }
    // The finding of a check, test or driver is not counted: it is gone as soon as the command is not run again, and
    // when the command did pass later, that is the failed-then-passed count above. Counting both would count one event twice.
  }

  const rulesOf = (n: number): Rule[] => f.rules.filter((r) => lessonOfRule.get(r.id) === n);
  const proven = f.rules.filter((r) => r.proof);
  const runs = (kind: string, status: string): number => sum(f.records.map((r) => r.outcomes.filter((o) => o.kind === kind && o.status === status).length));
  const ends = unrunAtEnd(f.records);
  const unrun = sum(ends.map((e) => e.unrun.length));
  const commentForms = sum(COMMENT_FORMS.map((n) => f.hatches.byName[n] ?? 0));
  const first = f.snapshots[0];
  const trend = (now: number, was: (s: Snapshot) => number, what: string): { effect: Effect; effectText: string } =>
    first === undefined || Date.parse(f.snapshots[f.snapshots.length - 1]?.time ?? "") - Date.parse(first.time) < 86_400_000
      ? { effect: "too little history", effectText: f.logOn ? `${what} ${now} now; a trend is read once the log spans a day` : `${what} ${now} now; a trend needs the log, which is off here` }
      : { effect: "measured", effectText: `${what} ${was(first)} at the first line of the log (${day(first.time)}), ${now} now` };
  const corr = new Map<string, number>();
  for (const c of f.corrections) corr.set(c.outcome, (corr.get(c.outcome) ?? 0) + 1);
  const corrText = f.logOn ? `Prompts that read like a correction by their wording, since the log went on: ${f.corrections.length}${f.corrections.length > 0 ? ` (${[...corr].map(([k, v]) => `${k} ${v}`).join("; ")})` : ""}${f.correctionsWaiting > 0 ? `, ${f.correctionsWaiting} waiting for their turn to end` : ""}.` : "Chat corrections are not counted: the log is off here.";
  const no = (reason: string): { inUse: null; use: string; effect: Effect; effectText: string } => ({ inUse: null, use: reason, effect: "not measured", effectText: "not measured" });

  const outcomeCell = (): { effect: Effect; effectText: string } => {
    if (!f.sinceDate || !f.before || !f.since) return { effect: "not measured", effectText: "the harness was never switched on here, so there is no before and since" };
    const said = `fix commits since ${day(f.sinceDate)}: ${f.since.fixes} of ${f.since.commits}; before: ${f.before.fixes} of ${f.before.commits}; reverts ${f.since.reverts} and ${f.before.reverts}`;
    if (f.since.commits < MIN_COMMITS || f.before.commits < MIN_COMMITS) return { effect: "too little history", effectText: `${said}. Each side needs ${MIN_COMMITS} commits before the two are compared` };
    const share = f.before.fixes / f.before.commits;
    const high = atLeast(f.since.fixes, f.since.commits, share);
    const low = 1 - atLeast(f.since.fixes + 1, f.since.commits, share);
    return { effect: "measured", effectText: `${said}. With no change, a share this high or higher has a chance of ${(100 * high).toFixed(1)}%, this low or lower ${(100 * low).toFixed(1)}%. Other things changed over the same weeks, and a fix is read from a subject line` };
  };

  const ids = (rs: Rule[]): string => list(rs.map((r) => r.id));
  const anyLayer = f.rules.length + checks.length + tests.length + drivers.length > 0;
  const rows: LessonRow[] = [
    { n: 1, lesson: "Invest bottom-up: the code and its interfaces first, then static checks, then verification, prose last", at: "01:45", audit: "T1", inUse: anyLayer, use: `Static checks and verification only: ${f.rules.length} rule(s), ${checks.length} check(s), ${tests.length} mapped test(s), ${drivers.length} driver(s). The first layer, the code itself, is out of reach: the harness never edits a repository file`, effect: "not measured", effectText: "not measured" },
    { n: 2, lesson: "Each correction becomes a deterministic check, not a line of prose", at: "02:57", audit: "T2", inUse: proven.length + written.length > 0, use: `${proven.length} of ${f.rules.length} rule(s) proven on a fix or on a change after a correction (${ids(proven)}); ${written.length} written test(s) (${list(written.map((t) => t.name))}), ${written.filter((t) => t.stage === "trial").length} on trial. ${corrText} Effect is counted here for pattern rules (${ids(rulesOf(2))}) and written tests; a ban counts under 4 or 5`, ...effectOf(by[2] ?? ZERO, "no rule of this kind and no written test has caught anything in a session yet") },
    { n: 3, lesson: "Agents copy what is there: stop new cases, then clean the old ones", at: "04:09", audit: "T3", inUse: f.rules.some((r) => sum(Object.values(r.baseline ?? {})) > 0), use: `Backlog allowed by the rules: ${sum(f.rules.map((r) => sum(Object.values(r.baseline ?? {}))))}; in the tree now: ${sum(f.rules.map((r) => f.census[r.id] ?? 0))} (${list(f.rules.map((r) => `${r.id} ${f.census[r.id] ?? 0}`))})`, ...trend(sum(f.rules.map((r) => f.census[r.id] ?? 0)), (s) => s.backlogNow, "old cases in the tree:") },
    { n: 4, lesson: "Ban what needs nuance to use well", at: "05:13", audit: "T4", inUse: rulesOf(4).length > 0, use: `${rulesOf(4).length} ban(s) of a call or of an outside package (${ids(rulesOf(4))})`, ...effectOf(by[4] ?? ZERO, "no ban has caught anything in a session yet") },
    { n: 5, lesson: "Directory structure as context: imports across a boundary are forbidden", at: "05:59", audit: "T5", inUse: rulesOf(5).length > 0, use: `${rulesOf(5).length} ban(s) of an import from a path inside the repository (${ids(rulesOf(5))}). A one-line pattern, not a dependency graph`, ...effectOf(by[5] ?? ZERO, "no boundary rule has caught anything in a session yet") },
    { n: 6, lesson: "Comments and markdown become excuses: ban them", at: "06:46", audit: "T6", inUse: true, use: `Only the suppressions written as comments are counted: ${commentForms} in tracked source (${list(COMMENT_FORMS.filter((n) => (f.hatches.byName[n] ?? 0) > 0).map((n) => `${n} ${f.hatches.byName[n]}`))}), of ${f.hatches.total} escape hatches${f.config.hatchCeiling === undefined ? "" : `, ceiling ${f.config.hatchCeiling}`}. A new one is reported in the session that adds it. Comments that argue for a shortcut, and markdown, are not looked at`, ...((e) => ({ effect: e.effect, effectText: `${e.effectText}. ${trend(commentForms, (s) => s.commentForms, "comment suppressions:").effectText}` }))(effectOf(by[6] ?? ZERO, "no added comment suppression has been taken out again while it could not hold the turn")) },
    { n: 7, lesson: "Agents over-rotate on a one-off correction", at: "06:58", audit: "", inUse: f.rules.length > 0, use: `${proven.length} of ${f.rules.length} rule(s) proven on the change they come from; ${f.rules.filter((r) => r.stage === "trial").length} on trial, where a rule reports and cannot hold a turn`, effect: "not measured", effectText: "nothing here tells a rule that is too wide from one that is right" },
    { n: 8, lesson: "A check's message names the root cause and the fix", at: "08:39", audit: "T7", inUse: f.rules.length > 0, use: `Every rule carries its fix text, or it is refused (${f.rules.length} rule(s))`, effect: "shared", effectText: `the same events as rows 2, 4, 5, 6, 10 and 12, not counted again: gone while it could not hold the turn ${p.advisedActedOn}, gone while it could hold the turn ${p.holdingActedOn} (compliance)` },
    { n: 9, lesson: "End state: nothing left to review, agents merge their own work", at: "09:16", audit: "", ...no("Not in the harness: it merges, commits and posts nothing") },
    { n: 10, lesson: "Runtime verification: run the code", at: "09:47", audit: "T8", inUse: mapped.length + checks.length > 0, use: `${checks.length} check(s), ${mapped.length} mapped test(s) besides the written ones. On record: checks passed ${runs("check", "pass")}, failed ${runs("check", "fail")}; tests passed ${runs("test", "pass")}, failed ${runs("test", "fail")}. Tests still unrun at a session's last recorded turn: ${unrun} in ${ends.filter((e) => e.unrun.length > 0).length} of ${ends.length} session(s). Tests run at a turn end; nothing drives the running program`, ...effectOf(by[10] ?? ZERO, "no check or mapped test has failed and then passed in one session yet") },
    { n: 11, lesson: "Feature map: the program's features in the user's words", at: "10:05", audit: "T9", ...no("Not in the harness: `ratchet features` maps folders to what watches them, which is another thing") },
    { n: 12, lesson: "Reusable command-line drivers, cheaper and testable", at: "10:20", audit: "", inUse: drivers.length > 0, use: `${drivers.length} driver(s) (${list(drivers.map((d) => d.name))}). On record: passed ${runs("driver", "pass")}, failed ${runs("driver", "fail")}`, ...effectOf(by[12] ?? ZERO, "no driver has failed and then passed in one session yet") },
    { n: 13, lesson: "Formal verification where it pays", at: "10:35", audit: "T10", ...no("Not in the harness") },
    { n: 14, lesson: "Property-based testing", at: "11:22", audit: "T11", ...no("Not measured: the harness does not tell a test that generates its inputs from one that does not") },
    { n: 15, lesson: "Most tokens go to verification", at: "11:57", audit: "T12", ...no("Not measured: a hook cannot tell which tokens of a session went to verification") },
    { n: 16, lesson: "Review the verification artifacts, not the diff", at: "09:35", audit: "T13", inUse: f.records.length > 0, use: `${f.records.length} verification record(s) written, text only (no picture, video or diagram). ${f.logOn ? `Latest record shown by command: ${f.shown.filter((s) => !s.agent).length} time(s) from a shell that is not an agent's, ${f.shown.filter((s) => s.agent).length} from an agent's shell` : "Whether a record is shown by command is not logged: the log is off here"}`, effect: "not measured", effectText: "a record shown by command is not a record read" },
    { n: 17, lesson: "Judge by outcomes: reverts and the fixes that follow", at: "14:04", audit: "T15", inUse: f.sinceDate !== null, use: f.sinceDate ? `Fix commits, fixes of a fix and reverts are read from git history, split at ${day(f.sinceDate)}. No performance number` : "The harness was never switched on here", ...outcomeCell() },
    { n: 18, lesson: "Fix the inner loop before automating", at: "15:00", audit: "T14", ...no("By design, not by measurement: the harness merges, commits and posts nothing, and its loop only tightens") },
    { n: 19, lesson: "Outer loop: agents fuzz each release, fix and merge", at: "15:57", audit: "T16", ...no("Not in the harness") },
  ];
  // A row that is not in use has no effect to wait for.
  return rows.map((r) => (r.inUse === false ? { ...r, effect: "not in use" as const, effectText: "not in use" } : r));
};

export const renderLessons = ({ root, rows, logOn, time }: { root: string; rows: LessonRow[]; logOn: boolean; time: string }): string => {
  const nums = (e: Effect): string => {
    const ns = rows.filter((r) => r.effect === e).map((r) => r.n);
    return `${ns.length}${ns.length > 0 ? ` (${ns.join(", ")})` : ""}`;
  };
  const cell = (s: string): string => s.replace(/\|/g, "/");
  return [
    `# Lesson card of ${root}`,
    "",
    `Read ${time.slice(0, 16).replace("T", " ")} from this project's turn records, rules, config and git history. The lessons are the nineteen of the talk named in the Ratchet README.`,
    "",
    `Effect shown: ${nums("shown")} of ${rows.length} lessons. Measured as a number with no verdict: ${nums("measured")}. In use with no effect on record yet: ${nums("none yet")}. Not in use: ${nums("not in use")}. Too little history: ${nums("too little history")}. Shared with other rows: ${nums("shared")}. Not measured by the harness: ${nums("not measured")}.`,
    `In use here: ${rows.filter((r) => r.inUse === true).length}. Not in use: ${rows.filter((r) => r.inUse === false).length}. Outside what the harness can see: ${rows.filter((r) => r.inUse === null).length}.`,
    "",
    "In use is not effect: a rule that never fires is in use and shows nothing. \"Shown\" counts two kinds of event only: a command that failed at one turn end and passed at a later one of the same session, and a finding that could not hold the turn and was gone at a later turn end. A finding that could hold the turn and was gone is compliance and is printed apart. Each rule, test and driver counts for one row only.",
    "",
    "| # | Lesson (talk time, audit row) | In use here | Effect measured |",
    "|---|---|---|---|",
    ...rows.map((r) => `| ${r.n} | ${cell(r.lesson)} [${r.at}${r.audit ? `, ${r.audit}` : ""}] | ${r.inUse === null ? "" : r.inUse ? "Yes. " : "No. "}${cell(r.use)}. | **${r.effect}**${r.effectText === r.effect ? "" : `: ${cell(r.effectText)}`}. |`),
    "",
    logOn ? "The log is on for this project: each pass of the loop adds one line of these numbers to lessons.jsonl and writes this page again." : "The log is off for this project: nothing was written. `ratchet lessons --on` lets each pass of the loop keep one line of these numbers, which is what a trend is read from.",
    "",
  ].join("\n");
};

// ---- reading the facts and keeping the log ---------------------------------------------------------------------

const lines = <T>(file: string): T[] => {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as T];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
};

/** Everything the card reads, counted by the functions the other commands use (C5). It writes nothing. */
export const gatherLessonFacts = (root: string): LessonFacts => {
  const config = readConfig(root);
  const rules = readRules(root);
  const dir = projectDir(root);
  const state = readState();
  const sinceDate = state.projects[normRoot(root)]?.since ?? (effective(state, root).enabled ? state.since : undefined) ?? null;
  let log: ReturnType<typeof parseLog> = [];
  try {
    log = parseLog(execFileSync("git", ["-C", root, "log", "-400", "--no-merges", "--format=%x01%H%x09%ct%x09%s", "--name-only"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    log = [];
  }
  const cut = sinceDate ? Date.parse(sinceDate) / 1000 : null;
  const hatches = countHatches(root);
  return {
    rules,
    config,
    records: realRecords(root),
    topFolders: [...new Set(trackedFiles(root).filter((f) => f.includes("/")).map((f) => f.split("/")[0] as string))],
    census: Object.fromEntries(rules.map((r) => [r.id, sum(Object.values(census(root, r)))])),
    hatches: { total: hatches.total, byName: hatches.byName },
    sinceDate,
    before: cut === null ? null : outcomes({ commits: log.filter((c) => c.time < cut) }),
    since: cut === null ? null : outcomes({ commits: log.filter((c) => c.time >= cut) }),
    snapshots: lines<Snapshot>(path.join(dir, "lessons.jsonl")),
    corrections: lines<{ time: string; outcome: string }>(path.join(dir, "corrections.jsonl")),
    correctionsWaiting: pendingCorrections(root).length,
    shown: lines<{ time: string; agent: boolean }>(path.join(dir, "shown.jsonl")),
    logOn: config.lessonsLog === true,
  };
};

const append = (file: string, value: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
};

/** One exit of the chat-correction step, kept only where the log is on. Never a word of the chat. */
export const logCorrection = ({ root, time, outcome }: { root: string; time: string; outcome: string }): void => {
  if (readConfig(root).lessonsLog === true) append(path.join(projectDir(root), "corrections.jsonl"), { time, outcome });
};

/** The latest verification record was shown by command. Kept only where the log is on. */
export const logShown = ({ root, time, agent }: { root: string; time: string; agent: boolean }): void => {
  if (readConfig(root).lessonsLog === true) append(path.join(projectDir(root), "shown.jsonl"), { time, agent });
};

/** One pass of the loop: a line of the card's numbers and the page, only where the log is on (C7, C8). */
export const logLessons = ({ root, time }: { root: string; time: string }): boolean => {
  if (readConfig(root).lessonsLog !== true) return false;
  const dir = projectDir(root);
  const facts = gatherLessonFacts(root);
  const line = snapshotOf(facts, time);
  append(path.join(dir, "lessons.jsonl"), line);
  facts.snapshots.push(line);
  fs.writeFileSync(path.join(dir, "lessons.md"), renderLessons({ root: normRoot(root), rows: lessonCard(facts), logOn: true, time }));
  return true;
};
