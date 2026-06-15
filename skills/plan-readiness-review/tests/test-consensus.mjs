import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'

// Fixed 3-expert roster via override so gap ids are predictable (G1 from 'raiser').
const ROSTER = ['raiser', 'other1', 'other2']
const baseArgs = { spec: 'x', plan: 'y', rosterOverride: ROSTER, projectLangs: [], date: '' }

// A) A Blocker disputed by another expert (1 dissenter, 0 endorsers) -> CONTESTED,
//    so it must NOT drive MISALIGNED, and it must appear in the Contested section.
{
  const fake = async (prompt, opts) => {
    if (opts.label === 'review:raiser')
      return { gaps: [{ dimension: 'risk', severity: 'Blocker', title: 'C1', detail: 'd', evidence: 'e', fix: 'f' }], matrix: null }
    if (opts.label?.startsWith('review:')) return { gaps: [], matrix: null }
    if (opts.label === 'debate:other1') return { reactions: [{ gapId: 'G1', stance: 'dispute', reason: 'not real' }] }
    if (opts.label?.startsWith('debate:')) return { reactions: [] }
    return null
  }
  const { result } = await runWorkflow(SCRIPT, { args: baseArgs, agentImpl: fake })
  const c1 = result.consensus.find((c) => c.title === 'C1')
  assert.equal(c1.status, 'contested', 'disputed Blocker (tie) must be contested, not agreed')
  assert.equal(result.verdict, 'READY', 'a contested Blocker must not force MISALIGNED')
  assert.ok(/## Contested/.test(result.report) && /C1/.test(result.report), 'contested section shows C1')
}

// B) The raiser disputes its own gap and nobody endorses -> DROPPED (gone from report).
{
  const fake = async (prompt, opts) => {
    if (opts.label === 'review:raiser')
      return { gaps: [{ dimension: 'risk', severity: 'Blocker', title: 'D1', detail: 'd', evidence: 'e', fix: 'f' }], matrix: null }
    if (opts.label?.startsWith('review:')) return { gaps: [], matrix: null }
    if (opts.label === 'debate:raiser') return { reactions: [{ gapId: 'G1', stance: 'dispute', reason: 'I withdraw' }] }
    if (opts.label?.startsWith('debate:')) return { reactions: [] }
    return null
  }
  const { result } = await runWorkflow(SCRIPT, { args: baseArgs, agentImpl: fake })
  const d1 = result.consensus.find((c) => c.title === 'D1')
  assert.equal(d1.status, 'dropped', 'self-retracted gap must be dropped')
  assert.ok(!/D1/.test(result.report), 'dropped gap must not appear in the report')
  assert.equal(result.verdict, 'READY')
}

// C) An `add` reaction (a new angle, no existing gap) is surfaced, not discarded.
{
  const fake = async (prompt, opts) => {
    if (opts.label?.startsWith('review:')) return { gaps: [], matrix: null }
    if (opts.label === 'debate:other1') return { reactions: [{ gapId: '-', stance: 'add', reason: 'consider rate limiting' }] }
    if (opts.label?.startsWith('debate:')) return { reactions: [] }
    return null
  }
  const { result } = await runWorkflow(SCRIPT, { args: baseArgs, agentImpl: fake })
  assert.ok(/Raised in debate/.test(result.report), 'add section present')
  assert.ok(/consider rate limiting/.test(result.report), 'add reason surfaced')
}

// D) A failed (null) review is tracked and named, not silently dropped.
{
  const fake = async (prompt, opts) => {
    if (opts.label === 'review:other1') return null // simulate a crashed expert
    if (opts.label?.startsWith('review:')) return { gaps: [], matrix: null }
    if (opts.label?.startsWith('debate:')) return { reactions: [] }
    return null
  }
  const { result } = await runWorkflow(SCRIPT, { args: baseArgs, agentImpl: fake })
  assert.ok(result.failedExperts.includes('other1'), 'failed expert tracked in result')
  assert.ok(/Experts that failed to run/.test(result.report) && /other1/.test(result.report),
    'failed expert named in the report')
}

console.log('consensus tests: PASS')
