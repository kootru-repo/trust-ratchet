// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FixFile } from "./propose.ts";
import { projectDir, readJson, writeJson } from "./state.ts";

/**
 * Corrections given in chat (T2 for the corrections that never become a fix commit). When a prompt reads like a
 * correction, the hook keeps where the repository stood at that moment: its head and a copy of every source file
 * with uncommitted work. When the turn that follows ends, the loop reads the difference between that moment and
 * the result as a fix, and puts it to the same proposer a fix commit goes to.
 *
 * What is weaker than a fix commit: the difference holds everything the turn changed, not only the correction.
 * So a rule from here is on trial like any other, and marked with where it came from.
 *
 * The prompt itself is not kept, apart from a short excerpt for the person who audits the folder. It is never
 * shown on the dashboard and never told to a session.
 */
export type CorrectionMeta = { id: string; time: string; sessionId: string; head: string | null; dirty: string[]; excerpt: string };

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi)$/;
const MAX_FILES = 80;
const MAX_BYTES = 1_000_000;
const START = /^(no[,.! ]|nope\b|stop\b|wait\b|don'?t\b|do not\b|never\b|wrong\b|incorrect\b|that'?s (not|wrong)|this is (not|wrong)|not what\b|you (are|were|should|shouldn'?t|didn'?t|did not|forgot|missed|broke|keep|still)\b|i (asked|said|told|didn'?t ask|did not ask|never asked)\b|why (did|are|is|would|wouldn'?t|didn'?t)\b|revert\b|undo\b|again[,:]|still (wrong|broken|not|fails?)\b)/i;
const INSIDE = /\b(i asked (you|u)\b|i told (you|u)\b|you (should not|shouldn'?t|must not|were supposed to)\b|that'?s wrong|\bis wrong\b|not what i (asked|wanted|meant)|you (broke|forgot|missed|ignored))/i;

/** Pure: does a prompt read like a correction of what was just done? A guess by wording, wide on purpose: the proposer is strict. */
export const looksLikeCorrection = (prompt: string): boolean => {
  const text = prompt.trim();
  if (text.length < 3 || text.length > 800 || text.startsWith("/") || text.startsWith("<")) return false;
  return START.test(text) || INSIDE.test(text);
};

const git = (root: string, args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], timeout: 8000 });
const dirOf = (root: string): string => path.join(projectDir(root), "corrections");

/** The source files with uncommitted work, tracked or new. */
export const dirtySource = (root: string): string[] =>
  git(root, ["status", "--porcelain", "--no-renames", "--untracked-files=all"])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, ""))
    .filter((f) => SOURCE.test(f));

/** Keeps where the repository stands now. Called from the prompt hook: quick, silent, and a fault changes nothing. */
export const noteCorrection = ({ root, sessionId, prompt, now = new Date().toISOString() }: { root: string; sessionId: string; prompt: string; now?: string }): CorrectionMeta | null => {
  let head: string | null = null;
  try {
    head = git(root, ["rev-parse", "HEAD"]).trim();
  } catch {
    head = null;
  }
  const dirty = dirtySource(root).slice(0, MAX_FILES);
  const id = `${now.replace(/[:.]/g, "-")}-${createHash("sha256").update(`${sessionId}${now}`).digest("hex").slice(0, 6)}`;
  const dir = path.join(dirOf(root), id);
  const kept: string[] = [];
  for (const f of dirty) {
    try {
      const from = path.join(root, f);
      if (fs.statSync(from).size > MAX_BYTES) continue;
      const to = path.join(dir, "files", f);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      kept.push(f);
    } catch {
      // deleted in the working tree: its "before" is then the empty file, which is what the missing copy says
      kept.push(f);
    }
  }
  const meta: CorrectionMeta = { id, time: now, sessionId, head, dirty: kept, excerpt: prompt.trim().replace(/\s+/g, " ").slice(0, 120) };
  writeJson(path.join(dir, "meta.json"), meta);
  return meta;
};

export const pendingCorrections = (root: string): CorrectionMeta[] => {
  try {
    return fs
      .readdirSync(dirOf(root))
      .sort()
      .flatMap((d) => {
        const meta = readJson<CorrectionMeta | null>(path.join(dirOf(root), d, "meta.json"), null);
        return meta ? [meta] : [];
      });
  } catch {
    return [];
  }
};

export const dropCorrection = (root: string, id: string): void => fs.rmSync(path.join(dirOf(root), id), { recursive: true, force: true });

/** Pure: the lines one text lost and gained against another, read from a unified diff with no context. */
export const sides = (diff: string): { removed: string[]; added: string[] } => {
  const removed: string[] = [];
  const added: string[] = [];
  let inHunk = false;
  for (const l of diff.split(/\r?\n/)) {
    if (l.startsWith("@@")) inHunk = true;
    else if (!inHunk) continue;
    else if (l.startsWith("-")) removed.push(l.slice(1));
    else if (l.startsWith("+")) added.push(l.slice(1));
  }
  return { removed, added };
};

/** What changed between the moment of a correction and now, as the files of a fix. */
export const fixFromCorrection = ({ root, meta }: { root: string; meta: CorrectionMeta }): FixFile[] => {
  let since: string[] = [];
  try {
    since = meta.head ? git(root, ["diff", "--name-only", "--no-renames", meta.head]).split(/\r?\n/).filter(Boolean) : [];
  } catch {
    since = [];
  }
  let dirtyNow: string[] = [];
  try {
    dirtyNow = dirtySource(root);
  } catch {
    dirtyNow = [];
  }
  const files = [...new Set([...meta.dirty, ...since, ...dirtyNow])].filter((f) => SOURCE.test(f)).slice(0, MAX_FILES);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-corr-"));
  const out: FixFile[] = [];
  try {
    for (const f of files) {
      const copy = path.join(dirOf(root), meta.id, "files", f);
      let before = "";
      if (meta.dirty.includes(f)) before = fs.existsSync(copy) ? fs.readFileSync(copy, "utf8") : "";
      else if (meta.head) {
        try {
          before = git(root, ["show", `${meta.head}:${f}`]);
        } catch {
          before = "";
        }
      }
      let after = "";
      try {
        after = fs.readFileSync(path.join(root, f), "utf8");
      } catch {
        after = "";
      }
      if (before === after) continue;
      const a = path.join(tmp, "before");
      const b = path.join(tmp, "after");
      fs.writeFileSync(a, before);
      fs.writeFileSync(b, after);
      let diff = "";
      try {
        diff = execFileSync("git", ["diff", "--no-index", "-U0", "--", a, b], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      } catch (e) {
        // git diff --no-index exits 1 when the files differ: that is the answer, not a fault.
        diff = String((e as { stdout?: string }).stdout ?? "");
      }
      const { removed, added } = sides(diff);
      if (removed.length + added.length > 0) out.push({ file: f, removed, added, after, before });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return out;
};
