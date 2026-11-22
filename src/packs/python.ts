import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { escapeRegExp, type Pack } from "../pack.ts";
import type { Specialist } from "../plan.ts";
import type { ReproConfig, RunOutcome, TestRunner } from "../repro.ts";

export const PY_SPECIALISTS: Specialist[] = [
  {
    id: "intent",
    focus: "whether the code does what its names, docstrings, comments and callers say it does",
    lookFor: "inverted or wrong conditions, wrong variable used, wrong default, a branch that can never run or always runs, a value computed but not used, a return value that contradicts the docstring or a caller's expectation, an error message that describes a different condition than the one tested",
  },
  {
    id: "missing",
    focus: "missing values and control flow",
    lookFor: "None reaching an attribute access, call or arithmetic; a KeyError or IndexError on input that can occur; empty string, empty list, 0 or 0.0 treated as missing by a truthiness test (`if x:`, `x or default`); dict.get without a usable default; early returns that skip cleanup; off-by-one and boundary cases in ranges and slices; a bare or broad except that hides a real error",
  },
  {
    id: "mutation",
    focus: "shared mutable state",
    lookFor: "a mutable default argument; a list, dict or array mutated in place while the caller or another holder still uses it; a view mistaken for a copy (or a copy mistaken for a view); state kept on a module or class that leaks between calls; iteration over a container that is changed during the loop; a cache that is never invalidated",
  },
  {
    id: "shape",
    focus: "array shapes, axes and numeric types",
    lookFor: "an operation on the wrong axis; broadcasting that silently produces a different shape than intended; a reshape or transpose that scrambles the meaning of the axes; integer division or an integer dtype where a float is needed; a float compared with == ; overflow or loss of precision from a narrow dtype; an index array of the wrong dtype; NaN or inf that propagates unnoticed; degrees mixed with radians",
  },
  {
    id: "determinism",
    focus: "reproducibility of results",
    lookFor: "a random draw without a seed or with a global seed another call can disturb; a result that depends on set or dict ordering, file listing order or wall-clock time; a seed reused so two streams are identical; state carried between runs through a file or cache that is not part of the stated inputs; a parallel step whose result depends on scheduling",
  },
  {
    id: "units",
    focus: "physical units and scale factors",
    lookFor: "two quantities in different units added, compared or passed to one parameter (mm with m, ms with s, Hz with rad/s, degrees with radians, grams with kilograms); a conversion factor applied twice or not at all; a constant whose unit does not match the variable it is assigned to; a time step used in one unit and stated in another",
  },
  {
    id: "io",
    focus: "files, paths, encodings and external processes",
    lookFor: "a file read or written with the platform default encoding where the content is not ASCII; a file left half-written when an error occurs; a path built by string concatenation that breaks on another platform or on a space; a subprocess whose failure is ignored; data parsed from a file without checking the fields it needs; a write that silently overwrites or a read of a file that may be stale",
  },
  {
    id: "sourcing",
    focus: "values that the project requires to come from configuration, not from code",
    lookFor: "a numeric constant written into the code that affects results and is not read from the project's configuration; a value from configuration that is silently replaced, clamped or defaulted in code; a setting read under one name and documented under another; a fallback value that hides a missing configuration entry",
  },
];

const byId = (id: string): Specialist => {
  const found = PY_SPECIALISTS.find((s) => s.id === id);
  if (!found) throw new Error(`the python pack has no specialist "${id}"`);
  return found;
};

/** Deterministic choice of specialists from the file's contents. `extras` are added by the target (for example "sourcing"). */
export const pickPySpecialists = ({ content, extras }: { file: string; content: string; extras: string[] }): Specialist[] => {
  const ids = ["intent", "missing", "mutation"];
  if (/^\s*(import|from)\s+(numpy|torch|jax|scipy|pandas|cupy)\b/m.test(content)) ids.push("shape");
  if (/\b(random|seed|rng|default_rng|shuffle|RandomState|time\.time|os\.listdir|glob\()/.test(content)) ids.push("determinism");
  if (/(_mm|_ms|_um|_hz|_kg|_deg|_rad|_sec|_newton)\b|\b(mm|ms|um|Hz|kg|deg|rad|newton|metre|meter)s?\b/.test(content)) ids.push("units");
  if (/\bopen\(|\bsubprocess\b|\.read_text\(|\.write_text\(|json\.load|json\.dump|\bcsv\./.test(content)) ids.push("io");
  for (const e of extras) if (!ids.includes(e)) ids.push(e);
  return ids.map(byId);
};

const unescapeXml = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#10;/g, "\n").replace(/&amp;/g, "&");

/**
 * Pure: reads pytest's JUnit report. Only a failed assertion counts as the bug showing itself.
 * A collection error, an import error or any other exception is a broken test.
 */
export const readJUnit = (xml: string, fallback: string): RunOutcome => {
  const cases = (xml.match(/<testcase\b/g) ?? []).length;
  const errors = [...xml.matchAll(/<error\b[^>]*?message="([^"]*)"/g)].map((m) => unescapeXml(m[1] ?? ""));
  const failures = [...xml.matchAll(/<failure\b[^>]*?message="([^"]*)"/g)].map((m) => unescapeXml(m[1] ?? ""));
  if (errors.length > 0) return { outcome: "error", output: (errors.join("\n") + "\n" + fallback).slice(0, 3000) };
  if (cases === 0) return { outcome: "error", output: fallback.slice(0, 3000) || "no test ran" };
  if (failures.length === 0) return { outcome: "passed", output: `${cases} test(s) passed` };
  const asserted = failures.every((f) => /^(AssertionError|assert\b|Failed\b)/.test(f.trim()));
  return { outcome: asserted ? "failed-assertion" : "error", output: (failures.join("\n") + "\n" + fallback).slice(0, 3000) };
};

export const PY_TEST_DIR = "_ratchet_tests";

/** A TestRunner for Python packages, using pytest. */
export const pytestRunner = (config: ReproConfig): TestRunner => ({ root, code, name }) => {
  const pkgDir = path.resolve(root, config.pkg);
  const testDir = path.join(pkgDir, PY_TEST_DIR);
  const testFile = path.join(testDir, `test_${name}.py`);
  const reportFile = path.join(pkgDir, "_ratchet_report.xml");
  const python = config.python ?? "python";
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(testFile, code);
  try {
    let text = "";
    try {
      text = execFileSync(`"${python}" -m pytest "${PY_TEST_DIR}/test_${name}.py" -q --no-header -p no:cacheprovider --junitxml=_ratchet_report.xml`, {
        cwd: pkgDir,
        shell: true,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 3 * 60_000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, PYTHONPATH: [pkgDir, process.env.PYTHONPATH ?? ""].filter(Boolean).join(path.delimiter), PYTHONDONTWRITEBYTECODE: "1" },
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      text = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim() || (e.message ?? "");
    }
    if (!fs.existsSync(reportFile)) return { outcome: "error", output: text.slice(-3000) };
    return readJUnit(fs.readFileSync(reportFile, "utf8"), text.slice(-2000));
  } finally {
    fs.rmSync(reportFile, { force: true });
    fs.rmSync(testDir, { recursive: true, force: true });
  }
};

/** `tools/dm/dmlib.py` is imported as `dmlib`, `tools.dm.dmlib`, `from tools.dm import dmlib` or `from . import dmlib`. */
/** Pure: the local names an importing file gives to what it imports from `file`. */
export const pyImportedNames = (importerText: string, file: string): string[] => {
  const base = (file.split("/").pop() ?? file).replace(/\.py$/, "");
  const out: string[] = [];
  for (const m of importerText.matchAll(new RegExp(`^\\s*from\\s+[\\w.]*\\b${base}\\s+import\\s+(\\([^)]*\\)|[^\\n]+)`, "gm")))
    for (const p of (m[1] ?? "").replace(/[()]/g, "").split(",")) out.push((/\bas\s+(\w+)/.exec(p)?.[1] ?? p).trim());
  for (const m of importerText.matchAll(new RegExp(`^\\s*import\\s+([\\w.]*\\b${base})(?:\\s+as\\s+(\\w+))?`, "gm"))) out.push(m[2] ?? base);
  for (const m of importerText.matchAll(new RegExp(`^\\s*from\\s+[\\w.]+\\s+import\\s+[^\\n]*\\b${base}\\b(?:\\s+as\\s+(\\w+))?`, "gm"))) out.push(m[1] ?? base);
  return [...new Set(out.filter((n) => /^[A-Za-z_]\w*$/.test(n)))];
};

export const pyLocalImports = ({ root, file, content, pkg }: { root: string; file: string; content: string; pkg: string }): string[] => {
  const dir = path.dirname(path.resolve(root, file));
  const out = new Set<string>();
  const mods = [...content.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)].map((m) => m[1] ?? m[2] ?? "");
  for (const mod of mods) {
    const dots = /^\.*/.exec(mod)?.[0].length ?? 0;
    const rel = mod.slice(dots).split(".").join("/");
    if (!rel) continue;
    const bases = dots > 0 ? [path.resolve(dir, "../".repeat(dots - 1))] : [path.resolve(root), path.resolve(root, pkg), dir];
    const hit = bases.flatMap((b) => [path.join(b, rel + ".py"), path.join(b, rel, "__init__.py")]).find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
    if (hit && path.resolve(hit) !== path.resolve(root, file)) out.add(path.relative(path.resolve(root), hit).split(path.sep).join("/"));
  }
  return [...out].slice(0, 12);
};

const importerPattern = (file: string): RegExp => {
  const stem = path.basename(file) === "__init__.py" ? path.basename(path.dirname(file)) : path.basename(file).replace(/\.py$/, "");
  const s = escapeRegExp(stem);
  return new RegExp(`^\\s*(?:import\\s+(?:[\\w.]+\\.)?${s}\\b|from\\s+(?:[\\w.]*\\.)?${s}\\s+import\\b|from\\s+[\\w.]+\\s+import\\s+(?:\\(?[\\w\\s,]*\\b)?${s}\\b)`, "m");
};

export const pythonPack: Pack = {
  name: "python",
  language: "Python",
  handles: (file) => /\.py$/.test(file),
  isSource: (name) => /\.py$/.test(name),
  packageMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "pytest.ini"],
  importerPattern,
  importedNames: pyImportedNames,
  localImports: pyLocalImports,
  pickSpecialists: pickPySpecialists,
  defaultChecks: (file) => [`python -m py_compile "${file}"`],
  runner: pytestRunner,
  testGuide: (pkg) =>
    `- Write one pytest test file. It will be saved as ${pkg === "." ? "" : `${pkg}/`}${PY_TEST_DIR}/test_<name>.py and run with the folder ${pkg === "." ? "at the root of the tree" : pkg} on the import path. Import the code under test the way the repository's own scripts and tests import it.
- Assert with plain assert. If the bug shows as a raised exception, catch it and call pytest.fail("...") or assert on the outcome, so the failure is an assertion and not a stray exception.
- Do not read or write files outside pytest's tmp_path. Do not start long computations: the test must finish in seconds. Build the smallest input that triggers the bug.
- If the module needs heavy setup at import time, use monkeypatch or a small stub. Read the existing tests in the repository to see how it is done here.
- "test" in your reply is the full test file.`,
};
