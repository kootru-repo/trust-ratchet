#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only
# The package as a new user meets it, in temp folders only: install the package globally (into a temp prefix), run
# `ratchet install` against a temp settings file, use it on a sample project, feed the installed hooks the events
# Claude Code sends, then uninstall. Nothing outside <workdir> is written.
# Usage: scripts/e2e.sh <workdir> [package spec, default: a tarball packed from this checkout]
set -u
mkdir -p "$1"
# a POSIX spelling of the folder, so it can go on PATH under Git Bash on Windows too
Q="$(cd "$1" && pwd)"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SPEC="${2:-}"
if [ -z "$SPEC" ]; then SPEC="$Q/$(cd "$HERE" && npm pack --silent --pack-destination "$Q" | tail -1)"; fi
export RATCHET_HOME="$Q/home" RATCHET_SETTINGS="$Q/home/settings.json" npm_config_prefix="$Q/prefix"
export PATH="$Q/prefix:$Q/prefix/bin:$PATH"
FAILED=0
ok() { echo "PASS  $1"; }
bad() { echo "FAIL  $1"; FAILED=1; }
step() { local name="$1"; shift; if "$@" > "$Q/out.txt" 2>&1; then ok "$name"; else bad "$name"; tail -8 "$Q/out.txt"; fi; }
has() { if grep -q "$1" "$Q/out.txt"; then ok "$2"; else bad "$2"; cat "$Q/out.txt"; fi; }

cd "$Q"
step "npm install -g $SPEC" npm install -g --no-audit --no-fund "$SPEC"
step "ratchet --version" ratchet --version
step "ratchet help" ratchet help
has "Start here:" "help opens with the first steps"
step "ratchet install" ratchet install
if grep -q '"SessionStart"' "$RATCHET_SETTINGS" && grep -q '"Stop"' "$RATCHET_SETTINGS"; then ok "settings file holds the hook entries"; else bad "settings entries"; fi
if [ -f "$Q/home/commands/ratchet.md" ]; then ok "slash command written"; else bad "slash command"; fi

mkdir proj && cd proj && git init -q -b main
printf 'exports.add = (a, b) => a + b;\n' > calc.js
git add -A && git -c user.name=e2e -c user.email=e2e@example.invalid commit -q -m start
step "ratchet on --project ." ratchet on --project .
step "ratchet init --project ." ratchet init --project .
step "ratchet status --project ." ratchet status --project .
has "ON, mode advise" "status says ON, advise"
step "ratchet rule add" ratchet rule add --id no-eval --kind ban-api --pattern eval --files "**/*.js" --message "eval runs text as code" --fix "Use JSON.parse." --project .
step "ratchet rule list" ratchet rule list --project .
step "ratchet census" ratchet census --project .
step "ratchet hatches" ratchet hatches --project .
step "ratchet features" ratchet features --project .
step "ratchet level" ratchet level --project .
step "ratchet measure" ratchet measure --project .
step "ratchet on --mode enforce" ratchet on --project . --mode enforce

# the installed hooks, started exactly as the settings file says, with the payloads Claude Code sends
run_hook() { node -e "
const s=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const h=s.hooks[process.argv[2]][0].hooks[0];
const r=require('child_process').spawnSync(h.command,h.args,{input:process.argv[3],encoding:'utf8'});
process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1)" "$RATCHET_SETTINGS" "$1" "$2"; }
P=$(node -e "console.log(process.cwd().replace(/\\\\/g,'/'))")
run_hook SessionStart "{\"session_id\":\"e2e\",\"cwd\":\"$P\"}" > "$Q/out.txt" 2>&1
has "Ratchet harness is on" "installed hook: SessionStart tells the session what is checked"
run_hook PreToolUse "{\"session_id\":\"e2e\",\"cwd\":\"$P\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$P/calc.js\"}}" > /dev/null 2>&1
printf 'exports.add = (a, b) => eval(a + "+" + b);\n' > calc.js
run_hook PostToolUse "{\"session_id\":\"e2e\",\"cwd\":\"$P\",\"tool_name\":\"Edit\",\"tool_input\":{\"file_path\":\"$P/calc.js\"}}" > "$Q/out.txt" 2>&1
has "rule no-eval, line 1" "installed hook: a bad edit comes back with its rule"
printf 'exports.add = (a, b) => a + b;\n' > calc.js
if run_hook Stop "{\"session_id\":\"e2e\",\"cwd\":\"$P\"}" > "$Q/out.txt" 2>&1; then ok "installed hook: Stop ran"; else bad "Stop hook"; cat "$Q/out.txt"; fi

cd "$Q"
step "ratchet off --project proj" ratchet off --project proj
step "ratchet uninstall" ratchet uninstall
if grep -q "SessionStart" "$RATCHET_SETTINGS"; then bad "uninstall left hook entries"; else ok "uninstall removed every hook entry"; fi
if [ -f "$Q/home/commands/ratchet.md" ]; then bad "slash command left"; else ok "slash command removed"; fi
step "npm uninstall -g trust-ratchet" npm uninstall -g trust-ratchet
echo "FAILED=$FAILED"
exit "$FAILED"
