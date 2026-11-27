# Commands

This is the output of `ratchet help`. Every command takes `--project <dir>` where shown; the default is the current folder. `ratchet --version` prints the version.

```
Ratchet 0.2.1: a trust harness for AI coding agents.

Start here:
  ratchet install                              add the hooks to Claude Code (your settings file is backed up first)
  ratchet on --project <dir>                   switch it on for one project (advise mode)
  ratchet init --project <dir>                 write a config from what is found there
  ratchet status --project <dir>               what is on and what is checked
  ratchet on --project <dir> --mode enforce    hold a turn on a failure the session caused
  ratchet rule add ...                         turn a correction into a rule
  ratchet uninstall                            remove the hooks again

Guide: https://github.com/kootru-repo/trust-ratchet#readme

Every command:
ratchet mutate --file <path> --test "<command>" [--max 20] [--timeout 120] [--project <dir>]   break the file on purpose in a temporary copy and report which breaks the test misses (exit 0 all caught, 1 missed, 2 usage, 3 test fails unbroken, 4 wait, 5 nothing to try)
ratchet launchgate [--workers <n>] [--max-workers <n>] [--max-ram <pct>]   (exit 0 start, 1 wait)
ratchet gates [--project <dir>] [--file <gates.json>]   (exit 0 when row 18 allows auto-merge, 1 when rows are open)
ratchet decisions <log.md> [--repo <dir>] [--previous <file>]
ratchet drivers [--project <dir>]   (checks each configured driver against the contract; runs them)
ratchet tokens <session.jsonl> [--pattern <regex>]...
ratchet review <root> <file> [--check "<command>"]... [--check-dir <dir>] [--repro-pkg <dir>] [--deps-from <dir>] [--alias "~=src"]... [--python <exe>] [--extra <specialist>]...
                              [--vault <dir>] [--target <name>] [--model sonnet] [--max-checks 40] [--out report.md]
ratchet bench [--cases bench/cases.json] [--results bench/results] [--limit 4] [--only <case id>] [--no-controls] [--rescore] [--repro] [--audit-local 3] [--require-reads 2] [--guards <dir>] [--vault <dir>] [--model sonnet]
ratchet bench mine --repo <dir> --prefix <path> [--exclude-cases <file>]... [--max 10] [--max-changed 40] [--max-patch 400] [--target <name>] [--out bench/cases-fresh.json]
                              find fix commits and the commits that wrote the bugs, mechanically
ratchet review-commit <repo> <rev> [--repro-pkg <dir>] [--deps-from <dir>] [--check "<command>"]... [--check-file "<command>"]... [--max-files 6] [--out report.md]
                              review a commit as a patch (--check-file keeps only output lines about the reviewed file)
ratchet effort <results dir>                                                   turns and tokens per kind of call, from saved transcripts
ratchet guard promote [--cases <file>] [--results <dir>] [--guards <dir>]     turn reproduced tests into case guards
ratchet guard prove [--cases <file>] [--guards <dir>]                          run every guard on the buggy and the fixed tree
ratchet retire <specialist> [--cases <file>] [--results <dir>] [--guards <dir>] [--limit 20] [--audit-local 3] [--guard-facts]
                              give it the same --audit-local and guard facts as the baseline run in --results
ratchet vault init <dir> --schema <dg schema json>
ratchet vault sync <dir>
ratchet review-work [--project <dir>] [--since HEAD] [--max-files 3] [--out report.md]   review the change not yet committed, by reviewers that never saw the session
  a report puts its confirmed findings to the author as questions; --no-questions gives the status list
  optional, off by default (review and review-work): [--verifier-reads <n>] [--budget] [--guides [--guides-dir <dir>]] [--must-not-flag] [--property] [--mask-comments] [--escalate-local] [--message-to-all (for measuring bias)]
ratchet install | uninstall                         add or remove the five hook entries in the Claude Code settings (switch state is kept)
ratchet on | off [--project <dir>] [--mode advise|enforce]   the global switch, or one project's own switch
ratchet default --project <dir>                       drop a project's own switch, so it follows the global one
ratchet status [--project <dir>] [--brief]   --brief adds the house rules to paste into a subagent's brief
ratchet init [--project <dir>] [--in-repo] [--force] [--keep-own]  write a project config from what is found (no whole test suite, ever); --keep-own keeps the checks, tests and drivers written by hand, and the limits set by hand
ratchet init --pair-tests [--py-test "python -B {test}"] [--ts-test "<cmd> {test}"] [--exclude <glob>]... [--project <dir>]
                                                      map each test that sits beside the file it tests to that file
ratchet features [--project <dir>]                    the feature map: what watches each folder of source files
ratchet auto [--project <dir>] [--on | --off] [--guards | --no-guards] [--guard-commit <rev>] [--backlog] [--py-test "python -B {test}"] [--ts-test <cmd>] [--exclude <glob>]... [--not-ours <glob>]...
                                                      one pass of the autonomous loop; --on and --off switch it for the project;
                                                      --backlog also times the tests that were there before it was switched on, three a pass
                                                      --guards lets it ask a model for a regression test of each new fix, kept only when a
                                                      program saw it fail before the fix and pass after; --guard-commit asks for one fix by name
ratchet baseline [--project <dir>] [--minutes 10]     run the mapped commands once on the tree as it is (not a session's turn; refused where noFullRuns is set)
ratchet limits [--project <dir>] [--replay] [--on | --off]  the turn-end limits (tests per turn end, time budget), their floor and ceiling, and what the records say; --on lets the loop move its own value one step a pass
ratchet lessons [--project <dir>] [--on | --off] [--record]  the lesson card: for each lesson of the talk, what is in use here and what effect is measured; --on keeps a line of its
                                                      numbers at each pass of the loop (off by default: nothing is written); --record prints the latest verification record
ratchet level [--project <dir>]                       the verification level, with every requirement met or not
ratchet backtest [--project <dir>] [--max 400] [--from <n>] [--to <n>] [--cap 25] [--shapes a,b|all] [--minutes 20] [--resume] [--json]
                                                      walk the history oldest first: the rules the loop would have written, and the
                                                      later fixes they would have named; stops at the time limit, --resume goes on
ratchet dashboard [--out <file>]                      one page for every project the loop runs in: level, trend, what it changed
ratchet guides [--project <dir>] [--last 1000]        write generated notes for reviewers: the fixes each folder has needed and the rules in it
ratchet rule add --id <id> --kind ban-pattern|ban-import|ban-api --pattern <p> --files <glob>... --message <m> --fix <f> [--scope statement]
                 [--proof-commit <rev> --proof-file <file>] [--project <dir>] [--in-repo]
ratchet rule list | rule remove --id <id> [--project <dir>]
ratchet census [--project <dir>] [--tighten]          every rule: count now against its baseline; --tighten lowers a backlog that fell
ratchet hatches [--project <dir>] [--set-ceiling]     escape hatches in the repository against the stored ceiling
ratchet measure [--project <dir>] [--last 200]        outcomes from git history and the harness's own records
ratchet check --base <ref> [--checks name,name] [--project <dir>]   the turn-end checks on everything changed since <ref>, for CI: any finding fails (exit 1)
ratchet ci codeql [--project <dir>] [--force]   write .github/workflows/codeql.yml (JavaScript and TypeScript), pinned; not part of ci-ok
ratchet ci blame-ignore --commit <sha> [--note <text>] [--project <dir>]   list a layout-only commit (a formatter run) in .git-blame-ignore-revs
ratchet ci init [--project <dir>] [--os ubuntu-latest,windows-latest] [--ref <commit>] [--tag <name>] [--skip-ref-check] [--force]   write .github/workflows/ci.yml calling the reusable gate; prints the ruleset command, pushes nothing
ratchet allow-protected --path <glob> [--minutes 30] [--project <dir>]   allow changes to protected files (builtin:protected) for a while, logged
ratchet must-not add --files <glob>... --pattern <regex on the line> --reason <why it is fine> [--project <dir>]
ratchet must-not from-vault --vault <dir> --review <review .json>... [--project <dir>]   false-alarm rulings become must-not-flag cases
ratchet must-not list [--project <dir>]
```
