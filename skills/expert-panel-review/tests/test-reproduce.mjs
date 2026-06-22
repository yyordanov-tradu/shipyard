import assert from 'node:assert/strict'
import { runWorkflow, SCRIPT } from './harness.mjs'

const impl = (verifyClass) => async (prompt, opts) => {
  const l = opts.label ?? ''
  if (l === 'review:unit:a.py') return { findings: [{ severity: 'High', file: 'a.py', line: 1, title: 'bug', detail: 'd', suggestion: 's' }] }
  if (l.startsWith('review:')) return { findings: [] }
  if (l === 'ledger') return { ledger: [] }
  if (l.startsWith('verify:')) return { classification: verifyClass, citation: verifyClass === 'reproduced' ? 'npm test' : '', reason: 'r' }
  return '# report'
}

// With a test command: the verify prompt offers reproduction; a reproduced verdict is labeled
// and the report shows the command.
{
  const { result, calls } = await runWorkflow(SCRIPT, {
    args: { diff: 'fake', changedFiles: ['a.py'], rules: '', date: '', testCommand: 'npm test' },
    agentImpl: impl('reproduced'),
  })
  const v = calls.find((c) => c.opts.label?.startsWith('verify:'))
  assert.ok(/REPRODUCE/.test(v.prompt) && v.prompt.includes('npm test'), 'verify prompt offers reproduction with the command')
  assert.equal(result.findings.find((f) => f.title === 'bug').verification, 'reproduced', 'reproduced verdict labels the finding')
  assert.ok(result.report.includes('npm test'), 'report shows the reproduce command')
}

// Without a test command: reproduction is announced unavailable (never blocks on its absence).
{
  const { calls } = await runWorkflow(SCRIPT, {
    args: { diff: 'fake', changedFiles: ['a.py'], rules: '', date: '' },
    agentImpl: impl('confirmed'),
  })
  const v = calls.find((c) => c.opts.label?.startsWith('verify:'))
  assert.ok(/reproduction is unavailable/.test(v.prompt), 'no test command -> reproduction announced unavailable')
}

console.log('reproduce (engine) tests: PASS')
