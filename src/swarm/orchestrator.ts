import fs from "node:fs";
import path from "node:path";
import { countVerdict, type VerdictWord } from "../harness/mergeclass.ts";
import { subscriptionEnv } from "../subscription.ts";
import { decideLaunch, DEFAULT_LIMITS, readMachine, type Limits, type Machine } from "./launchgate.ts";
import { coverage, type Coverage, type Returned } from "./slices.ts";
import { judgeWorker, showsNothingNew, type Probe, type WorkerRecord } from "./stuck.ts";
import { acceptVerdict, patchId, type Check, type Handover } from "./verdict.ts";

/** One task of the run: a file set the worker may write, and what it is asked to do. */
export type Slice = { id: string; files: string[]; prompt: string; /** The tree this worker writes in (its own worktree). Default: the run's `root`. */ root?: string };

/** What a worker hands back when it ends by itself. A missing report is a gap; a missing diff is "no patch". */
export type WorkerEnd = { report?: string; diff?: string; files?: string[]; base?: string };

export type WorkerHandle = {
  /** The session that writes the patch. A verifier with the same id is refused. */
  author: string;
  done: Promise<WorkerEnd>;
  /** Transcript size and file mtimes now. Stuck is judged by these side effects only (K10). */
  probe: () => Probe | Promise<Probe>;
  stop: () => void | Promise<void>;
};

/** The guard environment of K5 to K9, plus the worker's task. Billing variables are never in env. */
export type SpawnRequest = { slice: Slice; env: Record<string, string> };
export type SpawnWorker = (req: SpawnRequest) => WorkerHandle | Promise<WorkerHandle>;

/** What a verifier returns. The orchestrator, not the verifier, decides whether it counts. */
export type VerifierReport = { verifier: string; patchId: string; verdict: VerdictWord; evidence: string[]; status: "PASS" | "ISSUES" | "BLOCKED"; method: string; checks: Check[] };
export type Verify = (handover: Handover, diff: string) => Promise<VerifierReport>;

export type Options = {
  slices: Slice[];
  spawnWorker: SpawnWorker;
  verify: Verify;
  /** The owner's hold file (K9): while it exists nothing launches and running workers are stopped. */
  holdFile: string;
  /** The JSON run record is written here. */
  recordFile: string;
  /** Root of the tree workers write in, for RATCHET_SWARM_ROOT. */
  root: string;
  limits?: Limits;
  stuckAfterMs?: number;
  pollMs?: number;
  /** Reads the machine for the launch gate. Default: the real one. */
  machine?: (workers: number) => Machine | Promise<Machine>;
  now?: () => number;
  /** Environment to derive from; billing variables are stripped. Default: process.env. */
  env?: Record<string, string | undefined>;
};

export type SliceOutcome = {
  slice: string;
  state: "accepted" | "refused" | "no-patch" | "gap";
  author?: string;
  patchId?: string;
  verifier?: string;
  reasons: string[];
  notes: string[];
};

export type RunRecord = {
  startedAt: number;
  endedAt: number;
  held: boolean;
  launchWaits: { slice: string; reasons: string[] }[];
  stuck: string[];
  outcomes: SliceOutcome[];
  coverage: Coverage;
  accepted: string[];
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The environment a worker starts with: the guard's variables over the subscription-only environment (never an API key). */
export const workerEnv = (slice: Slice, o: Pick<Options, "root" | "holdFile" | "recordFile" | "env">): Record<string, string> => {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(subscriptionEnv(o.env ?? process.env))) if (v !== undefined) clean[k] = v;
  return {
    ...clean,
    RATCHET_SWARM_ROLE: "worker",
    RATCHET_SWARM_ROOT: slice.root ?? o.root,
    RATCHET_SWARM_ALLOW: slice.files.join(";"),
    RATCHET_SWARM_HOLD: o.holdFile,
    RATCHET_SWARM_LOG: path.join(path.dirname(o.recordFile), `${slice.id}.refusals.jsonl`),
  };
};

/** SCALE_PLAN K2, K6, K9, K10 and the proof plan's row 9 in one loop. Returns the record it also writes. */
export const runSwarm = async (o: Options): Promise<RunRecord> => {
  const now = o.now ?? Date.now;
  const pollMs = o.pollMs ?? 1000;
  const stuckAfterMs = o.stuckAfterMs ?? 10 * 60 * 1000;
  const limits = o.limits ?? DEFAULT_LIMITS;
  const machine = o.machine ?? ((w: number) => readMachine(w));
  const held = (): boolean => fs.existsSync(o.holdFile);
  const startedAt = now();
  const launchWaits: RunRecord["launchWaits"] = [];
  const stuck: string[] = [];
  const outcomes = new Map<string, SliceOutcome>();
  const returned: Record<string, Returned> = {};
  let running = 0;
  let sawHold = false;

  const gap = (slice: string, reason: string): void => {
    outcomes.set(slice, { slice, state: "gap", reasons: [reason], notes: [] });
  };

  const runSlice = async (slice: Slice): Promise<void> => {
    running++;
    try {
      const handle = await o.spawnWorker({ slice, env: workerEnv(slice, o) });
      const rec: WorkerRecord = { id: slice.id, startedAt: now() };
      let last = await handle.probe();
      let finished: WorkerEnd | undefined;
      handle.done.then(
        (e) => {
          finished = e;
        },
        () => {
          finished = {};
        },
      );
      let end: WorkerEnd | "stuck" | "hold" | undefined;
      while (end === undefined) {
        await Promise.race([handle.done.catch(() => undefined), sleep(pollMs)]);
        if (finished !== undefined) {
          end = finished;
        } else if (held()) {
          sawHold = true;
          end = "hold";
        } else {
          const seen = await handle.probe();
          if (!showsNothingNew(last, seen)) rec.lastActivityAt = now();
          last = seen;
          if (judgeWorker(rec, now(), stuckAfterMs) === "stuck") end = "stuck";
        }
      }
      if (end === "hold" || end === "stuck") {
        await handle.stop();
        if (end === "stuck") stuck.push(slice.id);
        gap(slice.id, end === "hold" ? "stopped by the hold file" : "the worker was stuck and was stopped");
        return;
      }
      returned[slice.id] = { report: end.report };
      if (!end.diff || end.diff.trim() === "") {
        outcomes.set(slice.id, { slice: slice.id, state: "no-patch", author: handle.author, reasons: [], notes: [] });
        return;
      }
      const id = patchId(end.diff);
      const handover: Handover = { task: slice.id, author: handle.author, patchId: id, base: end.base ?? "", files: end.files ?? [], allow: slice.files };
      const v = await o.verify(handover, end.diff);
      const accept = acceptVerdict(handover, { verifier: v.verifier, patchId: v.patchId, status: v.status, method: v.method, checks: v.checks }, end.diff);
      const counted = countVerdict({ author: handle.author, verifier: v.verifier, patchId: v.patchId, verdict: v.verdict, evidence: v.evidence }, id);
      const reasons = [...accept.reasons, ...counted.reasons.filter((r) => !accept.reasons.includes(r))];
      // The record of a verified patch comes from the program (the verifier's report and the acceptance rules), so a worker that was never asked for a JSON line is not a gap.
      returned[slice.id] = { report: end.report, verdict: { status: reasons.length === 0 ? "PASS" : v.status === "PASS" ? "ISSUES" : v.status, heads: [id], method: v.method } };
      outcomes.set(slice.id, { slice: slice.id, state: reasons.length === 0 ? "accepted" : "refused", author: handle.author, patchId: id, verifier: v.verifier, reasons, notes: accept.notes });
    } catch (e) {
      gap(slice.id, `the worker failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      running--;
    }
  };

  const tasks: Promise<void>[] = [];
  for (const slice of o.slices) {
    if (held()) sawHold = true;
    // K6: wait on the launch gate; K9: a hold ends all launches.
    let blocked = false;
    while (!sawHold) {
      const d = decideLaunch(await machine(running), limits);
      if (d.start) break;
      if (!blocked) launchWaits.push({ slice: slice.id, reasons: d.reasons });
      blocked = true;
      await sleep(pollMs);
      if (held()) sawHold = true;
    }
    if (sawHold) {
      gap(slice.id, "not started: the hold file exists");
      continue;
    }
    tasks.push(runSlice(slice));
  }
  await Promise.all(tasks);

  const cov = coverage(
    o.slices.map((s) => s.id),
    returned,
  );
  const outs = o.slices.map((s): SliceOutcome => outcomes.get(s.id) ?? { slice: s.id, state: "gap", reasons: ["no outcome"], notes: [] });
  const record: RunRecord = { startedAt, endedAt: now(), held: sawHold, launchWaits, stuck, outcomes: outs, coverage: cov, accepted: outs.filter((x) => x.state === "accepted").map((x) => x.slice) };
  fs.mkdirSync(path.dirname(o.recordFile), { recursive: true });
  fs.writeFileSync(o.recordFile, `${JSON.stringify(record, null, 1)}\n`);
  return record;
};
