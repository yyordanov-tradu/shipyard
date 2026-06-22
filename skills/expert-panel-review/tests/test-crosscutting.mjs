import assert from 'node:assert/strict'
import { runWorkflow, SCRIPT } from './harness.mjs'

const CHANGED = ['svc/a.py', 'svc/b.py']

// 1) The cross-cutting tier runs over the whole change, with the edge/degrade instruction.
{
  const { calls } = await runWorkflow(SCRIPT, {
    args: { diff: 'fake', changedFiles: CHANGED, rules: 'no secrets in code', date: '' },
    agentImpl: async (p, o) => {
      const l = o.label ?? ''
      return l.startsWith('review:') ? { findings: [] } : (l === 'ledger' ? { ledger: [] } : 'ok')
    },
  })
  const xcut = (k) => calls.find((c) => c.opts.label === `review:xcut:${k}`)
  for (const k of ['security', 'integration', 'architecture', 'performance', 'compliance'])
    assert.ok(xcut(k), `cross-cutting reviewer ${k} runs`)
  assert.ok(xcut('security').prompt.includes('svc/a.py') && xcut('security').prompt.includes('svc/b.py'), 'xcut reviews the whole change')
  assert.ok(/graphify/.test(xcut('integration').prompt) && /Serena/.test(xcut('integration').prompt), 'edge block names graphify + Serena')
  assert.ok(xcut('integration').prompt.includes('file-level edges only'), 'degrade-announce instruction present')
  assert.ok(xcut('compliance').prompt.includes('no secrets in code'), 'compliance reviewer gets the project rules')
}

// 2) A failed SECURITY reviewer (failure-blocking) forces REQUEST-CHANGES with zero findings.
{
  const impl = async (p, o) => {
    const l = o.label ?? ''
    if (l === 'review:xcut:security') return null
    if (l.startsWith('review:')) return { findings: [] }
    if (l === 'ledger') return { ledger: [] }
    return 'ok'
  }
  const { result } = await runWorkflow(SCRIPT, { args: { diff: 'fake', changedFiles: CHANGED, rules: '', date: '' }, agentImpl: impl })
  assert.equal(result.verdict, 'REQUEST-CHANGES', 'failed security (blocking) -> REQUEST-CHANGES')
  assert.ok(result.failedExperts.includes('xcut:security'))
}

// 3) A failed PERFORMANCE reviewer (non-blocking) is recorded but does NOT auto-block.
{
  const impl = async (p, o) => {
    const l = o.label ?? ''
    if (l === 'review:xcut:performance') return null
    if (l.startsWith('review:')) return { findings: [] }
    if (l === 'ledger') return { ledger: [] }
    return 'ok'
  }
  const { result } = await runWorkflow(SCRIPT, { args: { diff: 'fake', changedFiles: CHANGED, rules: '', date: '' }, agentImpl: impl })
  assert.equal(result.verdict, 'APPROVE', 'failed performance (non-blocking) does not force REQUEST-CHANGES')
  assert.ok(result.failedExperts.includes('xcut:performance'), 'still recorded as failed')
}

console.log('crosscutting tests: PASS')
