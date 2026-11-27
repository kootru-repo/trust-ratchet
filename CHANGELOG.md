# Changelog

Notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.2] - 2026-11-27

### Fixed
- The gate's `ratchet` job cannot read its own commit inside a called workflow, so it stopped. Callers now name it with `ratchet-package`, and `ratchet ci init` writes that, pinned to the gate's commit, for a project with `.ratchet/config.json`. [docs/CI.md](docs/CI.md) says so.

## [0.2.1] - 2026-11-27

### Added
- `ratchet check --base <ref> [--checks a,b]`: the turn-end checks (syntax, project rules, escape hatches, and the project's checks, built-ins included) on everything changed since a commit. Any finding fails. It is for CI, so a change made by hand meets the same checks as an agent's turn.
- The reusable gate's `ratchet-check` input runs it in CI, reading the project config from `.ratchet/`. A commit trailer `Ratchet-Allow-Protected: <glob>` allows a deliberate re-record. See [docs/CI.md](docs/CI.md).

## [0.2.0] - 2026-11-27

Run `ratchet install` again after updating: it brings the new built-in checks to the installed copy the hooks run, and adds two hook entries (seven in all).

### Added
- Built-in checks, which Ratchet runs itself instead of a shell command:
  - `builtin:lf` fails a changed file that git would store with carriage returns. It reads attributes and `core.autocrlf`, and skips binaries, `eol=crlf` files and links.
  - `builtin:protected` fails any change in the session to recorded references such as fixtures, golden files or snapshots, committed or not. A re-record needs `ratchet allow-protected --path <glob> --minutes <n>`, which gives a timed allowance and logs it.
  - `builtin:generated` checks that committed build output still matches its sources. It builds into a temporary folder, never into the working tree.
- `ratchet init` finds more checks and tries each one once:
  - lint, check, type-check and format-check scripts in nested packages;
  - ruff and mypy from `pyproject.toml`;
  - the LF check;
  - protected checks for `fixtures`, `__snapshots__`, `golden` and `testdata` folders.
- Subagents:
  - Ratchet records which files a subagent wrote, with new SubagentStart and SubagentStop hooks.
  - While a background agent is still running, a failure in the agent's own files is reported as pending instead of holding the parent's turn. It holds once the agent stops, or if it is still pending with nothing changed.
- CI for any project ([docs/CI.md](docs/CI.md)):
  - reusable workflows `gate.yml` (lint, test matrix) and `release.yml` (refuses a tag that did not pass `ci-ok`, builds per system, checks the version, checksums, attestation, verified downloads, dry-run rehearsal);
  - `ratchet ci init`, which writes the caller and the ruleset that requires `ci-ok`, and checks that the gate is at the commit it pins;
  - `ratchet ci codeql` and `ratchet ci blame-ignore`.
- Tests that catch more ([docs/TESTING.md](docs/TESTING.md)):
  - `src/modelcheck.ts`, bounded exhaustive model checks with shrinking and reachability;
  - `ratchet mutate`, which breaks a file on purpose in a temporary copy and lists the breaks the test misses.
- `ratchet status --brief`: house rules to paste into a subagent's brief.

### Changed
- `ratchet rule add` refuses a pattern that must match a carriage return, since rules see lines already split, and `rule list` marks stored ones.
- A check-only formatter script (`biome format`, `--check`) and output redirects such as `2>&1` no longer stop a script from being offered as a check.
- Every action in the shipped workflows is pinned to a commit.

### Fixed
- A build that runs out of time is stopped with every process it started, not only its shell.

## [0.1.1] - 2026-11-22

### Added
- The `ratchet` command as an npm package: `npm install -g github:kootru-repo/trust-ratchet && ratchet install`.
- `ratchet --version`; `ratchet help` now opens with the commands to start with and goes to standard output.
- `npm run demo` and [docs/EXAMPLE.md](docs/EXAMPLE.md): what the agent is told, without Claude Code.
- macOS in CI. Licence headers and AUTHORS.md.

### Changed
- An unknown command is named, with the usage of that command when there is one, in place of the whole command list.

### Fixed
- Linux and macOS: removing a dependency link, and a missing command under `sh` is "could not run", not a failure.

## [0.1.0] - 2026-11-22

First public release, under AGPL-3.0.

### Added
- The coding harness for Claude Code: checks after each edit and before each turn ends, `advise` and `enforce` modes, rules from corrections with a census, the escape-hatch ceiling, the comments constraint.
- The autonomous loop (`auto`), with `level`, `lessons`, `limits`, `measure`, `dashboard`, `backtest` and `guides`.
- Code review: `review`, `review-commit`, `review-work`, with language packs for TypeScript and Python and optional reproduction of findings.
- Experimental: the swarm modules, property testing, and the small tools `launchgate`, `gates`, `decisions`, `drivers`, `tokens`.
