import fs from "node:fs";
import path from "node:path";
import { matchesAny } from "./harness/rules.ts";
import { ident } from "./ident.ts";
import type { Check, Checked, Cite, Dropped, ToolUse } from "./types.ts";
import type { Ruling } from "./vault.ts";

/**
 * Review mechanisms that change what a model is told or how a verdict is kept. Every one is OFF unless asked for:
 * none has been through a benchmark run, and no prompt change is called an improvement without one (S10).
 */
export type ReviewOptions = {
  /** S5: a verifier's verdict stands only if it opened this many files besides the cited one. 0 or absent: off. */
  verifierReads?: number;
  /** S6: tell each reviewer how much work the size of the change is worth. */
  budget?: boolean;
  /** S12: notes from the people who own the code, for the file under review. */
  guides?: Guide[];
  /** S14: places a person ruled a false alarm. They are told to the reviewers and dropped by a program if raised again. */
  mustNotFlag?: MustNot[];
  /** T11: ask for a property over generated inputs when the claim is about every input of a kind. */
  property?: boolean;
  /** S3, for measuring the bias only: every specialist sees the author's commit message, not just `intent`. */
  messageToAll?: boolean;
  /** S3: comments are hidden in the diff a reviewer is shown, so the author's own account of a line cannot stand in for the code. */
  maskComments?: boolean;
  /** S1: when a sampled local dismissal turns out to be a bug, every other local dismissal of that review is verified too. */
  escalateLocal?: boolean;
};

export type Budget = { size: number; toolCalls: number; label: "small" | "medium" | "large" };

/** Pure: the work a change is worth, from its size in lines (the diff when there is one, else the file). */
export const budgetFor = ({ fileLines, diffLines }: { fileLines: number; diffLines?: number }): Budget => {
  const size = diffLines !== undefined && diffLines > 0 ? diffLines : fileLines;
  if (size <= 40) return { size, toolCalls: 6, label: "small" };
  if (size <= 250) return { size, toolCalls: 12, label: "medium" };
  return { size, toolCalls: 20, label: "large" };
};

export const budgetLine = (b: Budget): string =>
  `Budget: what you are judging is ${b.size} lines (${b.label}). Spend about ${b.toolCalls} tool calls at most. Stop reading when another file would not change your answer; say "unproven" or dismiss as "assumed" over guessing when the budget runs out.`;

/** Pure: the changed lines of a unified diff. */
export const diffSize = (diff: string): number => diff.split(/\r?\n/).filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).length;

export type Guide = { name: string; applies: string[]; text: string };

/** Pure: one guide file. The first line may be `applies: glob, glob`; without it the guide applies everywhere. */
export const parseGuide = (name: string, raw: string): Guide => {
  const lines = raw.replace(/^﻿/, "").split(/\r?\n/);
  const m = /^applies:\s*(.+)$/i.exec(lines[0] ?? "");
  return m ? { name, applies: (m[1] ?? "").split(",").map((g) => g.trim()).filter(Boolean), text: lines.slice(1).join("\n").trim() } : { name, applies: ["**"], text: raw.trim() };
};

/** The guides in a folder (`*.md`) that apply to a file. A missing folder is no guides. */
export const guidesFor = ({ dir, file }: { dir: string; file: string }): Guide[] => {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  return names.map((n) => parseGuide(n, fs.readFileSync(path.join(dir, n), "utf8"))).filter((g) => g.text !== "" && matchesAny(file, g.applies));
};

export const guidesBlock = (guides: Guide[]): string =>
  guides.length === 0 ? "" : `\nNotes from the people who own this code (context, not proof: where a note and the code disagree, the code decides, and say so):\n${guides.map((g) => `--- ${g.name}\n${g.text.slice(0, 4000)}`).join("\n")}\n`;

/** A place that looks wrong and was ruled fine by a person. `pattern` is a regular expression on the quoted line. */
export type MustNot = { files: string[]; pattern: string; reason: string };

const hit = (m: MustNot, cite: Cite): boolean => {
  if (!matchesAny(cite.file, m.files)) return false;
  try {
    return new RegExp(m.pattern).test(cite.quote);
  } catch {
    return false;
  }
};

/** Pure: splits the checks into those to verify and those a person already ruled a false alarm. */
export const applyMustNot = ({ checks, mustNot }: { checks: Check[]; mustNot: MustNot[] }): { kept: Check[]; dropped: Dropped[] } => {
  const kept: Check[] = [];
  const dropped: Dropped[] = [];
  for (const c of checks) {
    const m = mustNot.find((x) => hit(x, c.cite));
    if (m) dropped.push({ title: c.title, specialist: c.specialist, reason: `a person ruled this place a false alarm: ${m.reason}` });
    else kept.push(c);
  }
  return { kept, dropped };
};

export const mustNotBlock = ({ mustNot, file }: { mustNot: MustNot[]; file: string }): string => {
  const mine = mustNot.filter((m) => matchesAny(file, m.files));
  return mine.length === 0 ? "" : `\nA person has already ruled these false alarms in this file. Do not raise them again:\n${mine.map((m) => `- a line matching /${m.pattern}/: ${m.reason}`).join("\n")}\n`;
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Pure: must-not-flag cases from a person's rulings (S14). A ruling names a finding by its id; the saved review
 * results give the id its file and quoted line. A ruling with no matching finding is returned as unmatched.
 */
export const mustNotFromRulings = ({ rulings, checked }: { rulings: Ruling[]; checked: Checked[] }): { cases: MustNot[]; unmatched: string[] } => {
  const cases: MustNot[] = [];
  const unmatched: string[] = [];
  for (const r of rulings.filter((x) => x.ruling === "false-alarm")) {
    const c = checked.find((x) => ident(x.cite) === r.finding);
    if (!c) unmatched.push(r.finding);
    else cases.push({ files: [c.cite.file], pattern: escapeRe(c.cite.quote.trim()).replace(/\s+/g, "\\s+"), reason: r.note.split(/\r?\n/)[0]?.trim() || `ruled a false alarm (finding ${r.finding})` });
  }
  return { cases, unmatched };
};

export const PROPERTY_GUIDE = `- If the claim is about every input of a kind (any empty list, any negative number, any key that is missing), write the test as a property: build at least 20 inputs of that kind in a loop from a fixed seed or a fixed list that covers the edges (empty, one element, many, the boundary values), assert the correct behaviour on each, and put the failing input in the assertion message. Use the property library the repository already has if there is one; do not add a dependency.`;

/**
 * Pure: how many places besides the cited file a verifier looked at (S5): files opened with Read, plus searches
 * (Grep, Glob) aimed anywhere but the cited file alone. A search over the tree is how a verifier finds the callers,
 * so it counts; a first live run showed verifiers that listed five call sites from Grep and opened nothing.
 */
export const lookedBeyond = ({ tools, root, cited }: { tools: ToolUse[]; root: string; cited: string }): number => {
  const rel = (t: string): string => path.relative(path.resolve(root), path.resolve(root, t)).split(path.sep).join("/");
  const read = new Set(tools.filter((t) => t.name === "Read" && t.target !== "").map((t) => rel(t.target)).filter((f) => f !== cited && !f.startsWith("..")));
  const searches = tools.filter((t) => (t.name === "Grep" || t.name === "Glob") && rel(t.target) !== cited).length;
  return read.size + searches;
};

/** Pure: the verdict a verifier's reading supports (S5). `others` is null when tool use was not recorded: then nothing is judged. */
export const judgeVerifierReading = ({ others, required }: { others: number | null; required: number }): { ok: boolean; others: number | null } => ({ ok: others === null || required <= 0 || others >= required, others });

export const verifierReadLine = (required: number): string =>
  `\nReading is required, and a program checks it from your tool calls: look at least ${required} time${required === 1 ? "" : "s"} beyond the cited file before you rule: open a caller or what the line calls with Read, or search the tree for the callers with Grep. A "confirmed" or "refuted" from a verifier that looked less is recorded as unproven.\n`;

/**
 * Pure (S3): the diff with its line comments hidden. Only whole-line comments and comments that follow code after a
 * space are hidden; the marker stays, so a reviewer sees that something was said there. The file itself is not changed.
 */
export const maskDiffComments = ({ diff, language }: { diff: string; language: string }): string => {
  const mark = /python/i.test(language) ? "#" : "//";
  const esc = mark.replace(/[/#]/g, "\\$&");
  const whole = new RegExp(`^([+\\- ]\\s*)${esc}(?!/).*$`);
  const tail = new RegExp(`^([+\\- ].*?[;,{})\\]\\w"'\`]\\s+)${esc}\\s.*$`);
  return diff
    .split("\n")
    .map((line) => (/^(\+\+\+|---|@@|diff |index )/.test(line) ? line : line.replace(whole, `$1${mark} (comment hidden)`).replace(tail, `$1${mark} (comment hidden)`)))
    .join("\n");
};

/** Pure (S1): the local dismissals still to verify once one sampled dismissal was found to be a bug. */
export const escalation = <T extends { cite: { file: string; line: number } }>({ local, verified, anyWrong, max }: { local: T[]; verified: T[]; anyWrong: boolean; max: number }): T[] =>
  !anyWrong
    ? []
    : local
        .filter((l) => !verified.some((v) => v.cite.file === l.cite.file && v.cite.line === l.cite.line))
        .filter((l, i, all) => all.findIndex((o) => o.cite.file === l.cite.file && o.cite.line === l.cite.line) === i)
        .slice(0, max);
