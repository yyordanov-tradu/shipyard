import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'
const base = (arb) => async (prompt, opts) => {
  if (opts.label === 'frame') return { problem: 'p', keyDecisions: [] }
  if (opts.label?.startsWith('advise:')) return { recommendations: [{ id: 'r1', text: 't', rationale: 'r' }] }
  if (opts.label === 'reconcile') return { conflicts: [{ kind: 'expert-expert', summary: 'cache vs no-cache', positions: [{ party: 'performance', stance: 'cache' }, { party: 'architecture', stance: 'no cache' }] }] }
  if (opts.label?.startsWith('arbitrate:')) return arb(opts)
  if (opts.label === 'draft') return '# Plan\n'
  return null
}
// arbiter is structurally neutral: its call must carry NO agentType.
{
  const { calls } = await runWorkflow(SCRIPT, { args: { source: 'x', projectLangs: [], date: '' }, agentImpl: base(() => ({ resolution: 'cache', rationale: 'hot path', confidence: 'high', stakes: 'low' })) })
  assert.equal(calls.filter((c) => c.opts.label === 'reconcile').length, 1, 'one reconcile call')
  const arb = calls.filter((c) => c.opts.label?.startsWith('arbitrate:'))
  assert.equal(arb.length, 1, 'one arbiter call per conflict')
  assert.ok(!arb[0].opts.agentType, 'arbiter must run with NO agentType (structural neutrality)')
}
// arbiter failure must not drop the conflict: it ends up escalated.
{
  const { result } = await runWorkflow(SCRIPT, { args: { source: 'x', projectLangs: [], date: '' }, agentImpl: base(() => { throw new Error('boom') }) })
  assert.equal(result.escalations.length, 1, 'arbiter failure -> conflict escalates, not dropped')
}
console.log('reconcile tests: PASS')
