// SPDX-License-Identifier: AGPL-3.0-only
import { STOP_TIMEOUT_S } from "./limits.ts";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { home, readJson, writeJson, writeText } from "./state.ts";

/** Every hook entry the harness owns carries this argument. Uninstall removes exactly the entries that have it. */
export const MARK = "--ratchet-hook";

type HookCmd = { type?: string; command?: string; args?: string[]; timeout?: number; [k: string]: unknown };
type HookGroup = { matcher?: string; hooks?: HookCmd[]; [k: string]: unknown };
export type Settings = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

export const EVENTS: { event: string; matcher?: string; timeout: number }[] = [
  { event: "SessionStart", timeout: 30 },
  { event: "PreToolUse", matcher: "Edit|Write|MultiEdit", timeout: 30 },
  { event: "PostToolUse", matcher: "Edit|Write|MultiEdit", timeout: 30 },
  // Above the default 120 s budget of the turn checks, so Claude Code never cuts the harness off mid-record.
  { event: "Stop", timeout: STOP_TIMEOUT_S },
  // Reads one prompt, may copy a few files, prints nothing. A short limit: a prompt must never wait on the harness.
  { event: "UserPromptSubmit", timeout: 10 },
];

const isOurs = (h: HookCmd): boolean => Array.isArray(h.args) && h.args.includes(MARK);

/** Pure: the settings with the harness's entries taken out and nothing else touched. */
export const removeHooks = (settings: Settings): Settings => {
  if (!settings.hooks) return settings;
  const hooks: Record<string, HookGroup[]> = {};
  let touched = false;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept: HookGroup[] = [];
    for (const group of groups) {
      const mine = (group.hooks ?? []).some(isOurs);
      if (!mine) {
        kept.push(group);
        continue;
      }
      touched = true;
      const rest = (group.hooks ?? []).filter((h) => !isOurs(h));
      if (rest.length > 0) kept.push({ ...group, hooks: rest });
    }
    if (kept.length > 0) hooks[event] = kept;
  }
  if (!touched) return settings;
  const { hooks: _dropped, ...rest } = settings;
  return Object.keys(hooks).length > 0 ? insertAt(settings, "hooks", hooks) : rest;
};

/** Keeps a key where it stood, so the file's order does not change. */
const insertAt = (settings: Settings, key: string, value: unknown): Settings => Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, k === key ? value : v]));

/** Pure: the settings with the harness's five entries added after whatever is there. Running it twice changes nothing more. */
export const addHooks = ({ settings, node, entry }: { settings: Settings; node: string; entry: string }): Settings => {
  const clean = removeHooks(settings);
  const hooks: Record<string, HookGroup[]> = { ...(clean.hooks ?? {}) };
  for (const { event, matcher, timeout } of EVENTS) {
    const group: HookGroup = { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: node, args: ["--experimental-strip-types", "--no-warnings", entry, event, MARK], timeout }] };
    hooks[event] = [...(hooks[event] ?? []), group];
  }
  return "hooks" in clean ? insertAt(clean, "hooks", hooks) : { ...clean, hooks };
};

/** Pure: JSON in the layout the file already had (indent, line ends, last newline). */
export const formatLike = (original: string, value: unknown): string => {
  const indent = /^\{\r?\n([ \t]+)"/.exec(original)?.[1] ?? "  ";
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const tail = /(\r?\n)*$/.exec(original)?.[0] ?? "";
  return JSON.stringify(value, null, indent).split("\n").join(eol) + (original === "" ? "\n" : tail);
};

export const settingsPath = (): string => process.env.RATCHET_SETTINGS ?? path.join(os.homedir(), ".claude", "settings.json");
const fwd = (p: string): string => p.split(path.sep).join("/");
const stamp = (): string => new Date().toISOString().replace(/[:.]/g, "-");

const ENTRY = `import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Written by "ratchet install". Loads the installed copy of the harness and never fails the session it runs in.
const dir = import.meta.dirname;
try {
  if (process.env.RATCHET_CHILD !== "1") {
    const current = JSON.parse(fs.readFileSync(path.join(dir, "current.json"), "utf8")) as { dir: string };
    const mod = (await import(pathToFileURL(path.join(current.dir, "src", "harness", "hook.ts")).href)) as { main: (event: string) => Promise<void> };
    await mod.main(process.argv[2] ?? "");
  }
} catch (e) {
  try {
    fs.mkdirSync(path.join(dir, "..", "log"), { recursive: true });
    fs.appendFileSync(path.join(dir, "..", "log", "errors.log"), new Date().toISOString() + " entry: " + String(e) + "\\n");
  } catch {
    // Nothing more can be done, and the session must go on.
  }
}
`;

const CLI = `import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Written by "ratchet install". Runs the installed copy's command line.
const current = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "current.json"), "utf8")) as { dir: string };
await import(pathToFileURL(path.join(current.dir, "src", "cli.ts")).href);
`;

const slashCommand = (cli: string): string => `---
description: "Ratchet coding harness: on, off, status, init, rule, census, hatches, measure, review-work"
argument-hint: "status | on | off | on --project . | init | rule add ... | census | hatches | measure | review-work"
---
Run this with the Bash tool from the current folder, then report its output in a few lines:

node --experimental-strip-types --no-warnings "${cli}" $ARGUMENTS

With no arguments, run it with \`status\`. \`on\` and \`off\` alone are the global switch for every project; with \`--project .\` they switch this repository only. \`review-work\` starts model calls and can take minutes: say so before running it.
`;

export type InstallResult = { settings: string; backup: string | null; app: string; entry: string; cli: string; command: string; changed: boolean };

/**
 * Copies the harness under its home, proves the copy starts, then adds the five hook entries to the settings file.
 * The hooks run the copy, never the repository, so an edit to Ratchet cannot break a running session.
 */
export const install = ({ source }: { source: string }): InstallResult => {
  const appRoot = path.join(home(), "app");
  if (path.resolve(source).startsWith(path.resolve(appRoot))) throw new Error("run install from the Ratchet repository, not from the installed copy");
  const version = path.join(appRoot, `v-${stamp()}`);
  fs.mkdirSync(version, { recursive: true });
  fs.cpSync(path.join(source, "src"), path.join(version, "src"), { recursive: true });
  writeText(path.join(appRoot, "package.json"), `${JSON.stringify({ name: "ratchet-installed", private: true, type: "module" }, null, 2)}\n`);
  const entry = path.join(appRoot, "entry.ts");
  const cli = path.join(appRoot, "ratchet.ts");
  writeText(entry, ENTRY);
  writeText(cli, CLI);

  // Prove the new copy loads and runs before anything points at it.
  const previous = readJson<{ dir: string } | null>(path.join(appRoot, "current.json"), null);
  const probe = path.join(version, "probe");
  fs.mkdirSync(probe, { recursive: true });
  fs.cpSync(entry, path.join(probe, "entry.ts"));
  writeJson(path.join(probe, "current.json"), { dir: version });
  writeText(path.join(probe, "package.json"), '{"type":"module"}\n');
  const probeHome = path.join(version, "probe-home");
  execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", path.join(probe, "entry.ts"), "SessionStart", MARK], { input: JSON.stringify({ session_id: "install-probe", cwd: os.tmpdir() }), env: { ...process.env, RATCHET_HOME: probeHome, RATCHET_CHILD: "" }, timeout: 30_000, stdio: ["pipe", "pipe", "pipe"] });
  const faults = [path.join(version, "log", "errors.log"), path.join(probeHome, "log", "errors.log")].filter((f) => fs.existsSync(f));
  if (faults.length > 0) {
    const text = fs.readFileSync(faults[0] as string, "utf8").slice(0, 600);
    fs.rmSync(version, { recursive: true, force: true });
    throw new Error(`the copied harness does not start, nothing was installed: ${text}`);
  }
  fs.rmSync(probe, { recursive: true, force: true });
  fs.rmSync(probeHome, { recursive: true, force: true });
  writeJson(path.join(appRoot, "current.json"), { dir: version });
  for (const name of fs.readdirSync(appRoot)) {
    const p = path.join(appRoot, name);
    if (name.startsWith("v-") && p !== version && p !== previous?.dir) fs.rmSync(p, { recursive: true, force: true });
  }

  const file = settingsPath();
  const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const settings = original.trim() === "" ? {} : (JSON.parse(original) as Settings);
  const next = formatLike(original, addHooks({ settings, node: fwd(process.execPath), entry: fwd(entry) }));
  let backup: string | null = null;
  if (next !== original) {
    if (original !== "") {
      backup = path.join(home(), "backup", `settings-${stamp()}.json`);
      writeText(backup, original);
    }
    writeText(file, next);
  }
  writeText(path.join(path.dirname(file), "commands", "ratchet.md"), slashCommand(fwd(cli)));
  const command = path.join(home(), "ratchet.cmd");
  writeText(command, `@echo off\r\n"${process.execPath}" --experimental-strip-types --no-warnings "%~dp0app\\ratchet.ts" %*\r\n`);
  return { settings: file, backup, app: version, entry, cli, command, changed: next !== original };
};

/** Takes the harness's entries out of the settings file and removes the slash command. State, rules and records stay. */
export const uninstall = (): { settings: string; backup: string | null; changed: boolean } => {
  const file = settingsPath();
  const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (original.trim() === "") return { settings: file, backup: null, changed: false };
  const next = formatLike(original, removeHooks(JSON.parse(original) as Settings));
  let backup: string | null = null;
  if (next !== original) {
    backup = path.join(home(), "backup", `settings-${stamp()}.json`);
    writeText(backup, original);
    writeText(file, next);
  }
  fs.rmSync(path.join(path.dirname(file), "commands", "ratchet.md"), { force: true });
  return { settings: file, backup, changed: next !== original };
};

export const installed = (): { hooks: string[]; app: string | null } => {
  const settings = readJson<Settings>(settingsPath(), {});
  const hooks = Object.entries(settings.hooks ?? {}).flatMap(([event, groups]) => (groups.some((g) => (g.hooks ?? []).some(isOurs)) ? [event] : []));
  const current = readJson<{ dir: string } | null>(path.join(home(), "app", "current.json"), null);
  return { hooks, app: current && fs.existsSync(current.dir) ? current.dir : null };
};
