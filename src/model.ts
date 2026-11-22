import { spawn } from "node:child_process";
import { subscriptionEnv } from "./subscription.ts";
import fs from "node:fs";
import path from "node:path";
import type { ModelFn, ToolUse } from "./types.ts";

/** Runs at most `limit` tasks at once. The machine is shared, so the default stays low. */
export const pool = (limit: number): (<T>(task: () => Promise<T>) => Promise<T>) => {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
};

type Event = { type?: unknown; message?: { content?: unknown }; result?: unknown; is_error?: unknown; num_turns?: unknown; usage?: unknown; duration_ms?: unknown };

/**
 * Pure: reads the command's event stream (one JSON object per line). Returns the final result object and every tool
 * call the reviewer made, in order.
 */
export const readStream = (out: string): { result: Event | null; tools: ToolUse[] } => {
  const tools: ToolUse[] = [];
  let result: Event | null = null;
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let e: Event;
    try {
      e = JSON.parse(line) as Event;
    } catch {
      continue;
    }
    if (e.type === "result") result = e;
    if (e.type !== "assistant" || !Array.isArray(e.message?.content)) continue;
    for (const part of e.message.content as { type?: unknown; name?: unknown; input?: Record<string, unknown> }[]) {
      if (part.type !== "tool_use" || typeof part.name !== "string") continue;
      const target = part.input?.file_path ?? part.input?.path ?? part.input?.pattern ?? "";
      tools.push({ name: part.name, target: typeof target === "string" ? target : "" });
    }
  }
  return { result, tools };
};

export type ClaudeOptions = {
  model: string;
  concurrency?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
  /** When set, every call is saved here: prompt, reply, tool calls, turns, token use. */
  transcriptDir?: string;
};

/**
 * A ModelFn backed by the local `claude` command in print mode. No API key: it uses the login the command already has.
 * The child runs in restricted mode with read-only tools: file tools are confined to the tree under review (tested: a read outside it is denied).
 */
export const claudeModel = ({ model, concurrency = 3, timeoutMs = 10 * 60_000, log = () => {}, transcriptDir }: ClaudeOptions): ModelFn => {
  const run = pool(concurrency);
  let serial = 0;
  const args = ["-p", "--restricted", "--model", model, "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--no-session-persistence", "--tools", "Read", "Grep", "Glob"];
  return ({ prompt, cwd, label, onTools }) =>
    run(
      () =>
        new Promise<string>((resolve, reject) => {
          const started = Date.now();
          // shell: true is needed on Windows, where the command is a .cmd shim. Every argument is a constant; the prompt goes in on stdin.
          // RATCHET_CHILD: the coding harness's hooks say nothing inside Ratchet's own reviewers.
          const child = spawn("claude", args, { cwd, shell: true, windowsHide: true, env: { ...subscriptionEnv(process.env), RATCHET_CHILD: "1" } });
          let out = "";
          let err = "";
          const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`timed out after ${timeoutMs / 1000}s`));
          }, timeoutMs);
          child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
          child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
          child.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
          });
          child.on("close", (code) => {
            clearTimeout(timer);
            log(`${label}: ${Math.round((Date.now() - started) / 1000)}s, exit ${code}`);
            if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(-300) || out.slice(-300)}`));
            try {
              const { result: parsed, tools } = readStream(out);
              if (parsed === null) throw new Error("no result");
              onTools?.(tools);
              if (transcriptDir) {
                fs.mkdirSync(transcriptDir, { recursive: true });
                serial += 1;
                const name = `${String(serial).padStart(4, "0")}-${label.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80)}.json`;
                fs.writeFileSync(path.join(transcriptDir, name), JSON.stringify({ label, model, cwd, prompt, reply: parsed.result, tools, turns: parsed.num_turns, usage: parsed.usage, durationMs: parsed.duration_ms }, null, 2));
              }
              if (parsed.is_error === true || typeof parsed.result !== "string") return reject(new Error(`claude reported an error: ${out.slice(0, 300)}`));
              resolve(parsed.result);
            } catch {
              reject(new Error(`claude output was not JSON: ${out.slice(0, 300)}`));
            }
          });
          child.stdin.end(prompt);
        }),
    );
};
