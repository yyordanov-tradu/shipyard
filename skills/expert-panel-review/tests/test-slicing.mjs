import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'

// A real 2-file unified diff. Each file carries a unique content marker so we can
// assert which file's changes reached which agent's prompt.
const DIFF = `diff --git a/web/app.tsx b/web/app.tsx
index 1111111..2222222 100644
--- a/web/app.tsx
+++ b/web/app.tsx
@@ -1,2 +1,3 @@
 const x = 1
+const MARKER_TSX = 2
diff --git a/migrations/001_init.sql b/migrations/001_init.sql
index 3333333..4444444 100644
--- a/migrations/001_init.sql
+++ b/migrations/001_init.sql
@@ -0,0 +1 @@
+CREATE TABLE MARKER_SQL (id int);
`
const CHANGED = ['web/app.tsx', 'migrations/001_init.sql']

const reviewCall = (calls, type) =>
  calls.find((c) => c.opts.label === `review:${type}`)

// ===== 1) Inline mode: a conditional expert gets ONLY its lane's file =====
{
  const empty = async (prompt, opts) =>
    opts.label?.startsWith('review:') ? { findings: [] } : 'ok'
  const { calls } = await runWorkflow(SCRIPT, {
    args: { diff: DIFF, changedFiles: CHANGED, rules: '', date: '' },
    agentImpl: empty,
  })

  const fe = reviewCall(calls, 'frontend-developer')
  assert(fe, 'frontend-developer lane should run')
  assert(fe.prompt.includes('MARKER_TSX'), 'FE expert must see the .tsx change')
  assert(!fe.prompt.includes('MARKER_SQL'), 'FE expert must NOT see the unrelated .sql change')

  const db = reviewCall(calls, 'database-optimizer')
  assert(db, 'database-optimizer lane should run')
  assert(db.prompt.includes('MARKER_SQL'), 'DB expert must see the .sql change')
  assert(!db.prompt.includes('MARKER_TSX'), 'DB expert must NOT see the unrelated .tsx change')

  // An always-on (general) expert reviews the whole change — both files.
  const backend = reviewCall(calls, 'backend-architect')
  assert(backend.prompt.includes('MARKER_TSX') && backend.prompt.includes('MARKER_SQL'),
    'general expert must see all changed files')
}

// ===== 2) Inline mode: a skeptic gets ONLY the finding's file =====
{
  const impl = async (prompt, opts) => {
    const label = opts.label ?? ''
    if (label === 'review:backend-architect')
      return { findings: [{ severity: 'High', file: 'web/app.tsx', line: 2, title: 'x', detail: 'd', suggestion: 's' }] }
    if (label.startsWith('review:')) return { findings: [] }
    if (label.startsWith('skeptic:')) return { refuted: false, reason: 'ok' }
    if (label === 'dedup') {
      const m = 'FINDINGS JSON:\n'
      return { findings: JSON.parse(prompt.slice(prompt.indexOf(m) + m.length)) }
    }
    if (label === 'ledger') return { ledger: [] }
    return '# report'
  }
  const { calls } = await runWorkflow(SCRIPT, {
    args: { diff: DIFF, changedFiles: CHANGED, rules: '', date: '' },
    agentImpl: impl,
  })
  const skeptics = calls.filter((c) => c.opts.label?.startsWith('skeptic:'))
  assert.equal(skeptics.length, 3, 'one High finding -> 3 skeptics')
  for (const s of skeptics) {
    assert(s.prompt.includes('MARKER_TSX'), 'skeptic must see the finding file change')
    assert(!s.prompt.includes('MARKER_SQL'), 'skeptic must NOT see unrelated file change')
  }
}

// ===== 3) Repo mode: NO diff blob — agents are told to read changes from the repo =====
{
  const empty = async (prompt, opts) =>
    opts.label?.startsWith('review:') ? { findings: [] } : (opts.label === 'ledger' ? { ledger: [] } : 'ok')
  const { result, calls } = await runWorkflow(SCRIPT, {
    args: {
      // no `diff` at all
      changedFiles: ['web/app.tsx'],
      baseRef: 'abc123',
      repoPath: '/tmp/repo',
      rules: '',
      date: '2026-06-18',
    },
    agentImpl: empty,
  })
  assert.equal(result.error, undefined, 'repo mode must not error without an inline diff')
  assert.equal(typeof result.report, 'string', 'repo mode still produces a report')

  const backend = reviewCall(calls, 'backend-architect')
  assert(backend, 'review lanes run in repo mode')
  assert(backend.prompt.includes('git -C /tmp/repo diff abc123'),
    'repo-mode prompt must tell the agent how to read the diff from the repo')
  assert(backend.prompt.includes('web/app.tsx'), 'repo-mode prompt lists the changed file')
  assert(!backend.prompt.includes('\nDIFF:\n'), 'repo mode must NOT inline a diff blob')
}

// ===== 4) Repo mode still needs something to review =====
{
  const empty = async () => 'ok'
  const { result, calls } = await runWorkflow(SCRIPT, {
    args: { changedFiles: [], baseRef: 'abc123', repoPath: '/tmp/repo', rules: '', date: '' },
    agentImpl: empty,
  })
  assert.equal(result.error, 'empty diff', 'repo mode with no changed files is empty')
  assert.equal(calls.length, 0, 'no agents run when there is nothing to review')
}

console.log('slicing tests: PASS')
