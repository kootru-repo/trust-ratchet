export type Cite = { file: string; line: number; quote: string };

export type Severity = "critical" | "major" | "minor";

export type Concern = {
  specialist: string;
  title: string;
  severity: Severity;
  cite: Cite;
  reasoning: string;
};

/** A candidate the specialist looked at and ruled out. "assumed" means it relied on code it did not read. */
export type Dismissal = {
  specialist: string;
  title: string;
  cite: Cite;
  proof: "local" | "assumed";
  reasoning: string;
};

export type SpecialistOutput = { concerns: Concern[]; dismissed: Dismissal[]; reads?: Cite[] };

export type Verdict = "confirmed" | "refuted" | "unproven";

export type Check = {
  /** "local-dismissal": a dismissal the specialist said was proven by the code it read, sampled to check that claim. */
  origin: "concern" | "dismissal" | "local-dismissal";
  specialist: string;
  title: string;
  severity: Severity;
  cite: Cite;
  claim: string;
};

export type Checked = Check & {
  verdict: Verdict;
  proof: Cite[];
  explanation: string;
  callSites: string[];
  /** A lint rule or test that would catch this class of bug without a model. */
  guard: string;
  /** Why the harness changed the verifier's own verdict, if it did. */
  downgraded?: string;
  /** Set when a reproduction was tried. Absent means the finding is argued only. */
  repro?: Repro;
};

export type Repro = {
  status: "reproduced" | "test-passed" | "test-broken" | "not-attempted";
  reason: string;
  test: string;
  output: string;
  attempts: number;
  /** Benchmark only: the same test run on the tree after the real fix. */
  afterFix?: "passes" | "still-fails" | "error";
};

export type Dropped = { title: string; specialist: string; reason: string };

/** `ran: false` means the check could not run at all. It is then no evidence either way. */
export type Fact = { command: string; exitCode: number; tail: string; ran?: boolean };

export type ReviewResult = {
  file: string;
  specialists: string[];
  facts: Fact[];
  candidates: Concern[];
  dismissals: Dismissal[];
  dropped: Dropped[];
  unchecked: Check[];
  checked: Checked[];
  modelCalls: number;
  errors: string[];
  /** How many locally proven dismissals there were, and how many of them were sampled for a second look. */
  localDismissals?: number;
  localAudited?: number;
  reading?: Reading[];
  /** True when the file was reviewed as a change (a diff and its commit message), not as a whole file. */
  patch?: boolean;
};

/** Sends one prompt to a model working in `cwd` and returns its final text. */
/** One tool call a reviewer made. `target` is the file path or the search pattern. */
export type ToolUse = { name: string; target: string };
/** `onTools` is called once with the tool calls of the reply, by a model wrapper that can see them. */
export type ModelFn = (args: { prompt: string; cwd: string; label: string; onTools?: (tools: ToolUse[]) => void }) => Promise<string>;

/** How much one specialist read outside the file under review. `opened` is null when tool use was not recorded. */
export type Reading = { specialist: string; opened: number | null; verified: number; required: number; retried: boolean };
