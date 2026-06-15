#!/usr/bin/env bash
# PostToolUse hook: keep edited SKILL.md / plugin.json well-formed.
# Quiet on success (exit 0, no output). On a problem it prints a single
# {"systemMessage": "..."} line so Claude Code shows a warning in the UI.
#
# Reads the hook payload (JSON) on stdin and pulls the edited file path from it.
set -uo pipefail

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_response.filePath // empty')
[ -n "$file" ] || exit 0
[ -f "$file" ] || exit 0

warn() { printf '{"systemMessage":"shipyard: %s"}\n' "$1"; exit 0; }

case "$file" in
  */plugin.json|plugin.json)
    jq empty "$file" >/dev/null 2>&1 || warn "plugin.json is not valid JSON."
    [ -n "$(jq -r '.name // empty' "$file")" ] || warn "plugin.json is missing a \"name\" field."
    ;;
  */SKILL.md|SKILL.md)
    # Frontmatter must be a --- fenced block on line 1 with name + description.
    [ "$(head -1 "$file")" = "---" ] || warn "${file##*/}: frontmatter must start on line 1 with ---"
    fm=$(awk 'NR==1 && $0=="---"{f=1; next} f && $0=="---"{exit} f{print}' "$file")
    printf '%s\n' "$fm" | grep -q '^name:' || warn "${file##*/}: frontmatter is missing name:"
    printf '%s\n' "$fm" | grep -q '^description:' || warn "${file##*/}: frontmatter is missing description:"
    ;;
esac
exit 0
