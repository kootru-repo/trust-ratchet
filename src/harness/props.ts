/**
 * A property-test runner (the proof plan row 14): a seeded generator, N cases, shrinking by halving, and a program
 * check that the inputs were generated (seed recorded, distinct count, not a fixed list). A failure carries its seed
 * and case index, and replays from them.
 */

export type Rng = { next: () => number; int: (lo: number, hi: number) => number };
export type Gen<T> = (rng: Rng) => T;

/** mulberry32: small, seedable, the same stream on every run. */
export const makeRng = (seed: number): Rng => {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)) };
};

export const genInt = (lo: number, hi: number): Gen<number> => (r) => r.int(lo, hi);
export const genArray = <T>(item: Gen<T>, maxLen: number): Gen<T[]> => (r) => Array.from({ length: r.int(0, maxLen) }, () => item(r));

/** Shrink steps by halving: a number toward 0; an array to its first half, its second half, then without its last item. */
export const halveNumber = (n: number): number[] => (n === 0 ? [] : [Math.trunc(n / 2)]);
export const halveArray = <T>(a: T[]): T[][] => (a.length === 0 ? [] : a.length === 1 ? [[]] : [a.slice(0, Math.floor(a.length / 2)), a.slice(Math.floor(a.length / 2)), a.slice(0, -1)]);

export type Failure<T> = { seed: number; caseIndex: number; input: T; shrunk: T; shrinkSteps: number; error: string };
export type PropertyReport<T> = { seed: number; cases: number; distinct: number; failure: Failure<T> | null };

const key = (x: unknown): string => JSON.stringify(x) ?? "undefined";
const caseSeed = (seed: number, i: number): number => (Math.imul(seed ^ 0x9e3779b9, 31) + Math.imul(i, 0x85ebca6b)) >>> 0;

/** The i-th input of a run, so a failure replays from its seed and index alone. */
export const inputAt = <T>(gen: Gen<T>, seed: number, i: number): T => gen(makeRng(caseSeed(seed, i)));

const failsWith = <T>(prop: (x: T) => boolean | void, x: T): string | null => {
  try {
    return prop(x) === false ? "property returned false" : null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

export const runProperty = <T>(o: { seed: number; cases: number; gen: Gen<T>; prop: (x: T) => boolean | void; shrink?: (x: T) => T[] }): PropertyReport<T> => {
  const keys = new Set<string>();
  for (let i = 0; i < o.cases; i++) {
    const input = inputAt(o.gen, o.seed, i);
    keys.add(key(input));
    const error = failsWith(o.prop, input);
    if (error === null) continue;
    let shrunk = input;
    let steps = 0;
    let progress = true;
    while (progress && o.shrink) {
      progress = false;
      for (const c of o.shrink(shrunk)) {
        if (failsWith(o.prop, c) !== null) {
          shrunk = c;
          steps++;
          progress = true;
          break;
        }
      }
    }
    return { seed: o.seed, cases: i + 1, distinct: keys.size, failure: { seed: o.seed, caseIndex: i, input, shrunk, shrinkSteps: steps, error } };
  }
  return { seed: o.seed, cases: o.cases, distinct: keys.size, failure: null };
};

export type GeneratedCheck = { ok: boolean; seed: number; cases: number; distinct: number; reasons: string[] };
/**
 * A program check that inputs were generated and not written by hand: the same seed gives the same inputs (replay), a
 * different seed gives different ones, and the distinct count reaches a share of the cases. `inputs` is optional: when
 * given, it must equal what the generator makes from the recorded seed, so a fixed list fails.
 */
export const checkGenerated = <T>(o: { gen: Gen<T>; seed: number; cases: number; minDistinctShare?: number; inputs?: T[] }): GeneratedCheck => {
  const reasons: string[] = [];
  const make = (seed: number): string[] => Array.from({ length: o.cases }, (_, i) => key(inputAt(o.gen, seed, i)));
  const mine = make(o.seed);
  const distinct = new Set(mine).size;
  const share = o.minDistinctShare ?? 0.5;
  if (!Number.isInteger(o.seed)) reasons.push("seed is not recorded as an integer");
  if (o.cases < 2) reasons.push("fewer than two cases");
  if (distinct < Math.ceil(o.cases * share)) reasons.push(`only ${distinct} distinct inputs in ${o.cases} cases`);
  if (key(make(o.seed)) !== key(mine)) reasons.push("the same seed gave different inputs");
  if (key(make(o.seed + 1)) === key(mine)) reasons.push("a different seed gave the same inputs: the list is fixed");
  if (o.inputs && key(o.inputs.map(key)) !== key(mine)) reasons.push("the inputs are not what the generator makes from the recorded seed: written by hand");
  return { ok: reasons.length === 0, seed: o.seed, cases: o.cases, distinct, reasons };
};

export type Replay = { reproduced: boolean; runs: number; reasons: string[] };

/**
 * Row 14 and 19: a failure is reproduced twice, each time from its seed and case index alone, before any fix.
 * A failure that does not come back both times is a flake, not a bug to fix.
 */
export const replayTwice = <T>(o: { gen: Gen<T>; prop: (x: T) => boolean | void; failure: Failure<T> }): Replay => {
  const reasons: string[] = [];
  for (let run = 1; run <= 2; run++) {
    const input = inputAt(o.gen, o.failure.seed, o.failure.caseIndex);
    if (key(input) !== key(o.failure.input)) {
      reasons.push(`replay ${run}: the seed and index give a different input than the one recorded. Record the seed and case index of the run that failed.`);
      continue;
    }
    if (failsWith(o.prop, input) === null) reasons.push(`replay ${run}: the property passed on the recorded input. This failure is not reproducible, so it is a flake: do not fix it, find what varies.`);
  }
  return { reproduced: reasons.length === 0, runs: 2, reasons };
};
