// SPDX-License-Identifier: AGPL-3.0-only
/** One worker as the orchestrator records it. */
export type WorkerRecord = {
  id: string;
  /** Epoch ms when it started. */
  startedAt: number;
  /** Epoch ms of the newest side effect seen: transcript growth or a file change in its tree. Absent when none was ever seen. */
  lastActivityAt?: number;
  /** Epoch ms when it returned or ended, when it did. */
  endedAt?: number;
};

export type Liveness = "finished" | "running" | "stuck";

/**
 * a worker is stuck when it shows nothing new past its stuck-after time.
 * Judged by side effects only: the worker's own status text is never an input.
 * Silence runs from the last side effect, or from the start when there never was one.
 */
export const judgeWorker = (w: WorkerRecord, now: number, stuckAfterMs: number): Liveness => {
  if (w.endedAt !== undefined) return "finished";
  const since = Math.max(w.startedAt, w.lastActivityAt ?? w.startedAt);
  return now - since > stuckAfterMs ? "stuck" : "running";
};

/** What was observed of a worker: transcript size and the modification times of files in its tree. */
export type Probe = { transcriptBytes: number; fileMtimes: Record<string, number> };

/** True when nothing grew or changed since the last probe. */
export const showsNothingNew = (prev: Probe, now: Probe): boolean => {
  if (now.transcriptBytes > prev.transcriptBytes) return false;
  for (const [f, t] of Object.entries(now.fileMtimes)) if (prev.fileMtimes[f] === undefined || t > prev.fileMtimes[f]) return false;
  return true;
};

/** Ids of stuck workers; they are never reported as running, and their slices become gaps under K2. */
export const stuckWorkers = (ws: WorkerRecord[], now: number, stuckAfterMs: number): string[] => ws.filter((w) => judgeWorker(w, now, stuckAfterMs) === "stuck").map((w) => w.id);
