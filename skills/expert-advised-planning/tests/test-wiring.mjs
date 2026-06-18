import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { runWorkflow, SCRIPT } from './harness.mjs'

// 1) workflow parses
execFileSync('node', ['--check', SCRIPT])

// 2) SKILL.md frontmatter valid. The hook reads JSON on STDIN and (like all PostToolUse hooks)
// signals problems via STDOUT, often while still exiting 0 — so exit code alone is not enough:
// capture stdout and assert it carries no error/systemMessage, or an invalid file would pass silently.
if (existsSync('skills/expert-advised-planning/SKILL.md') && existsSync('.claude/hooks/validate-skill-meta.sh')) {
  const payload = JSON.stringify({ tool_input: { file_path: process.cwd() + '/skills/expert-advised-planning/SKILL.md' } })
  const out = execFileSync('bash', ['.claude/hooks/validate-skill-meta.sh'], { input: payload, encoding: 'utf8' })
  assert.ok(!/systemMessage|error|invalid|missing/i.test(out), `frontmatter hook reported a problem: ${out}`)
}

// 3) every JSON Schema the workflow passes to agent() is well-formed.
const fake = async (prompt, opts) => {
  if (opts.label === 'frame') return { problem: 'p', keyDecisions: [] }
  if (opts.label?.startsWith('advise:')) return { recommendations: [] }
  if (opts.label === 'reconcile') return { conflicts: [] }
  if (opts.label === 'draft') return '# Plan\n- [ ] step\n'
  return null
}
const { calls } = await runWorkflow(SCRIPT, { args: { source: 'x', projectLangs: [], date: '' }, agentImpl: fake })
const schemas = calls.map((c) => c.opts.schema).filter(Boolean)
assert.ok(schemas.length >= 3, 'at least FRAMING/ADVICE/CONFLICT schemas are exercised')
for (const s of schemas) {
  assert.equal(s.type, 'object', 'schema type must be object')
  assert.ok(s.properties && typeof s.properties === 'object', 'schema must have properties')
  assert.equal(s.additionalProperties, false, 'schema must set additionalProperties:false')
}
console.log('wiring test: PASS')
