// Dry-run loader: wraps the workflow body in an AsyncFunction with stubbed
// workflow globals and a fake agent. No real agents are spawned.
import { readFile } from 'node:fs/promises'

export const SCRIPT = process.env.HOME + '/.claude/workflows/plan-readiness-review.js'

export async function runWorkflow(scriptPath, { args = {}, agentImpl }) {
  if (typeof agentImpl !== 'function') throw new TypeError('agentImpl is required')
  let src = await readFile(scriptPath, 'utf8')
  src = src.replace(/^export\s+const\s+meta/m, 'const meta')

  const calls = []
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts })
    return agentImpl(prompt, opts)
  }
  const parallel = (thunks) =>
    Promise.all(thunks.map(async (t) => { try { return await t() } catch { return null } }))
  const pipeline = (items, ...stages) =>
    Promise.all(items.map(async (item, i) => {
      let cur = item
      for (const s of stages) { try { cur = await s(cur, item, i) } catch { return null } }
      return cur
    }))
  const phase = () => {}
  const log = () => {}
  const budget = { total: null, spent: () => 0, remaining: () => Infinity }

  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor
  const fn = new AsyncFn(
    'args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow', src
  )
  const result = await fn(args, agent, parallel, pipeline, phase, log, budget, async () => null)
  return { result, calls }
}
