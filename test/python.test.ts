// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gatherContext } from "../src/context.ts";
import { packFor } from "../src/packs/index.ts";
import { pickPySpecialists, pytestRunner, pythonPack, readJUnit } from "../src/packs/python.ts";
import { reviewFile } from "../src/review.ts";
import type { ModelFn } from "../src/types.ts";

const tree = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-py-"));
  fs.mkdirSync(path.join(root, "tools", "dm"), { recursive: true });
  fs.writeFileSync(path.join(root, "tools", "__init__.py"), "");
  fs.writeFileSync(path.join(root, "tools", "dm", "__init__.py"), "");
  fs.writeFileSync(path.join(root, "tools", "dm", "pick.py"), ["def first_titles(rows):", '    """Return the first cell of every row, or an empty string."""', "    return [r[0].strip() or '' for r in rows]", ""].join("\n"));
  fs.writeFileSync(path.join(root, "tools", "dm", "use_a.py"), "from tools.dm.pick import first_titles\n");
  fs.writeFileSync(path.join(root, "tools", "dm", "use_b.py"), "from . import pick\n");
  fs.writeFileSync(path.join(root, "tools", "dm", "use_c.py"), "import tools.dm.pick as p\n");
  fs.writeFileSync(path.join(root, "tools", "dm", "other.py"), "from tools.dm.picker import x\nimport pickle\n");
  return root;
};

const json = (v: unknown): string => "```json\n" + JSON.stringify(v) + "\n```";

test("packFor chooses a pack by extension and refuses an unknown one", () => {
  assert.equal(packFor("a/b.py").name, "python");
  assert.equal(packFor("a/b.tsx").name, "typescript");
  assert.throws(() => packFor("a/b.rs"), /no language pack/);
});

test("python specialists: three always run, the rest follow the file's contents, extras are added once", () => {
  const ids = (content: string, extras: string[] = []): string[] => pickPySpecialists({ file: "a.py", content, extras }).map((s) => s.id);
  assert.deepEqual(ids("x = 1\n"), ["intent", "missing", "mutation"]);
  assert.deepEqual(ids("import numpy as np\nrng = np.random.default_rng(0)\n"), ["intent", "missing", "mutation", "shape", "determinism"]);
  assert.deepEqual(ids("step_ms = 5\nwith open(p) as f:\n    pass\n"), ["intent", "missing", "mutation", "units", "io"]);
  assert.deepEqual(ids("x = 1\n", ["sourcing", "intent"]), ["intent", "missing", "mutation", "sourcing"]);
  assert.throws(() => ids("x = 1\n", ["nonsense"]), /no specialist/);
});

test("python importers: absolute, relative and aliased imports are found, lookalike names are not", () => {
  const root = tree();
  const ctx = gatherContext({ root, file: "tools/dm/pick.py", pack: pythonPack });
  assert.deepEqual(ctx.importers, ["tools/dm/use_a.py", "tools/dm/use_b.py", "tools/dm/use_c.py"]);
  assert.equal(ctx.pkg, ".");
});

test("readJUnit: only a failed assertion counts", () => {
  const suite = (inner: string): string => `<testsuites><testsuite tests="1">${inner}</testsuite></testsuites>`;
  const tc = (inner = ""): string => `<testcase classname="t" name="test_x">${inner}</testcase>`;
  assert.equal(readJUnit(suite(tc(`<failure message="AssertionError: assert [''] == ['a']">body</failure>`)), "").outcome, "failed-assertion");
  assert.equal(readJUnit(suite(tc(`<failure message="assert 1 == 2">body</failure>`)), "").outcome, "failed-assertion");
  assert.equal(readJUnit(suite(tc(`<failure message="Failed: raised IndexError">body</failure>`)), "").outcome, "failed-assertion");
  assert.equal(readJUnit(suite(tc(`<failure message="IndexError: list index out of range">body</failure>`)), "").outcome, "error");
  assert.equal(readJUnit(suite(tc(`<error message="collection failure">ModuleNotFoundError</error>`)), "").outcome, "error");
  assert.equal(readJUnit(suite(tc()), "").outcome, "passed");
  assert.equal(readJUnit(`<testsuites><testsuite tests="0"></testsuite></testsuites>`, "nothing collected").outcome, "error");
});

test("pytestRunner runs real pytest: assertion failure, pass, stray exception and import error are told apart, and nothing is left behind", () => {
  const root = tree();
  const run = pytestRunner({ pkg: "." });
  const head = "from tools.dm.pick import first_titles\n";
  assert.equal(run({ root, name: "a", code: head + "def test_a():\n    assert first_titles([[' x ']]) == ['y']\n" }).outcome, "failed-assertion");
  assert.equal(run({ root, name: "b", code: head + "def test_b():\n    assert first_titles([[' x ']]) == ['x']\n" }).outcome, "passed");
  // The real bug in the fixture: an empty row raises IndexError. Unwrapped, that is a stray exception, not a reproduction.
  assert.equal(run({ root, name: "c", code: head + "def test_c():\n    assert first_titles([[]]) == ['']\n" }).outcome, "error");
  const wrapped = head + "import pytest\n\ndef test_d():\n    try:\n        out = first_titles([[]])\n    except IndexError as e:\n        pytest.fail(f'raised {e!r}')\n    assert out == ['']\n";
  assert.equal(run({ root, name: "d", code: wrapped }).outcome, "failed-assertion");
  assert.equal(run({ root, name: "e", code: "from tools.dm.nothing import x\n\ndef test_e():\n    assert x\n" }).outcome, "error");
  assert.equal(fs.existsSync(path.join(root, "_ratchet_tests")), false);
  assert.equal(fs.existsSync(path.join(root, "_ratchet_report.xml")), false);
});

test("a python file goes through the whole pipeline, with python wording and a real reproduction", async () => {
  const root = tree();
  const cite = { file: "tools/dm/pick.py", line: 3, quote: "return [r[0].strip() or '' for r in rows]" };
  const prompts: string[] = [];
  const model: ModelFn = async ({ prompt, label }) => {
    prompts.push(prompt);
    if (label.startsWith("missing")) return json({ concerns: [{ title: "An empty row raises IndexError", severity: "major", ...cite, reasoning: "r[0] on []" }], dismissed: [] });
    if (label.startsWith("verify")) return json({ verdict: "confirmed", explanation: "first_titles([[]]) raises", callSites: ["tools/dm/use_a.py:1"], proof: [cite], guard: "unit test with an empty row" });
    if (label.startsWith("repro"))
      return json({ reproducible: true, reason: "", test: "import pytest\nfrom tools.dm.pick import first_titles\n\ndef test_empty_row():\n    try:\n        out = first_titles([[]])\n    except IndexError as e:\n        pytest.fail(f'raised {e!r}')\n    assert out == ['']\n" });
    return json({ concerns: [], dismissed: [] });
  };
  const res = await reviewFile({ root, file: "tools/dm/pick.py", model, repro: { pkg: ".", runner: pytestRunner({ pkg: "." }) }, extras: ["sourcing"] });
  assert.deepEqual(res.specialists, ["intent", "missing", "mutation", "sourcing"]);
  assert.equal(res.checked[0]?.verdict, "confirmed");
  assert.equal(res.checked[0]?.repro?.status, "reproduced");
  assert.ok(prompts.every((p) => !p.includes("TypeScript")));
  assert.ok(prompts.some((p) => p.includes("on a Python codebase")));
  assert.ok(prompts.some((p) => p.includes("pytest.fail")));
});
