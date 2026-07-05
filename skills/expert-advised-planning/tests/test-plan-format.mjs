import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runWorkflow, SCRIPT } from './harness.mjs'

// The plan is the one machine-read artifact of the pipeline: test-driven-implementation
// parses it with lib/plan-parse.mjs. The draft prompt's format guide must therefore state
// the exact grammar the parser needs, and its own example must round-trip through that
// parser — otherwise the guide teaches a format the pipeline cannot read.
const { parsePlan } = await import(
  join(dirname(fileURLToPath(import.meta.url)), '../../test-driven-implementation/lib/plan-parse.mjs')
)

const fake = async (prompt, opts) => {
  if (opts.label === 'frame') return { problem: 'p', keyDecisions: [] }
  if (opts.label?.startsWith('advise:')) return { recommendations: [], risks: [], patterns: [] }
  if (opts.label === 'reconcile') return { conflicts: [] }
  if (opts.label === 'draft') return '### Task 1: stub\n\n**Files:**\n- Create: `a.js`\n'
  return null
}

const { calls } = await runWorkflow(SCRIPT, {
  args: { source: 'build a widget', projectLangs: [], date: '2026-07-03' },
  agentImpl: fake,
})

const draft = calls.find((c) => c.opts.label === 'draft')
assert.ok(draft, 'draft agent ran')

// 1. The guide names every token of the parser's grammar.
assert.ok(/### Task N: <short title>/.test(draft.prompt), 'guide states the task-heading grammar')
assert.ok(draft.prompt.includes('**Files:**'), 'guide states the Files-block grammar')
assert.ok(/depends on Task N/.test(draft.prompt), 'guide states the dependency phrase')

// 2. The guide's example block satisfies the canonical parser (round-trip).
const { tasks } = parsePlan(draft.prompt)
assert.ok(tasks.length >= 2, `guide example parses to >=2 tasks (got ${tasks.length})`)
assert.ok(tasks[0].files.length >= 1, 'example task 1 yields files')
const dependent = tasks.find((t) => t.deps.length > 0)
assert.ok(dependent, 'example includes a parseable dependency')
assert.ok(dependent.deps.includes(tasks[0].id), 'dependency points at an earlier task')

console.log('plan-format guide: PASS')
