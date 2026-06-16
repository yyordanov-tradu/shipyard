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
console.log('concurrency test: PASS')
