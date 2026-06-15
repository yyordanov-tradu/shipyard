import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'

// Every expert returns one trivial gap; decide returns a minimal decision object.
const fake = async (prompt, opts) => {
  if (opts.label?.startsWith('review:')) return { gaps: [], matrix: null }
  if (opts.label?.startsWith('debate:')) return { reactions: [] }
  if (opts.label === 'decide')
    return { verdict: 'READY', report: '# Plan Readiness Review\n\nREADY', consensus: [] }
  return null
}

const { result } = await runWorkflow(SCRIPT, {
  args: { spec: 'S', plan: 'P', rules: '', designDocs: '', projectLangs: [], date: '2026-06-14' },
  agentImpl: fake,
})
assert.ok(result && typeof result.report === 'string', 'workflow must return a report string')
assert.ok(['READY', 'NEEDS-WORK', 'MISALIGNED'].includes(result.verdict), 'valid verdict')
console.log('smoke test: PASS')
