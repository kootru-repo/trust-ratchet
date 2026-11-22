// SPDX-License-Identifier: AGPL-3.0-only
import fs from "node:fs";
import path from "node:path";
import type { Pack } from "./pack.ts";
import type { Cite, ToolUse } from "./types.ts";

const posix = (p: string): string => p.split(path.sep).join("/").replace(/\\/g, "/");

/** Pure apart from path maths: the files a reviewer opened with Read, relative to the tree, forward slashes. */
export const openedFiles = ({ tools, root }: { tools: ToolUse[]; root: string }): Set<string> =>
  new Set(
    tools
      .filter((t) => t.name === "Read" && t.target !== "")
      .map((t) => posix(path.relative(path.resolve(root), path.resolve(root, t.target))))
      .filter((p) => !p.startsWith("..")),
  );

export type Use = { file: string; line: number; text: string };

/**
 * The lines in each importing file that use what it imports from the file under review.
 * A program finds them, so they cost the reviewer nothing; they show where to look, not what the code does.
 */
export const findUses = ({ root, file, importers, pack, perFile = 5, maxFiles = 8 }: { root: string; file: string; importers: string[]; pack: Pack; perFile?: number; maxFiles?: number }): Use[] =>
  importers.slice(0, maxFiles).flatMap((importer) => {
    const text = fs.readFileSync(path.resolve(root, importer), "utf8");
    const names = pack.importedNames?.(text, file) ?? [];
    if (names.length === 0) return [];
    const word = new RegExp(`\\b(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`);
    return text
      .split(/\r?\n/)
      .map((l, i) => ({ file: importer, line: i + 1, text: l.trim().slice(0, 160) }))
      .filter((u) => word.test(u.text) && !/^(import|from|export\s+\{|\}\s*from)\b/.test(u.text))
      .slice(0, perFile);
  });

export type ReadingVerdict = { verified: Cite[]; rejected: { cite: Cite; reason: string }[]; ok: boolean };

/**
 * Pure: decides whether a reviewer showed that it read other files.
 * A read counts when its quote matches the file, the file is not the one under review, the line was not already
 * printed in the prompt, and (when tool use was recorded) the reviewer really opened that file. One read per file.
 */
export const judgeReading = ({
  reads,
  file,
  shown,
  opened,
  matches,
  required,
}: {
  reads: Cite[];
  file: string;
  shown: Set<string>;
  opened: Set<string> | null;
  matches: (cite: Cite) => { ok: boolean; line?: number; reason?: string };
  required: number;
}): ReadingVerdict => {
  const verified: Cite[] = [];
  const rejected: { cite: Cite; reason: string }[] = [];
  for (const cite of reads) {
    const no = (reason: string): void => void rejected.push({ cite, reason });
    if (cite.file === file) no("it is the file under review");
    else if (verified.some((v) => v.file === cite.file)) no("another line of this file is already counted");
    else if (opened !== null && !opened.has(cite.file)) no("the file was never opened with Read");
    else {
      const m = matches(cite);
      if (!m.ok) no(m.reason ?? "the quote does not match");
      else if (shown.has(`${cite.file}:${m.line ?? cite.line}`)) no("the line was already printed in the prompt");
      else verified.push(cite);
    }
  }
  return { verified, rejected, ok: verified.length >= required };
};
