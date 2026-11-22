import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { decode, disagreements, encode, parseCorpus, parseRulings, show, wrongBuilds, type Traces } from "../src/swarm/differential.ts";

test("differential: values JSON cannot carry survive the round trip", () => {
  const v = [Number.NaN, Infinity, -Infinity, -0, undefined, 1.5, "x", { a: [Number.NaN] }];
  const back = decode(JSON.parse(JSON.stringify(encode(v)))) as unknown[];
  assert.ok(Number.isNaN(back[0]));
  assert.equal(back[1], Infinity);
  assert.equal(back[2], -Infinity);
  assert.ok(Object.is(back[3], -0));
  assert.equal(back[4], undefined);
  assert.equal(show(-0), '{"$":"-0"}');
  assert.equal(show(Number.NaN), '{"$":"NaN"}');
});

test("differential: a corpus that is not whole scripts is refused", () => {
  assert.ok("scripts" in parseCorpus('noise [{"id":"a","steps":[{"fn":"f","args":[1]}]}] noise'));
  for (const bad of ["no list", "[1]", '[{"id":"a"}]', '[{"id":"a","steps":[{"fn":"f"}]}]', '[{"id":"a","steps":[]},{"id":"a","steps":[]}]', "[{broken"]) assert.ok("error" in parseCorpus(bad), bad);
});

const scripts = [{ id: "s1", steps: [{ fn: "rate", args: [[1e-7]] }, { fn: "rate", args: [[2]] }] }];
test("differential: a step where two builds differ is a disagreement, with the call shown", () => {
  const a: Traces = { s1: [{ value: "0" }, { value: "2" }] };
  const b: Traces = { s1: [{ value: '{"$":"NaN"}' }, { value: "2" }] };
  const d = disagreements({ scripts, a, b });
  assert.equal(d.length, 1);
  assert.equal(d[0]?.step, 0);
  assert.match(d[0]?.call ?? "", /^rate\(\[1e-7\]\)$/);
  assert.deepEqual(disagreements({ scripts, a, b: a }), [], "two builds that agree have no disagreement");
});

test("differential: a throw against a value, and a script one build could not run, are disagreements", () => {
  const a: Traces = { s1: [{ threw: "TypeError" }, { value: "2" }] };
  const b: Traces = { s1: [{ value: "null" }] };
  const d = disagreements({ scripts, a, b });
  assert.deepEqual(d.map((x) => x.step), [0, 1]);
  assert.equal(d[1]?.b, "(not run)");
});

test("differential: the adjudicator's rulings say which build is wrong", () => {
  const d = [{ script: "s1", step: 0, call: "c", a: "1", b: "2" }, { script: "s1", step: 1, call: "c", a: "1", b: "2" }, { script: "s2", step: 0, call: "c", a: "1", b: "2" }];
  const r = parseRulings('[{"script":"s1","step":0,"right":"B"},{"script":"s1","step":1,"right":"open"}]');
  assert.ok(r);
  const w = wrongBuilds({ disputes: d, rulings: r });
  assert.equal(w.aWrong.length, 1);
  assert.equal(w.bWrong.length, 0);
  assert.equal(w.unruled.length, 1, "a disagreement nobody ruled on is never taken as settled");
  assert.equal(parseRulings('[{"script":"s1","step":0,"right":"maybe"}]'), null);
});

test("differential: the runner runs a corpus against a real module, a throw is an outcome, a factory keeps state", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-diff-"));
  fs.writeFileSync(path.join(dir, "m.js"), "export const half = (x) => { if (x < 0) throw new RangeError('neg'); return x / 2; };\nexport const makeCounter = () => { let n = 0; return { add: (k) => (n += k), get: () => n }; };\n");
  const corpus = [{ id: "p", steps: [{ fn: "half", args: [3] }, { fn: "half", args: [-1] }, { fn: "half", args: [{ $: "NaN" }] }, { fn: "nothing", args: [] }] }, { id: "c", factory: "makeCounter", steps: [{ fn: "add", args: [2] }, { fn: "add", args: [3] }, { fn: "get", args: [] }] }, { id: "bad", factory: "missing", steps: [{ fn: "x", args: [] }] }];
  fs.writeFileSync(path.join(dir, "corpus.json"), JSON.stringify(corpus));
  execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", path.resolve(import.meta.dirname, "../src/swarm/corpusrun.ts"), path.join(dir, "m.js"), path.join(dir, "corpus.json"), path.join(dir, "out.json")]);
  const out = JSON.parse(fs.readFileSync(path.join(dir, "out.json"), "utf8")) as Traces;
  assert.deepEqual(out.p, [{ value: "1.5" }, { threw: "RangeError" }, { value: '{"$":"NaN"}' }, { threw: "NotAFunction" }]);
  assert.deepEqual(out.c, [{ value: "2" }, { value: "5" }, { value: "5" }]);
  assert.match(JSON.stringify(out.bad), /factory/);
});
