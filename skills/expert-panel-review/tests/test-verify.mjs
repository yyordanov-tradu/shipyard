import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'

// Interim verify (skeptic-based) over the per-unit review model. (Stage 4 becomes
// classify-by-evidence in a later task; this guards the skeptic flow until then.)
const F = (severity, title) => ({ severity, file: 'a.py', line: 1, title, detail: 'd', suggestion: 's' })

const agentImpl = async (prompt, opts) => {
  const label = opts.label ?? ''
  // unit a.py raises the canned findings; unit b.py FAILS (null) -> failed unit.
  if (label === 'review:unit:a.py')
    return { findings: [F('Critical', 'drop-me'), F('High', 'keep-me'), F('Medium', 'medium-pass'), F('High', 'flaky-verify'), F('Minor', 'minor-keep'), F('Minor', 'minor-drop')] }
  if (label === 'review:unit:b.py') return null
  if (label.startsWith('review:')) return { findings: [] }
  if (label.startsWith('selfcheck:')) {
    if (prompt.includes('"title":"minor-keep"')) return { grounded: true, reason: 'confirmed' }
    if (prompt.includes('"title":"minor-drop"')) return { grounded: false, reason: 'cannot confirm' }
    return { grounded: false, reason: 'unknown' }
  }
  if (label === 'dedup') {
    const marker = 'FINDINGS JSON:\n'
    return { findings: JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length)) }
  }
  if (label === 'ledger')
    return { ledger: [{ claim: 'null format falls back to CSV', status: 'verified', evidence: 'resolveDefaultFormat returns CSV' }] }
  if (label.startsWith('skeptic:')) {
    if (prompt.includes('"title":"drop-me"')) return { refuted: true, reason: 'cannot confirm' }
    if (prompt.includes('"title":"flaky-verify"')) {
      if (prompt.includes('skeptic #1')) throw new Error('skeptic crashed')
      if (prompt.includes('skeptic #2')) return { refuted: true, reason: 'not convinced' }
      return { refuted: false, reason: 'confirmed' }
    }
    return { refuted: false, reason: 'confirmed in change' }
  }
  return '# Expert Panel Review — test'
}

const { result, calls } = await runWorkflow(SCRIPT, {
  args: { diff: 'fake', changedFiles: ['a.py', 'b.py'], rules: '', date: '2026-06-11' },
  agentImpl,
})

// 4 C/H/M findings × 3 skeptics = 12; 2 Minors × 1 self-check = 2.
assert.equal(calls.filter((c) => c.opts.label?.startsWith('skeptic:')).length, 12, 'expected 12 skeptic calls')
assert.equal(calls.filter((c) => c.opts.label?.startsWith('selfcheck:')).length, 2, 'expected 2 selfcheck calls')

// Refuted Critical dropped; both Highs + the Medium + minor-keep survive.
assert.deepEqual(result.findings.map((f) => f.title).sort(), ['flaky-verify', 'keep-me', 'medium-pass', 'minor-keep'])
assert.equal(result.findings.find((f) => f.title === 'flaky-verify').verification, 'survived 1/2 skeptics')
assert.equal(result.verdict, 'REQUEST-CHANGES', 'surviving Highs -> REQUEST-CHANGES')

// A failed UNIT is tracked (not treated as clean).
assert.deepEqual(result.failedExperts, ['unit:b.py'])

// Synthesis carries the failed unit, the ledger, and survivors — but not the dropped finding.
const synth = calls.find((c) => c.opts.label === 'synthesize')
assert(synth.prompt.includes('unit:b.py'))
assert(synth.prompt.includes('flaky-verify') && !synth.prompt.includes('drop-me'))
assert(synth.prompt.includes('VERIFICATION LEDGER JSON') && synth.prompt.includes('null format falls back to CSV'))

// Scenario 2: a red CI run forces REQUEST-CHANGES even with zero findings.
const cleanImpl = async (prompt, opts) => {
  const label = opts.label ?? ''
  if (label.startsWith('review:')) return { findings: [] }
  if (label === 'ledger') return { ledger: [] }
  return '# Expert Panel Review — test'
}
const red = await runWorkflow(SCRIPT, {
  args: { diff: 'fake', changedFiles: ['a.py'], rules: '', date: '2026-06-11', ciStatus: 'test\tfail\t4m\thttps://x/job' },
  agentImpl: cleanImpl,
})
assert.equal(red.result.verdict, 'REQUEST-CHANGES', 'red CI must force REQUEST-CHANGES')
assert(red.calls.find((c) => c.opts.label === 'synthesize').prompt.includes('A CHECK IS FAILING'))

console.log('verify tests: PASS')
