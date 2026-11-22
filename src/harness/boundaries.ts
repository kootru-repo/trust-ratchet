// SPDX-License-Identifier: AGPL-3.0-only
import fs from "node:fs";
import path from "node:path";
import { matchesAny, type Finding } from "./rules.ts";

/**
 * Row 5: directory structure as context, imports across a boundary forbidden.
 * `.ratchet/boundaries.json` names folders and the boundaries each may import from. A file belongs to the boundary
 * with the longest folder that holds it. Files in no boundary are free to import and be imported, except that a
 * bounded file reaching a forbidden boundary through them is caught as a two-step violation. `allowed` is the backlog
 * (T3): the violations that existed when the file was written. It may fall, never rise.
 */
export type Boundary = {
  name: string;
  /** Folder relative to the repository root, forward slashes. */
  folder: string;
  /** Names of boundaries this one may import from. Its own files are always allowed. */
  mayImportFrom: string[];
  /** Package names (an npm package, a Python top-level module) this boundary may not import. */
  banPackages?: string[];
};
export type BoundaryConfig = { boundaries: Boundary[]; /** Violation keys, see violationKey. */ allowed?: string[]; exclude?: string[] };

export type Violation = {
  file: string;
  /** The import as written. */
  spec: string;
  line: number;
  /** The file or package reached. */
  target: string;
  /** Files passed through before the target (a two-step violation), outside any boundary. */
  via: string[];
  from: string;
  to: string;
  allowedTo: string[];
  allowedFolders: string[];
};

export const BOUNDARY_FILE = ".ratchet/boundaries.json";
const JS_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const PY_EXT = /\.py$/;
const JS_TRY = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** Pure: what is wrong with a boundary file as written. */
export const boundaryProblems = (config: Partial<BoundaryConfig>): string[] => {
  const out: string[] = [];
  const bs = config.boundaries;
  if (!Array.isArray(bs) || bs.length === 0) return ["boundaries is missing"];
  const names = new Set<string>();
  for (const b of bs) {
    if (!b.name || !b.folder) out.push("a boundary needs a name and a folder");
    if (names.has(b.name)) out.push(`boundary ${b.name} is named twice`);
    names.add(b.name);
  }
  for (const b of bs) for (const m of b.mayImportFrom ?? []) if (!names.has(m)) out.push(`boundary ${b.name} may import from ${m}, which is not a boundary`);
  return out;
};

const norm = (folder: string): string => folder.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

/** Pure: the boundary a file is in (the longest folder wins), or undefined. */
export const boundaryOf = (config: BoundaryConfig, file: string): Boundary | undefined => {
  let best: Boundary | undefined;
  for (const b of config.boundaries) {
    const f = norm(b.folder);
    if (f === "." || f === "" || file.startsWith(`${f}/`)) if (!best || f.length > norm(best.folder).length) best = b;
  }
  return best;
};

export type ImportRef = { spec: string; line: number; kind: "js" | "py" };

const COMMENT = /^\s*(\/\/|\/\*|\*|#)/;
const JS_PATTERNS = [/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g, /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g];

/**
 * Pure: the imports of a JS/TS file (import, export from, require and import() with a literal) or a Python file
 * (import, from). A Python spec is "module:name,name": the names are candidates for a module of that package.
 */
export const importsOf = (file: string, content: string): ImportRef[] => {
  const out: ImportRef[] = [];
  if (JS_EXT.test(file)) {
    content.split(/\r?\n/).forEach((text, i) => {
      if (COMMENT.test(text)) return;
      for (const re of JS_PATTERNS) for (const m of text.matchAll(re)) out.push({ spec: m[1] as string, line: i + 1, kind: "js" });
    });
  } else if (PY_EXT.test(file)) {
    content.split(/\r?\n/).forEach((text, i) => {
      const from = /^\s*from\s+(\.*[\w.]*)\s+import\s+(.+?)\s*(?:#.*)?$/.exec(text);
      if (from) {
        const names = (from[2] as string).replace(/[()]/g, "").split(",").map((n) => (n.trim().split(/\s+as\s+/)[0] as string)).filter(Boolean);
        out.push({ spec: `${from[1] as string}:${names.join(",")}`, line: i + 1, kind: "py" });
        return;
      }
      const imp = /^\s*import\s+([\w.\s,]+?)\s*(?:#.*)?$/.exec(text);
      if (imp) for (const part of (imp[1] as string).split(",")) out.push({ spec: `${part.trim().split(/\s+as\s+/)[0] as string}:`, line: i + 1, kind: "py" });
    });
  }
  return out;
};

/** Pure: the files an import reaches among `files`; none for a package or a file that is not there. */
export const resolveImport = ({ from, ref, files }: { from: string; ref: ImportRef; files: Set<string> }): string[] => {
  const dir = path.posix.dirname(from);
  if (ref.kind === "js") {
    if (!ref.spec.startsWith(".")) return [];
    const base = path.posix.normalize(path.posix.join(dir, ref.spec));
    const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
    const tries = [base, ...JS_TRY.map((e) => stem + e), ...JS_TRY.map((e) => `${base}/index${e}`)];
    const hit = tries.find((t) => files.has(t));
    return hit ? [hit] : [];
  }
  const [mod, namesText] = ref.spec.split(":") as [string, string];
  const names = namesText ? namesText.split(",") : [];
  const dots = /^\.*/.exec(mod)?.[0].length ?? 0;
  const rest = mod.slice(dots);
  let roots: string[];
  if (dots > 0) {
    let d = dir;
    for (let i = 1; i < dots; i += 1) d = path.posix.dirname(d);
    roots = [d];
  } else roots = [".", "src"];
  const out: string[] = [];
  for (const r of roots) {
    const prefix = rest === "" ? path.posix.normalize(r) : path.posix.normalize(path.posix.join(r, rest.replace(/\./g, "/")));
    const p = prefix === "." ? "" : prefix;
    const sep = p ? `${p}/` : "";
    if (p) {
      const hit = [`${p}.py`, `${p}/__init__.py`].find((t) => files.has(t));
      if (hit) out.push(hit);
    }
    for (const n of names) {
      const sub = [`${sep}${n}.py`, `${sep}${n}/__init__.py`].find((t) => files.has(t));
      if (sub) out.push(sub);
    }
    if (out.length > 0) break;
  }
  return out;
};

/** Pure: the package an import names, or undefined for a relative import. */
const packageOf = (ref: ImportRef): string | undefined => {
  if (ref.kind === "js") {
    if (ref.spec.startsWith(".")) return undefined;
    const parts = ref.spec.split("/");
    return ref.spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] as string);
  }
  const mod = ref.spec.split(":")[0] as string;
  return mod.startsWith(".") ? undefined : (mod.split(".")[0] as string);
};

export const violationKey = (v: Pick<Violation, "file" | "target">): string => `${v.file} -> ${v.target}`;

const allowedFoldersOf = (config: BoundaryConfig, b: Boundary): string[] => [norm(b.folder), ...b.mayImportFrom.map((n) => norm(config.boundaries.find((x) => x.name === n)?.folder ?? n))];

/** Pure: every import across a boundary in `contents` (path to text), direct or through files that are in no boundary. */
export const findViolations = ({ config, contents }: { config: BoundaryConfig; contents: Map<string, string> }): Violation[] => {
  const files = new Set(contents.keys());
  const out: Violation[] = [];
  const edges = (file: string): { ref: ImportRef; targets: string[] }[] => importsOf(file, contents.get(file) ?? "").map((ref) => ({ ref, targets: resolveImport({ from: file, ref, files }) }));
  for (const file of [...files].sort()) {
    if (config.exclude && matchesAny(file, config.exclude)) continue;
    const mine = boundaryOf(config, file);
    if (!mine) continue;
    const allowedTo = [mine.name, ...mine.mayImportFrom];
    const allowedFolders = allowedFoldersOf(config, mine);
    const seen = new Set<string>();
    const add = (v: Violation): void => {
      if (seen.has(violationKey(v))) return;
      seen.add(violationKey(v));
      out.push(v);
    };
    for (const { ref, targets } of edges(file)) {
      const spec = ref.spec.split(":")[0] as string;
      const pkg = packageOf(ref);
      if (pkg && mine.banPackages?.includes(pkg)) add({ file, spec, line: ref.line, target: pkg, via: [], from: mine.name, to: `package ${pkg}`, allowedTo, allowedFolders });
      // Walk from each target through files outside any boundary until a boundary file is reached.
      const queue: { at: string; via: string[] }[] = targets.map((t) => ({ at: t, via: [] }));
      const visited = new Set<string>([file]);
      for (let next = queue.shift(); next; next = queue.shift()) {
        const { at, via } = next;
        if (visited.has(at)) continue;
        visited.add(at);
        const theirs = boundaryOf(config, at);
        if (theirs) {
          if (!allowedTo.includes(theirs.name)) add({ file, spec, line: ref.line, target: at, via, from: mine.name, to: theirs.name, allowedTo, allowedFolders });
          continue;
        }
        for (const e of edges(at)) for (const t of e.targets) queue.push({ at: t, via: [...via, at] });
      }
    }
  }
  return out;
};

const describe = (v: Violation): string => `${v.file} (boundary ${v.from}) line ${v.line} imports ${v.spec}${v.via.length > 0 ? `, which reaches ${v.target} through ${v.via.join(" -> ")}` : ` (${v.target})`}, in boundary ${v.to}.`;

/**
 * Pure: judge the tree. A violation listed in `allowed` is the backlog and is tolerated; any other is a blocking finding
 * that names the file, the forbidden import and the folders to use instead. `fallen` lists backlog entries that no longer
 * occur, to be removed so the backlog can only fall.
 */
export const judgeBoundaries = ({ config, contents }: { config: BoundaryConfig; contents: Map<string, string> }): { findings: Finding[]; tolerated: Violation[]; fallen: string[] } => {
  const all = findViolations({ config, contents });
  const allowed = new Set(config.allowed ?? []);
  const tolerated = all.filter((v) => allowed.has(violationKey(v)));
  const fresh = all.filter((v) => !allowed.has(violationKey(v)));
  const present = new Set(all.map(violationKey));
  const fallen = [...allowed].filter((k) => !present.has(k)).sort();
  const findings = fresh.map((v): Finding => ({
    kind: "rule",
    file: v.file,
    title: `boundary ${v.from} may not import from ${v.to}, line ${v.line}`,
    detail: `${describe(v)} Imports across a boundary are forbidden, and this one is not in the backlog (the backlog may fall, never rise).`,
    fix: v.to.startsWith("package ")
      ? `Do not import ${v.target} in ${v.from}. Use what ${v.from} already has, or move this code to a folder that may use it.`
      : `Import only from ${v.allowedFolders.join(", ")}. Move the shared code into one of those folders, or reach ${v.to} through a boundary that may import from it.`,
    blocking: true,
  }));
  return { findings, tolerated, fallen };
};

export const readBoundaryConfig = (root: string): BoundaryConfig | undefined => {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, BOUNDARY_FILE), "utf8")) as Partial<BoundaryConfig>;
    return boundaryProblems(parsed).length === 0 ? (parsed as BoundaryConfig) : undefined;
  } catch {
    return undefined;
  }
};

const SKIP_DIRS = new Set(["node_modules", ".git", ".ratchet", "dist", "build", "__pycache__", ".venv", "venv"]);

/** Thin reader: the JS/TS/Python files under root, as path (forward slashes) to text. */
export const readTree = (root: string): Map<string, string> => {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(rel);
      } else if (JS_EXT.test(e.name) || PY_EXT.test(e.name)) out.set(rel, fs.readFileSync(path.join(root, rel), "utf8"));
    }
  };
  walk("");
  return out;
};

/** The one call a turn end makes: the findings for the tree under root, or none when there is no boundary file. */
export const checkBoundaries = (root: string): { findings: Finding[]; tolerated: Violation[]; fallen: string[] } => {
  const config = readBoundaryConfig(root);
  if (!config) return { findings: [], tolerated: [], fallen: [] };
  return judgeBoundaries({ config, contents: readTree(root) });
};
