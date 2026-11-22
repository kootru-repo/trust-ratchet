// SPDX-License-Identifier: AGPL-3.0-only
import type { Pack } from "../pack.ts";
import { pythonPack } from "./python.ts";
import { typescriptPack } from "./typescript.ts";

export const PACKS: Pack[] = [typescriptPack, pythonPack];

/** The pack for a file, chosen by its extension. */
export const packFor = (file: string): Pack => {
  const found = PACKS.find((p) => p.handles(file));
  if (!found) throw new Error(`no language pack handles ${file}. Packs: ${PACKS.map((p) => p.name).join(", ")}`);
  return found;
};
