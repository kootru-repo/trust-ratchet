// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import type { Case } from "./bench.ts";
import { hunkRanges, type Range } from "./git.ts";
import { PACKS } from "./packs/index.ts";

const git = (repo: string, args: string[]): string => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
export const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Pure: for every hunk, the lines it covers in the old file and in the new file. */
export const hunkPairs = (diff: string): { before: Range; after: Range }[] =>
  [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => {
    const span = (start: number, count: number): Range => (count === 0 ? { from: start, to: start + 1 } : { from: start, to: start + count - 1 });
    return { before: span(Number(m[1]), m[2] === undefined ? 1 : Number(m[2])), after: span(Number(m[3]), m[4] === undefined ? 1 : Number(m[4])) };
  });

/** Lines too short or too common to identify a place in a file. */
const TELLING = 12;

/** Pure: the text of the lines a diff removed, whitespace-squashed. Trivial lines (a lone brace, a short keyword) are left out. */
export const removedTexts = (diff: string): string[] =>
  diff
    .split(/\r?\n/)
    .filter((l) => l.startsWith("-") && !l.startsWith("---"))
    .map((l) => squash(l.slice(1)))
    .filter((l) => l.length >= TELLING);

/** Pure: the lines of a file whose text is one of the wanted lines (whitespace-squashed). */
export const linesWith = ({ text, wanted }: { text: string; wanted: string[] }): Range[] => {
  const set = new Set(wanted);
  return text.split(/\r?\n/).flatMap((l, i) => (set.has(squash(l)) ? [{ from: i + 1, to: i + 1 }] : []));
};

export const fileAt = ({ repo, rev, file }: { repo: string; rev: string; file: string }): string | null => {
  try {
    return git(repo, ["show", `${rev}:${file}`]);
  } catch {
    return null;
  }
};

export type Patch = { message: string; diff: string };

/** What one commit did to one file, and why its author said it did it. */
export const commitPatch = ({ repo, rev, file }: { repo: string; rev: string; file: string }): Patch => ({
  message: git(repo, ["show", "-s", "--format=%B", rev]).trim(),
  diff: git(repo, ["show", "--format=", "-U3", rev, "--", file]),
});

/** The fix's own diff for one file, with no context lines. */
export const fixDiff = ({ repo, fix, file }: { repo: string; fix: string; file: string }): string => git(repo, ["diff", "-U0", `${fix}^`, fix, "--", file]);

export const changedFiles = ({ repo, rev }: { repo: string; rev: string }): string[] =>
  git(repo, ["show", "--name-only", "--format=", rev])
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * The commit that last wrote the lines a fix removed: the usual way to find where a bug came in (SZZ).
 * Returns null when the fix removed nothing, or when no single commit wrote most of those lines.
 */
export const introducing = ({ repo, fix, file }: { repo: string; fix: string; file: string }): string | null => {
  const diff = git(repo, ["diff", "-U0", `${fix}^`, fix, "--", file]);
  if (removedTexts(diff).length === 0) return null;
  const counts = new Map<string, number>();
  let total = 0;
  for (const r of hunkRanges(diff)) {
    let out = "";
    try {
      out = git(repo, ["blame", "-l", "-s", "-L", `${r.from},${r.to}`, `${fix}^`, "--", file]);
    } catch {
      continue;
    }
    for (const line of out.split(/\r?\n/).filter(Boolean)) {
      const hash = (line.split(" ")[0] ?? "").replace(/^\^/, "");
      if (!hash) continue;
      counts.set(hash, (counts.get(hash) ?? 0) + 1);
      total += 1;
    }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] * 2 > total ? top[0] : null;
};

const isTest = (f: string): boolean => /\.test\.|\.spec\.|__tests__|(^|\/)tests?\/|(^|\/)test_[^/]*\.py$/.test(f);
const isSourceFile = (f: string): boolean => PACKS.some((p) => p.handles(f)) && !isTest(f);
const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/, "");

/**
 * Pure: does a commit subject announce a bug fix? The subject line only, whole words only, and not housekeeping
 * (a build, lint or rename fix is not a fault a reviewer could have found in the code).
 */
export const isFixSubject = (subject: string): boolean => /\b(fix|fixes|fixed|bug|bugfix|crash|regression)\b/i.test(subject) && !/\b(ci|rename|renames|chore|lint|typo|typos|bump|build|deps|docs?|test|tests|types?|style|format|formatting)\b/i.test(subject);

export type MineArgs = { repo: string; prefix: string; exclude: string[]; max: number; maxChanged?: number; maxPatch?: number };

/**
 * Finds benchmark cases mechanically, so nobody picks them by eye: commits whose message says fix or bug, that change
 * exactly one source file by a few lines, and whose removed lines were mostly written by one earlier commit.
 * That earlier commit is the patch to review. Newest first.
 */
export const mineCases = ({ repo, prefix, exclude, max, maxChanged = 40, maxPatch = 400 }: MineArgs): Case[] => {
  const skip = new Set(exclude.map((h) => git(repo, ["rev-parse", h]).trim()));
  const log = git(repo, ["log", "--no-merges", "--format=%H\t%s", "--", prefix]).split(/\r?\n/).filter(Boolean);
  const out: Case[] = [];
  for (const line of log) {
    if (out.length >= max) break;
    const [fix = "", subject = ""] = line.split("\t");
    if (skip.has(fix) || !isFixSubject(subject)) continue;
    const stats = git(repo, ["show", "--numstat", "--format=", fix])
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => l.split("\t"))
      .filter((p) => p.length === 3 && p[0] !== "-");
    const sources = stats.filter((p) => isSourceFile(p[2] ?? "") && (p[2] ?? "").startsWith(prefix));
    if (sources.length !== 1) continue;
    const [added = "0", removed = "0", file = ""] = sources[0] ?? [];
    if (Number(added) + Number(removed) > maxChanged || Number(removed) === 0) continue;
    const intro = introducing({ repo, fix, file });
    if (!intro || intro === fix) continue;
    let patchLines = 0;
    try {
      patchLines = commitPatch({ repo, rev: intro, file }).diff.split(/\r?\n/).length;
    } catch {
      continue;
    }
    if (patchLines === 0 || patchLines > maxPatch) continue;
    // The faulty lines must already be in the file as that commit left it, or the case cannot be scored.
    // Each of those lines must be there exactly once: a repeated line would widen what counts as a hit.
    const then = fileAt({ repo, rev: intro, file });
    const wanted = [...new Set(removedTexts(fixDiff({ repo, fix, file })))];
    const found = then === null ? [] : wanted.map((w) => linesWith({ text: then, wanted: [w] }).length);
    if (!found.some((n) => n === 1) || found.some((n) => n > 1)) continue;
    // A commit that created or moved the file is not a patch to review: its diff is the whole file.
    if (!/^M\t/m.test(git(repo, ["show", "--name-status", "--format=", intro, "--", file]))) continue;
    out.push({ id: `${slug(subject)}-${fix.slice(0, 7)}`, fix: fix.slice(0, 10), file, intro: intro.slice(0, 10), note: subject.slice(0, 120) });
  }
  return out;
};
