import { execFileSync } from "node:child_process";
import { forShell } from "./shellcmd.ts";
import path from "node:path";
import { withDeps, type ReproConfig } from "./repro.ts";
import type { Fact } from "./types.ts";

/**
 * A deterministic check that runs before any model call.
 * {file} in the command is replaced by the file under review, relative to the package folder.
 * `onlyFile` keeps only the output lines that name that file: a whole-project type check then says something about
 * this file alone, and errors elsewhere (for example from dependencies newer than an old commit) are ignored.
 */
export type CheckSpec = { command: string; onlyFile?: boolean };

const MISSING = /is not recognized as an internal or external command|command not found|^(\/bin\/)?sh: \d+: .+: not found|No such file or directory|Cannot find module|ERR_MODULE_NOT_FOUND|Could not find config file|ESLint couldn't find|Parsing error: parserOptions|This is a bug in your configuration/i;
/** A compiler diagnostic is the tool working, even when what it says is that a module is missing. */
const DIAGNOSTIC = /error TS\d+:/;
export const broke = (output: string): boolean => output.split(/\r?\n/).some((l) => MISSING.test(l) && !DIAGNOSTIC.test(l));

/**
 * Pure: turns one command's exit code and output into a fact, or into "could not run".
 * A check that could not run is never shown to a reviewer as a pass or a failure.
 */
export const judgeCheck = ({ spec, command, file, status, output }: { spec: CheckSpec; command: string; file: string; status: number; output: string }): Fact => {
  const lines = output.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (spec.onlyFile) {
    // The path, not the bare name: "index.ts" would match every index.ts in the project.
    const mine = lines.filter((l) => l.replace(/\\/g, "/").includes(file));
    const ran = status === 0 || (!broke(output) && lines.length > 0);
    if (!ran) return { command, exitCode: status, tail: lines.slice(-8).join("\n"), ran: false };
    return { command: `${command} (lines about ${file} only)`, exitCode: mine.length === 0 ? 0 : 1, tail: mine.slice(0, 25).join("\n"), ran: true };
  }
  const ran = status === 0 || (status === 1 && !broke(output));
  return { command, exitCode: status, tail: ran ? lines.slice(-25).join("\n") : lines.slice(-8).join("\n"), ran };
};

/** Runs the checks in the package folder, with dependencies linked only for the duration. */
export const runChecks = ({ root, config, checks, file }: { root: string; config: ReproConfig; checks: CheckSpec[]; file: string }): Fact[] => {
  const pkgDir = path.resolve(root, config.pkg);
  const rel = path.relative(pkgDir, path.resolve(root, file)).split(path.sep).join("/");
  return withDeps({
    root,
    pkg: config.pkg,
    ...(config.depsFrom ? { depsFrom: config.depsFrom } : {}),
    work: () =>
      checks.map((spec) => {
        const command = spec.command.split("{file}").join(rel);
        let status = 0;
        let output = "";
        try {
          output = execFileSync(forShell(command), { cwd: pkgDir, shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 8 * 60_000, maxBuffer: 64 * 1024 * 1024 });
        } catch (err) {
          const e = err as { status?: number | null; stdout?: string; stderr?: string };
          status = e.status ?? 2;
          output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
        }
        return judgeCheck({ spec, command, file: rel, status, output });
      }),
  });
};
