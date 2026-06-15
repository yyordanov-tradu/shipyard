import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'

// Stub: every review lane returns zero findings; synthesis returns a string.
const emptyFindings = async (prompt, opts) =>
  opts.label?.startsWith('review:') ? { findings: [] } : 'No significant issues.'

const reviewTypes = (calls) =>
  calls
    .filter((c) => c.opts.label?.startsWith('review:'))
    .map((c) => c.opts.label.slice('review:'.length))

// 1) Python + CDK TypeScript diff: both language experts, NO frontend expert
//    (cdk is infra), compliance present because rules are non-empty.
{
  const { calls } = await runWorkflow(SCRIPT, {
    args: {
      diff: 'fake diff',
      changedFiles: ['app/finops/tools/cost.py', 'agentcore/cdk/lib/stack.ts'],
      rules: 'rule: read-only only',
      date: '2026-06-11',
    },
    agentImpl: emptyFindings,
  })
  const types = reviewTypes(calls)
  for (const t of [
    'backend-architect',
    'qa-automation-architect',
    'performance-engineer',
    'security-auditor',
    'python-pro',
    'typescript-pro',
    'compliance',
  ])
    assert(types.includes(t), `missing lane: ${t}`)
  assert(!types.includes('frontend-developer'), 'cdk .ts must not trigger FE')
  assert(!types.includes('database-optimizer'), 'no DB files in diff')
}

// 2) Docs-only diff, empty rules: exactly the 4 always-on engineer lanes
//    (compliance skipped when no rules text exists).
{
  const { calls } = await runWorkflow(SCRIPT, {
    args: { diff: 'fake', changedFiles: ['README.md', 'docs/a.md'], rules: '', date: '' },
    agentImpl: emptyFindings,
  })
  const types = reviewTypes(calls)
  assert.deepEqual(
    types.sort(),
    ['backend-architect', 'performance-engineer', 'qa-automation-architect', 'security-auditor'].sort()
  )
}

// 3) Frontend + SQL diff: FE and DB experts activate.
{
  const { calls } = await runWorkflow(SCRIPT, {
    args: {
      diff: 'fake',
      changedFiles: ['web/app.tsx', 'migrations/001_init.sql'],
      rules: 'r',
      date: '',
    },
    agentImpl: emptyFindings,
  })
  const types = reviewTypes(calls)
  assert(types.includes('frontend-developer'))
  assert(types.includes('database-optimizer'))
  assert(types.includes('typescript-pro'), '.tsx is TypeScript')
}

// 4) Roster override: ONLY the named agents run (no always-on, no compliance).
{
  const { calls } = await runWorkflow(SCRIPT, {
    args: {
      diff: 'fake',
      changedFiles: ['a.py'],
      rosterOverride: ['security-auditor', 'python-pro'],
      rules: 'r',
      date: '',
    },
    agentImpl: emptyFindings,
  })
  assert.deepEqual(reviewTypes(calls).sort(), ['python-pro', 'security-auditor'])
}

// 5) Empty diff: returns an error, calls no agents.
{
  const { result, calls } = await runWorkflow(SCRIPT, {
    args: { diff: '   ', changedFiles: [], rules: '', date: '' },
    agentImpl: emptyFindings,
  })
  assert.equal(result.error, 'empty diff')
  assert.equal(calls.length, 0)
}

// 6) String-delivered args (some harness versions JSON-stringify args): the
//    script must parse and behave identically.
{
  const { result, calls } = await runWorkflow(SCRIPT, {
    args: JSON.stringify({
      diff: 'fake diff',
      changedFiles: ['a.py'],
      rules: 'r',
      date: '2026-06-11',
    }),
    agentImpl: emptyFindings,
  })
  const types = reviewTypes(calls)
  assert(types.includes('python-pro'), 'string args must still detect python')
  assert(types.includes('compliance'), 'string args must still carry rules')
  assert.equal(result.error, undefined)
}

console.log('detection tests: PASS')
