import fs from "node:fs";
import path from "node:path";
import type { Pack } from "./pack.ts";
import { findUses, type Use } from "./reading.ts";

export const numbered = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((l, i) => `${String(i + 1).padStart(5)}  ${l}`)
    .join("\n");

const toPosix = (p: string): string => p.split(path.sep).join("/");

const walk = (dir: string, isSource: (name: string) => boolean, out: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "__pycache__" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, isSource, out);
    else if (isSource(entry.name)) out.push(full);
  }
  return out;
};

/** Nearest folder at or above the file that holds one of the marker files, relative to root. */
export const packageDir = ({ root, file, markers }: { root: string; file: string; markers: string[] }): string => {
  let dir = path.dirname(path.resolve(root, file));
  const top = path.resolve(root);
  while (dir.startsWith(top)) {
    if (markers.some((m) => fs.existsSync(path.join(dir, m)))) return toPosix(path.relative(top, dir)) || ".";
    if (dir === top) break;
    dir = path.dirname(dir);
  }
  return ".";
};

/** `uses`: lines in importing files that use this file. `imports`: files in the tree this file imports. Both found by a program. */
export type Context = { content: string; importers: string[]; pkg: string; uses?: Use[]; imports?: string[] };

/** Gathers what a reviewer needs besides the file itself: where it sits and which files import it. */
export const gatherContext = ({ root, file, pack, maxImporters = 12 }: { root: string; file: string; pack: Pack; maxImporters?: number }): Context => {
  const content = fs.readFileSync(path.resolve(root, file), "utf8");
  const pkg = packageDir({ root, file, markers: pack.packageMarkers });
  const needle = pack.importerPattern(file);
  const self = path.resolve(root, file);
  const importers = walk(path.resolve(root, pkg), pack.isSource)
    .filter((f) => f !== self && needle.test(fs.readFileSync(f, "utf8")))
    .map((f) => toPosix(path.relative(path.resolve(root), f)))
    .sort()
    .slice(0, maxImporters);
  return { content, importers, pkg, uses: findUses({ root, file, importers, pack }), imports: pack.localImports?.({ root, file, content, pkg }) ?? [] };
};
