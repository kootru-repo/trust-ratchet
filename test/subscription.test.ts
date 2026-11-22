// SPDX-License-Identifier: AGPL-3.0-only
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { subscriptionEnv } from "../src/subscription.ts";

test("subscription: no key or billing switch reaches a claude process Ratchet starts", () => {
  const env = { PATH: "p", HOME: "h", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", ANTHROPIC_BASE_URL: "u", CLAUDE_CODE_USE_BEDROCK: "1", OPENAI_API_KEY: "k", OPENROUTER_API_KEY: "k", anthropic_api_key: "k" };
  assert.deepEqual(subscriptionEnv(env), { PATH: "p", HOME: "h" });
});

test("subscription: every claude process in src starts with the subscription environment", () => {
  const dir = path.resolve(import.meta.dirname, "..", "src");
  const files = fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    if (/spawn(Sync)?\(\s*["']claude["']|execFile(Sync)?\(\s*["']claude["']/.test(text)) assert.match(text, /subscriptionEnv\(process\.env\)/, `${f} starts claude with the whole environment`);
  }
});
