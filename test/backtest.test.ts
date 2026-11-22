import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { backtest, firing, step, summarize } from "../src/harness/backtest.ts";
import { ALL_SHAPES, candidates, type FixFile } from "../src/harness/propose.ts";
import { ruleLines, type Rule } from "../src/harness/rules.ts";

const tmp = (name: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ratchet-${name}-`)));
const gitIn = (repo: string, ...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" });
const put = (repo: string, file: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
};
const commit = (repo: string, message: string): void => {
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", message);
};

test("one rule on one file over one commit: new lines are flagged, a fix of a new line is caught, of an old line is backlog", () => {
  // A line written after the rule existed, then removed by a fix: caught.
  const flagged = step({ live: {}, before: ["old()"], after: ["old()", "new()"], isFix: false });
  assert.deepEqual({ flagged: flagged.flagged, live: flagged.live }, { flagged: 1, live: { "new()": 1 } });
  const caught = step({ live: flagged.live, before: ["old()", "new()"], after: ["old()"], isFix: true });
  assert.deepEqual({ caught: caught.caught, backlogFixed: caught.backlogFixed, live: caught.live }, { caught: 1, backlogFixed: 0, live: {} });
  // The line that was there before the rule: its fix is backlog, not a catch.
  assert.equal(step({ live: {}, before: ["old()"], after: [], isFix: true }).backlogFixed, 1);
  assert.equal(step({ live: {}, before: ["old()"], after: [], isFix: false }).backlogRemoved, 1);
  // Removed by a commit that is not a fix: neither.
  const other = step({ live: { "new()": 1 }, before: ["new()"], after: [], isFix: false });
  assert.deepEqual({ caught: other.caught, removedOtherwise: other.removedOtherwise }, { caught: 0, removedOtherwise: 1 });
  // An edit in place keeps the line's standing and is not a new flag, even in a fix commit.
  const edit = step({ live: { "new(1)": 1 }, before: ["new(1)"], after: ["new(2)"], isFix: true });
  assert.deepEqual({ flagged: edit.flagged, caught: edit.caught, live: edit.live }, { flagged: 0, caught: 0, live: { "new(2)": 1 } });
});

test("the text a rule fires on is read by line or by statement", () => {
  const rule: Rule = { id: "x", kind: "ban-pattern", scope: "statement", pattern: "run\\((?!.*\\bencoding=)", files: ["**/*.py"], message: "m", fix: "f" };
  assert.deepEqual(firing(rule, "a = run(\n    1,\n    text=True)\nb = run(2, encoding='x')\n"), ["a = run( 1, text=True)"]);
  assert.deepEqual(firing(rule, ""), []);
});

test("each new shape writes a rule that fires on the line the fix removed and not on the line it added", () => {
  const proven = (fix: FixFile, shape: string): string => {
    const found = candidates(fix, ALL_SHAPES).filter((c) => c.shape === shape);
    const ok = found.filter((c) => ruleLines({ id: "x", ...c }, fix.removed.join("\n")).length > 0 && ruleLines({ id: "x", ...c }, fix.added.join("\n")).length === 0);
    assert.ok(ok.length > 0, `${shape}: ${JSON.stringify(found.map((c) => c.pattern))}`);
    return ok[0]?.pattern ?? "";
  };
  const fix = (file: string, removed: string, added: string): FixFile => ({ file, removed: [removed], added: [added], after: added });
  assert.match(proven(fix("tools/a.py", "    r = subprocess.run(cmd, shell=True, check=True)", "    r = subprocess.run(cmd, check=True)"), "keyword-removed"), /shell/);
  assert.match(proven(fix("tools/a.py", "    data = yaml.load(text, safe=False)", "    data = yaml.load(text, safe=True)"), "constant-swapped"), /safe/);
  proven(fix("tools/a.py", "from old.place import helper, other", "from new.place import helper, other"), "import-swapped");
  proven(fix("src/a.ts", 'import { helper } from "./old";', 'import { helper } from "./new";'), "import-swapped");
  proven(fix("src/a.ts", "  const rows = loadRows(id);", "  const rows = await loadRows(id);"), "await-added");
  proven(fix("src/a.ts", "  if (kind == other) return;", "  if (kind === other) return;"), "operator-swapped");
  // Nothing new is tried unless it is asked for.
  assert.deepEqual(candidates(fix("src/a.ts", "  if (kind == other) return;", "  if (kind === other) return;")), []);
});

test("a walk over a small history: a rule written at a fix names the same fault written later and fixed later, and never reads the future", () => {
  const repo = tmp("bt");
  gitIn(repo, "init", "-q", "-b", "main");
  const bad = (n: string): string => `import subprocess\ndef go():\n    return subprocess.run(["${n}"], capture_output=True, text=True)\n`;
  const good = (n: string): string => `import subprocess\ndef go():\n    return subprocess.run(["${n}"], capture_output=True, text=True, encoding="utf-8")\n`;
  put(repo, "tools/a.py", bad("a"));
  put(repo, "tools/old.py", bad("old"));
  put(repo, "tools/plain.py", "import subprocess\n" + 'subprocess.run(["x"], capture_output=True)\n'.repeat(30));
  commit(repo, "add");
  put(repo, "tools/a.py", good("a"));
  commit(repo, "fix: name the encoding");
  put(repo, "tools/b.py", bad("b"));
  put(repo, "tools/c.py", bad("c"));
  commit(repo, "two more tools");
  put(repo, "tools/b.py", good("b"));
  commit(repo, "fix: b read text without an encoding");
  put(repo, "tools/old.py", good("old"));
  commit(repo, "fix: old too");
  const statePath = path.join(tmp("st"), "bt.json");
  const state = backtest({ root: repo, statePath, memory: () => 0.1 });
  const s = summarize(state);
  assert.equal(state.done, true);
  assert.deepEqual({ commits: s.commits, fixes: s.fixes, rules: s.rules }, { commits: 5, fixes: 3, rules: 1 });
  // b.py: written after the rule, fixed by a fix. old.py: there before the rule. c.py: written after, never fixed.
  assert.deepEqual({ caught: s.caught, backlogFixed: s.backlogFixed, flagged: s.flagged, neverFixed: s.neverFixed }, { caught: 1, backlogFixed: 1, flagged: 2, neverFixed: 1 });
  assert.equal(state.rules[0]?.hitsWhenWritten, 1);
  // Stopped at once by a zero time limit, it has read nothing; resumed, it finishes with the same numbers.
  const p2 = path.join(tmp("st"), "bt.json");
  assert.equal(backtest({ root: repo, statePath: p2, minutes: 0, memory: () => 0.1 }).next, 0);
  assert.deepEqual(summarize(backtest({ root: repo, statePath: p2, resume: true, memory: () => 0.1 })), s);
});
