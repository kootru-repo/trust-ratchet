// SPDX-License-Identifier: AGPL-3.0-only
import os from "node:os";
import { execFileSync } from "node:child_process";

/** What the machine looks like at the moment a worker is asked for. */
export type Machine = {
  /** Percent of RAM in use, 0 to 100. */
  ramPercent: number;
  /** Percent of CPU busy over a short sample, 0 to 100. */
  cpuPercent: number;
  /** Count of running claude and node processes, all projects. */
  processes: number;
  /** Count of this run's workers already running. */
  workers: number;
};

export type Limits = { maxRamPercent: number; maxCpuPercent: number; maxProcesses: number; maxWorkers: number };

/** The owner's limits: no start at RAM >= 90% (ram-guard-90), at most 3 workers while the machine is shared, a process ceiling (process-cap-12). */
export const DEFAULT_LIMITS: Limits = { maxRamPercent: 90, maxCpuPercent: 90, maxProcesses: 12, maxWorkers: 3 };

export type LaunchDecision = { start: true } | { start: false; reasons: string[] };

/**
 * before each worker starts, a program reads the load and refuses the launch over any limit.
 * The refusal is data (reasons) so the orchestrator records it; waiting is the caller's loop.
 */
export const decideLaunch = (m: Machine, limits: Limits = DEFAULT_LIMITS): LaunchDecision => {
  const reasons: string[] = [];
  if (m.ramPercent >= limits.maxRamPercent) reasons.push(`RAM is ${m.ramPercent.toFixed(1)}%, limit ${limits.maxRamPercent}%`);
  if (m.cpuPercent >= limits.maxCpuPercent) reasons.push(`CPU is ${m.cpuPercent.toFixed(1)}%, limit ${limits.maxCpuPercent}%`);
  if (m.processes >= limits.maxProcesses) reasons.push(`${m.processes} claude and node processes are running, limit ${limits.maxProcesses}`);
  if (m.workers >= limits.maxWorkers) reasons.push(`${m.workers} workers are running, limit ${limits.maxWorkers}`);
  return reasons.length === 0 ? { start: true } : { start: false, reasons };
};

/** Percent busy between two samples of os.cpus(). */
export const cpuPercent = (before: os.CpuInfo[], after: os.CpuInfo[]): number => {
  let idle = 0;
  let total = 0;
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    const beforeCore = before[i];
    const afterCore = after[i];
    if (!beforeCore || !afterCore) break;
    const b = beforeCore.times;
    const a = afterCore.times;
    total += a.user + a.nice + a.sys + a.idle + a.irq - (b.user + b.nice + b.sys + b.idle + b.irq);
    idle += a.idle - b.idle;
  }
  return total <= 0 ? 0 : (100 * (total - idle)) / total;
};

/** Count lines of a process listing (`tasklist /fo csv /nh` or `ps -eo comm`) whose image is claude or node. */
export const countProcesses = (listing: string): number =>
  listing.split(/\r?\n/).filter((l) => /^(claude|node)(\.exe)?$/i.test(imageName(l))).length;

const imageName = (line: string): string => {
  const t = line.trim();
  const first = t.startsWith('"') ? t.slice(1, t.indexOf('"', 1)) : t;
  return first.replace(/^.*[\\/]/, "");
};

const listProcesses = (): string =>
  process.platform === "win32" ? execFileSync("tasklist", ["/fo", "csv", "/nh"], { encoding: "utf8" }) : execFileSync("ps", ["-eo", "comm"], { encoding: "utf8" });

/** Reads the machine now. The only impure function here; sampleMs is the CPU sample window. */
export const readMachine = async (workers: number, sampleMs = 500): Promise<Machine> => {
  const before = os.cpus();
  await new Promise((r) => setTimeout(r, sampleMs));
  const after = os.cpus();
  return { ramPercent: (100 * (os.totalmem() - os.freemem())) / os.totalmem(), cpuPercent: cpuPercent(before, after), processes: countProcesses(listProcesses()), workers };
};
