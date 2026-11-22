import type { Specialist } from "./plan.ts";
import type { ReproConfig, TestRunner } from "./repro.ts";

/**
 * Everything that depends on the language. The engine (citation check, triage, verifiers, proof check,
 * reproduction loop, vault, benchmark) never looks at a file extension or a test framework itself.
 */
export type Pack = {
  name: string;
  /** How prompts name the language. */
  language: string;
  handles: (file: string) => boolean;
  /** Source files that count when looking for importers. */
  isSource: (fileName: string) => boolean;
  /** Files that mark the folder tests run from. First match walking up from the file wins. */
  packageMarkers: string[];
  /** A pattern that matches a line importing `file`. */
  importerPattern: (file: string) => RegExp;
  /** The names an importing file uses for what it takes from `file`. */
  importedNames?: (importerText: string, file: string) => string[];
  /** The files inside the tree that `file` imports, relative to the root. */
  localImports?: (args: { root: string; file: string; content: string; pkg: string }) => string[];
  pickSpecialists: (args: { file: string; content: string; extras: string[] }) => Specialist[];
  /** Cheap deterministic checks that need no project setup. They run before any model call. */
  defaultChecks: (file: string) => string[];
  runner: (config: ReproConfig) => TestRunner;
  /** Runs a lint configuration on one file and returns what it reported, or null when it could not run. */
  lint?: (config: ReproConfig) => LintRunner;
  /** Instructions for writing a reproduction test in this language's framework. */
  testGuide: (pkg: string) => string;
};

export type Violation = { line: number; rule: string; message: string };
export type LintRunner = (args: { root: string; file: string; configCode: string }) => Violation[] | null;

export const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
