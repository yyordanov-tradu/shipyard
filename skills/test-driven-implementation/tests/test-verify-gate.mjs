import assert from 'node:assert/strict'
import { sequenceGate } from '../lib/verify-gate.mjs'

const full = sequenceGate({ typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'npm test' })
assert.deepEqual(full.steps.map(s => s.name), ['typecheck', 'lint', 'test'], 'cheap -> expensive order')
assert.equal(full.steps[0].cmd, 'tsc --noEmit')
assert.deepEqual(full.skipped, [])

const partial = sequenceGate({ test: 'pytest' })
assert.deepEqual(partial.steps.map(s => s.name), ['test'], 'only present steps run')
assert.deepEqual(partial.skipped, ['typecheck', 'lint'], 'missing steps reported')

const none = sequenceGate({})
assert.deepEqual(none.steps, [])
assert.deepEqual(none.skipped, ['typecheck', 'lint', 'test'])
console.log('verify-gate: PASS')
