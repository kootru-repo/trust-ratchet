#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// The command of the npm package. Ratchet is TypeScript that Node runs directly, and Node does not do that for files
// under node_modules. So this launcher keeps a copy of the package's src/ outside node_modules, under the harness home,
// and runs the command line from there. `ratchet install` then makes its own copy for the hooks, as from a clone.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 6)) {
  console.error(`Ratchet needs Node 22.6 or later; this is ${process.versions.node}.`);
  process.exit(1);
}
const pkgRoot = path.join(import.meta.dirname, "..");
const version = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")).version;
const inNodeModules = pkgRoot.split(path.sep).includes("node_modules");
let root = pkgRoot;
if (inNodeModules) {
  const home = process.env.RATCHET_HOME ?? path.join(os.homedir(), ".claude", "ratchet");
  root = path.join(home, "pkg", `v${version}`);
  const done = path.join(root, "copied");
  if (!fs.existsSync(done)) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });
    fs.cpSync(path.join(pkgRoot, "src"), path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "ratchet-package-copy", version, private: true, type: "module" }, null, 2)}\n`);
    fs.writeFileSync(done, `${new Date().toISOString()}\n`);
  }
}
const ran = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", path.join(root, "src", "cli.ts"), ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(ran.status ?? 1);
