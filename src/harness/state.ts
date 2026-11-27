// SPDX-License-Identifier: AGPL-3.0-only
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Everything the harness keeps lives here, outside every repository. RATCHET_HOME moves it (tests, probes). */
export const home = (): string => process.env.RATCHET_HOME ?? path.join(os.homedir(), ".claude", "ratchet");

export type Mode = "advise" | "enforce";
export type Switch = { enabled?: boolean; mode?: Mode; /** When the switch was last turned on. `measure` splits outcomes at this date. */ since?: string };
/** `projects` is keyed by the normalised root, so one small file answers "is the harness on here" with no git call. */
export type State = { enabled: boolean; mode: Mode; debug?: boolean; since?: string; projects: Record<string, Switch> };

export type CheckCmd = { name: string; command: string; when?: string[]; onlyChanged?: boolean; timeoutS?: number; /** "auto": mapped by the autonomous loop, which may unmap it again. */ origin?: "auto"; /** "trial": a failure is reported and never holds the turn. */ stage?: "trial"; /** builtin:generated: the build, with {out} for the folder it writes into. */ build?: string; /** builtin:generated: the committed folder its output must match. */ into?: string };
import type { CommentsConfig } from "./comments.ts";

export type ProjectConfig = {
  /** The no-comments constraint: off (default), excuses or ban. See comments.ts. */
  comments?: CommentsConfig;
  /** Layer 2: commands run before the turn ends. {files} is replaced by the changed files that match `when`. */
  checks?: CheckCmd[];
  /** Layer 3: the one relevant test for a set of files. Never a whole suite. */
  tests?: CheckCmd[];
  /** Layer 3: commands that run the real thing. */
  drivers?: CheckCmd[];
  budgetS?: { stop?: number };
  /** The most mapped tests one turn end may run (default 3). The rest are "not run": a wide change must not become the whole suite. */
  maxTestsPerStop?: number;
  /** The loop's own turn-end limits, kept apart from a person's: the larger of the two is used, and taking this out is the undo. */
  autoLimits?: { tests?: number; budgetS?: number };
  /** The loop may move its own turn-end limits. Off until the project's replay is recorded. */
  autoLimitsOn?: boolean;
  /** The lesson card's log: each pass of the loop keeps one line of the card's numbers, chat corrections are counted by outcome, and a record shown by command is noted. Off unless set. */
  lessonsLog?: boolean;
  /** The autonomous loop runs after each checked turn: it learns rules and tests, keeps a ledger, promotes and retires its own items, and assesses the level. */
  auto?: boolean;
  /** Globs the loop never proposes a rule for and never maps or runs a test in. */
  autoExclude?: string[];
  /** The command the loop runs a new test with, per language (ts also covers .test.mjs and .test.js), with {test} for the file. No template: no test of that language is mapped. */
  autoTest?: { py?: string; ts?: string };
  /** The loop may ask a model for a regression test of a fix and keep it when a program saw it fail before the fix and pass after. One model call a pass. Off unless set. */
  autoGuards?: boolean;
  /** The project forbids running all its mapped commands at once: no baseline run is ever started here. */
  noFullRuns?: boolean;
  /** Folders that are not this project's own code (vendored, pinned). They do not count for or against coverage. */
  notOurs?: string[];
  /** The most escape hatches the repository may hold. It may be lowered, never raised by the harness. */
  hatchCeiling?: number;
};

export const readJson = <T>(file: string, fallback: T): T => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
};

/** Writes through a temporary file and a rename, so a reader never sees half a file. */
export const writeText = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
};
export const writeJson = (file: string, value: unknown): void => writeText(file, `${JSON.stringify(value, null, 2)}\n`);

/**
 * A linked git worktree is the same project as its main repository (without this a worker in a worktree
 * ran with no project rules, checks or switch). A linked worktree has a `.git` file reading `gitdir: <main>/.git/worktrees/<name>`;
 * the main repository is the folder that holds that `.git`. Anything else (a normal repository, no repository) is returned as given.
 */
export const mainOfWorktree = (root: string): string => {
  try {
    const dotGit = path.join(root, ".git");
    if (!fs.statSync(dotGit).isFile()) return root;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, "utf8"));
    if (!m) return root;
    const gitdir = path.resolve(root, m[1] as string);
    const parts = gitdir.split(path.sep);
    const at = parts.lastIndexOf("worktrees");
    if (at < 2 || parts[at - 1] !== ".git") return root;
    return parts.slice(0, at - 1).join(path.sep) || root;
  } catch {
    return root;
  }
};

/** One spelling per folder: forward slashes, no trailing slash, lower case on Windows. */
export const normRoot = (root: string): string => {
  const p = path.resolve(mainOfWorktree(root)).split(path.sep).join("/").replace(/\/+$/, "");
  return process.platform === "win32" ? p.toLowerCase() : p;
};
export const slug = (root: string): string => normRoot(root).replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "");

const stateFile = (): string => path.join(home(), "state.json");
export const readState = (): State => ({ enabled: false, mode: "advise", projects: {}, ...readJson<Partial<State>>(stateFile(), {}) });
export const writeState = (state: State): void => writeJson(stateFile(), state);

/** True when no project and no global switch is on: the hook can leave at once. */
export const allOff = (state: State): boolean => !state.enabled && !Object.values(state.projects).some((p) => p.enabled === true);

/** The project's own switch wins over the global one, in both directions. */
export const effective = (state: State, root: string): { enabled: boolean; mode: Mode } => {
  const own = state.projects[normRoot(root)] ?? {};
  return { enabled: own.enabled ?? state.enabled, mode: own.mode ?? state.mode };
};

export const setSwitch = ({ root, enabled, mode }: { root?: string; enabled?: boolean; mode?: Mode }): State => {
  const state = readState();
  if (root === undefined) {
    if (enabled === true && !state.enabled) state.since = new Date().toISOString();
    if (enabled !== undefined) state.enabled = enabled;
    if (mode !== undefined) state.mode = mode;
  } else {
    const own = { ...(state.projects[normRoot(root)] ?? {}) };
    if (enabled === true && own.enabled !== true) own.since = new Date().toISOString();
    if (enabled !== undefined) own.enabled = enabled;
    if (mode !== undefined) own.mode = mode;
    state.projects[normRoot(root)] = own;
  }
  writeState(state);
  return state;
};

/** Drops a project's own switch, so it follows the global one again. */
export const clearSwitch = (root: string): State => {
  const state = readState();
  delete state.projects[normRoot(root)];
  writeState(state);
  return state;
};

export const projectDir = (root: string): string => path.join(home(), "projects", slug(root));

/** Where a project file is read from: `.ratchet/` in the repository when it holds the file, else the harness home. */
export const projectFile = (root: string, name: string): string => {
  const inRepo = path.join(root, ".ratchet", name);
  return fs.existsSync(inRepo) ? inRepo : path.join(projectDir(root), name);
};

export const readConfig = (root: string): ProjectConfig => readJson<ProjectConfig>(projectFile(root, "config.json"), {});

export const logLine = (name: string, line: string): void => {
  try {
    const file = path.join(home(), "log", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // The log is a convenience. A harness that cannot log still must not fail the session.
  }
};
