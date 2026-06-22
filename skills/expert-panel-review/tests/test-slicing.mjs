import assert from 'node:assert/strict'
import { runWorkflow, SCRIPT } from './harness.mjs'

// Per-UNIT scoping: each unit reviewer sees only its file; a skeptic sees the finding's
// file (+ causeFiles); repo mode passes a git command, never an inlined diff blob.
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
const review = (calls, path) => calls.find((c) => c.opts.label === `review:unit:${path}`)

// 1) Inline mode: each unit reviewer sees ONLY its own file's change.
{
  const empty = async (prompt, opts) =>
    opts.label?.startsWith('review:') ? { findings: [] } : (opts.label === 'ledger' ? { ledger: [] } : 'ok')
  const { calls } = await runWorkflow(SCRIPT, { args: { diff: DIFF, changedFiles: CHANGED, rules: '', date: '' }, agentImpl: empty })

  const fe = review(calls, 'web/app.tsx')
  assert.ok(fe.prompt.includes('MARKER_TSX') && !fe.prompt.includes('MARKER_SQL'), 'tsx unit sees only its change')
  const db = review(calls, 'migrations/001_init.sql')
  assert.ok(db.prompt.includes('MARKER_SQL') && !db.prompt.includes('MARKER_TSX'), 'sql unit sees only its change')
}

// 2) Inline mode: a skeptic gets ONLY the finding's file.
{
  const impl = async (prompt, opts) => {
    const label = opts.label ?? ''
    if (label === 'review:unit:web/app.tsx')
      return { findings: [{ severity: 'High', file: 'web/app.tsx', line: 2, title: 'x', detail: 'd', suggestion: 's' }] }
    if (label.startsWith('review:')) return { findings: [] }
    if (label.startsWith('skeptic:')) return { refuted: false, reason: 'ok' }
    if (label === 'dedup') { const m = 'FINDINGS JSON:\n'; return { findings: JSON.parse(prompt.slice(prompt.indexOf(m) + m.length)) } }
    if (label === 'ledger') return { ledger: [] }
    return '# report'
  }
  const { calls } = await runWorkflow(SCRIPT, { args: { diff: DIFF, changedFiles: CHANGED, rules: '', date: '' }, agentImpl: impl })
  const skeptics = calls.filter((c) => c.opts.label?.startsWith('skeptic:'))
  assert.equal(skeptics.length, 3, 'one High -> 3 skeptics')
  for (const s of skeptics)
    assert.ok(s.prompt.includes('MARKER_TSX') && !s.prompt.includes('MARKER_SQL'), 'skeptic scoped to finding file')
}

// 3) Repo mode: no diff blob — units are reviewed via a git command.
{
  const empty = async (prompt, opts) =>
    opts.label?.startsWith('review:') ? { findings: [] } : (opts.label === 'ledger' ? { ledger: [] } : 'ok')
  const { result, calls } = await runWorkflow(SCRIPT, {
    args: { changedFiles: ['web/app.tsx'], baseRef: 'abc123', repoPath: '/tmp/repo', rules: '', date: '2026-06-22' },
    agentImpl: empty,
  })
  assert.equal(result.error, undefined, 'repo mode runs without an inline diff')
  const fe = review(calls, 'web/app.tsx')
  assert.ok(fe.prompt.includes('git -C /tmp/repo diff abc123'), 'repo-mode reviewer reads via git')
  assert.ok(!fe.prompt.includes('\nDIFF:\n'), 'repo mode inlines no diff blob')
}

// 4) Repo mode with no changed files -> empty.
{
  const { result, calls } = await runWorkflow(SCRIPT, {
    args: { changedFiles: [], baseRef: 'abc123', repoPath: '/tmp/repo', rules: '', date: '' },
    agentImpl: async () => 'ok',
  })
  assert.equal(result.error, 'empty diff')
  assert.equal(calls.length, 0)
}

console.log('slicing tests: PASS')
