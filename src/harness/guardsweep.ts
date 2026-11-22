// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import { forShell } from "../shellcmd.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelFn } from "../types.ts";
import { reads_like_a_fix } from "./auto.ts";
import { attemptGuard, PROMPT_ID, runAt, type GuardClass, type Ran } from "./guardwriter.ts";
import { matchesAny } from "./rules.ts";
import { readJson, writeJson, writeText } from "./state.ts";

/**
 * The measure of the written tests. Two steps, both resumable and bounded in time:
 *
 * sweep: a sample of past fix commits, fixed by a seed before anything runs, each given one model call. Every
 *   outcome is counted by its class. What the sweep runs is what the loop runs (`attemptGuard`).
 * walk:  each kept test is run at the later commits that touched its files. It CATCHES when it was passing, a
 *   later commit made it fail by an assertion, and a later fix commit made it pass again, with the failure seen at
 *   that fix commit's own parent. Its own fix never counts. The cost is written beside it: breaks that were not
 *   assertions (the test no longer loads), breaks mended by a commit that is not a fix, and tests failing at the end.
 */
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi)$/;
const PY = /\.pyi?$/;
const git = (root: string, args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });

export type SweepResult = { cls: GuardClass; reason: string; files: string[]; testName?: string; atHead?: Ran; seconds: number };
export type WalkResult = { later: number; truncated: boolean; breaks: { at: string; kind: Ran; byFix: boolean }[]; caught: string[]; mendedByNonFix: number; standing: Ran | null };
export type SweepState = { root: string; seed: string; n: number; promptId: string; templates: { py?: string; ts?: string }; fixes: number; eligible: number; sample: string[]; results: Record<string, SweepResult>; walk: Record<string, WalkResult>; done: boolean; walked: boolean };

/** Pure: `n` of the hashes, chosen by the seed alone. The same seed gives the same sample whatever ran before. */
export const pick = (hashes: string[], seed: string, n: number): string[] =>
  hashes
    .map((h) => ({ h, k: crypto.createHash("sha1").update(`${seed}\t${h}`).digest("hex") }))
    .sort((a, b) => a.k.localeCompare(b.k))
    .slice(0, n)
    .map((x) => x.h);

/** The fix commits of the whole history, oldest first, and those a written test could be asked for. */
export const eligibleFixes = ({ root, exclude, templates, only = [], after }: { root: string; exclude: string[]; templates: { py?: string; ts?: string }; only?: string[]; /** Only commits after this one. */ after?: string }): { fixes: number; eligible: string[] } => {
  const rows = git(root, ["log", "--no-merges", "--reverse", "--format=%x01%H%x09%s", "--name-only", ...(after ? [`${after}..HEAD`] : [])]).split("\x01").filter(Boolean);
  const eligible: string[] = [];
  let fixes = 0;
  for (const row of rows) {
    const lines = row.split(/\r?\n/).filter(Boolean);
    const [hash = "", subject = ""] = (lines[0] ?? "").split("\t");
    if (!reads_like_a_fix(subject)) continue;
    fixes += 1;
    const files = lines.slice(1).filter((f) => SOURCE.test(f) && !matchesAny(f, exclude) && (only.length === 0 || matchesAny(f, only)));
    if (files.length >= 1 && files.length <= 3 && files.some((f) => (PY.test(f) ? templates.py : templates.ts))) eligible.push(hash);
  }
  return { fixes, eligible };
};

const ram = (): number => Math.round(100 * (1 - os.freemem() / os.totalmem()));
const codeDir = (statePath: string): string => statePath.replace(/\.json$/, "");

/** One model call per sampled fix, until the sample is done, the time is up or memory is short. Run it again to go on. */
export const sweep = async ({ root, model, statePath, n, seed, templates, exclude = [], only = [], after, style, minutes = 20, memory = ram }: { root: string; model: ModelFn; statePath: string; n: number; seed: string; templates: { py?: string; ts?: string }; exclude?: string[]; only?: string[]; after?: string; style?: string[]; minutes?: number; memory?: () => number }): Promise<SweepState> => {
  const promptId = style ? `${PROMPT_ID}-${crypto.createHash("sha1").update(style.join("\n")).digest("hex").slice(0, 6)}` : PROMPT_ID;
  let state = readJson<SweepState | null>(statePath, null);
  if (!state || state.seed !== seed || state.n !== n || state.promptId !== promptId) {
    const found = eligibleFixes({ root, exclude, templates, only, ...(after ? { after } : {}) });
    state = { root, seed, n, promptId, templates, fixes: found.fixes, eligible: found.eligible.length, sample: pick(found.eligible, seed, n), results: {}, walk: {}, done: false, walked: false };
    writeJson(statePath, state);
  }
  const deadline = Date.now() + minutes * 60_000;
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  for (const commit of state.sample) {
    if (state.results[commit]) continue;
    if (Date.now() >= deadline || memory() >= 90) break;
    const started = Date.now();
    const a = await attemptGuard({ root, commit, model, exclude, only, ...(style ? { style } : {}), templates });
    const result: SweepResult = { cls: a.cls, reason: a.reason, files: a.files, seconds: 0, ...(a.testName ? { testName: a.testName } : {}) };
    if (a.cls === "kept" && a.code && a.testName) {
      writeText(path.join(codeDir(statePath), a.testName), a.code);
      const template = (PY.test(a.testName) ? templates.py : templates.ts) as string;
      try {
        const part = runAt({ root, rev: head, files: a.files, testName: a.testName, code: a.code, template }).ran;
        result.atHead = part === "passes" ? part : runAt({ root, rev: head, files: a.files, testName: a.testName, code: a.code, template, full: true }).ran;
      } catch {
        result.atHead = "errors";
      }
    }
    result.seconds = Math.round((Date.now() - started) / 1000);
    state.results[commit] = result;
    state.done = state.sample.every((c) => state?.results[c]);
    writeJson(statePath, state);
  }
  state.done = state.sample.every((c) => state?.results[c]);
  writeJson(statePath, state);
  return state;
};

/** Pure: what a run of statuses at later commits means for one kept test. `exact` runs the test at a commit's parent. */
export const readWalk = ({ later, statuses, exact, truncated = false }: { later: { hash: string; fix: boolean }[]; statuses: Ran[]; exact: (hash: string) => Ran; truncated?: boolean }): WalkResult => {
  const out: WalkResult = { later: later.length, truncated, breaks: [], caught: [], mendedByNonFix: 0, standing: null };
  let prev: Ran = "passes";
  later.forEach((c, i) => {
    const s = statuses[i] ?? "errors";
    if (prev === "passes" && s !== "passes") out.breaks.push({ at: c.hash, kind: s, byFix: c.fix });
    if (prev !== "passes" && s === "passes") {
      // Counted as a catch only when a fix commit mended it and the test fails by an assertion at that commit's own parent.
      if (c.fix && exact(c.hash) === "fails") out.caught.push(c.hash);
      else out.mendedByNonFix += 1;
    }
    prev = s;
  });
  out.standing = prev === "passes" ? null : prev;
  return out;
};

/** Each kept test of a finished sweep, run at the later commits that touched its files. Resumable; no model call. */
export const walk = ({ statePath, maxLater = 30, minutes = 20, memory = ram }: { statePath: string; maxLater?: number; minutes?: number; memory?: () => number }): SweepState => {
  const state = readJson<SweepState | null>(statePath, null);
  if (!state) throw new Error(`no sweep at ${statePath}`);
  const deadline = Date.now() + minutes * 60_000;
  for (const [commit, r] of Object.entries(state.results)) {
    if (r.cls !== "kept" || !r.testName || state.walk[commit]) continue;
    if (Date.now() >= deadline || memory() >= 90) break;
    const code = fs.readFileSync(path.join(codeDir(statePath), r.testName), "utf8");
    const template = (PY.test(r.testName) ? state.templates.py : state.templates.ts) as string;
    const all = git(state.root, ["log", "--no-merges", "--reverse", "--format=%H\t%s", `${commit}..HEAD`, "--", ...r.files]).split(/\r?\n/).filter(Boolean).map((l) => {
      const [hash = "", subject = ""] = l.split("\t");
      return { hash, fix: reads_like_a_fix(subject) };
    });
    const later = all.slice(0, maxLater);
    const at = (rev: string): Ran => {
      try {
        const part = runAt({ root: state.root, rev, files: r.files, testName: r.testName as string, code, template }).ran;
        return part === "passes" ? part : runAt({ root: state.root, rev, files: r.files, testName: r.testName as string, code, template, full: true }).ran;
      } catch {
        return "errors";
      }
    };
    state.walk[commit] = readWalk({ later, statuses: later.map((c) => at(c.hash)), exact: (hash) => at(`${hash}^`), truncated: all.length > maxLater });
    writeJson(statePath, state);
  }
  state.walked = Object.entries(state.results).every(([c, r]) => r.cls !== "kept" || state.walk[c]);
  writeJson(statePath, state);
  return state;
};

export type SweepSummary = { fixes: number; eligible: number; sampled: number; tried: number; byClass: Record<string, number>; kept: number; keptPassingAtHead: number; walked: number; laterCommits: number; caught: number; assertionBreaks: number; loadBreaks: number; mendedByNonFix: number; standingAtEnd: number };

/** Pure: the numbers of one sweep. */
export const summarizeSweep = (s: SweepState): SweepSummary => {
  const results = Object.values(s.results);
  const byClass: Record<string, number> = {};
  for (const r of results) byClass[r.cls] = (byClass[r.cls] ?? 0) + 1;
  const walks = Object.values(s.walk);
  const sum = (f: (w: WalkResult) => number): number => walks.reduce((n, w) => n + f(w), 0);
  return {
    fixes: s.fixes,
    eligible: s.eligible,
    sampled: s.sample.length,
    tried: results.length,
    byClass,
    kept: byClass.kept ?? 0,
    keptPassingAtHead: results.filter((r) => r.cls === "kept" && r.atHead === "passes").length,
    walked: walks.length,
    laterCommits: sum((w) => w.later),
    caught: sum((w) => w.caught.length),
    assertionBreaks: sum((w) => w.breaks.filter((b) => b.kind === "fails").length),
    loadBreaks: sum((w) => w.breaks.filter((b) => b.kind === "errors").length),
    mendedByNonFix: sum((w) => w.mendedByNonFix),
    standingAtEnd: walks.filter((w) => w.standing !== null).length,
  };
};

export const renderSweep = (s: SweepState): string => {
  const x = summarizeSweep(s);
  return [
    `Written tests, sweep of ${s.root} (seed ${s.seed}, request ${s.promptId}): ${x.fixes} fix commits in the history, ${x.eligible} a test could be asked for, ${x.sampled} sampled, ${x.tried} tried${s.done ? "" : " (not finished)"}.`,
    `Outcomes: ${Object.entries(x.byClass).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}.`,
    `Kept: ${x.kept} of ${x.tried}; of those, passing in the tree at HEAD: ${x.keptPassingAtHead}.`,
    s.walked || x.walked > 0
      ? `Walked forward${s.walked ? "" : " (not finished)"}: ${x.walked} kept test(s) over ${x.laterCommits} later commits that touched their files. Caught (broke by an assertion, mended by a later fix commit): ${x.caught}. Breaks by an assertion: ${x.assertionBreaks}; breaks where the test no longer loaded: ${x.loadBreaks}; mended by a commit that is not a fix: ${x.mendedByNonFix}; still not passing at the end of the walk: ${x.standingAtEnd}.`
      : "Not walked forward yet.",
  ].join("\n");
};

/**
 * The kept tests of a sweep become mapped tests of the project: each must pass in the project as it is now and
 * leave the working tree as it was. Only adds entries of the loop's own; a name already there is left alone.
 */
export const adopt = ({ statePath, projectDirOf, configFile, now = () => new Date().toISOString() }: { statePath: string; projectDirOf: string; configFile: string; now?: () => string }): { adopted: string[]; skipped: string[]; changes: { time: string; what: string; undo: string }[] } => {
  const state = readJson<SweepState | null>(statePath, null);
  if (!state) throw new Error(`no sweep at ${statePath}`);
  const adopted: string[] = [];
  const skipped: string[] = [];
  const changes: { time: string; what: string; undo: string }[] = [];
  for (const [commit, r] of Object.entries(state.results)) {
    if (r.cls !== "kept" || !r.testName) continue;
    const name = `guard-${commit.slice(0, 7)}`;
    const config = readJson<{ tests?: { name: string; when?: string[]; command: string; timeoutS?: number; origin?: string }[] }>(configFile, {});
    if ((config.tests ?? []).some((t) => t.name === name)) {
      skipped.push(`${name}: already mapped`);
      continue;
    }
    const stored = path.join(projectDirOf, "guards", r.testName).split(path.sep).join("/");
    writeText(stored, fs.readFileSync(path.join(codeDir(statePath), r.testName), "utf8"));
    const template = (PY.test(r.testName) ? state.templates.py : state.templates.ts) as string;
    const command = template.split("{test}").join(stored);
    const before = git(state.root, ["status", "--porcelain"]);
    let ok = true;
    try {
      execFileSync(forShell(command), { cwd: state.root, shell: true, stdio: "ignore", timeout: 60_000, windowsHide: true, env: { ...process.env, RATCHET_CHILD: "1" } });
    } catch {
      ok = false;
    }
    if (!ok || git(state.root, ["status", "--porcelain"]) !== before) {
      fs.rmSync(stored, { force: true });
      skipped.push(`${name}: ${ok ? "it changed files in the working tree" : "it does not pass in the project as it is now"}`);
      continue;
    }
    writeJson(configFile, { ...config, tests: [...(config.tests ?? []), { name, when: r.files, command, timeoutS: 60, origin: "auto", stage: "trial" }] });
    // The loop does not ask a model again for a fix whose test is already here.
    const autoFile = path.join(projectDirOf, "auto.json");
    const auto = readJson<{ guardTried?: string[] }>(autoFile, {});
    writeJson(autoFile, { ...auto, guardTried: [...new Set([...(auto.guardTried ?? []), commit])].slice(-200) });
    adopted.push(name);
    changes.push({ time: now(), what: `test ${name} from the sweep of past fixes mapped: a program saw it fail by an assertion before fix ${commit.slice(0, 8)} and pass after it, and pass in the project as it is now. It is on trial: a failure is reported and does not hold a turn. It runs when one of ${r.files.join(", ")} changes. File: ${stored}`, undo: `remove the entry named ${name} from tests in ${configFile}` });
  }
  return { adopted, skipped, changes };
};

export type FixWalk = { laterFixes: number; caught: string[]; failingAtParent: number };

/**
 * The walk as it was registered: each kept test is run at the parent of EVERY later fix commit, whatever files
 * that commit touched, and where it fails there by an assertion, at the commit itself. A catch is fail, then pass.
 * Its own fix never counts. Resumable; no model call.
 */
export const walkFixes = ({ statePath, minutes = 20, memory = ram, paths = [] }: { statePath: string; minutes?: number; memory?: () => number; /** Where given, only later fix commits that touched one of these paths are visited (said beforehand, for a repository of several apps). */ paths?: string[] }): SweepState & { fixWalk: Record<string, FixWalk> } => {
  const state = readJson<(SweepState & { fixWalk?: Record<string, FixWalk>; fixWalkSeen?: Record<string, Record<string, Ran>> }) | null>(statePath, null);
  if (!state) throw new Error(`no sweep at ${statePath}`);
  const fixWalk = state.fixWalk ?? {};
  // What each test did in each whole tree, kept in the file: a walk cut short by the time limit goes on from there.
  const fixWalkSeen = state.fixWalkSeen ?? {};
  const deadline = Date.now() + minutes * 60_000;
  for (const [commit, r] of Object.entries(state.results)) {
    if (r.cls !== "kept" || !r.testName || fixWalk[commit]) continue;
    if (Date.now() >= deadline || memory() >= 90) break;
    const code = fs.readFileSync(path.join(codeDir(statePath), r.testName), "utf8");
    const template = (PY.test(r.testName) ? state.templates.py : state.templates.ts) as string;
    const later = git(state.root, ["log", "--no-merges", "--reverse", "--format=%H\t%s", `${commit}..HEAD`, ...(paths.length > 0 ? ["--", ...paths] : [])]).split(/\r?\n/).filter(Boolean).map((l) => l.split("\t")).filter(([, s = ""]) => reads_like_a_fix(s)).map(([h = ""]) => h);
    const seen = (fixWalkSeen[commit] ??= {});
    // The same whole tree gives the same result: a later fix whose parent is the fix before it is run once.
    const treeKey = (rev: string): string => {
      try {
        return git(state.root, ["rev-parse", `${rev}^{tree}`]).trim();
      } catch {
        return "";
      }
    };
    const at = (rev: string): Ran => {
      try {
        const part = runAt({ root: state.root, rev, files: r.files, testName: r.testName as string, code, template }).ran;
        return part === "passes" ? part : runAt({ root: state.root, rev, files: r.files, testName: r.testName as string, code, template, full: true }).ran;
      } catch {
        return "errors";
      }
    };
    const cached = (rev: string): Ran => {
      const key = treeKey(rev);
      if (key === "") return at(rev);
      const had = seen[key];
      if (had) return had;
      const ran = at(rev);
      seen[key] = ran;
      writeJson(statePath, { ...state, fixWalk, fixWalkSeen });
      return ran;
    };
    const out: FixWalk = { laterFixes: later.length, caught: [], failingAtParent: 0 };
    let cut = false;
    for (const f of later) {
      if (Date.now() >= deadline) {
        cut = true;
        break;
      }
      if (cached(`${f}^`) !== "fails") continue;
      out.failingAtParent += 1;
      if (cached(f) === "passes") out.caught.push(f);
    }
    // A walk cut short by the time limit is not a result yet: the next run goes on from what is kept above.
    if (cut) break;
    fixWalk[commit] = out;
    writeJson(statePath, { ...state, fixWalk, fixWalkSeen });
  }
  const done = { ...state, fixWalk, fixWalkSeen };
  writeJson(statePath, done);
  return done;
};

export type Return = { undone: boolean; ran: Ran | null };

/**
 * If the fault came back today: the fix of each kept test is taken out of the tree at HEAD and the test is run.
 * A test that fails by an assertion would catch the fault's return. Where the code has moved on and the fix can
 * no longer be taken out as it was, nothing is said. No model call.
 */
export const faultReturns = ({ statePath }: { statePath: string }): Record<string, Return> => {
  const state = readJson<SweepState | null>(statePath, null);
  if (!state) throw new Error(`no sweep at ${statePath}`);
  const out: Record<string, Return> = {};
  for (const [commit, r] of Object.entries(state.results)) {
    if (r.cls !== "kept" || !r.testName) continue;
    const code = fs.readFileSync(path.join(codeDir(statePath), r.testName), "utf8");
    const template = (PY.test(r.testName) ? state.templates.py : state.templates.ts) as string;
    const undo = git(state.root, ["diff", `${commit}^`, commit, "--", ...r.files.filter((f) => !/(^|\/)(tests?|__tests__)\/|\.test\.|(^|\/)test_[^/]*\.py$/.test(f))]);
    try {
      const run = runAt({ root: state.root, rev: "HEAD", files: r.files, testName: r.testName, code, template, full: true, undo });
      out[commit] = { undone: run.undone === true, ran: run.undone ? run.ran : null };
    } catch {
      out[commit] = { undone: false, ran: null };
    }
  }
  writeJson(statePath, { ...readJson<SweepState>(statePath, state), faultReturns: out });
  return out;
};
