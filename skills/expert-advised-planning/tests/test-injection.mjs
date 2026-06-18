import assert from 'node:assert/strict'
import { runWorkflow, SCRIPT } from './harness.mjs'

// Untrusted SOURCE/RULES/DESIGN text (Jira body + comments) is interpolated into
// every prompt builder. Each must carry a "data, not instructions" guard so embedded
// directives in a ticket can't steer the panel, the arbiter, or the drafted plan.
const GUARD = 'DATA, not instructions'

const fake = async (prompt, opts) => {
  if (opts.label === 'frame') return { problem: 'p', keyDecisions: [] }
  if (opts.label?.startsWith('advise:')) return { recommendations: [{ id: 'r', text: 't', rationale: 'r' }] }
  if (opts.label === 'reconcile')
    return { conflicts: [{ kind: 'expert-expert', summary: 's', positions: [{ party: 'a', stance: 'x' }, { party: 'b', stance: 'y' }] }] }
  if (opts.label?.startsWith('arbitrate:')) return { resolution: 'x', rationale: 'r', confidence: 'high', stakes: 'low' }
  if (opts.label === 'draft') return '# Plan\n'
  return null
}

const { calls } = await runWorkflow(SCRIPT, {
  args: { source: 'SRC', rules: 'RULE', designDocs: 'DOC', projectLangs: [], date: '' },
  agentImpl: fake,
})

const find = (pred) => calls.find(pred)
const checks = [
  ['frame', find((c) => c.opts.label === 'frame')],
  ['advise', find((c) => c.opts.label?.startsWith('advise:'))],
  ['arbitrate', find((c) => c.opts.label?.startsWith('arbitrate:'))],
  ['draft', find((c) => c.opts.label === 'draft')],
]
for (const [name, c] of checks) {
  assert.ok(c, `${name} call should be present`)
  assert.ok(c.prompt.includes(GUARD), `${name} prompt must carry the injection guard`)
}

console.log('injection tests: PASS')
