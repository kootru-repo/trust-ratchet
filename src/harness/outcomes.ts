import { isFixSubject } from "../history.ts";
import { matchesAny, type Rule } from "./rules.ts";
import type { CheckCmd, ProjectConfig } from "./state.ts";

/**
 * Pure: file to test maps for tests that sit beside the file they test (`test_x.py` beside `x.py`, `x.test.ts` beside
 * `x.ts`). Each test runs only when its own file or the file it tests changed: never a suite. `template` gives the
 * command per language with {test} for the test file; a language with no template is left out.
 */
export const pairTests = ({ files, exclude, template }: { files: string[]; exclude: string[]; template: { py?: string; ts?: string } }): CheckCmd[] => {
  const have = new Set(files);
  const out: CheckCmd[] = [];
  for (const test of files) {
    if (matchesAny(test, exclude)) continue;
    const py = /^(.*\/)?test_([^/]+)\.py$/.exec(test);
    const ts = /^(.*\/)?([^/]+)\.test\.(ts|tsx|mts)$/.exec(test);
    const source = py ? `${py[1] ?? ""}${py[2]}.py` : ts ? `${ts[1] ?? ""}${ts[2]}.${ts[3]}` : null;
    const cmd = py ? template.py : ts ? template.ts : undefined;
    if (source === null || cmd === undefined || !have.has(source)) continue;
    out.push({ name: test.replace(/^.*\//, "").replace(/\.(py|ts|tsx|mts)$/, ""), when: [source, test], command: cmd.split("{test}").join(test), timeoutS: 60 });
  }
  return out;
};

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi)$/;

export type FeatureRow = { folder: string; files: number; rules: string[]; checks: string[]; tests: string[]; drivers: string[] };

/**
 * Pure: the feature map (T9). For each folder of source files, what watches it: which rules cover a file in it,
 * which checks, mapped tests and drivers would run if it changed. A folder with nothing is a place the harness
 * can only check for syntax and escape hatches.
 */
export const featureMap = ({ files, rules, config, depth = 2 }: { files: string[]; rules: Rule[]; config: ProjectConfig; depth?: number }): FeatureRow[] => {
  const byFolder = new Map<string, string[]>();
  for (const f of files.filter((x) => SOURCE.test(x))) {
    const parts = f.split("/");
    const folder = parts.length === 1 ? "." : parts.slice(0, Math.min(depth, parts.length - 1)).join("/");
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), f]);
  }
  const names = (list: CheckCmd[] | undefined, inFolder: string[]): string[] => (list ?? []).filter((c) => !c.when || inFolder.some((f) => matchesAny(f, c.when ?? []))).map((c) => c.name);
  return [...byFolder.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([folder, inFolder]) => ({
      folder,
      files: inFolder.length,
      rules: rules.filter((r) => inFolder.some((f) => matchesAny(f, r.files))).map((r) => r.id),
      checks: names(config.checks, inFolder),
      tests: names(config.tests, inFolder),
      drivers: names(config.drivers, inFolder),
    }));
};

export const renderFeatureMap = ({ root, rows }: { root: string; rows: FeatureRow[] }): string => {
  const cell = (xs: string[]): string => (xs.length === 0 ? "-" : xs.length > 6 ? `${xs.slice(0, 6).join(", ")} and ${xs.length - 6} more` : xs.join(", "));
  const bare = rows.filter((r) => r.rules.length + r.checks.length + r.tests.length + r.drivers.length === 0);
  return [
    `# Feature map of ${root}`,
    "",
    "Written by `ratchet features` from the project's rules and config. Every folder also gets the syntax check and the escape hatch check.",
    "",
    "| Folder | Source files | Rules | Checks | Tests mapped | Drivers |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.folder} | ${r.files} | ${cell(r.rules)} | ${cell(r.checks)} | ${cell(r.tests)} | ${cell(r.drivers)} |`),
    "",
    `Folders with nothing beyond syntax and escape hatches: ${bare.length} of ${rows.length}${bare.length > 0 ? ` (${bare.slice(0, 12).map((r) => r.folder).join(", ")}${bare.length > 12 ? ", ..." : ""})` : ""}.`,
    "",
  ].join("\n");
};

export type Commit = { hash: string; time: number; subject: string; files: string[] };

/** Pure: `git log --format=%x01%H%x09%ct%x09%s --name-only` output as commits, newest first. */
export const parseLog = (out: string): Commit[] =>
  out
    .split("\u0001")
    .filter((b) => b.trim() !== "")
    .map((block) => {
      const [head = "", ...rest] = block.split(/\r?\n/);
      const [hash = "", time = "0", ...subject] = head.split("\t");
      return { hash, time: Number(time), subject: subject.join("\t"), files: rest.map((l) => l.trim()).filter(Boolean) };
    });

export type Outcomes = { commits: number; fixes: number; reverts: number; fixOfFix: number };

/**
 * Pure: outcomes read from history (T15). A fix is a commit whose subject says so. A revert undoes a commit.
 * A fix of a fix is a fix that touches a source file another fix touched in the `days` before it: the first fix
 * did not hold. All three are stand-ins read from subjects and paths, not rulings.
 */
export const outcomes = ({ commits, days = 14 }: { commits: Commit[]; days?: number }): Outcomes => {
  const oldestFirst = [...commits].sort((a, b) => a.time - b.time);
  const lastFix = new Map<string, number>();
  let fixes = 0;
  let reverts = 0;
  let fixOfFix = 0;
  for (const c of oldestFirst) {
    if (/^revert\b/i.test(c.subject.trim())) reverts += 1;
    if (!isFixSubject(c.subject)) continue;
    fixes += 1;
    const source = c.files.filter((f) => SOURCE.test(f));
    if (source.some((f) => lastFix.has(f) && c.time - (lastFix.get(f) ?? 0) <= days * 86_400)) fixOfFix += 1;
    for (const f of source) lastFix.set(f, c.time);
  }
  return { commits: commits.length, fixes, reverts, fixOfFix };
};

export const renderOutcomes = (label: string, o: Outcomes): string => {
  const pct = (n: number): string => (o.commits === 0 ? "0" : String(Math.round((1000 * n) / o.commits) / 10));
  return `${label}: ${o.commits} commits; fixes ${o.fixes} (${pct(o.fixes)}%); fixes of a fix made within 14 days ${o.fixOfFix}; reverts ${o.reverts}.`;
};

export type GeneratedGuide = { name: string; text: string };

/**
 * Pure (S12): notes a program can write for reviewers, one per folder of source files. A note lists the fixes that
 * folder has needed (what has gone wrong here before) and the rules that hold in it. It says it is generated: an
 * owner's note is a different file, and where the two disagree the owner's stands.
 */
export const generatedGuides = ({ commits, rules, files, depth = 2, maxFixes = 8 }: { commits: Commit[]; rules: Rule[]; files: string[]; depth?: number; maxFixes?: number }): GeneratedGuide[] => {
  const folderOf = (f: string): string => {
    const parts = f.split("/");
    return parts.length === 1 ? "." : parts.slice(0, Math.min(depth, parts.length - 1)).join("/");
  };
  const folders = [...new Set(files.filter((f) => SOURCE.test(f)).map(folderOf))].sort();
  const fixes = [...commits].filter((c) => isFixSubject(c.subject)).sort((a, b) => b.time - a.time);
  const out: GeneratedGuide[] = [];
  for (const folder of folders) {
    const inFolder = files.filter((f) => SOURCE.test(f) && folderOf(f) === folder);
    const here = fixes.filter((c) => c.files.some((f) => SOURCE.test(f) && folderOf(f) === folder)).slice(0, maxFixes);
    const held = rules.filter((r) => inFolder.some((f) => matchesAny(f, r.files)));
    if (here.length === 0 && held.length === 0) continue;
    const day = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);
    out.push({
      name: `generated-${folder === "." ? "root" : folder.replace(/[^A-Za-z0-9]+/g, "-")}.md`,
      text: [
        `applies: ${folder === "." ? "*" : `${folder}/**`}`,
        `Generated by a program from this repository's history and rules, not written by an owner. It says where faults have been before; it does not say the code is wrong now.`,
        ...(here.length === 0 ? [] : ["", "Fixes this folder has needed, newest first:", ...here.map((c) => `- ${day(c.time)} ${c.subject.slice(0, 160)} (${c.files.filter((f) => SOURCE.test(f) && folderOf(f) === folder).slice(0, 4).join(", ")})`)]),
        ...(held.length === 0 ? [] : ["", "Rules that hold here, each from a past correction:", ...held.map((r) => `- ${r.id}: ${r.message} Fix: ${r.fix}`)]),
        "",
      ].join("\n"),
    });
  }
  return out;
};
