// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { generatedCheck, type GeneratedSpec } from "./generated.ts";
import { protectedCheck } from "./protected.ts";

/**
 * Checks that Ratchet runs itself, in place of a shell command. A config names one as `"command": "builtin:<name>"`;
 * it sees the files the check covers (at a turn end, the changed files that match its `when`) and answers like a
 * command would: an exit status and output lines, each line naming the file it is about.
 */
export type BuiltinRun = { status: number; output: string };

const BUILTIN = /^builtin:([a-z][a-z0-9-]*)$/;
export const builtinName = (command: string): string | null => BUILTIN.exec(command.trim())?.[1] ?? null;

/** The text files the LF check covers unless a config says otherwise. */
export const LF_WHEN = ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs", "**/*.py", "**/*.pyi", "**/*.json", "**/*.md", "**/*.yml", "**/*.yaml", "**/*.css", "**/*.html", "**/*.sh", "**/*.toml"];

export type EolAttrs = { text: string; eol: string };

/** Pure: the carriage returns in a file: those that end a line (CR LF), and bare ones that git never converts. */
export const countCr = (bytes: Buffer): { crlf: number; bare: number } => {
  let crlf = 0;
  let bare = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] !== 13) continue;
    if (bytes[i + 1] === 10) crlf += 1;
    else bare += 1;
  }
  return { crlf, bare };
};

/**
 * Pure: will this file be stored with carriage returns? "skip" when it may hold them: binary (a NUL byte, or `-text`),
 * or `eol=crlf` on purpose (a .bat file). A bare CR is never converted. CR LF is turned into LF on add by a `text`
 * attribute or `eol=lf`; by `text=auto` or core.autocrlf only when the stored copy (`indexEol`, from
 * `git ls-files --eol`) has no CR LF yet, since git keeps a file that is already stored with CR LF as it is.
 */
export const lfVerdict = ({ bytes, attrs, autocrlf, indexEol = "" }: { bytes: Buffer; attrs: EolAttrs; autocrlf: string; indexEol?: string }): "ok" | "cr" | "skip" => {
  if (attrs.eol === "crlf" || attrs.text === "unset" || bytes.includes(0)) return "skip";
  const { crlf, bare } = countCr(bytes);
  if (bare > 0) return "cr";
  if (crlf === 0) return "ok";
  if (attrs.text === "set" || attrs.eol === "lf") return "ok";
  const storedCrlf = indexEol === "crlf" || indexEol === "mixed";
  if (attrs.text === "auto" && !storedCrlf) return "ok";
  if (attrs.text === "unspecified" && (autocrlf === "true" || autocrlf === "input") && !storedCrlf) return "ok";
  return "cr";
};

/** Pure: `git ls-files --eol -z` output as the stored line ending per file ("lf", "crlf", "mixed", "none", "-text"). */
export const parseIndexEol = (out: string): Map<string, string> => {
  const map = new Map<string, string>();
  for (const entry of out.split("\0")) {
    const m = /^i\/(\S*)\s+w\/\S*\s+attr\/[^\t]*\t(.+)$/s.exec(entry);
    if (m?.[2] !== undefined) map.set(m[2], m[1] ?? "");
  }
  return map;
};

const git = (root: string, args: string[], input?: string): string => {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  } catch {
    return "";
  }
};

/** Pure: `git check-attr -z text eol` output as attributes per file. */
export const parseAttrs = (out: string): Map<string, EolAttrs> => {
  const parts = out.split("\0");
  const map = new Map<string, EolAttrs>();
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const [file, attr, value] = [parts[i] ?? "", parts[i + 1] ?? "", parts[i + 2] ?? ""];
    const have = map.get(file) ?? { text: "unspecified", eol: "unspecified" };
    if (attr === "text") have.text = value;
    if (attr === "eol") have.eol = value;
    map.set(file, have);
  }
  return map;
};

/** A regular file only: a folder, a submodule or a symbolic link (git stores the link, not its target) is not judged. */
const regularFile = (abs: string): boolean => {
  try {
    return fs.lstatSync(abs).isFile();
  } catch {
    return false;
  }
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The LF check: names each file that would be stored with carriage returns, and how to rewrite it. Past `deadline`
 * (milliseconds since the epoch) it stops and answers exit 124, like a command that ran out of time.
 */
export const lfCheck = ({ root, files, deadline = Infinity }: { root: string; files: string[]; deadline?: number }): BuiltinRun => {
  const present = files.filter((f) => regularFile(path.join(root, f)));
  if (present.length === 0) return { status: 0, output: "" };
  const attrs = parseAttrs(git(root, ["check-attr", "-z", "--stdin", "text", "eol"], `${present.join("\0")}\0`));
  // No paths on the command line: a few thousand would pass the length limit of a Windows command.
  const indexEol = parseIndexEol(git(root, ["ls-files", "--eol", "-z"]));
  const autocrlf = git(root, ["config", "--type=bool-or-str", "core.autocrlf"]).trim().toLowerCase();
  const bad: string[] = [];
  for (const file of present) {
    if (Date.now() > deadline) return { status: 124, output: "builtin:lf ran out of time" };
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(path.join(root, file));
    } catch {
      continue;
    }
    if (lfVerdict({ bytes, attrs: attrs.get(file) ?? { text: "unspecified", eol: "unspecified" }, autocrlf, indexEol: indexEol.get(file) ?? "" }) !== "cr") continue;
    const { crlf, bare } = countCr(bytes);
    const what = [crlf > 0 ? `${plural(crlf, "line ends", "lines end")} in CR LF` : "", bare > 0 ? `${plural(bare, "bare CR", "bare CRs")} (a CR with no LF after it)` : ""].filter(Boolean).join(" and ");
    bad.push(`${file}: ${what}; this project stores LF. Rewrite the file with LF endings (in Python open it with newline="\\n"; in Node write the text with \\r\\n and \\r replaced by \\n).`);
  }
  return bad.length === 0 ? { status: 0, output: "" } : { status: 1, output: bad.join("\n") };
};

/** Runs a built-in check on the files it covers. An unknown name could not run: exit 127, like a missing command. */
export const runBuiltin = ({ command, root, files, deadline, head, spec = {} }: { command: string; root: string; files: string[]; deadline?: number; /** The session's baseline commit, for how to put a file back. */ head?: string | null; /** The check's own settings, for builtin:generated. */ spec?: GeneratedSpec }): BuiltinRun => {
  const name = builtinName(command);
  if (name === "lf") return lfCheck({ root, files, ...(deadline !== undefined ? { deadline } : {}) });
  if (name === "protected") return protectedCheck({ root, files, head: head ?? null });
  if (name === "generated") return generatedCheck({ root, files, spec, ...(deadline !== undefined ? { deadline } : {}) });
  return { status: 127, output: `${command}: command not found (Ratchet has no built-in check by that name; it knows builtin:lf, builtin:protected and builtin:generated)` };
};

/** Which files a built-in is tried on before it is mapped: every tracked file it covers, or only those changed now. */
export const trialScope = (command: string): "tracked" | "changed" => (builtinName(command) === "protected" ? "changed" : "tracked");

export const PROTECTED_FOLDERS = ["fixtures", "__snapshots__", "golden", "testdata"];

/** Pure: the tracked folders that look like a recorded reference, by name, outermost first and none inside another. */
export const protectedFolders = (files: string[]): string[] => {
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    const at = parts.findIndex((p, i) => i < parts.length - 1 && PROTECTED_FOLDERS.includes(p));
    if (at >= 0 && !parts.includes("node_modules")) dirs.add(parts.slice(0, at + 1).join("/"));
  }
  return [...dirs].sort();
};
