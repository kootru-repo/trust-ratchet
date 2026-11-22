// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { BOUNDARY_FILE, boundaryProblems, checkBoundaries, importsOf, judgeBoundaries, type BoundaryConfig } from "../src/harness/boundaries.ts";

const tree = (files: Record<string, string>): string => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ratchet-bound-")));
  for (const [f, t] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), t);
  }
  return root;
};
const config = (extra: Partial<BoundaryConfig> = {}): BoundaryConfig => ({
  boundaries: [
    { name: "ui", folder: "src/ui", mayImportFrom: ["core"] },
    { name: "core", folder: "src/core", mayImportFrom: [] },
  ],
  ...extra,
});
const write = (root: string, c: BoundaryConfig): void => {
  fs.mkdirSync(path.join(root, ".ratchet"), { recursive: true });
  fs.writeFileSync(path.join(root, BOUNDARY_FILE), JSON.stringify(c));
};

test("B1: a clean tree passes", () => {
  const root = tree({ "src/ui/nav.ts": `import { a } from "../core/a.ts";\nimport "./x.ts";`, "src/ui/x.ts": "export {};", "src/core/a.ts": "export const a = 1;" });
  write(root, config());
  assert.deepEqual(checkBoundaries(root).findings, []);
});

test("B2: a cross-boundary import is caught and names the file, the import and the folders to use", () => {
  const root = tree({ "src/core/a.ts": `import { n } from "../ui/nav";`, "src/ui/nav.ts": "export const n = 1;" });
  write(root, config());
  const found = checkBoundaries(root).findings;
  assert.equal(found.length, 1);
  const f = found[0];
  assert.equal(f?.file, "src/core/a.ts");
  assert.equal(f?.blocking, true);
  assert.match(f?.detail ?? "", /imports \.\.\/ui\/nav \(src\/ui\/nav\.ts\)/);
  assert.match(f?.fix ?? "", /Import only from src\/core/);
});

test("B3: a two-step violation through a file in no boundary is caught", () => {
  const root = tree({ "src/ui/nav.js": `const m = require("../shared/mod.js");`, "src/shared/mod.js": `import("../core/c.ts");`, "src/core/c.ts": "export {};" });
  write(root, config({ boundaries: [{ name: "ui", folder: "src/ui", mayImportFrom: [] }, { name: "core", folder: "src/core", mayImportFrom: [] }] }));
  const f = checkBoundaries(root).findings[0];
  assert.match(f?.detail ?? "", /reaches src\/core\/c\.ts through src\/shared\/mod\.js/);
});

test("B4: a banned package is caught in a boundary", () => {
  const root = tree({ "src/ui/nav.ts": `import * as T from "three/examples/x";` });
  write(root, config({ boundaries: [{ name: "ui", folder: "src/ui", mayImportFrom: [], banPackages: ["three"] }] }));
  assert.match(checkBoundaries(root).findings[0]?.title ?? "", /package three/);
});

test("B5: the allowed backlog is tolerated, a new violation is refused, a fallen entry is listed", () => {
  const contents = new Map([["src/core/a.ts", `import "../ui/nav";`], ["src/ui/nav.ts", ""], ["src/core/b.ts", `import "../ui/nav";`]]);
  const r = judgeBoundaries({ config: config({ allowed: ["src/core/a.ts -> src/ui/nav.ts", "src/core/gone.ts -> src/ui/nav.ts"] }), contents });
  assert.equal(r.tolerated.length, 1);
  assert.deepEqual(r.findings.map((f) => f.file), ["src/core/b.ts"]);
  assert.deepEqual(r.fallen, ["src/core/gone.ts -> src/ui/nav.ts"]);
});

test("B6: Python import and from-import are checked, relative and absolute", () => {
  const root = tree({
    "svc/a.py": `from other import thing\nimport svc.own\nfrom . import own  # fine\n`,
    "svc/own.py": "x = 1\n",
    "other/thing.py": "y = 1\n",
    "other/__init__.py": "",
    "svc/b.py": `from other.thing import y\n`,
  });
  write(root, config({ boundaries: [{ name: "py", folder: "svc", mayImportFrom: [] }, { name: "other", folder: "other", mayImportFrom: [] }] }));
  assert.deepEqual(checkBoundaries(root).findings.map((f) => f.file), ["svc/a.py", "svc/a.py", "svc/b.py"]);
  assert.deepEqual(importsOf("a.py", "import os, sys as s\nfrom .m import (a, b)").map((i) => i.spec), ["os:", "sys:", ".m:a,b"]);
});

test("B7: comments are not imports, and a bad boundary file is reported", () => {
  assert.deepEqual(importsOf("a.ts", `// import x from "./y"\nconst s = 1;`), []);
  assert.ok(boundaryProblems({ boundaries: [{ name: "a", folder: "a", mayImportFrom: ["zz"] }] }).length > 0);
});
