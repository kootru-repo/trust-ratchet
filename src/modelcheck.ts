// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Bounded exhaustive model checking for small state machines (D1). Every sequence of events up to a depth is run
 * against the system and checked after each step, usually against a simple reference model kept in the same state.
 * In trio-mix-assistant this found 7 hardening bugs and 2 hold leaks that ordinary tests missed.
 *
 * - `init` makes a fresh system (and model) for each sequence; `step` applies one event. Either `step` or `check`
 *   reports a broken rule by returning a message (or throwing); null or undefined means fine. The initial state is
 *   checked too.
 * - `key` (optional) names the whole state as far as the future goes: the system's own state as well as the model's.
 *   Sequences that reach the same key with the same number of steps left are explored once. A key that leaves out
 *   part of the system's state can hide a bug in that part, so when in doubt leave `key` out.
 * - `reach` names states the run must get to. A pass that never reached them proves nothing, so they are reported.
 * - A failing sequence is shrunk by dropping events one at a time while it still fails the same way: the result has
 *   no event that can be dropped alone, though a shorter sequence may exist.
 *
 * No dependencies. Import it from a test: `import { explore, assertExplored } from "trust-ratchet/src/modelcheck.ts"`.
 */
export type Model<S, E> = {
  alphabet: readonly E[];
  depth: number;
  init: () => S;
  step: (s: S, e: E) => string | null | undefined | void;
  check?: (s: S) => string | null | undefined;
  key?: (s: S) => string;
  reach?: readonly { name: string; hit: (s: S) => boolean }[];
  /** Stop after this many steps run in all (the work done, pruned or not). Default 50 million. */
  maxSteps?: number;
};

export type Explored<E> = { sequences: number; steps: number; states: number; counterexample: E[] | null; message: string | null; unreached: string[]; capped: boolean };

const fault = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  return m === "" ? "(no message)" : m;
};
/** A step's or check's answer as a failure message, or null. An empty message is still a failure. */
const said = (v: string | null | undefined | void): string | null => (v === null || v === undefined ? null : v === "" ? "(no message)" : v);

type Run<S> = { ok: true; s: S } | { ok: false; at: number; message: string };

/** Runs one sequence from a fresh system, checking the initial state and every step. */
const runSeq = <S, E>(m: Model<S, E>, seq: readonly E[], onStep: () => void = () => undefined): Run<S> => {
  let s: S;
  try {
    s = m.init();
    const first = said(m.check?.(s));
    if (first) return { ok: false, at: -1, message: first };
  } catch (e) {
    return { ok: false, at: -1, message: `init: ${fault(e)}` };
  }
  for (let i = 0; i < seq.length; i += 1) {
    onStep();
    try {
      const broke = said(m.step(s, seq[i] as E)) ?? said(m.check?.(s));
      if (broke) return { ok: false, at: i, message: broke };
    } catch (e) {
      return { ok: false, at: i, message: fault(e) };
    }
  }
  return { ok: true, s };
};

/** Pure on its model: the sequence with events dropped one at a time while it still fails with the same message. */
export const shrink = <S, E>(m: Model<S, E>, seq: readonly E[]): E[] => {
  const first = runSeq(m, seq);
  if (first.ok) return [...seq];
  const message = first.message;
  let best = [...seq];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < best.length; i += 1) {
      const shorter = [...best.slice(0, i), ...best.slice(i + 1)];
      const r = runSeq(m, shorter);
      if (!r.ok && r.message === message) {
        best = shorter;
        changed = true;
        break;
      }
    }
  }
  return best;
};

/** Explores every sequence up to `depth`, depth first, replaying each prefix on a fresh system. */
export const explore = <S, E>(m: Model<S, E>): Explored<E> => {
  const max = m.maxSteps ?? 50_000_000;
  const seen = new Set<string>();
  const states = new Set<string>();
  const hit = new Set<string>();
  let sequences = 0;
  let steps = 0;
  let capped = false;
  const count = (): void => {
    steps += 1;
  };
  const visit = (s: S): void => {
    for (const r of m.reach ?? []) if (!hit.has(r.name) && r.hit(s)) hit.add(r.name);
    const k = m.key?.(s);
    if (k !== undefined) states.add(k);
  };
  const result = (failure: { seq: E[]; message: string } | null): Explored<E> => {
    const unreached = (m.reach ?? []).map((r) => r.name).filter((n) => !hit.has(n));
    if (!failure) return { sequences, steps, states: states.size, counterexample: null, message: null, unreached, capped };
    const small = shrink(m, failure.seq);
    return { sequences, steps, states: states.size, counterexample: small, message: failure.message, unreached, capped };
  };
  const start = runSeq(m, []);
  if (!start.ok) return result({ seq: [], message: start.message });
  visit(start.s);
  const prefix: E[] = [];
  const walk = (): { seq: E[]; message: string } | null => {
    if (prefix.length === m.depth) {
      sequences += 1;
      return null;
    }
    for (const e of m.alphabet) {
      if (steps >= max) {
        capped = true;
        return null;
      }
      prefix.push(e);
      // Replay the prefix on a fresh system: steps need not be undoable, and nothing is shared between branches.
      const r = runSeq(m, prefix, count);
      if (!r.ok) return { seq: [...prefix], message: r.message };
      visit(r.s);
      const k = m.key?.(r.s);
      const memo = k === undefined ? null : `${m.depth - prefix.length}#${k}`;
      if (memo && seen.has(memo)) {
        sequences += 1;
        prefix.pop();
        continue;
      }
      if (memo) seen.add(memo);
      const deeper = walk();
      if (deeper) return deeper;
      prefix.pop();
    }
    return null;
  };
  return result(walk());
};

/** Throws with the shrunk counterexample, or when a named state was never reached or the run was cut short. */
export const assertExplored = <E>(r: Explored<E>, show: (e: E) => string = (e) => JSON.stringify(e)): void => {
  if (r.counterexample) throw new Error(`model check failed: ${r.message}\nsequence (${r.counterexample.length} steps, none can be dropped alone): ${r.counterexample.length === 0 ? "(the initial state)" : r.counterexample.map(show).join(" -> ")}`);
  if (r.unreached.length > 0) throw new Error(`model check passed without reaching: ${r.unreached.join(", ")}. A pass over states never reached proves nothing: widen the alphabet or the depth.`);
  if (r.capped) throw new Error(`model check stopped at its step limit after ${r.steps} steps: lower the depth, add a key, or raise maxSteps.`);
};
