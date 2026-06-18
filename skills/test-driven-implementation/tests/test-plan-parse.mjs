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
console.log('plan-parse: PASS')
