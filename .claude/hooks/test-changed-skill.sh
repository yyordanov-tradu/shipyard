#!/usr/bin/env bash
# PostToolUse hook: when a file under skills/<name>/ is edited, run that skill's
# Node test harnesses. Quiet on pass; prints one {"systemMessage": "..."} line
# on the first failing harness so the regression surfaces right away.
#
# Reads the hook payload (JSON) on stdin. Runs from the project root, so the
# relative skills/<name>/tests path resolves correctly.
set -uo pipefail

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_response.filePath // empty')
[ -n "$file" ] || exit 0

# Only react to edits inside a skill directory.
case "$file" in
  *skills/*/*) ;;
  *) exit 0 ;;
esac

skill=$(printf '%s' "$file" | sed -E 's#.*skills/([^/]+)/.*#\1#')
dir="skills/$skill/tests"
[ -d "$dir" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0

shopt -s nullglob
tests=("$dir"/test-*.mjs)
[ ${#tests[@]} -gt 0 ] || exit 0

for t in "${tests[@]}"; do
  if ! out=$(node "$t" 2>&1); then
    msg=$(printf '%s' "$out" | tail -3 | tr '\n' ' ' | sed 's/"/\\"/g')
    printf '{"systemMessage":"shipyard: %s tests FAILED in %s — %s"}\n' "$skill" "$(basename "$t")" "$msg"
    exit 0
  fi
done
exit 0
