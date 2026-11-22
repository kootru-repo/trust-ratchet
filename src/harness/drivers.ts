/**
 * Row 12: the driver contract and its checker. A driver is one command a project lists in its config. Pure: the
 * checker runs nothing itself. It is given `env.run` (runs a driver with extra arguments, returns code and text)
 * and `env.tree` (a fingerprint of the working tree outside the driver's output folder, plus the git refs), so
 * the same code checks a real driver and a planted one.
 *
 * The contract: one command; exit 0 ok, 1 broken, 2 cannot run; at most 40 lines of output; `--help` exits 0
 * with text; a normal run prints JSON the checker parses; a driver that writes outside its output folder has a
 * `--dry-run` that changes nothing outside it; a failing exit prints a line that says what to do; the skill's
 * body names it.
 */
export const MAX_LINES = 40;
export const EXIT_OK = 0;
export const EXIT_BROKEN = 1;
export const EXIT_CANNOT_RUN = 2;

export type Driver = { name: string; command: string; /** True when it writes anywhere but its own output folder. */ writes?: boolean };
export type RunResult = { code: number; stdout: string; stderr: string };
export type DriverEnv = {
  run: (command: string, args: string[]) => RunResult;
  tree: () => string;
  /** The verification skill's body, to find each driver's name in. Omit to skip that check. */
  skillText?: string;
};
export type DriverFault = { driver: string; check: "help" | "exit-code" | "silent" | "lines" | "json" | "dry-run-missing" | "dry-run-writes" | "advice" | "skill" | "one-command"; message: string };

const BAD_FLAG = "--ratchet-unknown-flag";
const lineCount = (s: string): number => (s === "" ? 0 : s.replace(/\r?\n$/, "").split(/\r?\n/).length);
const ADVICE = /\b(run|try|use|set|pass|add|install|check|fix|see|create|rerun|pick|give)\b/i;
const NOT_ONE = /\|\||&&|[|;]/;

/** Pure: the faults of one driver, each with what to do about it. */
export const checkDriver = (d: Driver, env: DriverEnv): DriverFault[] => {
  const out: DriverFault[] = [];
  const fault = (check: DriverFault["check"], message: string): void => void out.push({ driver: d.name, check, message });
  if (d.command.trim() === "" || NOT_ONE.test(d.command)) fault("one-command", `"${d.name}" is not one command. List a single command with no pipe, && or ;; put the steps in a script.`);

  const help = env.run(d.command, ["--help"]);
  if (help.code !== EXIT_OK || (help.stdout + help.stderr).trim() === "") fault("help", `"${d.name} --help" must exit 0 and print text (exit ${help.code}). Add a --help that says what it does, its exit codes and its flags.`);

  const normal = env.run(d.command, []);
  if (![EXIT_OK, EXIT_BROKEN, EXIT_CANNOT_RUN].includes(normal.code)) fault("exit-code", `"${d.name}" exited ${normal.code}. Use 0 for ok, 1 for broken, 2 for cannot run.`);
  const shown = normal.stdout + normal.stderr;
  if (normal.code !== EXIT_OK && shown.trim() === "") fault("silent", `"${d.name}" exited ${normal.code} and printed nothing. Print one line that says what failed and what to do.`);
  if (lineCount(normal.stdout) > MAX_LINES || lineCount(normal.stderr) > MAX_LINES) fault("lines", `"${d.name}" printed more than ${MAX_LINES} lines. Print a summary and write the rest to a file in its output folder.`);
  if (normal.stdout.trim() !== "") {
    try {
      JSON.parse(normal.stdout);
    } catch {
      fault("json", `"${d.name}" output is not JSON. Print one JSON object on stdout so the checker can parse it.`);
    }
  }
  if (normal.code !== EXIT_OK && shown.trim() !== "" && !ADVICE.test(shown)) fault("advice", `"${d.name}" failed with a message that does not say what to do. Say what to run or change, for example "Run X first".`);

  const bad = env.run(d.command, [BAD_FLAG]);
  if (bad.code === EXIT_OK) fault("exit-code", `"${d.name}" accepted an unknown flag and exited 0. Exit 2 on a flag it does not know.`);
  else if ((bad.stdout + bad.stderr).trim() === "") fault("silent", `"${d.name}" exited ${bad.code} on an unknown flag and printed nothing. Print a line that says what to do, for example "Run ${d.name} --help".`);
  else if (!ADVICE.test(bad.stdout + bad.stderr)) fault("advice", `"${d.name}" rejects a bad flag without saying what to do. Point to --help.`);

  if (d.writes === true) {
    const before = env.tree();
    const probe = env.run(d.command, ["--dry-run"]);
    const after = env.tree();
    if (probe.code === EXIT_CANNOT_RUN && /unknown|unrecognized|usage/i.test(probe.stdout + probe.stderr)) fault("dry-run-missing", `"${d.name}" writes outside its output folder and has no --dry-run. Add --dry-run that prints what it would do and changes nothing.`);
    else if (after !== before) fault("dry-run-writes", `"${d.name} --dry-run" changed the tree or the git refs outside its output folder. Make --dry-run print the plan and write nothing.`);
  }
  if (env.skillText !== undefined && !env.skillText.includes(d.name)) fault("skill", `"${d.name}" is not named in the verification skill. Write its call in the skill's body.`);
  return out;
};

/** Pure: the faults of every driver a project lists. */
export const checkDrivers = (drivers: Driver[], env: DriverEnv): DriverFault[] => drivers.flatMap((d) => checkDriver(d, env));

export const renderDriverFaults = (drivers: Driver[], faults: DriverFault[]): string[] =>
  faults.length === 0 ? [`${drivers.length} driver(s) meet the contract`] : [`${faults.length} fault(s) in ${new Set(faults.map((f) => f.driver)).size} of ${drivers.length} driver(s)`, ...faults.map((f) => `${f.driver} [${f.check}]: ${f.message}`)];
