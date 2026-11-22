import { execFileSync } from "node:child_process";
import { forShell } from "../shellcmd.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportTree } from "../git.ts";
import type { ModelFn } from "../types.ts";
import { fixFiles, reads_like_a_fix, type AutoState, type Change } from "./auto.ts";
import { matchesAny } from "./rules.ts";
import { projectDir, projectFile, readConfig, readJson, writeJson, writeText, type CheckCmd, type ProjectConfig } from "./state.ts";

/**
 * The loop writes a test (T8 made autonomous). For one fix commit a model is asked for a regression test, and a
 * program then decides whether it is kept. The test must FAIL BY A FAILED ASSERTION in the tree before the fix and
 * PASS in the tree after it, both exported to a temporary folder. Kept is refused as well when the test leans on a
 * name the fix itself added (it would fail before for the wrong reason), when it changed any file of the tree it
 * ran in, and when it does not pass in the project as it is now. A test that fails any of this is thrown away.
 *
 * Kept tests live outside the repository, beside the project's rules. They find the code through the working
 * directory, so the same file runs in the exported trees and in the repository. One model call a pass at most.
 * It has its own switch per project (`autoGuards`), because it spends model tokens and runs written code.
 */
export type Ran = "passes" | "fails" | "errors";
export type GuardClass = "kept" | "untestable" | "refused" | "model-failed" | "setup-failed" | "too-wide" | "no-command" | "new-name" | "errors-before" | "passes-both" | "fails-both" | "not-passing-after" | "wrote-files" | "stale-now";
export type GuardTry = { commit: string; kept: boolean; cls: GuardClass; reason: string; name?: string };
export type GuardFile = { file: string; before: string; after: string };

const SCRIPT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const PY = /\.pyi?$/;
const isTestPath = (file: string): boolean => /(^|\/)(tests?|__tests__)\/|\.test\.|(^|\/)test_[^/]*\.py$|_test\.py$/.test(file);
/** Written code is run unattended: anything that starts a process, reaches the network or deletes is refused unread. */
const REFUSED = /node_modules|child_process|\bsubprocess\b|os\.system|\bexec(File)?(Sync)?\(|\beval\(|\bfetch\(|https?:\/\/|\brequire\(["'](net|http|https|dgram)["']|node:(net|http|https|dgram)|rmSync|rmdirSync|unlinkSync|\brm\(|shutil\.rmtree|os\.(remove|unlink|rmdir)|\bsocket\b|urllib|requests\./;
/** How a test runner or an interpreter says that an assertion failed, as against the test not loading or throwing. */
const ASSERTION = /ERR_ASSERTION|AssertionError/;

/** Pure: the request for one regression test. The file is found through the working directory, so the test can live anywhere. */
export const guardPrompt = ({ file, diff, after, others = [], style }: { file: string; diff: string; after: string; others?: { file: string; diff: string }[]; /** How tests are written in this project, where it is not plain Node or plain Python. */ style?: string[] }): string => {
  const how = style
    ? style
    : PY.test(file)
    ? [
        "Write it as a plain Python script: assert statements at module level, no test framework. A failed assert must end the script with a non-zero exit code.",
        `The script is run with the repository root as the working directory. Make the module importable yourself, first thing: import os, sys; sys.path.insert(0, os.path.join(os.getcwd(), ${JSON.stringify(path.posix.dirname(file))})).`,
        "Use the standard library and the repository's own code only.",
      ]
    : [
        'Write it with node:test and node:assert/strict (import { test } from "node:test").',
        `The test is run with the repository root as the working directory. Load the module under test like this, and not by a relative path: const mod = await import(pathToFileURL(path.join(process.cwd(), ${JSON.stringify(file)})).href); with path from "node:path" and pathToFileURL from "node:url".`,
        "Use Node's built-in modules and the repository's own code only.",
      ];
  return [
    "You are writing one regression test for a bug that has been fixed. Below are the diff of the fix and the file as it is after the fix.",
    "The test must FAIL on the code as it was before the fix and PASS on the code after it. A program will run it on both and throw it away if it does not.",
    ...how,
    "The failure before the fix must be a failed assertion about behaviour. A test that fails before the fix only because it does not load, or because it calls a function, class or name that the fix itself added, is thrown away: use only names that already existed before the fix. If the old code threw where the new code does not, assert that it does not throw.",
    "Do not start a process, do not use the network, do not delete or write files. Keep it under 80 lines. Test the behaviour the fix changed, through what the module exports; do not read the source text.",
    "Reply with the test file only, in one fenced code block. If the fix cannot be tested this way (nothing exported changes behaviour, or it needs a service), reply with the single word UNTESTABLE.",
    ...(others.length > 0 ? ["The same fix changed other files too; their diffs are below. If the behaviour that changed is easier to reach through one of them, load that file the same way, through its own path from the working directory."] : []),
    `\nFile: ${file}\n\nDiff of the fix:\n${diff.slice(0, 12_000)}\n\nThe file after the fix:\n${after.slice(0, 24_000)}`,
    ...others.map((o) => `\nAlso changed: ${o.file}\n${o.diff.slice(0, 6_000)}`),
  ].join("\n");
};
/** The request text is part of the measure: a sweep records which one it ran with. */
export const PROMPT_ID = crypto.createHash("sha1").update(guardPrompt({ file: "a.ts", diff: "", after: "", others: [{ file: "b.ts", diff: "" }] }) +guardPrompt({ file: "a.py", diff: "", after: "" })).digest("hex").slice(0, 8);

/** Pure: the code in a reply, or null when the reply declines or holds none. */
export const extractCode = (reply: string): string | null => {
  if (/^\s*UNTESTABLE\b/.test(reply)) return null;
  const fenced = /```[\w-]*\r?\n([\s\S]*?)```/.exec(reply);
  const code = (fenced ? fenced[1] : reply)?.trim() ?? "";
  return code.length > 20 ? `${code}\n` : null;
};

/** Pure: why written code is not run, or null when it may be. */
export const refusal = (code: string): string | null => {
  const hit = REFUSED.exec(code);
  return hit ? `it uses ${hit[0]}, and written code that starts a process, reaches the network, deletes or names the installed packages folder is not run` : null;
};

/** Pure: the names a file defines at its top level or exports. */
export const topNames = (file: string, text: string): Set<string> => {
  const out = new Set<string>();
  const patterns = PY.test(file) ? [/^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm, /^([A-Za-z_]\w*)\s*(?::[^=\n]+)?=/gm] : [/export\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g, /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/gm];
  for (const p of patterns) for (const m of text.matchAll(p)) if (m[1]) out.add(m[1]);
  return out;
};

/** Pure: a name the fix added that the written test uses, or null. Such a test fails before the fix for the wrong reason. */
export const leansOnNew = ({ files, code }: { files: GuardFile[]; code: string }): string | null => {
  for (const f of files) {
    const before = topNames(f.file, f.before);
    for (const name of topNames(f.file, f.after)) if (!before.has(name) && name.length > 2 && new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`).test(code)) return name;
  }
  return null;
};

const runIn = (cwd: string, command: string, timeoutS: number): Ran => {
  try {
    const words = /[&|<>"'%$]/.test(command) ? null : command.split(/\s+/).filter(Boolean);
    const opts = { cwd, encoding: "utf8" as const, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024, timeout: timeoutS * 1000, windowsHide: true, env: { ...process.env, RATCHET_CHILD: "1" } };
    if (words && words[0]) execFileSync(words[0], words.slice(1), opts);
    else execFileSync(forShell(command), { ...opts, shell: true });
    return "passes";
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    // For reading by hand why a test did not load: the output is appended to the named file, where one is named.
    if (process.env.RATCHET_GUARD_OUT) fs.appendFileSync(process.env.RATCHET_GUARD_OUT, `--- ${command}\n${err.stdout ?? ""}\n${err.stderr ?? ""}\n`);
    return ASSERTION.test(`${err.stdout ?? ""}\n${err.stderr ?? ""}`) ? "fails" : "errors";
  }
};

/** Every file under a folder with its size and time, the guard's own folder and caches left out. */
const stamp = (dir: string): string => {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".ratchet-guard" || e.name === "node_modules" || e.name === "__pycache__" || e.name === ".git") continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        const s = fs.statSync(full);
        out.push(`${path.relative(dir, full)}:${s.size}:${s.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return crypto.createHash("sha1").update(out.sort().join("\n")).digest("hex");
};

const rootFilesAt = (root: string, rev: string): string[] => execFileSync("git", ["-C", root, "ls-tree", "--name-only", rev], { encoding: "utf8", windowsHide: true }).split(/\r?\n/).filter((f) => /\.(json|toml|cfg|ini|mjs|cjs|js|ts|py)$/.test(f));
const topsOf = (files: string[]): string[] => [...new Set(files.map((f) => f.split("/")[0] ?? "").filter(Boolean))];

/**
 * Runs one written test in the tree of one commit, exported to a temporary folder. Only the top folders named,
 * and the files at the root, are exported. `overlay` writes file texts over the export (a change that is not a commit).
 */
export const runAt = ({ root, rev, files, testName, code, template, overlay = [], timeoutS = 60, full = false, undo }: { root: string; rev: string; files: string[]; testName: string; code: string; template: string; overlay?: { file: string; text: string }[]; timeoutS?: number; /** Export every tracked folder, not only those the fix touched. */ full?: boolean; /** A patch taken back out of the exported tree before the test runs (the fix, undone). */ undo?: string }): { ran: Ran; wrote: boolean; undone?: boolean } => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-guard-"));
  const links: string[] = [];
  try {
    const dest = path.join(work, "t");
    const everything = (): string[] => execFileSync("git", ["-C", root, "ls-tree", "--name-only", rev], { encoding: "utf8", windowsHide: true }).split(/\r?\n/).filter(Boolean);
    exportTree({ repo: root, commit: rev, dest, paths: full ? everything() : [...new Set([...topsOf(files), ...rootFilesAt(root, rev)])] });
    // Installed packages are not in git. Where the repository has them, the exported tree is given a link to each
    // folder of them (the root's, and one beside each package file two levels down), so an import of a package resolves.
    for (const rel of installedFolders(root)) {
      const at = path.join(dest, rel);
      if (!fs.existsSync(path.dirname(at)) || fs.existsSync(at)) continue;
      try {
        fs.symlinkSync(path.join(root, rel), at, "junction");
        links.push(at);
      } catch {
        // No link, then: the test runs without the packages.
      }
    }
    for (const o of overlay) writeText(path.join(dest, o.file), o.text);
    if (undo !== undefined) {
      const patch = path.join(work, "undo.patch");
      fs.writeFileSync(patch, undo);
      try {
        execFileSync("git", ["apply", "-R", "--whitespace=nowarn", patch], { cwd: dest, stdio: "ignore", windowsHide: true });
      } catch {
        // The code has moved on: the fix can no longer be taken out as it was.
        return { ran: "errors", wrote: false, undone: false };
      }
    }
    // A command may say where the project's own runner looks for tests: "[place <folder>] <command>". The test is
    // then written there in the exported tree (never in the repository), and {name} stands for its file name.
    // "[lay <commit> <file> ...]" before it lays the project's test setup files, as they are at that commit, into a
    // tree that does not have them yet (an older tree, from before the project had that setup).
    const laid = /^\[lay (\S+)((?: [^\]\s]+)+)\]\s*/.exec(template);
    const command = laid ? template.slice(laid[0].length) : template;
    for (const file of laid ? (laid[2] ?? "").trim().split(" ") : []) {
      if (fs.existsSync(path.join(dest, file))) continue;
      writeText(path.join(dest, file), execFileSync("git", ["-C", root, "show", `${laid?.[1]}:${file}`], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 }));
    }
    const placed = /^\[place ([^\]]+)\]\s*/.exec(command);
    const rel = path.posix.join(placed?.[1] ?? ".ratchet-guard", testName);
    writeText(path.join(dest, rel), code);
    const before = stamp(dest);
    const ran = runIn(dest, command.replace(/^\[place [^\]]+\]\s*/, "").split("{test}").join(rel).split("{name}").join(testName), timeoutS);
    return { ran, wrote: stamp(dest) !== before, ...(undo !== undefined ? { undone: true } : {}) };
  } finally {
    // The links go first and by themselves, so that removing the folder can never reach what they point at.
    for (const l of links) fs.rmSync(l, { force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
};

/** The folders of installed packages in a repository: at its root and beside package files up to two levels down. */
const installedFolders = (root: string): string[] => {
  const out: string[] = [];
  const look = (rel: string, depth: number): void => {
    const dir = path.join(root, rel);
    if (fs.existsSync(path.join(dir, "node_modules"))) out.push(path.join(rel, "node_modules"));
    if (depth === 0) return;
    let names: fs.Dirent[] = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) look(path.join(rel, e.name), depth - 1);
  };
  look("", 2);
  return out;
};

/** Runs one written test in the tree before a fix and in the tree after it. */
export const proveGuard = ({ root, commit, files, testName, code, template, timeoutS = 60 }: { root: string; commit: string; files: string[]; testName: string; code: string; template: string; timeoutS?: number }): { before: Ran; after: Ran; wrote: boolean } => {
  const b = runAt({ root, rev: `${commit}^`, files, testName, code, template, timeoutS });
  const a = runAt({ root, rev: commit, files, testName, code, template, timeoutS });
  return { before: b.ran, after: a.ran, wrote: b.wrote || a.wrote };
};

/** Pure: what a proof on two sides means. */
export const judge = ({ before, after, wrote }: { before: Ran; after: Ran; wrote: boolean }): { cls: GuardClass; reason: string } => {
  if (wrote) return { cls: "wrote-files", reason: "the written test changed files of the tree it ran in" };
  if (before === "fails" && after === "passes") return { cls: "kept", reason: "failed by an assertion before the fix, passed after it" };
  const said = `the written test ${before} before the fix and ${after} after it; it must fail before and pass after`;
  if (after !== "passes") return { cls: before === "passes" ? "not-passing-after" : before === "errors" && after === "errors" ? "errors-before" : "fails-both", reason: said };
  return before === "passes" ? { cls: "passes-both", reason: said } : { cls: "errors-before", reason: `${said} (before the fix it did not fail by an assertion: it did not load, or it threw)` };
};

const git = (root: string, args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
const showOr = (root: string, spec: string): string => {
  try {
    return git(root, ["show", spec]);
  } catch {
    return "";
  }
};

export type Attempt = { cls: GuardClass; reason: string; code?: string; testName?: string; files: string[] };

/**
 * One fix commit, one model call, one verdict: everything short of mapping. Used by the loop and by the sweep, so
 * what the sweep measures is what the loop does. `exclude` and the command templates come from the caller.
 */
export const attemptGuard = async ({ root, commit, model, exclude = [], only = [], style, templates }: { root: string; commit: string; model: ModelFn; exclude?: string[]; /** Where given, only files matching one of these count. */ only?: string[]; style?: string[]; templates: { py?: string; ts?: string } }): Promise<Attempt> => {
  const short = commit.slice(0, 7);
  const fix = fixFiles(root, commit).filter((f) => !matchesAny(f.file, exclude) && (only.length === 0 || matchesAny(f.file, only)));
  const files = fix.map((f) => f.file);
  const templateFor = (file: string): string | undefined => (PY.test(file) ? templates.py : SCRIPT.test(file) ? templates.ts : undefined);
  // The target is a file of the code, not one of the fix's own tests, where there is a choice.
  const target = fix.find((f) => templateFor(f.file) && !isTestPath(f.file)) ?? fix.find((f) => templateFor(f.file));
  if (fix.length > 3) return { cls: "too-wide", reason: "the fix touches more than three source files", files };
  if (!target) return { cls: "no-command", reason: "no test command is set for the language of the fixed file", files };
  const template = templateFor(target.file) as string;
  const testName = PY.test(target.file) ? `test_guard_${short}.py` : `guard-${short}.test.${/\.(ts|tsx|mts|cts)$/.test(target.file) ? "ts" : "mjs"}`;
  let reply = "";
  try {
    reply = await model({ prompt: guardPrompt({ file: target.file, diff: git(root, ["diff", `${commit}^`, commit, "--", target.file]), after: target.after, ...(style ? { style } : {}), others: fix.filter((f) => f.file !== target.file && !isTestPath(f.file)).map((f) => ({ file: f.file, diff: git(root, ["diff", `${commit}^`, commit, "--", f.file]) })) }), cwd: root, label: `guard-${short}` });
  } catch (e) {
    return { cls: "model-failed", reason: `the model call failed (${e instanceof Error ? e.message.split("\n")[0]?.slice(0, 120) : "unknown"})`, files };
  }
  const code = extractCode(reply);
  if (code === null) return { cls: "untestable", reason: "the model said the fix cannot be tested through what the module exports", files };
  const refused = refusal(code);
  if (refused) return { cls: "refused", reason: refused, files, code, testName };
  const added = leansOnNew({ files: fix.map((f) => ({ file: f.file, before: showOr(root, `${commit}^:${f.file}`), after: f.after })), code });
  if (added) return { cls: "new-name", reason: `the written test uses ${added}, a name the fix itself added, so its failure before the fix would prove nothing`, files, code, testName };
  try {
    return { ...judge(proveGuard({ root, commit, files, testName, code, template })), files, code, testName };
  } catch (e) {
    return { cls: "setup-failed", reason: `the two trees could not be set up (${e instanceof Error ? e.message.split("\n")[0]?.slice(0, 120) : "unknown"})`, files, code, testName };
  }
};

/** A change a session made after a correction given in chat, kept by the loop for one written test. */
export type GuardJob = { id: string; time: string; head: string; files: GuardFile[] };
const jobsDir = (root: string): string => path.join(projectDir(root), "guard-jobs");
export const addGuardJob = (root: string, job: GuardJob): void => writeJson(path.join(jobsDir(root), `${job.id}.json`), job);
const nextJob = (root: string): GuardJob | null => {
  try {
    const name = fs.readdirSync(jobsDir(root)).filter((f) => f.endsWith(".json")).sort()[0];
    return name ? readJson<GuardJob | null>(path.join(jobsDir(root), name), null) : null;
  } catch {
    return null;
  }
};

/** Pure: a plain line diff of two texts, enough for a model to see what changed. The words of the chat are never part of it. */
export const plainDiff = (before: string, after: string): string => {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  return [`@@ line ${head + 1} @@`, ...a.slice(head, a.length - tail).map((l) => `-${l}`), ...b.slice(head, b.length - tail).map((l) => `+${l}`)].join("\n");
};

const attemptJob = async ({ root, job, model, templates }: { root: string; job: GuardJob; model: ModelFn; templates: { py?: string; ts?: string } }): Promise<Attempt> => {
  const files = job.files.map((f) => f.file);
  const templateFor = (file: string): string | undefined => (PY.test(file) ? templates.py : SCRIPT.test(file) ? templates.ts : undefined);
  const target = job.files.find((f) => templateFor(f.file));
  if (job.files.length > 3) return { cls: "too-wide", reason: "the change touches more than three source files", files };
  if (!target) return { cls: "no-command", reason: "no test command is set for the language of the changed file", files };
  const template = templateFor(target.file) as string;
  const short = job.id.replace(/[^a-z0-9]/gi, "").slice(-7);
  const testName = PY.test(target.file) ? `test_guard_chat_${short}.py` : `guard-chat-${short}.test.${/\.(ts|tsx|mts|cts)$/.test(target.file) ? "ts" : "mjs"}`;
  let reply = "";
  try {
    reply = await model({ prompt: guardPrompt({ file: target.file, diff: plainDiff(target.before, target.after), after: target.after, others: job.files.filter((f) => f.file !== target.file).map((f) => ({ file: f.file, diff: plainDiff(f.before, f.after) })) }), cwd: root, label: `guard-chat-${short}` });
  } catch (e) {
    return { cls: "model-failed", reason: `the model call failed (${e instanceof Error ? e.message.split("\n")[0]?.slice(0, 120) : "unknown"})`, files };
  }
  const code = extractCode(reply);
  if (code === null) return { cls: "untestable", reason: "the model said the change cannot be tested through what the module exports", files };
  const refused = refusal(code);
  if (refused) return { cls: "refused", reason: refused, files, code, testName };
  const added = leansOnNew({ files: job.files, code });
  if (added) return { cls: "new-name", reason: `the written test uses ${added}, a name the change itself added`, files, code, testName };
  try {
    const side = (which: "before" | "after") => runAt({ root, rev: job.head, files, testName, code, template, overlay: job.files.map((f) => ({ file: f.file, text: f[which] })) });
    const b = side("before");
    const a = side("after");
    return { ...judge({ before: b.ran, after: a.ran, wrote: b.wrote || a.wrote }), files, code, testName };
  } catch (e) {
    return { cls: "setup-failed", reason: `the two trees could not be set up (${e instanceof Error ? e.message.split("\n")[0]?.slice(0, 120) : "unknown"})`, files, code, testName };
  }
};

/**
 * One step: a change that followed a correction in chat comes first, then the oldest fix commit since the last step
 * that has not been tried. `only` names a commit to try whatever the pointer says (a person asking for a guard of one fix).
 */
export const writeGuard = async ({ root, model, only, now = () => new Date().toISOString(), memory = () => Math.round(100 * (1 - os.freemem() / os.totalmem())) }: { root: string; model: ModelFn; only?: string; now?: () => string; memory?: () => number }): Promise<{ tried: GuardTry | null; change: Change | null; note: string | null }> => {
  const none = (note: string | null = null) => ({ tried: null, change: null, note });
  const config = readConfig(root);
  if (!config.auto || !config.autoGuards) return none();
  if (memory() >= 90) return none(`memory is at ${memory()}%: no test was written this pass.`);
  const dir = projectDir(root);
  const statePath = path.join(dir, "auto.json");
  const state = readJson<AutoState>(statePath, { root });
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  const tried = state.guardTried ?? [];
  const templates = config.autoTest ?? {};
  const job = only ? null : nextJob(root);
  let commit = only ? git(root, ["rev-parse", only]).trim() : "";
  if (!only && !job) {
    if (!state.guardPointer) {
      // Switched on: the fixes already there are not swept.
      writeJson(statePath, { ...readJson<AutoState>(statePath, { root }), guardPointer: head });
      return none();
    }
    const fresh = git(root, ["log", "--no-merges", "--reverse", "--format=%H\t%s", `${state.guardPointer}..${head}`]).split(/\r?\n/).filter(Boolean).map((l) => l.split("\t")).filter(([h = "", s = ""]) => reads_like_a_fix(s) && !tried.includes(h));
    commit = fresh[0]?.[0] ?? "";
    if (!commit) {
      writeJson(statePath, { ...readJson<AutoState>(statePath, { root }), guardPointer: head, guardTried: [] });
      return none();
    }
  }
  const what = job ? `the change after a correction given in chat at ${job.time.slice(0, 16).replace("T", " ")}` : `fix ${commit.slice(0, 8)}`;
  const done = (t: GuardTry, change: Change | null): { tried: GuardTry; change: Change | null; note: string | null } => {
    if (job) fs.rmSync(path.join(jobsDir(root), `${job.id}.json`), { force: true });
    else {
      const latest = readJson<AutoState>(statePath, { root });
      writeJson(statePath, { ...latest, guardTried: [...new Set([...(latest.guardTried ?? []), commit])].slice(-200) });
    }
    return { tried: t, change, note: t.kept ? null : `${what}: no test was kept: ${t.reason}.` };
  };
  const attempt = job ? await attemptJob({ root, job, model, templates }) : await attemptGuard({ root, commit, model, exclude: config.autoExclude ?? [], templates });
  const id = job ? job.id : commit;
  if (attempt.cls !== "kept" || !attempt.code || !attempt.testName) return done({ commit: id, kept: false, cls: attempt.cls, reason: attempt.reason }, null);
  const stored = path.join(dir, "guards", attempt.testName).split(path.sep).join("/");
  const template = (PY.test(attempt.testName) ? templates.py : templates.ts) as string;
  const command = template.split("{test}").join(stored);
  // It must also pass in the project as it is now, and leave it as it was: a test that is stale on arrival is not mapped.
  writeText(stored, attempt.code);
  const statusBefore = git(root, ["status", "--porcelain"]);
  const nowRan = runIn(root, command, 60);
  if (nowRan !== "passes" || git(root, ["status", "--porcelain"]) !== statusBefore) {
    fs.rmSync(stored, { force: true });
    return done({ commit: id, kept: false, cls: nowRan !== "passes" ? "stale-now" : "wrote-files", reason: nowRan !== "passes" ? `it failed before and passed after, but it ${nowRan} in the project as it is now, so it is stale and was not mapped` : "it changed files in the working tree" }, null);
  }
  const name = job ? `guard-chat-${attempt.testName.replace(/^.*chat[-_]/, "").replace(/\..*$/, "")}` : `guard-${commit.slice(0, 7)}`;
  const entry: CheckCmd = { name, when: attempt.files, command, timeoutS: 60, origin: "auto", stage: "trial" };
  const configFile = projectFile(root, "config.json");
  const latest: ProjectConfig = readConfig(root);
  if (!(latest.tests ?? []).some((t) => t.name === name)) writeJson(configFile, { ...latest, tests: [...(latest.tests ?? []), entry] });
  return done({ commit: id, kept: true, cls: "kept", reason: "failed before the fix, passed after it", name }, { time: now(), what: `test ${name} written for ${what} and kept: a program saw it fail by an assertion in the tree before and pass in the tree after, and pass in the project as it is now. It is on trial: a failure is reported and does not hold a turn. It runs when one of ${entry.when?.join(", ")} changes. File: ${stored}`, undo: `remove the entry named ${name} from tests in ${configFile}` });
};

/** Adds what a guard step did to the loop's log and notes, in the form the loop itself writes. */
export const recordGuard = ({ root, change, note, now = () => new Date().toISOString() }: { root: string; change: Change | null; note: string | null; now?: () => string }): void => {
  const dir = projectDir(root);
  if (change) fs.appendFileSync(path.join(dir, "auto-log.jsonl"), `${JSON.stringify(change)}\n`);
  if (change || note) fs.appendFileSync(path.join(dir, "auto-notes.md"), `${[`## ${now()}`, ...(change ? [`- CHANGED: ${change.what} Undo: ${change.undo}`] : []), ...(note ? [`- noted: ${note}`] : []), ""].join("\n")}\n`);
};
