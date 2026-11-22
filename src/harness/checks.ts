// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { forShell } from "../shellcmd.ts";
import fs from "node:fs";
import path from "node:path";
import { matchesAny } from "./rules.ts";
import type { CheckCmd, ProjectConfig } from "./state.ts";

/**
 * The loop finds a check (T9 made autonomous): a type-check for a folder with a tsconfig, or a lint or type-check
 * script of the root package. A check is only a candidate here. The loop maps it after it has run once, ended
 * clean, and left the working tree exactly as it was. A script that rewrites files is never a candidate.
 */
export type CheckCandidate = CheckCmd & { /** The file whose presence suggests the check; a change of it lets a failed trial be tried again. */ from: string };

const slug = (dir: string): string => (dir === "." ? "root" : dir.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, ""));
const REWRITES = /--fix\b|--write\b|\bprettier\b(?!.*--check)|\bformat\b|\bsed\b|\brm\b|>\s*\S/;

/** Pure: the checks the tracked files and the root package's scripts suggest, minus those the config already has. */
export const checkCandidates = ({ files, scripts, hasTypescript, config, exclude = [] }: { files: string[]; scripts: Record<string, string>; hasTypescript: (dir: string) => boolean; config: ProjectConfig; exclude?: string[] }): CheckCandidate[] => {
  const have = config.checks ?? [];
  const out: CheckCandidate[] = [];
  for (const f of files.filter((x) => /(^|\/)tsconfig\.json$/.test(x) && !x.includes("node_modules/") && x.split("/").length <= 4 && !matchesAny(x, exclude))) {
    const dir = path.posix.dirname(f);
    if (!hasTypescript(dir)) continue;
    // A person's type-check of the same folder, however it is spelled, is the check of that folder.
    if (have.some((c) => /\btsc\b/.test(c.command) && (dir === "." ? !/\bcd\s/.test(c.command) : c.command.includes(`cd ${dir} `) || c.command.includes(`cd ${dir}&`) || c.command.includes(`-p ${dir}`)))) continue;
    if (dir === "." && have.some((c) => /npm run -s (check-types|typecheck|type-check|tsc)\b/.test(c.command))) continue;
    const prefix = dir === "." ? "" : `${dir}/`;
    out.push({ name: `types-${slug(dir)}`, command: `${dir === "." ? "" : `cd ${dir} && `}npx --no-install tsc --noEmit -p .`, when: [`${prefix}**/*.ts`, `${prefix}**/*.tsx`, `${prefix}**/*.mts`, `${prefix}*.ts`], timeoutS: 120, origin: "auto", from: f });
  }
  for (const [name, kind] of [["lint", "lint"], ["typecheck", "types"], ["check-types", "types"], ["type-check", "types"]] as const) {
    const body = scripts[name];
    if (!body || REWRITES.test(body)) continue;
    if (have.some((c) => c.command.includes(`npm run -s ${name}`)) || out.some((c) => c.name === `${kind}-root`)) continue;
    if (kind === "types" && (have.some((c) => /\btsc\b/.test(c.command) && !/\bcd\s/.test(c.command)) || out.some((c) => c.name === "types-root"))) continue;
    out.push({ name: `${kind}-root-script`, command: `npm run -s ${name}`, when: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.js", "**/*.jsx", "**/*.mjs"], timeoutS: 120, origin: "auto", from: "package.json" });
  }
  return out.filter((c) => !have.some((h) => h.name === c.name));
};

const status = (root: string): string => execFileSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });

/** Runs a candidate once. It is kept only when it ended clean in time and the working tree is as it was before. */
export const tryCheck = ({ root, check }: { root: string; check: CheckCandidate }): { ok: boolean; seconds: number; why: string } => {
  const before = status(root);
  const started = Date.now();
  let ok = true;
  try {
    execFileSync(forShell(check.command), { cwd: root, shell: true, stdio: "ignore", timeout: (check.timeoutS ?? 120) * 1000, windowsHide: true, env: { ...process.env, RATCHET_CHILD: "1" } });
  } catch {
    ok = false;
  }
  const seconds = (Date.now() - started) / 1000;
  if (status(root) !== before) return { ok: false, seconds, why: "it changed files in the working tree" };
  return { ok, seconds, why: ok ? "it ran clean" : "it did not end clean on the tree as it is, or ran out of time" };
};

export const readScripts = (root: string): Record<string, string> => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return {};
  }
};

/** Is there a TypeScript compiler this folder can run without downloading one? */
export const hasTypescriptAt = (root: string) => (dir: string): boolean => {
  let at = path.resolve(root, dir);
  const top = path.resolve(root);
  for (;;) {
    if (fs.existsSync(path.join(at, "node_modules", "typescript", "package.json"))) return true;
    if (at === top || path.dirname(at) === at) return false;
    at = path.dirname(at);
  }
};
