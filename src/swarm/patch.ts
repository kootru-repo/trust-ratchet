import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { patchId } from "./verdict.ts";

export type Applied = { state: "applied" | "already" | "conflict"; message: string };

const git = (tree: string, args: string[]): { ok: boolean; out: string } => {
  try {
    return { ok: true, out: execFileSync("git", ["-C", tree, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
};

/**
 * Idempotent integration of a patch: applying it twice leaves the tree as applying it once did. A patch that is already in the tree is "already", never applied a second time;
 * a patch that fits neither the tree nor the tree with it applied is a "conflict" and nothing is changed. (Owner, 2026-11-21: a retried call must not change twice.)
 */
export const applyPatch = (tree: string, diff: string): Applied => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-patch-")), "p.diff");
  try {
    fs.writeFileSync(file, diff);
    if (git(tree, ["apply", "--check", "--reverse", file]).ok) return { state: "already", message: `patch ${patchId(diff)} is already in the tree` };
    const check = git(tree, ["apply", "--check", "--whitespace=nowarn", file]);
    if (!check.ok) return { state: "conflict", message: check.out.trim().slice(0, 300) };
    const done = git(tree, ["apply", "--whitespace=nowarn", file]);
    return done.ok ? { state: "applied", message: `patch ${patchId(diff)} applied` } : { state: "conflict", message: done.out.trim().slice(0, 300) };
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
};
