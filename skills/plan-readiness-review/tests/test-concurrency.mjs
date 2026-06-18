import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'

// agentImpl tracks how many review experts run at once.
let inflight = 0, peak = 0
const fake = async (prompt, opts) => {
  if (opts.label?.startsWith('review:')) {
    inflight++; peak = Math.max(peak, inflight)
    await new Promise((r) => setTimeout(r, 15))
    inflight--
    return { gaps: [], matrix: null }
  }
  if (opts.label?.startsWith('debate:')) return { reactions: [] }
  if (opts.label === 'decide') return { verdict: 'READY', report: 'r', consensus: [] }
  return null
}

// Force a big roster via override so there are more experts than the cap.
const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((x) => x + '-pro')
process.env.PRR_MAX_CONCURRENCY = '4'
const { calls } = await runWorkflow(SCRIPT, {
  args: { spec: 'S', plan: 'P', rosterOverride: many, projectLangs: [], date: '' },
  agentImpl: fake,
})
const reviewCount = calls.filter((c) => c.opts.label?.startsWith('review:')).length
assert.equal(reviewCount, many.length, 'all override experts must run')
assert.ok(peak <= 4, `peak concurrency ${peak} must be <= 4`)

// Args delivered as a JSON string: a caller-supplied maxConcurrency must still be
// honored (read after parse, not before).
let inflight2 = 0, peak2 = 0
const fake2 = async (prompt, opts) => {
  if (opts.label?.startsWith('review:')) { inflight2++; peak2 = Math.max(peak2, inflight2); await new Promise((r) => setTimeout(r, 15)); inflight2--; return { gaps: [], matrix: null } }
  if (opts.label?.startsWith('debate:')) return { reactions: [] }
  if (opts.label === 'decide') return null
  return null
}
{
  const { calls } = await runWorkflow(SCRIPT, {
    args: JSON.stringify({ spec: 'S', plan: 'P', rosterOverride: many, projectLangs: [], maxConcurrency: 2, date: '' }),
    agentImpl: fake2,
  })
  assert.equal(calls.filter((c) => c.opts.label?.startsWith('review:')).length, many.length, 'all override experts must run (string args)')
  assert.ok(peak2 <= 2, `peak concurrency ${peak2} must be <= 2 with string-delivered args`)
}
console.log('concurrency test: PASS')
