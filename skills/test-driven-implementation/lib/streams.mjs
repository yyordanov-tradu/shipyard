import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parsePlan } from './plan-parse.mjs'

export function planStreams(tasks, { depEdges = [], graphAvailable = false } = {}) {
  const ids = tasks.map(t => t.id)
  const parent = new Map(ids.map(i => [i, i]))
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x) } return x }
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb) }
  const has = new Set(ids)

  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      if (tasks[i].files.some(f => tasks[j].files.includes(f))) union(tasks[i].id, tasks[j].id)
    }
  }
  for (const t of tasks) for (const d of t.deps) if (has.has(d)) union(t.id, d)
  for (const [from, to] of depEdges) if (has.has(from) && has.has(to)) union(from, to)

  const comp = new Map()
  for (const id of ids) {
    const r = find(id)
    if (!comp.has(r)) comp.set(r, [])
    comp.get(r).push(id)
  }
  const streams = [...comp.values()]
    .map(s => s.sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0])

  const reasons = []
  let parallel
  if (!graphAvailable) { parallel = false; reasons.push('graphify unavailable -> sequential (low conviction)') }
  else if (streams.length > 1) { parallel = true; reasons.push(`${streams.length} independent streams found`) }
  else { parallel = false; reasons.push('single connected stream -> sequential') }

  return { streams, parallel, conviction: graphAvailable ? 'high' : 'low', reasons }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { tasks } = parsePlan(readFileSync(process.argv[2], 'utf8'))
  const depEdges = process.argv[3] ? JSON.parse(process.argv[3]) : []
  const graphAvailable = process.argv.includes('--graph')
  process.stdout.write(JSON.stringify(planStreams(tasks, { depEdges, graphAvailable }), null, 2) + '\n')
}
