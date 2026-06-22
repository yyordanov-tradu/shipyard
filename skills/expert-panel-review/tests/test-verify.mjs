import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'

// Stage 4: verify by EVIDENCE. Drop only on CITED counter-evidence; Critical/High are never
// dropped (cited-refuted -> "suppressed" but still blocking); cross-file findings are verified
// with their causeFiles in scope.
const F = (severity, title, extra = {}) => ({ severity, file: 'a.py', line: 1, title, detail: 'd', suggestion: 's', ...extra })

const agentImpl = async (prompt, opts) => {
  const label = opts.label ?? ''
  if (label === 'review:unit:a.py')
    return { findings: [
      F('Critical', 'cross-file-bug', { causeFiles: ['other.py'] }),
      F('High', 'plausible-high'),
      F('Medium', 'drop-me-medium'),
      F('Critical', 'suppressed-crit'),
      F('Medium', 'keep-medium-nocite'),
    ] }
  if (label.startsWith('review:')) return { findings: [] } // cross-cutting reviewers: clean
  if (label === 'ledger') return { ledger: [] }
  if (label.startsWith('verify:')) {
    if (prompt.includes('"title":"cross-file-bug"')) return { classification: 'confirmed', citation: 'other.py:5', reason: 'proven cross-file' }
    if (prompt.includes('"title":"plausible-high"')) return { classification: 'plausible', citation: '', reason: 'cannot cite' }
    if (prompt.includes('"title":"drop-me-medium"')) return { classification: 'refuted', citation: 'a.py:1 already guarded', reason: 'not a problem' }
    if (prompt.includes('"title":"suppressed-crit"')) return { classification: 'refuted', citation: 'a.py:2 safe', reason: 'looks fine' }
    if (prompt.includes('"title":"keep-medium-nocite"')) return { classification: 'refuted', citation: '', reason: 'maybe' } // no citation
    return { classification: 'plausible', citation: '', reason: 'x' }
  }
  return '# Expert Panel Review — test'
}

const { result, calls } = await runWorkflow(SCRIPT, {
  args: { diff: 'fake', changedFiles: ['a.py'], rules: '', date: '2026-06-11' },
  agentImpl,
})

// Cross-file: the verify prompt for the Critical includes its causeFiles (lesson-B regression guard).
const xfile = calls.find((c) => c.opts.label?.startsWith('verify:') && c.prompt.includes('"title":"cross-file-bug"'))
assert.ok(xfile.prompt.includes('other.py'), 'verify of a cross-file finding includes its causeFiles')

// Verifier counts: Critical/High -> criticalRefuters (2); Medium -> 1.
const vCount = (t) => calls.filter((c) => c.opts.label?.startsWith('verify:') && c.prompt.includes(`"title":"${t}"`)).length
assert.equal(vCount('cross-file-bug'), 2, 'Critical -> 2 verifiers')
assert.equal(vCount('plausible-high'), 2, 'High -> 2 verifiers')
assert.equal(vCount('drop-me-medium'), 1, 'Medium -> 1 verifier')

// drop-me-medium dropped (1 cited refute); everything else kept.
assert.deepEqual(
  result.findings.map((f) => f.title).sort(),
  ['cross-file-bug', 'keep-medium-nocite', 'plausible-high', 'suppressed-crit']
)
// A refute WITHOUT a citation does not drop.
assert.ok(result.findings.some((f) => f.title === 'keep-medium-nocite'), 'uncited refute keeps the finding')
// A cited-refuted Critical is suppressed but kept, and still blocks.
const sup = result.findings.find((f) => f.title === 'suppressed-crit')
assert.ok(/suppressed/.test(sup.verification), 'cited-refuted Critical -> suppressed (not dropped)')
assert.equal(result.findings.find((f) => f.title === 'cross-file-bug').verification, 'confirmed')
assert.equal(result.verdict, 'REQUEST-CHANGES', 'a Critical (even suppressed) blocks')

// Red CI with zero findings still forces REQUEST-CHANGES.
const clean = async (p, o) => {
  const l = o.label ?? ''
  if (l.startsWith('review:')) return { findings: [] }
  if (l === 'ledger') return { ledger: [] }
  return '# report'
}
const red = await runWorkflow(SCRIPT, { args: { diff: 'fake', changedFiles: ['a.py'], rules: '', date: '', ciStatus: 'test\tfail\t4m\thttps://x' }, agentImpl: clean })
assert.equal(red.result.verdict, 'REQUEST-CHANGES', 'red CI forces REQUEST-CHANGES')

console.log('verify tests: PASS')
