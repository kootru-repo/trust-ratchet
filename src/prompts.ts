// SPDX-License-Identifier: AGPL-3.0-only
import type { Context } from "./context.ts";
import { numbered } from "./context.ts";
import type { Specialist } from "./plan.ts";
import type { Patch } from "./history.ts";
import type { Check, Fact } from "./types.ts";

const factsBlock = (facts: Fact[]): string => {
  const ran = facts.filter((f) => f.ran !== false);
  const broken = facts.filter((f) => f.ran === false);
  if (facts.length === 0) return "No deterministic checks were run on this tree.";
  return [
    ...ran.map((f) => `- \`${f.command}\` ${f.exitCode === 0 ? "passed" : `reported problems:\n${f.tail}`}`),
    ...broken.map((f) => `- \`${f.command}\` could not run on this tree. It tells you nothing.`),
  ].join("\n");
};

const RULES = `Rules that apply to everything you output:
- You may only read files (Read, Grep, Glob) inside the current working directory. Do not try to run code.
- Every item needs "file" (path relative to the working directory, forward slashes), "line" (1-based) and "quote" (text copied exactly from that line, one line, at least 6 characters). A program checks each quote against the file. An item whose quote does not match is thrown away, so copy, never paraphrase.
- Report only behaviour that is wrong for a user or caller. No style, naming, formatting, performance or "could be cleaner" remarks.
- End your reply with one fenced json block and nothing after it.`;

const patchBlock = (patch: Patch | undefined, showMessage: boolean): string =>
  !patch
    ? ""
    : `\nThis is a review of a change. The diff below was just applied to this file. Judge the changed lines and the code they affect; a problem that was already there and that the change does not touch is not your concern.\n${
        showMessage ? `\nThe author's commit message (it may be wrong or incomplete; check the code against it):\n${patch.message}\n` : ""
      }\nDiff:\n\`\`\`diff\n${patch.diff.trim()}\n\`\`\`\n`;

const usesBlock = (context: Context): string => {
  const uses = context.uses ?? [];
  const imports = context.imports ?? [];
  return [
    uses.length ? `Where it is used (lines found by a program; they show where to look, not what the surrounding code does):\n${uses.map((u) => `  ${u.file}:${u.line}  ${u.text}`).join("\n")}` : "",
    imports.length ? `Files in this codebase that it imports: ${imports.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
};

/** What a reviewer is told when reading other files is required. `rejected` is set on the second attempt. */
export type ReadRule = { required: number; rejected?: string };

const readStep = (rule: ReadRule | undefined, file: string): string =>
  !rule || rule.required === 0
    ? ""
    : `\n6. Reading other files is required, and a program checks it. Before you answer, open at least ${rule.required} file${rule.required === 1 ? "" : "s"} other than ${file} with the Read tool: a caller listed above, or a file it imports. Read the code around each use, enough to know what values really arrive and what the callee really returns. List them in "read", one entry per file, each with a line you opened that is NOT already printed in this prompt, and what you learned from it. The program checks each quote against the file and checks that you opened the file. A review that fails this check is thrown away.${
        rule.rejected ? `\n\nAn earlier attempt at this same review was thrown away for this reason: ${rule.rejected}. Open the files this time.` : ""
      }`;

export const specialistPrompt = ({ specialist, file, context, facts, language, patch, messageToAll, read, addenda }: { specialist: Specialist; file: string; context: Context; facts: Fact[]; language: string; patch?: Patch; messageToAll?: boolean; read?: ReadRule; /** Optional blocks (budget, owners' notes, ruled false alarms). Empty unless an option asks for them. */ addenda?: string }): string =>
  `You are one of several code reviewers working in parallel on a ${language} codebase. Each reviewer has one focus. Yours is: ${specialist.focus}.

Look only for this class of problem: ${specialist.lookFor}.
Other reviewers cover the other classes. Do not report outside your focus.

File under review: ${file} (package folder: ${context.pkg})
Files that import it: ${context.importers.length ? context.importers.join(", ") : "none found"}
${usesBlock(context)}

Results of deterministic checks (facts, not opinions):
${factsBlock(facts)}
${patchBlock(patch, specialist.id === "intent" || messageToAll === true)}${addenda ?? ""}
How to work:
1. Read the file below. For anything suspicious, read the code it depends on and the code that calls it before deciding. The changed lines are never judged in isolation.
2. Keep two lists. "concerns": problems you believe are real. "dismissed": things that looked wrong and that you ruled out.
3. For each dismissal say how you ruled it out. "proof": "local" means the code you cite proves it is safe. "proof": "assumed" means you are relying on a caller, a guard or a guarantee you did not read. Be honest: an assumed dismissal gets a second look, a wrongly "local" one hides a bug.
4. Do not stop at the first problem. Finish the file.
5. At most 4 concerns and 6 dismissals. Prefer the ones most likely to be real.${readStep(read, file)}

${RULES}

Reply format:
\`\`\`json
{
  "concerns": [{ "title": "", "severity": "critical|major|minor", "file": "", "line": 0, "quote": "", "reasoning": "" }],
  "dismissed": [{ "title": "", "file": "", "line": 0, "quote": "", "proof": "local|assumed", "reasoning": "" }]${read && read.required > 0 ? `,
  "read": [{ "file": "", "line": 0, "quote": "", "learned": "" }]` : ""}
}
\`\`\`

${file}:
${numbered(context.content)}
`;

export const verifierPrompt = ({ check, facts, language, addenda }: { check: Check; facts: Fact[]; language: string; addenda?: string }): string =>
  `You are verifying one claim about a ${language} codebase. You did not write the claim. Your only job is to settle it with code.

${
  check.origin === "concern"
    ? `A reviewer claims this is a bug:`
    : check.origin === "dismissal"
      ? `A reviewer noticed this, then dismissed it on an assumption they did not check. Decide whether it is in fact a bug:`
      : `A reviewer noticed this, then dismissed it and said the code it had read proves it safe. Nobody checked that. Decide whether it is in fact a bug:`
}
Title: ${check.title}
Location: ${check.cite.file}:${check.cite.line}
Quoted line: ${check.cite.quote}
Reviewer's reasoning: ${check.claim}

Results of deterministic checks (facts, not opinions):
${factsBlock(facts)}
${addenda ?? ""}
The rule is symmetrical. Neither "it is a bug" nor "it is fine" is accepted without code that proves it.
- To confirm: show the concrete input or state that reaches the line and the wrong result that follows. Read the callers. If every call site rules the bad input out, it is not a bug.
- To refute: cite the code that makes it safe (the guard, the type, the caller) at every call site that matters.
- If you cannot prove either way with code you have read, the verdict is "unproven". Do not guess.

"guard" is the cheapest deterministic check that would catch this whole class of problem next time without a model: a lint rule, a stricter type, or a unit test (name the function and the input). Give one whether you confirm or refute.

Rules that apply to your output:
- You may only read files (Read, Grep, Glob) inside the current working directory. Do not try to run code.
- "proof" needs at least one entry. Each entry has "file", "line" and "quote" copied exactly from that line (one line, at least 6 characters). A program checks every quote. If any quote fails to match, your verdict is discarded and recorded as unproven.
- End your reply with one fenced json block and nothing after it.

Reply format:
\`\`\`json
{
  "verdict": "confirmed|refuted|unproven",
  "explanation": "",
  "callSites": ["path:line of each call site you read"],
  "proof": [{ "file": "", "line": 0, "quote": "" }],
  "guard": ""
}
\`\`\`
`;
