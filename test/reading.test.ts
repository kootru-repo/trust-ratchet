import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { gatherContext } from "../src/context.ts";
import { otherFilesOpened, summarizeEffort } from "../src/effort.ts";
import { readStream } from "../src/model.ts";
import { pyImportedNames, pythonPack } from "../src/packs/python.ts";
import { tsImportedNames, typescriptPack } from "../src/packs/typescript.ts";
import { SPECIALISTS } from "../src/plan.ts";
import { specialistPrompt } from "../src/prompts.ts";
import { judgeReading, openedFiles } from "../src/reading.ts";
import { reviewFile } from "../src/review.ts";
import type { ModelFn } from "../src/types.ts";

test("readStream returns the result and the tool calls in order", () => {
  const out = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "C:\\t\\src\\b.ts" } }] } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "pick\\(", path: "src" } }, { type: "text", text: "x" }] } }),
    "not json",
    JSON.stringify({ type: "result", result: "done", num_turns: 3 }),
  ].join("\n");
  const { result, tools } = readStream(out);
  assert.equal(result?.result, "done");
  assert.deepEqual(tools, [
    { name: "Read", target: "C:\\t\\src\\b.ts" },
    { name: "Grep", target: "src" },
  ]);
  assert.equal(readStream("").result, null);
});

test("imported names are found for TypeScript and Python", () => {
  assert.deepEqual(tsImportedNames('import React from "react";\nimport pick, { size as count, type Row } from "../utils/pick";\nimport * as other from "./other";', "src/utils/pick.ts"), ["pick", "count", "Row"]);
  assert.deepEqual(tsImportedNames('import {\n  a,\n  b,\n} from "~/utils/pick";', "src/utils/pick.ts"), ["a", "b"]);
  assert.deepEqual(pyImportedNames("from tools.dm.dmlib import read_note, write_note as wn\nimport os\n", "tools/dm/dmlib.py"), ["read_note", "wn"]);
  assert.deepEqual(pyImportedNames("import tools.dm.dmlib as dm\nfrom tools.dm import dmlib\n", "tools/dm/dmlib.py"), ["dm", "dmlib"]);
});

const tree = (): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-read-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "package.json"), "{}");
  fs.writeFileSync(path.join(root, "src", "pick.ts"), 'import { clean } from "./clean";\nexport const pick = (rows: string[][]) => rows.map((r) => clean(r[0]));\n');
  fs.writeFileSync(path.join(root, "src", "clean.ts"), "export const clean = (s: string) => s.trim();\n");
  fs.writeFileSync(path.join(root, "src", "page.ts"), 'import { pick } from "./pick";\nconst rows: string[][] = load();\nexport const titles = pick(rows);\nexport const again = pick([[]]);\n');
  return root;
};

test("context carries the call sites and the local imports, and the prompt prints them", () => {
  const root = tree();
  const context = gatherContext({ root, file: "src/pick.ts", pack: typescriptPack });
  assert.deepEqual(context.imports, ["src/clean.ts"]);
  assert.deepEqual(
    context.uses?.map((u) => `${u.file}:${u.line}`),
    ["src/page.ts:3", "src/page.ts:4"],
  );
  const specialist = SPECIALISTS[0];
  assert.ok(specialist);
  const off = specialistPrompt({ specialist, file: "src/pick.ts", context, facts: [], language: "TypeScript" });
  assert.match(off, /src\/page\.ts:4 {2}export const again = pick\(\[\[\]\]\);/);
  assert.doesNotMatch(off, /"read":/);
  const on = specialistPrompt({ specialist, file: "src/pick.ts", context, facts: [], language: "TypeScript", read: { required: 2, rejected: "it showed 0 checked read(s)" } });
  assert.match(on, /open at least 2 files other than src\/pick\.ts/);
  assert.match(on, /"read":/);
  assert.match(on, /thrown away for this reason: it showed 0/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("python local imports resolve inside the tree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-read-py-"));
  fs.mkdirSync(path.join(root, "tools", "dm"), { recursive: true });
  fs.writeFileSync(path.join(root, "tools", "dm", "dmlib.py"), "def read_note(p):\n    return p\n");
  fs.writeFileSync(path.join(root, "tools", "dm", "check.py"), "import os\nimport dmlib\nfrom tools.dm.dmlib import read_note\n\nprint(read_note('x'))\n");
  const context = gatherContext({ root, file: "tools/dm/check.py", pack: pythonPack });
  assert.deepEqual(context.imports, ["tools/dm/dmlib.py"]);
  const lib = gatherContext({ root, file: "tools/dm/dmlib.py", pack: pythonPack });
  assert.deepEqual(lib.uses?.map((u) => `${u.file}:${u.line}`), ["tools/dm/check.py:5"]);
  fs.rmSync(root, { recursive: true, force: true });
});

const ROOT = process.platform === "win32" ? "C:/t" : "/t";
const ELSEWHERE = process.platform === "win32" ? "C:/elsewhere/x.ts" : "/elsewhere/x.ts";

test("a read counts only when it is real", () => {
  const matches = (c: { quote: string; line: number }) => (c.quote === "good" ? { ok: true, line: c.line } : { ok: false, reason: "quote not found" });
  const base = { file: "src/pick.ts", shown: new Set(["src/page.ts:3"]), matches, required: 2 };
  const cite = (file: string, line: number, quote = "good") => ({ file, line, quote });
  // Opened and quoted correctly: counts.
  assert.equal(judgeReading({ ...base, reads: [cite("src/page.ts", 2), cite("src/clean.ts", 1)], opened: new Set(["src/page.ts", "src/clean.ts"]) }).ok, true);
  // The file under review, a line already printed, a bad quote, a file never opened, a second line of the same file.
  const v = judgeReading({
    ...base,
    reads: [cite("src/pick.ts", 1), cite("src/page.ts", 3), cite("src/clean.ts", 1, "bad"), cite("src/other.ts", 1), cite("src/page.ts", 2), cite("src/page.ts", 4)],
    opened: new Set(["src/page.ts", "src/clean.ts"]),
  });
  assert.equal(v.verified.length, 1);
  assert.equal(v.ok, false);
  assert.deepEqual(
    v.rejected.map((r) => r.reason),
    ["it is the file under review", "the line was already printed in the prompt", "quote not found", "the file was never opened with Read", "another line of this file is already counted"],
  );
  // With no tool record the quote check alone decides.
  assert.equal(judgeReading({ ...base, reads: [cite("src/other.ts", 1), cite("src/clean.ts", 1)], opened: null }).ok, true);
  assert.deepEqual([...openedFiles({ tools: [{ name: "Read", target: path.join(ROOT, "src", "b.ts") }, { name: "Grep", target: "src" }, { name: "Read", target: ELSEWHERE }], root: ROOT })], ["src/b.ts"]);
});

test("a specialist that did not read is asked once more, and the count is lowered to what exists", async () => {
  const root = tree();
  const prompts: string[] = [];
  const reply = (read: object[]): string => JSON.stringify({ concerns: [], dismissed: [], read });
  const lazyThenGood: ModelFn = async ({ prompt, onTools }) => {
    prompts.push(prompt);
    if (!prompt.includes("thrown away for this reason")) {
      onTools?.([]);
      // Quotes a line the prompt already printed, without opening anything.
      return reply([{ file: "src/page.ts", line: 3, quote: "export const titles = pick(rows);" }]);
    }
    onTools?.([
      { name: "Read", target: path.join(root, "src", "page.ts") },
      { name: "Read", target: path.join(root, "src", "clean.ts") },
    ]);
    return reply([
      { file: "src/page.ts", line: 2, quote: "const rows: string[][] = load();" },
      { file: "src/clean.ts", line: 1, quote: "export const clean = (s: string) => s.trim();" },
    ]);
  };
  const r = await reviewFile({ root, file: "src/pick.ts", model: lazyThenGood, requireReads: 5 });
  // Two other files exist, so two are required, not five.
  assert.ok(r.reading && r.reading.length > 0);
  for (const x of r.reading ?? []) assert.deepEqual({ required: x.required, verified: x.verified, retried: x.retried, opened: x.opened }, { required: 2, verified: 2, retried: true, opened: 2 });
  assert.equal(r.modelCalls, 2 * (r.reading?.length ?? 0));
  assert.equal(prompts.filter((p) => p.includes("thrown away for this reason")).length, r.reading?.length);

  // Switched off: one call each and no reading demanded.
  prompts.length = 0;
  const off = await reviewFile({ root, file: "src/pick.ts", model: lazyThenGood });
  assert.equal(off.modelCalls, off.specialists.length);
  assert.ok(prompts.every((p) => !p.includes('"read":')));
  // A file nothing imports and that imports nothing cannot be held to the rule.
  const alone = await reviewFile({ root, file: "src/clean.ts", model: async () => reply([]), requireReads: 2 });
  assert.equal(alone.reading?.[0]?.required, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("effort counts the other files a call opened", () => {
  const t = { label: "nullflow src/pick.ts", tools: [{ name: "Read", target: "C:\\t\\src\\pick.ts" }, { name: "Read", target: "C:\\t\\src\\page.ts" }, { name: "Read", target: "C:\\t\\src\\page.ts" }, { name: "Grep", target: "x" }] };
  assert.equal(otherFilesOpened(t), 1);
  assert.equal(otherFilesOpened({ label: "verify src/pick.ts:12", tools: [{ name: "Read", target: "C:/t/src/pick.ts" }] }), 0);
  assert.equal(otherFilesOpened({ label: "nullflow src/pick.ts" }), null);
  const { rows } = summarizeEffort([t, { label: "intent src/pick.ts", tools: [] }]);
  const row = rows.find((r) => r.role === "specialist");
  assert.equal(row?.otherFiles, 0.5);
  assert.equal(row?.noReads, 1);
});
