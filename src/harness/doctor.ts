// SPDX-License-Identifier: AGPL-3.0-only
/**
 * A Doctor over injected probes. Ready means usable: the process is up, it is the
 * right version or build, the port is owned by the process we started, and a probe of the real user path works.
 * Every probe is injected, so the module names no project, tool or port.
 */

export type ProcessInfo = { pid: number; startedByUs: boolean };
export type PathResult = { ok: boolean; detail?: string };

export type DoctorProbes = {
  /** The process we expect to be running, or null when there is none. */
  process: () => Promise<ProcessInfo | null>;
  /** The version or build the running thing reports. */
  version: () => Promise<string>;
  /** The pid that owns the port, or null when nothing listens. */
  portOwner: (port: number) => Promise<number | null>;
  /** A probe of the real user path (what the user does), not a port answering. Required. */
  realPath: () => Promise<PathResult>;
};

export type DoctorConfig = { port: number; expectedVersion: string };
export type ReasonCode = "process-down" | "foreign-process" | "wrong-version" | "port-free" | "port-foreign" | "path-broken" | "probe-failed" | "no-real-path-probe";
export type Reason = { code: ReasonCode; message: string; fix: string };
export type Diagnosis = { ready: boolean; reasons: Reason[] };

type Outcome<T> = { ok: true; value: T } | { ok: false };

const guard = async <T>(name: string, run: () => Promise<T>, reasons: Reason[]): Promise<Outcome<T>> => {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    reasons.push({ code: "probe-failed", message: `the ${name} probe threw: ${e instanceof Error ? e.message : String(e)}`, fix: `Fix the ${name} probe or the thing it reads; no verdict is possible without it.` });
    return { ok: false };
  }
};

export const diagnose = async (probes: DoctorProbes, config: DoctorConfig): Promise<Diagnosis> => {
  const reasons: Reason[] = [];
  const proc = await guard("process", probes.process, reasons);
  const info = proc.ok ? proc.value : null;
  if (proc.ok && info === null) {
    reasons.push({ code: "process-down", message: "no process is running", fix: "Start it with the project's launch command, then run the Doctor again." });
  } else if (info && !info.startedByUs) {
    reasons.push({ code: "foreign-process", message: `process ${info.pid} was not started by this run`, fix: "Stop it by the process id this run holds, never by name, and start a fresh one." });
  }
  const version = await guard("version", probes.version, reasons);
  if (version.ok && version.value !== config.expectedVersion) {
    reasons.push({ code: "wrong-version", message: `version is ${version.value}, expected ${config.expectedVersion}`, fix: "Rebuild from this tree and restart, so the running build is this tree's own." });
  }
  const owner = await guard("port owner", () => probes.portOwner(config.port), reasons);
  if (owner.ok) {
    if (owner.value === null) reasons.push({ code: "port-free", message: `nothing listens on port ${config.port}`, fix: "Start the process and wait for it to listen." });
    else if (info && owner.value !== info.pid) reasons.push({ code: "port-foreign", message: `port ${config.port} is owned by ${owner.value}, not by our process ${info.pid}`, fix: "Free the port by the owner's process id if this run started it, otherwise pick another port." });
    else if (!info) reasons.push({ code: "port-foreign", message: `port ${config.port} is owned by ${owner.value}, which this run cannot show it started`, fix: "Start our own process on a free port." });
  }
  if (typeof probes.realPath !== "function") {
    reasons.push({ code: "no-real-path-probe", message: "no probe of the real user path was given", fix: "Give the Doctor a probe that does what the user does; a port answering is not ready." });
  } else {
    const path = await guard("real path", probes.realPath, reasons);
    if (path.ok && !path.value.ok) reasons.push({ code: "path-broken", message: `the real user path failed${path.value.detail ? `: ${path.value.detail}` : ""}`, fix: "Drive the path by hand, fix what breaks, and do not count a port that answers as ready." });
  }
  return { ready: reasons.length === 0, reasons };
};
