// SPDX-License-Identifier: AGPL-3.0-only
// A walk through what a coding agent sees with Ratchet on, without Claude Code and without touching your setup:
// a throwaway repository and a throwaway harness home in the temp folder, and the same hook handler the installed hooks call.
// Run: npm run demo
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = (name: string): string => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ratchet-demo-${name}-`)));
process.env.RATCHET_HOME = tmp("home");
delete process.env.RATCHET_CHILD;
// imported after RATCHET_HOME is set, so nothing here can reach the real harness home
const { handle } = await import("../src/harness/hook.ts");
const { projectDir, setSwitch, writeJson } = await import("../src/harness/state.ts");

const repo = tmp("repo");
const git = (...args: string[]): string => execFileSync("git", ["-C", repo, "-c", "user.name=demo", "-c", "user.email=demo@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
const put = (file: string, text: string): void => { fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); fs.writeFileSync(path.join(repo, file), text); };
const say = (title: string): void => console.log(`\n=== ${title} ===`);
const show = (out: object | null): void => {
  const o = (out ?? {}) as { decision?: string; reason?: string; systemMessage?: string; hookSpecificOutput?: { additionalContext?: string } };
  if (out === null) { console.log("(the hook says nothing: all clear)"); return; }
  if (o.decision) console.log(`decision: ${o.decision}`);
  for (const text of [o.reason, o.hookSpecificOutput?.additionalContext, o.systemMessage]) if (text) console.log(text.replaceAll(repo.replaceAll("\\", "/"), "<repo>").replaceAll(repo, "<repo>"));
};

// a small project: one module, and one test that is mapped to it
put("calc.js", "exports.add = (a, b) => a + b;\n");
put("calc.test.js", "const { add } = require('./calc.js');\nif (add(2, 3) !== 5) { console.error('add(2, 3) should be 5'); process.exit(1); }\n");
git("init", "-q", "-b", "main");
git("add", "-A");
git("commit", "-q", "-m", "start");

setSwitch({ root: repo, enabled: true, mode: "enforce" });
writeJson(path.join(projectDir(repo), "config.json"), { tests: [{ name: "calc", command: "node calc.test.js", when: ["calc.js"] }] });
writeJson(path.join(projectDir(repo), "rules.json"), [{ id: "no-eval", kind: "ban-api", pattern: "eval", files: ["**/*.js"], message: "eval runs text as code", fix: "Parse the input with JSON.parse or a real parser." }]);

const session = { session_id: "demo", cwd: repo };
const edit = { ...session, tool_name: "Edit", tool_input: { file_path: path.join(repo, "calc.js") } };

say("1. The session starts: Ratchet tells the agent what is checked here");
show(handle("SessionStart", session));

say("2. The agent writes a file that breaks a rule: the fact and its fix come back at once");
handle("PreToolUse", edit);
put("calc.js", "exports.add = (a, b) => eval(`${a} + ${b}`);\n");
show(handle("PostToolUse", edit));

say("3. The agent removes the eval but breaks the sum, then tries to end its turn");
put("calc.js", "exports.add = (a, b) => a - b;\n");
show(handle("PostToolUse", edit));
show(handle("Stop", session));

say("4. The agent fixes the sum and ends its turn again");
put("calc.js", "exports.add = (a, b) => a + b;\n");
handle("PostToolUse", edit);
show(handle("Stop", session));

say("5. The verification record of the held turn");
const latest = path.join(projectDir(repo), "latest.md");
console.log(fs.existsSync(latest) ? fs.readFileSync(latest, "utf8").replaceAll(repo.replaceAll("\\", "/"), "<repo>").replaceAll(repo, "<repo>").trim() : "(no record written)");

fs.rmSync(repo, { recursive: true, force: true });
fs.rmSync(process.env.RATCHET_HOME, { recursive: true, force: true });
