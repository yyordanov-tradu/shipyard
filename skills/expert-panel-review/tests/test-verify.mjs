import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'

const F = (severity, title) => ({
  severity,
  file: 'a.py',
  line: 1,
  title,
  detail: 'd',
  suggestion: 's',
})

// Canned behavior:
// - backend lane returns 6 findings: a Critical that skeptics refute ("drop-me"),
//   a High that survives ("keep-me"), a Medium ("medium-pass"), a High where
//   one skeptic errors ("flaky-verify"), and two Minors ("minor-keep", "minor-drop").
// - performance lane THROWS (a failed expert).
// - security lane returns NULL (a skipped agent) — must also land in failedExperts.
// - every other review lane returns no findings.
// - skeptics: refute "drop-me"; for "flaky-verify" skeptic #1 throws, #2 refutes,
//   #3 confirms; everything else is not refuted.
// - selfcheck: "minor-keep" → grounded:true; "minor-drop" → grounded:false.
// - dedup: echo the findings back unchanged (no merging needed in this canned set).
// - synthesis returns a markdown string.
const agentImpl = async (prompt, opts) => {
  const label = opts.label ?? ''
  if (label === 'review:backend-architect')
    return {
      findings: [
        F('Critical', 'drop-me'),
        F('High', 'keep-me'),
        F('Medium', 'medium-pass'),
        F('High', 'flaky-verify'),
        F('Minor', 'minor-keep'),
        F('Minor', 'minor-drop'),
      ],
    }
  if (label === 'review:performance-engineer') throw new Error('boom')
  if (label === 'review:security-auditor') return null
  if (label.startsWith('review:')) return { findings: [] }
  if (label.startsWith('selfcheck:')) {
    if (prompt.includes('"title":"minor-keep"'))
      return { grounded: true, reason: 'confirmed' }
    if (prompt.includes('"title":"minor-drop"'))
      return { grounded: false, reason: 'cannot confirm' }
    return { grounded: false, reason: 'unknown' }
  }
  if (label === 'dedup') {
    // Echo the findings back unchanged — no duplicates in this canned set.
    const marker = 'FINDINGS JSON:\n'
    const idx = prompt.indexOf(marker)
    const findings = JSON.parse(prompt.slice(idx + marker.length))
    return { findings }
  }
  if (label === 'ledger')
    return {
      ledger: [
        { claim: 'null format falls back to CSV', status: 'verified', evidence: 'resolveDefaultFormat returns CSV' },
      ],
    }
  if (label.startsWith('skeptic:')) {
    if (prompt.includes('"title":"drop-me"'))
      return { refuted: true, reason: 'cannot confirm' }
    if (prompt.includes('"title":"flaky-verify"')) {
      if (prompt.includes('skeptic #1')) throw new Error('skeptic crashed')
      if (prompt.includes('skeptic #2')) return { refuted: true, reason: 'not convinced' }
      return { refuted: false, reason: 'confirmed' }
    }
    return { refuted: false, reason: 'confirmed in diff' }
  }
  return '# Expert Panel Review — test'
}

const { result, calls } = await runWorkflow(SCRIPT, {
  args: {
    diff: 'fake diff content',
    changedFiles: ['a.py'],
    rules: 'some rule',
    date: '2026-06-11',
  },
  agentImpl,
})

// Skeptics run for Critical, High, AND Medium findings only.
// Minor findings use a single selfcheck agent, not skeptics.
// 4 skeptic-path findings (drop-me Critical, keep-me High, flaky-verify High, medium-pass Medium)
// × 3 skeptics = 12 skeptic calls total.
const skepticCalls = calls.filter((c) => c.opts.label?.startsWith('skeptic:'))
assert.equal(skepticCalls.length, 12, `expected 12 skeptic calls, got ${skepticCalls.length}`)

// Exactly 2 selfcheck calls: one per Minor finding.
const selfcheckCalls = calls.filter((c) => c.opts.label?.startsWith('selfcheck:'))
assert.equal(selfcheckCalls.length, 2, `expected 2 selfcheck calls, got ${selfcheckCalls.length}`)

// The refuted Critical is gone; both Highs survived; the Medium also survived; minor-keep survived.
const titles = result.findings.map((f) => f.title).sort()
assert.deepEqual(titles, ['flaky-verify', 'keep-me', 'medium-pass', 'minor-keep'])

// minor-keep survives with self-checked verification.
const minorKeep = result.findings.find((f) => f.title === 'minor-keep')
assert.equal(minorKeep.verification, 'self-checked')

// minor-drop is absent (grounding check returned grounded:false).
assert(!result.findings.some((f) => f.title === 'minor-drop'), 'minor-drop should be absent')

const high = result.findings.find((f) => f.title === 'keep-me')
assert.equal(high.verification, 'survived 3/3 skeptics')

// medium-pass now goes through 3 skeptics (Medium is now in VERIFY_SEVERITIES).
const med = result.findings.find((f) => f.title === 'medium-pass')
assert.equal(med.verification, 'survived 3/3 skeptics')

// One skeptic errored (does not vote): 2 valid votes, 1 refute -> kept, honest label.
const flaky = result.findings.find((f) => f.title === 'flaky-verify')
assert.equal(flaky.verification, 'survived 1/2 skeptics')

// Surviving Highs make the verdict REQUEST-CHANGES.
assert.equal(result.verdict, 'REQUEST-CHANGES')

// BOTH failure shapes are reported: the throwing lane AND the null-returning lane.
assert.deepEqual(result.failedExperts, ['performance-engineer', 'security-auditor'])
assert.equal(typeof result.report, 'string')
assert(result.report.includes('Expert Panel Review'))

// Surviving findings carry their lane's expert tag (synthesis groups by it).
assert.equal(high.expert, 'backend-architect')

// The synthesis prompt interpolates the failed experts and the survivors —
// and NOT the dropped finding.
const synth = calls.find((c) => c.opts.label === 'synthesize')
assert(synth.prompt.includes('performance-engineer, security-auditor'))
assert(synth.prompt.includes('flaky-verify'))
assert(!synth.prompt.includes('drop-me'))

// Verification ledger (v3, Gap B): runs once, is returned, and reaches synthesis.
const ledgerCalls = calls.filter((c) => c.opts.label === 'ledger')
assert.equal(ledgerCalls.length, 1, `expected 1 ledger call, got ${ledgerCalls.length}`)
assert(Array.isArray(result.ledger) && result.ledger.length === 1, 'result.ledger present')
assert.equal(result.ledger[0].status, 'verified')
assert(synth.prompt.includes('VERIFICATION LEDGER JSON'), 'synthesis carries the ledger')
assert(synth.prompt.includes('null format falls back to CSV'), 'ledger claim reaches synthesis')

// ===== Scenario 2 (v3, Gap A): a red CI run forces REQUEST-CHANGES even with no findings =====
const cleanImpl = async (prompt, opts) => {
  const label = opts.label ?? ''
  if (label.startsWith('review:')) return { findings: [] }
  if (label === 'ledger') return { ledger: [] }
  return '# Expert Panel Review — test'
}
const red = await runWorkflow(SCRIPT, {
  args: {
    diff: 'fake diff content',
    changedFiles: ['a.py'],
    rules: 'some rule',
    date: '2026-06-11',
    ciStatus: 'test\tfail\t4m\thttps://x/job',
  },
  agentImpl: cleanImpl,
})
// No findings at all, but red CI must override the otherwise-APPROVE verdict.
assert.equal(red.result.verdict, 'REQUEST-CHANGES', 'red CI must force REQUEST-CHANGES')
const redSynth = red.calls.find((c) => c.opts.label === 'synthesize')
assert(redSynth.prompt.includes('CI STATUS'), 'synthesis prompt carries CI status')
assert(redSynth.prompt.includes('A CHECK IS FAILING'), 'red CI is flagged to the synthesizer')
// Sanity: with zero findings, dedup is skipped but the ledger still runs.
assert.equal(
  red.calls.filter((c) => c.opts.label === 'ledger').length,
  1,
  'ledger runs even with zero findings'
)

console.log('verify tests: PASS')
