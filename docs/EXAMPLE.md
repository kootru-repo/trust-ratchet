# A worked example

Two things you can run in a minute. Neither touches your Claude Code settings.

## 1. What the agent sees

`npm run demo` builds a throwaway repository and a throwaway harness home in the temp folder, then calls the same hook handler the installed hooks call, in the order a session would: start, a bad edit, a broken test at the end of the turn, the fix. The script is [`examples/demo.ts`](../examples/demo.ts). Its output (the date and timing differ on your machine):

```
=== 1. The session starts: Ratchet tells the agent what is checked here ===
Ratchet harness is on for <repo> (mode: enforce).
After each file edit, programs check that the file parses, the project's rules (no-eval) and that no escape hatch was added. What they find comes back to you as facts, each with its fix.
Before your turn ends, the same checks run on every file this session changed, then: calc. A failure that is this session's holds the turn, at most 2 times.
These are program results, not opinions. Fix the cause; do not switch a check off.

=== 2. The agent writes a file that breaks a rule: the fact and its fix come back at once ===
decision: block
Ratchet: 1 fact from programs about the file you just edited.
1. calc.js: rule no-eval, line 1. eval runs text as code Fix: Parse the input with JSON.parse or a real parser.

=== 3. The agent removes the eval but breaks the sum, then tries to end its turn ===
(the hook says nothing: all clear)
decision: block
Ratchet: the turn checks fail in <repo> (1 changed file, 1 command; hold 1 of 2). Fix these before ending the turn, or tell the user plainly why one cannot be fixed.
1. calc fails, exit 1 (node calc.test.js). add(2, 3) should be 5 Fix: Make the code pass: change the code, not the test, unless the test itself is wrong, and say so if it is.

=== 4. The agent fixes the sum and ends its turn again ===
(the hook says nothing: all clear)

=== 5. The verification record of the held turn ===
# Verification record, 2026-11-22T15:42:02.672Z

Repository: <repo>. Session: demo. Mode: enforce. The turn was held.

## Files this session changed (1)

- calc.js

## What ran

- On every changed file: syntax, 1 project rules, escape hatches against the session baseline.
- test calc: fail (passed before, fails now), 0.7 s. Command: `node calc.test.js`

## What it said

- FAILS: calc fails, exit 1 (node calc.test.js). Fix: Make the code pass: change the code, not the test, unless the test itself is wrong, and say so if it is.

## What could not run

- Nothing.
```

What to notice:

- **Step 2**: the rule fires on the edit itself, with the fix, before the agent goes on.
- **Step 3**: the edit hook is quiet (the file parses and breaks no rule), but the turn cannot end: the test mapped to `calc.js` passed before the session and fails now, so the failure is the session's.
- **Step 4**: with the sum fixed, the turn ends.
- **Step 5**: a checked turn leaves a record of what ran and what it said.

## 2. A correction becomes a rule

Say the agent wrote `subprocess.run(..., text=True)` without an encoding, you had it fixed, and the fix is the last commit. In a scratch repository with that history (set `RATCHET_HOME` to a temp folder to keep it away from your real setup):

```
$ ratchet on --project .
$ ratchet init --project .
Wrote <home>/projects/<project>/config.json: checks none; escape hatch ceiling 0.

$ ratchet rule add --id subprocess-text-needs-encoding --kind ban-pattern \
    --pattern 'subprocess\.run\((?![^)]*encoding=)[^)]*text=True' \
    --files "tools/**/*.py" \
    --message "subprocess.run(text=True) without encoding= breaks on non-ASCII output" \
    --fix "add encoding='utf-8'" \
    --proof-commit HEAD --proof-file tools/build.py
Rule subprocess-text-needs-encoding added, proven on a795896a: fired on 1 line(s) the fix removed, on none it added.
Census: 1 more of the same in 1 file(s), kept as the backlog (may fall, never rise): tools/other.py 1.

$ ratchet census
subprocess-text-needs-encoding: 1 now, backlog was 1.
```

The rule was **proven**: a program checked that the pattern matches the line the fix removed and none it added. The one other place with the same fault is the **backlog**. From now on an edit that adds a new one is reported at once, the backlog may shrink, and `ratchet census --tighten` lowers it after a clean-up so it cannot grow back.
