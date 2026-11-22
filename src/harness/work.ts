// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PACKS } from "../packs/index.ts";
import type { ReviewOptions } from "../options.ts";
import { reviewFile } from "../review.ts";
import type { Fact, ModelFn, ReviewResult } from "../types.ts";
import { renderFindings } from "./rules.ts";
import { LEFTOVER, statusPaths, takeBaseline } from "./session.ts";
import { readConfig } from "./state.ts";
import { fileFindings, readRules } from "./turn.ts";

const git = (root: string, args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });

/** The source files that differ from `since` in the working tree, untracked ones included, that a language pack handles. */
export const workFiles = ({ root, since }: { root: string; since: string }): string[] => {
  const names = new Set<string>(statusPaths(git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])));
  for (const f of git(root, ["diff", "--name-only", "-z", since]).split("\0")) if (f) names.add(f);
  return [...names].filter((f) => !LEFTOVER.test(f) && PACKS.some((p) => p.handles(f)) && fs.existsSync(path.join(root, f))).sort();
};

/**
 * Reviews what the working tree changes against `since`, file by file, with reviewers that are fresh processes: they never saw the
 * session that wrote the change (S1), and they read the tree with read-only tools. The harness's own program checks
 * go in as facts first (T1).
 */
export const reviewWork = async ({ root, since, model, maxFiles, log, optionsFor = () => ({}) }: { root: string; since: string; model: ModelFn; maxFiles: number; log: (line: string) => void; optionsFor?: (file: string) => ReviewOptions }): Promise<{ files: string[]; reviews: ReviewResult[]; skipped: string[] }> => {
  const all = workFiles({ root, since });
  const files = all.slice(0, maxFiles);
  const baseline = { ...takeBaseline(root), dirty: {} };
  const rules = readRules(root);
  const reviews: ReviewResult[] = [];
  for (const file of files) {
    log(`reviewing ${file}`);
    const { findings, ran } = fileFindings({ baseline, file, rules, comments: readConfig(root).comments });
    const facts: Fact[] = [{ command: `ratchet file checks (${ran.join(", ")})`, exitCode: findings.length > 0 ? 1 : 0, tail: findings.length > 0 ? renderFindings({ findings, heading: "" }).trim() : "", ran: true }];
    const diff = git(root, ["diff", since, "--", file]);
    reviews.push(await reviewFile({ root, file, model, facts, auditLocal: 3, options: optionsFor(file), ...(diff.trim() ? { patch: { message: `Change in the working tree against ${since}`, diff } } : {}) }));
  }
  return { files, reviews, skipped: all.slice(maxFiles) };
};
