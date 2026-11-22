// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { VERSION } from "../src/version.ts";

const root = path.join(import.meta.dirname, "..");
const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", path.join(root, "src", "cli.ts"), ...args], { encoding: "utf8" });

test("the version in the source is the version of the package", () => {
  assert.equal(VERSION, (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version);
  assert.equal(run("--version").stdout.trim(), VERSION);
});

test("help goes to standard output with exit 0, with or without a command; an unknown command is named, with exit 2", () => {
  for (const args of [[], ["help"], ["--help"]]) {
    const r = run(...args);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Start here:/);
    assert.match(r.stdout, /ratchet install \| uninstall/);
  }
  const bad = run("frobnicate");
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Unknown command: frobnicate/);
  assert.doesNotMatch(bad.stderr, /ratchet launchgate/);
});

test("the package launcher runs the command line from a clone", () => {
  const r = spawnSync(process.execPath, [path.join(root, "bin", "ratchet.mjs"), "--version"], { encoding: "utf8" });
  assert.equal(r.stdout.trim(), VERSION);
});
