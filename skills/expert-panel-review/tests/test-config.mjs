import assert from 'node:assert/strict'
import { runWorkflow, SCRIPT } from './harness.mjs'

// Tunables are read from ONE config block AFTER args are parsed — so an override
// delivered as a JSON string (the harness sometimes does this) must be honored, not
// silently dropped. maxConditional is the observable one: it caps the conditional roster.
const empty = async (prompt, opts) =>
  opts.label?.startsWith('review:') ? { findings: [] } : (opts.label === 'ledger' ? { ledger: [] } : 'ok')

const reviewTypes = (calls) =>
  calls.filter((c) => c.opts.label?.startsWith('review:')).map((c) => c.opts.label.slice('review:'.length))

// 3 language files would add 3 conditional experts; string-args maxConditional:1 caps to 1.
const { calls } = await runWorkflow(SCRIPT, {
  args: JSON.stringify({
    diff: 'fake',
    changedFiles: ['a.py', 'b.go', 'c.rs'],
    maxConditional: 1,
    rules: '',
    date: '',
  }),
  agentImpl: empty,
})
const types = reviewTypes(calls)
const conditionals = types.filter((t) => ['python-pro', 'golang-pro', 'rust-pro'].includes(t))
assert.equal(conditionals.length, 1, `maxConditional:1 (string args) must cap conditional roster to 1, got ${conditionals.length}`)
assert.ok(['backend-architect', 'security-auditor'].every((t) => types.includes(t)), 'always-on lanes still present')

console.log('config tests: PASS')
