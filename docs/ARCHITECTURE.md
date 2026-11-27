# Architecture

Ratchet is plain TypeScript run directly by Node (type stripping), with no build step and no runtime dependencies.

```
src/
  cli.ts              the one entry point; review and bench commands, then hands the rest to harness/cli.ts
  harness/            the coding harness
    install.ts        copies the harness, edits the settings file, writes the slash command
    hook.ts           what each hook event does
    turn.ts           the turn-end check: syntax, rules, hatches, then checks, tests, drivers
    checks.ts         finding checks: tsconfig folders, package scripts at any depth, pyproject, built-ins
    builtins.ts, protected.ts, generated.ts   the built-in checks (builtin:lf, builtin:protected, builtin:generated)
    runtree.ts        runs a command and stops every process it started at its deadline
    agents.ts         the subagent log and the pending rule while an agent runs
    ciinit.ts, brief.ts   ratchet ci init / codeql / blame-ignore, and status --brief
    rules.ts          rule kinds, matching, census
    state.ts          where everything is kept; the switch; the project config type
    auto.ts           the autonomous loop: propose, prove, map, promote, retire
    level.ts, lessons.ts, outcomes.ts, dashboard.ts, backtest.ts   reports
    work.ts           review of uncommitted work
  review.ts, plan.ts, prompts.ts, triage.ts, cite.ts, repro.ts    the review pipeline
  pack.ts, packs/     language packs (TypeScript, Python)
  bench.ts, guard.ts  the review benchmark and guards from reproduced findings
  vault.ts            findings as notes in an Obsidian vault
  subscription.ts     strips API key variables from every child process
  modelcheck.ts       bounded exhaustive model checks for small state machines (for projects' tests)
  mutate.ts           ratchet mutate: deliberate breaks in a temporary copy
  swarm/              EXPERIMENTAL: workers in worktrees, verifier, guard, launch gate, ladder
test/                 node:test files, one per module
.github/workflows/    gate.yml and release.yml, the reusable CI workflows projects call
```

## Principles the code holds to

- **A program decides first.** A model's claim is kept only with a quotation a program matched against the tree.
- **Pure where possible.** Decisions (`decideLaunch`, `addHooks`, `removeHooks`, rule matching) are pure functions with the file and process work kept at the edges, so they can be tested without a machine state.
- **The hooks must never break a session.** A hook that cannot do its work exits quietly; logging is a convenience.
- **Writes are atomic.** State is written through a temporary file and a rename.
- **Only tightening is automatic.** Anything that loosens a check is a person's command.
- **No escape hatches** in Ratchet's own source: no `as unknown as`, no `@ts-ignore`.

## Running one test

```
node --experimental-strip-types --no-warnings --test test/harness.test.ts
```
