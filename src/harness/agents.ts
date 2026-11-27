// SPDX-License-Identifier: AGPL-3.0-only
import fs from "node:fs";
import type { Finding } from "./rules.ts";
import path from "node:path";
import { changedStamps, sessionDir } from "./session.ts";
import { slug } from "./state.ts";

/**
 * Who wrote what in a session, per repository (T1). A subagent's hook payloads carry the parent's session id plus
 * `agent_id`, so an edit with an `agent_id` is the subagent's and one without is the session's own. Writes that
 * reach no edit hook (a shell command) are found by comparing the changed files at SubagentStart and SubagentStop.
 *
 * Hooks run as separate processes at the same time, so the record is an append-only log of events, one JSON line
 * each, and the ledger is folded from it when read. No hook rewrites what another wrote.
 */
export type Stamp = { file: string; hash: string };
export type AgentEvent =
  | { kind: "edit"; at: number; file: string; agentId?: string; agentType?: string }
  | { kind: "start"; at: number; agentId: string; agentType?: string; changed: Stamp[] }
  | { kind: "stop"; at: number; agentId: string; changed: Stamp[] };

export type AgentEntry = {
  type?: string;
  /** Milliseconds since the epoch. */
  started: number;
  stopped?: number;
  /** The changed files and their stamps when the agent started, so its other writes can be found at its stop. */
  snapshot?: Record<string, string>;
  files: string[];
};
export type Ledger = { agents: Record<string, AgentEntry>; /** Files the session's own edits wrote, with the time of the last write. */ own: Record<string, number> };

const add = (list: string[], file: string): string[] => (list.includes(file) ? list : [...list, file]);

/** Pure: the ledger after one edit, by the agent named or by the session itself. */
export const withEdit = (ledger: Ledger, { file, agentId, agentType, now }: { file: string; agentId?: string; agentType?: string; now: number }): Ledger => {
  if (!agentId) return { ...ledger, own: { ...ledger.own, [file]: now } };
  // An edit logged after the agent's stop (the hooks run at the same time) adds its file and leaves it stopped.
  const before = ledger.agents[agentId];
  const entry = before ?? { started: now, files: [], ...(agentType ? { type: agentType } : {}) };
  return { ...ledger, agents: { ...ledger.agents, [agentId]: { ...entry, files: add(entry.files, file) } } };
};

/** Pure: the ledger when an agent starts, with the changed files as they are now. An id seen before starts afresh once it has stopped. */
export const withStart = (ledger: Ledger, { agentId, agentType, now, changed }: { agentId: string; agentType?: string; now: number; changed: Stamp[] }): Ledger => {
  const before = ledger.agents[agentId];
  const keep = before && before.stopped === undefined ? before : undefined;
  const snapshot = Object.fromEntries(changed.map((c) => [c.file, c.hash]));
  const type = agentType ?? keep?.type;
  return { ...ledger, agents: { ...ledger.agents, [agentId]: { files: keep?.files ?? [], started: keep?.started ?? now, snapshot, ...(type ? { type } : {}) } } };
};

/** An agent that never reported its stop is taken as stopped after this long. */
export const AGENT_EXPIRY_MS = 60 * 60 * 1000;

/** When an agent's window ends: its stop, or for one whose stop never came, the expiry. */
const windowEnd = (a: AgentEntry, until: number): number => a.stopped ?? Math.min(until, a.started + AGENT_EXPIRY_MS);
const overlaps = (a: AgentEntry, b: AgentEntry, until: number): boolean => a.started < windowEnd(b, until) && b.started < windowEnd(a, until);

/**
 * Pure: the files an agent changed by `now`: its own edits, plus what else changed since it started that the session
 * did not write itself in that time and no other agent edited. Those other writes (a shell command's) are given to
 * it only when no other agent ran at the same time; otherwise nobody can say whose they are, and they are left out.
 */
export const agentFiles = (agentId: string, ledger: Ledger, changed: Stamp[], now: number): string[] => {
  const entry = ledger.agents[agentId];
  if (!entry) return [];
  const files = [...entry.files];
  const others = Object.entries(ledger.agents).filter(([id]) => id !== agentId).map(([, a]) => a);
  if (!entry.snapshot || others.some((o) => overlaps(entry, o, now))) return files;
  const snapshot = entry.snapshot;
  for (const c of changed) {
    if (snapshot[c.file] === c.hash) continue;
    if ((ledger.own[c.file] ?? 0) >= entry.started) continue;
    if (others.some((o) => o.files.includes(c.file))) continue;
    if (!files.includes(c.file)) files.push(c.file);
  }
  return files;
};

/** Pure: the ledger when an agent stops: its files are fixed from what changed while it ran. */
export const withStop = (ledger: Ledger, { agentId, now, changed }: { agentId: string; now: number; changed: Stamp[] }): Ledger => {
  const entry = ledger.agents[agentId];
  if (!entry || entry.stopped !== undefined) return ledger;
  return { ...ledger, agents: { ...ledger.agents, [agentId]: { ...entry, files: agentFiles(agentId, ledger, changed, now), stopped: now } } };
};

const isStamps = (v: unknown): v is Stamp[] => Array.isArray(v) && v.every((s) => typeof s?.file === "string" && typeof s?.hash === "string");

/** Pure: one log line as an event, or null when it is not one (a torn or foreign line is skipped, never thrown on). */
export const parseEvent = (line: string): AgentEvent | null => {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const e = v as Record<string, unknown>;
  if (typeof e.at !== "number") return null;
  const agentType = typeof e.agentType === "string" ? { agentType: e.agentType } : {};
  if (e.kind === "edit" && typeof e.file === "string") return { kind: "edit", at: e.at, file: e.file, ...(typeof e.agentId === "string" ? { agentId: e.agentId } : {}), ...agentType };
  if ((e.kind === "start" || e.kind === "stop") && typeof e.agentId === "string" && isStamps(e.changed)) return e.kind === "start" ? { kind: "start", at: e.at, agentId: e.agentId, changed: e.changed, ...agentType } : { kind: "stop", at: e.at, agentId: e.agentId, changed: e.changed };
  return null;
};

/** Pure: the ledger from the log, in the order the events were written. */
export const fold = (events: AgentEvent[]): Ledger =>
  events.reduce<Ledger>((l, e) => {
    if (e.kind === "edit") return withEdit(l, { file: e.file, now: e.at, ...(e.agentId ? { agentId: e.agentId } : {}), ...(e.agentType ? { agentType: e.agentType } : {}) });
    if (e.kind === "start") return withStart(l, { agentId: e.agentId, now: e.at, changed: e.changed, ...(e.agentType ? { agentType: e.agentType } : {}) });
    return withStop(l, { agentId: e.agentId, now: e.at, changed: e.changed });
  }, { agents: {}, own: {} });

/** Pure: the agents of the ledger still running at `now`: started, not stopped, not expired. */
export const running = (ledger: Ledger, now: number, expiryMs = AGENT_EXPIRY_MS): [string, AgentEntry][] =>
  Object.entries(ledger.agents).filter(([, a]) => a.stopped === undefined && now - a.started < expiryMs);

const logFile = (sessionId: string, root: string): string => path.join(sessionDir(sessionId), `${slug(root)}.agents.jsonl`);

export const readLedger = (sessionId: string, root: string): Ledger => {
  let text = "";
  try {
    text = fs.readFileSync(logFile(sessionId, root), "utf8");
  } catch {
    return { agents: {}, own: {} };
  }
  return fold(text.split("\n").flatMap((l) => (l.trim() === "" ? [] : [parseEvent(l)].filter((e): e is AgentEvent => e !== null))));
};

/** One event, appended as a single line: concurrent hooks never overwrite each other. */
export const appendEvent = (sessionId: string, root: string, event: AgentEvent): void => {
  const file = logFile(sessionId, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
};

/** Hook side: record one edit. */
export const noteAgentEdit = ({ sessionId, root, file, agentId, agentType, now = Date.now() }: { sessionId: string; root: string; file: string; agentId?: string; agentType?: string; now?: number }): void =>
  appendEvent(sessionId, root, { kind: "edit", at: now, file, ...(agentId ? { agentId } : {}), ...(agentType ? { agentType } : {}) });

/** Hook side: an agent starts or stops, in each repository given. The changed files are stamped by size and time, not hashed. */
export const noteAgentEvent = ({ sessionId, roots, event, agentId, agentType, now = Date.now() }: { sessionId: string; roots: string[]; event: "start" | "stop"; agentId: string; agentType?: string; now?: number }): void => {
  for (const root of roots) {
    const changed = changedStamps(root);
    appendEvent(sessionId, root, event === "start" ? { kind: "start", at: now, agentId, changed, ...(agentType ? { agentType } : {}) } : { kind: "stop", at: now, agentId, changed });
  }
};

/** Pure: the path-like words of a check's output, with / for \ and without a leading ./ or trailing :line:col. */
export const pathsIn = (text: string): string[] =>
  [...text.replace(/\\/g, "/").matchAll(/[A-Za-z0-9_@.~/-]*[A-Za-z0-9_-]\.[A-Za-z0-9]+/g)].map((m) => m[0].replace(/^(\.\/)+/, ""));

/** Pure: does a printed path stand for this repository path: the same, or a whole-segment end of it (printed from a package folder)? */
export const samePath = (printed: string, file: string): boolean => printed === file || file.endsWith(`/${printed}`) || printed.endsWith(`/${file}`);

/**
 * Pure (A6): while a background agent of the session is still running, a blocking failure that names a file the agent
 * is editing, and no file of the session's own, is kept and reported as pending: it may be the agent's half-done work.
 * Everything else holds as before, and so does any failure whose output names no file at all. Only the finding's
 * file and its output are read, never its title, which repeats the command and every file passed to it.
 */
export const pendingForAgents = ({ findings, own, busy, running: anyRunning }: { findings: Finding[]; own: string[]; busy: string[]; running: boolean }): Finding[] => {
  if (!anyRunning || busy.length === 0) return findings;
  const shown = `${busy.slice(0, 8).join(", ")}${busy.length > 8 ? `, and ${busy.length - 8} more` : ""}`;
  return findings.map((f) => {
    if (!f.blocking) return f;
    const named = [...(f.file ? [f.file] : []), ...pathsIn(f.detail)];
    const names = (files: string[]): boolean => named.some((p) => files.some((x) => samePath(p, x)));
    if (!names(busy) || names(own)) return f;
    return { ...f, blocking: false, detail: `${f.detail}\n(Pending: a background agent of this session is still editing ${shown}. This failure names its files and none of this session's own, so it does not hold the turn while the agent runs. It is checked again at the next turn end, and holds if it is still pending with nothing changed.)` };
  });
};

/** Pure: the session's own files at a turn end: those its edits wrote, and every changed file that no agent's record claims. */
export const ownFiles = ({ ledger, changed, agentClaims }: { ledger: Ledger; changed: string[]; agentClaims: string[] }): string[] => [...new Set([...Object.keys(ledger.own), ...changed.filter((f) => !agentClaims.includes(f))])];
