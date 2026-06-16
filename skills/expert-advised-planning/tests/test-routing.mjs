import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'
const oneConflict = { kind: 'expert-expert', summary: 's', positions: [{ party: 'a', stance: 'x' }, { party: 'b', stance: 'y' }] }
const mk = (conf, stakes) => async (prompt, opts) => {
  if (opts.label === 'frame') return { problem: 'p', keyDecisions: [] }
  if (opts.label?.startsWith('advise:')) return { recommendations: [{ id: 'r', text: 't', rationale: 'r' }] }
  if (opts.label === 'reconcile') return { conflicts: [oneConflict] }
  if (opts.label?.startsWith('arbitrate:')) return { resolution: 'x', rationale: 'r', confidence: conf, stakes }
  if (opts.label === 'draft') return '# Plan body\n'
  return null
}
// auto-resolve (high conf, low stakes) -> DRAFT -> plan
{
  const { result } = await runWorkflow(SCRIPT, { args: { source: 'x', projectLangs: [], date: '' }, agentImpl: mk('high', 'low') })
  assert.ok(result.plan, 'auto-resolved -> plan'); assert.equal(result.escalations.length, 0)
}
// escalate (low conf) -> awaiting-human, carry present, NO draft
{
  const { result, calls } = await runWorkflow(SCRIPT, { args: { source: 'x', projectLangs: [], date: '' }, agentImpl: mk('low', 'low') })
  assert.equal(result.phase, 'awaiting-human'); assert.equal(result.escalations.length, 1)
  assert.ok(result.carry && result.carry.resolved !== undefined && result.carry.advice, 'carry payload returned')
  assert.equal(calls.filter((c) => c.opts.label === 'draft').length, 0, 'no DRAFT before human resolves')
}
// med confidence is NOT high -> must escalate, never auto-resolve
{
  const { result } = await runWorkflow(SCRIPT, { args: { source: 'x', projectLangs: [], date: '' }, agentImpl: mk('med', 'low') })
  assert.equal(result.phase, 'awaiting-human', 'med confidence must escalate, not auto-resolve')
  assert.equal(result.escalations.length, 1)
}
// draft-mode: skips phases 1-3 entirely, merges humanDecisions, runs only DRAFT
{
  const carry = { framing: { problem: 'p', keyDecisions: [] }, advice: [{ expert: 'architecture', recommendations: [] }], resolved: [], roster: ['architecture'], graphMode: 'graphify' }
  const { result, calls } = await runWorkflow(SCRIPT, {
    args: { mode: 'draft', carry, humanDecisions: [{ conflictId: 'C1', resolution: 'go with x', note: 'lead call' }], date: '' },
    agentImpl: mk('low', 'low'),
  })
  assert.ok(result.plan, 'draft-mode -> plan')
  for (const l of ['frame', 'reconcile']) assert.equal(calls.filter((c) => c.opts.label === l).length, 0, `no ${l} call in draft mode`)
  assert.equal(calls.filter((c) => c.opts.label?.startsWith('advise:')).length, 0, 'no advise calls in draft mode')
  assert.equal(calls.filter((c) => c.opts.label === 'draft').length, 1, 'exactly one draft call')
}
console.log('routing tests: PASS')
