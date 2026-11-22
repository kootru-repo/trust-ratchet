import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDrivers, renderDriverFaults, type DriverEnv, type RunResult } from "../src/harness/drivers.ts";

const ok = (stdout: string, code = 0, stderr = ""): RunResult => ({ code, stdout, stderr });
type Tree = { v: number };
type Behaviour = { help?: RunResult; normal?: RunResult; bad?: RunResult; dry?: (tree: Tree) => RunResult };
/** A planted driver: a table of what each call returns. `tree.v` is the state outside the output folder. */
const env = (b: Behaviour, tree: Tree = { v: 0 }, skillText?: string): DriverEnv => ({
  run: (_c, args) => {
    if (args[0] === "--help") return b.help ?? ok("usage: d [--dry-run]\nexit 0 ok, 1 broken, 2 cannot run");
    if (args[0] === "--ratchet-unknown-flag") return b.bad ?? ok("", 2, "unknown flag. Run d --help");
    if (args[0] === "--dry-run") return b.dry?.(tree) ?? ok('{"dry":true}');
    return b.normal ?? ok('{"ok":true}');
  },
  tree: () => String(tree.v),
  ...(skillText === undefined ? {} : { skillText }),
});
const d = { name: "d", command: "node d.js" };
const checks = (b: Behaviour, drv = d, tree?: Tree, skill?: string): string[] => checkDrivers([drv], env(b, tree, skill)).map((f) => f.check);

test("a driver that meets the contract has no fault", () => {
  const w = { ...d, writes: true };
  assert.deepEqual(checkDrivers([w], env({}, { v: 0 }, "call d in the skill")), []);
  assert.match(renderDriverFaults([w], []).join(""), /1 driver\(s\) meet/);
});

test("no --help, or --help that prints nothing", () => {
  assert.deepEqual(checks({ help: ok("", 2, "unknown flag --help. Run d") }), ["help"]);
  assert.deepEqual(checks({ help: ok("", 0) }), ["help"]);
});

test("exit codes other than 0, 1, 2 fail; an unknown flag that exits 0 fails", () => {
  assert.deepEqual(checks({ normal: ok("", 7, "bad. Run x") }), ["exit-code"]);
  assert.deepEqual(checks({ bad: ok('{"ok":1}', 0) }), ["exit-code"]);
});

test("a non-zero exit with nothing printed fails, also on a bad flag", () => {
  assert.deepEqual(checks({ normal: ok("", 1) }), ["silent"]);
  assert.deepEqual(checks({ bad: ok("", 2) }), ["silent"]);
});

test("error text that does not say what to do fails, with a message that does", () => {
  const f = checkDrivers([d], env({ normal: ok("", 1, "boom") }));
  assert.deepEqual(f.map((x) => x.check), ["advice"]);
  assert.match(f[0]?.message ?? "", /Say what to run or change/);
  assert.deepEqual(checks({ normal: ok("", 1, "failed: run npm install first") }), []);
});

test("more than 40 lines, and output that is not JSON", () => {
  const long = JSON.stringify({ rows: Array.from({ length: 50 }, (_, i) => i) }, null, 1);
  assert.deepEqual(checks({ normal: ok(long) }), ["lines"]);
  assert.deepEqual(checks({ normal: ok("all good") }), ["json"]);
  assert.deepEqual(checks({ normal: ok(JSON.stringify(Array.from({ length: 38 }, (_, i) => i), null, 1)) }), []);
});

test("a driver that is several commands fails", () => {
  assert.deepEqual(checks({}, { name: "d", command: "node a.js && node b.js" }), ["one-command"]);
  assert.deepEqual(checks({}, { name: "d", command: "node a.js | head" }), ["one-command"]);
});

test("a writing driver with no --dry-run fails; one whose --dry-run writes fails; a read-only one needs none", () => {
  const w = { ...d, writes: true };
  assert.deepEqual(checks({ dry: () => ok("", 2, "unrecognized option --dry-run. Run d --help") }, w), ["dry-run-missing"]);
  assert.deepEqual(
    checks({ dry: (t) => ((t.v += 1), ok('{"dry":true}')) }, w, { v: 0 }),
    ["dry-run-writes"],
  );
  assert.deepEqual(checks({ dry: () => ok("", 2, "unrecognized option") }, d), []);
});

test("a driver the skill does not name fails", () => {
  assert.deepEqual(checks({}, d, undefined, "the skill names nothing"), ["skill"]);
  assert.deepEqual(checks({}, d, undefined, "run d first"), []);
});

test("faults print as lines naming the driver and what to do", () => {
  const f = checkDrivers([d], env({ help: ok("", 2, "x") }));
  const lines = renderDriverFaults([d], f);
  assert.match(lines[0] ?? "", /1 fault\(s\) in 1 of 1/);
  assert.match(lines[1] ?? "", /^d \[help\]: .*Add a --help/);
});
