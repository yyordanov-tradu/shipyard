import assert from 'node:assert/strict'
import { partitionUnits, expertForUnit } from '../units.mjs'

// 1) Determinism + stable order: same changed files -> deep-equal units, sorted by path.
{
  const files = ['web/b.py', 'web/a.ts', 'web/b.py'] // dup + unsorted
  const a = partitionUnits(files)
  const b = partitionUnits(files)
  assert.deepEqual(a, b, 'same input -> deep-equal units (deterministic)')
  assert.deepEqual(a.map((u) => u.path), ['web/a.ts', 'web/b.py'], 'deduped + sorted by path')
  assert.deepEqual(a.map((u) => u.id), ['u1', 'u2'], 'stable ids by position')
}

// 2) Expert match per unit type.
{
  const u = (path, deletionOnly = false) => ({ path, deletionOnly })
  assert.equal(expertForUnit(u('web/app.tsx')), 'frontend-developer', '.tsx -> frontend')
  assert.equal(expertForUnit(u('src/util.ts')), 'typescript-pro', 'plain .ts -> typescript-pro')
  assert.equal(expertForUnit(u('migrations/001_init.sql')), 'database-optimizer', '.sql/migration -> db')
  assert.equal(expertForUnit(u('svc/handler.py')), 'python-pro', '.py -> python-pro')
  assert.equal(expertForUnit(u('cmd/main.go')), 'golang-pro', '.go -> golang-pro')
  assert.equal(expertForUnit(u('infra/main.tf')), 'terraform-specialist', '.tf -> infra')
  assert.equal(expertForUnit(u('notes.xyz')), 'code-reviewer', 'unknown -> generalist')
}

// 3) Deletion-only file -> kind 'removed-safety' + generalist reviewer; hunks attached.
{
  const diffs = new Map([
    ['auth/guard.py', 'diff --git a/auth/guard.py b/auth/guard.py\n--- a/auth/guard.py\n+++ b/auth/guard.py\n@@ -1,3 +1,1 @@\n-    if not user.is_admin:\n-        raise Forbidden()\n existing'],
    ['svc/new.py', 'diff --git a/svc/new.py b/svc/new.py\n--- a/svc/new.py\n+++ b/svc/new.py\n@@ -0,0 +1 @@\n+def f(): pass'],
  ])
  const units = partitionUnits(['auth/guard.py', 'svc/new.py'], diffs)
  const guard = units.find((u) => u.path === 'auth/guard.py')
  const added = units.find((u) => u.path === 'svc/new.py')
  assert.equal(guard.deletionOnly, true, 'all-removal patch is deletion-only')
  assert.equal(guard.kind, 'removed-safety', 'deletion-only -> kind removed-safety')
  assert.equal(expertForUnit(guard), 'code-reviewer', 'removed-safety -> generalist reviewer')
  assert.ok(guard.hunks.includes('raise Forbidden'), 'hunks attached from fileDiffs')
  assert.equal(added.deletionOnly, false, 'patch with additions is not deletion-only')
  assert.equal(added.kind, 'code', 'normal .py unit -> code kind')
}

console.log('units tests: PASS')
