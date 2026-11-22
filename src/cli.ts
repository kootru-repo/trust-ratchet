import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { rescoreBench, runBench, type CaseFile } from "./bench.ts";
import { reviewCommit } from "./commit.ts";
import { readTranscripts, renderEffort } from "./effort.ts";
import { mineCases } from "./history.ts";
import type { CheckSpec } from "./layer0.ts";
import { here, runCheck } from "./git.ts";
import { hitMap, judgeGuards, judgeRetirement, promote, prove, renderGuards, renderRetirement, type GuardFile, type Proof } from "./guard.ts";
import { claudeModel } from "./model.ts";
import { packFor } from "./packs/index.ts";
import type { ReproConfig } from "./repro.ts";
import { renderReport } from "./report.ts";
import { reviewFile } from "./review.ts";
import { initVault, syncVault, writeReview } from "./vault.ts";
import { HARNESS_COMMANDS, HARNESS_USAGE, harnessCli } from "./harness/cli.ts";
import { checkLogFile } from "./harness/decisionlog.ts";
import { checkDrivers, renderDriverFaults } from "./harness/drivers.ts";
import { autoMergeMayBeOn, readGates, refusal } from "./harness/mergeclass.ts";
import { DEFAULT_LIMITS, decideLaunch, readMachine } from "./swarm/launchgate.ts";
import { countTokens, readSession, renderTokens } from "./harness/tokens.ts";
import { recordGuard, writeGuard } from "./harness/guardwriter.ts";
import { adopt, faultReturns, renderSweep, summarizeSweep, sweep, walk, walkFixes, type SweepState } from "./harness/guardsweep.ts";
import { readConfig } from "./harness/state.ts";
import { repoRoot } from "./harness/session.ts";
import { projectDir } from "./harness/state.ts";
import { reviewWork } from "./harness/work.ts";
import { readMustNot } from "./harness/cli.ts";
import { guidesFor, type ReviewOptions } from "./options.ts";
import { projectFile } from "./harness/state.ts";

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? fallback) : fallback;
};
const flags = (name: string): string[] => argv.flatMap((a, i) => (a === `--${name}` && argv[i + 1] !== undefined ? [argv[i + 1] as string] : []));
const log = (line: string): void => console.error(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

const USAGE = `ratchet launchgate [--workers <n>] [--max-workers <n>] [--max-ram <pct>]   (exit 0 start, 1 wait)
ratchet gates [--project <dir>] [--file <gates.json>]   (exit 0 when row 18 allows auto-merge, 1 when rows are open)
ratchet decisions <log.md> [--repo <dir>] [--previous <file>]
ratchet drivers [--project <dir>]   (checks each configured driver against the contract; runs them)
ratchet tokens <session.jsonl> [--pattern <regex>]...
ratchet review <root> <file> [--check "<command>"]... [--check-dir <dir>] [--repro-pkg <dir>] [--deps-from <dir>] [--alias "~=src"]... [--python <exe>] [--extra <specialist>]...
                              [--vault <dir>] [--target <name>] [--model sonnet] [--max-checks 40] [--out report.md]
ratchet bench [--cases bench/cases.json] [--results bench/results] [--limit 4] [--only <case id>] [--no-controls] [--rescore] [--repro] [--audit-local 3] [--require-reads 2] [--guards <dir>] [--vault <dir>] [--model sonnet]
ratchet bench mine --repo <dir> --prefix <path> [--exclude-cases <file>]... [--max 10] [--max-changed 40] [--max-patch 400] [--target <name>] [--out bench/cases-fresh.json]
                              find fix commits and the commits that wrote the bugs, mechanically
ratchet review-commit <repo> <rev> [--repro-pkg <dir>] [--deps-from <dir>] [--check "<command>"]... [--check-file "<command>"]... [--max-files 6] [--out report.md]
                              review a commit as a patch (--check-file keeps only output lines about the reviewed file)
ratchet effort <results dir>                                                   turns and tokens per kind of call, from saved transcripts
ratchet guard promote [--cases <file>] [--results <dir>] [--guards <dir>]     turn reproduced tests into case guards
ratchet guard prove [--cases <file>] [--guards <dir>]                          run every guard on the buggy and the fixed tree
ratchet retire <specialist> [--cases <file>] [--results <dir>] [--guards <dir>] [--limit 20] [--audit-local 3] [--guard-facts]
                              give it the same --audit-local and guard facts as the baseline run in --results
ratchet vault init <dir> --schema <dg schema json>
ratchet vault sync <dir>
ratchet review-work [--project <dir>] [--since HEAD] [--max-files 3] [--out report.md]   review the change not yet committed, by reviewers that never saw the session
  a report puts its confirmed findings to the author as questions; --no-questions gives the status list
  optional, off by default (review and review-work): [--verifier-reads <n>] [--budget] [--guides [--guides-dir <dir>]] [--must-not-flag] [--property] [--mask-comments] [--escalate-local] [--message-to-all (for measuring bias)]`;

/**
 * The optional review mechanisms, from flags. All off by default: none has been through a benchmark run.
 * Guides and ruled false alarms are read from the project's folder under the harness home, or from .ratchet/ in the repository.
 */
const wholeNumber = (name: string): number => {
  const n = Number(flag(name, ""));
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a whole number, 0 or more`);
  return n;
};
const optionsFor = (root: string) => (file: string): ReviewOptions => ({
  ...(flag("verifier-reads", "") ? { verifierReads: wholeNumber("verifier-reads") } : {}),
  ...(argv.includes("--budget") ? { budget: true } : {}),
  ...(argv.includes("--guides") ? { guides: guidesFor({ dir: flag("guides-dir", projectFile(root, "guides")), file }) } : {}),
  ...(argv.includes("--must-not-flag") ? { mustNotFlag: readMustNot(root) } : {}),
  ...(argv.includes("--property") ? { property: true } : {}),
  ...(argv.includes("--message-to-all") ? { messageToAll: true } : {}),
  ...(argv.includes("--mask-comments") ? { maskComments: true } : {}),
  ...(argv.includes("--escalate-local") ? { escalateLocal: true } : {}),
});

const main = async (): Promise<void> => {
  if (argv[0] === "guard-sweep") {
    // The measure of the written tests: a seeded sample of past fixes, one model call each, then a walk forward. Resumable.
    const root = repoRoot(path.resolve(flag("project", process.cwd())));
    if (!root) throw new Error("not a git repository");
    const config = readConfig(root);
    const py = flag("py-test", config.autoTest?.py ?? "");
    const ts = flag("ts-test", config.autoTest?.ts ?? "");
    const seed = flag("seed", "2026-11-20");
    const n = Number(flag("n", "12"));
    const statePath = path.join(projectDir(root), "guardsweep", `${seed}-${n}.json`);
    // (A sweep with its own test style keeps its own state: the seed names it.)
    const minutes = Number(flag("minutes", "20"));
    let state = argv.includes("--walk") || argv.includes("--show") || argv.includes("--adopt") || argv.includes("--walk-fixes") || argv.includes("--fault-returns") ? null : await sweep({ root, model: claudeModel({ model: flag("model", "sonnet"), concurrency: 1, timeoutMs: 5 * 60_000 }), statePath, n, seed, templates: { ...(py ? { py } : {}), ...(ts ? { ts } : {}) }, exclude: [...(config.autoExclude ?? []), ...flags("exclude")], only: flags("only"), ...(flag("after", "") ? { after: flag("after", "") } : {}), ...(flag("style-file", "") ? { style: fs.readFileSync(flag("style-file", ""), "utf8").split(/\r?\n/).filter(Boolean) } : {}), minutes });
    if (argv.includes("--adopt")) {
      const done = adopt({ statePath, projectDirOf: projectDir(root), configFile: path.join(projectDir(root), "config.json") });
      for (const c of done.changes) recordGuard({ root, change: c, note: null });
      console.log(`Adopted: ${done.adopted.join(", ") || "none"}. Not adopted: ${done.skipped.join("; ") || "none"}.`);
      return;
    }
    if (argv.includes("--fault-returns")) {
      const rows = Object.values(faultReturns({ statePath }));
      const undone = rows.filter((x) => x.undone);
      console.log(`If the fault came back today: ${rows.length} kept test(s); the fix could still be taken out of the tree at HEAD for ${undone.length}; of those the test fails by an assertion (it would catch the return) for ${undone.filter((x) => x.ran === "fails").length}, does not load or throws for ${undone.filter((x) => x.ran === "errors").length}, and still passes (it would miss it) for ${undone.filter((x) => x.ran === "passes").length}.`);
      return;
    }
    if (argv.includes("--walk-fixes")) {
      const w = walkFixes({ statePath, minutes, paths: flags("paths") });
      const rows = Object.values(w.fixWalk);
      console.log(`Walked over every later fix commit: ${rows.length} kept test(s), ${rows.reduce((n, x) => n + x.laterFixes, 0)} later fix commits in all; failing by an assertion at a later fix's parent: ${rows.reduce((n, x) => n + x.failingAtParent, 0)}; caught (then passing at that fix): ${rows.reduce((n, x) => n + x.caught.length, 0)}.`);
      return;
    }
    if (argv.includes("--walk")) state = walk({ statePath, minutes, maxLater: Number(flag("max-later", "30")) });
    if (!state) state = JSON.parse(fs.readFileSync(statePath, "utf8")) as SweepState;
    console.log(argv.includes("--json") ? JSON.stringify(summarizeSweep(state)) : renderSweep(state));
    return;
  }
  if (argv[0] === "launchgate") {
    const workers = Number(flag("workers", "0"));
    const d = decideLaunch(await readMachine(workers), { ...DEFAULT_LIMITS, maxWorkers: Number(flag("max-workers", String(DEFAULT_LIMITS.maxWorkers))), maxRamPercent: Number(flag("max-ram", String(DEFAULT_LIMITS.maxRamPercent))) });
    console.log(d.start ? "start" : `wait: ${d.reasons.join("; ")}`);
    process.exitCode = d.start ? 0 : 1;
    return;
  }
  if (argv[0] === "gates") {
    const root = repoRoot(path.resolve(flag("project", process.cwd())));
    const file = path.join(root ?? process.cwd(), flag("file", "proof/gates.json"));
    const sw = autoMergeMayBeOn(readGates(file));
    console.log(sw.allowed ? "auto-merge may be switched on: every listed row is closed" : refusal(sw));
    process.exitCode = sw.allowed ? 0 : 1;
    return;
  }
  if (argv[0] === "decisions") {
    const file = argv[1];
    if (!file || file.startsWith("--")) {
      console.error("ratchet decisions <log.md> [--repo <dir>] [--previous <older copy>]   Checks the decision log: six columns, evidence pointers resolve, old rows unchanged.");
      process.exitCode = 2;
      return;
    }
    const prev = flag("previous", "");
    const problems = checkLogFile({ file: path.resolve(file), repo: path.resolve(flag("repo", process.cwd())), ...(prev ? { previous: fs.readFileSync(path.resolve(prev), "utf8") } : {}) });
    console.log(problems.length === 0 ? "decision log ok" : problems.map((p) => `line ${p.line}: ${p.problem}`).join(String.fromCharCode(10)));
    process.exitCode = problems.length === 0 ? 0 : 1;
    return;
  }
  if (argv[0] === "drivers") {
    const root = repoRoot(path.resolve(flag("project", process.cwd())));
    if (!root) {
      console.error("ratchet drivers --project <dir>   Not inside a git repository: give --project a repository folder.");
      process.exitCode = 2;
      return;
    }
    const drivers = (readConfig(root).drivers ?? []).map((d) => ({ name: d.name, command: d.command }));
    const gitOut = (a: string[]): string => spawnSync("git", ["-C", root, ...a], { encoding: "utf8" }).stdout ?? "";
    const faults = checkDrivers(drivers, {
      run: (command, args) => {
        const r = spawnSync(command, args, { cwd: root, encoding: "utf8", shell: true, timeout: 60_000 });
        return { code: r.status ?? 2, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      },
      tree: () => gitOut(["status", "--porcelain"]) + gitOut(["diff"]),
    });
    console.log(renderDriverFaults(drivers, faults).join(String.fromCharCode(10)));
    process.exitCode = faults.length === 0 ? 0 : 1;
    return;
  }
  if (argv[0] === "tokens") {
    const transcript = argv[1];
    if (!transcript || transcript.startsWith("--")) {
      console.error("ratchet tokens <session.jsonl> [--pattern <regex>]...   Counts tokens by kind, subagents included.");
      process.exitCode = 2;
      return;
    }
    const patterns = argv.flatMap((a, i) => (a === "--pattern" && argv[i + 1] ? [argv[i + 1] as string] : []));
    const { main: mainText, subagents } = readSession(fs, path.join, path.resolve(transcript));
    console.log(renderTokens(countTokens({ main: mainText, subagents, patterns })).join(String.fromCharCode(10)));
    return;
  }
  if (HARNESS_COMMANDS.has(argv[0] ?? "")) {
    process.exitCode = harnessCli(argv, here());
    // The one part of the loop that calls a model: a written test for a fix, kept only when a program proved it.
    if (argv[0] === "auto" && !["--on", "--off", "--guards", "--no-guards", "--no-full-runs"].some((f) => argv.includes(f))) {
      try {
        const root = repoRoot(path.resolve(flag("project", process.cwd())));
        if (root && readConfig(root).auto && readConfig(root).autoGuards) {
          const only = flag("guard-commit", "");
          const step = await writeGuard({ root, model: claudeModel({ model: flag("model", "sonnet"), concurrency: 1, timeoutMs: 5 * 60_000 }), ...(only ? { only } : {}) });
          recordGuard({ root, change: step.change, note: step.note });
          if (!argv.includes("--quiet")) for (const line of [step.change ? `CHANGED: ${step.change.what} Undo: ${step.change.undo}` : "", step.note ? `noted: ${step.note}` : ""]) if (line) console.log(line);
        }
      } catch (e) {
        if (!argv.includes("--quiet")) console.log(`The guard step did not run: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      }
    }
    return;
  }
  const modelName = flag("model", "sonnet");
  // Transcripts sit next to the results they belong to.
  const resultsFlag = path.resolve(flag("results", here("bench", "results")));
  // The specialist-off arm keeps its transcripts with its own results, never with the baseline it is compared to.
  const transcriptBase = argv[0] === "retire" ? `${resultsFlag}-without-${argv[1] ?? ""}` : argv[0] === "bench" ? resultsFlag : flag("out", "") ? path.dirname(path.resolve(flag("out", ""))) : "";
  const model = claudeModel({ model: modelName, log, ...(transcriptBase ? { transcriptDir: path.join(transcriptBase, "transcripts") } : {}) });
  const [command, a, b] = argv;
  const vault = flag("vault", "");

  if (command === "review" && a && b && !a.startsWith("--") && !b.startsWith("--")) {
    const root = path.resolve(a);
    const checkDir = path.resolve(root, flag("check-dir", "."));
    // Layer 0: deterministic checks run first and reach the reviewers as facts.
    const pack = packFor(b);
    const facts = [...pack.defaultChecks(b.replace(/\\/g, "/")), ...flags("check")].map((c) => {
      log(`check: ${c}`);
      return runCheck({ command: c, cwd: checkDir });
    });
    const pkg = flag("repro-pkg", "");
    const depsFrom = flag("deps-from", "");
    const python = flag("python", "");
    const config: ReproConfig | undefined = pkg
      ? { pkg, ...(depsFrom ? { depsFrom } : {}), ...(python ? { python } : {}), alias: Object.fromEntries(flags("alias").map((x) => x.split("=") as [string, string])) }
      : undefined;
    const result = await reviewFile({
      root,
      file: b.replace(/\\/g, "/"),
      model,
      facts,
      maxChecks: Number(flag("max-checks", "40")),
      ...(config ? { repro: { pkg: config.pkg, runner: pack.runner(config) } } : {}),
      extras: flags("extra"),
      options: optionsFor(root)(b.replace(/\\/g, "/")),
    });
    const report = renderReport(result, { questions: !argv.includes("--no-questions") });
    const out = flag("out", "");
    if (out) {
      fs.writeFileSync(out, report);
      fs.writeFileSync(out.replace(/\.md$/, "") + ".json", JSON.stringify(result, null, 2));
      log(`report written to ${out}`);
    } else console.log(report);
    if (vault) {
      let commit = "working copy";
      try {
        commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      } catch {
        // not a git tree
      }
      const sync = writeReview({ vault: path.resolve(vault), review: result, meta: { target: flag("target", path.basename(root)), commit, model: modelName, when: new Date().toISOString() } });
      log(`vault: ${sync.written} notes written, ${sync.unchanged} unchanged${sync.handEdited.length ? `, ${sync.handEdited.length} left alone because someone edited them` : ""}`);
    }
    return;
  }

  if (command === "effort" && a) {
    console.log(renderEffort(readTranscripts(path.join(path.resolve(a), "transcripts"))));
    return;
  }

  if (command === "bench" && a === "mine") {
    const repo = path.resolve(flag("repo", "."));
    const exclude = flags("exclude-cases").flatMap((f) => (JSON.parse(fs.readFileSync(path.resolve(f), "utf8")) as CaseFile).cases.map((c) => c.fix));
    const cases = mineCases({ repo, prefix: flag("prefix", ""), exclude, max: Number(flag("max", "10")), maxChanged: Number(flag("max-changed", "40")), maxPatch: Number(flag("max-patch", "400")) });
    const out = path.resolve(flag("out", here("bench", "cases-fresh.json")));
    const base = fs.existsSync(out) ? (JSON.parse(fs.readFileSync(out, "utf8")) as CaseFile) : { target: flag("target", path.basename(repo)), repo: repo.split(path.sep).join("/"), paths: [flag("prefix", ".")], cases: [] };
    fs.writeFileSync(out, JSON.stringify({ ...base, cases }, null, 2) + "\n");
    log(`${cases.length} case(s) written to ${out}`);
    for (const c of cases) console.log(`${c.id}  fix ${c.fix}  wrote the bug ${c.intro ?? "?"}  ${c.file}`);
    return;
  }

  if (command === "review-commit" && a && b) {
    const pkg = flag("repro-pkg", "");
    const depsFrom = flag("deps-from", "");
    const checks: CheckSpec[] = [...flags("check").map((c) => ({ command: c })), ...flags("check-file").map((c) => ({ command: c, onlyFile: true }))];
    const { commit, reviews, skipped } = await reviewCommit({
      repo: path.resolve(a),
      rev: b,
      model,
      ...(pkg ? { config: { pkg, ...(depsFrom ? { depsFrom } : {}) } } : {}),
      checks,
      extras: flags("extra"),
      maxFiles: Number(flag("max-files", "6")),
      auditLocal: Number(flag("audit-local", "3")),
      log,
    });
    const report = [`# Review of commit ${commit.slice(0, 10)}`, "", ...(skipped.length ? [`Not reviewed (over the file limit): ${skipped.join(", ")}`, ""] : []), ...reviews.map((r) => renderReport(r))].join("\n");
    const out = flag("out", "");
    if (out) {
      fs.writeFileSync(out, report);
      fs.writeFileSync(out.replace(/\.md$/, "") + ".json", JSON.stringify({ commit, reviews, skipped }, null, 2));
      log(`report written to ${out}`);
    } else console.log(report);
    return;
  }

  if (command === "review-work") {
    const root = repoRoot(path.resolve(flag("project", ".")));
    if (!root) throw new Error("review-work needs a git repository");
    // At most two model calls at once: the machine is shared.
    const workModel = claudeModel({ model: modelName, concurrency: 2, log });
    const since = flag("since", "HEAD");
    const maxFiles = Number(flag("max-files", "3"));
    if (!Number.isInteger(maxFiles) || maxFiles < 1) throw new Error("--max-files must be a whole number, 1 or more");
    const { files, reviews, skipped } = await reviewWork({ root, since, model: workModel, maxFiles, log, optionsFor: optionsFor(root) });
    if (files.length === 0) {
      console.log(`Nothing to review: no source file in the working tree differs from ${since}.`);
      return;
    }
    const report = [`# Review of the working tree of ${root} against ${since}`, "", ...(skipped.length ? [`Not reviewed (over the file limit): ${skipped.join(", ")}`, ""] : []), ...reviews.map((r) => renderReport(r, { questions: !argv.includes("--no-questions") }))].join("\n");
    const out = flag("out", "") || path.join(projectDir(root), "reviews", `${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, report);
    fs.writeFileSync(out.replace(/\.md$/, "") + ".json", JSON.stringify({ root, reviews, skipped }, null, 2));
    console.log(`Reviewed ${files.join(", ")}. Confirmed findings: ${reviews.reduce((n, r) => n + r.checked.filter((c) => c.verdict === "confirmed").length, 0)}. Report: ${out}`);
    return;
  }

  if (command === "bench") {
    const casePath = path.resolve(flag("cases", here("bench", "cases.json")));
    const caseFile = JSON.parse(fs.readFileSync(casePath, "utf8")) as CaseFile;
    const only = flag("only", "");
    if (argv.includes("--rescore")) {
      // Recompute the scores of saved reviews with the current scoring rule. No model call.
      console.log(rescoreBench({ caseFile, resultsDir: path.resolve(flag("results", here("bench", "results"))), modelName, repro: argv.includes("--repro") }));
      return;
    }
    const summary = await runBench({
      caseFile,
      resultsDir: path.resolve(flag("results", here("bench", "results"))),
      model,
      modelName,
      limit: Number(flag("limit", "4")),
      controls: !argv.includes("--no-controls"),
      repro: argv.includes("--repro"),
      auditLocal: Number(flag("audit-local", "0")),
      requireReads: Number(flag("require-reads", "0")),
      optionsFor: optionsFor(caseFile.repo),
      generatedGuides: argv.includes("--guides-as-of"),
      ...(flag("guards", "") ? { guardsDir: path.resolve(flag("guards", "")) } : {}),
      ...(only ? { only } : {}),
      ...(vault ? { vault: path.resolve(vault) } : {}),
      log,
    });
    console.log(summary);
    return;
  }

  if (command === "guard" && (a === "promote" || a === "prove")) {
    const caseFile = JSON.parse(fs.readFileSync(path.resolve(flag("cases", here("bench", "cases.json"))), "utf8")) as CaseFile;
    const guardsDir = path.resolve(flag("guards", here("guards", caseFile.target)));
    if (a === "promote") {
      const data = promote({ caseFile, resultsDir: path.resolve(flag("results", here("bench", "results"))), guardsDir });
      log(`${data.guards.length} guard(s) in ${path.join(guardsDir, "guards.json")}`);
      return;
    }
    const guards = JSON.parse(fs.readFileSync(path.join(guardsDir, "guards.json"), "utf8")) as GuardFile;
    const proofs = prove({ caseFile, guards, guardsDir, log });
    const text = renderGuards(judgeGuards({ guards: guards.guards, proofs }));
    fs.writeFileSync(path.join(guardsDir, "PROOF.md"), text);
    console.log(text);
    return;
  }

  if (command === "retire" && a && !a.startsWith("--")) {
    const caseFile = JSON.parse(fs.readFileSync(path.resolve(flag("cases", here("bench", "cases.json"))), "utf8")) as CaseFile;
    const guardsDir = path.resolve(flag("guards", here("guards", caseFile.target)));
    const baselineDir = path.resolve(flag("results", here("bench", "results")));
    const withoutDir = `${baselineDir}-without-${a}`;
    // The specialist-off run: bug cases only, no reproduction, saved apart from the baseline.
    await runBench({ caseFile, resultsDir: withoutDir, model, modelName, limit: Number(flag("limit", "20")), controls: false, repro: false, without: [a], auditLocal: Number(flag("audit-local", "0")), ...(argv.includes("--guard-facts") ? { guardsDir } : {}), log });
    const guardFile = path.join(guardsDir, "guards.json");
    const guards = fs.existsSync(guardFile) ? (JSON.parse(fs.readFileSync(guardFile, "utf8")) as GuardFile).guards : [];
    const proofFile = path.join(guardsDir, "proofs.json");
    const proofs = fs.existsSync(proofFile) ? (JSON.parse(fs.readFileSync(proofFile, "utf8")) as Proof[]) : [];
    const result = judgeRetirement({
      specialist: a,
      caseIds: caseFile.cases.map((c) => c.id),
      baseline: hitMap({ caseFile, resultsDir: baselineDir }),
      without: hitMap({ caseFile, resultsDir: withoutDir }),
      reports: judgeGuards({ guards, proofs }),
    });
    const text = renderRetirement(result);
    fs.writeFileSync(path.join(withoutDir, "RETIREMENT.md"), text);
    console.log(text);
    return;
  }

  if (command === "vault" && a === "init" && b) {
    const schema = flag("schema", "");
    if (!schema) throw new Error("vault init needs --schema <path to a Discourse Graphs schema json>");
    initVault({ vault: path.resolve(b), schemaFrom: path.resolve(schema) });
    log(`vault ready at ${path.resolve(b)}`);
    return;
  }

  if (command === "vault" && a === "sync" && b) {
    console.log(syncVault(path.resolve(b)).dashboard);
    return;
  }

  console.error(`${USAGE}
${HARNESS_USAGE}`);
  process.exitCode = 2;
};

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
