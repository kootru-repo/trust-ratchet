// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Property-based testing through a page: generated sequences of a user's inputs
 * (click, key, type, wait) with properties of what the page shows. The page is behind an injected PageDriver, so this
 * module names no browser. A seed and the sequence are recorded; a failing sequence shrinks by halving; the failing
 * input is run again twice from the recorded seed and index (props.replayTwice) before it counts, and a failure that
 * does not replay is reported as a flake and not counted. An optional Doctor runs first: not ready means inconclusive.
 */
import { checkGenerated, halveArray, inputAt, replayTwice, type Failure, type Gen, type GeneratedCheck, type Replay } from "./props.ts";
import type { Diagnosis } from "./doctor.ts";

export type PageInput =
  | { kind: "click"; target: string }
  | { kind: "key"; key: string }
  | { kind: "type"; target: string; text: string }
  | { kind: "wait"; ms: number };

export type PageState = { text: string; values: Record<string, string> };

export interface PageDriver {
  /** Load the page fresh: every sequence starts from the same state. */
  open(): Promise<void>;
  act(input: PageInput): Promise<void>;
  read(): Promise<PageState>;
  close(): Promise<void>;
}

/** A property of what the page shows. Returns null when it holds, or a message. `history` is the inputs so far. */
export type PageProperty = { name: string; check: (state: PageState, history: PageInput[]) => string | null };

export const genPageInput = (alphabet: PageInput[]): Gen<PageInput> => (r) => alphabet[r.int(0, alphabet.length - 1)] as PageInput;
export const genSequence = (alphabet: PageInput[], maxLen: number): Gen<PageInput[]> => (r) => {
  const item = genPageInput(alphabet);
  return Array.from({ length: r.int(1, maxLen) }, () => item(r));
};

/** Run one sequence on a fresh page. Returns the first property failure (with the step), or null. A driver error is a failure too. */
export const runSequence = async (driver: PageDriver, props: PageProperty[], seq: PageInput[]): Promise<string | null> => {
  try {
    await driver.open();
    for (let i = 0; i < seq.length; i++) {
      await driver.act(seq[i] as PageInput);
      const state = await driver.read();
      for (const p of props) {
        const msg = p.check(state, seq.slice(0, i + 1));
        if (msg !== null) return `${p.name} after step ${i + 1}: ${msg}`;
      }
    }
    return null;
  } catch (e) {
    return `driver error: ${e instanceof Error ? e.message : String(e)}`;
  }
};

/** Shrink candidates: halving first (first half, second half, without the last), then without each single input. */
export const shrinkSequence = (s: PageInput[]): PageInput[][] => [...halveArray(s), ...(s.length > 1 ? s.map((_, i) => [...s.slice(0, i), ...s.slice(i + 1)]) : [])];

export type PageReport = {
  status: "passed" | "failed" | "flaky" | "inconclusive";
  seed: number;
  cases: number;
  generated: GeneratedCheck;
  failure: Failure<PageInput[]> | null;
  replay: Replay | null;
  /** A failure counts only when it replayed twice from its seed. */
  counted: boolean;
  notes: string[];
};

export const runPageProperty = async (o: {
  seed: number;
  cases: number;
  alphabet: PageInput[];
  maxLen: number;
  driver: PageDriver;
  properties: PageProperty[];
  doctor?: () => Promise<Diagnosis>;
  minDistinctShare?: number;
}): Promise<PageReport> => {
  const gen = genSequence(o.alphabet, o.maxLen);
  const generated = checkGenerated({ gen, seed: o.seed, cases: o.cases, minDistinctShare: o.minDistinctShare });
  const base = { seed: o.seed, cases: o.cases, generated, failure: null, replay: null, counted: false };
  if (!generated.ok) return { ...base, status: "inconclusive", notes: ["sequences were not shown to be generated", ...generated.reasons] };
  if (o.doctor) {
    const d = await o.doctor();
    if (!d.ready) return { ...base, status: "inconclusive", notes: d.reasons.map((r) => `doctor: ${r.code}: ${r.message}`) };
  }
  try {
    for (let i = 0; i < o.cases; i++) {
      const input = inputAt(gen, o.seed, i);
      const error = await runSequence(o.driver, o.properties, input);
      if (error === null) continue;
      let shrunk = input;
      let steps = 0;
      for (let progress = true; progress; ) {
        progress = false;
        for (const c of shrinkSequence(shrunk)) {
          if ((await runSequence(o.driver, o.properties, c)) !== null) {
            shrunk = c;
            steps++;
            progress = true;
            break;
          }
        }
      }
      const failure: Failure<PageInput[]> = { seed: o.seed, caseIndex: i, input, shrunk, shrinkSteps: steps, error };
      // Two real runs of the failing input, fed to props.replayTwice as its verdicts (it regenerates the input from the seed and index).
      const verdicts = [await runSequence(o.driver, o.properties, input), await runSequence(o.driver, o.properties, input)];
      const replay = replayTwice({ gen, failure, prop: () => (verdicts.shift() === null ? undefined : false) });
      const counted = replay.reproduced;
      return { ...base, cases: i + 1, status: counted ? "failed" : "flaky", failure, replay, counted, notes: counted ? [] : ["did not replay twice from its seed: reported, not counted"] };
    }
    return { ...base, status: "passed", notes: [] };
  } finally {
    await o.driver.close();
  }
};
