/**
 * Differential check: two independent builds of one brief are run on the same corpus of inputs; where they disagree one of them is wrong, or the brief is open.
 * The corpus holds INPUTS only (written by a session that has seen the brief and neither build), so no expected value is ever trusted from a model.
 */
export type Step = { fn: string; args: unknown[] };

/** A script is one call list. With `factory` the module's factory function is called first and the steps are methods of what it returns; without, the steps are functions of the module. */
export type Script = { id: string; factory?: string; factoryArgs?: unknown[]; steps: Step[] };

/** What one step did: the JSON of its result, or the name of what it threw. */
export type Outcome = { value: string } | { threw: string };

export type Traces = Record<string, Outcome[]>;

export type Disagreement = { script: string; step: number; call: string; a: string; b: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Values JSON cannot carry travel as { "$": "NaN" | "Infinity" | "-Infinity" | "undefined" | "-0" }. */
export const encode = (v: unknown): unknown => {
  if (v === undefined) return { $: "undefined" };
  if (typeof v === "number") return Number.isNaN(v) ? { $: "NaN" } : v === Infinity ? { $: "Infinity" } : v === -Infinity ? { $: "-Infinity" } : Object.is(v, -0) ? { $: "-0" } : v;
  if (Array.isArray(v)) return v.map(encode);
  if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]));
  return v;
};

export const decode = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(decode);
  if (isRecord(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === "$") {
      const tag = v.$;
      if (tag === "NaN") return Number.NaN;
      if (tag === "Infinity") return Infinity;
      if (tag === "-Infinity") return -Infinity;
      if (tag === "-0") return -0;
      if (tag === "undefined") return undefined;
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]));
  }
  return v;
};

export const show = (v: unknown): string => JSON.stringify(encode(v)) ?? "undefined";

/** The corpus file is JSON: a list of scripts. Anything that is not a whole script is refused, never guessed at. */
export const parseCorpus = (text: string): { scripts: Script[] } | { error: string } => {
  const from = text.indexOf("[");
  const to = text.lastIndexOf("]");
  if (from < 0 || to < from) return { error: "no JSON list in the corpus" };
  let value: unknown;
  try {
    value = JSON.parse(text.slice(from, to + 1));
  } catch {
    return { error: "the corpus does not parse" };
  }
  if (!Array.isArray(value)) return { error: "the corpus is not a list" };
  const scripts: Script[] = [];
  const seen = new Set<string>();
  for (const s of value) {
    if (!isRecord(s) || typeof s.id !== "string" || !Array.isArray(s.steps) || seen.has(s.id)) return { error: "a script has no id, no steps or a repeated id" };
    if (s.factory !== undefined && typeof s.factory !== "string") return { error: `script ${s.id}: factory is not a name` };
    const steps: Step[] = [];
    for (const st of s.steps) {
      if (!isRecord(st) || typeof st.fn !== "string" || !Array.isArray(st.args)) return { error: `script ${s.id}: a step has no fn or no args` };
      steps.push({ fn: st.fn, args: st.args });
    }
    seen.add(s.id);
    scripts.push({ id: s.id, ...(s.factory !== undefined ? { factory: s.factory } : {}), ...(Array.isArray(s.factoryArgs) ? { factoryArgs: s.factoryArgs } : {}), steps });
  }
  return { scripts };
};

/** Pure: where two runs of one corpus differ, step by step. A script one build could not even start is a disagreement at step 0. */
export const disagreements = ({ scripts, a, b }: { scripts: Script[]; a: Traces; b: Traces }): Disagreement[] => {
  const out: Disagreement[] = [];
  for (const s of scripts) {
    const ta = a[s.id] ?? [];
    const tb = b[s.id] ?? [];
    const n = Math.max(ta.length, tb.length, s.steps.length);
    for (let i = 0; i < n; i++) {
      const x = ta[i];
      const y = tb[i];
      const sx = x === undefined ? "(not run)" : "value" in x ? x.value : `throws ${x.threw}`;
      const sy = y === undefined ? "(not run)" : "value" in y ? y.value : `throws ${y.threw}`;
      if (sx !== sy) {
        const st = s.steps[i];
        out.push({ script: s.id, step: i, call: st ? `${s.factory ? `${s.factory}().` : ""}${st.fn}(${st.args.map(show).join(", ")})` : "(factory)", a: sx, b: sy });
      }
    }
  }
  return out;
};

export type Ruling = { script: string; step: number; right: "A" | "B" | "both" | "neither" | "open"; expected?: string };

/** The adjudicator answers each disagreement with who is right by the brief. A build is wrong when it is not the one the ruling names. */
export const wrongBuilds = ({ disputes, rulings }: { disputes: Disagreement[]; rulings: Ruling[] }): { aWrong: Disagreement[]; bWrong: Disagreement[]; unruled: Disagreement[] } => {
  const aWrong: Disagreement[] = [];
  const bWrong: Disagreement[] = [];
  const unruled: Disagreement[] = [];
  for (const d of disputes) {
    const r = rulings.find((x) => x.script === d.script && x.step === d.step);
    if (!r) unruled.push(d);
    else if (r.right === "B" || r.right === "neither") aWrong.push(d);
    if (r && (r.right === "A" || r.right === "neither")) bWrong.push(d);
  }
  return { aWrong, bWrong, unruled };
};

export const parseRulings = (text: string): Ruling[] | null => {
  const from = text.indexOf("[");
  const to = text.lastIndexOf("]");
  if (from < 0 || to < from) return null;
  let value: unknown;
  try {
    value = JSON.parse(text.slice(from, to + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const out: Ruling[] = [];
  for (const r of value) {
    if (!isRecord(r) || typeof r.script !== "string" || typeof r.step !== "number" || !["A", "B", "both", "neither", "open"].includes(String(r.right))) return null;
    out.push({ script: r.script, step: r.step, right: r.right as Ruling["right"], ...(typeof r.expected === "string" ? { expected: r.expected } : {}) });
  }
  return out;
};
