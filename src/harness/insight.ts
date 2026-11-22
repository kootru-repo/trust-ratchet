import { execFileSync } from "node:child_process";
import { forShell } from "../shellcmd.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { atLeast } from "./level.ts";
import { projectDir, readConfig, readJson, writeJson, type CheckCmd } from "./state.ts";

/**
 * What the loop can say about itself beyond its level (gaps H4 to H7 of AUDIT.md):
 * what was acted on, whether its own measure is contradicted by what followed, a baseline run for a project
 * no session has edited yet, and a loop that is off without anyone having switched it off.
 */

// ---- H4: what was acted on ----------------------------------------------------------------------------------

export type TurnRecord = { time: string; sessionId: string; findings: { kind: string; file?: string; title: string; blocking: boolean }[]; outcomes: { kind: string; name: string; status: string }[] };
export type Prevention = {
  /** Findings that stood at one turn end and were gone at a later one in the same session, by whether they could hold the turn. */
  advisedActedOn: number;
  holdingActedOn: number;
  /** A mapped command that failed at one turn end and passed at a later one in the same session: code was wrong, and was mended before the session ended. */
  turned: { name: string; times: number }[];
  sessions: number;
};

/**
 * Pure: what makes a finding the same finding at the next turn end. A rule finding names its lines and a hatch
 * finding its count and lines, and both move when the file is edited elsewhere: by its title a finding that only
 * moved would read as gone. So a rule finding is its rule in its file, and a hatch finding is its file.
 */
export const findingKey = (f: { kind: string; file?: string; title: string }): string => {
  const rule = f.kind === "rule" ? /^rule ([^,]+),/.exec(f.title)?.[1] : undefined;
  return [f.kind, f.file ?? "", rule !== undefined ? rule : f.kind === "hatch" ? "" : f.title].join("\t");
};

/** Pure: read from turn records, oldest first. The three counts are kept apart: they are not the same kind of evidence. */
export const prevention = (records: TurnRecord[]): Prevention => {
  const bySession = new Map<string, TurnRecord[]>();
  for (const r of [...records].sort((a, b) => a.time.localeCompare(b.time))) bySession.set(r.sessionId, [...(bySession.get(r.sessionId) ?? []), r]);
  let advisedActedOn = 0;
  let holdingActedOn = 0;
  const turned = new Map<string, number>();
  for (const turns of bySession.values()) {
    let open = new Map<string, boolean>();
    const failing = new Set<string>();
    for (const turn of turns) {
      const now = new Map(turn.findings.map((f) => [findingKey(f), f.blocking]));
      for (const [key, blocking] of open) {
        if (now.has(key)) continue;
        if (blocking) holdingActedOn += 1;
        else advisedActedOn += 1;
      }
      open = now;
      for (const o of turn.outcomes) {
        if (o.status === "fail") failing.add(o.name);
        else if (o.status === "pass" && failing.delete(o.name)) turned.set(o.name, (turned.get(o.name) ?? 0) + 1);
      }
    }
  }
  return { advisedActedOn, holdingActedOn, turned: [...turned].map(([name, times]) => ({ name, times })).sort((a, b) => b.times - a.times), sessions: bySession.size };
};

/**
 * Pure: what the turn records say about the tests the harness wrote itself. One that failed and then passed within
 * a session was acted on: it may hold a turn from then on. One that was still failing when the session's last turn
 * was let go, in two sessions or more, and was never acted on, is noise: it is taken out again.
 */
export const guardVerdicts = ({ records, names }: { records: TurnRecord[]; names: string[] }): { promote: string[]; retire: string[] } => {
  const turned = new Set(prevention(records).turned.map((t) => t.name));
  const left = new Map<string, number>();
  const last = new Map<string, Map<string, string>>();
  for (const r of [...records].sort((a, b) => a.time.localeCompare(b.time))) for (const o of r.outcomes) if (o.status === "pass" || o.status === "fail") last.set(r.sessionId, new Map(last.get(r.sessionId) ?? [])).get(r.sessionId)?.set(o.name, o.status);
  for (const perSession of last.values()) for (const [name, status] of perSession) if (status === "fail") left.set(name, (left.get(name) ?? 0) + 1);
  return { promote: names.filter((n) => turned.has(n)), retire: names.filter((n) => !turned.has(n) && (left.get(n) ?? 0) >= 2) };
};

export const renderPrevention =(p: Prevention): string => {
  const strong = p.turned.reduce((n, t) => n + t.times, 0);
  return [
    `Acted on, read from ${p.sessions} session(s) with a checked turn. These are three kinds of evidence and are not added up.`,
    `- A mapped check or test failed at a turn end and passed later in the same session: ${strong}${strong > 0 ? ` (${p.turned.map((t) => `${t.name} ${t.times}`).join(", ")})` : ""}. This is the strong count: code was wrong and was mended before the session ended.`,
    `- A finding that could not hold the turn (advise mode or a rule on trial) was gone at a later turn end: ${p.advisedActedOn}. The session chose to act.`,
    `- A finding that could hold the turn was gone at a later turn end: ${p.holdingActedOn}. This is compliance; it does not show the finding was a fault.`,
  ].join("\n");
};

// ---- H5: is the measure contradicted by what followed? --------------------------------------------------------

export type Period = { level: number; from: string; commits: number; fixes: number };
export type SelfCheck = { periods: Period[]; usable: number; contradictions: string[]; text: string };

/**
 * Pure: the assessments of one scheme cut into stretches of one level, each joined to the commits made while it
 * lasted. A contradiction is a stretch at a higher level whose fix share is significantly above that of an
 * earlier stretch at a lower level. This instruments the measure; it does not calibrate it.
 */
export const selfCheck = ({ assessments, commits, scheme, minCommits = 20, alpha = 0.05 }: { assessments: { time: string; level: number; scheme?: number }[]; commits: { time: number; fix: boolean }[]; scheme: number; minCommits?: number; alpha?: number }): SelfCheck => {
  const rows = assessments.filter((a) => (a.scheme ?? 1) === scheme && typeof a.level === "number").sort((a, b) => a.time.localeCompare(b.time));
  const starts: { level: number; from: string }[] = [];
  for (const r of rows) if (starts[starts.length - 1]?.level !== r.level) starts.push({ level: r.level, from: r.time });
  const periods = starts.map((s, i): Period => {
    const lo = Date.parse(s.from) / 1000;
    const hi = starts[i + 1] ? Date.parse(starts[i + 1]?.from ?? "") / 1000 : Infinity;
    const inside = commits.filter((c) => c.time >= lo && c.time < hi);
    return { level: s.level, from: s.from, commits: inside.length, fixes: inside.filter((c) => c.fix).length };
  });
  const usable = periods.filter((p) => p.commits >= minCommits);
  const contradictions: string[] = [];
  for (let i = 0; i < usable.length; i += 1)
    for (let j = i + 1; j < usable.length; j += 1) {
      const a = usable[i];
      const b = usable[j];
      if (!a || !b || b.level <= a.level) continue;
      const chance = atLeast(b.fixes, b.commits, a.fixes / a.commits);
      if (b.fixes / b.commits > a.fixes / a.commits && chance < alpha) contradictions.push(`at level ${b.level} (from ${b.from.slice(0, 10)}) ${b.fixes} of ${b.commits} commits were fixes, against ${a.fixes} of ${a.commits} at level ${a.level} before; the chance of that with no change is ${(chance * 100).toFixed(1)}%`);
    }
  const text = [
    `The measure checked against what followed (scheme ${scheme}): ${periods.length} stretch(es) of one level, ${usable.length} with at least ${minCommits} commits.`,
    ...periods.map((p) => `- level ${p.level} from ${p.from.slice(0, 10)}: ${p.fixes} fix commits of ${p.commits}`),
    usable.length < 2 ? "Too little history to compare two levels. Nothing can be said yet, in either direction." : contradictions.length === 0 ? "No stretch at a higher level had a significantly higher fix share than an earlier lower one." : `CONTRADICTION: ${contradictions.join("; ")}. The level did not go with fewer fixes here.`,
    "This instruments the measure. It does not calibrate it: the thresholds stay conventions, and the loop never loosens one.",
  ].join("\n");
  return { periods, usable: usable.length, contradictions, text };
};

// ---- H6: a baseline run for a project no session has edited yet -----------------------------------------------

export type Baseline = { started: string; head: string; dirty: number; results: { name: string; kind: string; status: "pass" | "fail" | "skipped"; seconds: number; note?: string }[]; done: boolean };

const gitOut = (root: string, args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });

/**
 * Runs some of the project's mapped commands once on the tree as it is, and remembers which ran. It is not a
 * session's turn: nothing here enters the ledger or the count of clean turns. Refused where the project forbids
 * full runs. The tree may hold someone's uncommitted work; that is counted and recorded, never touched.
 */
export const baselineStep = ({ root, max = 5, minutes = 5, now = () => new Date().toISOString(), memory = () => Math.round(100 * (1 - os.freemem() / os.totalmem())) }: { root: string; max?: number; minutes?: number; now?: () => string; memory?: () => number }): { ran: number; baseline: Baseline | null; note: string | null } => {
  const config = readConfig(root);
  if (config.noFullRuns) return { ran: 0, baseline: null, note: "no baseline run: full runs are forbidden for this project (noFullRuns)" };
  const file = path.join(projectDir(root), "baseline.json");
  const head = gitOut(root, ["rev-parse", "HEAD"]).trim();
  let baseline = readJson<Baseline | null>(file, null);
  if (!baseline || baseline.head !== head) baseline = { started: now(), head, dirty: gitOut(root, ["status", "--porcelain"]).split(/\r?\n/).filter(Boolean).length, results: [], done: false };
  const all: { kind: string; check: CheckCmd }[] = [...(config.checks ?? []).map((check) => ({ kind: "check", check })), ...(config.tests ?? []).map((check) => ({ kind: "test", check })), ...(config.drivers ?? []).map((check) => ({ kind: "driver", check }))];
  const have = new Set(baseline.results.map((r) => `${r.kind}\t${r.name}`));
  const deadline = Date.now() + minutes * 60_000;
  let ran = 0;
  let note: string | null = null;
  for (const { kind, check } of all) {
    if (have.has(`${kind}\t${check.name}`)) continue;
    if (check.command.includes("{files}")) {
      baseline.results.push({ name: check.name, kind, status: "skipped", seconds: 0, note: "it needs the list of changed files" });
      continue;
    }
    if (ran >= max || Date.now() >= deadline) break;
    if (memory() >= 90) {
      note = `memory is at ${memory()}%: the baseline run waits.`;
      break;
    }
    const started = Date.now();
    let status: "pass" | "fail" = "pass";
    try {
      execFileSync(forShell(check.command), { cwd: root, shell: true, stdio: "ignore", timeout: (check.timeoutS ?? 120) * 1000, windowsHide: true, env: { ...process.env, RATCHET_CHILD: "1" } });
    } catch {
      status = "fail";
    }
    baseline.results.push({ name: check.name, kind, status, seconds: Math.round((Date.now() - started) / 100) / 10 });
    ran += 1;
  }
  baseline.done = all.length > 0 && all.every(({ kind, check }) => baseline?.results.some((r) => r.kind === kind && r.name === check.name));
  writeJson(file, baseline);
  return { ran, baseline, note };
};

export const readBaseline = (root: string): Baseline | null => {
  const b = readJson<Baseline | null>(path.join(projectDir(root), "baseline.json"), null);
  return b && Array.isArray(b.results) ? b : null;
};

export const renderBaseline = (b: Baseline): string => {
  const n = (s: string): number => b.results.filter((r) => r.status === s).length;
  const failed = b.results.filter((r) => r.status === "fail").map((r) => r.name);
  return `Baseline run of the mapped commands on the tree as it was at ${b.head.slice(0, 8)} (${b.dirty} uncommitted file(s) of someone's work were in it): ${n("pass")} passed, ${n("fail")} failed${failed.length > 0 ? ` (${failed.join(", ")})` : ""}, ${n("skipped")} skipped; ${b.done ? "finished" : "not finished"}. It is not a session's turn and counts for no clean turn.`;
};

// ---- H7: a loop that is off without anyone having switched it off ----------------------------------------------

type Marks = { onAt?: string; offBy?: string };
const marksFile = (root: string): string => path.join(projectDir(root), "auto.json");

/** The switch command leaves its mark beside the loop's own state, where a rewrite of the config cannot reach it. */
export const markSwitch = ({ root, on, now = () => new Date().toISOString() }: { root: string; on: boolean; now?: () => string }): void => {
  const file = marksFile(root);
  const state = readJson<Record<string, unknown>>(file, { root });
  if (on) {
    delete state.offBy;
    state.onAt = now();
  } else state.offBy = now();
  writeJson(file, state);
};

/** One line when the loop was on here, is off now, and no off command was given. Null otherwise. The loop is not switched back on. */
export const offUnseen = (root: string): string | null => {
  if (!fs.existsSync(marksFile(root))) return null;
  const marks = readJson<Marks>(marksFile(root), {});
  if (readConfig(root).auto || !marks.onAt || marks.offBy) return null;
  return `Ratchet's autonomous loop was switched on for this project (${marks.onAt.slice(0, 10)}) and is off now, though nobody switched it off by command: its config was written again without the switch. It is not switched back on by itself. To switch it on: ratchet auto --on --project . ; to keep it off and end this notice: ratchet auto --off --project .`;
};
