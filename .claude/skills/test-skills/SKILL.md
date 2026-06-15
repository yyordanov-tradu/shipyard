---
name: test-skills
description: Run all shipyard skill test harnesses and report pass/fail. Use when asked to run the tests, check the skills still pass, or before committing a change to a skill.
disable-model-invocation: true
---

# test-skills

Run every shipyard skill's Node test harness in one shot and report the result.

The harnesses are plain `node` scripts (no test runner, no `package.json`). Each one
exits `0` on pass and non-zero on failure, and prints a `<name> tests: PASS` line.
They load the installed workflow from `~/.claude/workflows/<skill>.js`, so the skill
being tested must be installed for its harness to run.

## Run

From the project root:

```bash
fail=0
for t in skills/*/tests/test-*.mjs; do
  printf '• %s ... ' "$t"
  if out=$(node "$t" 2>&1); then
    echo "PASS"
  else
    echo "FAIL"
    printf '%s\n' "$out" | sed 's/^/    /'
    fail=1
  fi
done
[ "$fail" -eq 0 ] && echo "All skill tests passed." || echo "Some skill tests FAILED."
exit "$fail"
```

## Report

- All green → say so plainly, list how many harnesses ran.
- Any failure → name the failing harness (`skills/<name>/tests/test-*.mjs`) and show the
  last few lines of its output, which point at the failing assertion. Do not move on to
  another harness's fix until the current failure is understood.
- If a harness errors with "Cannot find module" for `~/.claude/workflows/<skill>.js`, the
  skill isn't installed — that's an environment problem, not a test failure. Say so.
