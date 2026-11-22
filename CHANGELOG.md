# Changelog

Notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
