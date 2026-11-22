// SPDX-License-Identifier: AGPL-3.0-only
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { decode, parseCorpus, show, type Outcome, type Traces } from "./differential.ts";

/** Runs a corpus against one module: node corpusrun.ts <module.js> <corpus.json> <out.json>. Never throws for what the module does: a throw is an outcome. */
const callOf = (target: unknown, fn: string, args: unknown[]): Outcome => {
  try {
    const f = (target as Record<string, unknown>)[fn];
    if (typeof f !== "function") return { threw: "NotAFunction" };
    return { value: show((f as (...a: unknown[]) => unknown).apply(target, args.map(decode))) };
  } catch (e) {
    return { threw: e instanceof Error ? e.constructor.name : "Throw" };
  }
};

const main = async (): Promise<void> => {
  const [mod, corpusFile, out] = process.argv.slice(2);
  if (!mod || !corpusFile || !out) throw new Error("usage: corpusrun.ts <module.js> <corpus.json> <out.json>");
  const parsed = parseCorpus(fs.readFileSync(corpusFile, "utf8"));
  if ("error" in parsed) throw new Error(parsed.error);
  const m: unknown = await import(pathToFileURL(path.resolve(mod)).href);
  const traces: Traces = {};
  for (const s of parsed.scripts) {
    let target: unknown = m;
    const trace: Outcome[] = [];
    if (s.factory) {
      try {
        const f = (m as Record<string, unknown>)[s.factory];
        target = (f as (...a: unknown[]) => unknown)(...(s.factoryArgs ?? []).map(decode));
      } catch (e) {
        traces[s.id] = s.steps.map(() => ({ threw: `factory ${e instanceof Error ? e.constructor.name : "Throw"}` }));
        continue;
      }
    }
    for (const st of s.steps) trace.push(callOf(target, st.fn, st.args));
    traces[s.id] = trace;
  }
  fs.writeFileSync(out, JSON.stringify(traces));
};

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  });
}
