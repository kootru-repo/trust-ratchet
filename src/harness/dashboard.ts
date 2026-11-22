// SPDX-License-Identifier: AGPL-3.0-only
/**
 * One page for every project the autonomous loop runs in: the verification level, each requirement met or not, the
 * trend of the assessments and what the loop changed. Pure: it renders what it is given and reads nothing.
 */
export type DashProject = { root: string; last: Record<string, unknown>; history: Record<string, unknown>[]; level: string; changes?: string; evidence?: string; warning?: string };

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** The level over the assessments, as a small step line. */
const trend = (history: Record<string, unknown>[]): string => {
  // A level under another scheme is another measure and is not drawn on the same line.
  const scheme = history[history.length - 1]?.scheme;
  const points = history.filter((h) => h.scheme === scheme).slice(-60).map((h) => num(h.level));
  if (points.length < 2) return "";
  const w = 240;
  const h = 44;
  const x = (i: number): number => 4 + (i * (w - 8)) / (points.length - 1);
  const y = (v: number): number => h - 6 - (v * (h - 12)) / 5;
  const d = points.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="level over the last ${points.length} assessments"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
};

const card = (p: DashProject): string => {
  const lines = p.level.split("\n");
  const reqs = lines.filter((l) => /^\s*\[[x ]\]/.test(l) || /^Level \d/.test(l));
  const next = lines.find((l) => l.startsWith("To reach level")) ?? "";
  return [
    `<section class="card">`,
    `<h2>${esc(p.root)}</h2>`,
    p.warning ? `<p class="next"><strong>${esc(p.warning)}</strong></p>` : "",
    `<p class="level"><span class="n">${num(p.last.level)}</span> ${esc(text(p.last.name) || "not assessed")}</p>`,
    `<p class="facts">${num(p.last.met)} of ${num(p.last.of)} requirements met. ${num(p.last.rules)} rules (${num(p.last.trial)} on trial), ${num(p.last.tests)} mapped tests, ${num(p.last.watched)} of ${num(p.last.folders)} source folders watched. Assessed ${p.history.length} time(s), last ${esc(text(p.last.time))}.</p>`,
    trend(p.history),
    `<ul class="reqs">${reqs.map((l) => (/^Level/.test(l) ? `<li class="head">${esc(l)}</li>` : `<li class="${l.includes("[x]") ? "met" : "open"}">${esc(l.replace(/^\s*\[[x ]\]\s*/, ""))}</li>`)).join("")}</ul>`,
    next ? `<p class="next">${esc(next)}</p>` : "",
    p.evidence ? `<h3>Rules, what was acted on, and the measure checked against what followed</h3><pre>${esc(p.evidence)}</pre>` : "",
    p.changes ? `<h3>What the harness changed or noted by itself</h3><pre>${esc(p.changes)}</pre>` : "",
    `</section>`,
  ].join("\n");
};

export const renderDashboard = ({ projects, now }: { projects: DashProject[]; now: string }): string =>
  [
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ratchet levels</title>`,
    `<style>`,
    `:root{--bg:#f6f5f1;--fg:#1c1b19;--muted:#6b6862;--card:#ffffff;--line:#dedbd3;--ok:#1f7a4d;--no:#a4462b}`,
    `@media (prefers-color-scheme: dark){:root{--bg:#161614;--fg:#ecebe6;--muted:#a09d95;--card:#1f1f1c;--line:#34332f;--ok:#58c28c;--no:#e08a6c}}`,
    `body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}`,
    `main{max-width:860px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0;word-break:break-all}h3{font-size:14px;margin:16px 0 4px}`,
    `.note{color:var(--muted);margin:0 0 20px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:0 0 16px}`,
    `.level{font-size:18px;margin:6px 0}.level .n{font-size:34px;font-weight:700;margin-right:6px}.facts,.next{color:var(--muted);margin:4px 0}`,
    `.reqs{list-style:none;padding:0;margin:10px 0}.reqs li{padding:2px 0 2px 22px;position:relative}.reqs .head{padding-left:0;font-weight:600;margin-top:8px}`,
    `.reqs .met::before{content:"\\2713";position:absolute;left:2px;color:var(--ok)}.reqs .open::before{content:"\\2717";position:absolute;left:2px;color:var(--no)}`,
    `pre{white-space:pre-wrap;word-break:break-word;font:12px/1.45 ui-monospace,monospace;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:10px;max-height:320px;overflow:auto}svg{color:var(--muted);max-width:100%}`,
    `</style></head><body><main>`,
    `<h1>Ratchet verification levels</h1>`,
    `<p class="note">A level says how much checking a project has been shown to have, computed from the harness's own records. It does not say the code is right. Written ${esc(now)}.</p>`,
    projects.length === 0 ? `<p>No project has been assessed yet. Switch the loop on with: ratchet auto --on</p>` : projects.map(card).join("\n"),
    `</main></body></html>`,
  ].join("\n");
