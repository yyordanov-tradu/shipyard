import assert from 'node:assert'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runWorkflow, SCRIPT } from './harness.mjs'

// Build a fake where the alignment expert raises a Blocker and everyone concedes.
function makeFake({ severity, status }) {
  return async (prompt, opts) => {
    if (opts.label === 'review:alignment')
      return {
        gaps: [{ dimension: 'alignment', severity, title: 'uncovered req',
                 detail: 'd', evidence: 'e', fix: 'f' }],
        matrix: { requirements: [{ id: 'R1', text: 'must do X', status }], orphanPlanSteps: [] },
      }
    if (opts.label?.startsWith('review:')) return { gaps: [], matrix: null }
    if (opts.label?.startsWith('debate:')) return { reactions: [] }
    if (opts.label === 'decide') return null // force the workflow's own fallback verdict
    return null
  }
}

// Blocker gap + uncovered requirement -> MISALIGNED
{
  const { result } = await runWorkflow(SCRIPT, {
    args: { spec: 'must do X', plan: 'do Y', projectLangs: [], date: '' },
    agentImpl: makeFake({ severity: 'Blocker', status: 'uncovered' }),
  })
  assert.equal(result.verdict, 'MISALIGNED', 'blocker + uncovered -> MISALIGNED')
  assert.ok(/R1/.test(result.report) && /uncovered/i.test(result.report), 'coverage table in report')
}

// Only a Major + partial coverage -> NEEDS-WORK
{
  const { result } = await runWorkflow(SCRIPT, {
    args: { spec: 'x', plan: 'y', projectLangs: [], date: '' },
    agentImpl: makeFake({ severity: 'Major', status: 'partial' }),
  })
  assert.equal(result.verdict, 'NEEDS-WORK')
}

{
  // Fixtures sit next to this test file; resolve relative to it so tests run from the repo.
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
  const spec = await readFile(join(dir, 'spec.md'), 'utf8')
  const plan = await readFile(join(dir, 'plan.md'), 'utf8')
  const fake = async (prompt, opts) => {
    if (opts.label === 'review:alignment')
      return {
        gaps: [{ dimension: 'alignment', severity: 'Blocker', title: 'receipt email not planned',
                 detail: 'req 2 has no task', evidence: 'plan has 1 task', fix: 'add an email task' }],
        matrix: { requirements: [
          { id: 'R1', text: 'store file', coveredBy: ['Task 1'], status: 'covered' },
          { id: 'R2', text: 'email receipt', coveredBy: [], status: 'uncovered' },
        ], orphanPlanSteps: [] },
      }
    if (opts.label?.startsWith('review:')) return { gaps: [], matrix: null }
    if (opts.label?.startsWith('debate:')) return { reactions: [] }
    return null
  }
  const { result } = await runWorkflow(SCRIPT, {
    args: { spec, plan, projectLangs: ['py'], date: '2026-06-14' }, agentImpl: fake,
  })
  assert.equal(result.verdict, 'MISALIGNED', 'uncovered requirement must block')
  assert.ok(/R2/.test(result.report) && /uncovered/i.test(result.report), 'R2 shown uncovered')
  assert.ok(result.panel.includes('python-pro'), 'py fixture -> python-pro on the panel')
}

// A CONTESTED Blocker (one expert disputes it, another defends — a genuine split)
// must NOT pass as READY. The verdict only looked at `agreed` gaps, so a contested
// Blocker slipped through with a clean coverage matrix.
{
  const fake = async (prompt, opts) => {
    if (opts.label === 'review:alignment')
      return {
        gaps: [{ dimension: 'alignment', severity: 'Blocker', title: 'risky migration',
                 detail: 'd', evidence: 'e', fix: 'f' }],
        matrix: { requirements: [{ id: 'R1', text: 'x', coveredBy: ['Task 1'], status: 'covered' }], orphanPlanSteps: [] },
      }
    if (opts.label?.startsWith('review:')) return { gaps: [], matrix: null }
    if (opts.label === 'debate:architecture') return { reactions: [{ gapId: 'G1', stance: 'dispute', reason: 'not real' }] }
    if (opts.label === 'debate:test-strategy') return { reactions: [{ gapId: 'G1', stance: 'defend', reason: 'it is real' }] }
    if (opts.label?.startsWith('debate:')) return { reactions: [] }
    if (opts.label === 'decide') return null
    return null
  }
  const { result } = await runWorkflow(SCRIPT, {
    args: { spec: 'x', plan: 'y', projectLangs: [], date: '' }, agentImpl: fake,
  })
  assert.notEqual(result.verdict, 'READY', 'a contested Blocker must not yield READY')
  assert.equal(result.verdict, 'NEEDS-WORK', 'contested Blocker -> NEEDS-WORK')
}

console.log('verdict tests: PASS')
