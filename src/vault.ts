import fs from "node:fs";
import path from "node:path";
import { hashText, ident, uuidFrom } from "./ident.ts";
import type { Checked, ReviewResult } from "./types.ts";

/**
 * Writes review results into an Obsidian vault as Discourse Graphs notes, and reads a person's rulings back.
 * The vault records and informs. It never enforces anything: that is the job of checks that are code.
 *
 * Folders written by this program: Findings, Proof, Runs, plus Dashboard.md and relations.json.
 * Folders written by a person: Rulings (a stub is created once, then never touched again), Guides, Features.
 */

export type Schema = { nodeTypes: { id: string; name: string; format: string }[]; relationTypes: { id: string; label: string }[] };
export type RunMeta = { target: string; commit: string; model: string; when: string };
export type Ruling = { finding: string; ruling: "real" | "false-alarm" | "wont-fix" | ""; note: string };
type Relation = { id: string; source: string; destination: string; type: string; created: number; lastModified: number };
type RelationFile = { version: number; lastModified: number; relations: Record<string, Relation> };

const HARNESS_DIRS = ["Findings", "Proof", "Runs"];
const PERSON_DIRS = ["Rulings", "Guides", "Features"];

export const loadSchema = (vault: string): Schema => JSON.parse(fs.readFileSync(path.join(vault, "Meta", "dg-schema.json"), "utf8")) as Schema;

const nodeType = (schema: Schema, name: string): { id: string; format: string } => {
  const found = schema.nodeTypes.find((n) => n.name === name);
  if (!found) throw new Error(`the vault schema has no node type "${name}"`);
  return found;
};
const relType = (schema: Schema, label: string): string => {
  const found = schema.relationTypes.find((r) => r.label === label);
  if (!found) throw new Error(`the vault schema has no relation "${label}"`);
  return found.id;
};

/** A file name Obsidian and Windows both accept. */
export const safeName = (s: string): string =>
  s
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 110)
    .trim();

const yaml = (v: unknown): string => (Array.isArray(v) ? `[${v.map((x) => JSON.stringify(String(x))).join(", ")}]` : typeof v === "number" ? String(v) : JSON.stringify(String(v)));

export const readNote = (file: string): { front: Record<string, string>; body: string } => {
  const text = fs.readFileSync(file, "utf8");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { front: {}, body: text };
  const front: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv && kv[1]) front[kv[1]] = (kv[2] ?? "").trim().replace(/^"(.*)"$/, "$1");
  }
  return { front, body: m[2] ?? "" };
};

const notesIn = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => path.join(dir, f)) : []);

export type WriteOutcome = "written" | "unchanged" | "hand-edited";

/**
 * Writes a harness-owned note. The body's hash is stored in the note. If the body on disk no longer matches its hash,
 * a person has edited a note that is not theirs to edit: it is left alone and reported.
 */
export const writeNote = ({ dir, name, key, front, body }: { dir: string; name: string; key: string; front: Record<string, unknown>; body: string }): { file: string; outcome: WriteOutcome } => {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  const old = notesIn(dir).find((f) => readNote(f).front.ratchet_key === key);
  if (old) {
    const prior = readNote(old);
    if (prior.front.ratchet_hash && prior.front.ratchet_hash !== hashText(prior.body)) return { file: old, outcome: "hand-edited" };
  }
  const full = { ...front, ratchet_key: key, ratchet_hash: hashText(body) };
  const text = `---\n${Object.entries(full)
    .map(([k, v]) => `${k}: ${yaml(v)}`)
    .join("\n")}\n---\n${body}`;
  if (old && old === file && fs.readFileSync(old, "utf8") === text) return { file, outcome: "unchanged" };
  // The title carries the status, so a finding that changes status changes file name. Remove the old file.
  if (old && old !== file) fs.rmSync(old);
  fs.writeFileSync(file, text);
  return { file, outcome: "written" };
};

const link = (name: string): string => `[[${name}]]`;
const quoteBlock = (s: string): string => "```\n" + s.trim() + "\n```";

const findingName = (schema: Schema, c: Checked): string => {
  const type = nodeType(schema, c.verdict === "confirmed" ? "Claim" : "Hypothesis");
  return safeName(type.format.replace("{content}", `${c.title} (${ident(c.cite)})`));
};

export type SyncReport = { written: number; unchanged: number; handEdited: string[]; rulings: Ruling[] };

export const initVault = ({ vault, schemaFrom }: { vault: string; schemaFrom: string }): void => {
  for (const d of [...HARNESS_DIRS, ...PERSON_DIRS, "Meta"]) fs.mkdirSync(path.join(vault, d), { recursive: true });
  fs.copyFileSync(schemaFrom, path.join(vault, "Meta", "dg-schema.json"));
  const readme = path.join(vault, "README.md");
  if (!fs.existsSync(readme))
    fs.writeFileSync(
      readme,
      [
        "# Ratchet review vault",
        "",
        "Written by the harness. Do not edit: `Findings/`, `Proof/`, `Runs/`, `Dashboard.md`, `relations.json`.",
        "Written by you: `Rulings/`, `Guides/`, `Features/`.",
        "",
        "To rule on a finding, open its note in `Rulings/` and set `ruling:` to `real`, `false-alarm` or `wont-fix`. Add your reason under the line.",
        "Then run `npm run vault -- sync <this folder>` to refresh the dashboard.",
        "",
      ].join("\n"),
    );
};

export const readRulings = (vault: string): Ruling[] =>
  notesIn(path.join(vault, "Rulings")).flatMap((f) => {
    const { front, body } = readNote(f);
    if (!front.finding) return [];
    const r = (front.ruling ?? "").toLowerCase();
    return [{ finding: front.finding, ruling: r === "real" || r === "false-alarm" || r === "wont-fix" ? r : "", note: body.trim() }];
  });

/** Precision so far: of the findings a person has ruled on, how many were real. wont-fix counts as real. */
export const precision = (rulings: Ruling[]): { real: number; falseAlarm: number; unruled: number; value: number | null } => {
  const real = rulings.filter((r) => r.ruling === "real" || r.ruling === "wont-fix").length;
  const falseAlarm = rulings.filter((r) => r.ruling === "false-alarm").length;
  return { real, falseAlarm, unruled: rulings.filter((r) => r.ruling === "").length, value: real + falseAlarm === 0 ? null : real / (real + falseAlarm) };
};

const reproLine = (c: Checked): string =>
  !c.repro
    ? "argued only (no test was run)"
    : c.repro.status === "reproduced"
      ? `reproduced by a failing test${c.repro.afterFix ? `; after the real fix the test ${c.repro.afterFix}` : ""}`
      : c.repro.status === "test-passed"
        ? "a test of the claim PASSED, which speaks against it"
        : c.repro.status === "test-broken"
          ? "a test was written but never reached an assertion"
          : `no test attempted: ${c.repro.reason}`;

/** Writes one review into the vault. Safe to run again: the same input writes nothing new. */
export const writeReview = ({ vault, review, meta }: { vault: string; review: ReviewResult; meta: RunMeta }): SyncReport => {
  const schema = loadSchema(vault);
  const report: SyncReport = { written: 0, unchanged: 0, handEdited: [], rulings: [] };
  const relations: Relation[] = [];
  const now = Date.parse(meta.when);
  const tally = (r: { file: string; outcome: WriteOutcome }): void => {
    if (r.outcome === "written") report.written += 1;
    else if (r.outcome === "unchanged") report.unchanged += 1;
    else report.handEdited.push(r.file);
  };
  const relate = (source: string, label: string, destination: string): void => {
    const id = uuidFrom(`${source}|${label}|${destination}`);
    relations.push({ id, source, destination, type: relType(schema, label), created: now, lastModified: now });
  };

  const runKey = `run:${meta.target}:${review.file}:${meta.when}`;
  const runId = uuidFrom(runKey);
  const runName = safeName(nodeType(schema, "Experiment").format.replace("{content}", `Review of ${path.basename(review.file)} at ${meta.commit.slice(0, 8)}, ${meta.when.slice(0, 16).replace("T", " ")}`));
  const noted = review.checked.filter((c) => c.verdict !== "refuted");

  for (const c of noted) {
    const id = ident(c.cite);
    const confirmed = c.verdict === "confirmed";
    const kind = confirmed ? "Claim" : "Hypothesis";
    const name = findingName(schema, c);
    const instance = uuidFrom(`finding:${meta.target}:${id}`);
    const proofName = safeName(nodeType(schema, "Evidence").format.replace("{content}", `Proof for ${id}, ${c.title}`));
    const proofId = uuidFrom(`proof:${meta.target}:${id}`);
    const rulingName = safeName(nodeType(schema, "Evidence").format.replace("{content}", `Ruling on ${id}`));

    tally(
      writeNote({
        dir: path.join(vault, "Findings"),
        name,
        key: `finding:${id}`,
        front: { nodeTypeId: nodeType(schema, kind).id, nodeInstanceId: instance, dg_type: kind, ratchet_kind: "finding", finding: id, target: meta.target, file: c.cite.file, line: c.cite.line, verdict: c.verdict, severity: c.severity, specialist: c.specialist, origin: c.origin, repro: c.repro?.status ?? "none", commit: meta.commit, last_seen: meta.when },
        body: [
          `# ${c.title}`,
          "",
          `- Where: \`${c.cite.file}:${c.cite.line}\` in ${meta.target} at \`${meta.commit.slice(0, 8)}\``,
          `- Status: ${confirmed ? "confirmed by a verifier" : "open question, neither proven nor disproven"}; ${reproLine(c)}`,
          `- Raised by: ${c.specialist}${c.origin === "dismissal" ? " (first dismissed on an unchecked assumption, then promoted)" : ""}`,
          `- Proof: ${link(proofName)}`,
          `- Your ruling: ${link(rulingName)}`,
          `- Run: ${link(runName)}`,
          "",
          quoteBlock(c.cite.quote),
          "",
          c.explanation || c.claim,
          ...(c.downgraded ? ["", `Harness note: ${c.downgraded}`] : []),
          ...(c.guard ? ["", "## Guard to add", c.guard] : []),
          "",
        ].join("\n"),
      }),
    );

    tally(
      writeNote({
        dir: path.join(vault, "Proof"),
        name: proofName,
        key: `proof:${id}`,
        front: { nodeTypeId: nodeType(schema, "Evidence").id, nodeInstanceId: proofId, dg_type: "Evidence", ratchet_kind: "proof", finding: id },
        body: [
          `# Proof for ${link(name)}`,
          "",
          "Every quote below was checked by a program against the tree under review.",
          "",
          ...c.proof.flatMap((p) => [`\`${p.file}:${p.line}\``, quoteBlock(p.quote), ""]),
          ...(c.callSites.length ? ["Call sites the verifier read:", ...c.callSites.map((s) => `- \`${s}\``), ""] : []),
          ...(c.repro && c.repro.test ? [`## Reproduction: ${reproLine(c)}`, "", "```ts", c.repro.test.trim(), "```", "", "Output:", quoteBlock(c.repro.output || "(none)"), ""] : []),
        ].join("\n"),
      }),
    );
    relate(proofId, confirmed ? "supports" : "consistent with", instance);

    // A ruling stub is created once and then belongs to the person. It is never rewritten.
    const rulingFile = path.join(vault, "Rulings", `${rulingName}.md`);
    if (!notesIn(path.join(vault, "Rulings")).some((f) => readNote(f).front.finding === id)) {
      fs.mkdirSync(path.dirname(rulingFile), { recursive: true });
      fs.writeFileSync(rulingFile, `---\nnodeTypeId: ${yaml(nodeType(schema, "Evidence").id)}\nnodeInstanceId: ${yaml(uuidFrom(`ruling:${meta.target}:${id}`))}\ndg_type: "Evidence"\nratchet_kind: "ruling"\nfinding: ${yaml(id)}\nruling: ""\n---\nFinding: ${link(name)}\n\nSet \`ruling\` above to real, false-alarm or wont-fix. Write your reason here.\n`);
    }
  }

  tally(
    writeNote({
      dir: path.join(vault, "Runs"),
      name: runName,
      key: runKey,
      front: { nodeTypeId: nodeType(schema, "Experiment").id, nodeInstanceId: runId, dg_type: "Experiment", ratchet_kind: "run", target: meta.target, file: review.file, commit: meta.commit, model: meta.model, when: meta.when, model_calls: review.modelCalls, confirmed: review.checked.filter((c) => c.verdict === "confirmed").length, reproduced: review.checked.filter((c) => c.repro?.status === "reproduced").length },
      body: [
        `# Review of \`${review.file}\``,
        "",
        `Target ${meta.target} at \`${meta.commit}\`, model ${meta.model}, ${meta.when}.`,
        "",
        `Specialists: ${review.specialists.join(", ")}. Candidates raised: ${review.candidates.length}. Dismissals recorded: ${review.dismissals.length}. Verified: ${review.checked.length}. Not verified: ${review.unchecked.length}. Dropped: ${review.dropped.length}. Model calls: ${review.modelCalls}.`,
        "",
        "## Deterministic checks",
        review.facts.length ? review.facts.map((f) => `- \`${f.command}\`: ${f.exitCode === 0 ? "pass" : `FAILED (exit ${f.exitCode})`}`).join("\n") : "None were run.",
        "",
        "## Findings",
        ...(noted.length ? noted.map((c) => `- ${link(findingName(schema, c))}: ${c.verdict}; ${reproLine(c)}`) : ["None."]),
        "",
        "## Refuted",
        ...(review.checked.some((c) => c.verdict === "refuted") ? review.checked.filter((c) => c.verdict === "refuted").map((c) => `- \`${c.cite.file}:${c.cite.line}\` ${c.title}: ${c.explanation}`) : ["None."]),
        "",
      ].join("\n"),
    }),
  );
  for (const c of noted) relate(runId, "motivates", uuidFrom(`finding:${meta.target}:${ident(c.cite)}`));

  mergeRelations({ vault, add: relations.filter((r) => schemaAllows(r, noted, meta, schema)), now });
  const dash = syncVault(vault);
  return { ...report, rulings: dash.rulings };
};

/** Experiment -motivates-> Claim is in the schema; Experiment -> Hypothesis is not, so that link is left out. */
const schemaAllows = (r: Relation, noted: Checked[], meta: RunMeta, schema: Schema): boolean => {
  if (r.type !== relType(schema, "motivates")) return true;
  const hyp = new Set(noted.filter((c) => c.verdict !== "confirmed").map((c) => uuidFrom(`finding:${meta.target}:${ident(c.cite)}`)));
  return !hyp.has(r.destination);
};

const mergeRelations = ({ vault, add, now }: { vault: string; add: Relation[]; now: number }): void => {
  const file = path.join(vault, "relations.json");
  const data: RelationFile = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as RelationFile) : { version: 1, lastModified: now, relations: {} };
  let changed = false;
  for (const r of add) {
    if (data.relations[r.id]) continue;
    data.relations[r.id] = r;
    changed = true;
  }
  if (changed || !fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ ...data, lastModified: now }, null, 2));
};

/** Rebuilds Dashboard.md and the ruling relations from what is in the vault now. Run it after ruling on findings. */
export const syncVault = (vault: string): { rulings: Ruling[]; dashboard: string } => {
  const schema = loadSchema(vault);
  const findings = notesIn(path.join(vault, "Findings")).map((f) => ({ name: path.basename(f, ".md"), ...readNote(f).front }) as Record<string, string>);
  const rulings = readRulings(vault);
  const byFinding = new Map(rulings.map((r) => [r.finding, r]));
  const p = precision(rulings.filter((r) => findings.some((f) => f.finding === r.finding)));

  // A ruling is Evidence that supports or opposes the finding. Only findings that are Claims can take that relation.
  const add: Relation[] = [];
  for (const f of findings) {
    const r = byFinding.get(f.finding ?? "");
    if (!r || r.ruling === "" || f.dg_type !== "Claim" || !f.target || !f.nodeInstanceId) continue;
    const source = uuidFrom(`ruling:${f.target}:${f.finding}`);
    const label = r.ruling === "false-alarm" ? "opposes" : "supports";
    add.push({ id: uuidFrom(`${source}|${label}|${f.nodeInstanceId}`), source, destination: f.nodeInstanceId, type: relType(schema, label), created: Date.now(), lastModified: Date.now() });
  }
  if (add.length) mergeRelations({ vault, add, now: Date.now() });

  const confirmed = findings.filter((f) => f.verdict === "confirmed");
  const count = (xs: Record<string, string>[], f: (x: Record<string, string>) => boolean): number => xs.filter(f).length;
  const specialists = [...new Set(confirmed.flatMap((f) => (f.specialist ?? "").split("+")))].filter(Boolean).sort();
  const row = (f: Record<string, string>): string => `| ${link(f.name ?? "")} | \`${f.file}:${f.line}\` | ${f.severity} | ${f.specialist} | ${f.repro} | ${byFinding.get(f.finding ?? "")?.ruling || "none yet"} |`;
  const dashboard = [
    "# Ratchet dashboard",
    "",
    "Written by the harness. Do not edit. Refresh with `npm run vault -- sync <vault>`.",
    "",
    `- Trust level: 0, not yet trusted. ${p.value === null ? "Nothing has been ruled on." : "Rulings have started; no threshold has been set."} A reproduced finding means a model-written test failed on an assertion. The model also wrote the expectation, so it is evidence, not proof.`,
    `- Confirmed findings: ${confirmed.length}. Open questions: ${findings.length - confirmed.length}.`,
    `- Reproduced by a failing test: ${count(confirmed, (f) => f.repro === "reproduced")} of ${confirmed.length}. A test of the claim passed: ${count(confirmed, (f) => f.repro === "test-passed")}.`,
    `- Precision from your rulings: ${p.value === null ? "unknown, nothing ruled yet" : `${p.real} real of ${p.real + p.falseAlarm} ruled (${Math.round(100 * p.value)}%)`}. Waiting for a ruling: ${count(confirmed, (f) => !byFinding.get(f.finding ?? "")?.ruling)}.`,
    "",
    "## By specialist",
    "| specialist | confirmed | reproduced | ruled real | ruled false alarm |",
    "|---|---|---|---|---|",
    ...specialists.map((s) => {
      const mine = confirmed.filter((f) => (f.specialist ?? "").split("+").includes(s));
      const ruled = (v: string[]): number => count(mine, (f) => v.includes(byFinding.get(f.finding ?? "")?.ruling ?? ""));
      return `| ${s} | ${mine.length} | ${count(mine, (f) => f.repro === "reproduced")} | ${ruled(["real", "wont-fix"])} | ${ruled(["false-alarm"])} |`;
    }),
    "",
    "## Confirmed findings",
    "| finding | where | severity | raised by | reproduction | ruling |",
    "|---|---|---|---|---|---|",
    ...confirmed.sort((a, b) => (a.file ?? "").localeCompare(b.file ?? "") || Number(a.line) - Number(b.line)).map(row),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(vault, "Dashboard.md"), dashboard);
  return { rulings, dashboard };
};
