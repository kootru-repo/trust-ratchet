// SPDX-License-Identifier: AGPL-3.0-only
import { offUnseen } from "./insight.ts";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { looksLikeCorrection, noteCorrection } from "./corrections.ts";
import { renderFindings, type Finding } from "./rules.ts";
import { ensureBaseline, readTurn, relTo, repoRoot, sessionBaselines, sweepSessions, writeTurn } from "./session.ts";
import { allOff, effective, logLine, projectDir, readConfig, readJson, readState, writeJson, type State } from "./state.ts";
import { fileFindings, readRules, runTurn, writeRecord } from "./turn.ts";
import { STOP_MARGIN_S, STOP_TIMEOUT_S, skipCause } from "./limits.ts";

/** What Claude Code sends a hook on stdin. Only the fields the harness reads. */
export type Payload = {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  /** UserPromptSubmit: what the person typed. */
  prompt?: string;
  source?: string;
  tool_name?: string;
  tool_input?: { file_path?: string };
  stop_hook_active?: boolean;
};

export const MAX_HOLDS = 2;

/** What the autonomous loop did since a session was last told. Read here, not through auto.ts, so the hook stays light. */
const loopNotes = (root: string): string => {
  try {
    const dir = projectDir(root);
    const text = fs.readFileSync(path.join(dir, "auto-notes.md"), "utf8");
    const seen = Number(readJson<{ seen?: number }>(path.join(dir, "auto-seen.json"), {}).seen ?? 0);
    if (text.length <= seen) return "";
    writeJson(path.join(dir, "auto-seen.json"), { seen: text.length });
    return text.slice(seen).trim().slice(0, 4000);
  } catch {
    return "";
  }
};

/** Tells the loop's ledger which rules fire on a file right after an edit of it. This is how a fix made before the turn ends is seen. */
const noteEdit = ({ root, sessionId, file, findings }: { root: string; sessionId: string; file: string; findings: Finding[] }): void => {
  try {
    if (!readConfig(root).auto) return;
    const rules = findings.flatMap((f) => (f.kind === "rule" ? [/^rule ([a-z0-9-]+)/.exec(f.title)?.[1] ?? ""] : [])).filter(Boolean);
    fs.appendFileSync(path.join(projectDir(root), "events.jsonl"), `${JSON.stringify({ time: new Date().toISOString(), sessionId, file, rules })}\n`);
  } catch {
    // the ledger misses one edit; the check itself is not touched
  }
};

/**
 * Starts one pass of the autonomous loop in its own process and returns at once. The hook's answer never waits
 * for it and never depends on it: a fault here is logged and nothing else changes. The child runs with
 * RATCHET_CHILD=1, so nothing it starts can call the harness again.
 */
const startLoop = (root: string): void => {
  try {
    if (!readConfig(root).auto) return;
    // No new process when memory is short. The pass that is skipped is made up by the next one.
    if (1 - os.freemem() / os.totalmem() >= 0.9) return;
    const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.ts");
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", cli, "auto", "--project", root, "--quiet"], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, RATCHET_CHILD: "1" } });
    child.on("error", (e) => logLine("errors.log", `loop, ${root}: ${e.message}`));
    child.unref();
  } catch (e) {
    logLine("errors.log", `loop, ${root}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
};

const shorten = (value: unknown): unknown => {
  if (typeof value === "string") return value.length > 200 ? `${value.slice(0, 200)}... (${value.length} chars)` : value;
  if (Array.isArray(value)) return value.slice(0, 10).map(shorten);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shorten(v)]));
  return value;
};

const editedFile = (payload: Payload): { root: string; file: string } | null => {
  const raw = payload.tool_input?.file_path;
  if (typeof raw !== "string" || raw === "") return null;
  const abs = path.resolve(payload.cwd ?? process.cwd(), raw);
  const root = repoRoot(abs);
  return root ? { root, file: relTo(root, abs) } : null;
};

const sessionStart = (state: State, payload: Payload, sessionId: string): object | null => {
  sweepSessions(14);
  const root = repoRoot(payload.cwd ?? process.cwd());
  if (!root) return null;
  const { enabled, mode } = effective(state, root);
  if (!enabled) return null;
  ensureBaseline(sessionId, root);
  const rules = readRules(root);
  const config = readConfig(root);
  const commands = [...(config.checks ?? []), ...(config.tests ?? []), ...(config.drivers ?? [])].map((c) => c.name);
  const note = [
    `Ratchet harness is on for ${root} (mode: ${mode}).`,
    `After each file edit, programs check that the file parses, the project's rules (${rules.length === 0 ? "none yet" : rules.map((r) => r.id).join(", ")}) and that no escape hatch was added. What they find comes back to you as facts, each with its fix.`,
    `Before your turn ends, the same checks run on every file this session changed${commands.length > 0 ? `, then: ${commands.join(", ")}` : ""}. ${mode === "enforce" ? `A failure that is this session's holds the turn, at most ${MAX_HOLDS} times.` : "Failures are reported, nothing is held."}`,
    "These are program results, not opinions. Fix the cause; do not switch a check off.",
    ...((line) => (line ? [line] : []))(offUnseen(root)),
    ...(config.auto ? ["The harness also works by itself after each checked turn: it writes a trial rule from a fix commit, maps a new test once it has passed alone, lowers backlogs, and records its verification level. It only tightens, and it tells you here what it changed."] : []),
    ...((): string[] => {
      const learned = loopNotes(root);
      return learned ? [`Since the last session the harness changed or noted:\n${learned}`] : [];
    })(),
  ].join("\n");
  return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: note } };
};

const preEdit = (state: State, payload: Payload, sessionId: string): null => {
  const target = editedFile(payload);
  if (target && effective(state, target.root).enabled) ensureBaseline(sessionId, target.root);
  return null;
};

const postEdit = (state: State, payload: Payload, sessionId: string): object | null => {
  const target = editedFile(payload);
  if (!target) return null;
  const { enabled, mode } = effective(state, target.root);
  if (!enabled) return null;
  const { baseline } = ensureBaseline(sessionId, target.root);
  const { findings } = fileFindings({ baseline, file: target.file, rules: readRules(target.root), comments: readConfig(target.root).comments });
  noteEdit({ root: target.root, sessionId, file: target.file, findings });
  if (findings.length === 0) return null;
  const text = renderFindings({ findings, heading: `Ratchet: ${findings.length} fact${findings.length === 1 ? "" : "s"} from programs about the file you just edited.` });
  // A finding that may not hold a turn (a rule on trial) is told, never used to block.
  return mode === "enforce" && findings.some((f) => f.blocking) ? { decision: "block", reason: text } : { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } };
};

const stop = (state: State, sessionId: string): object | null => {
  const holdTexts: string[] = [];
  const notes: string[] = [];
  // One Stop, one deadline: every repository the session touched is checked under the hook's single timeout.
  const stopDeadline = Date.now() + (STOP_TIMEOUT_S - STOP_MARGIN_S) * 1000;
  for (const baseline of sessionBaselines(sessionId)) {
    const { enabled, mode } = effective(state, baseline.root);
    if (!enabled) continue;
    let result: ReturnType<typeof runTurn>;
    try {
      result = runTurn({ sessionId, baseline, stopDeadline });
    } catch (e) {
      // One repository that cannot be checked (deleted, locked) must not silence the others.
      logLine("errors.log", `Stop, ${baseline.root}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      continue;
    }
    if (result === null || result.repeated) continue;
    const blocking: Finding[] = result.findings.filter((f) => f.blocking);
    const turn = readTurn(sessionId, baseline.root);
    const held = mode === "enforce" && blocking.length > 0 && turn.holds < MAX_HOLDS;
    turn.holds = held ? turn.holds + 1 : 0;
    writeTurn(sessionId, baseline.root, turn);
    const record = writeRecord({ result, sessionId, mode, held });
    // The loop reads the record just written. It is started when the turn is let go, not while it is held.
    if (!held) startLoop(baseline.root);
    const ran = `${result.changed.length} changed file${result.changed.length === 1 ? "" : "s"}, ${result.outcomes.length} command${result.outcomes.length === 1 ? "" : "s"}`;
    if (held) {
      holdTexts.push(renderFindings({ findings: blocking, heading: `Ratchet: the turn checks fail in ${baseline.root} (${ran}; hold ${turn.holds} of ${MAX_HOLDS}). Fix these before ending the turn, or tell the user plainly why one cannot be fixed.` }));
    } else if (result.findings.length > 0) {
      notes.push(`Ratchet, ${baseline.root}: ${blocking.length} failing, ${result.findings.length - blocking.length} noted (${ran}). ${mode === "enforce" && blocking.length > 0 ? `The turn ends with the failures stated after ${MAX_HOLDS} holds. ` : ""}Record: ${record}\n${renderFindings({ findings: result.findings, heading: "" }).trim()}`);
    } else {
      const left = result.outcomes.filter((o) => ["count", "budget"].includes(skipCause(o) ?? "")).length;
      const could = result.notRun.length - left;
      notes.push(`Ratchet, ${baseline.root}: nothing failed (${ran}${left > 0 ? `; left for the next turn end by the limits: ${left}` : ""}${could > 0 ? `; could not run: ${could}` : ""}).`);
    }
  }
  if (holdTexts.length > 0) return { decision: "block", reason: holdTexts.join("\n\n") };
  return notes.length > 0 ? { systemMessage: notes.join("\n") } : null;
};

/**
 * A prompt that reads like a correction: keep where the repository stands, so the loop can read what the session
 * then changes as a fix. It answers nothing, ever: what a prompt hook prints goes into the conversation, and a
 * block would erase the prompt.
 */
const promptSubmit = (state: State, payload: Payload, sessionId: string): null => {
  try {
    const text = typeof payload.prompt === "string" ? payload.prompt : "";
    if (!looksLikeCorrection(text)) return null;
    const root = repoRoot(payload.cwd ?? process.cwd());
    if (!root || !effective(state, root).enabled || !readConfig(root).auto) return null;
    noteCorrection({ root, sessionId, prompt: text });
  } catch (e) {
    logLine("errors.log", `prompt: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
  return null;
};

/** One hook call. Returns what to print for Claude Code, or null for nothing. */
export const handle = (event: string, payload: Payload): object | null => {
  if (process.env.RATCHET_CHILD === "1") return null;
  const state = readState();
  if (state.debug) logLine("payloads.jsonl", JSON.stringify({ event, payload: shorten(payload) }));
  if (allOff(state)) return null;
  const sessionId = payload.session_id ?? "unknown";
  if (event === "SessionStart") return sessionStart(state, payload, sessionId);
  if (event === "PreToolUse") return preEdit(state, payload, sessionId);
  if (event === "PostToolUse") return postEdit(state, payload, sessionId);
  if (event === "Stop") return stop(state, sessionId);
  if (event === "UserPromptSubmit") return promptSubmit(state, payload, sessionId);
  return null;
};

const readStdin = async (): Promise<string> => {
  if (process.stdin.isTTY) return "";
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
};

/** The process entry. Any fault inside the harness is logged and the hook says nothing: it fails open. */
export const main = async (event: string): Promise<void> => {
  const started = Date.now();
  try {
    const raw = await readStdin();
    const payload = raw.trim() === "" ? {} : (JSON.parse(raw) as Payload);
    const out = handle(event, payload);
    if (out !== null) process.stdout.write(JSON.stringify(out));
    if (out !== null || Date.now() - started > 1500) logLine("hook.log", `${event} ${Date.now() - started}ms ${out === null ? "silent" : Object.keys(out).join(",")}`);
  } catch (e) {
    logLine("errors.log", `${event}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  }
};
