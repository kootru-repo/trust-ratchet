// SPDX-License-Identifier: AGPL-3.0-only
import { builtinName } from "./builtins.ts";
import type { Rule } from "./rules.ts";
import type { ProjectConfig } from "./state.ts";

/** Pure: a command without the values of environment settings written before it (`TOKEN=abc npm test`). */
export const redact = (command: string): string => command.replace(/(^|[\s;&|(])(--?[A-Za-z][A-Za-z0-9_-]*|[A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, "$1$2=…");

/**
 * Part C: the house rules to paste into a subagent's brief, from what Ratchet knows about the project. The turn end
 * of the session checks the same things, so a subagent that follows them does not hold its parent's turn. Values of
 * environment settings in commands are left out, since a brief is pasted into other prompts.
 */
export const briefText = ({ config, rules }: { config: ProjectConfig; rules: Rule[] }): string => {
  const checks = config.checks ?? [];
  const protectedPaths = checks.filter((c) => builtinName(c.command) === "protected").flatMap((c) => c.when ?? []);
  const generated = checks.filter((c) => builtinName(c.command) === "generated");
  const commands = checks.filter((c) => builtinName(c.command) === null);
  const lines = [
    "House rules for this repository (from Ratchet; paste them into a subagent's brief):",
    "- Write text files with LF line endings, never CR LF.",
    "- Write a unit test first, see it fail, then change the code.",
    "- Do not commit or push. Leave the changes for the session to review.",
    "- If a test finds a real bug you are not asked to fix, report the failing input; do not commit a failing test.",
  ];
  if (protectedPaths.length > 0) lines.push(`- Never change these recorded references: ${protectedPaths.join(", ")}. Only the person may allow a re-record.`);
  for (const g of generated) {
    if (!g.into) continue;
    const from = (g.when ?? []).length > 0 ? ` from ${(g.when ?? []).join(", ")}` : "";
    const how = g.build ? `: rebuild them with ${redact(g.build.split("{out}").join(g.into))} after changing the sources` : ": rebuild them after changing the sources";
    lines.push(`- Files under ${g.into} are built${from}${how}.`);
  }
  if (commands.length > 0) lines.push("- Before reporting, run these and fix what they report in your files:", ...commands.map((c) => `    ${c.name}: ${redact(c.command)}`));
  if (rules.length > 0) lines.push("- Project rules (a broken one fails the turn):", ...rules.map((r) => `    ${r.id}: ${r.message} Fix: ${r.fix}`));
  return lines.join("\n");
};
