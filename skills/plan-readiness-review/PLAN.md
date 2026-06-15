# plan-readiness-review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a global Claude Code skill that reviews a spec + implementation plan together, before any code is written, and returns a verdict plus the gaps — so the plan is proven build-ready.

**Architecture:** A launcher (`SKILL.md`, markdown the main agent runs) resolves inputs and runs a deterministic dynamic workflow (`plan-readiness-review.js`). The workflow runs a flat panel of expert subagents in three phases — Review → Debate → Decide — with a capped parallelism. No agent hands distilled context to another: the launcher passes the same raw sources to every expert. Read `DESIGN.md` in this folder first; it is the source of truth.

**Tech Stack:** Node ESM (the workflow + tests, run with `node`), the Claude Code Workflow tool, the `Agent` tool's subagent types, and the `graphify` skill for codebase grounding. Tests are plain `.mjs` driven by a dry-run harness — no real model calls.

---

## Read first

- `~/.claude/skills/plan-readiness-review/DESIGN.md` — the approved design.
- `~/.claude/skills/expert-panel-review/SKILL.md` and `.../workflows/expert-panel-review.js` — the sibling skill this mirrors. Match its style and conventions.

## File structure

| File | Responsibility |
|---|---|
| `~/.claude/workflows/plan-readiness-review.js` | The deterministic workflow: tunables, roster selection, the three phases, verdict + report. Self-contained — all logic lives here so the harness can run it. |
| `~/.claude/skills/plan-readiness-review/SKILL.md` | The launcher: parse args, resolve spec+plan, gather the raw bundle, refresh the graph, run the workflow, save the report, print the summary. |
| `~/.claude/skills/plan-readiness-review/tests/harness.mjs` | Dry-run loader: runs the whole workflow with stubbed workflow globals and a fake `agentImpl`. No agents spawned. |
| `~/.claude/skills/plan-readiness-review/tests/test-detection.mjs` | Asserts the roster (which experts run) for given spec/plan/args. |
| `~/.claude/skills/plan-readiness-review/tests/test-concurrency.mjs` | Asserts no more than `MAX_CONCURRENCY` experts run at once. |
| `~/.claude/skills/plan-readiness-review/tests/test-verdict.mjs` | Asserts the verdict + report shape for crafted gaps/reactions/decision. |
| `~/.claude/skills/plan-readiness-review/DESIGN.md` | Already written. Do not change unless the design changes. |

All paths are absolute and live under `$HOME`. Run every command from any directory; the tests resolve `$HOME` themselves.

---

### Task 1: Scaffold a runnable workflow + the test harness

**Files:**
- Create: `~/.claude/workflows/plan-readiness-review.js`
- Create: `~/.claude/skills/plan-readiness-review/tests/harness.mjs`
- Create: `~/.claude/skills/plan-readiness-review/tests/test-smoke.mjs`

- [ ] **Step 1: Write the harness**

Create `tests/harness.mjs` (adapted from the sibling — same stub set, since this workflow uses `parallel`, `phase`, `log`):

```js
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
```

- [ ] **Step 2: Write the smoke test (failing — no workflow yet)**

Create `tests/test-smoke.mjs`:

```js
import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'

// Every expert returns one trivial gap; decide returns a minimal decision object.
const fake = async (prompt, opts) => {
  if (opts.label?.startsWith('review:')) return { gaps: [], matrix: null }
  if (opts.label?.startsWith('debate:')) return { reactions: [] }
  if (opts.label === 'decide')
    return { verdict: 'READY', report: '# Plan Readiness Review\n\nREADY', consensus: [] }
  return null
}

const { result } = await runWorkflow(SCRIPT, {
  args: { spec: 'S', plan: 'P', rules: '', designDocs: '', projectLangs: [], date: '2026-06-14' },
  agentImpl: fake,
})
assert.ok(result && typeof result.report === 'string', 'workflow must return a report string')
assert.ok(['READY', 'NEEDS-WORK', 'MISALIGNED'].includes(result.verdict), 'valid verdict')
console.log('smoke test: PASS')
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `node ~/.claude/skills/plan-readiness-review/tests/test-smoke.mjs`
Expected: FAIL — `ENOENT` (the workflow file does not exist yet).

- [ ] **Step 4: Write the minimal runnable workflow**

Create `~/.claude/workflows/plan-readiness-review.js`:

```js
export const meta = {
  name: 'plan-readiness-review',
  description:
    'Flat-panel review of a spec + implementation plan: Review -> Debate -> Decide, returns a verdict and the gaps. Report-only.',
  phases: [
    { title: 'Review', detail: 'each expert reviews the spec + plan independently' },
    { title: 'Debate', detail: 'experts argue each other\'s gaps' },
    { title: 'Decide', detail: 'consensus + coverage table + verdict' },
  ],
}

// ---------- tunables ----------
const MAX_CONCURRENCY = Number(process.env.PRR_MAX_CONCURRENCY) || 4
const STAGGER_MS = Number(process.env.PRR_STAGGER_MS) || 0

// ---------- args ----------
const a = typeof args === 'string' ? JSON.parse(args) : args || {}
const spec = (a.spec || '').trim()
const plan = (a.plan || '').trim()
if (!spec || !plan) return { error: 'missing spec or plan' }

// ---------- roster (filled in Task 3) ----------
const roster = [{ key: 'architecture', agentType: 'architect-review', lens: 'architecture fit' }]

// ---------- Review (filled in Task 4) ----------
phase('Review')
const reviews = await parallel(
  roster.map((e) => () =>
    agent(`Review the plan as the ${e.key} expert.\n\nSPEC:\n${spec}\n\nPLAN:\n${plan}`, {
      label: `review:${e.key}`,
      phase: 'Review',
      ...(e.agentType ? { agentType: e.agentType } : {}),
    })
  )
)

// ---------- Debate (filled in Task 5) ----------
phase('Debate')

// ---------- Decide (filled in Task 6) ----------
phase('Decide')
const decision = await agent(`Synthesize the verdict.\n\nREVIEWS:\n${JSON.stringify(reviews)}`, {
  label: 'decide',
  phase: 'Decide',
})

return {
  report: decision?.report || '# Plan Readiness Review\n\n(no report)',
  verdict: decision?.verdict || 'NEEDS-WORK',
  consensus: decision?.consensus || [],
}
```

- [ ] **Step 5: Run the smoke test to confirm it passes**

Run: `node ~/.claude/skills/plan-readiness-review/tests/test-smoke.mjs`
Expected: `smoke test: PASS`

- [ ] **Step 6: Commit**

```bash
git -C ~/.claude/skills/plan-readiness-review add . 2>/dev/null || true
# ~/.claude is not a git repo; if it is later, this commits. Otherwise skip.
echo "scaffold complete"
```

---

### Task 2: Cap parallelism with `parallelLimited`

**Files:**
- Modify: `~/.claude/workflows/plan-readiness-review.js`
- Create: `~/.claude/skills/plan-readiness-review/tests/test-concurrency.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/test-concurrency.mjs`:

```js
import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'

// agentImpl tracks how many review experts run at once.
let inflight = 0, peak = 0
const fake = async (prompt, opts) => {
  if (opts.label?.startsWith('review:')) {
    inflight++; peak = Math.max(peak, inflight)
    await new Promise((r) => setTimeout(r, 15))
    inflight--
    return { gaps: [], matrix: null }
  }
  if (opts.label?.startsWith('debate:')) return { reactions: [] }
  if (opts.label === 'decide') return { verdict: 'READY', report: 'r', consensus: [] }
  return null
}

// Force a big roster via override so there are more experts than the cap.
const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((x) => x + '-pro')
process.env.PRR_MAX_CONCURRENCY = '4'
const { calls } = await runWorkflow(SCRIPT, {
  args: { spec: 'S', plan: 'P', rosterOverride: many, projectLangs: [], date: '' },
  agentImpl: fake,
})
const reviewCount = calls.filter((c) => c.opts.label?.startsWith('review:')).length
assert.equal(reviewCount, many.length, 'all override experts must run')
assert.ok(peak <= 4, `peak concurrency ${peak} must be <= 4`)
console.log('concurrency test: PASS')
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node ~/.claude/skills/plan-readiness-review/tests/test-concurrency.mjs`
Expected: FAIL — `rosterOverride` is ignored (peak = 1, only the one hardcoded expert), so `reviewCount` assertion fails.

- [ ] **Step 3: Add `parallelLimited` and use it for Review**

In `plan-readiness-review.js`, add the helper after the tunables block:

```js
// Run thunks in waves of at most `limit`, optionally pausing between waves.
async function parallelLimited(thunks, limit, staggerMs = 0) {
  const out = []
  for (let i = 0; i < thunks.length; i += limit) {
    const wave = thunks.slice(i, i + limit)
    const settled = await parallel(wave.map((t) => t))
    out.push(...settled)
    if (staggerMs && i + limit < thunks.length) await new Promise((r) => setTimeout(r, staggerMs))
  }
  return out
}
```

Replace the Review `await parallel(...)` call with `await parallelLimited(roster.map(...), MAX_CONCURRENCY, STAGGER_MS)` (same `roster.map` body). Also honour the override roster: right before the roster definition, add:

```js
const rosterOverride = Array.isArray(a.rosterOverride) ? a.rosterOverride : null
```

and replace the placeholder `roster` line with:

```js
const roster = rosterOverride
  ? rosterOverride.map((name) => ({ key: name, agentType: name, lens: 'override' }))
  : [{ key: 'architecture', agentType: 'architect-review', lens: 'architecture fit' }]
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node ~/.claude/skills/plan-readiness-review/tests/test-concurrency.mjs`
Expected: `concurrency test: PASS`

- [ ] **Step 5: Re-run the smoke test (no regression)**

Run: `node ~/.claude/skills/plan-readiness-review/tests/test-smoke.mjs`
Expected: `smoke test: PASS`

- [ ] **Step 6: Commit**

```bash
echo "feat: capped parallelism via parallelLimited"
```

---

### Task 3: Roster selection (always-on + deterministic conditionals)

**Files:**
- Modify: `~/.claude/workflows/plan-readiness-review.js`
- Create: `~/.claude/skills/plan-readiness-review/tests/test-detection.mjs`

- [ ] **Step 1: Write the failing test**

Create `tests/test-detection.mjs`:

```js
import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'

const fake = async (prompt, opts) => {
  if (opts.label?.startsWith('review:')) return { gaps: [], matrix: null }
  if (opts.label?.startsWith('debate:')) return { reactions: [] }
  if (opts.label === 'decide') return { verdict: 'READY', report: 'r', consensus: [] }
  return null
}
const reviewKeys = (calls) =>
  calls.filter((c) => c.opts.label?.startsWith('review:')).map((c) => c.opts.label.slice(7))

// 1) Always-on 5 are present even with no signals.
{
  const { calls } = await runWorkflow(SCRIPT, {
    args: { spec: 'a plain feature', plan: 'do the thing', projectLangs: [], date: '' },
    agentImpl: fake,
  })
  const keys = reviewKeys(calls)
  for (const k of ['architecture', 'alignment', 'test-strategy', 'compliance', 'executability'])
    assert.ok(keys.includes(k), `missing always-on: ${k}`)
}

// 2) Language from plan file paths + project langs.
{
  const { calls } = await runWorkflow(SCRIPT, {
    args: {
      spec: 'x', plan: 'Create `src/intake/reader.py` and `web/app.tsx`.',
      projectLangs: ['go'], date: '',
    },
    agentImpl: fake,
  })
  const keys = reviewKeys(calls)
  assert.ok(keys.includes('python-pro'), '.py in plan -> python-pro')
  assert.ok(keys.includes('typescript-pro'), '.tsx in plan -> typescript-pro')
  assert.ok(keys.includes('golang-pro'), 'project go -> golang-pro')
}

// 3) Security + performance keyword scan.
{
  const { calls } = await runWorkflow(SCRIPT, {
    args: {
      spec: 'store the auth token and password securely', plan: 'reduce latency on the hot path',
      projectLangs: [], date: '',
    },
    agentImpl: fake,
  })
  const keys = reviewKeys(calls)
  assert.ok(keys.includes('security-auditor'), 'auth/token -> security')
  assert.ok(keys.includes('performance-engineer'), 'latency -> performance')
}

// 4) No security/perf signals -> those experts absent.
{
  const { calls } = await runWorkflow(SCRIPT, {
    args: { spec: 'rename a label', plan: 'update the text', projectLangs: [], date: '' },
    agentImpl: fake,
  })
  const keys = reviewKeys(calls)
  assert.ok(!keys.includes('security-auditor'))
  assert.ok(!keys.includes('performance-engineer'))
}

// 5) Override: only the named experts run.
{
  const { calls } = await runWorkflow(SCRIPT, {
    args: { spec: 'x', plan: 'y', rosterOverride: ['security-auditor'], projectLangs: [], date: '' },
    agentImpl: fake,
  })
  assert.deepEqual(reviewKeys(calls).sort(), ['security-auditor'])
}

console.log('detection tests: PASS')
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node ~/.claude/skills/plan-readiness-review/tests/test-detection.mjs`
Expected: FAIL — only `architecture` runs; always-on and conditionals missing.

- [ ] **Step 3: Implement roster selection**

In `plan-readiness-review.js`, replace the `roster` definition block with constants + a `selectRoster` function:

```js
const ALWAYS_ON = [
  { key: 'architecture', agentType: 'architect-review',
    lens: 'architecture fit, module boundaries, does the plan respect the design, code-vs-docs drift' },
  { key: 'alignment', agentType: null,
    lens: 'spec<->plan coverage both ways; produce the traceability matrix' },
  { key: 'test-strategy', agentType: 'qa-automation-architect',
    lens: 'validation points, acceptance criteria, testability, definition of done' },
  { key: 'compliance', agentType: null,
    lens: 'does the plan honor the project rules provided' },
  { key: 'executability', agentType: null,
    lens: 'instruction clarity, task ordering, dependencies, ambiguity that forces guessing' },
]

const LANG_MAP = {
  py: 'python-pro', ts: 'typescript-pro', tsx: 'typescript-pro', js: 'javascript-pro',
  jsx: 'javascript-pro', go: 'golang-pro', rs: 'rust-pro', java: 'java-pro', rb: 'ruby-pro',
}
const SECURITY_RX = /\b(auth|authz|authn|login|token|secret|password|credential|encrypt|oauth|jwt|injection|ssrf|csrf|pii)\b/i
const PERF_RX = /\b(latency|throughput|scale|scaling|hot path|cache|caching|concurren|p99|qps|memory|allocation)\b/i

function selectRoster({ spec, plan, projectLangs, rosterOverride }) {
  if (rosterOverride?.length)
    return rosterOverride.map((name) => ({ key: name, agentType: name, lens: 'override' }))

  const out = [...ALWAYS_ON]
  const text = `${spec}\n${plan}`

  // languages: plan file-path extensions UNION project languages
  const exts = new Set()
  for (const m of plan.matchAll(/[\w./-]+\.([A-Za-z0-9]+)/g)) exts.add(m[1].toLowerCase())
  for (const l of projectLangs || []) exts.add(String(l).toLowerCase())
  const langAgents = new Set()
  for (const e of exts) if (LANG_MAP[e]) langAgents.add(LANG_MAP[e])
  for (const ag of langAgents) out.push({ key: ag, agentType: ag, lens: 'language idioms and pitfalls' })

  // security / performance keyword scan (bias to include)
  if (SECURITY_RX.test(text))
    out.push({ key: 'security-auditor', agentType: 'security-auditor', lens: 'security risks' })
  if (PERF_RX.test(text))
    out.push({ key: 'performance-engineer', agentType: 'performance-engineer', lens: 'performance risks' })

  return out
}

const roster = selectRoster({
  spec, plan, projectLangs: a.projectLangs, rosterOverride: a.rosterOverride,
})
```

(Remove the now-unused `rosterOverride` const from Task 2 — `selectRoster` reads `a.rosterOverride` directly.)

- [ ] **Step 4: Run detection + smoke + concurrency to confirm all pass**

Run: `node ~/.claude/skills/plan-readiness-review/tests/test-detection.mjs && node ~/.claude/skills/plan-readiness-review/tests/test-smoke.mjs && node ~/.claude/skills/plan-readiness-review/tests/test-concurrency.mjs`
Expected: three PASS lines.

- [ ] **Step 5: Commit**

```bash
echo "feat: deterministic roster selection (always-on + language + keyword conditionals)"
```

---

### Task 4: Review phase — real prompts + schemas

**Files:**
- Modify: `~/.claude/workflows/plan-readiness-review.js`

- [ ] **Step 1: Add the schemas and the Review prompt builder**

In `plan-readiness-review.js`, after `selectRoster`, add:

```js
const SEVERITY = ['Blocker', 'Major', 'Minor']
const DIMENSION = ['alignment', 'grounding', 'executability', 'risk']

const GAP_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['gaps'],
  properties: {
    gaps: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['dimension', 'severity', 'title', 'detail', 'evidence', 'fix'],
        properties: {
          dimension: { enum: DIMENSION }, severity: { enum: SEVERITY },
          planSection: { type: 'string' }, specRef: { type: 'string' },
          title: { type: 'string' }, detail: { type: 'string' },
          evidence: { type: 'string' }, fix: { type: 'string' },
        },
      },
    },
    matrix: {
      type: ['object', 'null'], additionalProperties: false,
      properties: {
        requirements: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            required: ['id', 'text', 'status'],
            properties: {
              id: { type: 'string' }, specRef: { type: 'string' }, text: { type: 'string' },
              coveredBy: { type: 'array', items: { type: 'string' } },
              status: { enum: ['covered', 'partial', 'uncovered'] },
            },
          },
        },
        orphanPlanSteps: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            required: ['planStep'],
            properties: { planStep: { type: 'string' }, note: { type: 'string' } },
          },
        },
      },
    },
  },
}

function reviewPrompt(e, ctx) {
  const matrixAsk = e.key === 'alignment'
    ? '\n\nYou OWN the traceability matrix. Return `matrix` mapping every spec requirement to the plan steps that cover it (status covered|partial|uncovered) and any plan steps with no spec basis (orphanPlanSteps).'
    : '\n\nReturn `matrix: null` (only the alignment expert fills it).'
  return [
    `You are the ${e.key} expert on a plan-readiness panel. Lens: ${e.lens}.`,
    'Decide whether this implementation PLAN is ready to build from, judged against the SPEC, the project RULES, the ARCHITECTURE/DESIGN docs, and the real codebase.',
    'Query the codebase with the graphify skill (or smart-explore/grep if graphify is absent) to check the plan against how the code is actually built. Never invent facts you cannot see.',
    'Return GAPs only — concrete, evidenced problems. Each gap: dimension, severity (Blocker|Major|Minor), the plan section and spec reference it concerns, a clear detail, the evidence, and a suggested fix.' + matrixAsk,
    `\n=== SPEC ===\n${ctx.spec}`,
    `\n=== PLAN ===\n${ctx.plan}`,
    ctx.rules ? `\n=== PROJECT RULES ===\n${ctx.rules}` : '',
    ctx.designDocs ? `\n=== ARCHITECTURE / DESIGN DOCS ===\n${ctx.designDocs}` : '',
    `\n=== REPO ===\n${ctx.repoPath || '(no code / greenfield)'}`,
  ].join('\n')
}
```

- [ ] **Step 2: Wire the Review fan-out to use the prompt + schema**

Replace the Review block with:

```js
const ctx = { spec, plan, rules: a.rules || '', designDocs: a.designDocs || '', repoPath: a.repoPath || '' }

phase('Review')
const reviews = await parallelLimited(
  roster.map((e) => () =>
    agent(reviewPrompt(e, ctx), {
      label: `review:${e.key}`, phase: 'Review', schema: GAP_SCHEMA,
      ...(e.agentType ? { agentType: e.agentType } : {}),
    }).then((r) => ({ expert: e.key, gaps: r?.gaps || [], matrix: r?.matrix || null }))
  ),
  MAX_CONCURRENCY, STAGGER_MS
)
```

- [ ] **Step 3: Run smoke + detection + concurrency (no regression)**

Run: `node ~/.claude/skills/plan-readiness-review/tests/test-smoke.mjs && node ~/.claude/skills/plan-readiness-review/tests/test-detection.mjs && node ~/.claude/skills/plan-readiness-review/tests/test-concurrency.mjs`
Expected: three PASS lines.

- [ ] **Step 4: Commit**

```bash
echo "feat: review phase prompts + gap/matrix schema"
```

---

### Task 5: Debate phase

**Files:**
- Modify: `~/.claude/workflows/plan-readiness-review.js`

- [ ] **Step 1: Merge Review gaps into one numbered list**

After the Review block, add:

```js
const allGaps = []
let gid = 0
for (const r of reviews.filter(Boolean))
  for (const g of r.gaps) allGaps.push({ id: `G${++gid}`, expert: r.expert, ...g })
const matrix = reviews.find((r) => r?.expert === 'alignment')?.matrix || null
```

- [ ] **Step 2: Add the Debate schema + prompt and wire the fan-out**

Replace the `phase('Debate')` placeholder with:

```js
const REACTION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['reactions'],
  properties: {
    reactions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['gapId', 'stance', 'reason'],
        properties: {
          gapId: { type: 'string' },
          stance: { enum: ['concede', 'defend', 'dispute', 'add'] },
          reason: { type: 'string' },
        },
      },
    },
  },
}

function debatePrompt(e, ctx, gaps) {
  return [
    `You are the ${e.key} expert. Here are ALL gaps the panel raised about the plan.`,
    'For each gap you have a view on, react: concede (agree), defend (it is real, add weight), dispute (it is wrong or not a real problem), or add (a missing angle). Give a one-line reason. React only where you have something to say.',
    `\n=== GAPS ===\n${JSON.stringify(gaps, null, 1)}`,
    `\n=== SPEC ===\n${ctx.spec}\n\n=== PLAN ===\n${ctx.plan}`,
  ].join('\n')
}

phase('Debate')
const reactionsByExpert = await parallelLimited(
  roster.map((e) => () =>
    agent(debatePrompt(e, ctx, allGaps), {
      label: `debate:${e.key}`, phase: 'Debate', schema: REACTION_SCHEMA,
      ...(e.agentType ? { agentType: e.agentType } : {}),
    }).then((r) => ({ expert: e.key, reactions: r?.reactions || [] }))
  ),
  MAX_CONCURRENCY, STAGGER_MS
)
const allReactions = []
for (const r of reactionsByExpert.filter(Boolean))
  for (const x of r.reactions) allReactions.push({ expert: r.expert, ...x })
```

- [ ] **Step 3: Run smoke + detection + concurrency**

Run: `node ~/.claude/skills/plan-readiness-review/tests/test-smoke.mjs && node ~/.claude/skills/plan-readiness-review/tests/test-detection.mjs && node ~/.claude/skills/plan-readiness-review/tests/test-concurrency.mjs`
Expected: three PASS lines.

- [ ] **Step 4: Commit**

```bash
echo "feat: debate phase (experts react to the merged gap set)"
```

---

### Task 6: Decide phase — consensus, verdict, report

**Files:**
- Modify: `~/.claude/workflows/plan-readiness-review.js`
- Create: `~/.claude/skills/plan-readiness-review/tests/test-verdict.mjs`

- [ ] **Step 1: Write the failing verdict test**

Create `tests/test-verdict.mjs`:

```js
import assert from 'node:assert'
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

console.log('verdict tests: PASS')
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `node ~/.claude/skills/plan-readiness-review/tests/test-verdict.mjs`
Expected: FAIL — the Decide block returns the agent's `null`-driven fallback without computing the verdict from gaps/matrix.

- [ ] **Step 3: Add consensus folding, `computeVerdict`, `renderReport`, and the Decide call**

Replace the `phase('Decide')` placeholder and the final `return` with:

```js
// Fold reactions into a consensus per gap (counted, deterministic).
function foldConsensus(gaps, reactions) {
  return gaps.map((g) => {
    const rs = reactions.filter((r) => r.gapId === g.id)
    const endorsers = rs.filter((r) => r.stance === 'concede' || r.stance === 'defend').map((r) => r.expert)
    const dissenters = rs.filter((r) => r.stance === 'dispute').map((r) => r.expert)
    // dropped only if the original raiser is among dissenters and nobody endorses
    const retracted = dissenters.includes(g.expert) && endorsers.length === 0
    const status = retracted ? 'dropped' : dissenters.length > endorsers.length ? 'contested' : 'agreed'
    return { ...g, status, endorsers, dissenters }
  })
}

function computeVerdict(consensus, matrix) {
  const live = consensus.filter((c) => c.status !== 'dropped')
  const agreed = live.filter((c) => c.status === 'agreed')
  if (agreed.some((c) => c.severity === 'Blocker')) return 'MISALIGNED'
  const uncovered = (matrix?.requirements || []).some((r) => r.status === 'uncovered')
  if (uncovered) return agreed.some((c) => c.severity === 'Blocker') ? 'MISALIGNED' : 'NEEDS-WORK'
  const anyCoverageGap = (matrix?.requirements || []).some((r) => r.status !== 'covered')
  if (agreed.some((c) => c.severity === 'Major') || anyCoverageGap) return 'NEEDS-WORK'
  return 'READY'
}

function renderCoverage(matrix) {
  if (!matrix?.requirements?.length) return '_No traceability matrix produced._'
  const rows = matrix.requirements.map((r) => {
    const mark = r.status === 'covered' ? '✓' : r.status === 'partial' ? '◐' : '⚠'
    return `| ${r.id} | ${(r.text || '').replace(/\|/g, '\\|')} | ${(r.coveredBy || []).join(', ') || '—'} | ${mark} ${r.status} |`
  })
  const orphans = (matrix.orphanPlanSteps || []).map((o) => `- ${o.planStep}${o.note ? ` — ${o.note}` : ''}`)
  return [
    '| Req | Requirement | Covered by | Status |', '|---|---|---|---|', ...rows,
    orphans.length ? `\n**Plan steps with no spec basis:**\n${orphans.join('\n')}` : '',
  ].join('\n')
}

function renderReport({ verdict, consensus, matrix, date, panel, narrative }) {
  const live = consensus.filter((c) => c.status !== 'dropped')
  const byExpert = {}
  for (const c of live) (byExpert[c.expert] ||= []).push(c)
  const counts = SEVERITY.map((s) => `${s}: ${live.filter((c) => c.status === 'agreed' && c.severity === s).length}`).join(' · ')
  const groups = Object.entries(byExpert).map(([ex, gs]) => {
    const items = gs.map((c) =>
      `- **[${c.severity}] ${c.title}** (${c.dimension}${c.status === 'contested' ? ', contested' : ''})\n  - ${c.detail}\n  - _Evidence:_ ${c.evidence}\n  - _Fix:_ ${c.fix}`
    ).join('\n')
    return `### ${ex}\n${items}`
  }).join('\n\n')
  const contested = live.filter((c) => c.status === 'contested')
  const contestedBlock = contested.length
    ? '\n## Contested\n' + contested.map((c) => `- **${c.title}** — endorsed by ${c.endorsers.join(', ') || '—'}; disputed by ${c.dissenters.join(', ') || '—'}`).join('\n')
    : ''
  return [
    `# Plan Readiness Review — ${date || ''}`,
    `\n**Verdict: ${verdict}**  \nPanel: ${panel.join(', ')}  \nAgreed gaps — ${counts}`,
    narrative ? `\n${narrative}` : '',
    '\n## Spec ↔ Plan coverage', renderCoverage(matrix),
    '\n## Gaps by expert', groups || '_No gaps._',
    contestedBlock,
  ].join('\n')
}

phase('Decide')
const consensus = foldConsensus(allGaps, allReactions)
const verdict = computeVerdict(consensus, matrix)
// Optional one-paragraph narrative from a synthesis agent (best-effort).
const synth = await agent(
  `Write a 3-4 sentence plain-language summary of this plan-readiness outcome. Verdict: ${verdict}. Gaps:\n${JSON.stringify(consensus.filter((c) => c.status !== 'dropped'), null, 1)}`,
  { label: 'decide', phase: 'Decide' }
)
const narrative = typeof synth === 'string' ? synth : synth?.report || ''

const report = renderReport({
  verdict, consensus, matrix, date: a.date, panel: roster.map((e) => e.key), narrative,
})
return { report, verdict, consensus, matrix, panel: roster.map((e) => e.key) }
```

Note: the Decide agent is now best-effort prose only; the verdict and report are computed deterministically in code, so `test-verdict.mjs` (which returns `null` for `decide`) still gets a correct verdict and a rendered coverage table.

- [ ] **Step 4: Run the verdict test to confirm it passes**

Run: `node ~/.claude/skills/plan-readiness-review/tests/test-verdict.mjs`
Expected: `verdict tests: PASS`

- [ ] **Step 5: Run the full suite**

Run: `for t in smoke detection concurrency verdict; do node ~/.claude/skills/plan-readiness-review/tests/test-$t.mjs || break; done`
Expected: four PASS lines.

- [ ] **Step 6: Commit**

```bash
echo "feat: decide phase — consensus, verdict, coverage table, report"
```

---

### Task 7: The launcher (SKILL.md)

**Files:**
- Create: `~/.claude/skills/plan-readiness-review/SKILL.md`

- [ ] **Step 1: Write SKILL.md**

Create `~/.claude/skills/plan-readiness-review/SKILL.md` (study `~/.claude/skills/expert-panel-review/SKILL.md` for tone and rigor; the steps below are the contract):

````markdown
---
name: plan-readiness-review
description: Review a spec + implementation plan together, before any code is written, with a flat panel of expert subagents that argue to consensus. Returns a verdict (READY / NEEDS-WORK / MISALIGNED) and the gaps, grounded in the real codebase via graphify. Use when asked to check plan readiness, spec↔plan alignment, or whether a plan is good enough to build from.
---

# Plan Readiness Review

Run a flat-panel review of a spec + plan as a local dynamic workflow, then save the report
under the project's `docs/reviews/`.

**Announce at start:** "Running the plan-readiness review."

## Step 1 — Resolve the spec and plan

`/plan-readiness-review [spec] [plan]`.

1. **Two explicit paths given** → use them as `spec` and `plan`.
2. **No args** → newest file in `docs/specs/` is the spec, newest in `docs/plans/` is the plan.
   If either is missing or there is more than one plausible match, ask the user — do not guess.

Read both files. If either is empty, tell the user and STOP.

## Step 2 — Gather the raw bundle

`proj="$(git rev-parse --show-toplevel 2>/dev/null)"` (empty if not a git repo).

- **Rules:** if `"$proj/.claude/plan-review-rules.md"` exists, use it; else concatenate
  `"$proj/CLAUDE.md"`, `"$proj"/.claude/rules/*.md`, `"$proj"/docs/rules/*.md` (cap ~8000 chars).
- **Architecture/design docs:** concatenate `"$proj"/docs/architecture/*.md`,
  any `*ADR*`/`docs/architecture/adrs/*`, and existing design/spec docs the plan references
  (cap ~8000 chars). Prefix each with `=== <path> ===`.
- **Project languages:** `git -C "$proj" ls-files | sed 's/.*\.//' | sort | uniq -c | sort -rn`
  → take the extensions that map to a known language (py, ts, tsx, js, jsx, go, rs, java, rb).

## Step 3 — Refresh the code graph

If graphify is installed and `$proj` has code:
`graphify update "$proj"` (offline, incremental; builds the graph if none exists yet). If graphify is absent, skip — the
experts fall back to smart-explore/grep. Never block the review on this.

## Step 4 — Run the workflow

Invoke the **Workflow** tool:

- `scriptPath`: `<home>/.claude/workflows/plan-readiness-review.js` (expand `<home>` with `echo "$HOME"`)
- `args`: a JSON object:
  ```json
  {
    "spec": "<full spec text>",
    "plan": "<full plan text>",
    "repoPath": "<$proj, or empty>",
    "rules": "<rules text>",
    "designDocs": "<architecture/design docs text>",
    "projectLangs": ["py", "ts"],
    "rosterOverride": null,
    "date": "<YYYY-MM-DD from `date -u +%F`>"
  }
  ```
  Set `rosterOverride` to an array of agent names only if the user named a roster (e.g.
  `/plan-readiness-review … security-auditor,python-pro`).

The workflow returns `{ report, verdict, consensus, matrix, panel }`. If `report` is missing
or empty, show the error and STOP — never write an empty review.

## Step 5 — Save and summarize

1. Slug: the plan filename without extension, non-alphanumerics → `-`.
2. `mkdir -p "$proj/docs/reviews"` and write `report` to
   `"$proj/docs/reviews/<date>-<slug>-plan-readiness.md"`.
3. Print inline: the **verdict**, the panel that ran, agreed-gap counts by severity, the graph
   mode used (graphify / fallback / no-code), and the saved path. If the verdict is not READY,
   remind the user the next step is to revise the plan and re-run until it is READY.

## Cost note

Each run spawns roughly: roster size (5–9) × 2 rounds + 1 synthesis. At most
`MAX_CONCURRENCY` (default 4, env `PRR_MAX_CONCURRENCY`) run at once, to stay under rate limits.
Tell the user this only if they ask about cost; otherwise just run.
````

- [ ] **Step 2: Validate the frontmatter parses**

Run:
```bash
node -e "const fs=require('fs');const s=fs.readFileSync(process.env.HOME+'/.claude/skills/plan-readiness-review/SKILL.md','utf8');const m=s.match(/^---\n([\s\S]*?)\n---/);if(!m)throw new Error('no frontmatter');if(!/name:\s*plan-readiness-review/.test(m[1]))throw new Error('bad name');if(!/description:/.test(m[1]))throw new Error('no description');console.log('frontmatter OK')"
```
Expected: `frontmatter OK`

- [ ] **Step 3: Commit**

```bash
echo "feat: plan-readiness-review launcher (SKILL.md)"
```

---

### Task 8: End-to-end smoke + final checks

**Files:**
- Create: `~/.claude/skills/plan-readiness-review/tests/fixtures/spec.md`
- Create: `~/.claude/skills/plan-readiness-review/tests/fixtures/plan.md`
- Modify: `~/.claude/skills/plan-readiness-review/tests/test-verdict.mjs` (add the fixture case)

- [ ] **Step 1: Create a fixture with a deliberate uncovered requirement**

Create `tests/fixtures/spec.md`:

```markdown
# Spec
1. The system must store the uploaded file.
2. The system must email the user a receipt.
```

Create `tests/fixtures/plan.md`:

```markdown
# Plan
- Task 1: Write the file to disk in `src/store.py`.
```
(Requirement 2 — the receipt email — is intentionally uncovered.)

- [ ] **Step 2: Add a fixture-driven case to test-verdict.mjs**

Append to `tests/test-verdict.mjs` (before the final `console.log`):

```js
import { readFile } from 'node:fs/promises'
{
  const dir = process.env.HOME + '/.claude/skills/plan-readiness-review/tests/fixtures/'
  const spec = await readFile(dir + 'spec.md', 'utf8')
  const plan = await readFile(dir + 'plan.md', 'utf8')
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
```

- [ ] **Step 3: Run the full suite**

Run: `for t in smoke detection concurrency verdict; do node ~/.claude/skills/plan-readiness-review/tests/test-$t.mjs || break; done`
Expected: four PASS lines (the verdict file now prints last after both its blocks).

- [ ] **Step 4: Real end-to-end run (manual, optional but recommended)**

In a project that has a spec + plan (e.g. this repo), run `/plan-readiness-review` and confirm:
a report file appears under `docs/reviews/`, it has a verdict and a coverage table, and the
inline summary prints. This is the only step that spends real model tokens.

- [ ] **Step 5: Commit**

```bash
echo "test: end-to-end smoke with a deliberately uncovered requirement"
```

---

## Self-Review

**Spec coverage** (every `DESIGN.md` section → a task):
- No agent-to-agent handoff → launcher passes the raw bundle; experts read it directly (Task 4, Task 7). ✓
- Raw bundle (spec, plan, rules, arch docs) → Task 7 Step 2; passed to experts in Task 4. ✓
- graphify grounding + access chain + fresh `graphify update` → Task 7 Step 3; experts query in their prompt (Task 4). ✓
- Flat roster (always-on 5 + conditional) → Task 3. ✓
- Conditional detection (languages ∪ project langs; security/perf keywords; domain override-only) → Task 3. ✓
- Phases Review → Debate → Decide with barriers → Tasks 4, 5, 6. ✓
- Debate-to-consensus (concede/defend/dispute/add; agreed/contested/dropped) → Task 5, Task 6 `foldConsensus`. ✓
- Verdict rules (MISALIGNED / NEEDS-WORK / READY) → Task 6 `computeVerdict` + Task 8 fixture. ✓
- Output: coverage table + gaps by expert + contested section → Task 6 `renderReport`. ✓
- Concurrency cap (`MAX_CONCURRENCY` 4, overridable; optional stagger) → Task 2. ✓
- Error handling (missing spec/plan; no report) → Task 1 args guard, Task 7 Steps 1 & 4. ✓
- Testing (smoke, detection, concurrency, verdict, fallback) → Tasks 1–3, 6, 8. ✓

**Placeholder scan:** every code step shows real code; every run step shows the command and expected output. No TBD/TODO. ✓

**Type/name consistency:** `selectRoster`, `parallelLimited`, `reviewPrompt`, `debatePrompt`, `foldConsensus`, `computeVerdict`, `renderReport`, `renderCoverage` are defined once and used consistently. Schemas `GAP_SCHEMA`, `REACTION_SCHEMA`. Labels `review:<key>`, `debate:<key>`, `decide`. Args keys (`spec`, `plan`, `repoPath`, `rules`, `designDocs`, `projectLangs`, `rosterOverride`, `date`) match between SKILL.md (Task 7) and the workflow (Tasks 1–6). ✓

## Note on the Decide agent

The verdict and the report are computed **in code** (`computeVerdict`, `renderReport`), not by the
synthesis agent — the agent only writes a short plain-language narrative. This keeps the verdict
deterministic and testable, and means a flaky synthesis call never produces a wrong verdict.
````
