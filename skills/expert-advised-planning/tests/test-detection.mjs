import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'
const fake = async (prompt, opts) => {
  if (opts.label === 'frame') return { problem: 'p', keyDecisions: [] }
  if (opts.label?.startsWith('advise:')) return { recommendations: [] }
  if (opts.label === 'reconcile') return { conflicts: [] }
  if (opts.label === 'draft') return '# Plan\n'
  return null
}
const adviseKeys = (calls) =>
  calls.filter((c) => c.opts.label?.startsWith('advise:')).map((c) => c.opts.label.slice(7))
{
  const { calls } = await runWorkflow(SCRIPT, { args: { source: 'a plain feature', projectLangs: [], date: '' }, agentImpl: fake })
  for (const k of ['architecture', 'test-strategy', 'security', 'performance'])
    assert.ok(adviseKeys(calls).includes(k), `missing always-on: ${k}`)
}
{
  const { calls } = await runWorkflow(SCRIPT, { args: { source: 'touch `src/x.py` and `web/app.tsx`', projectLangs: ['go'], date: '' }, agentImpl: fake })
  const keys = adviseKeys(calls)
  assert.ok(keys.includes('python-pro'), '.py -> python-pro')
  assert.ok(keys.includes('typescript-pro'), '.tsx -> typescript-pro')
  assert.ok(keys.includes('golang-pro'), 'project go -> golang-pro')
}
{
  const { calls } = await runWorkflow(SCRIPT, { args: { source: 'add a migration and a new table; render a React component', projectLangs: [], date: '' }, agentImpl: fake })
  const keys = adviseKeys(calls)
  assert.ok(keys.includes('database-optimizer'), 'migration/table -> database')
  assert.ok(keys.includes('frontend-developer'), 'React/component -> frontend')
}
{
  const { calls } = await runWorkflow(SCRIPT, { args: { source: 'x', extraExperts: ['integration-expert'], projectLangs: [], date: '' }, agentImpl: fake })
  assert.ok(adviseKeys(calls).includes('integration-expert'), '--add integration-expert')
}
{
  const { calls } = await runWorkflow(SCRIPT, { args: { source: 'x', rosterOverride: ['security-auditor'], projectLangs: [], date: '' }, agentImpl: fake })
  assert.deepEqual(adviseKeys(calls).sort(), ['security-auditor'])
}
console.log('detection tests: PASS')
