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

## Built-in checks

A check whose `command` is `builtin:<name>` runs inside Ratchet, on the changed files that match its `when`. Each line it reports names one of them.

| Command | What it does | Extra fields |
|---|---|---|
| `builtin:lf` | Fails a file git would store with carriage returns. It reads `.gitattributes`, `core.autocrlf` and the form already stored, and skips binaries, `eol=crlf` files and links. | none |
| `builtin:protected` | Fails any change in the session to the files under `when` (recorded fixtures, golden files, snapshots), committed or not, and says how to put each back. `ratchet allow-protected --path <glob> --minutes <n>` allows a re-record for a while; every allowance given and used is logged in `allowances.log`. | none |
| `builtin:generated` | Builds into a temporary folder and compares every built file with the committed one under `into`, as LF for text and as bytes otherwise. Committed files of a kind the build makes but no longer builds are reported too. A build that changes the working tree is reported, and one that runs out of time is stopped with every process it started. Drift older than the session does not hold the turn until the check has passed once. | `build` (must contain `{out}`), `into` |

`ratchet init` offers `builtin:lf` when no covered file is stored with CR today, and `builtin:protected` for folders named `fixtures`, `__snapshots__`, `golden` and `testdata`. `builtin:generated` is configured by hand.

## Background agents

Ratchet keeps a log of which files each subagent's edits wrote (the SubagentStart and SubagentStop hooks). While an agent of the session is still running, a blocking failure that names a file that agent wrote, and none of the session's own, is reported as pending instead of holding the turn. It holds if it is still pending at the next turn end with nothing changed, and every failure holds as before once the agent stops. Writes made through a shell count as the session's own. Nothing to configure.

## Limits

| Key | Default | Meaning |
|---|---|---|
| `maxTestsPerStop` | 3 | The most mapped tests one turn end runs. The rest are reported as not run. |
| `budgetS.stop` | 120 (written by `init`) | Time budget in seconds for a turn-end check. |
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
