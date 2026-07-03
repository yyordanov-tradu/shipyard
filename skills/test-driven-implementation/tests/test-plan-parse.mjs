import assert from 'node:assert/strict'
import { parsePlan } from '../lib/plan-parse.mjs'

const md = `# Some Plan

intro text

### Task 1: First

**Files:**
- Create: \`src/a.js\`
- Test: \`tests/a.test.js\`

body of one

### Task 2: Second

**Files:**
- Modify: \`src/b.js:10-20\`

This task depends on Task 1.
`

const { header, tasks } = parsePlan(md)
assert.ok(header.includes('Some Plan'), 'header captured')
assert.equal(tasks.length, 2, 'two tasks')
assert.equal(tasks[0].id, 1)
assert.equal(tasks[0].title, 'First')
assert.deepEqual(tasks[0].files, ['src/a.js', 'tests/a.test.js'], 'files, no backticks')
assert.deepEqual(tasks[1].files, ['src/b.js'], 'line-range stripped')
assert.deepEqual(tasks[1].deps, [1], 'explicit dep parsed')
assert.deepEqual(tasks[0].deps, [], 'no deps when none stated')
// Contract characterization: a plan whose headings miss the grammar parses to ZERO tasks
// (silently). The SKILL.md must STOP on this — this test pins the behavior that makes
// the STOP necessary.
{
  const wrong = `# Plan\n\n## Task 1: wrong level\n\nFiles affected: src/a.js\n`
  const { tasks } = parsePlan(wrong)
  assert.equal(tasks.length, 0, 'non-grammar headings yield zero tasks, no error')
}

console.log('plan-parse: PASS')
