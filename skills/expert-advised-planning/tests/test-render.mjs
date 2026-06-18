import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'
const fake = async (prompt, opts) => {
  if (opts.label === 'frame') return { problem: 'p', keyDecisions: [] }
  if (opts.label?.startsWith('advise:')) return { recommendations: [{ id: 'r', text: 'use existing validator', rationale: 'dry' }] }
  if (opts.label === 'reconcile') return { conflicts: [{ kind: 'expert-expert', summary: 'cache vs no-cache', positions: [{ party: 'a', stance: 'x' }, { party: 'b', stance: 'y' }] }] }
  if (opts.label?.startsWith('arbitrate:')) return { resolution: 'use a cache', rationale: 'hot path', confidence: 'high', stakes: 'low' }
  if (opts.label === 'draft') return '# Feature Plan\n\n**Goal:** x\n\n### Task 1\n- [ ] step\n'
  return null
}
const { result } = await runWorkflow(SCRIPT, { args: { source: 'x', sourceRef: 'docs/specs/foo.md', graphMode: 'fallback', projectLangs: [], date: '2026-06-16' }, agentImpl: fake })
assert.ok(result.plan.includes('# Feature Plan'), 'keeps drafted body')
assert.ok(/- \[ \]/.test(result.plan), 'output-shape: plan-format checkbox markers present')
assert.ok(result.plan.includes('## Decisions & trade-offs'), 'decisions section present')
assert.ok(result.plan.includes('cache vs no-cache'), 'conflict recorded')
assert.ok(result.plan.includes('## Adviser provenance'), 'provenance section present')
assert.ok(result.plan.includes('fallback'), 'graph-fallback mode recorded in provenance')
assert.ok(result.plan.includes('docs/specs/foo.md'), 'source ref present')
assert.equal(result.escalations.length, 0, 'no escalations in happy path')
console.log('render tests: PASS')
