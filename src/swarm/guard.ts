// SPDX-License-Identifier: AGPL-3.0-only
import fs from "node:fs";
import path from "node:path";

/** What a worker or verifier session is, by the orchestrator that launched it. The orchestrator is the owner's own session and is never guarded. */
export type Role = "worker" | "verifier";

export type Context = {
  role: Role;
  /** The tree the session works in. Edits outside it are refused. */
  root: string;
  /** Files (relative to root) or folders (ending in /) a worker may write. A verifier may write none. */
  allow: string[];
  /** True while the owner's hold file exists: every write is refused. */
  hold: boolean;
};

export type Call = { tool: string; file?: string; command?: string; pattern?: string; path?: string };

export type Decision = { deny: false } | { deny: true; rule: string; reason: string };

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SEARCH_TOOLS = new Set(["Read", "Grep", "Glob"]);
const READ_ONLY_GIT = /^\s*git\s+(status|diff|log|show|rev-parse|ls-files|worktree\s+list)\b/;

const slashes = (s: string): string => s.replace(/\\/g, "/");

/** pstack, skills/swarm: "Give each worker its own writable output when it writes." A file is allowed when it is listed, or sits under a listed folder. */
export const inAllowed = (root: string, allow: string[], file: string): boolean => {
  const rel = slashes(path.relative(path.resolve(root), path.resolve(root, file)));
  if (rel === "" || rel.startsWith("../") || path.isAbsolute(rel)) return false;
  return allow.some((a) => (a.endsWith("/") ? rel.startsWith(a) : rel === a));
};

/** A command that cannot be undone, or that stages everything, or that finishes a worker's change by itself. */
const bashRule = (command: string, role: Role): { rule: string; reason: string } | null => {
  const c = slashes(command);
  if (/\.claude\/projects\b|\.claude\/ratchet\/sessions\b/.test(c)) return { rule: "other-projects-records", reason: "pstack's session-pickup: do not glob across the session records of other projects; that reads private chats from unrelated projects." };
  if (/\bgit\s+(-C\s+\S+\s+)?add\s+(-A\b|--all\b|\.(\s|$))/.test(c)) return { rule: "git-add-all", reason: "Stage only the files you changed: git add <files>, never -A, --all or a bare dot (pstack hillclimb)." };
  if (/\bgit\s+(-C\s+\S+\s+)?push\b/.test(c) || /\bgit\s+(-C\s+\S+\s+)?reset\s+--hard\b/.test(c) || /\bgit\s+(-C\s+\S+\s+)?clean\b/.test(c) || /\bgit\s+(-C\s+\S+\s+)?stash\b/.test(c) || /\bgit\s+(-C\s+\S+\s+)?checkout\s+(--\s|-f\b|\.)/.test(c) || /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/.test(c)) return { rule: "irreversible", reason: "An action that cannot be undone needs the owner's confirmation (pstack never-block-on-the-human: irreversible actions still require confirmation)." };
  if (role === "worker" && /\bgit\s+(-C\s+\S+\s+)?(commit|merge|rebase|cherry-pick|tag)\b/.test(c)) return { rule: "no-commit", reason: "A worker leaves its change uncommitted and hands over a patch; the rule is: commit or push only when the owner asks." };
  return null;
};

/** One tool call, one decision. Pure: the caller supplies what the world looks like. */
export const decide = (ctx: Context, call: Call): Decision => {
  const refuse = (rule: string, reason: string): Decision => ({ deny: true, rule, reason });
  if (EDIT_TOOLS.has(call.tool)) {
    if (ctx.hold) return refuse("hold", "The owner's hold is in force: every write by a worker is refused until it is lifted.");
    if (ctx.role === "verifier") return refuse("verifier-writes", "A verifier does not write: it runs the checks and reports. A verifier that edits has become an author.");
    if (!call.file) return refuse("file-set", "An edit with no file path cannot be matched to the files this worker may write.");
    if (!inAllowed(ctx.root, ctx.allow, call.file)) return refuse("file-set", `${slashes(call.file)} is outside the files this worker may write (${ctx.allow.join(", ")}). A rule, a limit or a check is never in that set.`);
    return { deny: false };
  }
  if (call.tool === "Bash") {
    const command = call.command ?? "";
    const hit = bashRule(command, ctx.role);
    if (hit) return refuse(hit.rule, hit.reason);
    if (ctx.hold && !READ_ONLY_GIT.test(command)) return refuse("hold", "The owner's hold is in force: only read-only git commands run until it is lifted.");
    return { deny: false };
  }
  if (SEARCH_TOOLS.has(call.tool)) {
    const target = slashes(`${call.file ?? ""} ${call.path ?? ""} ${call.pattern ?? ""}`);
    if (/\.claude\/projects\b|\.claude\/ratchet\/sessions\b/.test(target)) return refuse("other-projects-records", "Read only this workspace's records: another project's session folder holds private chats.");
  }
  return { deny: false };
};

/** The hook payload the CLI entry reads (PreToolUse), reduced to a Call. */
export const callOf = (payload: { tool_name?: string; tool_input?: { file_path?: string; command?: string; pattern?: string; path?: string; notebook_path?: string } }): Call => {
  const input = payload.tool_input ?? {};
  return { tool: payload.tool_name ?? "", file: input.file_path ?? input.notebook_path, command: input.command, pattern: input.pattern, path: input.path };
};

/** Read the context the orchestrator set for this session, from the environment. */
export const contextFromEnv = (env: Record<string, string | undefined>): Context | null => {
  const role = env.RATCHET_SWARM_ROLE;
  if (role !== "worker" && role !== "verifier") return null;
  const root = env.RATCHET_SWARM_ROOT ?? "";
  if (!root) return null;
  const holdFile = env.RATCHET_SWARM_HOLD;
  return { role, root, allow: (env.RATCHET_SWARM_ALLOW ?? "").split(";").filter(Boolean), hold: holdFile ? fs.existsSync(holdFile) : false };
};

/** Idempotent record: a hook run again for the same tool call (a retry, a replay) writes no second line. A call with no id is always written. */
export const alreadyLogged = (log: string, callId: string | undefined): boolean => {
  if (!callId) return false;
  try {
    return fs.readFileSync(log, "utf8").split("\n").some((l) => l.includes(`"call":${JSON.stringify(callId)}`));
  } catch {
    return false;
  }
};

/** PreToolUse hook entry. Prints the refusal as Claude Code reads it, and records it. */
export const runHook = (input: string, env: Record<string, string | undefined>): string => {
  const ctx = contextFromEnv(env);
  if (!ctx) return "";
  let payload: Parameters<typeof callOf>[0] & { agent_id?: string; session_id?: string; tool_use_id?: string };
  try {
    payload = JSON.parse(input) as typeof payload;
  } catch {
    return "";
  }
  const call = callOf(payload);
  const decision = decide(ctx, call);
  if (!decision.deny) return "";
  const log = env.RATCHET_SWARM_LOG;
  if (log && !alreadyLogged(log, payload.tool_use_id)) fs.appendFileSync(log, `${JSON.stringify({ time: new Date().toISOString(), role: ctx.role, session: payload.session_id, agent: payload.agent_id, call: payload.tool_use_id, tool: call.tool, rule: decision.rule, target: call.file ?? call.command ?? call.pattern ?? call.path })}\n`);
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Ratchet (${decision.rule}): ${decision.reason}` } });
};

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    input += chunk;
  });
  process.stdin.on("end", () => {
    const out = runHook(input, process.env);
    if (out) process.stdout.write(`${out}\n`);
  });
}
