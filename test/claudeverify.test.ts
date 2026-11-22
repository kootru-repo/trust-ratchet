import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { claudeReadOnly } from "../src/swarm/claudeverify.ts";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-cv-")));
const prog = path.join(dir, "echo.mjs");
fs.writeFileSync(prog, 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{process.stdout.write("got:"+s+"|key:"+(process.env.ANTHROPIC_API_KEY??"none"));});\n');
const failing = path.join(dir, "fail.mjs");
fs.writeFileSync(failing, 'process.stderr.write("boom");process.exit(3);\n');

test("the verifier call sends the prompt on stdin, runs in the given folder and passes only the given environment", async () => {
  const call = claudeReadOnly({ settingsFile: "unused", bin: process.execPath, extraArgs: [prog] });
  const out = await call({ cwd: dir, env: { PATH: process.env.PATH ?? "" }, prompt: "hello" });
  assert.equal(out, "got:hello|key:none");
});

test("a failing session is an error that carries its stderr, and a hung one is stopped", async () => {
  await assert.rejects(claudeReadOnly({ settingsFile: "x", bin: process.execPath, extraArgs: [failing] })({ cwd: dir, env: { PATH: process.env.PATH ?? "" }, prompt: "" }), /exited 3: boom/);
  const hang = path.join(dir, "hang.mjs");
  fs.writeFileSync(hang, "setTimeout(()=>{},60000);\n");
  await assert.rejects(claudeReadOnly({ settingsFile: "x", bin: process.execPath, extraArgs: [hang], timeoutMs: 300 })({ cwd: dir, env: { PATH: process.env.PATH ?? "" }, prompt: "" }), /timed out/);
});
