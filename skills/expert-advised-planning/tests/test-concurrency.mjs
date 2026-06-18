import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'
let inflight = 0, peak = 0
const fake = async (prompt, opts) => {
  if (opts.label === 'frame') return { problem: 'p', keyDecisions: [] }
  if (opts.label?.startsWith('advise:')) { inflight++; peak = Math.max(peak, inflight); await new Promise((r) => setTimeout(r, 15)); inflight--; return { recommendations: [] } }
  if (opts.label === 'reconcile') return { conflicts: [] }
  if (opts.label === 'draft') return '# Plan\n'
  return null
}
const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((x) => x + '-pro')
const { calls } = await runWorkflow(SCRIPT, { args: { source: 'S', rosterOverride: many, projectLangs: [], maxConcurrency: 2, date: '' }, agentImpl: fake })
assert.equal(calls.filter((c) => c.opts.label?.startsWith('advise:')).length, many.length, 'all override experts must advise')
assert.ok(peak <= 2, `peak concurrency ${peak} must be <= 2 (maxConcurrency arg)`)

// Args delivered as a JSON string (the harness sometimes does this): the tunables
// must still be honored — they have to be read AFTER args is parsed, not before.
let inflight2 = 0, peak2 = 0
const fake2 = async (prompt, opts) => {
  if (opts.label === 'frame') return { problem: 'p', keyDecisions: [] }
  if (opts.label?.startsWith('advise:')) { inflight2++; peak2 = Math.max(peak2, inflight2); await new Promise((r) => setTimeout(r, 15)); inflight2--; return { recommendations: [] } }
  if (opts.label === 'reconcile') return { conflicts: [] }
  if (opts.label === 'draft') return '# Plan\n'
  return null
}
{
  const { calls } = await runWorkflow(SCRIPT, { args: JSON.stringify({ source: 'S', rosterOverride: many, projectLangs: [], maxConcurrency: 2, date: '' }), agentImpl: fake2 })
  assert.equal(calls.filter((c) => c.opts.label?.startsWith('advise:')).length, many.length, 'all override experts must advise (string args)')
  assert.ok(peak2 <= 2, `peak concurrency ${peak2} must be <= 2 with string-delivered args`)
}
console.log('concurrency test: PASS')
