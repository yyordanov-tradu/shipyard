import assert from 'node:assert/strict'
import { runWorkflow, SCRIPT } from './harness.mjs'

// CI-coverage audit: a green check is a claim to audit, not a fact to trust.
// When ciConfig is passed, the integration lane and the ledger must be told to audit
// what each green check actually verifies; when it is absent, nothing changes
// (backward compatible — old callers pass no ciConfig).

const CHANGED = ['src/index.ts']
const CI_CONFIG = '=== .github/workflows/ci.yml ===\njobs:\n  build:\n    run: npm run build && test -f dist/index.js'
const CI_STATUS = 'build\tpass\t2m\thttps://x'

const cleanImpl = async (p, o) => {
  const l = o.label ?? ''
  return l.startsWith('review:') ? { findings: [] } : (l === 'ledger' ? { ledger: [] } : 'ok')
}

// 1) With ciConfig: the integration lane gets the audit instruction + the config + the
//    check results, and stays static (no build).
{
  const { calls } = await runWorkflow(SCRIPT, {
    args: { diff: 'fake', changedFiles: CHANGED, rules: '', date: '', ciStatus: CI_STATUS, ciConfig: CI_CONFIG },
    agentImpl: cleanImpl,
  })
  const byLabel = (l) => calls.find((c) => c.opts.label === l)
  const integration = byLabel('review:xcut:integration')
  assert.ok(integration.prompt.includes('CI-COVERAGE AUDIT'), 'integration lane gets the audit lens')
  assert.ok(integration.prompt.includes('test -f dist/index.js'), 'integration lane sees the CI config')
  assert.ok(integration.prompt.includes(CI_STATUS), 'integration lane sees the check results')
  assert.ok(integration.prompt.includes('do NOT run the build'), 'audit is static-only')

  // The audit lens belongs to the integration lane only — other lanes stay focused.
  assert.ok(!byLabel('review:xcut:security').prompt.includes('CI-COVERAGE AUDIT'), 'security lane unchanged')

  const ledger = byLabel('ledger')
  assert.ok(ledger.prompt.includes('Green CI checks'), 'ledger audits green checks as load-bearing claims')
  assert.ok(ledger.prompt.includes('test -f dist/index.js'), 'ledger sees the CI config')
}

// 2) Without ciConfig: no audit block anywhere; ciStatus alone still reaches the ledger
//    (check results are auditable data even without the config).
{
  const { calls } = await runWorkflow(SCRIPT, {
    args: { diff: 'fake', changedFiles: CHANGED, rules: '', date: '', ciStatus: CI_STATUS },
    agentImpl: cleanImpl,
  })
  const byLabel = (l) => calls.find((c) => c.opts.label === l)
  assert.ok(!byLabel('review:xcut:integration').prompt.includes('CI-COVERAGE AUDIT'), 'no config -> no audit lens')
  assert.ok(byLabel('ledger').prompt.includes(CI_STATUS), 'ledger still sees check results')
}

// 3) Fully absent (old callers): prompts are free of any CI block.
{
  const { calls } = await runWorkflow(SCRIPT, {
    args: { diff: 'fake', changedFiles: CHANGED, rules: '', date: '' },
    agentImpl: cleanImpl,
  })
  const byLabel = (l) => calls.find((c) => c.opts.label === l)
  assert.ok(!byLabel('review:xcut:integration').prompt.includes('CI-COVERAGE AUDIT'), 'backward compatible')
  assert.ok(!byLabel('ledger').prompt.includes('Green CI checks'), 'ledger unchanged without CI data')
}

// 4) The audit is prompt-only: a green check NEVER flips the verdict by itself
//    (only parseCiRed red states do — pinned elsewhere in test-verify.mjs).
{
  const { result } = await runWorkflow(SCRIPT, {
    args: { diff: 'fake', changedFiles: CHANGED, rules: '', date: '', ciStatus: CI_STATUS, ciConfig: CI_CONFIG },
    agentImpl: cleanImpl,
  })
  assert.equal(result.verdict, 'APPROVE', 'green CI + config with zero findings still APPROVE')
}

console.log('ci-audit tests: PASS')
