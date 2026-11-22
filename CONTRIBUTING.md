# Contributing to Ratchet

Thanks for helping. Small, checked changes are the easiest to take.

## Set up

```
git clone https://github.com/kootru-repo/trust-ratchet.git
cd trust-ratchet
npm install
npm run check-types
npm test
```

Node 22.6 or later is needed; there is no build step. `bash scripts/e2e.sh <an empty temp folder>` installs the package into that folder and walks a new user's path (install, a sample project, the hooks, uninstall). Tests use `RATCHET_HOME` in temporary folders and never touch your real Claude Code settings.

## What makes a change easy to accept

1. **A test that fails without it.** Run one file with `node --experimental-strip-types --no-warnings --test test/<name>.test.ts`.
2. **A program decides.** If a model is involved, say what a program verifies afterwards.
3. **It only tightens by itself.** Anything that loosens a check must be a person's command.
4. **No escape hatches**: no `as unknown as`, `@ts-ignore`, or `any` casts. No new runtime dependency.
5. **Docs with the code.** A new command or flag goes into the help text in `src/harness/cli.ts` or `src/cli.ts`, then `docs/COMMANDS.md` is regenerated from `ratchet help`. A new config key goes into `docs/CONFIGURATION.md`.

## Good first contributions

- A language pack (`src/packs/`): specialists, the always-on check, and the test runner for another language.
- A syntax check for another file type in `src/harness/turn.ts`.
- A rule kind in `src/harness/rules.ts`.
- Reports of a hook misbehaving on your platform, with the lines from `~/.claude/ratchet/log/`.

## Pull requests

- One topic per pull request, with a description of what was checked.
- CI must pass on Windows, Linux and macOS.
- You keep the copyright of your contribution and license it under the GNU Affero General Public License v3.0 (see [AUTHORS.md](AUTHORS.md)). New source files start with `// SPDX-License-Identifier: AGPL-3.0-only`.

## Reporting bugs

Use the bug report template. Remove private paths and code from any output you paste.
