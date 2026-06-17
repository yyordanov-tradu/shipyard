// Dry-run loader for Workflow scripts: wraps the script body in an AsyncFunction
// (like the real runtime) and stubs the workflow globals. No agents are spawned.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The engine ships inside the plugin at workflows/<skill>.js. Resolve it relative to
// this test file (skills/<skill>/tests/) so tests run from the repo, no install needed.
export const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '../../../workflows/expert-panel-review.js')

export async function runWorkflow(scriptPath, { args = {}, agentImpl }) {
  if (typeof agentImpl !== 'function') throw new TypeError('agentImpl is required')
  let src = await readFile(scriptPath, 'utf8')
  // The runtime accepts `export const meta`; AsyncFunction does not. Strip it.
  src = src.replace(/^export\s+const\s+meta/m, 'const meta')

  const calls = []
  const agent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts })
    return agentImpl(prompt, opts)
  }
  // parallel: thunks; an erroring thunk resolves to null (mirrors the runtime)
  const parallel = (thunks) =>
    Promise.all(thunks.map(async (t) => { try { return await t() } catch { return null } }))
  // pipeline: stages receive (prevResult, originalItem, index); a throwing stage
  // drops the item to null (mirrors the runtime)
  const pipeline = (items, ...stages) =>
    Promise.all(
      items.map(async (item, i) => {
        let cur = item
        for (const s of stages) {
          try {
            cur = await s(cur, item, i)
          } catch {
            return null
          }
        }
        return cur
      })
    )
  const phase = () => {}
  const log = () => {}
  const budget = { total: null, spent: () => 0, remaining: () => Infinity }

  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor
  const fn = new AsyncFn(
    'args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', 'workflow',
    src
  )
  const result = await fn(
    args, agent, parallel, pipeline, phase, log, budget, async () => null
  )
  return { result, calls }
}
