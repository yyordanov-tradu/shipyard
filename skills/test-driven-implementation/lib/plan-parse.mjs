import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const TASK_RE = /^###\s+Task\s+(\d+)\s*:\s*(.+)$/

export function parsePlan(md) {
  const lines = String(md).split('\n')
  const header = []
  const tasks = []
  let cur = null
  let inFiles = false
  for (const line of lines) {
    const m = line.match(TASK_RE)
    if (m) {
      if (cur) tasks.push(cur)
      cur = { id: Number(m[1]), title: m[2].trim(), files: [], deps: [], _body: [] }
      inFiles = false
      continue
    }
    if (!cur) { header.push(line); continue }
    cur._body.push(line)
    if (/^\*\*Files:\*\*/.test(line)) { inFiles = true; continue }
    if (inFiles) {
      if (/^\s*-\s/.test(line)) {
        for (const mm of line.matchAll(/`([^`]+)`/g)) {
          cur.files.push(mm[1].replace(/:[\d,\s-]+$/, '').trim())
        }
      } else {
        inFiles = false
      }
    }
  }
  if (cur) tasks.push(cur)
  for (const t of tasks) {
    for (const dm of t._body.join('\n').matchAll(/depends on Task\s+(\d+)/gi)) {
      const id = Number(dm[1])
      if (!t.deps.includes(id)) t.deps.push(id)
    }
    delete t._body
  }
  return { header: header.join('\n').trim(), tasks }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const md = readFileSync(process.argv[2], 'utf8')
  process.stdout.write(JSON.stringify(parsePlan(md), null, 2) + '\n')
}
