import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportTree, resolveCommit } from "./git.ts";
import { changedFiles, commitPatch } from "./history.ts";
import { runChecks, type CheckSpec } from "./layer0.ts";
import { PACKS } from "./packs/index.ts";
import { dropDepLinks, type ReproConfig } from "./repro.ts";
import { reviewFile } from "./review.ts";
import type { ModelFn, ReviewResult } from "./types.ts";

export type CommitReviewArgs = {
  repo: string;
  rev: string;
  model: ModelFn;
  /** Where checks run and where dependencies come from. Without it no deterministic check runs. */
  config?: ReproConfig;
  checks?: CheckSpec[];
  extras?: string[];
  maxFiles?: number;
  auditLocal?: number;
  log: (line: string) => void;
};

/**
 * Reviews one commit as a patch. The tree at that commit is exported with no history, so the reviewers are confined
 * to it and never share a session with whoever wrote the change. Only source files a language pack handles are reviewed.
 */
export const reviewCommit = async ({ repo, rev, model, config, checks = [], extras = [], maxFiles = 6, auditLocal = 3, log }: CommitReviewArgs): Promise<{ commit: string; reviews: ReviewResult[]; skipped: string[] }> => {
  const commit = resolveCommit({ repo, rev });
  const dest = path.join(os.tmpdir(), "ratchet-work", `commit-${commit.slice(0, 10)}`);
  exportTree({ repo, commit, dest, paths: ["."] });
  const all = changedFiles({ repo, rev: commit }).filter((f) => PACKS.some((p) => p.handles(f)) && fs.existsSync(path.join(dest, f)));
  const files = all.slice(0, maxFiles);
  const reviews: ReviewResult[] = [];
  try {
    for (const file of files) {
      log(`reviewing ${file} at ${commit.slice(0, 8)}`);
      const facts = config ? runChecks({ root: dest, config, checks, file }) : [];
      reviews.push(await reviewFile({ root: dest, file, model, facts, extras, auditLocal, patch: commitPatch({ repo, rev: commit, file }) }));
    }
  } finally {
    if (config) dropDepLinks({ root: dest, pkg: config.pkg });
    fs.rmSync(dest, { recursive: true, force: true });
  }
  return { commit, reviews, skipped: all.slice(maxFiles) };
};
