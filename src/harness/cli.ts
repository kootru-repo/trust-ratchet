import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isFixSubject } from "../history.ts";
import { EVENTS, install, installed, settingsPath, uninstall } from "./install.ts";
import { findComments } from "./comments.ts";
import { findHatches, matchesAny, ruleLines, ruleProblems, type Rule } from "./rules.ts";
import { fileAtCommit, readSource, repoRoot, trackedFiles } from "./session.ts";
import { clearSwitch, effective, home, normRoot, projectDir, projectFile, readConfig, readJson, readState, setSwitch, writeJson, type CheckCmd, type Mode, type ProjectConfig } from "./state.ts";
import { isWritten, readRules } from "./turn.ts";
import { ceiling, effectiveLimits, renderLimits, replay, turnStats, unrunAtEnd } from "./limits.ts";
import { featureMap, generatedGuides, outcomes, pairTests, parseLog, renderFeatureMap, renderOutcomes } from "./outcomes.ts";
import { writeText } from "./state.ts";
import { allAssessments, gatherFacts, realRecords, runAuto } from "./auto.ts";
import { levelOf, renderLevel } from "./level.ts";
import { backtest, renderBacktest, summarize } from "./backtest.ts";
import { ALL_SHAPES, DEFAULT_CAP, DEFAULT_SHAPES, type Shape } from "./propose.ts";
import { renderDashboard } from "./dashboard.ts";
import { baselineStep, markSwitch, offUnseen, renderBaseline } from "./insight.ts";
import { gatherLessonFacts, lessonCard, logLessons, logShown, renderLessons } from "./lessons.ts";
import { mustNotFromRulings, type MustNot } from "../options.ts";
import type { Checked, ReviewResult } from "../types.ts";
import { readRulings } from "../vault.ts";

export const HARNESS_COMMANDS = new Set(["install", "uninstall", "on", "off", "default", "status", "init", "rule", "census", "hatches", "comments", "measure", "debug", "must-not", "features", "guides", "auto", "level", "dashboard", "backtest", "baseline", "limits", "lessons"]);

/** The places a person ruled false alarms in this project (S14). */
export const readMustNot = (root: string): MustNot[] => {
  const raw = readJson<unknown>(projectFile(root, "must-not-flag.json"), []);
  // The file can be edited by hand: an entry that is not a whole case is left out, never trusted.
  return (Array.isArray(raw) ? raw : []).filter((m): m is MustNot => typeof m === "object" && m !== null && Array.isArray((m as MustNot).files) && (m as MustNot).files.every((f) => typeof f === "string") && typeof (m as MustNot).pattern === "string" && typeof (m as MustNot).reason === "string");
};

export const HARNESS_USAGE = `ratchet install | uninstall                         add or remove the five hook entries in the Claude Code settings (switch state is kept)
ratchet on | off [--project <dir>] [--mode advise|enforce]   the global switch, or one project's own switch
ratchet default --project <dir>                       drop a project's own switch, so it follows the global one
ratchet status [--project <dir>]
ratchet init [--project <dir>] [--in-repo] [--force] [--keep-own]  write a project config from what is found (no whole test suite, ever); --keep-own keeps the checks, tests and drivers written by hand, and the limits set by hand
ratchet init --pair-tests [--py-test "python -B {test}"] [--ts-test "<cmd> {test}"] [--exclude <glob>]... [--project <dir>]
                                                      map each test that sits beside the file it tests to that file
ratchet features [--project <dir>]                    the feature map: what watches each folder of source files
ratchet auto [--project <dir>] [--on | --off] [--guards | --no-guards] [--guard-commit <rev>] [--backlog] [--py-test "python -B {test}"] [--ts-test <cmd>] [--exclude <glob>]... [--not-ours <glob>]...
                                                      one pass of the autonomous loop; --on and --off switch it for the project;
                                                      --backlog also times the tests that were there before it was switched on, three a pass
                                                      --guards lets it ask a model for a regression test of each new fix, kept only when a
                                                      program saw it fail before the fix and pass after; --guard-commit asks for one fix by name
ratchet baseline [--project <dir>] [--minutes 10]     run the mapped commands once on the tree as it is (not a session's turn; refused where noFullRuns is set)
ratchet limits [--project <dir>] [--replay] [--on | --off]  the turn-end limits (tests per turn end, time budget), their floor and ceiling, and what the records say; --on lets the loop move its own value one step a pass
ratchet lessons [--project <dir>] [--on | --off] [--record]  the lesson card: for each lesson of the talk, what is in use here and what effect is measured; --on keeps a line of its
                                                      numbers at each pass of the loop (off by default: nothing is written); --record prints the latest verification record
ratchet level [--project <dir>]                       the verification level, with every requirement met or not
ratchet backtest [--project <dir>] [--max 400] [--from <n>] [--to <n>] [--cap 25] [--shapes a,b|all] [--minutes 20] [--resume] [--json]
                                                      walk the history oldest first: the rules the loop would have written, and the
                                                      later fixes they would have named; stops at the time limit, --resume goes on
ratchet dashboard [--out <file>]                      one page for every project the loop runs in: level, trend, what it changed
ratchet guides [--project <dir>] [--last 1000]        write generated notes for reviewers: the fixes each folder has needed and the rules in it
ratchet rule add --id <id> --kind ban-pattern|ban-import|ban-api --pattern <p> --files <glob>... --message <m> --fix <f> [--scope statement]
                 [--proof-commit <rev> --proof-file <file>] [--project <dir>] [--in-repo]
ratchet rule list | rule remove --id <id> [--project <dir>]
ratchet census [--project <dir>] [--tighten]          every rule: count now against its baseline; --tighten lowers a backlog that fell
ratchet hatches [--project <dir>] [--set-ceiling]     escape hatches in the repository against the stored ceiling
ratchet measure [--project <dir>] [--last 200]        outcomes from git history and the harness's own records
ratchet must-not add --files <glob>... --pattern <regex on the line> --reason <why it is fine> [--project <dir>]
ratchet must-not from-vault --vault <dir> --review <review .json>... [--project <dir>]   false-alarm rulings become must-not-flag cases
ratchet must-not list [--project <dir>]`;

type Args = { flag: (name: string, fallback: string) => string; flags: (name: string) => string[]; has: (name: string) => boolean };
const parse = (argv: string[]): Args => ({
  flag: (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
  },
  flags: (name) => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] !== undefined ? [argv[i + 1] as string] : [])),
  has: (name) => argv.includes(`--${name}`),
});

const rootOf = (dir: string): string => {
  const root = repoRoot(path.resolve(dir));
  if (!root) throw new Error(`${path.resolve(dir)} is not inside a git repository`);
  return root;
};

/** Where a project file is written: `.ratchet/` in the repository only when asked or already there. */
const writeTarget = (root: string, name: string, inRepo: boolean): string => (inRepo ? path.join(root, ".ratchet", name) : projectFile(root, name));

/** Pure: a config from the scripts and tool settings a repository already has. Tests enter only as file to test maps, by hand. */
export const detectConfig = ({ scripts, hasRuff }: { scripts: Record<string, string>; hasRuff: boolean }): ProjectConfig => {
  const checks: CheckCmd[] = [];
  const types = ["check-types", "typecheck", "type-check", "tsc"].find((s) => s in scripts);
  if (types) checks.push({ name: "types", command: `npm run -s ${types}`, when: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"], onlyChanged: true, timeoutS: 90 });
  if ("lint" in scripts) checks.push({ name: "lint", command: "npm run -s lint", when: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs"], onlyChanged: true, timeoutS: 90 });
  if (hasRuff) checks.push({ name: "ruff", command: "python -m ruff check {files}", when: ["**/*.py"], timeoutS: 60 });
  return { checks, tests: [], drivers: [], budgetS: { stop: 120 } };
};

/** Every escape hatch in the tracked files of a repository. */
export const countHatches = (root: string): { total: number; byName: Record<string, number>; byFile: Record<string, number> } => {
  const byName: Record<string, number> = {};
  const byFile: Record<string, number> = {};
  let total = 0;
  for (const file of trackedFiles(root)) {
    if (!/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi)$/.test(file)) continue;
    const text = readSource(path.join(root, file));
    if (text === null) continue;
    for (const h of findHatches(file, text)) {
      total += 1;
      byName[h.name] = (byName[h.name] ?? 0) + 1;
      byFile[file] = (byFile[file] ?? 0) + 1;
    }
  }
  return { total, byName, byFile };
};

/** Where a rule fires across the tracked files it covers: the siblings of the fault it was written for (T3). */
export const census = (root: string, rule: Rule): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const file of trackedFiles(root)) {
    if (!matchesAny(file, rule.files)) continue;
    const text = readSource(path.join(root, file));
    if (text === null) continue;
    const n = ruleLines(rule, text).length;
    if (n > 0) out[file] = n;
  }
  return out;
};

/**
 * Proof that a rule is the check for a correction (T2): it fires on a line the fix commit removed and on no line it added.
 * Other places in the same file where it still fires are siblings (T3) and go to the backlog.
 * Returns null when either side of the commit does not hold the file.
 */
export const proveRule = ({ root, rule, commit, file }: { root: string; rule: Rule; commit: string; file: string }): { firedBefore: number; firedAfter: number; onRemoved: number; onAdded: number; proven: boolean } | null => {
  const before = fileAtCommit(root, `${commit}^`, file);
  const after = fileAtCommit(root, commit, file);
  if (before === null || after === null) return null;
  const diff = execFileSync("git", ["-C", root, "diff", "-U0", `${commit}^`, commit, "--", file], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split(/\r?\n/);
  const side = (mark: string): number => ruleLines(rule, diff.filter((l) => l.startsWith(mark) && !l.startsWith(mark.repeat(3))).map((l) => l.slice(1)).join("\n")).length;
  const onRemoved = side("-");
  const onAdded = side("+");
  return { firedBefore: ruleLines(rule, before).length, firedAfter: ruleLines(rule, after).length, onRemoved, onAdded, proven: onRemoved > 0 && onAdded === 0 };
};

const sum = (counts: Record<string, number>): number => Object.values(counts).reduce((a, b) => a + b, 0);
const top = (counts: Record<string, number>, n: number): string => Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(", ");

const statusText = (dir: string): string => {
  const state = readState();
  const inst = installed();
  const lines = [
    `Installed: ${inst.hooks.length === EVENTS.length && inst.app ? "yes" : inst.hooks.length === 0 ? "no (run: ratchet install)" : `partly (${inst.hooks.join(", ")})`}. Settings: ${settingsPath()}. Home: ${home()}.`,
    `Global switch: ${state.enabled ? "ON" : "off"}, mode ${state.mode}.`,
    ...Object.entries(state.projects).map(([root, s]) => `Project switch: ${root}: ${s.enabled === undefined ? "follows global" : s.enabled ? "ON" : "off"}${s.mode ? `, mode ${s.mode}` : ""}.`),
  ];
  const root = repoRoot(path.resolve(dir));
  if (root) {
    const eff = effective(state, root);
    const config = readConfig(root);
    const rules = readRules(root);
    const names = (list: CheckCmd[] | undefined): string => ((list ?? []).length === 0 ? "none" : (list ?? []).map((c) => c.name).join(", "));
    lines.push(
      `Here (${root}): ${eff.enabled ? `ON, mode ${eff.mode}` : "off"}.`,
      `  Rules: ${rules.length} (${rules.filter((r) => r.proof).length} proven on a past fix). Checks: ${names(config.checks)}. Tests: ${names(config.tests)}. Drivers: ${names(config.drivers)}.`,
      `  Files: ${projectFile(root, "config.json")}, ${projectFile(root, "rules.json")}. Last record: ${fs.existsSync(path.join(projectDir(root), "latest.md")) ? path.join(projectDir(root), "latest.md") : "none yet"}.`,
    );
  }
  return lines.join("\n");
};

/** Runs one harness command. Returns the exit code. */
export const harnessCli = (argv: string[], source: string): number => {
  const [command, sub] = argv;
  const args = parse(argv);
  const say = (line: string): void => console.log(line);
  const projectFlag = args.flag("project", "");

  if (command === "install") {
    const r = install({ source });
    say(`Installed. Hook entries ${r.changed ? "written to" : "already in"} ${r.settings}${r.backup ? ` (backup: ${r.backup})` : ""}.`);
    say(`Copy: ${r.app}. Command: ${r.command}. Slash command: /ratchet.`);
    say(`The switch is ${readState().enabled ? "ON" : "off"}. Switch on everywhere: ratchet on. One project: ratchet on --project <dir>.`);
    return 0;
  }
  if (command === "uninstall") {
    const r = uninstall();
    say(r.changed ? `Hook entries removed from ${r.settings} (backup: ${r.backup}). Rules, records and the switch state stay in ${home()}.` : `No Ratchet hook entry in ${r.settings}.`);
    return 0;
  }
  if (command === "on" || command === "off") {
    const modeFlag = args.flag("mode", "");
    if (modeFlag !== "" && modeFlag !== "advise" && modeFlag !== "enforce") throw new Error("--mode must be advise or enforce");
    const root = projectFlag ? rootOf(projectFlag) : undefined;
    setSwitch({ ...(root ? { root } : {}), enabled: command === "on", ...(modeFlag ? { mode: modeFlag as Mode } : {}) });
    say(statusText(projectFlag || "."));
    if (command === "on" && installed().hooks.length < 4) say("The hooks are not installed, so nothing will run yet. Run: ratchet install");
    return 0;
  }
  if (command === "default") {
    if (!projectFlag) throw new Error("default needs --project <dir>");
    clearSwitch(rootOf(projectFlag));
    say(statusText(projectFlag));
    return 0;
  }
  if (command === "debug") {
    const state = readState();
    writeJson(path.join(home(), "state.json"), { ...state, debug: sub === "on" });
    say(`Payload logging ${sub === "on" ? `on: ${path.join(home(), "log", "payloads.jsonl")}` : "off"}.`);
    return 0;
  }
  if (command === "status") {
    say(statusText(projectFlag || "."));
    return 0;
  }

  const root = rootOf(projectFlag || ".");
  const inRepo = args.has("in-repo");

  if (command === "init" && args.has("pair-tests")) {
    const target = writeTarget(root, "config.json", inRepo);
    const config = readConfig(root);
    const py = args.flag("py-test", "");
    const ts = args.flag("ts-test", "");
    const found = pairTests({ files: trackedFiles(root), exclude: args.flags("exclude"), template: { ...(py ? { py } : {}), ...(ts ? { ts } : {}) } });
    const kept = (config.tests ?? []).filter((t) => !found.some((f) => f.name === t.name));
    writeJson(target, { ...config, tests: [...kept, ...found] });
    say(`${found.length} test(s) mapped to the file each one tests, in ${target}. A test runs only when its own file or that file changed, ${config.maxTestsPerStop ?? 3} at most per turn end.`);
    if (!py && !ts) say("No command template was given, so nothing was mapped. Give --py-test or --ts-test with {test} in it.");
    return 0;
  }

  if (command === "guides") {
    const last = Number(args.flag("last", "1000"));
    const log = parseLog(execFileSync("git", ["-C", root, "log", `-${last}`, "--no-merges", "--format=%x01%H%x09%ct%x09%s", "--name-only"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
    const notes = generatedGuides({ commits: log, rules: readRules(root), files: trackedFiles(root) });
    const dir = projectFile(root, "guides");
    fs.mkdirSync(dir, { recursive: true });
    // Only this command's own files are replaced: a note an owner wrote is never touched.
    for (const old of fs.readdirSync(dir).filter((f) => /^generated-.*\.md$/.test(f))) fs.rmSync(path.join(dir, old));
    for (const n of notes) writeText(path.join(dir, n.name), n.text);
    say(`${notes.length} generated note(s) written to ${dir}: ${notes.map((n) => n.name).join(", ") || "none"}. They reach reviewers with --guides. An owner's note is any other .md file there.`);
    return 0;
  }

  if (command === "auto") {
    const config = readConfig(root);
    if (args.has("on") || args.has("off") || args.has("guards") || args.has("no-guards") || args.has("no-full-runs") || args.has("py-test") || args.has("ts-test") || args.flags("exclude").length > 0 || args.flags("not-ours").length > 0) {
      const py = args.flag("py-test", "");
      const ts = args.flag("ts-test", "");
      const next = {
        ...config,
        ...(args.has("on") ? { auto: true } : {}),
        ...(args.has("off") ? { auto: false } : {}),
        ...(args.has("guards") ? { autoGuards: true } : {}),
        ...(args.has("no-guards") ? { autoGuards: false } : {}),
        ...(args.has("no-full-runs") ? { noFullRuns: true } : {}),
        ...(py || ts ? { autoTest: { ...config.autoTest, ...(py ? { py } : {}), ...(ts ? { ts } : {}) } } : {}),
        ...(args.flags("exclude").length > 0 ? { autoExclude: [...new Set([...(config.autoExclude ?? []), ...args.flags("exclude")])] } : {}),
        ...(args.flags("not-ours").length > 0 ? { notOurs: [...new Set([...(config.notOurs ?? []), ...args.flags("not-ours")])] } : {}),
      };
      writeJson(writeTarget(root, "config.json", inRepo), next);
      // The mark of the switch lives beside the loop's state, where a rewrite of the config cannot remove it.
      if (args.has("on") || args.has("off")) markSwitch({ root, on: args.has("on") });
      say(`Autonomous loop for ${normRoot(root)}: ${next.auto ? "on" : "off"}. Written tests for fixes: ${next.autoGuards ? "on (one model call a pass)" : "off"}. Test commands: ${JSON.stringify(next.autoTest ?? {})}. Never touched: ${(next.autoExclude ?? []).join(", ") || "nothing excluded"}. Not ours: ${(next.notOurs ?? []).join(", ") || "none"}.`);
      if (args.has("on") || args.has("off") || args.has("guards") || args.has("no-guards") || args.has("no-full-runs")) return 0;
    }
    const report = runAuto({ root, backlog: args.has("backlog") });
    if (!args.has("quiet")) {
      say(report.skipped ? `Nothing done: ${report.skipped}.` : [...report.changes.map((c) => `CHANGED: ${c.what} Undo: ${c.undo}`), ...report.notes.map((n) => `noted: ${n}`), report.level ? `Verification level: ${report.level.level} ${report.level.name}.` : ""].filter(Boolean).join("\n") || "Nothing to change.");
    }
    try {
      writeText(path.join(home(), "dashboard.html"), renderDashboard({ projects: allAssessments(), now: new Date().toISOString() }));
    } catch {
      // the page is a view of the records; a fault in it changes nothing
    }
    return 0;
  }

  if (command === "backtest") {
    const named = args.flag("shapes", "");
    const shapes: readonly Shape[] = named === "" ? DEFAULT_SHAPES : named === "all" ? ALL_SHAPES : ALL_SHAPES.filter((x) => named.split(",").includes(x));
    const num = (name: string, fallback: number): number => Number(args.flag(name, String(fallback)));
    const max = num("max", 400);
    const from = num("from", 0);
    const cap = num("cap", DEFAULT_CAP);
    const to = args.has("to") ? num("to", 0) : undefined;
    const tag = `${max}-${from}-${to ?? "end"}-${cap}-${[...shapes].sort().join("+")}`.replace(/[^\w+-]/g, "_");
    const statePath = path.join(projectDir(root), "backtest", `${tag}.json`);
    const state = backtest({ root, max, from, ...(to === undefined ? {} : { to }), cap, shapes, exclude: readConfig(root).autoExclude ?? [], minutes: num("minutes", 20), statePath, resume: args.has("resume") });
    say(args.has("json") ? JSON.stringify({ root: normRoot(root), cap, shapes, done: state.done, ...summarize(state) }) : `${renderBacktest({ root: normRoot(root), state })}\nState: ${statePath}`);
    return 0;
  }

  if (command === "baseline") {
    // The mapped commands, run once on the tree as it is, a few minutes at a time; run it again to go on.
    const step = baselineStep({ root, max: Number(args.flag("max", "200")), minutes: Number(args.flag("minutes", "10")) });
    say(step.baseline ? renderBaseline(step.baseline) : (step.note ?? "nothing run"));
    if (step.note && step.baseline) say(step.note);
    return 0;
  }

  if (command === "limits") {
    // The turn-end limits: what they are, their floor and ceiling, what the records say, and the replay (an estimate).
    const configFile = projectFile(root, "config.json");
    if (args.has("on") || args.has("off")) {
      const { autoLimitsOn: _was, ...rest } = readConfig(root);
      writeJson(configFile, args.has("on") ? { ...rest, autoLimitsOn: true } : rest);
      say(`The loop ${args.has("on") ? "may move the turn-end limits of this project from now on, one step a pass" : "no longer moves the turn-end limits of this project"}. A value it set is in "autoLimits" in ${configFile}; taking that out is the undo.`);
    }
    const config = readConfig(root);
    const records = realRecords(root);
    const stats = turnStats(records);
    const limits = effectiveLimits(config);
    const tests = config.tests ?? [];
    const top = ceiling({ stats, limits, mapped: tests.filter((t) => !isWritten(t)).length, written: tests.filter(isWritten).length });
    say(renderLimits({ limits, top, stats, waits: readJson<Record<string, number>>(projectFile(root, "waits.json"), {}), ends: unrunAtEnd(records), on: config.autoLimitsOn === true }));
    if (args.has("replay")) {
      say("");
      say(`Replay of the ${records.length} turn record(s) on file, per session in order. AN ESTIMATE: a test run early is taken as passed and not owed again until the record shows it ran.`);
      for (const extra of [0, 1, 2, 4, 8]) {
        const r = replay({ records, extra });
        say(`  ${extra === 0 ? "as recorded" : `${extra} more test(s) a turn end`}: tests still unrun at a session's last turn ${r.unrunAfter} (in ${r.sessionsWithUnrunAfter} of ${r.sessions} session(s))${extra === 0 ? "" : `; ${r.extraRuns} more run(s), about ${r.extraSeconds} s in all over ${r.turns} turn(s)`}.`);
      }
      say("  The drain (a turn end with nothing changed runs what is owed) is not in these records: a turn end that ran nothing left no record, so how many there were is not known.");
    }
    return 0;
  }

  if (command === "lessons") {
    // The lesson card. It reads; it writes only where the project's log is on.
    const configFile = projectFile(root, "config.json");
    if (args.has("on") || args.has("off")) {
      const { lessonsLog: _was, ...rest } = readConfig(root);
      writeJson(configFile, args.has("on") ? { ...rest, lessonsLog: true } : rest);
      say(args.has("on") ? `The lesson card's log is on for this project: each pass of the loop adds one line to ${path.join(projectDir(root), "lessons.jsonl")} and writes lessons.md beside it. Undo: ratchet lessons --off (the lines already kept stay).` : "The lesson card's log is off for this project. The lines already kept stay where they are.");
    }
    const time = new Date().toISOString();
    if (args.has("record")) {
      const latest = path.join(projectDir(root), "latest.md");
      say(fs.existsSync(latest) ? fs.readFileSync(latest, "utf8") : "No verification record yet.");
      if (fs.existsSync(latest)) logShown({ root, time, agent: (process.env.CLAUDECODE ?? "") !== "" });
      return 0;
    }
    if (args.has("on") && logLessons({ root, time })) say("");
    const facts = gatherLessonFacts(root);
    say(renderLessons({ root: normRoot(root), rows: lessonCard(facts), logOn: facts.logOn, time }));
    return 0;
  }

  if (command === "level") {
    const unseen = offUnseen(root);
    if (unseen) say(unseen);
    say(renderLevel({ root: normRoot(root), level: levelOf(gatherFacts(root)) }));
    return 0;
  }

  if (command === "dashboard") {
    const out = path.resolve(args.flag("out", path.join(home(), "dashboard.html")));
    writeText(out, renderDashboard({ projects: allAssessments(), now: new Date().toISOString() }));
    say(`Dashboard written to ${out}`);
    return 0;
  }

  if (command === "features") {
    const text = renderFeatureMap({ root: normRoot(root), rows: featureMap({ files: trackedFiles(root), rules: readRules(root), config: readConfig(root) }) });
    const file = path.join(projectDir(root), "features.md");
    writeText(file, text);
    say(`${text}\nWritten to ${file}`);
    return 0;
  }

  if (command === "init") {
    const target = writeTarget(root, "config.json", inRepo);
    if (fs.existsSync(target) && !args.has("force")) {
      say(`A config is already there: ${target}. Use --force to write it again.`);
      return 1;
    }
    const pkg = readJson<{ scripts?: Record<string, string> }>(path.join(root, "package.json"), {});
    const pyproject = readSource(path.join(root, "pyproject.toml")) ?? "";
    const config = detectConfig({ scripts: pkg.scripts ?? {}, hasRuff: /\[tool\.ruff/.test(pyproject) || fs.existsSync(path.join(root, "ruff.toml")) });
    config.hatchCeiling = countHatches(root).total;
    // Writing the config again never switches the loop off: its switches, its limits and what it mapped itself are carried over.
    const old = readConfig(root);
    for (const key of ["auto", "autoGuards", "autoTest", "autoExclude", "notOurs", "autoLimitsOn", "autoLimits", "lessonsLog"] as const) if (old[key] !== undefined) Object.assign(config, { [key]: old[key] });
    const mine = (list: CheckCmd[] | undefined, have: CheckCmd[] | undefined): CheckCmd[] => (list ?? []).filter((c) => c.origin === "auto" && !(have ?? []).some((h) => h.name === c.name));
    if (mine(old.tests, config.tests).length > 0) config.tests = [...(config.tests ?? []), ...mine(old.tests, config.tests)];
    if (mine(old.checks, config.checks).length > 0) config.checks = [...(config.checks ?? []), ...mine(old.checks, config.checks)];
    // --keep-own: what a person wrote survives too (commands of their own, not found by detection, and the limits they set). Without it, init --force starts their part afresh.
    const keptOwn: string[] = [];
    if (args.has("keep-own")) {
      const own = (list: CheckCmd[] | undefined, have: CheckCmd[] | undefined): CheckCmd[] => (list ?? []).filter((c) => c.origin !== "auto" && !(have ?? []).some((h) => h.name === c.name));
      for (const key of ["checks", "tests", "drivers"] as const) {
        const add = own(old[key], config[key]);
        if (add.length > 0) {
          config[key] = [...(config[key] ?? []), ...add];
          keptOwn.push(...add.map((c) => c.name));
        }
      }
      for (const key of ["budgetS", "maxTestsPerStop"] as const) if (old[key] !== undefined) Object.assign(config, { [key]: old[key] });
    }
    writeJson(target, config);
    say(`Wrote ${target}: checks ${(config.checks ?? []).map((c) => c.name).join(", ") || "none"}; escape hatch ceiling ${config.hatchCeiling}.${keptOwn.length > 0 ? ` Kept your own: ${keptOwn.join(", ")}.` : ""}`);
    say(`No test is run until you map files to the one test that covers them, for example: "tests": [{ "name": "parser", "when": ["src/parse/**"], "command": "npx vitest run test/parse.test.ts", "timeoutS": 60 }]`);
    return 0;
  }

  if (command === "rule" && sub === "list") {
    const rules = readRules(root);
    say(rules.length === 0 ? "No rules." : rules.map((r) => `${r.id} (${r.kind} ${JSON.stringify(r.pattern)} in ${r.files.join(", ")}): ${r.proof ? `proven on ${r.proof.commit.slice(0, 8)} (fired on ${r.proof.firedBefore} removed line(s), ${r.proof.firedAfter} added)` : "not proven on a past fix"}; backlog ${sum(r.baseline ?? {})}. Fix: ${r.fix}`).join("\n"));
    return 0;
  }
  if (command === "rule" && sub === "remove") {
    const id = args.flag("id", "");
    const rules = readRules(root);
    if (!rules.some((r) => r.id === id)) throw new Error(`no rule ${id}`);
    writeJson(projectFile(root, "rules.json"), rules.filter((r) => r.id !== id));
    say(`Removed rule ${id}.`);
    return 0;
  }
  if (command === "rule" && sub === "add") {
    const rule: Rule = { id: args.flag("id", ""), kind: args.flag("kind", "ban-pattern") as Rule["kind"], pattern: args.flag("pattern", ""), files: args.flags("files"), message: args.flag("message", ""), fix: args.flag("fix", ""), ...(args.flag("scope", "") ? { scope: args.flag("scope", "") as "line" | "statement" } : {}) };
    const problems = ruleProblems(rule);
    const rules = readRules(root);
    if (rules.some((r) => r.id === rule.id)) problems.push(`a rule named ${rule.id} exists: remove it first`);
    if (problems.length > 0) {
      say(`Rule refused:\n${problems.map((p) => `- ${p}`).join("\n")}`);
      return 1;
    }
    const commit = args.flag("proof-commit", "");
    if (commit) {
      const file = args.flag("proof-file", "");
      const proof = proveRule({ root, rule, commit, file });
      if (proof === null) throw new Error(`${file} is not in ${commit} and its parent`);
      if (!proof.proven) {
        say(`Rule refused: it is not the check for that fix. In ${file} it fires on ${proof.onRemoved} line(s) that ${commit.slice(0, 8)} removed and on ${proof.onAdded} it added. It must fire on a removed line and on no added line.`);
        return 1;
      }
      rule.proof = { commit: execFileSync("git", ["-C", root, "rev-parse", commit], { encoding: "utf8" }).trim(), file, firedBefore: proof.onRemoved, firedAfter: proof.onAdded };
    }
    const found = census(root, rule);
    if (Object.keys(found).length > 0) rule.baseline = found;
    writeJson(writeTarget(root, "rules.json", inRepo), [...rules, rule]);
    say(`Rule ${rule.id} added${rule.proof ? `, proven on ${rule.proof.commit.slice(0, 8)}: fired on ${rule.proof.firedBefore} line(s) the fix removed, on none it added` : ", NOT proven on a past fix (give --proof-commit and --proof-file)"}.`);
    say(Object.keys(found).length === 0 ? "Census: it fires nowhere in the repository now." : `Census: ${sum(found)} more of the same in ${Object.keys(found).length} file(s), kept as the backlog (may fall, never rise): ${top(found, 8)}.`);
    return 0;
  }

  if (command === "must-not") {
    const file = writeTarget(root, "must-not-flag.json", inRepo);
    const have = readMustNot(root);
    if (sub === "list") {
      say(have.length === 0 ? "No must-not-flag case." : have.map((m) => `/${m.pattern}/ in ${m.files.join(", ")}: ${m.reason}`).join("\n"));
      return 0;
    }
    let add: MustNot[] = [];
    if (sub === "add") {
      const one: MustNot = { files: args.flags("files"), pattern: args.flag("pattern", ""), reason: args.flag("reason", "") };
      const problems = [...(one.files.length === 0 ? ["files is missing"] : []), ...(one.pattern === "" ? ["pattern is missing"] : []), ...(one.reason.trim() === "" ? ["reason is missing: say why the place is fine"] : [])];
      try {
        new RegExp(one.pattern);
      } catch (e) {
        problems.push(`pattern is not a regular expression: ${(e as Error).message}`);
      }
      if (problems.length > 0) {
        say(`Case refused:\n${problems.map((p) => `- ${p}`).join("\n")}`);
        return 1;
      }
      add = [one];
    } else if (sub === "from-vault") {
      const checked: Checked[] = args.flags("review").flatMap((f) => {
        const data = readJson<ReviewResult | { reviews?: ReviewResult[] }>(path.resolve(f), { reviews: [] });
        return "checked" in data ? data.checked : (data.reviews ?? []).flatMap((r) => r.checked);
      });
      const got = mustNotFromRulings({ rulings: readRulings(path.resolve(args.flag("vault", ""))), checked });
      add = got.cases;
      if (got.unmatched.length > 0) say(`${got.unmatched.length} false-alarm ruling(s) match no finding in the given review files: ${got.unmatched.join(", ")}`);
    } else {
      console.error(HARNESS_USAGE);
      return 2;
    }
    const fresh = add.filter((m) => !have.some((h) => h.pattern === m.pattern && h.files.join() === m.files.join()));
    writeJson(file, [...have, ...fresh]);
    say(`${fresh.length} case(s) added, ${have.length + fresh.length} in ${file}. They apply when a review is run with --must-not-flag.`);
    return 0;
  }

  if (command === "census") {
    const rules = readRules(root);
    if (rules.length === 0) say("No rules.");
    let over = 0;
    for (const rule of rules) {
      const now = census(root, rule);
      const risen = Object.entries(now).filter(([f, n]) => n > (rule.baseline?.[f] ?? 0));
      over += risen.length;
      say(`${rule.id}: ${sum(now)} now, backlog was ${sum(rule.baseline ?? {})}${risen.length > 0 ? `; RISEN in ${risen.map(([f, n]) => `${f} (${rule.baseline?.[f] ?? 0} to ${n})`).join(", ")}` : ""}.`);
      if (args.has("tighten") && rule.baseline) {
        // The backlog only ever falls: each file keeps the lower of what it was allowed and what it has now.
        const lower = Object.fromEntries(Object.entries(rule.baseline).map(([f, n]) => [f, Math.min(n, now[f] ?? 0)] as const).filter(([, n]) => n > 0));
        if (sum(lower) < sum(rule.baseline)) say(`  backlog lowered from ${sum(rule.baseline)} to ${sum(lower)}.`);
        rule.baseline = lower;
      }
    }
    if (args.has("tighten")) writeJson(writeTarget(root, "rules.json", inRepo), rules);
    return over > 0 ? 1 : 0;
  }

  if (command === "comments") {
    const configFile = projectFile(root, "config.json");
    const config = readConfig(root);
    const wanted = args.flag("mode", "");
    if (wanted !== "") {
      if (wanted !== "off" && wanted !== "excuses" && wanted !== "ban") {
        say("--mode is off, excuses or ban.");
        return 1;
      }
      const allow = [...(config.comments?.allow ?? []), ...args.flags("allow")];
      for (const source of allow) {
        try {
          new RegExp(source);
        } catch {
          say(`--allow ${source} is not a regular expression.`);
          return 1;
        }
      }
      writeJson(configFile, { ...config, comments: { mode: wanted, ...(allow.length > 0 ? { allow } : {}) } });
      say(`Comments: mode ${wanted}${allow.length > 0 ? `, allowed: ${allow.join(" | ")}` : ""}. Only comments a session adds are charged; those already there never are.`);
      return 0;
    }
    const now = readConfig(root).comments ?? {};
    let total = 0;
    const byFile: Record<string, number> = {};
    for (const file of trackedFiles(root)) {
      const text = readSource(path.join(root, file));
      if (text === null) continue;
      const n = findComments(file, text).length;
      if (n > 0) {
        total += n;
        byFile[file] = n;
      }
    }
    say(`Comments: mode ${now.mode ?? "off"}${(now.allow ?? []).length > 0 ? `, allowed: ${(now.allow ?? []).join(" | ")}` : ""}. Comment lines in tracked source files: ${total}.`);
    if (total > 0) say(`Most: ${top(byFile, 8)}.`);
    return 0;
  }

  if (command === "hatches") {
    const found = countHatches(root);
    const configFile = projectFile(root, "config.json");
    const config = readConfig(root);
    say(`Escape hatches in tracked source files: ${found.total}${config.hatchCeiling === undefined ? " (no ceiling stored)" : `, ceiling ${config.hatchCeiling}`}.`);
    if (found.total > 0) say(`By kind: ${top(found.byName, 12)}.\nMost: ${top(found.byFile, 8)}.`);
    if (args.has("set-ceiling")) {
      if (config.hatchCeiling !== undefined && found.total > config.hatchCeiling) {
        say("The count is above the stored ceiling. The harness lowers a ceiling, it never raises one: edit the config by hand if the rise is accepted.");
        return 1;
      }
      writeJson(configFile, { ...config, hatchCeiling: found.total });
      say(`Ceiling set to ${found.total} in ${configFile}.`);
    }
    return config.hatchCeiling !== undefined && found.total > config.hatchCeiling ? 1 : 0;
  }

  if (command === "measure") {
    const last = Number(args.flag("last", "200"));
    const log = parseLog(execFileSync("git", ["-C", root, "log", `-${last}`, "--no-merges", "--format=%x01%H%x09%ct%x09%s", "--name-only"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
    const state = readState();
    const since = state.projects[normRoot(root)]?.since ?? (effective(state, root).enabled ? state.since : undefined);
    const cut = since ? Date.parse(since) / 1000 : null;
    const rules = readRules(root);
    const hatches = countHatches(root);
    const config = readConfig(root);
    const dir = path.join(projectDir(root), "records");
    const records = fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => readJson<{ held?: boolean; findings?: { blocking: boolean }[]; notRun?: string[] }>(path.join(dir, f), {})) : [];
    const failing = records.filter((r) => (r.findings ?? []).some((f) => f.blocking)).length;
    say(
      [
        `Repository: ${normRoot(root)}.`,
        renderOutcomes(`Outcomes (T15), last ${log.length} commits`, outcomes({ commits: log })),
        ...(cut === null
          ? ["The harness has never been switched on here, so there is no before and after."]
          : [
              renderOutcomes(`  Before the harness was switched on (${since?.slice(0, 10)})`, outcomes({ commits: log.filter((c) => c.time < cut) })),
              renderOutcomes("  Since", outcomes({ commits: log.filter((c) => c.time >= cut) })),
              "  A difference between the two means something only after weeks of commits, and other things change over the same weeks.",
            ]),
        "A fix is read from the subject line; a fix of a fix touches a source file another fix touched in the 14 days before. Stand-ins, not rulings.",
        `Rules: ${rules.length}, of which ${rules.filter((r) => r.proof).length} proven on a past fix; backlog ${rules.reduce((a, r) => a + sum(r.baseline ?? {}), 0)}.`,
        `Escape hatches: ${hatches.total}${config.hatchCeiling === undefined ? ", no ceiling stored" : `, ceiling ${config.hatchCeiling}`}.`,
        `Turns recorded: ${records.length}; with a failure of the session: ${failing}; held: ${records.filter((r) => r.held).length}; with a check that could not run: ${records.filter((r) => (r.notRun ?? []).length > 0).length}.`,
        "Model review: trust level 0 until rulings exist (AUDIT.md). The numbers above come from programs only.",
      ].join("\n"),
    );
    return 0;
  }

  console.error(HARNESS_USAGE);
  return 2;
};
