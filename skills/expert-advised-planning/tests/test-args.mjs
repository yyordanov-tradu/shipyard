import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'
const fake = async () => null
{
  const { result } = await runWorkflow(SCRIPT, { args: { source: '', date: '' }, agentImpl: fake })
  assert.equal(result.error, 'missing source', 'empty source must return {error}')
}
console.log('args tests: PASS')
