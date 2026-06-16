import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'
const fake = async (prompt, opts) => {
  if (opts.label === 'frame') return { problem: 'add rate limiting', keyDecisions: [{ id: 'D1', question: 'token bucket or fixed window?' }] }
  if (opts.label === 'advise:security') return { recommendations: [{ id: 's1', text: 'key by user not IP', rationale: 'shared NAT' }] }
  if (opts.label?.startsWith('advise:')) return { recommendations: [] }
  if (opts.label === 'reconcile') return { conflicts: [{ kind: 'expert-expert', summary: 'per-IP vs per-user keying', positions: [{ party: 'security', stance: 'per-user' }, { party: 'performance', stance: 'per-IP' }] }] }
  if (opts.label?.startsWith('arbitrate:')) return { resolution: 'per-user keying', rationale: 'correctness over micro-perf', confidence: 'high', stakes: 'med' }
  if (opts.label === 'draft') return '# Rate Limiting Plan\n\n**Goal:** add rate limiting\n\n### Task 1\n- [ ] step\n'
  return null
}
const { result } = await runWorkflow(SCRIPT, { args: { source: 'add API rate limiting', sourceRef: 'TICKET-42', projectLangs: ['ts'], graphMode: 'graphify', date: '2026-06-16' }, agentImpl: fake })
assert.ok(result.plan, 'produces a plan')
assert.ok(result.plan.includes('per-IP vs per-user keying'), 'records the resolved conflict')
assert.ok(result.plan.includes('per-user keying'), 'records the resolution')
assert.ok(result.panel.includes('typescript-pro'), 'ts project pulled in the language adviser')
assert.equal(result.escalations.length, 0, 'med stakes + high confidence => no escalation')
console.log('smoke test: PASS')
