# Tests that catch what ordinary tests miss

Two practices proved their worth in a real project (trio-mix-assistant). Ratchet ships a small helper for the first and a check for the second.

## Exhaustive model checks for small state machines

A component that changes state over time, such as a link watchdog, a write limiter, a scheduler or a hold switch, fails in sequences nobody thought to write a test for. A bounded model check runs **every** sequence of events up to a depth against the component and checks it after each step. It usually compares against a reference model: a few lines that say what the state should be.

In trio this found 7 hardening bugs and 2 hold leaks that hundreds of ordinary tests had missed. Each file ran 0.3 to 1.1 million sequences in 2 to 7 seconds.

```ts
import { assertExplored, explore } from "trust-ratchet/src/modelcheck.ts";

const r = explore({
  alphabet: ["heard", "tick", "reset"],       // the events, including edge values: exactly at a threshold, just below, just above, NaN, Infinity, time going backwards
  depth: 8,
  init: () => ({ sut: new LinkWatch(opts), model: new Model(opts) }),
  step: (s, e) => { s.sut.apply(e); s.model.apply(e); return s.sut.state === s.model.state ? null : `state ${s.sut.state}, model ${s.model.state}`; },
  key: (s) => `${s.sut.snapshot()}|${s.model.key()}`, // the whole state, the system's and the model's: equal keys are explored once
  reach: [{ name: "down", hit: (s) => s.model.state === "down" }, { name: "recovered", hit: (s) => s.model.recovered }],
});
assertExplored(r);
```

- **On a failure,** events are dropped one at a time while the sequence still fails the same way, and what is left is what you see: `right -> right -> wrong -> right -> open`. Report the counterexample, then fix the code. Do not commit a failing test.
- **The key must cover the whole state.** A key made only from the model's state treats two different system states as one, and a bug in the difference is never explored. When in doubt, leave `key` out: the run is slower, not wrong.
- **Reachability counts.** A pass that never reached a named state proves nothing, so `assertExplored` fails in that case. It also fails when the run hit its step limit (`maxSteps`, 50 million by default).
- **Prove that the check bites.** Break a copy of the code on purpose (a `<` for a `<=`, a dropped guard) and see the check fail. In trio, 21 of 21 deliberate breaks of the hold logic were caught before the check was trusted. `ratchet mutate --file src/x.ts --test "node --test test/x.test.ts"` does this for you: it breaks the file in a temporary copy, never your working tree, runs the test once per break, and lists each break the test missed. Exit 0 means every break was caught.

## Recorded fixtures as the oracle

When the right output is hard to state but easy to record, such as a device's replies or a parser's output for real inputs, record it once and compare against the recording ever after.

- **Re-record only on purpose,** behind a switch such as `RECORD_FIXTURES=1`, and review every changed line of the recording.
- **Protect the folder** so an agent cannot "fix" a failing test by rewriting what it compares against:

  ```json
  { "name": "fixtures-unchanged", "command": "builtin:protected", "when": ["test/fixtures/**"] }
  ```

  Any change to those files in a session fails the turn end, even a committed one, until you allow a re-record for a while:

  ```
  ratchet allow-protected --path "test/fixtures/**" --minutes 30
  ```

  `ratchet init` offers this check for folders named `fixtures`, `__snapshots__`, `golden` and `testdata`.
