import assert from 'node:assert/strict'
import { verdictOf, assembleReport } from '../assemble.mjs'

// verdictOf
assert.equal(verdictOf([{ severity: 'Critical' }]), 'REQUEST-CHANGES')
assert.equal(verdictOf([{ severity: 'High' }]), 'REQUEST-CHANGES')
assert.equal(verdictOf([{ severity: 'Medium' }]), 'APPROVE-WITH-NITS')
assert.equal(verdictOf([{ severity: 'Minor' }]), 'APPROVE')
assert.equal(verdictOf([]), 'APPROVE')
assert.equal(verdictOf([], { ciRed: true }), 'REQUEST-CHANGES', 'red CI blocks')
assert.equal(verdictOf([], { blockedByFailure: true }), 'REQUEST-CHANGES', 'failed always-on lane blocks')

// assembleReport is byte-identical for the same input (no LLM -> stable).
const input = {
  findings: [
    { severity: 'Critical', file: 'a.py', line: 5, title: 'sqli', detail: 'd', suggestion: 's', expert: 'security-auditor', verification: 'confirmed', support: 2, causeFiles: ['db.py'] },
    { severity: 'Minor', file: 'b.py', line: 1, title: 'naming', detail: 'd', suggestion: 's', expert: 'python-pro', verification: 'plausible', support: 1 },
  ],
  ledger: [{ claim: 'migration idempotent', status: 'verified', evidence: 'IF NOT EXISTS' }],
  failedExperts: ['xcut:performance'],
  ciStatus: '',
  date: '2026-06-22',
  verdict: 'REQUEST-CHANGES',
}
const r1 = assembleReport(input)
const r2 = assembleReport(input)
assert.equal(r1, r2, 'byte-identical for the same findings')

// content checks
assert.ok(r1.includes('**Verdict:** REQUEST-CHANGES'))
assert.ok(r1.includes('### Blocks merge') && r1.includes('## security-auditor'), 'blockers grouped by expert')
assert.ok(r1.includes('### Follow-up') && r1.includes('## python-pro'), 'follow-ups grouped by expert')
assert.ok(r1.includes('[cause: db.py]') && r1.includes('support 2'), 'cause files + support shown')
assert.ok(r1.includes('### Verified') && r1.includes('migration idempotent'), 'ledger table present')
assert.ok(r1.includes('override a block'), 'override note on REQUEST-CHANGES')
assert.ok(r1.includes('Experts that failed to run: xcut:performance'))

// empty report
const empty = assembleReport({ findings: [], ledger: [], date: '2026-06-22', verdict: 'APPROVE' })
assert.ok(empty.includes('No findings.') && !empty.includes('override a block'))

console.log('assemble tests: PASS')
