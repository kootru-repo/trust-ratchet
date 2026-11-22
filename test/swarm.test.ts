import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, runHook, type Context } from "../src/swarm/guard.ts";
import { acceptVerdict, parseResult, patchId, type Handover, type Verdict } from "../src/swarm/verdict.ts";

const root = process.platform === "win32" ? "C:/work/app" : "/work/app";
const worker: Context = { role: "worker", root, allow: ["town/lastlook.js", "town/simdb.json", "town/tests/"], hold: false };
const verifier: Context = { ...worker, role: "verifier" };
const edit = (file: string) => ({ tool: "Edit", file });
const bash = (command: string) => ({ tool: "Bash", command });
const ruleOf = (d: ReturnType<typeof decide>): string => (d.deny ? d.rule : "allowed");

test("guard: a worker writes only the files it was given (K5, K8)", () => {
  assert.equal(ruleOf(decide(worker, edit(`${root}/town/lastlook.js`))), "allowed");
  assert.equal(ruleOf(decide(worker, edit("town/tests/lastlook.test.mjs"))), "allowed");
  assert.equal(ruleOf(decide(worker, edit(`${root}/town/simdb.json`))), "allowed");
  assert.equal(ruleOf(decide(worker, edit(`${root}/town/people.js`))), "file-set");
  assert.equal(ruleOf(decide(worker, edit(`${root}/town/check_db.py`))), "file-set");
  assert.equal(ruleOf(decide(worker, edit(`${root}/.claude/settings.json`))), "file-set");
  assert.equal(ruleOf(decide(worker, edit(`${root}/CLAUDE.md`))), "file-set");
  assert.equal(ruleOf(decide(worker, edit(`${root}/../other/town/lastlook.js`))), "file-set");
  assert.equal(ruleOf(decide(worker, { tool: "Write" })), "file-set");
});

test("guard: a verifier never writes", () => {
  assert.equal(ruleOf(decide(verifier, edit(`${root}/town/lastlook.js`))), "verifier-writes");
  assert.equal(ruleOf(decide(verifier, { tool: "Write", file: `${root}/new.js` })), "verifier-writes");
});

test("guard: git add -A, irreversible commands and a worker's commit are refused (K11, K12)", () => {
  for (const c of ["git add -A", "git add --all", "git add .", "git -C /w add -A", "git add -A && git status"]) assert.equal(ruleOf(decide(worker, bash(c))), "git-add-all", c);
  for (const c of ["git push origin main", "git push --force", "git reset --hard HEAD~1", "git clean -fd", "git stash", "git checkout -- .", "rm -rf town"]) assert.equal(ruleOf(decide(worker, bash(c))), "irreversible", c);
  for (const c of ["git commit -m x", "git merge main", "git rebase main"]) assert.equal(ruleOf(decide(worker, bash(c))), "no-commit", c);
  for (const c of ["git add town/lastlook.js", "git status --short", "git diff", "py check_db.py", "node --test town/tests/lastlook.test.mjs"]) assert.equal(ruleOf(decide(worker, bash(c))), "allowed", c);
  assert.equal(ruleOf(decide(verifier, bash("git commit -m x"))), "allowed", "the commit rule is the worker's");
  assert.equal(ruleOf(decide(verifier, bash("git push"))), "irreversible");
});

test("guard: another project's session records are not read (K13)", () => {
  assert.equal(ruleOf(decide(worker, { tool: "Glob", pattern: "C:/Users/a/.claude/projects/*/*.jsonl" })), "other-projects-records");
  assert.equal(ruleOf(decide(worker, { tool: "Read", file: "C:\\Users\\a\\.claude\\projects\\x\\s.jsonl" })), "other-projects-records");
  assert.equal(ruleOf(decide(worker, { tool: "Grep", path: "~/.claude/projects", pattern: "x" })), "other-projects-records");
  assert.equal(ruleOf(decide(worker, bash("rg token ~/.claude/projects"))), "other-projects-records");
  assert.equal(ruleOf(decide(worker, { tool: "Read", file: `${root}/town/NEXT.md` })), "allowed");
});

test("guard: the hold is a zero-writes order (K9)", () => {
  const held: Context = { ...worker, hold: true };
  assert.equal(ruleOf(decide(held, edit(`${root}/town/lastlook.js`))), "hold");
  assert.equal(ruleOf(decide(held, bash("echo x > town/lastlook.js"))), "hold");
  assert.equal(ruleOf(decide(held, bash("git status"))), "allowed");
  assert.equal(ruleOf(decide(held, { tool: "Read", file: `${root}/town/NEXT.md` })), "allowed");
});

test("guard hook: a refusal is printed as Claude Code reads it, and nothing is printed when allowed or unguarded", () => {
  const env = { RATCHET_SWARM_ROLE: "worker", RATCHET_SWARM_ROOT: root, RATCHET_SWARM_ALLOW: "town/lastlook.js" };
  const out = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git add -A" }, session_id: "s", agent_id: "a" }), env);
  assert.match(out, /"permissionDecision":"deny"/);
  assert.match(out, /git-add-all/);
  assert.equal(runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" } }), env), "");
  assert.equal(runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "git add -A" } }), {}), "", "an unguarded session (the owner's) is never refused");
  assert.equal(runHook("not json", env), "");
});

const diff = "diff --git a/x b/x\n+one\n";
const handover: Handover = { task: "t", author: "session-worker", patchId: patchId(diff), base: "abc1234", files: ["x"] };
const good: Verdict = { verifier: "session-verifier", patchId: patchId(diff), status: "PASS", method: "ran check_db.py and the module test on the patched tree", checks: [{ command: "py check_db.py", exit: 0 }] };

test("verdict: a verdict from a session that did not write, on this patch, with checks that passed, is accepted", () => {
  assert.deepEqual(acceptVerdict(handover, good, diff), { ok: true, reasons: [], notes: [] });
});

test("verdict: each planted fault is refused with its reason (K3, K4)", () => {
  const cases: [string, Verdict, string, RegExp][] = [
    ["the author judges its own patch", { ...good, verifier: "session-worker" }, diff, /wrote the patch/],
    ["a verdict for another patch", { ...good, patchId: patchId("other") }, diff, /not /],
    ["the patch is edited after the verdict", good, `${diff}+two\n`, /changed after the verdict/],
    ["ISSUES is not PASS", { ...good, status: "ISSUES" }, diff, /not PASS/],
    ["no method", { ...good, method: " " }, diff, /no method/],
    ["no check run", { ...good, checks: [] }, diff, /no check was run/],
    ["a failing check with no base reading", { ...good, checks: [{ command: "py check_db.py", exit: 1 }] }, diff, /exit 1/],
    ["a check the patch broke", { ...good, checks: [{ command: "py check_db.py", exit: 1, baseExit: 0 }, { command: "node --test", exit: 0 }] }, diff, /passes on the base commit/],
    ["only inherited failures, no green check", { ...good, checks: [{ command: "py check_scene_db.py", exit: 1, baseExit: 1 }] }, diff, /no check passed/],
    ["a required check that fails on the base too", { ...good, checks: [{ command: "node --test t", exit: 1, baseExit: 1, mustPass: true }, { command: "py check_db.py", exit: 0 }] }, diff, /required check failed/],
  ];
  for (const [name, verdict, now, why] of cases) {
    const got = acceptVerdict(handover, verdict, now);
    assert.equal(got.ok, false, name);
    assert.ok(got.reasons.some((r) => why.test(r)), `${name}: ${got.reasons.join("; ")}`);
  }
});

test("verdict: a patch that touches a rule file outside the worker's set is refused even when every check is green (K8, a guard-off worker)", () => {
  const h: Handover = { ...handover, files: ["town/lastlook.js", "town/check_db.py"], allow: ["town/lastlook.js", "town/tests/"] };
  const got = acceptVerdict(h, good, diff);
  assert.equal(got.ok, false);
  assert.match(got.reasons.join(" "), /outside the worker.s set: town\/check_db.py/);
  assert.equal(acceptVerdict({ ...h, files: ["town/lastlook.js", "town/tests/a.mjs"] }, good, diff).ok, true);
});

test("verdict: a check that fails on the base commit too is a note and does not refuse a good patch (pstack: inherited faults do not block)", () => {
  const v: Verdict = { ...good, checks: [{ command: "py check_db.py", exit: 0, baseExit: 0 }, { command: "py check_scene_db.py", exit: 1, baseExit: 1 }] };
  const got = acceptVerdict(handover, v, diff);
  assert.equal(got.ok, true);
  assert.match(got.notes.join(" "), /fails on the base commit too/);
});

test("result: a report without heads or method is a gap, never a pass (K1)", () => {
  const ok = parseResult('done.\n{"status":"PASS","heads":["abc1234"],"method":"ran the test"}');
  assert.deepEqual(ok, { gap: false, status: "PASS", heads: ["abc1234"], method: "ran the test" });
  for (const text of ["I did it.", '{"status":"PASS","heads":[],"method":"x"}', '{"status":"PASS","heads":["abc1234"]}', '{"status":"DONE","heads":["abc1234"],"method":"x"}', '{"status":"PASS","heads":["not a sha"],"method":"x"}', '{"status": broken}']) {
    assert.equal(parseResult(text).gap, true, text);
  }
});
