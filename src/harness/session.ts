import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { findHatches } from "./rules.ts";
import { findComments } from "./comments.ts";
import { home, readJson, slug, writeJson } from "./state.ts";

const git = (root: string, args: string[]): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 20_000 });

/** The repository a file or folder belongs to, or null when it is in none. */
export const repoRoot = (fileOrDir: string): string | null => {
  let dir = path.resolve(fileOrDir);
  try {
    if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir);
  } catch {
    dir = path.dirname(dir);
  }
  while (!fs.existsSync(dir)) {
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  try {
    return path.resolve(git(dir, ["rev-parse", "--show-toplevel"]).trim());
  } catch {
    return null;
  }
};

export const relTo = (root: string, file: string): string => path.relative(root, path.resolve(file)).split(path.sep).join("/");

/** Pure: the paths in `git status --porcelain -z` output. A rename gives its new path; the old one is skipped. */
export const statusPaths = (out: string): string[] => {
  const parts = out.split("\0");
  const files: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i] as string;
    if (entry.length < 4) continue;
    files.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") i += 1;
  }
  return files;
};

const MAX_BYTES = 2 * 1024 * 1024;
const hashOf = (file: string): string | null => {
  try {
    const size = fs.statSync(file).size;
    if (size > MAX_BYTES) return `size:${size}`;
    return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
};

/** Text of a file, or null when it is missing, large or binary. */
export const readSource = (file: string): string | null => {
  try {
    if (fs.statSync(file).size > MAX_BYTES) return null;
    const buf = fs.readFileSync(file);
    return buf.includes(0) ? null : buf.toString("utf8");
  } catch {
    return null;
  }
};

/**
 * What a repository looked like before the session touched it. The session's change is what differs from this,
 * so work that was already there is never held against the session.
 */
export type Baseline = {
  root: string;
  head: string | null;
  taken: string;
  /** True when nothing was changed or untracked at the baseline. */
  clean: boolean;
  /** Files already changed at the baseline: their content hash (null: deleted) and the escape hatch lines they held. */
  dirty: Record<string, { hash: string | null; hatches: string[]; /** The text of each comment it held. Absent in a baseline taken before the comment check existed: then nothing is charged. */ comments?: string[] }>;
};

const headOf = (root: string): string | null => {
  try {
    return git(root, ["rev-parse", "HEAD"]).trim();
  } catch {
    return null;
  }
};

/** What tools leave behind when they run. Such a file is never the session's work and never makes a tree count as changed. */
export const LEFTOVER = /(^|\/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.ipynb_checkpoints)\/|\.py[co]$|(^|\/)(\.DS_Store|Thumbs\.db)$/;

const statusNow = (root: string): string[] => statusPaths(git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).filter((f) => !LEFTOVER.test(f));

export const takeBaseline = (root: string): Baseline => {
  const dirty: Baseline["dirty"] = {};
  for (const file of statusNow(root)) {
    const abs = path.join(root, file);
    const text = readSource(abs);
    dirty[file] = { hash: hashOf(abs), hatches: text === null ? [] : findHatches(file, text).map((h) => h.text), comments: text === null ? [] : findComments(file, text).map((c) => c.text) };
  }
  return { root, head: headOf(root), taken: new Date().toISOString(), clean: Object.keys(dirty).length === 0, dirty };
};

export const sessionDir = (sessionId: string): string => path.join(home(), "sessions", sessionId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "unknown");
const baselineFile = (sessionId: string, root: string): string => path.join(sessionDir(sessionId), `${slug(root)}.baseline.json`);

/** The baseline of this session for this repository, taken now if there is none yet. */
export const ensureBaseline = (sessionId: string, root: string): { baseline: Baseline; fresh: boolean } => {
  const file = baselineFile(sessionId, root);
  const found = readJson<Baseline | null>(file, null);
  if (found) return { baseline: found, fresh: false };
  const baseline = takeBaseline(root);
  writeJson(file, baseline);
  return { baseline, fresh: true };
};

/** Every repository this session has a baseline for. */
export const sessionBaselines = (sessionId: string): Baseline[] => {
  try {
    return fs
      .readdirSync(sessionDir(sessionId))
      .filter((f) => f.endsWith(".baseline.json"))
      .flatMap((f) => {
        const b = readJson<Baseline | null>(path.join(sessionDir(sessionId), f), null);
        return b ? [b] : [];
      });
  } catch {
    return [];
  }
};

/**
 * The files the session changed and that still exist: changed or untracked now, or changed by commits made since
 * the baseline, minus files that were already changed at the baseline and still hold the same content.
 */
export const changedFiles = (baseline: Baseline): { file: string; hash: string }[] => {
  const { root } = baseline;
  const names = new Set(statusNow(root));
  const head = headOf(root);
  if (baseline.head && head && head !== baseline.head) {
    try {
      // Only commits made on top of the baseline are the session's. After a branch switch or a reset the baseline is
      // no ancestor of HEAD, and the difference between the two branches is nobody's work in this session.
      git(root, ["merge-base", "--is-ancestor", baseline.head, head]);
      for (const f of git(root, ["diff", "--name-only", "-z", baseline.head, head]).split("\0")) if (f) names.add(f);
    } catch {
      // Not an ancestor, or the baseline commit is gone (history rewritten). The working tree changes still count.
    }
  }
  const out: { file: string; hash: string }[] = [];
  for (const file of [...names].sort()) {
    const hash = hashOf(path.join(root, file));
    if (hash === null) continue;
    const before = baseline.dirty[file];
    if (before && before.hash === hash) continue;
    out.push({ file, hash });
  }
  return out;
};

/** The comments a file held at the baseline, or null when that is not known (nothing is then charged). */
export const baselineComments = (baseline: Baseline, file: string): string[] | null => {
  const before = baseline.dirty[file];
  if (before) return before.comments ?? null;
  if (!baseline.head) return [];
  try {
    return findComments(file, git(baseline.root, ["show", `${baseline.head}:${file}`])).map((c) => c.text);
  } catch {
    return [];
  }
};

/** The escape hatch lines a file held at the baseline. */
export const baselineHatches = (baseline: Baseline, file: string): string[] => {
  const before = baseline.dirty[file];
  if (before) return before.hatches;
  if (!baseline.head) return [];
  try {
    return findHatches(file, git(baseline.root, ["show", `${baseline.head}:${file}`])).map((h) => h.text);
  } catch {
    return [];
  }
};

/** What the harness remembers between the turns of one session, per repository. */
export type TurnState = { lastKey?: string; lastBlocking?: number; holds: number; passed: string[]; /** Per command: the state of its own files when it last ran, and how that run ended. */ ran?: Record<string, { key: string; status: string }>; /** Commands left unrun at the last turn end, over the count or out of budget: a turn end with nothing changed runs them. */ pending?: number };
const turnFile = (sessionId: string, root: string): string => path.join(sessionDir(sessionId), `${slug(root)}.turn.json`);
export const readTurn = (sessionId: string, root: string): TurnState => ({ holds: 0, passed: [], ...readJson<Partial<TurnState>>(turnFile(sessionId, root), {}) });
export const writeTurn = (sessionId: string, root: string, turn: TurnState): void => writeJson(turnFile(sessionId, root), turn);

export const currentHead = headOf;
export const isClean = (root: string): boolean => statusNow(root).length === 0;
export const trackedFiles = (root: string): string[] => git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
export const fileAtCommit = (root: string, rev: string, file: string): string | null => {
  try {
    return git(root, ["show", `${rev}:${file}`]);
  } catch {
    return null;
  }
};

/** Removes session folders not touched for `days`. */
export const sweepSessions = (days: number): void => {
  const dir = path.join(home(), "sessions");
  try {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (Date.now() - fs.statSync(p).mtimeMs > days * 86_400_000) fs.rmSync(p, { recursive: true, force: true });
    }
  } catch {
    // Nothing to sweep.
  }
};
