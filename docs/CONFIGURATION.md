# Configuration

A project's config is `config.json`, read from `.ratchet/` in the repository when that folder holds it, else from `~/.claude/ratchet/projects/<project>/`. `ratchet init` writes it from what it finds (package scripts, `tsconfig.json`, tests that sit beside the files they test). `ratchet init --force --keep-own` writes it again and keeps the entries and limits you wrote by hand. The type is `ProjectConfig` in [`src/harness/state.ts`](../src/harness/state.ts).

## Commands: `checks`, `tests`, `drivers`

Each entry:

| Field | Meaning |
|---|---|
| `name` | Shown in reports. |
| `command` | The shell command. `{files}` is replaced by the changed files that match `when`. |
| `when` | Globs. The command runs only when a changed file matches. |
| `onlyChanged` | Run it only on changed files. |
| `timeoutS` | Seconds before the command is stopped. |
| `stage: "trial"` | A failure is reported and never holds the turn. |
| `origin: "auto"` | Written by the autonomous loop, which may remove it again. |

- `checks` run before the turn ends (type check, lint).
- `tests` name the one relevant test for a set of files. Never put a whole suite here.
- `drivers` run the real thing (start the CLI, build the page).

## Limits

| Key | Default | Meaning |
|---|---|---|
| `maxTestsPerStop` | 3 | The most mapped tests one turn end runs. The rest are reported as not run. |
| `budgetS.stop` | set by `init` | Time budget in seconds for a turn-end check. |
| `autoLimits` | none | The loop's own turn-end limits. The larger of yours and its is used; removing this key undoes it. |
| `autoLimitsOn` | false | Lets the loop move its own limits one step a pass. |
| `hatchCeiling` | counted by `hatches --set-ceiling` | The most escape hatches the repository may hold. The harness may lower it, never raise it. |
| `noFullRuns` | false | The project forbids running all mapped commands at once; `baseline` is refused. |

## Rules of style

| Key | Meaning |
|---|---|
| `comments.mode` | `off` (default), `excuses` (flags comments that excuse a switched-off check) or `ban`. |
| `comments.allow` | Regular expressions for the project's own comment tags, which stay allowed. |

## The autonomous loop

| Key | Meaning |
|---|---|
| `auto` | Run the loop after each checked turn. |
| `autoExclude` | Globs the loop never writes a rule for and never maps or runs a test in. |
| `autoTest.py`, `autoTest.ts` | The command the loop runs a new test with; `{test}` is the file. Without one, no test of that language is mapped. |
| `autoGuards` | The loop may ask a model for a regression test of a fix. It is kept only when a program saw it fail before the fix and pass after. One model call a pass. |
| `lessonsLog` | Keep one line of the lesson card's numbers each pass. |
| `notOurs` | Folders that are not the project's own code (vendored, pinned). They count neither for nor against coverage. |

## Switch and modes

The switch is kept in `~/.claude/ratchet/state.json`, not in the project config.

- `ratchet on` / `off`: the global switch for every project.
- `ratchet on --project <dir> [--mode advise|enforce]`: one project's own switch, which wins over the global one in both directions.
- `ratchet default --project <dir>`: drop the project's own switch.

## Environment variables

| Variable | Meaning |
|---|---|
| `RATCHET_HOME` | Where everything Ratchet keeps lives. Default `~/.claude/ratchet`. |
| `RATCHET_SETTINGS` | The Claude Code settings file `install` and `uninstall` edit. Default `~/.claude/settings.json`. |
| `RATCHET_SWARM_*` | Set by the experimental swarm for its workers. Not for manual use. |

To try Ratchet without touching your real setup, set both `RATCHET_HOME` and `RATCHET_SETTINGS` to paths in a temporary folder before `install`.
