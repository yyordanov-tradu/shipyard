import assert from 'node:assert/strict'
import { runWorkflow, SCRIPT } from './harness.mjs'

// Stage 1: ONE expert-matched reviewer per change unit (per file, default k=1).
const DIFF = `diff --git a/web/app.tsx b/web/app.tsx
index 1..2 100644
--- a/web/app.tsx
+++ b/web/app.tsx
@@ -1 +1,2 @@
 const x = 1
+const y = 2
diff --git a/svc/handler.py b/svc/handler.py
index 3..4 100644
--- a/svc/handler.py
+++ b/svc/handler.py
@@ -1 +1,2 @@
 import os
+x = 1
diff --git a/auth/guard.py b/auth/guard.py
index 5..6 100644
--- a/auth/guard.py
+++ b/auth/guard.py
@@ -1,2 +1,1 @@
-    if not admin: raise Forbidden()
 keep`
const CHANGED = ['web/app.tsx', 'svc/handler.py', 'auth/guard.py']

const empty = async (prompt, opts) =>
  opts.label?.startsWith('review:') ? { findings: [] } : (opts.label === 'ledger' ? { ledger: [] } : 'ok')

const { calls } = await runWorkflow(SCRIPT, { args: { diff: DIFF, changedFiles: CHANGED, rules: '', date: '' }, agentImpl: empty })

const reviews = calls.filter((c) => c.opts.label?.startsWith('review:unit:'))
assert.equal(reviews.length, 3, 'exactly one reviewer per changed unit (k=1)')

const byPath = Object.fromEntries(reviews.map((c) => [c.opts.label.slice('review:unit:'.length), c]))

// Expert matched to the unit type.
assert.equal(byPath['web/app.tsx'].opts.agentType, 'frontend-developer', '.tsx -> frontend-developer')
assert.equal(byPath['svc/handler.py'].opts.agentType, 'python-pro', '.py -> python-pro')
assert.equal(byPath['auth/guard.py'].opts.agentType, 'code-reviewer', 'deletion-only -> generalist (removed-safety)')

// Each reviewer is scoped to its own unit.
assert.ok(byPath['web/app.tsx'].prompt.includes('web/app.tsx'), 'reviewer prompt names its unit')
assert.ok(!byPath['web/app.tsx'].prompt.includes('svc/handler.py'), 'reviewer prompt does NOT see other units')

// Deletion-only unit is flagged to its reviewer.
assert.ok(/DELETION-ONLY/.test(byPath['auth/guard.py'].prompt), 'deletion-only reviewer warned about removed protection')

// Findings schema carries causeFiles (the cross-file hook).
assert.ok(
  byPath['web/app.tsx'].opts.schema.properties.findings.items.properties.causeFiles,
  'findings schema includes causeFiles'
)

console.log('units-review tests: PASS')
