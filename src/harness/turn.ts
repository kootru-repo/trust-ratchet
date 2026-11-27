// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { forShell } from "../shellcmd.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import os from "node:os";
import path from "node:path";
import { exportTree } from "../git.ts";
import { broke } from "../layer0.ts";
import { judgeHatches, judgeRules, matchesAny, type Finding, type Rule } from "./rules.ts";
import { checkBoundaries } from "./boundaries.ts";
import { builtinName, runBuiltin } from "./builtins.ts";
import { judgeComments, type CommentsConfig } from "./comments.ts";
import { baselineComments, baselineHatches, changedFiles, currentHead, isClean, readSource, readTurn, trackedFiles, writeTurn, type Baseline } from "./session.ts";
import { projectDir, projectFile, readConfig, readJson, slug, writeJson, writeText, type CheckCmd, type Mode } from "./state.ts";
import { CUT_BY_BUDGET, OUT_OF_BUDGET, effectiveLimits, nextWaits, skipCause } from "./limits.ts";

export const readRules = (root: string): Rule[] => readJson<Rule[]>(projectFile(root, "rules.json"), []);

const JSON_WITH_COMMENTS = /(^|\/)(tsconfig|jsconfig)[^/]*\.json$|(^|\/)\.vscode\/|(^|\/)\.devcontainer\/|\.jsonc$|(^|\/)\.eslintrc|(^|\/)\.babelrc|(^|\/)\.claude\//;
const PY_PARSE = "import ast,sys\np=sys.argv[1]\ntry:\n    ast.parse(open(p,'rb').read(),p)\nexcept SyntaxError as e:\n    print('line %s: %s' % (e.lineno, e.msg)); sys.exit(1)\n";

/**
 * Does the file parse? Answers with a finding, with null (it parses), or with "not-run" when no parser is at hand.
 * Nothing is written next to the file: Python is parsed in memory, TypeScript by Node's own type stripper.
 */
export const syntaxCheck = ({ file, abs, content }: { file: string; abs: string; content: string }): Finding | null | "not-run" => {
  const bad = (detail: string): Finding => ({ kind: "syntax", file, title: "does not parse", detail, fix: "Correct the syntax at that line before any other change: nothing else can be checked until the file parses.", blocking: true });
  if (/\.(ts|mts|cts)$/.test(file) && !file.endsWith(".d.ts")) {
    try {
      stripTypeScriptTypes(content);
      return null;
    } catch (e) {
      const err = e as { code?: string; message?: string };
      // Enums and the like are valid TypeScript that the stripper cannot erase: that is not a syntax error.
      return err.code === "ERR_INVALID_TYPESCRIPT_SYNTAX" ? bad((err.message ?? "").split("\n").slice(0, 6).join("\n")) : "not-run";
    }
  }
  if (/\.json$/.test(file) && !JSON_WITH_COMMENTS.test(file)) {
    try {
      JSON.parse(content.replace(/^\uFEFF/, ""));
      return null;
    } catch (e) {
      return bad((e as Error).message);
    }
  }
  const run = (cmd: string, args: string[]): Finding | null | "not-run" => {
    try {
      execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 8000, windowsHide: true });
      return null;
    } catch (e) {
      const err = e as { status?: number | null; stdout?: string; stderr?: string };
      if (err.status !== 1) return "not-run";
      return bad(`${err.stdout ?? ""}\n${err.stderr ?? ""}`.trim().split(/\r?\n/).filter((l) => l.trim() !== "").slice(0, 6).join("\n"));
    }
  };
  if (/\.pyi?$/.test(file)) return run("python", ["-I", "-c", PY_PARSE, abs]);
  if (/\.(js|mjs|cjs)$/.test(file)) return run(process.execPath, ["--check", abs]);
  return "not-run";
};

/** The fast checks on one file: does it parse, does it break a project rule, did the session add an escape hatch. */
export const fileFindings = ({ baseline, file, rules, comments }: { baseline: Baseline; file: string; rules: Rule[]; comments?: CommentsConfig }): { findings: Finding[]; ran: string[] } => {
  const abs = path.join(baseline.root, file);
  const content = readSource(abs);
  if (content === null) return { findings: [], ran: [] };
  const syntax = syntaxCheck({ file, abs, content });
  const findings: Finding[] = syntax !== null && syntax !== "not-run" ? [syntax] : [];
  findings.push(...judgeRules({ rules, file, content }), ...judgeHatches({ file, content, before: baselineHatches(baseline, file) }));
  const commentMode = comments?.mode ?? "off";
  if (comments && commentMode !== "off") findings.push(...judgeComments({ file, content, before: baselineComments(baseline, file), config: comments }));
  return { findings, ran: [syntax === "not-run" ? "syntax (no parser for this file type)" : "syntax", `${rules.filter((r) => matchesAny(file, r.files)).length} rules`, "escape hatches", ...(commentMode === "off" ? [] : [`comments (${commentMode})`])] };
};

export type Outcome = { kind: "check" | "test" | "driver"; name: string; command: string; status: "pass" | "fail" | "fail-elsewhere" | "not-run"; note: string; seconds: number };

const tailOf = (output: string, n: number): string => output.split(/\r?\n/).filter((l) => l.trim() !== "").slice(-n).join("\n");

/**
 * Pure: one command's result as an outcome and, when it says something about the session's work, a finding.
 * A command that could not run or ran out of time is "not-run": never a pass, never a failure.
 * A failure holds the turn only when it is the session's: its lines name a changed file, or the command is known to have passed before.
 */
export const judgeCommand = ({ check, kind, command, status, output, timedOut, changed, knownGreen, seconds }: { check: CheckCmd; kind: Outcome["kind"]; command: string; status: number; output: string; timedOut: boolean; changed: string[]; knownGreen: boolean; seconds: number }): { outcome: Outcome; finding: Finding | null } => {
  const base = { kind, name: check.name, command, seconds };
  const fix = kind === "check" ? "Fix what the command reports in the files you changed, then let it run again." : "Make the code pass: change the code, not the test, unless the test itself is wrong, and say so if it is.";
  if (timedOut) return { outcome: { ...base, status: "not-run", note: "did not finish inside its time limit" }, finding: null };
  if (status === 0) return { outcome: { ...base, status: "pass", note: "" }, finding: null };
  if (broke(output)) return { outcome: { ...base, status: "not-run", note: `could not run: ${tailOf(output, 2)}` }, finding: null };
  if (check.onlyChanged) {
    const mine = output.split(/\r?\n/).filter((l) => changed.some((f) => l.replace(/\\/g, "/").includes(f)));
    if (mine.length === 0) return { outcome: { ...base, status: "fail-elsewhere", note: "fails, but no line names a file this session changed" }, finding: null };
    return { outcome: { ...base, status: "fail", note: `${mine.length} lines about changed files` }, finding: { kind, title: `${check.name} reports ${mine.length} line${mine.length === 1 ? "" : "s"} about files you changed (${command})`, detail: mine.slice(0, 25).join("\n"), fix, blocking: true } };
  }
  const inherited = knownGreen ? "" : " It is not known to have passed before this session, so it does not hold the turn.";
  return { outcome: { ...base, status: "fail", note: knownGreen ? "passed before, fails now" : "not known to have passed before this session" }, finding: { kind, title: `${check.name} fails, exit ${status} (${command})`, detail: `${tailOf(output, 25)}${inherited ? `\n${inherited.trim()}` : ""}`, fix, blocking: knownGreen } };
};

const quote = (f: string): string => `"${f}"`;

type Ran = { status: number; output: string; timedOut: boolean };
const runCommand = ({ command, cwd, limitMs }: { command: string; cwd: string; limitMs: number }): Ran => {
  try {
    const output = execFileSync(forShell(command), { cwd, shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: limitMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, env: { ...process.env, RATCHET_CHILD: "1" } });
    return { status: 0, output, timedOut: false };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string; code?: string; signal?: string | null };
    return { status: e.status ?? 2, output: `${e.stdout ?? ""}\n${e.stderr ?? ""}`, timedOut: e.code === "ETIMEDOUT" || (e.status === null && e.signal !== null && e.signal !== undefined) };
  }
};

/** Above this many tracked files the baseline tree is not copied out: the answer stays "not known". */
export const MAX_EXPORT_FILES = 4000;

/**
 * Did this command pass before the session? Asked only when it fails now and nothing on record says.
 * The baseline commit is copied out with no history and the command is run there once. True: it passed, so the failure
 * is the session's. False: it failed there too. Null: not known (the tree was already changed at the baseline, the
 * repository is too large to copy, or the command could not run there, for example with no installed dependencies).
 */
export const passedAtBaseline = ({ baseline, command, limitMs }: { baseline: Baseline; command: string; limitMs: number }): boolean | null => {
  if (!baseline.clean || baseline.head === null || limitMs < 3000) return null;
  const dest = path.join(os.tmpdir(), "ratchet-work", `base-${slug(baseline.root).slice(-40)}-${baseline.head.slice(0, 10)}-${process.pid}`);
  try {
    if (trackedFiles(baseline.root).length > MAX_EXPORT_FILES) return null;
    exportTree({ repo: baseline.root, commit: baseline.head, dest, paths: ["."] });
    const ran = runCommand({ command, cwd: dest, limitMs });
    if (ran.timedOut) return null;
    if (ran.status === 0) return true;
    return broke(ran.output) ? null : false;
  } catch {
    return null;
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.rmSync(`${dest}.tar`, { force: true });
  }
};

type Green = Record<string, string>;
const greenFile = (root: string): string => path.join(projectDir(root), "green.json");

export type TurnResult = {
  root: string;
  changed: string[];
  findings: Finding[];
  outcomes: Outcome[];
  fileChecks: string[];
  /** True when nothing changed since the last run for this session, so nothing was run again. */
  repeated: boolean;
  notRun: string[];
  /** Wall-clock seconds of the whole turn check, and of the file checks that run before the budget starts. */
  wallS: number;
  fileS: number;
};

/**
 * Pure: mapped tests in the order they should be tried when only a few may run at a turn end. A test whose own file
 * changed comes first, then the test that names the fewest files (the one closest to the change). The order is otherwise kept.
 */
/** A test the harness wrote for a fix (a guard), as against a test of the project that it mapped or a person mapped. */
export const isWritten = (t: CheckCmd): boolean => t.origin === "auto" && t.name.startsWith("guard-");

export const nearestFirst = (tests: CheckCmd[], changed: string[], waits: Record<string, number> = {}): CheckCmd[] => {
  // A test the harness wrote for a fix names source files only, so its first file is not "its own": it comes after the project's tests.
  const own = (t: CheckCmd): number => (isWritten(t) ? 2 : t.when?.[0] !== undefined && changed.includes(t.when[0]) ? 0 : 1);
  // After the test of a file just changed, the test left unrun at the most turn ends in a row goes first.
  const waited = (t: CheckCmd): number => waits[t.name] ?? 0;
  return tests.map((t, i) => ({ t, i })).sort((a, b) => own(a.t) - own(b.t) || waited(b.t) - waited(a.t) || (a.t.when?.length ?? 0) - (b.t.when?.length ?? 0) || a.i - b.i).map((x) => x.t);
};

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi)$/;
/** Pure: the changed files in the order the file checks take them. Code first: when more changed than are checked, data must not crowd it out. */
export const checkOrder = (changed: string[]): string[] => [...changed.filter((f) => CODE.test(f)), ...changed.filter((f) => !CODE.test(f))];

/**
 * The turn checks for one repository: the file checks on every file the session changed, then the project's commands,
 * one at a time, inside the time budget. Returns null when the session changed nothing here.
 */
export const runTurn = ({ sessionId, baseline, now = Date.now, stopDeadline }: { sessionId: string; baseline: Baseline; now?: () => number; /** The one deadline of this Stop, shared by every repository it checks. */ stopDeadline?: number }): TurnResult | null => {
  const { root } = baseline;
  const began = now();
  const changedNow = changedFiles(baseline);
  if (changedNow.length === 0) return null;
  const changed = changedNow.map((c) => c.file);
  const key = crypto.createHash("sha1").update(changedNow.map((c) => `${c.file}:${c.hash}`).join("\n")).digest("hex");
  const turn = readTurn(sessionId, root);
  // Nothing changed since the last turn end and nothing was left unrun: nothing to do. With commands left unrun
  // (over the count, out of budget) the turn end goes on and runs the next of them, until none is left.
  const draining = turn.lastKey === key && (turn.lastBlocking ?? 0) === 0;
  if (draining && (turn.pending ?? 0) === 0) return { root, changed, findings: [], outcomes: [], fileChecks: [], repeated: true, notRun: [], wallS: 0, fileS: 0 };

  const rules = readRules(root);
  const findings: Finding[] = [];
  const commentsConfig = readConfig(root).comments;
  for (const file of checkOrder(changed).slice(0, 200)) findings.push(...fileFindings({ baseline, file, rules, comments: commentsConfig }).findings);
  // Row 5: an import across a boundary the project forbids, in a file this turn changed. A violation already in the backlog is tolerated.
  { const changedSet = new Set(changed); findings.push(...checkBoundaries(root).findings.filter((f) => f.file !== undefined && changedSet.has(f.file))); }
  const fileS = Math.round((now() - began) / 100) / 10;

  const config = readConfig(root);
  const limits = effectiveLimits(config);
  const green = readJson<Green>(greenFile(root), {});
  const head = currentHead(root);
  const deadline = Math.min(now() + limits.budgetS * 1000, stopDeadline ?? Infinity);
  const outcomes: Outcome[] = [];
  const notRun: string[] = [];
  const waits = readJson<Record<string, number>>(projectFile(root, "waits.json"), {});
  const all: { kind: Outcome["kind"]; check: CheckCmd }[] = [...(config.checks ?? []).map((check) => ({ kind: "check" as const, check })), ...nearestFirst(config.tests ?? [], changed, waits).map((check) => ({ kind: "test" as const, check })), ...(config.drivers ?? []).map((check) => ({ kind: "driver" as const, check }))];
  let greenChanged = false;
  let inheritedNote = "";
  const hashes = new Map(changedNow.map((c) => [c.file, c.hash]));
  const ranBefore = turn.ran ?? {};
  turn.ran = ranBefore;
  const maxTests = limits.tests;
  let testsRun = 0;
  let writtenRun = 0;
  for (const { kind, check } of all) {
    const matching = check.when ? changed.filter((f) => matchesAny(f, check.when ?? [])) : changed;
    if (matching.length === 0) continue;
    // A built-in check runs inside Ratchet. Several may share a command (builtin:generated), so its name is part of its key.
    const builtin = builtinName(check.command) !== null;
    const command = builtin ? `${check.command} (${check.name})` : check.command.split("{files}").join(matching.map(quote).join(" "));
    const greenKey = builtin ? command : check.command;
    // builtin:generated also depends on its committed output: a hand edit there must run it again.
    const into = check.into ? `${check.into.replace(/\\/g, "/").replace(/\/+$/, "")}/` : null;
    const keyFiles = into ? [...matching, ...changed.filter((f) => f.startsWith(into))] : matching;
    // A command runs again only when its own files changed since it last passed: one touched file must not rerun its test at every later turn end.
    const ownKey = crypto.createHash("sha1").update(keyFiles.map((f) => `${f}:${hashes.get(f) ?? ""}`).join("\n")).digest("hex");
    if (ranBefore[command]?.key === ownKey && ranBefore[command]?.status === "pass") {
      outcomes.push({ kind, name: check.name, command, status: "pass", note: "its files are unchanged since it last passed in this session; not run again", seconds: 0 });
      continue;
    }
    if (draining && ranBefore[command]?.key === ownKey) {
      outcomes.push({ kind, name: check.name, command, status: ranBefore[command]?.status as Outcome["status"], note: "already run at this state of its files, with this end; not run again while what is owed is run", seconds: 0 });
      continue;
    }
    // Written tests have their own allowance, so they never take a place from a test of the project.
    if (kind === "test" && isWritten(check)) {
      if (writtenRun >= maxTests) {
        notRun.push(`${check.name}: over the limit of ${maxTests} written tests per turn end`);
        outcomes.push({ kind, name: check.name, command, status: "not-run", note: `over the limit of ${maxTests} written tests per turn end`, seconds: 0 });
        continue;
      }
      writtenRun += 1;
    } else if (kind === "test") {
      if (testsRun >= maxTests) {
        notRun.push(`${check.name}: over the limit of ${maxTests} mapped tests per turn end`);
        outcomes.push({ kind, name: check.name, command, status: "not-run", note: `over the limit of ${maxTests} mapped tests per turn end`, seconds: 0 });
        continue;
      }
      testsRun += 1;
    }
    const leftMs = deadline - now();
    if (leftMs < 2000) {
      notRun.push(`${check.name}: the time budget for the turn checks was used up`);
      outcomes.push({ kind, name: check.name, command, status: "not-run", note: OUT_OF_BUDGET, seconds: 0 });
      continue;
    }
    const ownLimitMs = (check.timeoutS ?? 60) * 1000;
    const limitMs = Math.min(ownLimitMs, leftMs);
    const started = now();
    const { status, output, timedOut } = builtin ? ((r) => ({ ...r, timedOut: r.status === 124 }))(runBuiltin({ command: check.command, root, files: matching, deadline: now() + limitMs, head: baseline.head, spec: { ...(check.build ? { build: check.build } : {}), ...(check.into ? { into: check.into } : {}) } })) : runCommand({ command, cwd: root, limitMs });
    let knownGreen = turn.passed.includes(command) || (baseline.clean && baseline.head !== null && green[greenKey] === baseline.head);
    if (!knownGreen && !timedOut && status !== 0 && !check.onlyChanged && !builtin && !broke(output)) {
      const before = passedAtBaseline({ baseline, command, limitMs: Math.min((check.timeoutS ?? 60) * 1000, deadline - now()) });
      if (before === true) {
        knownGreen = true;
        if (baseline.head !== null && !check.command.includes("{files}")) {
          green[greenKey] = baseline.head;
          greenChanged = true;
        }
      } else if (before === false) inheritedNote = " It fails on the baseline commit too.";
    }
    // lf and protected name each changed file they judge; generated is judged like a command, so drift older than the session does not hold.
    const judged = judgeCommand({ check: builtin && builtinName(check.command) !== "generated" ? { ...check, onlyChanged: true } : check, kind, command, status, output, timedOut, changed, knownGreen, seconds: Math.round((now() - started) / 100) / 10 });
    if (judged.finding && inheritedNote) judged.finding.detail += inheritedNote;
    // A command on trial reports and never holds the turn: a test the harness wrote starts here, like its rules.
    if (judged.finding && check.stage === "trial") {
      judged.finding.blocking = false;
      judged.finding.detail += " (On trial: the harness wrote this test by itself, so it reports and does not hold the turn.)";
    }
    inheritedNote = "";
    // Cut off by the turn's budget, not by its own time limit: that says the limits are too wide, not that the command cannot run.
    if (timedOut && leftMs < ownLimitMs) judged.outcome.note = `${CUT_BY_BUDGET} after ${Math.round(limitMs / 1000)} s (its own limit is ${Math.round(ownLimitMs / 1000)} s)`;
    outcomes.push(judged.outcome);
    ranBefore[command] = { key: ownKey, status: judged.outcome.status };
    if (judged.outcome.status === "not-run") notRun.push(`${check.name}: ${judged.outcome.note}`);
    if (judged.finding) findings.push(judged.finding);
    if (judged.outcome.status === "pass") {
      if (!turn.passed.includes(command)) turn.passed.push(command);
      if (head && !check.command.includes("{files}") && isClean(root)) {
        green[greenKey] = head;
        greenChanged = true;
      }
    }
  }
  if (greenChanged) writeJson(greenFile(root), green);
  turn.lastKey = key;
  turn.lastBlocking = findings.filter((f) => f.blocking).length;
  // What the limits left unrun is owed: the next turn end runs it even when nothing has changed.
  turn.pending = outcomes.filter((o) => ["count", "budget"].includes(skipCause(o) ?? "")).length;
  writeTurn(sessionId, root, turn);
  const nextW = nextWaits(waits, outcomes, (config.tests ?? []).map((x) => x.name));
  if (JSON.stringify(nextW) !== JSON.stringify(waits)) writeJson(projectFile(root, "waits.json"), nextW);
  return { root, changed, findings, outcomes, fileChecks: ["syntax", `${rules.length} project rules`, "escape hatches against the session baseline"], repeated: false, notRun, wallS: Math.round((now() - began) / 100) / 10, fileS };
};

/** Pure: the verification record as a page a person can read (T13: evidence, not a diff). */
export const renderRecord = ({ result, sessionId, mode, held, time }: { result: TurnResult; sessionId: string; mode: Mode; held: boolean; time: string }): string => {
  const blocking = result.findings.filter((f) => f.blocking);
  const lines = [
    `# Verification record, ${time}`,
    "",
    `Repository: ${result.root}. Session: ${sessionId}. Mode: ${mode}. ${held ? "The turn was held." : blocking.length > 0 ? "The turn ended with failures stated." : "Nothing failed."}`,
    "",
    `## Files this session changed (${result.changed.length})`,
    "",
    ...result.changed.slice(0, 60).map((f) => `- ${f}`),
    ...(result.changed.length > 60 ? [`- and ${result.changed.length - 60} more`] : []),
    "",
    "## What ran",
    "",
    `- On every changed file: ${result.fileChecks.join(", ")}.`,
    ...result.outcomes.map((o) => `- ${o.kind} ${o.name}: ${o.status}${o.note ? ` (${o.note})` : ""}, ${o.seconds} s. Command: \`${o.command}\``),
    ...(result.outcomes.length === 0 ? ["- No project command is configured for these files."] : []),
    "",
    "## What it said",
    "",
    ...(result.findings.length === 0 ? ["- No finding."] : result.findings.map((f) => `- ${f.blocking ? "FAILS" : "noted"}: ${f.file ? `${f.file}: ` : ""}${f.title}. Fix: ${f.fix}`)),
    "",
    "## What could not run",
    "",
    ...(result.notRun.length === 0 ? ["- Nothing."] : result.notRun.map((n) => `- ${n}`)),
    "",
  ];
  return lines.join("\n");
};

/** Writes the record as JSON and as the project's latest page. Keeps the last 200. */
export const writeRecord = ({ result, sessionId, mode, held }: { result: TurnResult; sessionId: string; mode: Mode; held: boolean }): string => {
  const time = new Date().toISOString();
  const dir = path.join(projectDir(result.root), "records");
  const file = path.join(dir, `${time.replace(/[:.]/g, "-")}-${sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)}.json`);
  writeJson(file, { time, sessionId, mode, held, ...result });
  writeText(path.join(projectDir(result.root), "latest.md"), renderRecord({ result, sessionId, mode, held, time }));
  try {
    const old = fs.readdirSync(dir).sort().slice(0, -200);
    for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  } catch {
    // Pruning is housekeeping.
  }
  return file;
};
