// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import { test } from "node:test";
import { runPageProperty, type PageDriver, type PageInput, type PageProperty, type PageState } from "../src/harness/pageprops.ts";

/** A tiny in-memory counter page. The seeded bug: inc, type into the note, then Enter makes the count NaN. */
const fakePage = (opts: { bug: boolean; flaky?: boolean }): PageDriver & { closed: number; opens: number } => {
  let count = 0;
  let note = "";
  let last: PageInput[] = [];
  let nan = false;
  let hits = 0;
  const self = {
    closed: 0,
    opens: 0,
    async open() {
      self.opens++;
      count = 0;
      note = "";
      last = [];
      nan = false;
    },
    async act(i: PageInput) {
      last = [...last, i].slice(-3);
      if (i.kind === "click" && i.target === "inc") count++;
      if (i.kind === "click" && i.target === "dec") count--;
      if (i.kind === "key" && i.key === "r") count = 0;
      if (i.kind === "type") note = i.text;
      const [a, b, c] = last;
      if (opts.bug && a?.kind === "click" && a.target === "inc" && b?.kind === "type" && c?.kind === "key" && c.key === "Enter") {
        hits++;
        if (!opts.flaky || hits % 2 === 1) nan = true;
      }
    },
    async read(): Promise<PageState> {
      return { text: nan ? "NaN" : String(count), values: { note } };
    },
    async close() {
      self.closed++;
    },
  };
  return self;
};

const alphabet: PageInput[] = [
  { kind: "click", target: "inc" },
  { kind: "click", target: "dec" },
  { kind: "key", key: "r" },
  { kind: "key", key: "Enter" },
  { kind: "type", target: "note", text: "go" },
  { kind: "wait", ms: 1 },
];
const properties: PageProperty[] = [{ name: "count shows an integer", check: (s) => (/^-?\d+$/.test(s.text) ? null : `page shows "${s.text}"`) }];
const run = (driver: PageDriver, seed = 7, cases = 300) => runPageProperty({ seed, cases, alphabet, maxLen: 10, driver, properties });

test("the seeded 3-step bug is found, shrunk to 3 steps and replayed twice", async () => {
  const page = fakePage({ bug: true });
  const r = await run(page);
  assert.equal(r.status, "failed");
  assert.equal(r.counted, true);
  assert.equal(r.failure?.shrunk.length, 3);
  assert.deepEqual(r.failure?.shrunk.map((i) => i.kind), ["click", "type", "key"]);
  assert.equal(r.replay?.runs, 2);
  assert.equal(r.replay?.reproduced, true);
  assert.equal(r.failure?.seed, 7);
  assert.equal(page.closed, 1);
});

test("the clean page passes the same budget and the sequences are shown to be generated", async () => {
  const r = await run(fakePage({ bug: false }));
  assert.equal(r.status, "passed");
  assert.equal(r.generated.ok, true);
  assert.ok(r.generated.distinct >= 150);
});

test("a failure that shows once and does not replay is reported as flaky and not counted", async () => {
  const r = await run(fakePage({ bug: true, flaky: true }));
  assert.equal(r.status, "flaky");
  assert.equal(r.counted, false);
  assert.equal(r.replay?.reproduced, false);
});

test("a Doctor that is not ready makes the run inconclusive and runs nothing", async () => {
  const page = fakePage({ bug: true });
  const r = await runPageProperty({
    seed: 7,
    cases: 50,
    alphabet,
    maxLen: 10,
    driver: page,
    properties,
    doctor: async () => ({ ready: false, reasons: [{ code: "port-foreign", message: "foreign server", fix: "x" }] }),
  });
  assert.equal(r.status, "inconclusive");
  assert.equal(page.opens, 0);
});

test("a one-item alphabet is not generated: inconclusive", async () => {
  const one: PageInput[] = [{ kind: "wait", ms: 1 }];
  const r = await runPageProperty({ seed: 1, cases: 30, alphabet: one, maxLen: 1, driver: fakePage({ bug: false }), properties });
  assert.equal(r.status, "inconclusive");
});
