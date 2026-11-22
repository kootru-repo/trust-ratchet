import type { Checked, ReviewResult } from "./types.ts";

const item = (c: Checked, question = false): string =>
  [
    `### ${question ? `Is this intended? ${c.title}` : c.title}`,
    `- Where: \`${c.cite.file}:${c.cite.line}\`: \`${c.cite.quote.trim()}\``,
    `- Raised by: ${c.specialist}${c.origin === "dismissal" ? " (first dismissed on an unchecked assumption, then promoted)" : ""}; severity ${c.severity}`,
    `- Verifier: ${c.explanation || "no explanation"}`,
    ...(c.downgraded ? [`- Harness: ${c.downgraded}`] : []),
    ...(c.verdict === "confirmed"
      ? [
          `- Reproduction: ${
            !c.repro
              ? "not run. This finding is argued, not executed."
              : c.repro.status === "reproduced"
                ? "REPRODUCED. A test of the correct behaviour ran and failed on an assertion."
                : c.repro.status === "test-passed"
                  ? "A test of the claim PASSED. Treat this finding with suspicion."
                  : c.repro.status === "test-broken"
                    ? "A test was written but never reached an assertion. Argued only."
                    : `No test attempted: ${c.repro.reason}`
          }`,
        ]
      : []),
    ...(c.proof.length ? [`- Proof: ${c.proof.map((p) => `\`${p.file}:${p.line}\``).join(", ")}`] : []),
    ...(c.callSites.length ? [`- Call sites read: ${c.callSites.join(", ")}`] : []),
    ...(c.guard ? [`- Deterministic guard to add: ${c.guard}`] : []),
  ].join("\n");

/** A report for a human. Only verified findings are stated as findings. Everything else is shown as what it is. */
export const renderReport = (r: ReviewResult, { questions = false }: { /** S8: put confirmed findings to the author as questions. Wording only; what is shown is the same. */ questions?: boolean } = {}): string => {
  const by = (v: Checked["verdict"]): Checked[] => r.checked.filter((c) => c.verdict === v);
  const confirmed = by("confirmed");
  const unproven = by("unproven");
  const refuted = by("refuted");
  const failedFacts = r.facts.filter((f) => f.exitCode !== 0);
  return [
    `# Ratchet review: ${r.file}`,
    "",
    `Specialists: ${r.specialists.join(", ")}. Candidates raised: ${r.candidates.length}. Dismissals recorded: ${r.dismissals.length}. Sent to a verifier: ${r.checked.length}. Model calls: ${r.modelCalls}.`,
    "",
    "## Deterministic checks",
    r.facts.length === 0 ? "None were run." : r.facts.map((f) => `- \`${f.command}\`: ${f.exitCode === 0 ? "pass" : `FAILED (exit ${f.exitCode})`}`).join("\n"),
    ...(failedFacts.length ? ["", "Fix these first. A failing type check or test is a fact, and it outranks every finding below."] : []),
    "",
    questions ? `## Questions for the author, each backed by quoted code (${confirmed.length})` : `## Confirmed (${confirmed.length})`,
    confirmed.length ? `${questions ? "A verifier confirmed each of these with code it quoted. They are put as questions because only the author knows what was meant.\n\n" : ""}${confirmed.map((c) => item(c, questions)).join("\n\n")}` : "Nothing was confirmed. That is not proof the file is correct: see the benchmark for how often a real bug is missed.",
    "",
    `## Open questions (${unproven.length})`,
    unproven.length ? `Neither proven nor disproven with code. Treat these as questions for the author, not as bugs.\n\n${unproven.map((c) => item(c)).join("\n\n")}` : "None.",
    "",
    `## Refuted (${refuted.length})`,
    refuted.length ? refuted.map((c) => item(c)).join("\n\n") : "None.",
    "",
    `## Not verified (${r.unchecked.length})`,
    r.unchecked.length ? r.unchecked.map((c) => `- \`${c.cite.file}:${c.cite.line}\` ${c.title} (${c.specialist})`).join("\n") : "None. Every surviving candidate was checked.",
    "",
    `## Dropped before verification (${r.dropped.length})`,
    r.dropped.length ? r.dropped.map((d) => `- ${d.title} (${d.specialist}): ${d.reason}`).join("\n") : "None.",
    ...(r.errors.length ? ["", "## Errors", ...r.errors.map((e) => `- ${e}`)] : []),
    "",
  ].join("\n");
};
