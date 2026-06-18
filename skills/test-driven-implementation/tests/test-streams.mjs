import assert from 'node:assert/strict'
import { planStreams } from '../lib/streams.mjs'

const tasks = [
  { id: 1, title: 'a', files: ['src/api.js'], deps: [] },
  { id: 2, title: 'b', files: ['src/api.js'], deps: [] }, // shares file with 1
  { id: 3, title: 'c', files: ['src/ui.js'], deps: [] },  // independent
]

// graph available, two independent groups -> parallel
const a = planStreams(tasks, { depEdges: [], graphAvailable: true })
assert.deepEqual(a.streams, [[1, 2], [3]], 'file overlap groups 1+2; 3 alone')
assert.equal(a.parallel, true, 'two independent streams + graph -> parallel')
assert.equal(a.conviction, 'high')

// graph absent -> sequential regardless
const b = planStreams(tasks, { graphAvailable: false })
assert.equal(b.parallel, false, 'no graph -> sequential')
assert.equal(b.conviction, 'low')

// explicit dep merges streams
const dep = planStreams(
  [{ id: 1, title: 'a', files: ['x.js'], deps: [] },
   { id: 2, title: 'b', files: ['y.js'], deps: [1] }],
  { graphAvailable: true })
assert.deepEqual(dep.streams, [[1, 2]], 'explicit dep merges')
assert.equal(dep.parallel, false, 'one stream -> not parallel')

// graphify edge merges streams
const edge = planStreams(
  [{ id: 1, title: 'a', files: ['x.js'], deps: [] },
   { id: 2, title: 'b', files: ['y.js'], deps: [] }],
  { depEdges: [[1, 2]], graphAvailable: true })
assert.deepEqual(edge.streams, [[1, 2]], 'graph edge merges')
console.log('streams: PASS')
