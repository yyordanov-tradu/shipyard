import assert from 'node:assert/strict'
import { parseVerdict, pickLatestReport } from '../lib/verdict.mjs'

assert.equal(parseVerdict('**Verdict:** READY\nmore'), 'READY')
assert.equal(parseVerdict('Verdict: NEEDS-WORK'), 'NEEDS-WORK')
assert.equal(parseVerdict('the verdict is MISALIGNED here'), 'MISALIGNED')
assert.equal(parseVerdict('no decision yet'), null)

const files = [
  '2026-06-10-foo-plan-readiness.md',
  '2026-06-18-foo-plan-readiness-v2.md',
  '2026-06-18-bar-plan-readiness.md',
  '2026-06-18-foo-other.md',
]
assert.equal(pickLatestReport(files, 'foo'), '2026-06-18-foo-plan-readiness-v2.md', 'newest foo readiness report')
assert.equal(pickLatestReport(files, 'baz'), null, 'no match -> null')
console.log('verdict: PASS')
