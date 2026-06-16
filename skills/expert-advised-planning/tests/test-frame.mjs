import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'
let framePrompt = ''
const fake = async (prompt, opts) => {
  if (opts.label === 'frame') { framePrompt = prompt; return { problem: 'P', keyDecisions: [{ id: 'D1', question: 'reuse or build?' }] } }
  if (opts.label?.startsWith('advise:')) return { recommendations: [] }
  if (opts.label === 'reconcile') return { conflicts: [] }
  if (opts.label === 'draft') return '# Plan\n'
  return null
}
const { calls } = await runWorkflow(SCRIPT, { args: { source: 'build a thing', projectLangs: [], date: '' }, agentImpl: fake })
assert.equal(calls.filter((c) => c.opts.label === 'frame').length, 1, 'exactly one FRAME call')
assert.ok(framePrompt.includes('build a thing'), 'FRAME prompt includes the raw source')
console.log('frame tests: PASS')
