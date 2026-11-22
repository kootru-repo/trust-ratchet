import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { forShell } from "../src/shellcmd.ts";

test("forShell gives the program word backslashes on Windows and leaves arguments alone", () => {
  assert.equal(forShell(".venv/Scripts/python.exe -B research/tests/check.py", "win32"), ".venv\\Scripts\\python.exe -B research/tests/check.py");
  assert.equal(forShell('"C:/Program Files/x/run.exe" a/b', "win32"), '"C:\\Program Files\\x\\run.exe" a/b');
  assert.equal(forShell("cd town && bin/py check_db.py && ./go.cmd x/y", "win32"), "cd town && bin\\py check_db.py && .\\go.cmd x/y");
  assert.equal(forShell("tool/a x | sort/b", "win32"), "tool\\a x | sort\\b");
  assert.equal(forShell('python -c "a && b/c"', "win32"), 'python -c "a && b/c"');   // a separator inside quotes starts no command
  assert.equal(forShell("py x.py 2>&1", "win32"), "py x.py 2>&1");
  assert.equal(forShell("https://x/y", "win32"), "https://x/y");
  assert.equal(forShell("/c dir", "win32"), "/c dir");
});

test("forShell leaves the line unchanged off Windows", () => {
  assert.equal(forShell(".venv/bin/python -B x.py", "linux"), ".venv/bin/python -B x.py");
  assert.equal(forShell(".venv/Scripts/python.exe x", "darwin"), ".venv/Scripts/python.exe x");
});

test("a relative program path with forward slashes runs through the shell", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-shell-"));
  fs.mkdirSync(path.join(dir, "bin", "sub"), { recursive: true });
  const node = process.execPath;
  const prog = process.platform === "win32" ? "bin/sub/hello.cmd" : "bin/sub/hello.sh";
  fs.writeFileSync(path.join(dir, prog), process.platform === "win32" ? `@"${node}" -e "process.stdout.write('ok')"\r\n` : `#!/bin/sh\nprintf ok\n`, { mode: 0o755 });
  const out = execFileSync(forShell(prog), { cwd: dir, shell: true, encoding: "utf8", windowsHide: true });
  assert.equal(out.trim(), "ok");
  fs.rmSync(dir, { recursive: true, force: true });
});
