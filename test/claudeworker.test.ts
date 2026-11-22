import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { spawnClaudeWorker } from "../src/swarm/claudeworker.ts";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-cw-")));
const git = (...a: string[]): string => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
git("init", "-q");
git("config", "user.email", "t@example.invalid");
git("config", "user.name", "t");
fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
git("add", "a.txt");
git("commit", "-q", "-m", "base");
const prog = path.join(dir, "..", `cw-${path.basename(dir)}.mjs`);
fs.writeFileSync(prog, 'import fs from "node:fs";fs.writeFileSync("new.txt","fresh");fs.appendFileSync("a.txt","two");process.stdout.write("done");');

test("the patch a worker hands over carries a new file as well as an edit, and the worker stages nothing itself", async () => {
  const h = spawnClaudeWorker(dir, "unused", "haiku", [prog], process.execPath)({ slice: { id: "s", files: ["a.txt", "new.txt"], prompt: "" }, env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)) });
  const end = await h.done;
  assert.equal(end.report, "done");
  assert.deepEqual(end.files?.sort(), ["a.txt", "new.txt"]);
  assert.match(end.diff ?? "", /\+fresh/);
  assert.match(end.diff ?? "", /\+two/);
  assert.equal(h.author, "worker-s");
});
