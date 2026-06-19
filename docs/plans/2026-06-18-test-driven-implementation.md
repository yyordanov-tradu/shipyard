# test-driven-implementation Implementation Plan

> **For agentic workers:** implement this plan one task at a time, running each test exactly as written before moving on. Steps use checkbox (`- [ ]`) syntax for tracking. (If the superpowers execution skills happen to be installed, `subagent-driven-development` or `executing-plans` can automate the loop — but they are not required; execute the steps manually otherwise.)

**Goal:** Build shipyard's `implement` stage — a SKILL.md launcher that turns a READY plan into committed code, task by task with TDD, using a small `lib/` of deterministic helpers for the parts that must be exact (plan parsing, stream partition, gate verdict, verify-gate sequencing).

**Architecture:** A **SKILL.md launcher** (the "lead") does the model-driven work — gate check, querying graphify for stream analysis, dispatching one fresh subagent per task, the light between-task review, integration, escalation, handoff. The **deterministic decisions** live in `skills/test-driven-implementation/lib/*.mjs` as pure functions that are also runnable as a CLI, so the launcher calls them via `node` and gets exact JSON. There is **no `workflows/*.js` Workflow-tool engine** — that pattern is for fan-out advisory skills; `implement` fans out *builder* agents whose determinism is the verify gate (tests), not JS orchestration.

**Tech Stack:** Plain JavaScript ESM (`.mjs`), Node ≥ 18, no TypeScript, no external dependencies; tests are standalone `.mjs` files using `node:assert` run with `node`. Each `lib` module exports pure functions **and** has a CLI entry guarded by `import.meta.url === pathToFileURL(process.argv[1]).href`.

**Reference files (read once):** `docs/specs/2026-06-18-test-driven-implementation-design.md` (the approved design); `docs/tooling.md` (tool-ownership bible); `skills/expert-advised-planning/SKILL.md` (sibling launcher style); `.claude/hooks/validate-skill-meta.sh` (frontmatter check the repo runs on Write/Edit).

## Global Constraints

- Language: plain JavaScript ESM `.mjs`; **no TypeScript**, **no external npm dependencies**. Node ≥ 18.
- Each `lib/*.mjs` module: `export` pure functions **and** a CLI entry guarded by `import.meta.url === pathToFileURL(process.argv[1]).href`. CLI prints JSON to stdout.
- Tests: standalone `.mjs`, `node:assert/strict`, run with `node <file>`; print `<name>: PASS` on success. No test framework.
- Tooling ownership follows `docs/tooling.md` verbatim: lead → graphify (macro, stream analysis); subagents → Serena (micro); Claude Code edits; ripgrep fallback; context7 for unfamiliar APIs. A subagent is given Serena but **not** graphify.
- Skill name (frontmatter `name:`): `test-driven-implementation`.
- Output skill folder: `skills/test-driven-implementation/{SKILL.md, lib/, tests/, DESIGN.md, PLAN.md}`.
- Stable shapes used across tasks:
  - `Task = { id: number, title: string, files: string[], deps: number[] }`
  - `parsePlan(md) -> { header: string, tasks: Task[] }`
  - `planStreams(tasks, { depEdges?: [number,number][], graphAvailable?: boolean }) -> { streams: number[][], parallel: boolean, conviction: 'high'|'low', reasons: string[] }`
  - `parseVerdict(text) -> 'READY'|'NEEDS-WORK'|'MISALIGNED'|null`
  - `pickLatestReport(filenames: string[], slug: string) -> string|null`
  - `sequenceGate({ typecheck?: string, lint?: string, test?: string }) -> { steps: {name,cmd}[], skipped: string[] }`

---

### Task 1: `lib/plan-parse.mjs` — parse a plan into tasks

**Files:**
- Create: `skills/test-driven-implementation/lib/plan-parse.mjs`
- Test: `skills/test-driven-implementation/tests/test-plan-parse.mjs`

**Interfaces:**
- Produces: `parsePlan(md) -> { header, tasks }` where `Task = { id, title, files, deps }`. `files` are paths with backticks and any `:line-range` suffix stripped; `deps` are task ids found via "depends on Task N".

- [ ] **Step 1: Write the failing test** — `skills/test-driven-implementation/tests/test-plan-parse.mjs`:

```js
import assert from 'node:assert/strict'
import { parsePlan } from '../lib/plan-parse.mjs'

const md = `# Some Plan

intro text

### Task 1: First

**Files:**
- Create: \`src/a.js\`
- Test: \`tests/a.test.js\`

body of one

### Task 2: Second

**Files:**
- Modify: \`src/b.js:10-20\`

This task depends on Task 1.
`

const { header, tasks } = parsePlan(md)
assert.ok(header.includes('Some Plan'), 'header captured')
assert.equal(tasks.length, 2, 'two tasks')
assert.equal(tasks[0].id, 1)
assert.equal(tasks[0].title, 'First')
assert.deepEqual(tasks[0].files, ['src/a.js', 'tests/a.test.js'], 'files, no backticks')
assert.deepEqual(tasks[1].files, ['src/b.js'], 'line-range stripped')
assert.deepEqual(tasks[1].deps, [1], 'explicit dep parsed')
assert.deepEqual(tasks[0].deps, [], 'no deps when none stated')
console.log('plan-parse: PASS')
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node skills/test-driven-implementation/tests/test-plan-parse.mjs`
Expected: FAIL — `Cannot find module '../lib/plan-parse.mjs'`.

- [ ] **Step 3: Write the implementation** — `skills/test-driven-implementation/lib/plan-parse.mjs`:

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node skills/test-driven-implementation/tests/test-plan-parse.mjs`
Expected: `plan-parse: PASS`.

- [ ] **Step 5: Commit**

```bash
git add skills/test-driven-implementation/lib/plan-parse.mjs skills/test-driven-implementation/tests/test-plan-parse.mjs
git commit -m "Task 1: plan parser for test-driven-implementation"
```

---

### Task 2: `lib/streams.mjs` — partition tasks into streams

**Files:**
- Create: `skills/test-driven-implementation/lib/streams.mjs`
- Test: `skills/test-driven-implementation/tests/test-streams.mjs`

**Interfaces:**
- Consumes: `Task[]` from `parsePlan` (uses `id`, `files`, `deps`).
- Produces: `planStreams(tasks, { depEdges, graphAvailable }) -> { streams, parallel, conviction, reasons }`. Tasks are grouped by union-find over file overlap, explicit `deps`, and `depEdges`. `parallel` is true only when `graphAvailable` and more than one independent stream exists (bias to sequential when graphify is absent).

- [ ] **Step 1: Write the failing test** — `skills/test-driven-implementation/tests/test-streams.mjs`:

```js
import assert from 'node:assert/strict'
import { planStreams } from '../lib/streams.mjs'

const tasks = [
  { id: 1, title: 'a', files: ['src/api.js'], deps: [] },
  { id: 2, title: 'b', files: ['src/api.js'], deps: [] }, // shares file with 1
  { id: 3, title: 'c', files: ['src/ui.js'], deps: [] },  // independent
]

// graph available, two independent groups -> parallel
const a = planStreams(tasks, { depEdges: [], graphAvailable: true })
assert.deepEqual(a.streams, [[1, 2], [3]], 'file overlap groups 1+2; 3 alone')
assert.equal(a.parallel, true, 'two independent streams + graph -> parallel')
assert.equal(a.conviction, 'high')

// graph absent -> sequential regardless
const b = planStreams(tasks, { graphAvailable: false })
assert.equal(b.parallel, false, 'no graph -> sequential')
assert.equal(b.conviction, 'low')

// explicit dep merges streams
const dep = planStreams(
  [{ id: 1, title: 'a', files: ['x.js'], deps: [] },
   { id: 2, title: 'b', files: ['y.js'], deps: [1] }],
  { graphAvailable: true })
assert.deepEqual(dep.streams, [[1, 2]], 'explicit dep merges')
assert.equal(dep.parallel, false, 'one stream -> not parallel')

// graphify edge merges streams
const edge = planStreams(
  [{ id: 1, title: 'a', files: ['x.js'], deps: [] },
   { id: 2, title: 'b', files: ['y.js'], deps: [] }],
  { depEdges: [[1, 2]], graphAvailable: true })
assert.deepEqual(edge.streams, [[1, 2]], 'graph edge merges')
console.log('streams: PASS')
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node skills/test-driven-implementation/tests/test-streams.mjs`
Expected: FAIL — `Cannot find module '../lib/streams.mjs'`.

- [ ] **Step 3: Write the implementation** — `skills/test-driven-implementation/lib/streams.mjs`:

```js
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node skills/test-driven-implementation/tests/test-streams.mjs`
Expected: `streams: PASS`.

- [ ] **Step 5: Commit**

```bash
git add skills/test-driven-implementation/lib/streams.mjs skills/test-driven-implementation/tests/test-streams.mjs
git commit -m "Task 2: stream partitioner for test-driven-implementation"
```

---

### Task 3: `lib/verdict.mjs` — read the plan-readiness verdict

**Files:**
- Create: `skills/test-driven-implementation/lib/verdict.mjs`
- Test: `skills/test-driven-implementation/tests/test-verdict.mjs`

**Interfaces:**
- Produces: `parseVerdict(text) -> 'READY'|'NEEDS-WORK'|'MISALIGNED'|null`; `pickLatestReport(filenames, slug) -> string|null` (newest date-prefixed `*<slug>*plan-readiness*.md`).

- [ ] **Step 1: Write the failing test** — `skills/test-driven-implementation/tests/test-verdict.mjs`:

```js
import assert from 'node:assert/strict'
import { parseVerdict, pickLatestReport } from '../lib/verdict.mjs'

assert.equal(parseVerdict('**Verdict:** READY\nmore'), 'READY')
assert.equal(parseVerdict('Verdict: NEEDS-WORK'), 'NEEDS-WORK')
assert.equal(parseVerdict('the verdict is MISALIGNED here'), 'MISALIGNED')
assert.equal(parseVerdict('no decision yet'), null)

const files = [
  '2026-06-10-foo-plan-readiness.md',
  '2026-06-18-foo-plan-readiness-v2.md',
  '2026-06-18-bar-plan-readiness.md',
  '2026-06-18-foo-other.md',
]
assert.equal(pickLatestReport(files, 'foo'), '2026-06-18-foo-plan-readiness-v2.md', 'newest foo readiness report')
assert.equal(pickLatestReport(files, 'baz'), null, 'no match -> null')
console.log('verdict: PASS')
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node skills/test-driven-implementation/tests/test-verdict.mjs`
Expected: FAIL — `Cannot find module '../lib/verdict.mjs'`.

- [ ] **Step 3: Write the implementation** — `skills/test-driven-implementation/lib/verdict.mjs`:

```js
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function parseVerdict(text) {
  const m = String(text).match(/verdict\b.*?(READY|NEEDS-WORK|MISALIGNED)/i)
  return m ? m[1].toUpperCase() : null
}

export function pickLatestReport(filenames, slug) {
  const matches = filenames
    .filter(f => f.includes(slug) && /plan-readiness/.test(f) && f.endsWith('.md'))
    .sort()
    .reverse()
  return matches[0] || null
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , reviewsDir, slug] = process.argv
  let out = { verdict: null, reportPath: null }
  try {
    const file = pickLatestReport(readdirSync(reviewsDir), slug)
    if (file) {
      const reportPath = join(reviewsDir, file)
      out = { verdict: parseVerdict(readFileSync(reportPath, 'utf8')), reportPath }
    }
  } catch { /* dir missing -> verdict null */ }
  process.stdout.write(JSON.stringify(out) + '\n')
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node skills/test-driven-implementation/tests/test-verdict.mjs`
Expected: `verdict: PASS`.

- [ ] **Step 5: Commit**

```bash
git add skills/test-driven-implementation/lib/verdict.mjs skills/test-driven-implementation/tests/test-verdict.mjs
git commit -m "Task 3: gate-verdict reader for test-driven-implementation"
```

---

### Task 4: `lib/verify-gate.mjs` — sequence the verify gate

**Files:**
- Create: `skills/test-driven-implementation/lib/verify-gate.mjs`
- Test: `skills/test-driven-implementation/tests/test-verify-gate.mjs`

**Interfaces:**
- Produces: `sequenceGate({ typecheck, lint, test }) -> { steps: {name,cmd}[], skipped: string[] }` in fixed order typecheck → lint → test; missing commands go to `skipped`.

- [ ] **Step 1: Write the failing test** — `skills/test-driven-implementation/tests/test-verify-gate.mjs`:

```js
import assert from 'node:assert/strict'
import { sequenceGate } from '../lib/verify-gate.mjs'

const full = sequenceGate({ typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'npm test' })
assert.deepEqual(full.steps.map(s => s.name), ['typecheck', 'lint', 'test'], 'cheap -> expensive order')
assert.equal(full.steps[0].cmd, 'tsc --noEmit')
assert.deepEqual(full.skipped, [])

const partial = sequenceGate({ test: 'pytest' })
assert.deepEqual(partial.steps.map(s => s.name), ['test'], 'only present steps run')
assert.deepEqual(partial.skipped, ['typecheck', 'lint'], 'missing steps reported')

const none = sequenceGate({})
assert.deepEqual(none.steps, [])
assert.deepEqual(none.skipped, ['typecheck', 'lint', 'test'])
console.log('verify-gate: PASS')
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node skills/test-driven-implementation/tests/test-verify-gate.mjs`
Expected: FAIL — `Cannot find module '../lib/verify-gate.mjs'`.

- [ ] **Step 3: Write the implementation** — `skills/test-driven-implementation/lib/verify-gate.mjs`:

```js
import { pathToFileURL } from 'node:url'

export function sequenceGate({ typecheck, lint, test } = {}) {
  const order = [['typecheck', typecheck], ['lint', lint], ['test', test]]
  const steps = []
  const skipped = []
  for (const [name, cmd] of order) {
    if (cmd) steps.push({ name, cmd })
    else skipped.push(name)
  }
  return { steps, skipped }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmds = process.argv[2] ? JSON.parse(process.argv[2]) : {}
  process.stdout.write(JSON.stringify(sequenceGate(cmds)) + '\n')
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node skills/test-driven-implementation/tests/test-verify-gate.mjs`
Expected: `verify-gate: PASS`.

- [ ] **Step 5: Commit**

```bash
git add skills/test-driven-implementation/lib/verify-gate.mjs skills/test-driven-implementation/tests/test-verify-gate.mjs
git commit -m "Task 4: verify-gate sequencer for test-driven-implementation"
```

---

### Task 5: `SKILL.md` — the launcher

**Files:**
- Create: `skills/test-driven-implementation/SKILL.md`

**Interfaces:**
- Consumes: all four `lib` CLIs (`plan-parse`, `streams`, `verdict`, `verify-gate`).
- Produces: the operator-facing skill. No code/tests of its own; validated by the repo's frontmatter hook and by `node --check` on the lib it references.

- [ ] **Step 1: Write the launcher** — `skills/test-driven-implementation/SKILL.md` (write this content exactly):

````markdown
---
name: test-driven-implementation
description: Build a READY implementation plan into committed code, task by task with TDD. A lead analyses the plan for independent streams, then a fresh subagent builds each task (locate → ground → edit → verify → commit), escalating to you on failures or conflicts. Use when asked to implement a plan, build out a plan's tasks, or turn a READY plan into code.
---

# Test-Driven Implementation

Turn a plan that passed the plan gate into committed code on a feature branch, ready for the
code gate. Quality comes from a tight per-task loop, not a big prompt. Tool ownership follows
**docs/tooling.md** (the bible): the lead uses graphify (macro); per-task subagents use
Serena (micro); Claude Code edits; ripgrep is the fallback.

**Announce at start:** "Running test-driven implementation."

`LIB="${CLAUDE_PLUGIN_ROOT}/skills/test-driven-implementation/lib"`

## Step 1 — Resolve the plan and enforce the gate

1. `/test-driven-implementation [plan-path] [--force] [--max-parallel N]`. Plan = the given
   path, else the newest file in `docs/plans/`. If none, STOP.
2. Slug = the plan filename without date prefix/extension. Read the verdict:
   `node "$LIB/verdict.mjs" docs/reviews "<slug>"`.
   - `verdict == "READY"` → proceed.
   - otherwise → **STOP**: tell the user to run `plan-readiness-review` first — unless `--force`
     was passed (record "forced" in the summary).
3. Announce.

## Step 2 — Stream analysis (graphify = the lead's macro tool)

1. Parse tasks: `node "$LIB/plan-parse.mjs" "<plan-path>"`.
2. If graphify is installed, query it for dependency edges between the areas the tasks touch
   (macro question — graphify owns it; see the bible). Build `depEdges` as `[[fromId,toId],...]`
   and set `graphAvailable=true`. If graphify is absent, `graphAvailable=false` (bias to
   sequential) and say so.
3. Partition: `node "$LIB/streams.mjs" "<plan-path>" '<depEdgesJson>' [--graph]`. Print the
   resulting streams, `parallel`, and `conviction` so the user sees the execution shape before
   any code is written.

## Step 3 — Build the tasks

Create/use a **feature branch** (the integration target). Then, per the schedule:

- **Sequential** (default, or `parallel=false`): run tasks in id order, one at a time, on the
  branch.
- **Parallel** (`parallel=true`): run each independent stream as a concurrent subagent in its
  own **git worktree** (Agent tool, `isolation: "worktree"`), at most `--max-parallel`
  (default **3**) at once; the rest queue. No Native Teams, no JSONL, no inter-agent messaging —
  git is the handoff.

### The subagent contract (one fresh subagent per task)

Give each subagent only:
- its **own task block** (full), the plan's **shared header**, and a **text slice** of your
  graphify orientation (where this change sits) — never other tasks' text;
- tools: **Serena** retrieval (symbols/refs/types/diagnostics), **Claude Code** `Edit`/`Write`,
  **Bash** (verify commands + git in its worktree), **ripgrep**, **context7**. **Not** graphify,
  **not** Serena's edit tools.

Each subagent runs the loop: **locate** (Serena → ripgrep) → **ground** unfamiliar APIs
(context7) → **edit test-first** (write failing test → implement → refactor; Claude Code) →
**verify** (sequence with `node "$LIB/verify-gate.mjs" '<cmdsJson>'`, run steps in order; widen
with Serena call-hierarchy for impacted tests) → fix to green → return `{branch, status}`.

## Step 4 — Review between tasks (light)

Before committing a task, confirm the verify gate passed (green, clean diagnostics) and sanity-
check the diff against the task's intent. A plainly off-intent diff is a failure (retry, then
escalate). Deep review is the **code gate's** job — do not duplicate it here. Commit per task:
`Task N: <desc>`.

## Step 5 — Failure and conflicts (escalate, never guess)

- A task that can't reach green after **2 retries** → STOP; show the task, the failing output,
  and what was tried; ask the user how to proceed (fix / skip / abort).
- A worktree integration/merge conflict → STOP; the user resolves it (never auto-resolve).

## Step 6 — Integrate and hand off

Integrate streams into the feature branch **sequentially** — merge one, run the full suite,
then the next. When the last task is in and the suite is green, **instruct, don't auto-run**:
print the branch, tasks completed (and any skipped/escalated/forced), suite status, and any
tools that fell back. End with: "Next: run `expert-panel-review` on this branch."
````

- [ ] **Step 2: Verify the frontmatter passes the repo's checker**

Run: `.claude/hooks/validate-skill-meta.sh skills/test-driven-implementation/SKILL.md` (or trigger it by saving the file; the repo's PostToolUse hook runs it on Write/Edit).
Expected: no frontmatter error (name + description present, well-formed).

- [ ] **Step 3: Verify the referenced lib parses**

Run: `for f in skills/test-driven-implementation/lib/*.mjs; do node --check "$f" && echo "ok $f"; done`
Expected: `ok` for all four modules.

- [ ] **Step 4: Commit**

```bash
git add skills/test-driven-implementation/SKILL.md
git commit -m "Task 5: SKILL.md launcher for test-driven-implementation"
```

---

### Task 6: In-folder DESIGN/PLAN, doc updates, full suite

**Files:**
- Create: `skills/test-driven-implementation/DESIGN.md`
- Create: `skills/test-driven-implementation/PLAN.md`
- Modify: `README.md` (status tables + stage table state)
- Modify: `docs/flow.md` (roadmap item 4 → done)

**Interfaces:**
- Consumes: the finished skill from Tasks 1–5.
- Produces: in-folder design/plan copies and docs that mark `implement` built.

- [ ] **Step 1: Copy the design and plan into the skill folder**

```bash
cp docs/specs/2026-06-18-test-driven-implementation-design.md skills/test-driven-implementation/DESIGN.md
cp docs/plans/2026-06-18-test-driven-implementation.md skills/test-driven-implementation/PLAN.md
```

- [ ] **Step 2: Mark `implement` built in README**

In `README.md`, in the first stage table, change the implement row's skill cell to add ✅:
`| implement | \`test-driven-implementation\` ✅ | build the plan task-by-task with TDD | Serena (find/diagnostics), Claude Code (edit) |`
and in the Status table change the implement row state to `✅ built + tested`. Update the Status
prose: the remaining generative stage is no longer pending (all stages built).

- [ ] **Step 3: Mark the roadmap item done in flow.md**

In `docs/flow.md`, roadmap item 4 (`implement` skill): prefix with **Done** —, matching the
style of items 1 and 3 (e.g. `4. **Done** — \`test-driven-implementation\` (the \`implement\` stage). ...`).

- [ ] **Step 4: Run the full skill test suite**

Run: `for t in skills/test-driven-implementation/tests/test-*.mjs; do node "$t" || exit 1; done`
Expected: four `... : PASS` lines, exit 0.

- [ ] **Step 5: Run the whole repo's skill suites (no regressions)**

Run: `for t in skills/*/tests/test-*.mjs; do node "$t" || exit 1; done; echo "ALL PASS"`
Expected: ends with `ALL PASS`.

- [ ] **Step 6: Commit**

```bash
git add skills/test-driven-implementation/DESIGN.md skills/test-driven-implementation/PLAN.md README.md docs/flow.md
git commit -m "Task 6: in-folder DESIGN/PLAN + docs mark implement stage built"
```

---

## Self-Review (run before execution)

- **Spec coverage:** entry+gate (Task 5 Step 1 + Task 3) · stream analysis/conviction (Task 2, Task 5 Step 2) · per-task loop + subagent contract + tool allowlist (Task 5 Step 3) · light review (Task 5 Step 4) · failure/conflict escalation (Task 5 Step 5) · integrate + instruct-handoff (Task 5 Step 6) · git envelope (Task 5 Step 3) · verify-gate sequencing (Task 4) · no `.js` engine / lib helpers (Tasks 1–4) · tests for deterministic logic (Tasks 1–4) · artifacts/layout (Task 6).
- **Placeholders:** none — every code/test step shows complete code; every command shows expected output.
- **Type consistency:** `parsePlan` → `{header,tasks}` with `Task={id,title,files,deps}` consumed unchanged by `planStreams`; `planStreams` returns `{streams,parallel,conviction,reasons}`; `parseVerdict`/`pickLatestReport`/`sequenceGate` signatures match their tests and the SKILL.md CLI calls.
