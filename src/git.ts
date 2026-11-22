import { execFileSync } from "node:child_process";
import { forShell } from "./shellcmd.ts";
import fs from "node:fs";
import path from "node:path";
import type { Fact } from "./types.ts";

const git = (repo: string, args: string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/**
 * Copies the tree at `commit` into `dest` with no .git folder.
 * This matters for the benchmark: a reviewer working in a clone could read the fix from history.
 */
export const exportTree = ({ repo, commit, dest, paths }: { repo: string; commit: string; dest: string; paths: string[] }): void => {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const tarFile = `${dest}.tar`;
  const present = paths.filter((p) => git(repo, ["ls-tree", "--name-only", commit, "--", p]).trim() !== "");
  git(repo, ["archive", "--format=tar", "-o", tarFile, commit, "--", ...present]);
  // Relative paths: GNU tar reads "C:" in an absolute Windows path as a remote host.
  execFileSync("tar", ["-xf", path.join("..", path.basename(tarFile))], { cwd: dest });
  fs.rmSync(tarFile, { force: true });
};

export type Range = { from: number; to: number };

/** Pure: the line ranges of the old file that a unified diff touches. An insertion counts as the two lines around it. */
export const hunkRanges = (diff: string): Range[] =>
  [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)].map((m) => {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    return count === 0 ? { from: start, to: start + 1 } : { from: start, to: start + count - 1 };
  });

/** The lines of `file` at `fix^` that the fix commit changed. */
export const fixedRanges = ({ repo, fix, file }: { repo: string; fix: string; file: string }): Range[] =>
  hunkRanges(git(repo, ["diff", "-U0", `${fix}^`, fix, "--", file]));

export const inRanges = ({ line, ranges, slack }: { line: number; ranges: Range[]; slack: number }): boolean =>
  ranges.some((r) => line >= r.from - slack && line <= r.to + slack);

/** Runs a deterministic check (type check, lint, tests) and records the outcome as a fact for the reviewers. */
export const runCheck = ({ command, cwd }: { command: string; cwd: string }): Fact => {
  try {
    execFileSync(forShell(command), { cwd, shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000 });
    return { command, exitCode: 0, tail: "" };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    const text = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim().split(/\r?\n/).slice(-25).join("\n");
    return { command, exitCode: e.status ?? 1, tail: text };
  }
};

export const resolveCommit = ({ repo, rev }: { repo: string; rev: string }): string => git(repo, ["rev-parse", rev]).trim();
export const here = (...parts: string[]): string => path.resolve(import.meta.dirname, "..", ...parts);
