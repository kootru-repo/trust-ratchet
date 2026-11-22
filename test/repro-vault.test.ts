// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { score } from "../src/bench.ts";
import { ident, uuidFrom } from "../src/ident.ts";
import { dropDepLinks, readVitest, reproduce, withDeps, type RunOutcome } from "../src/repro.ts";
import type { Checked, ModelFn, ReviewResult } from "../src/types.ts";
import { initVault, precision, readNote, readRulings, safeName, syncVault, writeReview } from "../src/vault.ts";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-test-"));
const json = (v: unknown): string => "```json\n" + JSON.stringify(v) + "\n```";

const checked = (over: Partial<Checked> = {}): Checked => ({
  origin: "concern",
  specialist: "nullflow",
  title: "Row may be empty: d[0] is read without a check",
  severity: "major",
  cite: { file: "src/pick.ts", line: 2, quote: "rows.map((d) => d[0].trim() || '');" },
  claim: "d[0] can be undefined",
  verdict: "confirmed",
  proof: [{ file: "src/pick.ts", line: 2, quote: "d[0].trim()" }],
  explanation: "pick([[]]) throws a TypeError",
  callSites: ["src/use.ts:2"],
  guard: "unit test: pick([[]]) returns ['']",
  ...over,
});

const review = (items: Checked[]): ReviewResult => ({ file: "src/pick.ts", specialists: ["intent", "nullflow"], facts: [], candidates: [], dismissals: [], dropped: [], unchecked: [], checked: items, modelCalls: 4, errors: [] });

test("ident ignores line numbers and whitespace; uuidFrom is stable and UUID-shaped", () => {
  assert.equal(ident({ file: "a.ts", line: 1, quote: "const  x = 1;" }), ident({ file: "a.ts", line: 99, quote: " const x = 1; " }));
  assert.notEqual(ident({ file: "a.ts", line: 1, quote: "const x = 1;" }), ident({ file: "b.ts", line: 1, quote: "const x = 1;" }));
  assert.match(uuidFrom("seed"), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(uuidFrom("seed"), uuidFrom("seed"));
});

test("readVitest: only a failed assertion counts as the bug showing itself", () => {
  const file = (tests: { status: string; failureMessages?: string[] }[], message = ""): Parameters<typeof readVitest>[0] => ({ testResults: [{ message, assertionResults: tests }] });
  assert.equal(readVitest(file([{ status: "failed", failureMessages: ["AssertionError: expected [ '' ] to deeply equal [ 'a' ]"] }]), "").outcome, "failed-assertion");
  assert.equal(readVitest(file([{ status: "failed", failureMessages: ["Error: Cannot find module '../utils/x'"] }]), "").outcome, "error");
  assert.equal(readVitest(file([{ status: "failed", failureMessages: ["ReferenceError: window is not defined"] }]), "").outcome, "error");
  assert.equal(readVitest(file([{ status: "passed" }]), "").outcome, "passed");
  assert.equal(readVitest(file([], "Failed to resolve import"), "raw").outcome, "error");
  assert.equal(readVitest({}, "nothing ran").output, "nothing ran");
});

test("withDeps links dependencies only while work runs and never deletes the real folder", () => {
  const deps = tmp();
  const root = tmp();
  fs.mkdirSync(path.join(deps, "node_modules", "lib"), { recursive: true });
  fs.writeFileSync(path.join(deps, "node_modules", "lib", "index.js"), "module.exports = 1;");
  fs.mkdirSync(path.join(deps, "pkg", "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(root, "pkg"));
  const seen = withDeps({ root, pkg: "pkg", depsFrom: deps, work: () => fs.existsSync(path.join(root, "node_modules", "lib", "index.js")) && fs.existsSync(path.join(root, "pkg", "node_modules")) });
  assert.equal(seen, true);
  assert.equal(fs.existsSync(path.join(root, "node_modules")), false);
  assert.equal(fs.existsSync(path.join(root, "pkg", "node_modules")), false);
  assert.equal(fs.existsSync(path.join(deps, "node_modules", "lib", "index.js")), true);
  assert.throws(() => withDeps({ root, pkg: "pkg", depsFrom: deps, work: () => { throw new Error("boom"); } }));
  assert.equal(fs.existsSync(path.join(root, "node_modules")), false);
  dropDepLinks({ root, pkg: "pkg" });
  assert.equal(fs.existsSync(path.join(deps, "node_modules", "lib", "index.js")), true);
});

test("reproduce: a failed assertion is reproduced, a pass speaks against the finding, a broken test gets one repair, a refusal is recorded", async () => {
  const run = async (replies: string[], outcomes: RunOutcome[]): Promise<{ status: string; attempts: number; prompts: string[] }> => {
    const prompts: string[] = [];
    const model: ModelFn = async ({ prompt }) => {
      prompts.push(prompt);
      return replies.shift() ?? "none";
    };
    const r = await reproduce({ check: checked(), root: ".", language: "TypeScript", guide: "- guide", model, runner: () => outcomes.shift() ?? { outcome: "error", output: "no more" }, name: "t" });
    return { status: r.status, attempts: r.attempts, prompts };
  };
  const good = json({ reproducible: true, reason: "", test: "test('x', () => {})" });
  assert.deepEqual((await run([good], [{ outcome: "failed-assertion", output: "AssertionError" }])).status, "reproduced");
  assert.deepEqual((await run([good], [{ outcome: "passed", output: "" }])).status, "test-passed");
  const repaired = await run([good, good], [{ outcome: "error", output: "Cannot find module" }, { outcome: "failed-assertion", output: "AssertionError" }]);
  assert.equal(repaired.status, "reproduced");
  assert.equal(repaired.attempts, 2);
  assert.match(repaired.prompts[1] ?? "", /Cannot find module/);
  assert.equal((await run([good, good], [{ outcome: "error", output: "a" }, { outcome: "error", output: "b" }])).status, "test-broken");
  assert.equal((await run([json({ reproducible: false, reason: "needs a browser", test: "" })], [])).status, "not-attempted");
  assert.equal((await run(["garbage"], [])).status, "test-broken");
});

test("score counts a reproduced hit and a proven guard", () => {
  const r = review([checked({ repro: { status: "reproduced", reason: "", test: "t", output: "o", attempts: 1, afterFix: "passes" } }), checked({ cite: { file: "src/pick.ts", line: 40, quote: "something else entirely" }, repro: { status: "test-passed", reason: "", test: "t", output: "", attempts: 1 } })]);
  const s = score({ id: "x", kind: "bug", ranges: [{ from: 2, to: 2 }], review: r, seconds: 1, locate: (c) => c.line });
  assert.equal(s.reproducedHit, true);
  assert.equal(s.guardProven, true);
  assert.equal(s.reproduced, 1);
  assert.equal(s.testPassed, 1);
  assert.equal(s.confirmedElsewhere, 1);
});

const SCHEMA = {
  nodeTypes: [
    { id: "node_claim", name: "Claim", format: "CLM - {content}" },
    { id: "node_evd", name: "Evidence", format: "EVD - {content}" },
    { id: "node_exp", name: "Experiment", format: "EXP - {content}" },
    { id: "node_hyp", name: "Hypothesis", format: "HYP- {content}" },
  ],
  relationTypes: [
    { id: "rel_supports", label: "supports" },
    { id: "rel_opposes", label: "opposes" },
    { id: "rel_consistent", label: "consistent with" },
    { id: "rel_motivates", label: "motivates" },
  ],
};

const vaultWithSchema = (): string => {
  const dir = tmp();
  const schema = path.join(dir, "schema.json");
  fs.writeFileSync(schema, JSON.stringify(SCHEMA));
  const vault = path.join(dir, "vault");
  initVault({ vault, schemaFrom: schema });
  return vault;
};

const META = { target: "demo", commit: "abcdef1234567890", model: "sonnet", when: "2026-11-19T10:00:00.000Z" };

test("safeName removes characters Obsidian and Windows refuse", () => {
  assert.equal(safeName('a/b: c? [d] #e "f" | g'), "a b c d e f g");
});

test("writeReview writes typed notes, is idempotent, and creates a ruling stub once", () => {
  const vault = vaultWithSchema();
  const open = checked({ verdict: "unproven", title: "Timer may fire late", cite: { file: "src/pick.ts", line: 9, quote: "setTimeout(() => go(), 100);" }, proof: [] });
  const refuted = checked({ verdict: "refuted", title: "Not a bug", cite: { file: "src/pick.ts", line: 20, quote: "const fine = true;" } });
  const r = review([checked({ repro: { status: "reproduced", reason: "", test: "test('x', () => { expect(1).toBe(2); })", output: "AssertionError", attempts: 1 } }), open, refuted]);

  const first = writeReview({ vault, review: r, meta: META });
  assert.equal(first.handEdited.length, 0);
  const findings = fs.readdirSync(path.join(vault, "Findings"));
  assert.equal(findings.length, 2);
  const claim = findings.find((f) => f.startsWith("CLM - "));
  const hyp = findings.find((f) => f.startsWith("HYP- "));
  assert.ok(claim && hyp);
  const note = readNote(path.join(vault, "Findings", claim));
  assert.equal(note.front.nodeTypeId, "node_claim");
  assert.equal(note.front.verdict, "confirmed");
  assert.equal(note.front.repro, "reproduced");
  assert.match(note.body, /reproduced by a failing test/);
  assert.match(fs.readFileSync(path.join(vault, "Proof", fs.readdirSync(path.join(vault, "Proof"))[0] ?? ""), "utf8"), /checked by a program/);
  assert.equal(fs.readdirSync(path.join(vault, "Rulings")).length, 2);
  assert.equal(fs.readdirSync(path.join(vault, "Runs")).length, 1);

  const rel = JSON.parse(fs.readFileSync(path.join(vault, "relations.json"), "utf8")) as { relations: Record<string, { type: string }> };
  const types = Object.values(rel.relations).map((x) => x.type).sort();
  // proof supports the claim, proof is consistent with the hypothesis, the run motivates the claim only
  assert.deepEqual(types, ["rel_consistent", "rel_motivates", "rel_supports"]);

  const before = fs.readFileSync(path.join(vault, "relations.json"), "utf8");
  const second = writeReview({ vault, review: r, meta: META });
  assert.equal(second.written, 0);
  assert.equal(fs.readFileSync(path.join(vault, "relations.json"), "utf8"), before);
  assert.equal(fs.readdirSync(path.join(vault, "Rulings")).length, 2);
});

test("a finding that changes status keeps its id and its ruling; a hand-edited harness note is left alone", () => {
  const vault = vaultWithSchema();
  const open = checked({ verdict: "unproven" });
  writeReview({ vault, review: review([open]), meta: META });
  const stub = path.join(vault, "Rulings", fs.readdirSync(path.join(vault, "Rulings"))[0] ?? "");
  fs.writeFileSync(stub, fs.readFileSync(stub, "utf8").replace('ruling: ""', "ruling: real").replace("Write your reason here.", "I checked it by hand."));

  writeReview({ vault, review: review([checked()]), meta: { ...META, when: "2026-11-20T10:00:00.000Z" } });
  const findings = fs.readdirSync(path.join(vault, "Findings"));
  assert.equal(findings.length, 1);
  assert.ok(findings[0]?.startsWith("CLM - "));
  assert.equal(fs.readdirSync(path.join(vault, "Rulings")).length, 1);
  assert.match(fs.readFileSync(stub, "utf8"), /I checked it by hand/);

  const file = path.join(vault, "Findings", findings[0] ?? "");
  fs.appendFileSync(file, "\nSomeone typed here.\n");
  const again = writeReview({ vault, review: review([checked({ explanation: "a new explanation" })]), meta: { ...META, when: "2026-11-21T10:00:00.000Z" } });
  assert.equal(again.handEdited.length, 1);
  assert.match(fs.readFileSync(file, "utf8"), /Someone typed here/);
});

test("rulings are read back, give precision, and add supports or opposes relations", () => {
  const vault = vaultWithSchema();
  const a = checked();
  const b = checked({ title: "Second", cite: { file: "src/pick.ts", line: 30, quote: "const second = other + 1;" }, specialist: "intent" });
  const c = checked({ title: "Third", cite: { file: "src/pick.ts", line: 50, quote: "const third = other + 2;" }, specialist: "intent" });
  writeReview({ vault, review: review([a, b, c]), meta: META });
  assert.equal(precision(readRulings(vault)).value, null);
  assert.match(fs.readFileSync(path.join(vault, "Dashboard.md"), "utf8"), /not yet trusted/);

  const set = (id: string, value: string): void => {
    const file = fs.readdirSync(path.join(vault, "Rulings")).find((f) => f.includes(id));
    assert.ok(file);
    const full = path.join(vault, "Rulings", file);
    fs.writeFileSync(full, fs.readFileSync(full, "utf8").replace('ruling: ""', `ruling: ${value}`));
  };
  set(ident(a.cite), "real");
  set(ident(b.cite), "false-alarm");
  const { dashboard, rulings } = syncVault(vault);
  const p = precision(rulings);
  assert.deepEqual([p.real, p.falseAlarm, p.unruled, p.value], [1, 1, 1, 0.5]);
  assert.match(dashboard, /1 real of 2 ruled \(50%\)/);
  assert.match(dashboard, /Waiting for a ruling: 1/);
  assert.match(dashboard, /\| intent \| 2 \| 0 \| 0 \| 1 \|/);
  const rel = JSON.parse(fs.readFileSync(path.join(vault, "relations.json"), "utf8")) as { relations: Record<string, { type: string }> };
  const types = Object.values(rel.relations).map((x) => x.type);
  assert.equal(types.filter((t) => t === "rel_opposes").length, 1);
  assert.equal(types.filter((t) => t === "rel_supports").length, 4);
});
