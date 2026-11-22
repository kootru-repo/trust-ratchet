// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The verification level of a project: how much checking it has been shown to have, computed by program from the
 * harness's own records. It is not a statement that the code is right. Each level needs every level below it, and
 * each requirement is a fact with its number, so a reader can see why a project sits where it does.
 *
 * Scheme 2 (2026-11-20). No requirement rests on a count somebody picked. A requirement is either a plain fact
 * (on, clean, proven), or it is derived from the project's own history (which folders took a fix, how often a
 * commit is a fix), or it is a statistical statement at the conventions named in CONVENTIONS and nowhere else.
 */
export const SCHEME = 3;

/**
 * The conventions, all in one place. They are the customary ones of statistics, not measurements of this harness:
 * a 5% chance of a false alarm, 95% confidence, 80% power. `tolerated` and `rise` say what the levels are about.
 */
export const CONVENTIONS = {
  /** Confidence for a bound on a share (level 4). */
  confidence: 0.95,
  /** The share of checked turns that may end with a failure standing (level 4). Zero cannot be shown by any number of turns. */
  tolerated: 0.1,
  /** Chance of calling a rise that is not there, and the chance wanted of seeing one that is (level 5). */
  alpha: 0.05,
  power: 0.8,
  /** The rise in the fix share that must be detectable before the share is read at all: a doubling (level 5). */
  rise: 2,
  /** Past this many commits a base rate is too low to measure with. */
  horizon: 5000,
} as const;

export type LevelFacts = {
  /** The switch, as it applies to this project. */
  on: boolean;
  mode: "advise" | "enforce";
  rules: number;
  /** Rules proven on a past fix that hold a turn. A rule on trial is not counted: it holds nothing. */
  provenRules: number;
  /** Rules whose count is above their stored backlog in some file. */
  risenRules: number;
  /** Escape hatches now, and the stored ceiling (absent: none stored). */
  hatches: number;
  hatchCeiling?: number;
  commands: number;
  /** The project's own source folders that took a fix commit in the history read, and how many of those something watches. */
  fixFolders: number;
  watchedFixFolders: number;
  /** Own source folders in all, and those watched: used only when the history holds no fix. */
  folders: number;
  watchedFolders: number;
  /** Turn records, oldest first: whether anything failed, whether the turn was held, and the mode it ran in. */
  records: { time: string; mode: "advise" | "enforce"; failing: boolean; held: boolean }[];
  /** A baseline run of the mapped commands on the tree as it was, where one was made. It is not a session's turn. */
  baseline?: { done: boolean; failing: number };
  /** Commits, and those that read like a fix, before the switch went on and since. */
  before: { commits: number; fixes: number };
  since: { commits: number; fixes: number };
};

export type Requirement = { level: number; text: string; met: boolean };
export type Level = { level: number; name: string; requirements: Requirement[]; next: string[] };

export const LEVEL_NAMES = ["Unwatched", "Watched", "Ruled", "Tested", "Enforced", "Measured"] as const;

const logFact = (() => {
  const memo: number[] = [0];
  return (n: number): number => {
    for (let i = memo.length; i <= n; i += 1) memo.push((memo[i - 1] ?? 0) + Math.log(i));
    return memo[n] ?? 0;
  };
})();
const pmf = (k: number, n: number, p: number): number => (p <= 0 ? (k === 0 ? 1 : 0) : p >= 1 ? (k === n ? 1 : 0) : Math.exp(logFact(n) - logFact(k) - logFact(n - k) + k * Math.log(p) + (n - k) * Math.log(1 - p)));

/** Pure: the chance of k or more events in n tries when each has chance p. */
export const atLeast = (k: number, n: number, p: number): number => {
  if (k <= 0) return 1;
  let below = 0;
  for (let i = 0; i < k && i <= n; i += 1) below += pmf(i, n, p);
  return Math.max(0, 1 - below);
};

/** Pure: the exact upper bound, at the given confidence, on a share of which k events were seen in n tries. */
export const upperBound = (k: number, n: number, confidence: number): number => {
  if (n <= 0 || k >= n) return 1;
  let lo = k / n;
  let hi = 1;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    // The chance of seeing k or fewer falls as the true share rises.
    if (1 - atLeast(k + 1, n, mid) > 1 - confidence) lo = mid;
    else hi = mid;
  }
  return hi;
};

/**
 * Pure: the fewest commits in which a rise of the fix share from p0 to rise times p0 would be seen with the wanted
 * power, by an exact one-sided test at alpha. Null when the base rate is zero or the number is past the horizon.
 */
export const commitsNeeded = (p0: number, c: { alpha: number; power: number; rise: number; horizon: number } = CONVENTIONS): number | null => {
  if (!(p0 > 0) || p0 >= 1) return null;
  const p1 = Math.min(0.99, p0 * c.rise);
  for (let n = 5; n <= c.horizon; n += n < 200 ? 1 : n < 1000 ? 5 : 25) {
    let critical = 0;
    while (critical <= n && atLeast(critical, n, p0) > c.alpha) critical += 1;
    if (critical <= n && atLeast(critical, n, p1) >= c.power) return n;
  }
  return null;
};

const pct = (x: number): string => `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`;

/** Pure: every requirement, met or not, in level order. */
export const requirements = (f: LevelFacts): Requirement[] => {
  const enforced = f.records.filter((r) => r.mode === "enforce");
  // A turn is "let go while failing" when its record in enforce mode still fails and was not held.
  const released = enforced.filter((r) => r.failing && !r.held).length;
  const bound = upperBound(released, enforced.length, CONVENTIONS.confidence);
  const last = f.records[f.records.length - 1];
  const p0 = f.before.commits > 0 ? f.before.fixes / f.before.commits : 0;
  const needed = commitsNeeded(p0);
  const rise = f.since.commits > 0 ? atLeast(f.since.fixes, f.since.commits, p0) : 1;
  const coverage =
    f.fixFolders > 0
      ? { text: `every source folder that took a fix in the history read is watched by a rule, check, test or driver (${f.watchedFixFolders} of ${f.fixFolders})`, met: f.watchedFixFolders === f.fixFolders }
      : { text: `the history read holds no fix, so at least one source folder is watched (${f.watchedFolders} of ${f.folders})`, met: f.watchedFolders >= 1 };
  return [
    { level: 1, text: `the harness is on (${f.on ? "on" : "off"})`, met: f.on },
    { level: 1, text: `at least one checked turn is on record, or a baseline run of the mapped commands is finished (${f.records.length} turn(s); baseline ${f.baseline ? (f.baseline.done ? "finished" : "not finished") : "none"})`, met: f.records.length >= 1 || f.baseline?.done === true },
    { level: 1, text: `escape hatches are not above the stored ceiling (${f.hatches} of ${f.hatchCeiling ?? "no ceiling"})`, met: f.hatchCeiling !== undefined && f.hatches <= f.hatchCeiling },
    { level: 2, text: `at least one rule that holds a turn is proven on a past fix (${f.provenRules} of ${f.rules} rules)`, met: f.provenRules >= 1 },
    { level: 2, text: `no rule's count is above its backlog (${f.risenRules} risen)`, met: f.risenRules === 0 },
    { level: 3, ...coverage },
    { level: 3, text: `the project has commands that run code: checks, tests or drivers (${f.commands})`, met: f.commands >= 1 },
    { level: 3, text: `the latest checked turn ended with nothing failing; with no turn yet, the baseline run did (${last ? (last.failing ? "failing" : "clean") : f.baseline?.done ? `no turn; baseline ${f.baseline.failing} failing` : "no record"})`, met: last !== undefined ? !last.failing : f.baseline?.done === true && f.baseline.failing === 0 },
    { level: 4, text: `the mode is enforce (${f.mode})`, met: f.on && f.mode === "enforce" },
    {
      level: 4,
      text: `with ${pct(CONVENTIONS.confidence)} confidence at most ${pct(CONVENTIONS.tolerated)} of turns checked in enforce mode end with a failure standing (${released} of ${enforced.length} did; the bound is ${enforced.length === 0 ? "not known" : pct(bound)})`,
      met: enforced.length > 0 && bound <= CONVENTIONS.tolerated,
    },
    {
      level: 5,
      text:
        needed === null
          ? `the share of commits that are fixes can be measured (before the switch ${f.before.fixes} of ${f.before.commits}: ${p0 > 0 ? `too low to see a doubling within ${CONVENTIONS.horizon} commits` : "no fix to compare with"})`
          : `enough commits since the switch to see a doubling of the fix share with ${pct(CONVENTIONS.power)} power (${f.since.commits} of ${needed} needed; the share before was ${f.before.fixes} of ${f.before.commits})`,
      met: needed !== null && f.since.commits >= needed,
    },
    {
      level: 5,
      text: `the fix share has not risen (${f.since.fixes} of ${f.since.commits} since, ${f.before.fixes} of ${f.before.commits} before; the chance of this many or more with no change is ${f.since.commits > 0 ? pct(rise) : "not known"})`,
      met: f.since.commits > 0 && rise > CONVENTIONS.alpha,
    },
  ];
};

/** Pure: the highest level whose requirements, and those of every level below it, are all met. */
export const levelOf = (f: LevelFacts): Level => {
  const reqs = requirements(f);
  let level = 0;
  for (let n = 1; n <= 5; n += 1) {
    if (reqs.filter((r) => r.level === n).every((r) => r.met)) level = n;
    else break;
  }
  return { level, name: LEVEL_NAMES[level] ?? "Unwatched", requirements: reqs, next: reqs.filter((r) => r.level === level + 1 && !r.met).map((r) => r.text) };
};

export const renderLevel = ({ root, level }: { root: string; level: Level }): string =>
  [
    `Verification level of ${root}: ${level.level} ${level.name} (scheme ${SCHEME})`,
    "A level says how much checking the project has been shown to have. It does not say the code is right.",
    ...[1, 2, 3, 4, 5].flatMap((n) => [`Level ${n} ${LEVEL_NAMES[n]}:`, ...level.requirements.filter((r) => r.level === n).map((r) => `  [${r.met ? "x" : " "}] ${r.text}`)]),
    level.level === 5 ? "Nothing further." : `To reach level ${level.level + 1}: ${level.next.join("; ")}.`,
  ].join("\n");
