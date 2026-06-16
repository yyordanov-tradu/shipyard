# expert-advised-planning Implementation Plan

> **For agentic workers:** implement this plan one task at a time, running each test exactly as written before moving on. Steps use checkbox (`- [ ]`) syntax for tracking. (If the superpowers execution skills happen to be installed, `subagent-driven-development` or `executing-plans` can automate the loop — but they are not required; execute the steps manually otherwise.)

**Goal:** Build shipyard's plan-creation stage — a lead agent that drafts an executable plan after consulting an expert panel, with disagreements resolved by a neutral arbiter and escalated to a human when uncertain or high-stakes.

**Architecture:** A deterministic dynamic **Workflow** (`~/.claude/workflows/expert-advised-planning.js`) runs FRAME → ADVISE → RECONCILE(+arbiter) → DRAFT, with code (not agents) deciding escalation routing and rendering the audit sections. The human gate is a **two-call** flow: run 1 returns escalations + a `carry` payload; the launcher collects decisions; run 2 is invoked with `mode: "draft"` and the `carry`, which **skips phases 1-3 via a guard** (no journal/resume dependency). A **launcher** (`skills/expert-advised-planning/SKILL.md`) does I/O, source resolution, roster detection, the human turn, and writes the plan to `docs/plans/`. Same two-artifact split as `plan-readiness-review` and `expert-panel-review`.

**Tech Stack:** Plain JavaScript workflow (no TypeScript, no `process` global — overrides come from `args` only); Node ≥18 ESM `.mjs` tests with `node:assert`; the dry-run harness from `plan-readiness-review/tests/harness.mjs`; a shipyard-authored `PLAN_FORMAT_GUIDE` constant for the DRAFT step (no external plugin imported or required at runtime).

**Reference files (read once):** `~/.claude/workflows/plan-readiness-review.js`; `skills/plan-readiness-review/tests/harness.mjs`; `skills/plan-readiness-review/tests/test-detection.mjs`; `docs/specs/2026-06-16-expert-advised-planning-design.md`.

**Copy verbatim:** `parallelLimited` (PRR `~/.claude/workflows/plan-readiness-review.js`, the `async function parallelLimited` block); the `MAX_CONCURRENCY`/`STAGGER_MS` tunable block (read from `args`, NOT from any env var); `harness.mjs` (change only the `SCRIPT` path).

**Shared object shapes (stable across all tasks):**
- roster item: `{ key, agentType, lens }`
- `adviceByExpert` item: `{ expert, recommendations, risks, patterns, failed? }`
- conflict: `{ id, kind, summary, positions: [{party, stance}] }` (`id` used only within one run)
- decision: `{ conflictId, by, resolution, rationale, confidence, stakes, evidence }`
- **`resolved` item: `{ conflict, decision: {resolution, rationale, confidence, stakes}, by }`** (one shape; render reads `resolved.conflict.summary` and `resolved.decision.resolution`)
- `carry`: `{ framing, advice, resolved, roster, graphMode }`
- run-1 escalation return: `{ phase: 'awaiting-human', escalations, carry }`
- final return: `{ plan, resolved, escalations: [], panel, failedExperts }`
- test fakes key off labels: `frame`, `advise:<key>`, `reconcile`, `arbitrate:<id>`, `draft`.

---

### Task 1: Scaffold — harness, workflow skeleton, draft-mode flag

**Files:** Create `~/.claude/workflows/expert-advised-planning.js`, `skills/expert-advised-planning/tests/harness.mjs`, `skills/expert-advised-planning/tests/test-args.mjs`

- [ ] **Step 1: Copy the harness** — copy `skills/plan-readiness-review/tests/harness.mjs` to `skills/expert-advised-planning/tests/harness.mjs`, changing only:

```js
export const SCRIPT = process.env.HOME + '/.claude/workflows/expert-advised-planning.js'
```

- [ ] **Step 2: Write the failing test** — `skills/expert-advised-planning/tests/test-args.mjs`:

```js
import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'
const fake = async () => null
{
  const { result } = await runWorkflow(SCRIPT, { args: { source: '', date: '' }, agentImpl: fake })
  assert.equal(result.error, 'missing source', 'empty source must return {error}')
}
console.log('args tests: PASS')
```

- [ ] **Step 3: Run it to verify it fails** — `node skills/expert-advised-planning/tests/test-args.mjs` → FAIL (workflow file does not exist).

- [ ] **Step 4: Create the skeleton** — `~/.claude/workflows/expert-advised-planning.js`:

```js
export const meta = {
  name: 'expert-advised-planning',
  description:
    'Plan-creation stage: a lead drafts an executable plan after an expert panel advises; conflicts are arbitrated and escalated to a human when uncertain or high-stakes.',
  phases: [
    { title: 'Frame', detail: 'lead frames the problem and the decisions to consult on' },
    { title: 'Advise', detail: 'each expert advises on its area (parallel)' },
    { title: 'Reconcile', detail: 'detect conflicts and arbitrate them' },
    { title: 'Draft', detail: 'lead writes the executable plan bound to resolved decisions' },
  ],
}

// ---------- tunables (no `process` global — read overrides from args) ----------
const MAX_CONCURRENCY = Number(args?.maxConcurrency) || 4
const STAGGER_MS = Number(args?.staggerMs) || 0

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

// ---------- args ----------
const a = typeof args === 'string' ? JSON.parse(args) : args || {}
const DRAFT_MODE = a.mode === 'draft'
const source = (a.source || '').trim()
if (!DRAFT_MODE && !source) return { error: 'missing source' }

const ctx = {
  source, rules: a.rules || '', designDocs: a.designDocs || '',
  repoPath: a.repoPath || '', sourceRef: a.sourceRef || '',
}

return { error: 'not implemented' } // replaced in later tasks
```

- [ ] **Step 5: Run the test to verify it passes** — `node skills/expert-advised-planning/tests/test-args.mjs` → `args tests: PASS`.

- [ ] **Step 6: Commit**

```bash
git add skills/expert-advised-planning/tests/harness.mjs skills/expert-advised-planning/tests/test-args.mjs
git commit -m "expert-advised-planning: scaffold workflow skeleton + harness"
```

---

### Task 2: Roster selection

**Files:** Modify the workflow; Create `skills/expert-advised-planning/tests/test-detection.mjs`

- [ ] **Step 1: Write the failing test** — `skills/expert-advised-planning/tests/test-detection.mjs`:

```js
import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'
const fake = async (prompt, opts) => {
  if (opts.label === 'frame') return { problem: 'p', keyDecisions: [] }
  if (opts.label?.startsWith('advise:')) return { recommendations: [] }
  if (opts.label === 'reconcile') return { conflicts: [] }
  if (opts.label === 'draft') return '# Plan\n'
  return null
}
const adviseKeys = (calls) =>
  calls.filter((c) => c.opts.label?.startsWith('advise:')).map((c) => c.opts.label.slice(7))
{
  const { calls } = await runWorkflow(SCRIPT, { args: { source: 'a plain feature', projectLangs: [], date: '' }, agentImpl: fake })
  for (const k of ['architecture', 'test-strategy', 'security', 'performance'])
    assert.ok(adviseKeys(calls).includes(k), `missing always-on: ${k}`)
}
{
  const { calls } = await runWorkflow(SCRIPT, { args: { source: 'touch `src/x.py` and `web/app.tsx`', projectLangs: ['go'], date: '' }, agentImpl: fake })
  const keys = adviseKeys(calls)
  assert.ok(keys.includes('python-pro'), '.py -> python-pro')
  assert.ok(keys.includes('typescript-pro'), '.tsx -> typescript-pro')
  assert.ok(keys.includes('golang-pro'), 'project go -> golang-pro')
}
{
  const { calls } = await runWorkflow(SCRIPT, { args: { source: 'add a migration and a new table; render a React component', projectLangs: [], date: '' }, agentImpl: fake })
  const keys = adviseKeys(calls)
  assert.ok(keys.includes('database-optimizer'), 'migration/table -> database')
  assert.ok(keys.includes('frontend-developer'), 'React/component -> frontend')
}
{
  const { calls } = await runWorkflow(SCRIPT, { args: { source: 'x', extraExperts: ['integration-expert'], projectLangs: [], date: '' }, agentImpl: fake })
  assert.ok(adviseKeys(calls).includes('integration-expert'), '--add integration-expert')
}
{
  const { calls } = await runWorkflow(SCRIPT, { args: { source: 'x', rosterOverride: ['security-auditor'], projectLangs: [], date: '' }, agentImpl: fake })
  assert.deepEqual(adviseKeys(calls).sort(), ['security-auditor'])
}
console.log('detection tests: PASS')
```

- [ ] **Step 2: Run it to verify it fails** — FAIL (no `advise:` calls yet).

- [ ] **Step 3: Add the roster block** replacing `return { error: 'not implemented' }`:

```js
// ---------- roster ----------
const ALWAYS_ON = [
  { key: 'architecture', agentType: 'architect-review', lens: 'principles, patterns, decoupling, module boundaries, fit with existing code' },
  { key: 'test-strategy', agentType: 'qa-automation-architect', lens: 'validation points, testability, acceptance criteria, definition of done' },
  { key: 'security', agentType: 'security-auditor', lens: 'how to handle the security concern: auth, input, secrets, data exposure' },
  { key: 'performance', agentType: 'performance-engineer', lens: 'hot paths, scale, caching, allocation' },
]
const LANG_MAP = { py: 'python-pro', ts: 'typescript-pro', tsx: 'typescript-pro', js: 'javascript-pro', jsx: 'javascript-pro', go: 'golang-pro', rs: 'rust-pro', java: 'java-pro', rb: 'ruby-pro' }
const DB_RX = /\b(migration|schema|table|index|query|sql|orm|database|postgres|mysql|mongo)\b/i
const FE_RX = /\b(ui|react|component|page|css|frontend|browser|dom|tailwind|vue|svelte)\b/i
function withExtras(out, extraExperts) {
  const seen = new Set(out.map((r) => r.agentType).filter(Boolean))
  for (const x of (extraExperts || []).filter(Boolean)) {
    if (seen.has(x)) continue
    out.push({ key: x, agentType: x, lens: 'your own domain of expertise' }); seen.add(x)
  }
  return out
}
function selectRoster({ source, projectLangs, rosterOverride, extraExperts }) {
  if (rosterOverride?.length)
    return withExtras(rosterOverride.map((name) => ({ key: name, agentType: name, lens: 'override' })), extraExperts)
  const out = [...ALWAYS_ON]
  const exts = new Set()
  for (const m of source.matchAll(/[\w./-]+\.([A-Za-z0-9]+)/g)) exts.add(m[1].toLowerCase())
  for (const l of projectLangs || []) exts.add(String(l).toLowerCase())
  const langAgents = new Set()
  for (const e of exts) if (LANG_MAP[e]) langAgents.add(LANG_MAP[e])
  for (const ag of langAgents) out.push({ key: ag, agentType: ag, lens: 'language idioms and pitfalls' })
  if (DB_RX.test(source)) out.push({ key: 'database-optimizer', agentType: 'database-optimizer', lens: 'data model, queries, migrations' })
  if (FE_RX.test(source)) out.push({ key: 'frontend-developer', agentType: 'frontend-developer', lens: 'UI structure, state, accessibility' })
  return withExtras(out, extraExperts)
}
const roster = DRAFT_MODE ? (a.carry?.roster || []).map((k) => ({ key: k })) : selectRoster({
  source, projectLangs: a.projectLangs, rosterOverride: a.rosterOverride, extraExperts: a.extraExperts,
})

return { error: 'not implemented' } // replaced in Task 3+
```

- [ ] **Step 4: Confirm it parses** (test still fails — no `advise:` until Task 4). Run `node --check "$HOME/.claude/workflows/expert-advised-planning.js" && echo ok`.

- [ ] **Step 5: Commit** — `git add … test-detection.mjs && git commit -m "expert-advised-planning: roster selection"`

---

### Task 3: FRAME phase

**Files:** Modify the workflow; Create `skills/expert-advised-planning/tests/test-frame.mjs`

- [ ] **Step 1: Write the failing test** — `skills/expert-advised-planning/tests/test-frame.mjs`:

```js
import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'
let framePrompt = ''
const fake = async (prompt, opts) => {
  if (opts.label === 'frame') { framePrompt = prompt; return { problem: 'P', keyDecisions: [{ id: 'D1', question: 'reuse or build?' }] } }
  if (opts.label?.startsWith('advise:')) return { recommendations: [] }
  if (opts.label === 'reconcile') return { conflicts: [] }
  if (opts.label === 'draft') return '# Plan\n'
  return null
}
const { calls } = await runWorkflow(SCRIPT, { args: { source: 'build a thing', projectLangs: [], date: '' }, agentImpl: fake })
assert.equal(calls.filter((c) => c.opts.label === 'frame').length, 1, 'exactly one FRAME call')
assert.ok(framePrompt.includes('build a thing'), 'FRAME prompt includes the raw source')
console.log('frame tests: PASS')
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Add FRAME** replacing `return { error: 'not implemented' }`:

```js
// ---------- FRAME ----------
const FRAMING_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['problem', 'keyDecisions'],
  properties: {
    problem: { type: 'string' },
    keyDecisions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'question'], properties: { id: { type: 'string' }, question: { type: 'string' }, leadLean: { type: 'string' } } } },
    lanes: { type: 'array', items: { type: 'string' } },
  },
}
function framePromptText(ctx) {
  return [
    'You are the lead engineer creating an implementation plan. First FRAME the work.',
    'Read the SOURCE (a spec or a Jira ticket), the project RULES, the ARCHITECTURE/DESIGN docs, and the real codebase.',
    'Query the codebase live: graphify MCP tools -> graphify CLI -> smart-explore/grep. Never invent facts.',
    'Return a one-paragraph `problem`, and `keyDecisions` (id, question, optional leadLean).',
    `\n=== SOURCE ===\n${ctx.source}`,
    ctx.rules ? `\n=== PROJECT RULES ===\n${ctx.rules}` : '',
    ctx.designDocs ? `\n=== ARCHITECTURE / DESIGN DOCS ===\n${ctx.designDocs}` : '',
    `\n=== REPO ===\n${ctx.repoPath || '(no code / greenfield)'}`,
  ].join('\n')
}

let framing
if (!DRAFT_MODE) {
  phase('Frame')
  framing = (await agent(framePromptText(ctx), { label: 'frame', phase: 'Frame', schema: FRAMING_SCHEMA })) || { problem: '', keyDecisions: [] }
}

return { error: 'not implemented' } // replaced in Task 4+
```

- [ ] **Step 4: Run to verify it passes** — `frame tests: PASS`.

- [ ] **Step 5: Commit** — `… test-frame.mjs … -m "expert-advised-planning: FRAME phase"`

---

### Task 4: ADVISE phase

**Files:** Modify the workflow; Create `skills/expert-advised-planning/tests/test-concurrency.mjs`

- [ ] **Step 1: Write the failing concurrency test** (passes `maxConcurrency` via args — the workflow reads it from `args`, never an env var):

`skills/expert-advised-planning/tests/test-concurrency.mjs`:

```js
import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'
let inflight = 0, peak = 0
const fake = async (prompt, opts) => {
  if (opts.label === 'frame') return { problem: 'p', keyDecisions: [] }
  if (opts.label?.startsWith('advise:')) { inflight++; peak = Math.max(peak, inflight); await new Promise((r) => setTimeout(r, 15)); inflight--; return { recommendations: [] } }
  if (opts.label === 'reconcile') return { conflicts: [] }
  if (opts.label === 'draft') return '# Plan\n'
  return null
}
const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((x) => x + '-pro')
const { calls } = await runWorkflow(SCRIPT, { args: { source: 'S', rosterOverride: many, projectLangs: [], maxConcurrency: 2, date: '' }, agentImpl: fake })
assert.equal(calls.filter((c) => c.opts.label?.startsWith('advise:')).length, many.length, 'all override experts must advise')
assert.ok(peak <= 2, `peak concurrency ${peak} must be <= 2 (maxConcurrency arg)`)
console.log('concurrency test: PASS')
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Add ADVISE** replacing `return { error: 'not implemented' }`:

```js
// ---------- ADVISE ----------
const ADVICE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['recommendations'],
  properties: {
    recommendations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'text', 'rationale'], properties: { id: { type: 'string' }, text: { type: 'string' }, rationale: { type: 'string' }, evidence: { type: 'string' } } } },
    risks: { type: 'array', items: { type: 'string' } },
    patterns: { type: 'array', items: { type: 'string' } },
  },
}
function advisePromptText(e, ctx, framing) {
  return [
    `You are the ${e.key} adviser on a planning panel. Lens: ${e.lens}.`,
    'Advise the lead on the APPROACH for YOUR AREA ONLY. Do not write the plan; do not opine outside your lane.',
    'Query the codebase live (graphify MCP -> CLI -> smart-explore/grep). Ground every recommendation in what you can see.',
    'Return `recommendations` (id, text, rationale, evidence), plus `risks` and `patterns`.',
    `\n=== PROBLEM ===\n${framing.problem}`,
    `\n=== KEY DECISIONS ===\n${JSON.stringify(framing.keyDecisions, null, 1)}`,
    `\n=== SOURCE ===\n${ctx.source}`,
    ctx.rules ? `\n=== PROJECT RULES ===\n${ctx.rules}` : '',
    `\n=== REPO ===\n${ctx.repoPath || '(no code / greenfield)'}`,
  ].join('\n')
}

let adviceByExpert, failedExperts
if (!DRAFT_MODE) {
  phase('Advise')
  adviceByExpert = await parallelLimited(
    roster.map((e) => () =>
      agent(advisePromptText(e, ctx, framing), { label: `advise:${e.key}`, phase: 'Advise', schema: ADVICE_SCHEMA, ...(e.agentType ? { agentType: e.agentType } : {}) })
        .then((r) => ({ expert: e.key, recommendations: r?.recommendations || [], risks: r?.risks || [], patterns: r?.patterns || [] }))
        .catch(() => ({ expert: e.key, recommendations: [], risks: [], patterns: [], failed: true }))
    ), MAX_CONCURRENCY, STAGGER_MS)
  failedExperts = adviceByExpert.filter((r) => r && r.failed).map((r) => r.expert)
}

return { error: 'not implemented' } // replaced in Task 5+
```

- [ ] **Step 4: Run detection + concurrency to verify they pass.**

- [ ] **Step 5: Commit** — `… test-concurrency.mjs … -m "expert-advised-planning: ADVISE phase (parallel, capped)"`

---

### Task 5: RECONCILE — detect conflicts + neutral arbiter

**Files:** Modify the workflow; Create `skills/expert-advised-planning/tests/test-reconcile.mjs`

- [ ] **Step 1: Write the failing test** (asserts on the **stable outcome** — a failed arbiter's conflict ends up escalated — not on any temporary object shape):

`skills/expert-advised-planning/tests/test-reconcile.mjs`:

```js
import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'
const base = (arb) => async (prompt, opts) => {
  if (opts.label === 'frame') return { problem: 'p', keyDecisions: [] }
  if (opts.label?.startsWith('advise:')) return { recommendations: [{ id: 'r1', text: 't', rationale: 'r' }] }
  if (opts.label === 'reconcile') return { conflicts: [{ kind: 'expert-expert', summary: 'cache vs no-cache', positions: [{ party: 'performance', stance: 'cache' }, { party: 'architecture', stance: 'no cache' }] }] }
  if (opts.label?.startsWith('arbitrate:')) return arb(opts)
  if (opts.label === 'draft') return '# Plan\n'
  return null
}
// arbiter is structurally neutral: its call must carry NO agentType.
{
  const { calls } = await runWorkflow(SCRIPT, { args: { source: 'x', projectLangs: [], date: '' }, agentImpl: base(() => ({ resolution: 'cache', rationale: 'hot path', confidence: 'high', stakes: 'low' })) })
  assert.equal(calls.filter((c) => c.opts.label === 'reconcile').length, 1, 'one reconcile call')
  const arb = calls.filter((c) => c.opts.label?.startsWith('arbitrate:'))
  assert.equal(arb.length, 1, 'one arbiter call per conflict')
  assert.ok(!arb[0].opts.agentType, 'arbiter must run with NO agentType (structural neutrality)')
}
// arbiter failure must not drop the conflict: it ends up escalated.
{
  const { result } = await runWorkflow(SCRIPT, { args: { source: 'x', projectLangs: [], date: '' }, agentImpl: base(() => { throw new Error('boom') }) })
  assert.equal(result.escalations.length, 1, 'arbiter failure -> conflict escalates, not dropped')
}
console.log('reconcile tests: PASS')
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Add RECONCILE + neutral arbiter** replacing `return { error: 'not implemented' }`. The arbiter agent call deliberately passes **no `agentType`** (generic reasoner) so it is structurally never one of the conflicting parties:

```js
// ---------- RECONCILE ----------
const CONFLICT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['conflicts'],
  properties: { conflicts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind', 'summary', 'positions'], properties: {
    kind: { enum: ['expert-expert', 'framing-expert'] }, summary: { type: 'string' },
    positions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['party', 'stance'], properties: { party: { type: 'string' }, stance: { type: 'string' } } } },
  } } } },
}
const DECISION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['resolution', 'rationale', 'confidence', 'stakes'],
  properties: { resolution: { type: 'string' }, rationale: { type: 'string' }, confidence: { enum: ['high', 'med', 'low'] }, stakes: { enum: ['high', 'med', 'low'] }, evidence: { type: 'string' } },
}
function reconcilePromptText(ctx, framing, adviceByExpert) {
  return [
    'You are the reconciler. Read the framing and every adviser\'s recommendations.',
    'Find genuine CONFLICTS: expert-expert (incompatible recommendations) and framing-expert (an adviser contradicts the lead\'s leaning). Only real conflicts — when in doubt, do NOT invent one.',
    'Return `conflicts` (kind, one-line summary, positions party+stance).',
    `\n=== FRAMING ===\n${JSON.stringify(framing, null, 1)}`,
    `\n=== ADVICE ===\n${JSON.stringify(adviceByExpert.map((r) => ({ expert: r.expert, recommendations: r.recommendations })), null, 1)}`,
  ].join('\n')
}
function arbiterPromptText(c, ctx) {
  return [
    'You are a NEUTRAL arbiter — you are NOT one of the parties. Decide this conflict for the plan, on evidence not on who said it.',
    'Read both positions, the source, the rules, and the real codebase (graphify MCP -> CLI -> grep).',
    'Return: resolution, rationale, confidence (high|med|low), stakes (high|med|low), evidence.',
    `\n=== CONFLICT ===\n${JSON.stringify(c, null, 1)}`,
    `\n=== SOURCE ===\n${ctx.source}`,
    ctx.rules ? `\n=== PROJECT RULES ===\n${ctx.rules}` : '',
    `\n=== REPO ===\n${ctx.repoPath || '(no code / greenfield)'}`,
  ].join('\n')
}

let conflicts = [], decisions = []
if (!DRAFT_MODE) {
  phase('Reconcile')
  const detected = (await agent(reconcilePromptText(ctx, framing, adviceByExpert), { label: 'reconcile', phase: 'Reconcile', schema: CONFLICT_SCHEMA }))?.conflicts || []
  conflicts = detected.map((c, i) => ({ id: `C${i + 1}`, ...c }))
  // NEUTRAL arbiter: NO agentType, so it can never be one of the roster experts (structural).
  // An arbiter failure marks the decision low/high so routing (Task 6) escalates it — never dropped.
  decisions = await parallelLimited(
    conflicts.map((c) => () =>
      agent(arbiterPromptText(c, ctx), { label: `arbitrate:${c.id}`, phase: 'Reconcile', schema: DECISION_SCHEMA })
        .then((d) => ({ conflictId: c.id, by: 'arbiter', ...(d || {}), confidence: d?.confidence || 'low', stakes: d?.stakes || 'high' }))
        .catch(() => ({ conflictId: c.id, by: 'arbiter', resolution: '', rationale: 'arbiter failed', confidence: 'low', stakes: 'high' }))
    ), MAX_CONCURRENCY, STAGGER_MS)
}

return { error: 'not implemented' } // replaced in Task 6
```

- [ ] **Step 4: Run reconcile (case 1 — neutrality — passes; case 2 — escalation — still fails until Task 6).** That is expected; it goes fully green at the end of Task 6.

- [ ] **Step 5: Commit** — `… test-reconcile.mjs … -m "expert-advised-planning: RECONCILE + neutral arbiter"`

---

### Task 6: Routing (pure) + resolve/escalate + draft-mode guard

**Files:** Modify the workflow; Create `skills/expert-advised-planning/tests/test-routing.mjs`

- [ ] **Step 1: Write the failing test** — covers auto-resolve→draft, escalate→awaiting-human (no draft), human-resolved→draft, and the **draft-mode short-circuit** (no frame/advise/reconcile calls):

`skills/expert-advised-planning/tests/test-routing.mjs`:

```js
import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'
const oneConflict = { kind: 'expert-expert', summary: 's', positions: [{ party: 'a', stance: 'x' }, { party: 'b', stance: 'y' }] }
const mk = (conf, stakes) => async (prompt, opts) => {
  if (opts.label === 'frame') return { problem: 'p', keyDecisions: [] }
  if (opts.label?.startsWith('advise:')) return { recommendations: [{ id: 'r', text: 't', rationale: 'r' }] }
  if (opts.label === 'reconcile') return { conflicts: [oneConflict] }
  if (opts.label?.startsWith('arbitrate:')) return { resolution: 'x', rationale: 'r', confidence: conf, stakes }
  if (opts.label === 'draft') return '# Plan body\n'
  return null
}
// auto-resolve (high conf, low stakes) -> DRAFT -> plan
{
  const { result } = await runWorkflow(SCRIPT, { args: { source: 'x', projectLangs: [], date: '' }, agentImpl: mk('high', 'low') })
  assert.ok(result.plan, 'auto-resolved -> plan'); assert.equal(result.escalations.length, 0)
}
// escalate (low conf) -> awaiting-human, carry present, NO draft
{
  const { result, calls } = await runWorkflow(SCRIPT, { args: { source: 'x', projectLangs: [], date: '' }, agentImpl: mk('low', 'low') })
  assert.equal(result.phase, 'awaiting-human'); assert.equal(result.escalations.length, 1)
  assert.ok(result.carry && result.carry.resolved !== undefined && result.carry.advice, 'carry payload returned')
  assert.equal(calls.filter((c) => c.opts.label === 'draft').length, 0, 'no DRAFT before human resolves')
}
// med confidence is NOT high -> must escalate, never auto-resolve
{
  const { result } = await runWorkflow(SCRIPT, { args: { source: 'x', projectLangs: [], date: '' }, agentImpl: mk('med', 'low') })
  assert.equal(result.phase, 'awaiting-human', 'med confidence must escalate, not auto-resolve')
  assert.equal(result.escalations.length, 1)
}
// draft-mode: skips phases 1-3 entirely, merges humanDecisions, runs only DRAFT
{
  const carry = { framing: { problem: 'p', keyDecisions: [] }, advice: [{ expert: 'architecture', recommendations: [] }], resolved: [], roster: ['architecture'], graphMode: 'graphify' }
  const { result, calls } = await runWorkflow(SCRIPT, {
    args: { mode: 'draft', carry, humanDecisions: [{ conflictId: 'C1', resolution: 'go with x', note: 'lead call' }], date: '' },
    agentImpl: mk('low', 'low'),
  })
  assert.ok(result.plan, 'draft-mode -> plan')
  for (const l of ['frame', 'reconcile']) assert.equal(calls.filter((c) => c.opts.label === l).length, 0, `no ${l} call in draft mode`)
  assert.equal(calls.filter((c) => c.opts.label?.startsWith('advise:')).length, 0, 'no advise calls in draft mode')
  assert.equal(calls.filter((c) => c.opts.label === 'draft').length, 1, 'exactly one draft call')
}
console.log('routing tests: PASS')
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Add routing + resolve/escalate + draft-mode assembly** replacing `return { error: 'not implemented' }`:

```js
// ---------- routing (pure) ----------
// Spec rule: auto ONLY when high-confidence AND not high-stakes; everything else escalates
// (so med/low confidence escalates, and any high-stakes conflict escalates).
function routeDecision(d) { return d.confidence === 'high' && d.stakes !== 'high' ? 'auto' : 'escalate' }

let resolved = [], escalations = []
if (DRAFT_MODE) {
  // Reuse run-1's work; merge the human's decisions into the carried resolved set.
  framing = a.carry?.framing || { problem: '', keyDecisions: [] }
  adviceByExpert = a.carry?.advice || []
  failedExperts = []
  resolved = [...(a.carry?.resolved || [])]
  for (const h of a.humanDecisions || [])
    resolved.push({ conflict: { id: h.conflictId, summary: h.note || h.conflictId, positions: [] }, decision: { resolution: h.resolution, rationale: h.note || '', confidence: 'high', stakes: 'high' }, by: 'human' })
} else {
  for (const c of conflicts) {
    const d = decisions.find((x) => x.conflictId === c.id)
    if (d && routeDecision(d) === 'auto')
      resolved.push({ conflict: c, decision: { resolution: d.resolution, rationale: d.rationale, confidence: d.confidence, stakes: d.stakes }, by: 'arbiter' })
    else
      escalations.push({ conflict: c, arbiterLean: d || null })
  }
  if (escalations.length)
    return { phase: 'awaiting-human', escalations, carry: { framing, advice: adviceByExpert, resolved, roster: roster.map((e) => e.key), graphMode: a.graphMode || '' } }
}

return { error: 'not implemented' } // replaced in Task 7
```

- [ ] **Step 4: Run routing — escalate case passes; auto/human/draft cases still need DRAFT (Task 7) + assemble (Task 8). Expect partial pass.**

- [ ] **Step 5: Commit** — `… test-routing.mjs … -m "expert-advised-planning: routing + draft-mode guard"`

---

### Task 7: DRAFT phase (shipyard's own plan-format guide)

**Files:** Modify the workflow

- [ ] **Step 1: Define shipyard's own `PLAN_FORMAT_GUIDE`.** This is shipyard's own text — general good-practice rules for what a good plan looks like. It imports nothing, copies nothing, and requires no other plugin to be installed. Add this constant near the top of the workflow exactly as written:

```js
// ---------- shipyard's own plan-format guide (no external dependency) ----------
const PLAN_FORMAT_GUIDE = `
Write the plan so an engineer with zero context for this codebase can execute it.
- Bite-sized steps: each step is one 2-5 minute action.
- Test-first (TDD): write the failing test; run it and confirm it fails; write the minimal
  code to pass; run it and confirm it passes; commit.
- Every task names exact file paths (create / modify / test).
- Every code step shows the REAL code — never describe code in words.
- Every command shows the exact command and its expected output.
- NO placeholders: never write "TBD", "add error handling", "handle edge cases", or
  "same as above". Write the actual content.
- DRY, YAGNI, frequent commits.
`
```

  That is the whole guide — it is complete as written, not a stub to fill in.

- [ ] **Step 2: Add the DRAFT phase** replacing the Task-6 `return { error: 'not implemented' }`:

```js
// ---------- DRAFT ----------
function draftPromptText(ctx, framing, adviceByExpert, resolved) {
  return [
    'You are the lead engineer. Write the FULL implementation plan now.',
    PLAN_FORMAT_GUIDE,
    'Start with a header (one-sentence Goal, 2-3 sentence Architecture, Tech Stack), then the tasks.',
    'You MUST honor every resolved decision below — do not reopen them. Fold the advisers\' recommendations into the steps.',
    `\n=== PROBLEM ===\n${framing.problem}`,
    `\n=== ADVICE ===\n${JSON.stringify(adviceByExpert.map((r) => ({ expert: r.expert, recommendations: r.recommendations, risks: r.risks, patterns: r.patterns })), null, 1)}`,
    `\n=== RESOLVED DECISIONS (binding) ===\n${JSON.stringify(resolved.map((r) => ({ summary: r.conflict.summary, resolution: r.decision.resolution, by: r.by })), null, 1)}`,
    `\n=== SOURCE ===\n${ctx.source}`,
    ctx.rules ? `\n=== PROJECT RULES ===\n${ctx.rules}` : '',
    `\n=== REPO ===\n${ctx.repoPath || '(no code / greenfield)'}`,
    '\nReturn ONLY the plan markdown body.',
  ].join('\n')
}

phase('Draft')
const body = await agent(draftPromptText(ctx, framing, adviceByExpert, resolved), { label: 'draft', phase: 'Draft' })
const planBody = typeof body === 'string' ? body : ''
if (!planBody.trim()) return { error: 'draft produced no plan' }

return { error: 'not implemented' } // replaced in Task 8
```

**Notes:** (a) the `draft` call is **schema-less** and returns markdown **text** (mirrors PRR's synthesis call); every test's fake MUST return a non-empty string for `label === 'draft'` (objects for all other labels), or `planBody` is `''` and the run errors. (b) **Token budget:** this single call carries the full source + rules + advice + the format guide — the largest prompt in the workflow. Pass the framing + advice as the primary context and the raw source as support; if a source is very large, the launcher should frame-focus it.

- [ ] **Step 3: Run routing — draft now executes; final `result.plan` still assembled in Task 8.** Confirm a `draft` call now appears.

- [ ] **Step 4: Commit** — `git commit --allow-empty -m "expert-advised-planning: DRAFT phase (shipyard plan-format guide)"`

---

### Task 8: Render shipyard sections (in code) + final return

**Files:** Modify the workflow; Create `skills/expert-advised-planning/tests/test-render.mjs`

- [ ] **Step 1: Write the failing test** (also asserts the **graph-fallback** provenance line and the **output-shape** writing-plans markers):

`skills/expert-advised-planning/tests/test-render.mjs`:

```js
import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'
const fake = async (prompt, opts) => {
  if (opts.label === 'frame') return { problem: 'p', keyDecisions: [] }
  if (opts.label?.startsWith('advise:')) return { recommendations: [{ id: 'r', text: 'use existing validator', rationale: 'dry' }] }
  if (opts.label === 'reconcile') return { conflicts: [{ kind: 'expert-expert', summary: 'cache vs no-cache', positions: [{ party: 'a', stance: 'x' }, { party: 'b', stance: 'y' }] }] }
  if (opts.label?.startsWith('arbitrate:')) return { resolution: 'use a cache', rationale: 'hot path', confidence: 'high', stakes: 'low' }
  if (opts.label === 'draft') return '# Feature Plan\n\n**Goal:** x\n\n### Task 1\n- [ ] step\n'
  return null
}
const { result } = await runWorkflow(SCRIPT, { args: { source: 'x', sourceRef: 'docs/specs/foo.md', graphMode: 'fallback', projectLangs: [], date: '2026-06-16' }, agentImpl: fake })
assert.ok(result.plan.includes('# Feature Plan'), 'keeps drafted body')
assert.ok(/- \[ \]/.test(result.plan), 'output-shape: plan-format checkbox markers present')
assert.ok(result.plan.includes('## Decisions & trade-offs'), 'decisions section present')
assert.ok(result.plan.includes('cache vs no-cache'), 'conflict recorded')
assert.ok(result.plan.includes('## Adviser provenance'), 'provenance section present')
assert.ok(result.plan.includes('fallback'), 'graph-fallback mode recorded in provenance')
assert.ok(result.plan.includes('docs/specs/foo.md'), 'source ref present')
assert.equal(result.escalations.length, 0, 'no escalations in happy path')
console.log('render tests: PASS')
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Add render + final return** replacing the Task-7 `return { error: 'not implemented' }`:

```js
// ---------- render shipyard sections (in code) ----------
function renderDecisions(resolved) {
  if (!resolved.length) return '_No conflicts — advisers and the lead agreed._'
  return resolved.map((r) => {
    const opts = (r.conflict.positions || []).map((p) => `${p.party}: ${p.stance}`).join(' vs ') || '—'
    return `- **${r.conflict.summary}**\n  - _Options:_ ${opts}\n  - _Resolution:_ ${r.decision.resolution}\n  - _Decided by:_ ${r.by} (confidence ${r.decision.confidence || 'n/a'}, stakes ${r.decision.stakes || 'n/a'})\n  - _Why:_ ${r.decision.rationale || '—'}`
  }).join('\n')
}
function renderProvenance(adviceByExpert, graphMode) {
  const lines = (adviceByExpert || []).map((r) => `- **${r.expert}**${r.failed ? ' _(failed to run)_' : ''}: ${(r.recommendations || []).map((x) => x.text).slice(0, 5).join('; ') || '—'}`)
  return [`_Grounding: ${graphMode || 'unknown'}._`, ...lines].join('\n')
}
function assemblePlan({ body, resolved, adviceByExpert, sourceRef, graphMode, failedExperts }) {
  const panel = failedExperts?.length ? `\n_Advisers that failed to run: ${failedExperts.join(', ')}._\n` : ''
  return [
    body.trim(), '\n\n---\n',
    sourceRef ? `## Source\n\nBuilt from \`${sourceRef}\`.\n` : '',
    '## Decisions & trade-offs\n', renderDecisions(resolved), '',
    '## Adviser provenance\n', renderProvenance(adviceByExpert, graphMode), panel,
  ].join('\n')
}

const plan = assemblePlan({ body: planBody, resolved, adviceByExpert, sourceRef: ctx.sourceRef, graphMode: DRAFT_MODE ? a.carry?.graphMode : a.graphMode, failedExperts })
return { plan, resolved, escalations: [], panel: (DRAFT_MODE ? (a.carry?.roster || []) : roster.map((e) => e.key)), failedExperts: failedExperts || [] }
```

- [ ] **Step 4: Run render + routing — both pass.**

- [ ] **Step 5: Commit** — `… test-render.mjs … -m "expert-advised-planning: render sections + final return"`

---

### Task 9: Smoke test

**Files:** Create `skills/expert-advised-planning/tests/test-smoke.mjs`

- [ ] **Step 1: Write the smoke test** — `skills/expert-advised-planning/tests/test-smoke.mjs`:

```js
import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'
const fake = async (prompt, opts) => {
  if (opts.label === 'frame') return { problem: 'add rate limiting', keyDecisions: [{ id: 'D1', question: 'token bucket or fixed window?' }] }
  if (opts.label === 'advise:security') return { recommendations: [{ id: 's1', text: 'key by user not IP', rationale: 'shared NAT' }] }
  if (opts.label?.startsWith('advise:')) return { recommendations: [] }
  if (opts.label === 'reconcile') return { conflicts: [{ kind: 'expert-expert', summary: 'per-IP vs per-user keying', positions: [{ party: 'security', stance: 'per-user' }, { party: 'performance', stance: 'per-IP' }] }] }
  if (opts.label?.startsWith('arbitrate:')) return { resolution: 'per-user keying', rationale: 'correctness over micro-perf', confidence: 'high', stakes: 'med' }
  if (opts.label === 'draft') return '# Rate Limiting Plan\n\n**Goal:** add rate limiting\n\n### Task 1\n- [ ] step\n'
  return null
}
const { result } = await runWorkflow(SCRIPT, { args: { source: 'add API rate limiting', sourceRef: 'TICKET-42', projectLangs: ['ts'], graphMode: 'graphify', date: '2026-06-16' }, agentImpl: fake })
assert.ok(result.plan, 'produces a plan')
assert.ok(result.plan.includes('per-IP vs per-user keying'), 'records the resolved conflict')
assert.ok(result.plan.includes('per-user keying'), 'records the resolution')
assert.ok(result.panel.includes('typescript-pro'), 'ts project pulled in the language adviser')
assert.equal(result.escalations.length, 0, 'med stakes + high confidence => no escalation')
console.log('smoke test: PASS')
```

- [ ] **Step 2: Run it — passes.**

- [ ] **Step 3: Run the whole suite** — `for f in skills/expert-advised-planning/tests/test-*.mjs; do node "$f" || exit 1; done`.

- [ ] **Step 4: Commit** — `… test-smoke.mjs … -m "expert-advised-planning: smoke test"`

---

### Task 10: Wiring/validity test

**Files:** Create `skills/expert-advised-planning/tests/test-wiring.mjs`

- [ ] **Step 1: Write the wiring test** — proves the workflow parses, the SKILL.md frontmatter validates (via the hook, called the **correct** way — JSON on stdin), and the schema objects are valid JSON Schema:

`skills/expert-advised-planning/tests/test-wiring.mjs`:

```js
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

// 3) every JSON Schema the workflow passes to agent() is well-formed. Run the workflow once with a
// trivial fake, collect each distinct opts.schema, and assert it is a valid object schema.
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
```

(If `SKILL.md` does not exist yet when this runs, the frontmatter check is skipped; it becomes active once Task 11 lands. Run this test again after Task 11.)

- [ ] **Step 2: Run it — `node --check` passes; the frontmatter clause is skipped until Task 11.**

- [ ] **Step 3: Commit** — `… test-wiring.mjs … -m "expert-advised-planning: wiring/validity test"`

---

### Task 11: SKILL.md launcher

**Files:** Create `skills/expert-advised-planning/SKILL.md`

- [ ] **Step 1: Write the launcher.** Mirror `skills/plan-readiness-review/SKILL.md`. Use this content:

````markdown
---
name: expert-advised-planning
description: Create an executable implementation plan from a spec or a Jira ticket. A lead drafts the plan after an expert panel advises on the approach; conflicts are arbitrated and escalated to you only when uncertain or high-stakes. Use when asked to write a plan, turn a spec/ticket into a build plan, or plan a feature with expert input.
---

# Expert-Advised Planning

Create a plan as a local dynamic workflow: a lead consults an expert panel, resolves
disagreements, then writes the plan to the project's `docs/plans/`.

**Announce at start:** "Running expert-advised planning."

## Step 1 — Resolve the source
`/expert-advised-planning [source] [--add a,b] [--roster a,b]`.
1. A spec path or Jira key given -> use it.
2. No args -> newest file in `docs/specs/`; missing/ambiguous -> ask, do not guess.
3. Jira key (`^[A-Z]+-\d+$`) -> fetch the ticket and assemble body + acceptance criteria +
   comments + parent/linked issues into one text block.
Read the source. If empty, tell the user and STOP. Record `sourceRef` (path or key).

## Step 2 — Gather the raw bundle
`proj="$(git rev-parse --show-toplevel 2>/dev/null)"`.
- Rules: `"$proj/.claude/plan-review-rules.md"` if present, else `CLAUDE.md` +
  `.claude/rules/*.md` + `docs/rules/*.md` (cap ~8000 chars).
- Design docs: `docs/architecture/*.md`, ADRs, referenced specs (cap ~8000), each prefixed `=== <path> ===`.
- Languages: `git -C "$proj" ls-files | sed 's/.*\.//' | sort | uniq -c | sort -rn` -> known langs.

## Step 3 — Refresh the code graph
If graphify is installed and `$proj` has code: `graphify update "$proj"`. Else fall back.
Record `graphMode` (`graphify` / `fallback` / `no-code`).

## Step 4 — Offer add-on experts (optional)
List available add-on experts; collect any picks as `extraExperts`. Skip if none.

## Step 5 — Run the workflow
Invoke the **Workflow** tool:
- `scriptPath`: `<home>/.claude/workflows/expert-advised-planning.js` (expand `<home>` with `echo "$HOME"`)
- `args`:
  ```json
  {
    "source": "<full source text>", "sourceRef": "<path or key>", "repoPath": "<$proj or empty>",
    "rules": "<rules text>", "designDocs": "<design docs>", "projectLangs": ["ts"],
    "extraExperts": [], "rosterOverride": null, "graphMode": "graphify", "date": "<YYYY-MM-DD>"
  }
  ```
  Drop any `--add`/`--roster` agent that does not exist (warn the user).

## Step 6 — Human gate (only if escalated)
If the workflow returns `{ phase: "awaiting-human", escalations, carry }`, present each
escalation (both positions + the arbiter's lean) and collect one decision per conflict. Then
**re-invoke the Workflow** with args `{ "mode": "draft", "carry": <the returned carry>,
"humanDecisions": [{ "conflictId": "...", "resolution": "...", "note": "..." }], ...same setup }`.
This is a plain second call (no `resumeFromRunId`): the `mode: "draft"` guard skips phases 1-3
and only DRAFT runs. If the user cancels, STOP and write nothing.

## Step 7 — Save and summarize
The workflow returns `{ plan, resolved, escalations, panel, failedExperts }`. If `plan` is
missing/empty, show the error and STOP — never write an empty plan.
1. Slug: a short kebab-case name from the source title.
2. `mkdir -p "$proj/docs/plans"` and write `plan` to `"$proj/docs/plans/<date>-<slug>.md"`.
3. Print: the panel, conflicts (auto-resolved vs escalated), graph mode, any failed advisers, the path.
4. Remind the user the next step is the **plan-readiness-review** gate.

## Cost note
~ 1 frame + roster advisers + 1 reconciler + one arbiter per conflict + 1 draft, at most
`MAX_CONCURRENCY` (default 4, override via the `maxConcurrency` arg) at once. The draft-mode
second call adds only the single DRAFT agent.
````

- [ ] **Step 2: Validate the frontmatter the way the hook reads input** (JSON payload on stdin — NOT a positional arg):

```bash
printf '{"tool_input":{"file_path":"%s"}}' "$(pwd)/skills/expert-advised-planning/SKILL.md" | bash .claude/hooks/validate-skill-meta.sh && echo "frontmatter OK"
```

Expected: `frontmatter OK` / exit 0. (Confirm the hook's stdin contract first with `cat .claude/hooks/validate-skill-meta.sh`.)

- [ ] **Step 3: Re-run the wiring test** (now exercises the frontmatter clause): `node skills/expert-advised-planning/tests/test-wiring.mjs` → `wiring test: PASS`.

- [ ] **Step 4: Commit** — `… SKILL.md … -m "expert-advised-planning: SKILL.md launcher"`

---

### Task 12: In-folder DESIGN/PLAN + docs updates (incl. flow.md rule)

**Files:** Create `skills/expert-advised-planning/DESIGN.md`, `PLAN.md`; Modify `README.md`, `docs/flow.md`

- [ ] **Step 1: Copy design + plan into the skill folder**

```bash
cp docs/specs/2026-06-16-expert-advised-planning-design.md skills/expert-advised-planning/DESIGN.md
cp docs/plans/2026-06-16-expert-advised-planning.md skills/expert-advised-planning/PLAN.md
```

- [ ] **Step 2: Update `README.md`** stage table to the new names, marking `plan` built:

```markdown
| spec | `guided-spec-writing` | turn an idea into a spec (planned) | shipyard-owned (engine TBD) |
| plan | `expert-advised-planning` ✅ | turn a spec/ticket into a plan; lead drafts after an expert panel advises | graphify, expert subagents |
| **plan gate** | `plan-readiness-review` ✅ | spec ↔ plan alignment; verdict READY / NEEDS-WORK / MISALIGNED | git, graphify, expert subagents |
| implement | `test-driven-implementation` | build the plan task-by-task with TDD (planned) | Serena (find), Claude Code (edit) |
| **code gate** | `expert-panel-review` ✅ | multi-expert diff/PR review; findings verified by 3 skeptics | git, gh, graphify, expert subagents |
```

Also mark the `plan` row `✅ built + tested` in the Status table.

- [ ] **Step 3: Update `docs/flow.md` — ALL THREE graphify-boundary references** (grep `flow.md` for `graphify` and fix every spot that says plan-creation excludes it):
  1. The graphify-section sentence "The `plan` *creation* stage does not use it" → *"`plan` creation now grounds adviser and arbiter reasoning in graphify (with smart-explore/grep fallback); graphify stays read-only and is also used by the plan gate and code gate."*
  2. The **three-tools table** Phase column for graphify: change `review gates` → `plan creation + review gates`.
  3. The **Roadmap item 3** sentence ("Plan creation is purely the engine; graphify enters later, at the plan gate") → state plan creation now uses graphify for adviser/arbiter grounding.

  Also update the pipeline diagram + stage table to the new names, mark the plan stage built, and add a one-line note: *"Skills are named `<modifier>-<activity>`; gates end in `-review`."*

- [ ] **Step 4: Commit** — `git add skills/expert-advised-planning/DESIGN.md skills/expert-advised-planning/PLAN.md README.md docs/flow.md && git commit -m "expert-advised-planning: in-folder design/plan + docs updates"`

---

### Task 13: Full suite + finish

**Files:** none

- [ ] **Step 1: Run the new skill's suite** — `for f in skills/expert-advised-planning/tests/test-*.mjs; do echo "== $f"; node "$f" || exit 1; done`. Expected: every file prints `PASS`.

- [ ] **Step 2: No regressions in the existing gates** — `for f in skills/plan-readiness-review/tests/test-*.mjs skills/expert-panel-review/tests/test-*.mjs; do node "$f" || exit 1; done`.

- [ ] **Step 3: Verify the workflow parses** — `node --check "$HOME/.claude/workflows/expert-advised-planning.js" && echo "workflow parses"`.

- [ ] **Step 4: Finish the branch** — we are already on `feat/expert-advised-planning`; decide merge vs PR with the user. Do NOT merge to `main` without the user's go-ahead. (The `superpowers:finishing-a-development-branch` skill automates this if installed; otherwise do it with plain git.)

---

## Self-Review (run before execution)

**Spec coverage** — every spec requirement maps to a task (Blocker/Major fixes folded in):
- Inputs/bundle/grounding → Task 11 (launcher) + prompts in Tasks 3-5; arbiter grounding in Task 5.
- Roster (always-on 4 + conditional + `--add` + `--roster`) → Task 2.
- FRAME / ADVISE / RECONCILE+neutral-arbiter / DRAFT → Tasks 3, 4, 5, 7.
- Disagreement ladder + **structural arbiter neutrality (no agentType, asserted)** → Tasks 5, 6.
- Routing in code; **two-call human gate via `mode:"draft"`+`carry` (no resume/journal)** → Task 6 + Task 11 Step 6.
- Output (shipyard plan-format body + shipyard sections, to `docs/plans/`) → Tasks 7, 8, 11.
- Determinism (routing + section render in code) → Tasks 6, 8.
- **Plan-format guide is shipyard's own** (self-contained constant, no external plugin) → Task 7 Step 1.
- Error handling (missing source, arbiter fail → escalate, no empty plan) → Tasks 1, 5, 7, 8.
- Tests: args, detection, frame, concurrency (**maxConcurrency via args**), reconcile (**neutrality + escalation outcome**), routing (**auto/escalate/draft-mode short-circuit**), render (**graph-fallback + output-shape**), smoke, **wiring/validity (node --check + hook-via-stdin + schemas)** → Tasks 1-10.
- **flow.md graphify-boundary rewrite** → Task 12 Step 3.

**Placeholder scan** — no "TBD"/"add error handling"/"similar to above"; every code step has real code; the `return { error: 'not implemented' }` markers are intentional and replaced in the next task, never left at the end.

**Type consistency** — single shapes used throughout (see "Shared object shapes" header). `resolved` is `{conflict, decision:{resolution,rationale,confidence,stakes}, by}` everywhere; render reads `resolved.conflict.summary` / `resolved.decision.resolution`. The `carry` payload passes full objects, so positional conflict ids (`C1..Cn`) are never matched across runs. The concurrency test sets `maxConcurrency` via args (the workflow reads it from `args`, never an env var). The arbiter agent call carries no `agentType` and the reconcile test asserts it.
