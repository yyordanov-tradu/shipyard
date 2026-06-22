import assert from 'node:assert/strict'
import { unionFindings } from '../union.mjs'

const F = (severity, file, line, title, expert) => ({ severity, file, line, title, detail: 'd', suggestion: 's', expert })

// 1) Same issue, near line, overlapping title, same band -> merge with support 2 + experts union.
{
  const r = unionFindings([
    F('High', 'a.js', 10, 'missing null check', 'u1'),
    F('High', 'a.js', 11, 'missing null check on x', 'u2'),
  ])
  assert.equal(r.length, 1, 'two phrasings of one issue merge to one')
  assert.equal(r[0].support, 2, 'support counts contributors')
  assert.deepEqual(r[0].experts.sort(), ['u1', 'u2'], 'experts unioned')
}

// 2) Adjacent but DISTINCT (different title) -> stay separate (over-split bias).
{
  const r = unionFindings([
    F('High', 'a.js', 10, 'missing null check', 'u1'),
    F('High', 'a.js', 11, 'unused import foo', 'u2'),
  ])
  assert.equal(r.length, 2, 'distinct issues at adjacent lines do NOT merge')
  assert.deepEqual(r.map((x) => x.support), [1, 1], 'each kept with support 1')
}

// 3) Critical + Medium at the SAME line/title -> never merge (severity band in the key).
{
  const r = unionFindings([
    F('Critical', 'a.js', 5, 'sql injection', 'u1'),
    F('Medium', 'a.js', 5, 'sql injection', 'u2'),
  ])
  assert.equal(r.length, 2, 'a Critical never folds into a Medium')
}

// 4) Low-support (single draw) finding is KEPT, never dropped.
{
  const r = unionFindings([F('Critical', 'a.js', 1, 'rare race', 'u1')])
  assert.equal(r.length, 1)
  assert.equal(r[0].support, 1, 'a single-draw Critical survives')
}

// 5) Cluster keeps MAX severity (Critical + High of the same issue -> Critical).
{
  const r = unionFindings([
    F('High', 'a.js', 5, 'race condition', 'u1'),
    F('Critical', 'a.js', 5, 'race condition here', 'u2'),
  ])
  assert.equal(r.length, 1, 'same issue, same band (block) -> merges')
  assert.equal(r[0].severity, 'Critical', 'cluster carries MAX severity')
  assert.equal(r[0].support, 2)
}

console.log('union tests: PASS')
