#!/usr/bin/env bash
# SessionStart hook: install shipyard's bundled workflow scripts into ~/.claude/workflows/.
#
# Why: the pipeline skills invoke the Workflow tool with
# `<home>/.claude/workflows/<skill>.js`. Those JS files are the deterministic engines.
# They are bundled in this plugin's `workflows/` dir (the source of truth); this hook copies
# them into ~/.claude/workflows/ so the skills work wherever the plugin is installed.
#
# Idempotent and quiet: safe to run on every session start.
set -uo pipefail

# Resolve the plugin root: prefer the env var Claude Code sets for plugin hooks; otherwise
# fall back to this script's own location (hooks/ sits directly under the plugin root).
root="${CLAUDE_PLUGIN_ROOT:-}"
if [ -z "$root" ]; then
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi

src="$root/workflows"
dest="$HOME/.claude/workflows"

[ -d "$src" ] || exit 0
mkdir -p "$dest"
cp -f "$src"/*.js "$dest"/ 2>/dev/null || true
exit 0
