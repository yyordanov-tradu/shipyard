import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'

const fake = async (prompt, opts) => {
  if (opts.label?.startsWith('review:')) return { gaps: [], matrix: null }
  if (opts.label?.startsWith('debate:')) return { reactions: [] }
  if (opts.label === 'decide') return { verdict: 'READY', report: 'r', consensus: [] }
  return null
}
const reviewKeys = (calls) =>
  calls.filter((c) => c.opts.label?.startsWith('review:')).map((c) => c.opts.label.slice(7))

// 1) Always-on 5 are present even with no signals.
{
  const { calls } = await runWorkflow(SCRIPT, {
    args: { spec: 'a plain feature', plan: 'do the thing', projectLangs: [], date: '' },
    agentImpl: fake,
  })
  const keys = reviewKeys(calls)
  for (const k of ['architecture', 'alignment', 'test-strategy', 'compliance', 'executability'])
    assert.ok(keys.includes(k), `missing always-on: ${k}`)
}

// 2) Language from plan file paths + project langs.
{
  const { calls } = await runWorkflow(SCRIPT, {
    args: {
      spec: 'x', plan: 'Create `src/intake/reader.py` and `web/app.tsx`.',
      projectLangs: ['go'], date: '',
    },
    agentImpl: fake,
  })
  const keys = reviewKeys(calls)
  assert.ok(keys.includes('python-pro'), '.py in plan -> python-pro')
  assert.ok(keys.includes('typescript-pro'), '.tsx in plan -> typescript-pro')
  assert.ok(keys.includes('golang-pro'), 'project go -> golang-pro')
}

// 3) Security + performance keyword scan.
{
  const { calls } = await runWorkflow(SCRIPT, {
    args: {
      spec: 'store the auth token and password securely', plan: 'reduce latency on the hot path',
      projectLangs: [], date: '',
    },
    agentImpl: fake,
  })
  const keys = reviewKeys(calls)
  assert.ok(keys.includes('security-auditor'), 'auth/token -> security')
  assert.ok(keys.includes('performance-engineer'), 'latency -> performance')
}

// 4) No security/perf signals -> those experts absent.
{
  const { calls } = await runWorkflow(SCRIPT, {
    args: { spec: 'rename a label', plan: 'update the text', projectLangs: [], date: '' },
    agentImpl: fake,
  })
  const keys = reviewKeys(calls)
  assert.ok(!keys.includes('security-auditor'))
  assert.ok(!keys.includes('performance-engineer'))
}

// 5) Override: only the named experts run.
{
  const { calls } = await runWorkflow(SCRIPT, {
    args: { spec: 'x', plan: 'y', rosterOverride: ['security-auditor'], projectLangs: [], date: '' },
    agentImpl: fake,
  })
  assert.deepEqual(reviewKeys(calls).sort(), ['security-auditor'])
}

console.log('detection tests: PASS')
