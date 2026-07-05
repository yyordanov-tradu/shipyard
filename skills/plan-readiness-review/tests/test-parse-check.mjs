import assert from 'node:assert/strict'
import { runWorkflow, SCRIPT } from './harness.mjs'

// The gate must not pass a plan the implement stage cannot machine-read.
// The skill runs the canonical parser (plan-parse.mjs) and passes the task
// count as args.planTaskCount; 0 parsed tasks forces NEEDS-WORK.

// A clean panel: no gaps, full coverage — READY unless the parse check bites.
const cleanFake = async (prompt, opts) => {
  if (opts.label === 'review:alignment')
    return {
      gaps: [],
      matrix: { requirements: [{ id: 'R1', text: 'x', coveredBy: ['Task 1'], status: 'covered' }], orphanPlanSteps: [] },
    }
  if (opts.label?.startsWith('review:')) return { gaps: [], matrix: null }
  if (opts.label?.startsWith('debate:')) return { reactions: [] }
  if (opts.label === 'decide') return null
  return null
}

// planTaskCount: 0 -> the plan is not machine-readable -> NEEDS-WORK, and the report says why.
{
  const { result } = await runWorkflow(SCRIPT, {
    args: { spec: 'x', plan: '## Task 1 wrong heading', projectLangs: [], date: '', planTaskCount: 0 },
    agentImpl: cleanFake,
  })
  assert.equal(result.verdict, 'NEEDS-WORK', 'zero parsed tasks -> NEEDS-WORK')
  assert.ok(/machine-readab|plan-parse|### Task/i.test(result.report), 'report explains the format failure')
}

// planTaskCount > 0 -> no effect; clean panel stays READY.
{
  const { result } = await runWorkflow(SCRIPT, {
    args: { spec: 'x', plan: '### Task 1: ok', projectLangs: [], date: '', planTaskCount: 3 },
    agentImpl: cleanFake,
  })
  assert.equal(result.verdict, 'READY', 'parsed tasks present -> unchanged verdict')
}

// planTaskCount absent (old callers) -> backward compatible, no effect.
{
  const { result } = await runWorkflow(SCRIPT, {
    args: { spec: 'x', plan: 'y', projectLangs: [], date: '' },
    agentImpl: cleanFake,
  })
  assert.equal(result.verdict, 'READY', 'check not run -> verdict unchanged')
}

console.log('parse-check tests: PASS')
