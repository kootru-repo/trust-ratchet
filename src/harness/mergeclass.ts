import { readFileSync } from "node:fs";

/** Result of one lane at a turn end. Inconclusive and pending are never a pass (plan section 1). */
export type Lane = "pass" | "fail" | "inconclusive" | "pending";

/** Row 9: what a program knows about one turn. The speed lane is read from the first daily run of row 17 on a tree holding the change. */
export type TurnFacts = {
  changedSource: boolean;
  changedTest: boolean;
  /** Every mapped check ran: none could not run, none was left for the next turn end. */
  allChecksRan: boolean;
  tests: Lane;
  driver: Lane;
  speed: Lane;
  /** Row 17: a "faster" reading with no limiter named is inconclusive. */
  speedLimiter?: string;
  speedWord?: "faster" | "slower" | "no measurable difference" | "inconclusive";
  /** Row 16: the sheets of how the town looks differ. */
  lookChanged: boolean;
};

export type ClassResult = { inside: boolean; reasons: string[] };

/** The class of turn of row 9, defined by program. An empty list of reasons is the only way inside. */
export const classOfTurn = (t: TurnFacts): ClassResult => {
  const reasons: string[] = [];
  if (!t.changedSource) reasons.push("the turn changed no source file");
  if (!t.changedTest) reasons.push("the turn changed no test");
  if (!t.allChecksRan) reasons.push("a check could not run or was left for the next turn end");
  const lane = (name: string, l: Lane) => {
    if (l !== "pass") reasons.push(`the ${name} lane is ${l}, not pass`);
  };
  lane("tests", t.tests);
  lane("driver", t.driver);
  lane("speed", t.speed);
  if (t.speed === "pass") {
    if (t.speedWord !== "faster" && t.speedWord !== "no measurable difference") reasons.push(`the speed reading is ${t.speedWord ?? "missing"}, not faster or no measurable difference`);
    if (t.speedWord === "faster" && !(t.speedLimiter ?? "").trim()) reasons.push("a reading of faster names no limiter");
  }
  if (t.lookChanged) reasons.push("the turn changes how the town looks and waits for the owner");
  return { inside: reasons.length === 0, reasons };
};

export type VerdictWord = "VERIFIED" | "NOT VERIFIED" | "INCONCLUSIVE";

/** Row 9 verdict record: keyed by patch id, by an agent that did not write the code, with pointers to evidence. */
export type VerdictRecord = { author: string; verifier: string; patchId: string; verdict: VerdictWord; evidence: string[] };

export type Counted = { counted: boolean; reasons: string[] };

/** Only a VERIFIED verdict from a verifier other than the author, on the patch now in the tree, with evidence, counts. Inconclusive is not a pass. */
export const countVerdict = (r: VerdictRecord, patchNow: string): Counted => {
  const reasons: string[] = [];
  if (r.verifier === r.author) reasons.push("the verifier is the session that wrote the code");
  if (r.patchId !== patchNow) reasons.push(`the verdict covers patch ${r.patchId}, not ${patchNow}`);
  if (r.verdict === "INCONCLUSIVE") reasons.push("the verdict is INCONCLUSIVE, which is not a pass");
  else if (r.verdict !== "VERIFIED") reasons.push(`the verdict is ${r.verdict}, not VERIFIED`);
  if (r.evidence.length === 0 || r.evidence.some((e) => !e.trim())) reasons.push("the verdict points at no evidence");
  return { counted: reasons.length === 0, reasons };
};

export type GateState = "open" | "closed";
export type Gates = Record<string, GateState>;

/** Rows whose gates must be closed before the switches of rows 9 and 19 go on: 2 to 8 and 10 to 17. */
export const REQUIRED_ROWS: readonly number[] = [2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17];

/** Reads proof/gates.json. Anything other than "closed" reads as open. */
export const readGates = (file: string): Gates => {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const out: Gates = {};
  if (typeof parsed === "object" && parsed !== null && "gates" in parsed) {
    const g = parsed.gates;
    if (typeof g === "object" && g !== null) for (const [k, v] of Object.entries(g)) out[k] = v === "closed" ? "closed" : "open";
  }
  return out;
};

export type Switch = { allowed: boolean; open: number[] };

/** Row 18: auto-merge may be switched on only when every listed row's gate is closed. Names the open ones. */
export const autoMergeMayBeOn = (gates: Gates, required: readonly number[] = REQUIRED_ROWS): Switch => {
  const open = required.filter((r) => gates[String(r)] !== "closed");
  return { allowed: open.length === 0, open };
};

export const refusal = (s: Switch): string => (s.allowed ? "" : `auto-merge refused: rows ${s.open.join(", ")} are still open`);
