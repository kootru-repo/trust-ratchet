// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import { candidates, choose, type FixFile, type Judged } from "../src/harness/propose.ts";
import { ruleLines, type Rule } from "../src/harness/rules.ts";

const judge = (fix: FixFile, tree: Record<string, string>): Judged[] =>
  candidates(fix).map((c) => {
    const rule: Rule = { id: "x", ...c };
    const count = (text: string, r: Rule = rule): number => ruleLines(r, text).length;
    const all = Object.values(tree).reduce((n, t) => n + count(t), 0);
    const was = c.was ? Object.values(tree).reduce((n, t) => n + count(t, { ...rule, pattern: `(?<![\\w.])${c.was}\\b` }), 0) : undefined;
    return { candidate: c, onRemoved: count(fix.removed.join("\n")), onAdded: count(fix.added.join("\n")), leftByFix: count(fix.after), hits: all, ...(was === undefined ? {} : { wasStillUsed: was }) };
  });

test("a fix that adds a keyword argument to a call becomes the rule a person wrote for it", () => {
  const removed = ['    return subprocess.run([sys.executable, "-B", *args], cwd=wt, capture_output=True, text=True, env=ENV)'];
  const added = ['    return subprocess.run([sys.executable, "-B", *args], cwd=wt, capture_output=True, text=True, encoding="utf-8", errors="replace", env=ENV)   # a note name must not empty the text'];
  const after = `${added[0]}\nx = subprocess.run(["git"], capture_output=True, text=True)\n`;
  const fix: FixFile = { file: "tools/dm/test_semantic.py", removed, added, after };
  // The tree: binary reads are common and right, text reads without an encoding are the few faulty siblings.
  const tree = { a: 'subprocess.run(["a"], capture_output=True)\n'.repeat(30), b: 'r = subprocess.run(["b"], capture_output=True, text=True)\n'.repeat(3), c: after };
  const pick = choose({ judged: judge(fix, tree), cap: 25 });
  assert.equal(pick?.candidate.pattern, "subprocess\\.run\\((?=.*\\btext=True\\b)(?!.*\\bencoding=)");
  assert.equal(pick?.candidate.scope, "statement");
  assert.deepEqual(pick?.candidate.files, ["tools/**/*.py"]);
  assert.equal(pick?.hits, 4);
  // With a cap below the siblings nothing is kept: a pattern that fires everywhere names a habit, not a fault.
  assert.equal(choose({ judged: judge(fix, tree), cap: 2 }), null);
});

test("a fix that swaps one raised class keeps the narrowest wording that spares what the fix left standing", () => {
  const removed = ['        raise ValueError("%s: the properties cannot be read as YAML (%s)" % (path, e))'];
  const added = ['        raise UnreadableNote("%s: the properties cannot be read as YAML (%s)" % (path, e))'];
  const after = `${added[0]}\n    raise ValueError("no such table")\n`;
  const fix: FixFile = { file: "tools/dm/dmlib.py", removed, added, after };
  const pick = choose({ judged: judge(fix, { a: after }), cap: 25 });
  assert.equal(pick?.candidate.shape, "name-swapped");
  assert.match(pick?.candidate.pattern ?? "", /^\\braise\\s\+ValueError\\\(\.\*/);
  assert.equal(ruleLines({ id: "x", ...(pick?.candidate ?? { kind: "ban-pattern", pattern: "$^", files: [], message: "", fix: "" }) }, 'raise ValueError("no such table")').length, 0);
  assert.deepEqual(pick?.candidate.files, ["tools/dm/*.py"]);
});

test("a renamed variable, a changed word of text and a removed call are not rules", () => {
  const rename: FixFile = { file: "src/a.ts", removed: ["const allResults = load(input);", "return allResults.length;"], added: ["const results = load(input);", "return results.length;"], after: "const results = load(input);\nreturn results.length;\n" };
  assert.deepEqual(candidates(rename), []);
  const text: FixFile = { file: "src/p.tsx", removed: ["<p>The natural home</p>"], added: ["<p>A natural home</p>"], after: "<p>A natural home</p>" };
  assert.deepEqual(candidates(text), []);
  // A function renamed away everywhere is called on the removed line, but nothing is left of it to guard against.
  const gone: FixFile = { file: "src/u.ts", removed: ["  const n = getRelationsNode(tree);"], added: ["  const n = getRelationNode(tree);"], after: "const n = getRelationNode(tree);\n" };
  assert.equal(choose({ judged: judge(gone, { a: gone.after }), cap: 25 }), null);
  const removedCall: FixFile = { file: "src/u.ts", removed: ["  cache.clear();"], added: [], after: "export const x = 1;\n" };
  assert.deepEqual(candidates(removedCall), []);
});
