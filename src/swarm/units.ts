// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

/**
 * A store of the sentences of a document, each with the context a program derives from the document's own structure, and the verdicts passes give them.
 * Completion is a query ("no unit without a verdict"); a model is never asked to enumerate, only to judge what it is handed, and the context it is handed is computed, not chosen.
 */
export type Unit = {
  id: string;
  item: string;
  ord: number;
  text: string;
  /** Headings above the unit, outermost first, joined by " > ". */
  headingPath: string;
  kind: "paragraph" | "list" | "table" | "quote";
  /** The whole paragraph, list item or table row the sentence sits in. */
  blockText: string;
  /** For a list item: the line that introduces the list, and the item it is nested under. For a table row: the header row. Else empty. */
  leadIn: string;
  /** True when the sentence opens with a word that points back (this, these, it, such, the above...): its context is widened. */
  refStart: boolean;
};

export type Verdict = { unit: string; pass: string; model: string; enforceable: boolean; how: string };

const REF_START = /^(this|that|these|those|it|its|they|their|such|the above|the following|the same|same|also|then|otherwise|instead|else|but|however|so|and|or|both|either|neither|each|doing so|do so)\b/i;
const sentenceSplit = (s: string): string[] => s.split(/(?<=[.!?])\s+(?=[A-Z`*(\d])/);

export const unitId = (item: string, text: string): string => createHash("sha1").update(`${item}\n${text.replace(/\s+/g, " ").trim()}`).digest("hex").slice(0, 12);

/** Pure: the units of a markdown document, in order, each with its structural context. The same text always gives the same units. */
export const unitsOf = (item: string, markdown: string): Unit[] => {
  const lines = markdown.split(/\r?\n/);
  let from = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) from = end + 1;
  }
  const out: Unit[] = [];
  const headings: { level: number; text: string }[] = [];
  let lastParagraph = "";
  let tableHeader = "";
  let inFence = false;
  const stack: { indent: number; text: string }[] = [];
  const seen = new Set<string>();
  const add = (sentence: string, kind: Unit["kind"], block: string, leadIn: string): void => {
    const text = sentence.trim();
    if (text.length < 10) return;
    const id = unitId(item, text);
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, item, ord: out.length, text, headingPath: headings.map((h) => h.text).join(" > "), kind, blockText: block.trim(), leadIn: leadIn.trim(), refStart: REF_START.test(text) });
  };
  for (const raw of lines.slice(from)) {
    const t = raw.trim();
    if (t.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || t === "") {
      if (t === "") {
        tableHeader = "";
        stack.length = 0;
      }
      continue;
    }
    const h = /^(#+)\s+(.*)$/.exec(t);
    if (h) {
      const level = (h[1] ?? "#").length;
      while (headings.length > 0 && (headings[headings.length - 1]?.level ?? 0) >= level) headings.pop();
      headings.push({ level, text: (h[2] ?? "").trim() });
      lastParagraph = "";
      stack.length = 0;
      continue;
    }
    if (/^\|?[\s:|-]+\|?$/.test(t) && t.includes("-")) continue;
    if (t.startsWith("|")) {
      if (tableHeader === "") {
        tableHeader = t;
        continue;
      }
      for (const cell of t.split("|").map((c) => c.trim()).filter((c) => c !== "")) for (const s of sentenceSplit(cell)) add(s, "table", t, tableHeader);
      continue;
    }
    const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(raw);
    if (li) {
      const indent = (li[1] ?? "").length;
      while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) >= indent) stack.pop();
      const parent = stack.map((p) => p.text).join(" / ");
      const body = li[3] ?? "";
      for (const s of sentenceSplit(body)) add(s, "list", body, [lastParagraph, parent].filter((x) => x !== "").join(" // "));
      stack.push({ indent, text: body.slice(0, 160) });
      continue;
    }
    const quote = t.startsWith(">");
    const body = quote ? t.replace(/^>\s*/, "") : t;
    for (const s of sentenceSplit(body)) add(s, quote ? "quote" : "paragraph", body, "");
    lastParagraph = body.slice(0, 200);
  }
  return out;
};

/** Pure: what a judge is shown for one unit. Everything here is computed from the document; nothing is chosen. */
export const contextFor = (u: Unit, all: Unit[]): string => {
  const at = all.findIndex((x) => x.id === u.id);
  const back = u.refStart ? 3 : 2;
  const prev = all.slice(Math.max(0, at - back), at).map((x) => x.text);
  const next = all.slice(at + 1, at + 3).map((x) => x.text);
  const parts = [`FILE ITEM: ${u.item}`, `SECTION: ${u.headingPath || "(top)"}`];
  if (u.leadIn) parts.push(`${u.kind === "table" ? "TABLE HEADER" : "INTRODUCED BY"}: ${u.leadIn}`);
  if (u.blockText && u.blockText !== u.text) parts.push(`WHOLE ${u.kind.toUpperCase()}: ${u.blockText}`);
  if (prev.length > 0) parts.push(`SENTENCES BEFORE: ${prev.join(" | ")}`);
  if (next.length > 0) parts.push(`SENTENCES AFTER: ${next.join(" | ")}`);
  parts.push(`THE SENTENCE TO JUDGE: ${u.text}`);
  return parts.join("\n");
};

/** The store. A unit is written once, by id; a verdict once per unit and pass; writing either again changes nothing. */
export class UnitStore {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`create table if not exists units (id text primary key, item text not null, ord integer not null, text text not null, heading_path text not null, kind text not null, block_text text not null, lead_in text not null, ref_start integer not null);
      create table if not exists verdicts (unit text not null, pass text not null, model text not null, enforceable integer not null, how text not null, at text not null, primary key (unit, pass));`);
  }
  load(units: Unit[]): number {
    const ins = this.db.prepare("insert or ignore into units (id, item, ord, text, heading_path, kind, block_text, lead_in, ref_start) values (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    let n = 0;
    for (const u of units) n += Number(ins.run(u.id, u.item, u.ord, u.text, u.headingPath, u.kind, u.blockText, u.leadIn, u.refStart ? 1 : 0).changes);
    return n;
  }
  unit(id: string): Unit | undefined {
    const r = this.db.prepare("select * from units where id = ?").get(id);
    return r ? rowUnit(r) : undefined;
  }
  unitsOfItem(item: string): Unit[] {
    return this.db.prepare("select * from units where item = ? order by ord").all(item).map(rowUnit);
  }
  /** The next units of a pass that have no verdict, in the fixed order (item, ord). */
  pending(pass: string, limit: number, item?: string): Unit[] {
    const rows = item === undefined ? this.db.prepare("select * from units u where not exists (select 1 from verdicts v where v.unit = u.id and v.pass = ?) order by item, ord limit ?").all(pass, limit) : this.db.prepare("select * from units u where item = ? and not exists (select 1 from verdicts v where v.unit = u.id and v.pass = ?) order by ord limit ?").all(item, pass, limit);
    return rows.map(rowUnit);
  }
  record(v: Verdict): boolean {
    const known = this.db.prepare("select 1 as x from units where id = ?").get(v.unit);
    if (!known) return false;
    return Number(this.db.prepare("insert or ignore into verdicts (unit, pass, model, enforceable, how, at) values (?, ?, ?, ?, ?, ?)").run(v.unit, v.pass, v.model, v.enforceable ? 1 : 0, v.how, new Date().toISOString()).changes) === 1;
  }
  /** Completion, by query: how many units of an item still lack a verdict in a pass. Zero is the only done. */
  missing(pass: string, item?: string): number {
    const r = item === undefined ? this.db.prepare("select count(*) as n from units u where not exists (select 1 from verdicts v where v.unit = u.id and v.pass = ?)").get(pass) : this.db.prepare("select count(*) as n from units u where item = ? and not exists (select 1 from verdicts v where v.unit = u.id and v.pass = ?)").get(item, pass);
    return Number((r as { n: number } | undefined)?.n ?? 0);
  }
  enforceable(pass: string, item: string): string[] {
    return this.db.prepare("select u.id as id from units u join verdicts v on v.unit = u.id where u.item = ? and v.pass = ? and v.enforceable = 1 order by u.ord").all(item, pass).map((r) => String((r as { id: string }).id));
  }
  /** Units one pass called enforceable and another did not: the ones an adjudicator is shown. */
  disagreements(passA: string, passB: string): string[] {
    return this.db.prepare("select a.unit as id from verdicts a join verdicts b on a.unit = b.unit where a.pass = ? and b.pass = ? and a.enforceable != b.enforceable order by a.unit").all(passA, passB).map((r) => String((r as { id: string }).id));
  }
  union(passes: string[], item: string): string[] {
    const marks = passes.map(() => "?").join(",");
    return this.db.prepare(`select distinct u.id as id from units u join verdicts v on v.unit = u.id where u.item = ? and v.enforceable = 1 and v.pass in (${marks}) order by u.ord`).all(item, ...passes).map((r) => String((r as { id: string }).id));
  }
  close(): void {
    this.db.close();
  }
}

const rowUnit = (r: unknown): Unit => {
  const x = r as { id: string; item: string; ord: number; text: string; heading_path: string; kind: Unit["kind"]; block_text: string; lead_in: string; ref_start: number };
  return { id: x.id, item: x.item, ord: x.ord, text: x.text, headingPath: x.heading_path, kind: x.kind, blockText: x.block_text, leadIn: x.lead_in, refStart: x.ref_start === 1 };
};
