// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { decideStep, passedStep, type RunRecord, type Step, type StepDecision } from "./ladder.ts";
import { DEFAULT_LIMITS, type Limits, type Machine } from "./launchgate.ts";
import { runSwarm, type RunRecord as SwarmRecord, type Slice, type SpawnWorker, type Verify } from "./orchestrator.ts";

/** The generalised ladder runner: reads the run records, takes a census of other projects, asks decideStep, and only then runs. Pure parts first; every impure part is injected. */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const isStep = (n: number | undefined): n is Step => n === 1 || n === 2 || n === 3 || n === 4;

// ---- (1) run records

export type StoredRun = { stamp: string; dir: string; record: RunRecord };

/** Overlap of n running intervals (ms): they share an instant when the latest start is before the earliest end. */
export const overlapOf = (intervals: { startMs: number; endMs?: number }[], n: number): { overlapped: boolean; overlapMs: number } => {
  if (intervals.length !== n || intervals.some((i) => i.endMs === undefined)) return { overlapped: false, overlapMs: 0 };
  const latestStart = Math.max(...intervals.map((i) => i.startMs));
  const earliestEnd = Math.min(...intervals.map((i) => i.endMs ?? 0));
  return latestStart < earliestEnd ? { overlapped: true, overlapMs: earliestEnd - latestStart } : { overlapped: false, overlapMs: 0 };
};

/**
 * The ladder's view of one live-record.json. Gaps and unverified patches are counted from the orchestrator's outcomes (the program's verdicts),
 * not from coverage lines: step 1's record shows a gap that was the old coverage bug (a verified patch with no JSON line in the report).
 * A run of step 2 or more is complete only when its workers overlapped. A record that did not run (a refused gate) is no run record.
 */
export const deriveRecord = (live: unknown): { stamp: string; record: RunRecord } | undefined => {
  if (!isObj(live) || live["ran"] !== true) return undefined;
  const tasks = list(live["tasks"]);
  const declared = num(live["step"]);
  const slices = tasks.length > 0 ? tasks.length : text(live["task"]) !== undefined ? 1 : 0;
  const step = isStep(declared) ? declared : isStep(slices) ? slices : undefined;
  if (step === undefined) return undefined;
  const swarm = isObj(live["record"]) ? live["record"] : {};
  const outcomes = list(swarm["outcomes"]).filter(isObj);
  const gaps = outcomes.filter((o) => o["state"] === "gap").length + Math.max(0, step - outcomes.length);
  const unverified = outcomes.filter((o) => o["state"] === "accepted" && (text(o["verifier"]) === undefined || o["verifier"] === o["author"])).length;
  const checks = isObj(live["checks"]) ? live["checks"] : {};
  const overlapped = live["status"] === "overlapped" || checks["bothWorkersOverlapped"] === true || checks["overlapped"] === true;
  const completed = outcomes.length >= step && (step === 1 || overlapped);
  return { stamp: text(live["stamp"]) ?? "", record: { step, completed, gaps, unverifiedPatches: unverified } };
};

/** All run records under a results folder (one or two levels deep), oldest first by stamp. */
export const readRunRecords = (resultsDir: string): StoredRun[] => {
  const found: StoredRun[] = [];
  const visit = (dir: string, depth: number): void => {
    if (!fs.existsSync(dir)) return;
    const file = path.join(dir, "live-record.json");
    if (fs.existsSync(file)) {
      try {
        const d = deriveRecord(JSON.parse(fs.readFileSync(file, "utf8")));
        if (d !== undefined) found.push({ stamp: d.stamp, dir, record: d.record });
      } catch {
        // an unreadable record is not a run record
      }
    }
    if (depth <= 0) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) visit(path.join(dir, e.name), depth - 1);
  };
  visit(resultsDir, 2);
  return found.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0));
};

/** The next step to run: one above the highest clean step. null when step 4 is clean (the ladder is done). */
export const nextStep = (records: RunRecord[]): Step | null => {
  const next = passedStep(records) + 1;
  return isStep(next) ? next : null;
};

// ---- (2) census of other projects

export type Proc = { pid: number; ppid: number; name: string; cmd: string };
export type OtherProc = { pid: number; name: string; project: string; cmd: string };

const PROJECT_PATH = /[a-z]:[\\/]+projects[\\/]+([^\\/\s"']+)/gi;

/** Process ids that are this process, its ancestors, its descendants, and the whole tree of the nearest ancestor claude session (the harness that started it). */
export const ownTree = (procs: Proc[], selfPid: number): Set<number> => {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const children = new Map<number, number[]>();
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p.pid]);
  const own = new Set<number>();
  const down = new Set<number>();
  const addDown = (pid: number): void => {
    if (down.has(pid)) return;
    down.add(pid);
    own.add(pid);
    for (const c of children.get(pid) ?? []) addDown(c);
  };
  let session: number | undefined;
  for (let pid: number | undefined = selfPid, hops = 0; pid !== undefined && hops < 64; hops++) {
    own.add(pid);
    const p = byPid.get(pid);
    if (p !== undefined && session === undefined && pid !== selfPid && /^claude(\.exe)?$/i.test(p.name)) session = pid;
    pid = p === undefined || p.ppid === pid || own.has(p.ppid) ? undefined : p.ppid;
  }
  addDown(selfPid);
  if (session !== undefined) addDown(session);
  return own;
};

/** Processes whose command line names a project folder under C:\Projects other than `ownProject`; the harness's own tree does not count. */
export const otherProjectProcesses = (procs: Proc[], ownProject: string, selfPid: number): OtherProc[] => {
  const own = ownTree(procs, selfPid);
  const out: OtherProc[] = [];
  for (const p of procs) {
    if (own.has(p.pid)) continue;
    const projects = [...p.cmd.matchAll(PROJECT_PATH)].map((m) => (m[1] ?? "").toLowerCase()).filter((x) => x !== "" && x !== ownProject.toLowerCase());
    const first = projects[0];
    if (first !== undefined) out.push({ pid: p.pid, name: p.name, project: first, cmd: p.cmd.replace(/\s+/g, " ").slice(0, 140) });
  }
  return out;
};

/** Parses `Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json`. */
export const parseCimJson = (raw: string): Proc[] => {
  const parsed: unknown = JSON.parse(raw);
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const out: Proc[] = [];
  for (const r of rows) {
    if (!isObj(r)) continue;
    const pid = num(r["ProcessId"]);
    if (pid === undefined) continue;
    out.push({ pid, ppid: num(r["ParentProcessId"]) ?? 0, name: text(r["Name"]) ?? "", cmd: text(r["CommandLine"]) ?? "" });
  }
  return out;
};

/** Parses `ps -eo pid=,ppid=,comm=,args=` (non-Windows). */
export const parsePs = (raw: string): Proc[] =>
  raw
    .split(/\r?\n/)
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(l))
    .flatMap((m) => (m === null ? [] : [{ pid: Number(m[1]), ppid: Number(m[2]), name: m[3] ?? "", cmd: m[4] ?? "" }]));

/** The real process list. Throws when it cannot be read; the caller treats that as unknown (counted as shared). */
export const listProcesses = (): Proc[] => {
  if (process.platform === "win32") {
    const q = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress";
    return parseCimJson(execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", q], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true }));
  }
  return parsePs(execFileSync("ps", ["-eo", "pid=,ppid=,comm=,args="], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
};

export type Census = { others: OtherProc[]; error?: string };

export const takeCensus = (ownProject: string, selfPid: number, list_: () => Proc[] = listProcesses): Census => {
  try {
    return { others: otherProjectProcesses(list_(), ownProject, selfPid) };
  } catch (e) {
    return { others: [], error: e instanceof Error ? e.message : String(e) };
  }
};

/** Census to decideStep's fact: true, false, or null when the census could not be read. */
export const sharesMachine = (c: Census): boolean | null => (c.error !== undefined ? null : c.others.length > 0);

/** A short, grouped description of who shares the machine, for the refusal. */
export const describeOthers = (c: Census): string[] => {
  if (c.error !== undefined) return [`census unreadable: ${c.error}`];
  const byProject = new Map<string, OtherProc[]>();
  for (const p of c.others) byProject.set(p.project, [...(byProject.get(p.project) ?? []), p]);
  return [...byProject.entries()].map(([project, ps]) => `${project}: ${ps.length} process(es), e.g. ${ps.slice(0, 3).map((p) => `${p.name} pid ${p.pid} (${p.cmd.slice(0, 80)})`).join("; ")}`);
};

// ---- (3) tasks

export type PoolTask = { id: string; files: string[]; test: string; brief: string; source: string };
export type UsedTasks = { used: { id: string; step?: number; run?: string; note?: string }[] };

const inSet = (f: string, set: string[]): boolean => set.some((a) => (a.endsWith("/") ? f.startsWith(a) : f === a));
const disjoint = (a: PoolTask, b: PoolTask): boolean => !a.files.some((f) => inSet(f, b.files)) && !b.files.some((f) => inSet(f, a.files));

/** n unused tasks with pairwise disjoint file sets, in pool order; fewer when the pool cannot give n. */
export const pickTasks = (pool: PoolTask[], used: UsedTasks, n: number): PoolTask[] => {
  const taken = new Set(used.used.map((u) => u.id));
  const out: PoolTask[] = [];
  for (const t of pool) {
    if (out.length >= n) break;
    if (taken.has(t.id) || out.some((o) => !disjoint(o, t))) continue;
    out.push(t);
  }
  return out;
};

export const readUsed = (file: string): UsedTasks => {
  if (!fs.existsSync(file)) return { used: [] };
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  const rows = isObj(parsed) ? list(parsed["used"]).filter(isObj) : [];
  return { used: rows.flatMap((r) => (text(r["id"]) === undefined ? [] : [{ id: text(r["id"]) ?? "", step: num(r["step"]), run: text(r["run"]), note: text(r["note"]) }])) };
};

export const recordUsed = (file: string, tasks: PoolTask[], step: Step, run: string): void => {
  const u = readUsed(file);
  for (const t of tasks) u.used.push({ id: t.id, step, run });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(u, null, 1)}\n`);
};

// ---- (4) the decision

export type Plan = { step: Step | null; workers: number; decision: StepDecision; tasks: PoolTask[]; limits: Limits; census: string[] };

export type PlanInput = { records: RunRecord[]; census: Census; machine: Machine; pool: PoolTask[]; used: UsedTasks; requested?: Step };

/** Process ceiling: the census at start plus room for each worker's claude and helper processes (the lesson of step 2 run 1). */
export const limitsFor = (machine: Machine, step: Step): Limits => ({ ...DEFAULT_LIMITS, maxProcesses: machine.processes + 6 * step, maxWorkers: step });

export const plan = (q: PlanInput): Plan => {
  const step = q.requested ?? nextStep(q.records);
  if (step === null) return { step: null, workers: 0, decision: { allowed: false, reasons: ["every step of the ladder (1 to 4) has a clean record"] }, tasks: [], limits: DEFAULT_LIMITS, census: [] };
  const limits = limitsFor(q.machine, step);
  const base = decideStep({ requested: step, records: q.records, machine: q.machine, limits, otherProjectShares: sharesMachine(q.census) });
  const tasks = pickTasks(q.pool, q.used, step);
  const reasons = base.allowed ? [] : [...base.reasons];
  if (tasks.length < step) reasons.push(`only ${tasks.length} unused disjoint task(s) in the pool, step ${step} needs ${step}`);
  return { step, workers: step, decision: reasons.length === 0 ? { allowed: true } : { allowed: false, reasons }, tasks, limits, census: describeOthers(q.census) };
};

// ---- (5) the run

export type ExecuteInput = {
  step: Step;
  tasks: PoolTask[];
  outDir: string;
  stamp: string;
  usedFile: string;
  /** Folder each worker writes in (its own worktree). */
  rootOf: (t: PoolTask) => string;
  promptOf: (t: PoolTask) => string;
  spawnWorker: SpawnWorker;
  verify: Verify;
  machine: (workers: number) => Machine | Promise<Machine>;
  limits: Limits;
  holdFile: string;
  root: string;
  env: Record<string, string | undefined>;
  /** Files changed in a worker's tree after the run (for the isolation check). Default: none known. */
  changedIn?: (t: PoolTask) => string[];
  /** The hold file is written after this long, so the whole run stays under 20 minutes. Default 13 minutes. */
  deadlineMs?: number;
  pollMs?: number;
  stuckAfterMs?: number;
  now?: () => number;
};

export const executeStep = async (x: ExecuteInput): Promise<{ live: Record<string, unknown>; swarm: SwarmRecord }> => {
  const now = x.now ?? Date.now;
  const started = now();
  fs.mkdirSync(x.outDir, { recursive: true });
  // The tasks count as used from the moment the run starts, so a crash never lets a retry reuse them.
  recordUsed(x.usedFile, x.tasks, x.step, path.basename(x.outDir));
  const intervals = new Map<string, { startMs: number; endMs?: number }>();
  const markEnd = (id: string): void => {
    const iv = intervals.get(id);
    if (iv !== undefined) iv.endMs = now() - started;
  };
  const spawnWorker: SpawnWorker = async (req) => {
    const h = await x.spawnWorker(req);
    intervals.set(req.slice.id, { startMs: now() - started });
    void h.done.then(
      () => markEnd(req.slice.id),
      () => markEnd(req.slice.id),
    );
    return h;
  };
  const timer = setTimeout(() => fs.writeFileSync(x.holdFile, "run deadline\n"), x.deadlineMs ?? 13 * 60 * 1000);
  let swarm: SwarmRecord;
  try {
    const slices: Slice[] = x.tasks.map((t) => ({ id: t.id, files: t.files, prompt: x.promptOf(t), root: x.rootOf(t) }));
    swarm = await runSwarm({ slices, spawnWorker, verify: x.verify, holdFile: x.holdFile, recordFile: path.join(x.outDir, "orchestrator-record.json"), root: x.root, limits: x.limits, machine: x.machine, stuckAfterMs: x.stuckAfterMs ?? 8 * 60 * 1000, pollMs: x.pollMs ?? 2000, env: x.env, now });
  } finally {
    clearTimeout(timer);
  }
  const iv = overlapOf([...intervals.values()], x.step);
  const isolation = x.tasks.map((t) => {
    const changed = (x.changedIn ?? (() => []))(t);
    const others = x.tasks.filter((o) => o.id !== t.id);
    return { task: t.id, changed, outsideOwnSet: changed.filter((f) => !inSet(f, t.files)), inOtherTasksSet: changed.filter((f) => others.some((o) => inSet(f, o.files))) };
  });
  const disjointSets = x.tasks.every((a) => x.tasks.every((b) => a === b || disjoint(a, b)));
  const noCross = isolation.every((i) => i.outsideOwnSet.length === 0 && i.inOtherTasksSet.length === 0);
  const verifierIsNotAuthor = swarm.outcomes.every((o) => o.verifier === undefined || (o.author !== undefined && o.verifier !== o.author));
  const live: Record<string, unknown> = {
    stamp: x.stamp,
    ran: true,
    step: x.step,
    status: iv.overlapped ? "overlapped" : "not overlapped",
    intervals: Object.fromEntries(intervals),
    overlapMs: iv.overlapMs,
    tasks: x.tasks.map((t) => ({ id: t.id, files: t.files, source: t.source })),
    limits: x.limits,
    elapsedSeconds: Math.round((now() - started) / 1000),
    record: swarm,
    isolation,
    checks: { disjointSets, noCross, verifierIsNotAuthor, overlapped: iv.overlapped },
    accepted: swarm.accepted,
  };
  fs.writeFileSync(path.join(x.outDir, "live-record.json"), `${JSON.stringify(live, null, 1)}\n`);
  return { live, swarm };
};

/** Runs `execute` only when the plan allows it; a refusal starts nothing and returns the plan with its reasons. */
export const runIfAllowed = async <T>(p: Plan, execute: (p: Plan) => Promise<T>): Promise<{ ran: false; plan: Plan } | { ran: true; plan: Plan; result: T }> => {
  if (!p.decision.allowed || p.step === null) return { ran: false, plan: p };
  return { ran: true, plan: p, result: await execute(p) };
};
