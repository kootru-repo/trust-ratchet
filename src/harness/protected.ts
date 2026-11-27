// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { matchesAny } from "./rules.ts";
import { projectFile, readJson, writeJson } from "./state.ts";

/**
 * Protected paths (A3): files that are a recorded reference, such as test fixtures, golden files or snapshots. A
 * config protects them with a check `{ "command": "builtin:protected", "when": ["test/fixtures/**"] }`. At a turn
 * end, any of them the session changed (committed or not: the session's baseline decides) fails the check, unless the
 * person allowed a re-record for a while with `ratchet allow-protected`. Every allowance given and used is logged.
 *
 * The model is an honest agent: an agent could run the allow command itself. The message says it is the person's call.
 */
export type Allowance = { glob: string; at: number; until: number };

const allowanceFile = (root: string): string => projectFile(root, "allowances.json");
const logFile = (root: string): string => projectFile(root, "allowances.log");
const log = (root: string, line: string): void => {
  try {
    fs.appendFileSync(logFile(root), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // The log is a record, not a gate: a failure to write it must not change the check's answer.
  }
};

export const readAllowances = (root: string): Allowance[] => {
  const raw = readJson<unknown>(allowanceFile(root), []);
  return Array.isArray(raw) ? raw.filter((a): a is Allowance => typeof a?.glob === "string" && typeof a?.at === "number" && typeof a?.until === "number") : [];
};

/** Pure: is this file covered by an allowance still open at `now`? */
export const allowedNow = (allowances: Allowance[], file: string, now: number): boolean => allowances.some((a) => a.until > now && matchesAny(file, [a.glob]));

/** The person allows changes under a glob for some minutes. Expired allowances are dropped. */
export const allowProtected = ({ root, glob, minutes, now = Date.now() }: { root: string; glob: string; minutes: number; now?: number }): Allowance => {
  const allowance = { glob: normalizeGlob(glob), at: now, until: now + minutes * 60_000 };
  writeJson(allowanceFile(root), [...readAllowances(root).filter((a) => a.until > now), allowance]);
  log(root, `allowed ${allowance.glob} for ${minutes} min`);
  return allowance;
};

/** Pure: a glob as the checks see paths: forward slashes, no leading "./". */
export const normalizeGlob = (glob: string): string => glob.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "");

/** Did this file exist at the session's baseline commit? Null when that is not known. */
const atBaseline = (root: string, head: string | null, file: string): boolean | null => {
  if (!head) return null;
  try {
    execFileSync("git", ["-C", root, "cat-file", "-e", `${head}:${file}`], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
};

/** Pure: how to put one protected file back as it was at the baseline. */
export const restoreHint = (file: string, head: string | null, existed: boolean | null): string => {
  if (head && existed) return `put it back as it was: git restore --source=${head.slice(0, 12)} --staged --worktree -- "${file}" (then commit that if the change was committed)`;
  if (existed === false) return `it is new in this session: remove it (git rm --cached -- "${file}" if it is staged, then delete the file)`;
  return "put it back as it was at the start of the session";
};

/** The protected-paths check: names each changed protected file that no open allowance covers, and how to put it back. */
export const protectedCheck = ({ root, files, head = null, now = Date.now() }: { root: string; files: string[]; head?: string | null; now?: number }): { status: number; output: string } => {
  const allowances = readAllowances(root);
  const allowed = files.filter((f) => allowedNow(allowances, f, now));
  if (allowed.length > 0) log(root, `changes allowed by an open allowance: ${allowed.join(", ")}`);
  const blocked = files.filter((f) => !allowedNow(allowances, f, now));
  if (blocked.length === 0) return { status: 0, output: "" };
  return {
    status: 1,
    output: blocked.map((f) => `${f}: a protected file changed in this session. It is a recorded reference, so ${restoreHint(f, head, atBaseline(root, head, f))}. If the person asked for a re-record, they allow it for a while with: ratchet allow-protected --path "${f}" --minutes 30`).join("\n"),
  };
};
