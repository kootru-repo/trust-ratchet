// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { manifests } from "./checks.ts";

/**
 * `ratchet ci init` (B3): writes a project's CI caller, a short workflow that calls Ratchet's reusable gate
 * (public repository, .github/workflows/gate.yml) pinned to one commit, and keeps the ci-ok job a ruleset can require.
 * It never pushes and never changes repository settings: it prints the ruleset command for the person to run.
 */
export const GATE_REPO = "kootru-repo/trust-ratchet";
/** The GitHub Actions app: only a ci-ok reported by a workflow run counts, not a status any token could post. */
export const GITHUB_ACTIONS_APP = 15368;

export type CiPlan = { workingDirectory: string; nodeVersion: string; os: string[]; install: string; lint: string; check: string; test: string };

const TYPE_SCRIPTS = ["check-types", "typecheck", "type-check", "check"];
const LINT_SCRIPTS = ["lint", "format:check"];

/** Pure: what to run, from the package that has a test script (the root first, then the shallowest) and its scripts. */
export const planCi = ({ packages, nodeVersion, os }: { packages: { dir: string; scripts: Record<string, string>; hasLock: boolean }[]; nodeVersion?: string; os?: string[] }): CiPlan | null => {
  const ordered = [...packages].sort((a, b) => (a.dir === "." ? -1 : b.dir === "." ? 1 : a.dir.split("/").length - b.dir.split("/").length || a.dir.localeCompare(b.dir)));
  const pkg = ordered.find((p) => typeof p.scripts.test === "string" && !/no test specified/.test(p.scripts.test));
  if (!pkg) return null;
  const script = (names: string[]): string => {
    const name = names.find((n) => typeof pkg.scripts[n] === "string");
    return name ? `npm run -s ${name}` : "";
  };
  return { workingDirectory: pkg.dir, nodeVersion: nodeVersion ?? "22", os: os && os.length > 0 ? os : ["ubuntu-latest"], install: pkg.hasLock ? "npm ci" : "npm install", lint: script(LINT_SCRIPTS), check: script(TYPE_SCRIPTS), test: "npm test" };
};

const yamlString = (s: string): string => JSON.stringify(s);

/**
 * Pure: the caller workflow. The gate is pinned to a commit; the tag it came from is a comment. With `ratchetCheck`, the
 * gate also runs Ratchet's checks, installing Ratchet from the same commit: a called workflow cannot read its own commit.
 */
export const callerWorkflow = ({ plan, sha, tag, ratchetCheck = false }: { plan: CiPlan; sha: string; tag: string; ratchetCheck?: boolean }): string =>
  [
    "name: CI",
    "# Written by `ratchet ci init`. The checks run in Ratchet's reusable gate, pinned to one commit;",
    "# ci-ok stays here so a ruleset on main can require it by that name.",
    "on:",
    "  push:",
    "  pull_request:",
    "  merge_group:",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  gate:",
    `    uses: ${GATE_REPO}/.github/workflows/gate.yml@${sha} # ${tag}`,
    "    with:",
    `      working-directory: ${yamlString(plan.workingDirectory)}`,
    `      node-version: ${yamlString(plan.nodeVersion)}`,
    `      os-matrix: ${yamlString(JSON.stringify(plan.os))}`,
    `      install-command: ${yamlString(plan.install)}`,
    `      lint-command: ${yamlString(plan.lint)}`,
    `      check-command: ${yamlString(plan.check)}`,
    `      test-command: ${yamlString(plan.test)}`,
    ...(ratchetCheck ? ["      ratchet-check: true", `      ratchet-package: ${yamlString(`github:${GATE_REPO}#${sha}`)}`] : []),
    "  ci-ok:",
    "    if: always()",
    "    needs: [gate]",
    "    runs-on: ubuntu-latest",
    "    steps:",
    '      - run: test "${{ needs.gate.result }}" = success',
    "",
  ].join("\n");

/** Pure: a ruleset for main that requires ci-ok, with no bypass, no force push and no deletion. */
export const rulesetJson = (): string =>
  `${JSON.stringify(
    {
      name: "main requires ci-ok",
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      bypass_actors: [],
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "ci-ok", integration_id: GITHUB_ACTIONS_APP }] } }],
    },
    null,
    2,
  )}\n`;

/** The commit a tag of the public repository points at, or null when it cannot be told (no network, no such tag). */
export const resolveTag = (tag: string): string | null => {
  try {
    return parseLsRemote(execFileSync("git", ["ls-remote", "--tags", `https://github.com/${GATE_REPO}`, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], { encoding: "utf8", timeout: 20_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    return null;
  }
};

/** Pure: the commit from `git ls-remote` lines: an annotated tag's peeled line (^{}) over the tag object, else the only line. */
export const parseLsRemote = (out: string): string | null => {
  const lines = out.trim().split(/\r?\n/).filter((l) => /^[0-9a-f]{40}\s/.test(l));
  const line = lines.find((l) => l.endsWith("^{}")) ?? lines[0];
  return line ? (line.split(/\s+/)[0] ?? null) : null;
};

/**
 * Is the gate at this commit of the public repository? True or false from GitHub; null when it cannot be told (no
 * network). A pin to a commit without the gate would make every CI run fail before it starts.
 */
export const gateExistsAt = (sha: string): boolean | null => {
  const url = `https://raw.githubusercontent.com/${GATE_REPO}/${sha}/.github/workflows/gate.yml`;
  const probe = "fetch(process.argv[1],{method:'HEAD'}).then(r=>process.exit(r.status===200?0:r.status===404?1:2),()=>process.exit(2))";
  try {
    execFileSync(process.execPath, ["-e", probe, url], { timeout: 20_000, windowsHide: true, stdio: "ignore" });
    return true;
  } catch (e) {
    return (e as { status?: number | null }).status === 1 ? false : null;
  }
};

/** Pure: a lock file of another package manager, which an npm gate would ignore. */
export const otherLock = (files: string[], dir: string): string | null => {
  const prefix = dir === "." ? "" : `${dir}/`;
  return ["yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock"].find((l) => files.includes(`${prefix}${l}`)) ?? null;
};

/** The packages a CI plan may use, with whether each has a lock file. */
export const readCiPackages = (root: string, files: string[]): { dir: string; scripts: Record<string, string>; hasLock: boolean }[] =>
  manifests(files, "package.json").map((f) => {
    const dir = path.posix.dirname(f);
    let scripts: Record<string, string> = {};
    try {
      scripts = (JSON.parse(fs.readFileSync(path.join(root, f), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
    } catch {
      scripts = {};
    }
    return { dir, scripts, hasLock: files.includes(dir === "." ? "package-lock.json" : `${dir}/package-lock.json`) };
  });

/** The Node version the project names (.nvmrc or .node-version at the root), if any. */
export const readNodeVersion = (root: string): string | undefined => {
  for (const name of [".nvmrc", ".node-version"]) {
    try {
      const v = fs.readFileSync(path.join(root, name), "utf8").trim().replace(/^v/, "");
      if (/^\d+(\.\d+){0,2}$/.test(v)) return v;
    } catch {
      // none
    }
  }
  return undefined;
};

/** Pure (D6): a CodeQL workflow for JavaScript and TypeScript, pinned to commits. It is not part of ci-ok unless a ruleset adds it. */
export const codeqlWorkflow = (): string =>
  [
    "name: CodeQL",
    "# Written by `ratchet ci codeql`. Not part of ci-ok: add it to the ruleset only if you want it to block merges.",
    "on:",
    "  push:",
    "  pull_request:",
    "  schedule:",
    "    - cron: \"17 4 * * 1\"",
    "permissions:",
    "  contents: read",
    "jobs:",
    "  analyze:",
    "    runs-on: ubuntu-latest",
    "    permissions:",
    "      actions: read",
    "      contents: read",
    "      security-events: write",
    "    steps:",
    "      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0",
    "        with:",
    "          persist-credentials: false",
    "      - uses: github/codeql-action/init@915412ff23e8b7659517e607487dbeae018f2934 # v4.39.5",
    "        with:",
    "          languages: javascript-typescript",
    "      - uses: github/codeql-action/analyze@915412ff23e8b7659517e607487dbeae018f2934 # v4.39.5",
    "",
  ].join("\n");

/** Pure (D5): the blame-ignore file with one more layout-only commit, unchanged when it is there already. */
export const withBlameIgnore = (current: string, sha: string, note: string): string => {
  const commit = sha.toLowerCase();
  if (current.split(/\r?\n/).some((l) => l.trim().toLowerCase().startsWith(commit))) return current;
  // The file keeps the line ending it already has.
  const nl = current.includes("\r\n") ? "\r\n" : "\n";
  const head = current === "" ? `# Layout-only commits that git blame skips (git config blame.ignoreRevsFile .git-blame-ignore-revs)${nl}` : current.endsWith("\n") ? current : `${current}${nl}`;
  return `${head}# ${note}${nl}${commit}${nl}`;
};
