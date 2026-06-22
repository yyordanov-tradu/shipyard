import assert from 'node:assert/strict'
import { parallelLimited } from '../parallel.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 1) Concurrency cap + result order.
{
  let inflight = 0, peak = 0
  const mk = (i) => async () => {
    inflight++; peak = Math.max(peak, inflight)
    await sleep(10)
    inflight--
    return i
  }
  const res = await parallelLimited([0, 1, 2, 3, 4].map(mk), 2)
  assert.deepEqual(res, [0, 1, 2, 3, 4], 'results returned in input order')
  assert.ok(peak <= 2, `peak in-flight ${peak} must be <= 2`)
  assert.ok(peak >= 2, `peak ${peak} should reach the limit (2) given 5 tasks`)
}

// 2) A throwing thunk resolves to null; siblings survive; order preserved.
{
  const res = await parallelLimited([
    async () => 'a',
    async () => { throw new Error('boom') },
    async () => 'c',
  ], 3)
  assert.deepEqual(res, ['a', null, 'c'], 'throwing thunk -> null, others kept, order preserved')
}

// 3) Empty input.
{
  assert.deepEqual(await parallelLimited([], 4), [], 'empty input -> empty output')
}

// 4) limit larger than the task count still works.
{
  const res = await parallelLimited([async () => 1, async () => 2], 10)
  assert.deepEqual(res, [1, 2])
}

console.log('parallel tests: PASS')
