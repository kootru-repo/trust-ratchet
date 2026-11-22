import { createHash } from "node:crypto";
import type { Cite } from "./types.ts";

const sha = (s: string): string => createHash("sha1").update(s).digest("hex");

/**
 * A stable id for a finding: the file and the quoted text, not the line number or the title.
 * The same line found again in a later run gets the same id, so a person's ruling stays attached to it.
 */
export const ident = (cite: Cite): string => sha(cite.file + "|" + cite.quote.replace(/\s+/g, " ").trim()).slice(0, 10);

/** A deterministic UUID-shaped id, so writing the same note or relation twice changes nothing. */
export const uuidFrom = (seed: string): string => {
  const h = sha(seed);
  return [h.slice(0, 8), h.slice(8, 12), "5" + h.slice(13, 16), "8" + h.slice(17, 20), h.slice(20, 32)].join("-");
};

export const hashText = (s: string): string => sha(s).slice(0, 16);
