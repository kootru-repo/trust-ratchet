// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const SOURCE = path.resolve(import.meta.dirname, "..");
// In the development repository the shipped workflows are under public/; in the public repository they are at the root.
const devCopy = path.join(SOURCE, "public/.github/workflows");
const isDev = fs.existsSync(devCopy);
const shipped = isDev ? devCopy : path.join(SOURCE, ".github/workflows");

test("every action the shipped workflows use is pinned to a commit, or is a local file", () => {
  const files = fs.readdirSync(shipped).filter((f) => f.endsWith(".yml"));
  assert.ok(files.includes("gate.yml") && files.includes("release.yml"));
  for (const name of files) {
    for (const line of fs.readFileSync(path.join(shipped, name), "utf8").split(/\r?\n/)) {
      const m = /^\s*-?\s*uses:\s*(\S+)/.exec(line);
      if (!m?.[1] || m[1].startsWith("./")) continue;
      assert.match(m[1], /@[0-9a-f]{40}$/, `${name}: ${m[1]} is not pinned to a commit`);
    }
  }
});

test("the reusable workflows the self-tests call are the same files the public repository ships", { skip: !isDev }, () => {
  for (const name of ["gate.yml", "release.yml"]) {
    assert.equal(fs.readFileSync(path.join(SOURCE, ".github/workflows", name), "utf8"), fs.readFileSync(path.join(devCopy, name), "utf8"), name);
  }
});
