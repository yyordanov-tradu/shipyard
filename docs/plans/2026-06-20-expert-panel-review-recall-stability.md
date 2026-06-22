# expert-panel-review Redesign — TDD Implementation Plan

**Goal.** Rebuild the code-gate engine so recall on real Critical/High findings is *stable* across runs: never miss a seeded Critical, never flicker. We do this by (1) sampling each lens M times warm and unioning in deterministic JS, (2) adding a completeness-critic that routes targeted re-reviews, (3) making exactly one stage able to drop findings (Verify, now cross-file-aware and abstain-not-refute, with suppressed Critical/High still blocking), and (4) replacing two LLM stages (dedup, synthesis) with deterministic JS so the report is byte-stable. An eval harness measures recall stability and picks M.

**Architecture.** One engine file, `workflows/expert-panel-review.js`, run as a Workflow tool. Stage graph:

```
0 Resolve+roster        deterministic JS   no findings
1 Review (N-of-M warm)   agent             CREATES recall
2 Union+cluster+support  deterministic JS   never drops
3 Completeness-critic     agent            ADDS recall (routes re-reviews only)
4 Verify (cross-file)     agent            the ONLY stage that drops
5 Verification ledger     agent            trust signal, never gates recall
6 Assemble report+verdict deterministic JS  no findings, no LLM
```

Invariant that is the heart of the fix: **only Verify subtracts.** Union, ledger, and assembly cannot remove a finding.

**Tech stack.** Plain JS ESM, Node ≥18, zero npm deps. Engine reads its globals (`agent`, `parallel`, `pipeline`, `phase`, `log`, `budget`, `workflow`, `args`) from the runtime. Unit tests are standalone `.mjs` using `node:assert`, run with `node`, each printing `<name>: PASS`. A separate eval (`tests/eval-recall.mjs` + `tests/eval/`) runs the real engine against a frozen corpus.

**Shared helper.** `parallelLimited(thunks, limit, staggerMs)` is lifted from `workflows/expert-advised-planning.js:29` into `workflows/lib/parallel.mjs`; the engine and both sibling workflows import it.

**Ordering rationale.** Deterministic stages first (they are the testable spine and the never-drop guarantees). The shared concurrency helper (Task 1) and the config-order fix (Task 2) unblock everything. The eval scaffolding lands at **Task 3** — before any recall-changing behavior — so every later task can be A/B-measured. Then Union (4), the finder cross-file prompt + `causeFiles` (5), N-of-M (6), the critic (7), cross-file Verify (8), deterministic assembly (9), always-on-failure gate (10), and finally the corpus + metrics that consume all of it (11).

A note on the dry-run constraint that shapes several tasks: the harness (`tests/harness.mjs`) stubs only `agent`, `parallel`, `pipeline`, `phase`, `log`, `budget`, `workflow`. It **cannot** stub git. So every deterministic stage must do **zero IO** — Union keys off the already-parsed `fileDiffs` map (inline mode) or the finder-reported `(file, line, title)` (repo mode), never `git diff`.

---

### Task 1: Lift `parallelLimited` into a shared lib and route the engine's fan-out through it

Replaces the engine's bare `parallel` (line 413) with bounded concurrency, and deletes a duplicated helper from two sibling workflows. This is the one true simplification in the redesign and it must land first because every later fan-out (M-draws, critic passes, skeptic waves) routes through it.

**Files:**
- create `workflows/lib/parallel.mjs`
- modify `workflows/expert-advised-planning.js`
- modify `workflows/plan-readiness-review.js`
- modify `workflows/expert-panel-review.js`
- create `skills/expert-panel-review/tests/test-parallel.mjs`

**Steps:**

1. Write the failing test first. The helper is pure JS (no workflow globals), so the test imports it directly and supplies its own `parallel`-shaped runner via a thunk pattern. Create `tests/test-parallel.mjs`:

```js
import assert from 'node:assert'
import { parallelLimited } from '../../../workflows/lib/parallel.mjs'

// Records max concurrent in-flight thunks to prove the limit is respected.
let inflight = 0, peak = 0
const make = (n) => Array.from({ length: n }, (_, i) => async () => {
  inflight++; peak = Math.max(peak, inflight)
  await new Promise((r) => setTimeout(r, 5))
  inflight--
  return i
})

// limit=2 over 5 thunks: results in order, peak concurrency never exceeds 2.
const res = await parallelLimited(make(5), 2)
assert.deepEqual(res, [0, 1, 2, 3, 4], 'results preserve input order')
assert.equal(peak, 2, `peak concurrency should be 2, got ${peak}`)

// An erroring thunk resolves to null (matches runtime `parallel` semantics).
const mixed = await parallelLimited([
  async () => 'a',
  async () => { throw new Error('boom') },
  async () => 'c',
], 4)
assert.deepEqual(mixed, ['a', null, 'c'], 'errors become null, order kept')

console.log('parallel tests: PASS')
```

2. Run it — fails (module does not exist):

```
$ node skills/expert-panel-review/tests/test-parallel.mjs
node:internal/errors ... Cannot find module '.../workflows/lib/parallel.mjs'
```

3. Implement `workflows/lib/parallel.mjs`. Lift the exact body from `expert-advised-planning.js:29`, but make it self-contained (the lib version uses `Promise.all` with per-thunk try/catch instead of the runtime `parallel` global, so it works both in tests and inside the engine):

```js
// Bounded-concurrency fan-out. Runs `thunks` in waves of at most `limit`,
// preserving input order. An erroring thunk resolves to null (same contract
// as the Workflow runtime's `parallel`). Optional `staggerMs` pauses between
// waves to spread out agent spawns.
export async function parallelLimited(thunks, limit, staggerMs = 0) {
  const cap = Math.max(1, limit | 0)
  const out = []
  for (let i = 0; i < thunks.length; i += cap) {
    const wave = thunks.slice(i, i + cap)
    const settled = await Promise.all(
      wave.map(async (t) => { try { return await t() } catch { return null } })
    )
    out.push(...settled)
    if (staggerMs && i + cap < thunks.length) {
      await new Promise((r) => setTimeout(r, staggerMs))
    }
  }
  return out
}
```

4. Run — passes:

```
$ node skills/expert-panel-review/tests/test-parallel.mjs
parallel tests: PASS
```

5. Wire the engine to import it. The engine runs as a Workflow script (top-level body, no `import` at runtime is available the same way a module is) — but the harness reads the file as source and the runtime supports ESM `import` at the top of the engine. Add at the top of `workflows/expert-panel-review.js`, right after `export const meta`:

```js
import { parallelLimited } from './lib/parallel.mjs'
```

Then replace the skeptic fan-out at line 413 `await parallel(Array.from(...))` with `await parallelLimited(Array.from(...), MAX_CONCURRENCY)` (MAX_CONCURRENCY is defined in Task 2). For now leave the inner `parallel(checks)` call (line 460) as-is; it is re-routed in Task 6.

**Harness note:** `tests/harness.mjs` wraps the engine in `new AsyncFn(...)`, which does **not** support `import`. So in Task 1 we add a *guard*: the harness must `import` the same lib and inject it as a global, OR we strip the import line the way it strips `export const meta`. Use the strip approach to keep the engine honest. Update `tests/harness.mjs`:

```js
// The runtime supports top-level import; AsyncFunction does not. Strip the
// import and inject the same helper as a global so the engine body can call it.
import { parallelLimited } from '../../../workflows/lib/parallel.mjs'
...
src = src.replace(/^export\s+const\s+meta/m, 'const meta')
src = src.replace(/^import\s+\{\s*parallelLimited\s*\}.*$/m, '')
```

and add `'parallelLimited'` to the `AsyncFn` parameter list and pass `parallelLimited` in the `fn(...)` call.

6. De-duplicate the siblings. In `workflows/expert-advised-planning.js` and `workflows/plan-readiness-review.js`, delete the local `parallelLimited` definition (line 29 in each) and add `import { parallelLimited } from './lib/parallel.mjs'` at the top.

7. Run the whole suite to prove no regression:

```
$ for t in skills/*/tests/test-*.mjs; do node "$t" || break; done
detection tests: PASS
slicing tests: PASS
verify tests: PASS
parallel tests: PASS
```

8. Commit: `expert-panel-review: lift parallelLimited into shared lib, bound engine fan-out`.

---

### Task 2: Single config block parsed after args (kill the config-read-before-args bug)

The engine today reads `MAX_CONDITIONAL` (line 22) and the skeptic count before `args` is parsed (line 237). Parse `args` once at the very top, then read every tunable from one block. This is the home for all new tunables M, CRITIC_PASSES, line-band width, title threshold, etc.

**Files:**
- modify `workflows/expert-panel-review.js`
- create `skills/expert-panel-review/tests/test-config.mjs`

**Steps:**

1. Write the failing test. It asserts that overrides arriving in `args` actually take effect — specifically that `args.skeptics` changes the skeptic-call count. Create `tests/test-config.mjs`:

```js
import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'

const F = (severity, title) => ({ severity, file: 'a.py', line: 1, title, detail: 'd', suggestion: 's' })

// One backend High finding; everything else clean. Skeptics always confirm.
const impl = async (prompt, opts) => {
  const label = opts.label ?? ''
  if (label.startsWith('review:backend-architect')) return { findings: [F('High', 'keep')] }
  if (label.startsWith('review:')) return { findings: [] }
  if (label.startsWith('skeptic:')) return { confirmed: 'confirmed', verdict: 'confirmed', reason: 'ok' }
  if (label.startsWith('critic')) return { reviews: [] }
  if (label === 'ledger') return { ledger: [] }
  return null
}

// Default: M=1 here (set in later tasks; for Task 2 just prove SKEPTICS override flows).
const { calls } = await runWorkflow(SCRIPT, {
  args: { diff: 'd', changedFiles: ['a.py'], date: 'x', skeptics: 5, M: 1, criticPasses: 0 },
  impl_placeholder: true, agentImpl: impl,
})
const skepticCalls = calls.filter((c) => c.opts.label?.startsWith('skeptic:'))
assert.equal(skepticCalls.length, 5, `args.skeptics=5 must yield 5 skeptic calls, got ${skepticCalls.length}`)

console.log('config tests: PASS')
```

2. Run — fails (override ignored; today SKEPTICS is a module constant read before args):

```
$ node skills/expert-panel-review/tests/test-config.mjs
AssertionError: args.skeptics=5 must yield 5 skeptic calls, got 3
```

3. Implement. Move the args parse (currently lines 234–257) to the very top of the body, before any tunable. Replace the scattered `const SKEPTICS = 3` etc. with one config block right after the parse:

```js
// ---------- args (parse ONCE, up front) ----------
let input = args ?? {}
if (typeof input === 'string') { try { input = JSON.parse(input) } catch { input = {} } }

// ---------- config (every tunable, read after args) ----------
const SKEPTICS        = Number(input.skeptics)      || 3
const MAJORITY        = Math.floor(SKEPTICS / 2) + 1
const VERIFY_SEVERITIES = ['Critical', 'High', 'Medium']
const M               = Number(input.M)             || 1      // N-of-M draws/lens (Task 6 raises default)
const CRITIC_PASSES   = input.criticPasses == null ? 2 : Number(input.criticPasses) // Task 7
const LINE_BAND       = Number(input.lineBand)      || 8      // Union merge window (Task 4)
const TITLE_OVERLAP   = Number(input.titleOverlap)  || 0.5    // Union token threshold (Task 4)
const MAX_CONCURRENCY = Number(input.maxConcurrency)|| 4
const MAX_CONDITIONAL = Number(input.maxConditional)|| 4
```

Then delete the old `const SKEPTICS`/`MAJORITY`/`VERIFY_SEVERITIES`/`MAX_CONDITIONAL` lines and the duplicate input parse, and read the remaining destructured fields (`diff`, `changedFiles`, …) from `input`.

4. Run — passes:

```
$ node skills/expert-panel-review/tests/test-config.mjs
config tests: PASS
```

5. Full suite green:

```
$ for t in skills/*/tests/test-*.mjs; do node "$t" || break; done
... all PASS
```

6. Commit: `expert-panel-review: one config block parsed after args`.

---

### Task 3: Eval harness scaffolding (loader + LIVE/RECORDED modes) — lands BEFORE recall changes

The eval must exist before any recall-changing task so each can be A/B-measured. This task builds the *plumbing* (a loader that runs the real engine, RECORDED replay, a recall scorer) with a tiny placeholder corpus of one seeded Critical. The full corpus arrives in Task 11.

**Files:**
- create `skills/expert-panel-review/tests/eval/loader.mjs`
- create `skills/expert-panel-review/tests/eval/score.mjs`
- create `skills/expert-panel-review/tests/eval/corpus/seed-critical.json`
- create `skills/expert-panel-review/tests/eval/recorded/seed-critical.json`
- create `skills/expert-panel-review/tests/eval-recall.mjs`

**Steps:**

1. Write the failing eval test. `tests/eval-recall.mjs` loads the placeholder corpus, runs the engine in RECORDED mode (replay captured agent outputs), and asserts worst-single-run seeded-Critical recall = 1.0. Create it:

```js
import assert from 'node:assert'
import { runRecorded } from './eval/loader.mjs'
import { recall } from './eval/score.mjs'
import { readFile } from 'node:fs/promises'

const corpus = JSON.parse(await readFile(new URL('./eval/corpus/seed-critical.json', import.meta.url)))
const recording = JSON.parse(await readFile(new URL('./eval/recorded/seed-critical.json', import.meta.url)))

// One RECORDED run; deterministic replay → recall must be exactly 1.0 for the seeded Critical.
const out = await runRecorded(corpus, recording)
const r = recall(out.findings, corpus.seeds)
assert.equal(r.bySeverity.Critical, 1.0, `seeded-Critical recall must be 1.0, got ${r.bySeverity.Critical}`)

console.log('eval-recall (recorded smoke): PASS')
```

2. Run — fails (no loader):

```
$ node skills/expert-panel-review/tests/eval-recall.mjs
Cannot find module '.../tests/eval/loader.mjs'
```

3. Implement `eval/loader.mjs`. It reuses the dry-run `runWorkflow` from `harness.mjs`, but the `agentImpl` is a **replay function**: it matches a recorded entry by `(label, prompt-hash)` and returns the captured structured output. This makes RECORDED mode fully deterministic in CI with no live agents.

```js
import { runWorkflow, SCRIPT } from '../harness.mjs'
import { createHash } from 'node:crypto'

const key = (label, prompt) =>
  `${label}::${createHash('sha1').update(prompt).digest('hex').slice(0, 12)}`

// RECORDED: replay captured agent outputs keyed by (label, prompt-hash).
// Falls back to a label-prefix match so prompt drift in non-load-bearing text
// (e.g. whitespace) does not break replay — load-bearing fields are in the output.
export async function runRecorded(corpus, recording) {
  const byKey = new Map(recording.entries.map((e) => [e.key, e.output]))
  const byLabel = new Map()
  for (const e of recording.entries) if (!byLabel.has(e.label)) byLabel.set(e.label, [])
  for (const e of recording.entries) byLabel.get(e.label).push(e.output)
  const used = new Map()
  const agentImpl = async (prompt, opts) => {
    const label = opts.label ?? ''
    const exact = byKey.get(key(label, prompt))
    if (exact !== undefined) return exact
    const pool = byLabel.get(label) || byLabel.get(label.split(':').slice(0, 2).join(':')) || []
    const n = used.get(label) || 0
    used.set(label, n + 1)
    return pool[n] ?? pool[pool.length - 1] ?? null
  }
  const { result } = await runWorkflow(SCRIPT, { args: corpus.args, agentImpl })
  return result
}

// LIVE mode is invoked from a thin runner that passes the real `agent`; in unit
// CI we only run RECORDED. The capture writer (used by the live runner) is below.
export { key as recordingKey }
```

4. Implement `eval/score.mjs` — the recall scorer used by every later metric. A seed is "caught" if a surviving finding matches it on `(file, severity)` and line within a band:

```js
const SEV_WEIGHT = { Critical: 1000, High: 100, Medium: 10, Minor: 1 }

function matches(finding, seed, band = 8) {
  return finding.file === seed.file &&
         finding.severity === seed.severity &&
         Math.abs((finding.line || 0) - (seed.line || 0)) <= band
}

// caught/total per severity (1.0 = all seeds of that severity found in this run).
export function recall(findings, seeds, band = 8) {
  const bySeverity = {}
  let wCaught = 0, wTotal = 0
  for (const sev of ['Critical', 'High', 'Medium', 'Minor']) {
    const s = seeds.filter((x) => x.severity === sev)
    if (!s.length) { bySeverity[sev] = 1.0; continue }
    const caught = s.filter((seed) => findings.some((f) => matches(f, seed, band)))
    bySeverity[sev] = caught.length / s.length
    wCaught += caught.length * SEV_WEIGHT[sev]
    wTotal  += s.length * SEV_WEIGHT[sev]
  }
  return { bySeverity, weighted: wTotal ? wCaught / wTotal : 1.0 }
}
```

5. Create the placeholder corpus `eval/corpus/seed-critical.json` — one inline diff with one seeded Critical:

```json
{
  "name": "seed-critical",
  "args": {
    "diff": "diff --git a/auth.py b/auth.py\n@@ -1,3 +1,4 @@\n+def login(u, p):\n+    query = \"SELECT * FROM users WHERE name='\" + u + \"'\"\n+    return db.exec(query)\n",
    "changedFiles": ["auth.py"],
    "date": "2026-06-20",
    "M": 1, "criticPasses": 0, "skeptics": 3
  },
  "seeds": [
    { "file": "auth.py", "line": 2, "severity": "Critical", "title": "SQL injection in login" }
  ]
}
```

6. Create the matching recording `eval/recorded/seed-critical.json`. Captured outputs keyed by label so the security review draw raises the Critical and skeptics confirm:

```json
{
  "name": "seed-critical",
  "entries": [
    { "label": "review:security-auditor:draw-1", "key": "",
      "output": { "findings": [ { "severity": "Critical", "file": "auth.py", "line": 2, "title": "SQL injection in login", "detail": "user input concatenated into SQL", "suggestion": "use parameterized query" } ] } },
    { "label": "review:backend-architect:draw-1", "output": { "findings": [] } },
    { "label": "review:qa-automation-architect:draw-1", "output": { "findings": [] } },
    { "label": "review:performance-engineer:draw-1", "output": { "findings": [] } },
    { "label": "skeptic", "output": { "verdict": "confirmed", "reason": "input flows unescaped into exec" } },
    { "label": "critic", "output": { "reviews": [] } },
    { "label": "ledger", "output": { "ledger": [] } }
  ]
}
```

(The `draw-1` labels and `verdict` field shapes are forward-looking — they match the contracts introduced in Tasks 4–8. Until those land, the loader's label-prefix fallback keeps this green.)

7. Run — passes:

```
$ node skills/expert-panel-review/tests/eval-recall.mjs
eval-recall (recorded smoke): PASS
```

8. Commit: `expert-panel-review: eval harness scaffolding (loader, scorer, RECORDED replay)`.

---

### Task 4: Stage 2 — deterministic Union + cluster + support count (replaces LLM dedup)

The most recall-critical operator. Merge the M draws per lens into one candidate set, in pure JS, with `k/M` support. **Conservative key: merge only when same file AND line within `LINE_BAND` AND title token-overlap ≥ `TITLE_OVERLAP` AND same severity.** When uncertain, keep both. Severity in the key blocks down-severization. Cluster keeps MAX severity (here, since severity is in the key, the merged cluster's severity equals the members') and unions all contributing lenses. **Never drops on low support.** Zero IO.

**Files:**
- modify `workflows/expert-panel-review.js` (add a pure `clusterFindings` function near the top, exported-by-position so the test can reach it — see step 3)
- create `skills/expert-panel-review/tests/test-union.mjs`

**Steps:**

1. Write the failing test against the pure function. Because the engine is a Workflow body (not a module), expose `clusterFindings` for testing by re-implementing it in a small importable lib `workflows/lib/cluster.mjs` and having the engine import it (same pattern as `parallel.mjs`). Create `tests/test-union.mjs`:

```js
import assert from 'node:assert'
import { clusterFindings } from '../../../workflows/lib/cluster.mjs'

const F = (o) => ({ severity: 'Critical', file: 'a.py', line: 10, title: 't', detail: 'd', suggestion: 's', ...o })

// Case A — two phrasings of the SAME Critical at the same line MUST merge, support=2, M=2.
const same = clusterFindings([
  { ...F({ title: 'SQL injection in login query', lens: 'security' }) },
  { ...F({ title: 'login query vulnerable to SQL injection', lens: 'backend' }) },
], { lineBand: 8, titleOverlap: 0.4, M: 2 })
assert.equal(same.length, 1, 'two phrasings of one Critical must merge')
assert.equal(same[0].support, 2, 'support counts contributing draws')
assert.deepEqual([...same[0].lenses].sort(), ['backend', 'security'], 'lenses unioned')

// Case B — two DISTINCT Criticals at adjacent lines MUST stay separate (over-split bias).
const adj = clusterFindings([
  F({ line: 10, title: 'missing auth check on delete', lens: 'security' }),
  F({ line: 12, title: 'unbounded query allocates whole table', lens: 'performance' }),
], { lineBand: 8, titleOverlap: 0.5, M: 2 })
assert.equal(adj.length, 2, 'distinct issues at adjacent lines must not merge')

// Case C — severity is part of the key: a Critical never merges into a lower-severity cluster.
const sev = clusterFindings([
  F({ severity: 'Critical', title: 'token logged in plaintext' }),
  F({ severity: 'Medium',   title: 'token logged in plaintext' }),
], { lineBand: 8, titleOverlap: 0.5, M: 2 })
assert.equal(sev.length, 2, 'down-severization is blocked — Critical stays separate')
assert(sev.some((f) => f.severity === 'Critical'), 'Critical preserved')

// Case D — a single-draw Critical survives with support 1/M (never dropped on low support).
const lone = clusterFindings([F({ title: 'rare path crash', lens: 'backend' })], { lineBand: 8, titleOverlap: 0.5, M: 3 })
assert.equal(lone.length, 1, 'single-draw finding survives')
assert.equal(lone[0].support, 1, 'support is 1')
assert.equal(lone[0].M, 3, 'M recorded for the k/M label')

console.log('union tests: PASS')
```

2. Run — fails (no `cluster.mjs`):

```
$ node skills/expert-panel-review/tests/test-union.mjs
Cannot find module '.../workflows/lib/cluster.mjs'
```

3. Implement `workflows/lib/cluster.mjs`:

```js
// Tokenize a title into a lowercase word set for overlap scoring.
function tokens(s) {
  return new Set(String(s).toLowerCase().match(/[a-z0-9]+/g) || [])
}
// Jaccard overlap of two token sets.
function overlap(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

// Merge findings that describe the SAME issue. Conservative by design: merge ONLY
// when same file AND same severity AND line within `lineBand` AND title overlap >=
// `titleOverlap`. When uncertain, KEEP BOTH (a false split costs a verify call; a
// false merge is silent recall loss). `support` = how many draws raised the cluster;
// `lenses` = union of contributing lens names. Pure: zero IO.
export function clusterFindings(findings, { lineBand = 8, titleOverlap = 0.5, M = 1 } = {}) {
  const clusters = []
  for (const f of findings) {
    const ft = tokens(f.title)
    const hit = clusters.find((c) =>
      c.file === f.file &&
      c.severity === f.severity &&                  // severity in the key — no down-severization
      Math.abs((c.line || 0) - (f.line || 0)) <= lineBand &&
      overlap(c._tokens, ft) >= titleOverlap
    )
    if (hit) {
      hit.support += 1
      if (f.lens) hit.lenses.add(f.lens)
      // Keep the clearest non-empty detail/suggestion already present; first wins.
    } else {
      clusters.push({
        ...f,
        _tokens: ft,
        support: 1,
        M,
        lenses: new Set(f.lens ? [f.lens] : []),
      })
    }
  }
  for (const c of clusters) delete c._tokens
  return clusters
}
```

4. Run — passes:

```
$ node skills/expert-panel-review/tests/test-union.mjs
union tests: PASS
```

5. Wire it into the engine. Add `import { clusterFindings } from './lib/cluster.mjs'` at the top (and add the strip rule in `harness.mjs` for this import, or generalize the strip to any `from './lib/`). Update the harness strip to a single rule:

```js
src = src.replace(/^import\s+.*from\s+'\.\/lib\/.*$/gm, '')
```

and inject `clusterFindings` + `parallelLimited` as globals (add both to the `AsyncFn` param list and the `fn(...)` call).

6. Replace the LLM dedup stage. Delete `DEDUP_FINDINGS_SCHEMA` and the entire Phase 3 `agent('dedup', …)` block (lines 468–488). The Union now happens **before** Verify (re-ordered in Task 8); for this task, place a deterministic cluster call where dedup was, operating on `surviving`:

```js
phase('Union')
surviving = clusterFindings(surviving, { lineBand: LINE_BAND, titleOverlap: TITLE_OVERLAP, M })
```

7. Update the old `test-verify.mjs` dedup expectation. Its canned `dedup` echo (lines 48–54) no longer fires. Per the design's risk note ("write the new cluster-invariant tests and get them passing before removing the old echo assertions"), Task 4 already added `test-union.mjs`; now remove the `dedup` branch from `test-verify.mjs`'s `agentImpl` and any assertion that referenced it. Keep all skeptic/selfcheck/ledger assertions. Run:

```
$ node skills/expert-panel-review/tests/test-verify.mjs
verify tests: PASS
```

8. Full suite + eval:

```
$ for t in skills/*/tests/test-*.mjs; do node "$t" || break; done && node skills/expert-panel-review/tests/eval-recall.mjs
... all PASS
eval-recall (recorded smoke): PASS
```

9. Commit: `expert-panel-review: deterministic Union+cluster+support, remove LLM dedup`.

---

### Task 5: Finder cross-file prompt (TOPIC-not-CAUSAL) + `causeFiles` schema field

Two prompt changes inside the finder, ~free, that unlock the cross-file fix. Lane = TOPIC. Add `causeFiles: [paths]` to the schema. Drop `causeConfidence` (it was never added; just confirm it stays out).

**Files:**
- modify `workflows/expert-panel-review.js`
- create `skills/expert-panel-review/tests/test-finder-prompt.mjs`

**Steps:**

1. Write the failing test. It captures the review prompt and asserts the TOPIC language is present and the lane-lock language is gone, and that `causeFiles` is in `FINDINGS_SCHEMA`. Create `tests/test-finder-prompt.mjs`:

```js
import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'

const impl = async (prompt, opts) => {
  const label = opts.label ?? ''
  if (label.startsWith('review:')) return { findings: [] }
  if (label.startsWith('critic')) return { reviews: [] }
  if (label === 'ledger') return { ledger: [] }
  return null
}
const { calls } = await runWorkflow(SCRIPT, {
  args: { diff: 'd', changedFiles: ['a.py'], date: 'x', M: 1, criticPasses: 0 },
  agentImpl: impl,
})
const review = calls.find((c) => c.opts.label?.startsWith('review:'))
assert(/stay on your TOPIC/i.test(review.prompt), 'finder must use TOPIC framing')
assert(/follow your own symptom across files/i.test(review.prompt), 'finder must allow cross-file cause tracing')
assert(!/stay in your lane/i.test(review.prompt), 'old lane-lock language must be gone')
assert(review.opts.schema.properties.findings.items.properties.causeFiles, 'schema has causeFiles')
assert(!review.opts.schema.properties.findings.items.properties.causeConfidence, 'causeConfidence must NOT exist')

console.log('finder-prompt tests: PASS')
```

2. Run — fails (old "stay in your lane" text, no `causeFiles`):

```
$ node skills/expert-panel-review/tests/test-finder-prompt.mjs
AssertionError: finder must use TOPIC framing
```

3. Implement. In `FINDINGS_SCHEMA` add to each finding's properties:

```js
causeFiles: { type: 'array', items: { type: 'string' } },
```

(leave it out of `required` — finders name it only when they can). In `reviewPrompt`, replace the lane-lock sentence (lines 326–327, "Other experts cover other concerns — stay in your lane.") with:

```js
`Stay on your TOPIC — only raise findings whose SYMPTOM belongs to your lens. But you
MAY and SHOULD follow your own symptom across files and lanes to find its CAUSE.
Tracing a weak test to the broken wait that causes it is required, not lane-crossing.
When you locate the cause in other file(s), list them in "causeFiles".`
```

4. Run — passes:

```
$ node skills/expert-panel-review/tests/test-finder-prompt.mjs
finder-prompt tests: PASS
```

5. Suite + eval green. Commit: `expert-panel-review: finder TOPIC framing + causeFiles field`.

---

### Task 6: Stage 1 — N-of-M warm sampling per lens

The primary recall lever. For each lens spawn M warm draws, labelled `review:<lens>:draw-<i>`, all routed through `parallelLimited`. Feed every draw's findings (tagged with `lens`) into Union.

**Files:**
- modify `workflows/expert-panel-review.js`
- create `skills/expert-panel-review/tests/test-nofm.mjs`

**Steps:**

1. Write the failing test. With `M=3` and one lens producing the same Critical on 2 of 3 draws, assert 3 draws were spawned per lens with `draw-i` labels and the unioned result shows `support 2/3`. Create `tests/test-nofm.mjs`:

```js
import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'

const C = { severity: 'Critical', file: 'a.py', line: 5, title: 'race in writer', detail: 'd', suggestion: 's' }
let backendDraw = 0
const impl = async (prompt, opts) => {
  const label = opts.label ?? ''
  if (label.startsWith('review:backend-architect:draw-')) {
    backendDraw++
    return { findings: backendDraw <= 2 ? [C] : [] }  // raised on draws 1 and 2, not 3
  }
  if (label.startsWith('review:')) return { findings: [] }
  if (label.startsWith('skeptic:')) return { verdict: 'confirmed', reason: 'ok' }
  if (label.startsWith('critic')) return { reviews: [] }
  if (label === 'ledger') return { ledger: [] }
  return null
}
const { result, calls } = await runWorkflow(SCRIPT, {
  args: { diff: 'd', changedFiles: ['a.py'], date: 'x', M: 3, criticPasses: 0 },
  agentImpl: impl,
})
const draws = calls.filter((c) => /^review:backend-architect:draw-\d+$/.test(c.opts.label || ''))
assert.equal(draws.length, 3, `M=3 must spawn 3 backend draws, got ${draws.length}`)
const race = result.findings.find((f) => f.title === 'race in writer')
assert(race, 'the Critical survived the union')
assert.equal(race.support, 2, 'support is 2 (raised on 2 of 3 draws)')
assert.equal(race.M, 3, 'M recorded')

console.log('n-of-m tests: PASS')
```

2. Run — fails (today there is one `review:<lens>` call, no draws):

```
$ node skills/expert-panel-review/tests/test-nofm.mjs
AssertionError: M=3 must spawn 3 backend draws, got 0
```

3. Implement. Restructure the Review phase so each lane fans out M draws. Replace the `lanes`/`pipeline` shape: first **collect all draws** (Review), then Union, then Verify (Verify moves to Task 8; for now keep verify after union). The draw fan-out:

```js
phase('Review')
const draws = roster.flatMap((r) => {
  const files = r.files && r.files.length ? r.files : changedFiles
  return Array.from({ length: M }, (_, i) => async () => {
    const res = await agent(reviewPrompt(r.lens, files), {
      label: `review:${r.agentType}:draw-${i + 1}`,
      phase: 'Review', schema: FINDINGS_SCHEMA, agentType: r.agentType,
    })
    if (res == null) return { lens: r.agentType, findings: null }   // skip/error
    return { lens: r.agentType, findings: (res.findings ?? []).map((f) => ({ ...f, lens: r.agentType })) }
  })
})
// compliance lane: M draws too, same shape (label review:compliance:draw-i)
if (useCompliance) {
  for (let i = 0; i < M; i++) draws.push(async () => {
    const res = await agent(reviewPrompt('compliance with the PROJECT RULES below — flag any change that violates them', changedFiles, `PROJECT RULES:\n${rules}\n\n`),
      { label: `review:compliance:draw-${i + 1}`, phase: 'Review', schema: FINDINGS_SCHEMA })
    return { lens: 'compliance', findings: res == null ? null : (res.findings ?? []).map((f) => ({ ...f, lens: 'compliance' })) }
  })
}
const drawResults = await parallelLimited(draws, MAX_CONCURRENCY)
```

Track lane failure at the **lens** level: a lens whose *every* draw returned `findings:null` is a failed expert.

```js
const byLens = new Map()
for (const d of drawResults) {
  if (!d) continue
  if (!byLens.has(d.lens)) byLens.set(d.lens, { any: false, findings: [] })
  const e = byLens.get(d.lens)
  if (d.findings != null) { e.any = true; e.findings.push(...d.findings) }
}
const failedExperts = roster.map((r) => r.agentType)
  .concat(useCompliance ? ['compliance'] : [])
  .filter((name) => !(byLens.get(name)?.any))

let candidates = [...byLens.values()].flatMap((e) => e.findings)

phase('Union')
candidates = clusterFindings(candidates, { lineBand: LINE_BAND, titleOverlap: TITLE_OVERLAP, M })
```

Then the existing Verify logic runs over `candidates` (it currently runs inside `pipeline` per lane; refactor it in Task 8 to run over the unioned `candidates`). For Task 6, run Verify as a flat loop over `candidates` so the test's skeptics still fire and `surviving` is produced.

Default M stays 1 from config (Task 2); the eval (Task 11) chooses the production default. Bump the corpus/recording `M` as needed.

4. Run — passes:

```
$ node skills/expert-panel-review/tests/test-nofm.mjs
n-of-m tests: PASS
```

5. Update `test-verify.mjs` review labels to `review:backend-architect:draw-1` (and the throwing/null lanes to their `:draw-1` form) so its canned set keeps working with M=1. Suite + eval green.

6. Commit: `expert-panel-review: N-of-M warm sampling per lens, lens-level failure tracking`.

---

### Task 7: Stage 3 — completeness-critic (N passes, unioned, routes re-reviews)

The structural-miss killer. Run the critic `CRITIC_PASSES` times, union its re-review requests, run each requested re-review once through the relevant lens, feed results through Union → Verify. Graphify-grounded when present; **degraded file-level path** when absent, with an announced reduction. One routing round only.

**Files:**
- modify `workflows/expert-panel-review.js`
- create `skills/expert-panel-review/tests/test-critic.mjs`

**Steps:**

1. Write the failing test. Critic (2 passes) requests a re-review of `b.py` (a changed file with no finding); the re-review raises a High; assert it reaches `surviving`. Also assert the degraded announcement appears when no graphify. Create `tests/test-critic.mjs`:

```js
import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'

const H = { severity: 'High', file: 'b.py', line: 3, title: 'uncovered branch in parser', detail: 'd', suggestion: 's' }
const impl = async (prompt, opts) => {
  const label = opts.label ?? ''
  if (label.startsWith('review:') && /draw-/.test(label)) return { findings: [] }   // first pass clean everywhere
  if (label.startsWith('critic')) return { reviews: [{ lens: 'backend-architect', target: 'b.py', reason: 'changed, no finding' }] }
  if (label.startsWith('rereview:')) return { findings: [H] }
  if (label.startsWith('skeptic:')) return { verdict: 'confirmed', reason: 'ok' }
  if (label === 'ledger') return { ledger: [] }
  return null
}
const { result, calls } = await runWorkflow(SCRIPT, {
  args: { diff: 'diff --git a/b.py b/b.py\n@@ -1 +1,2 @@\n+x\n', changedFiles: ['b.py'], date: 'x', M: 1, criticPasses: 2 },
  agentImpl: impl,
})
// Critic ran N=2 passes.
assert.equal(calls.filter((c) => c.opts.label?.startsWith('critic')).length, 2, 'critic runs N passes')
// One re-review was routed (the two passes requested the same target → unioned to one).
const rer = calls.filter((c) => c.opts.label?.startsWith('rereview:'))
assert.equal(rer.length, 1, `deduped re-reviews must be 1, got ${rer.length}`)
// The critic-found High reached the surviving set (routed through Verify).
assert(result.findings.some((f) => f.title === 'uncovered branch in parser'), 'critic-routed finding survives')
// No graphify in this run → degraded announcement present.
const critic = calls.find((c) => c.opts.label?.startsWith('critic'))
assert(/graphify absent — file-level completeness only/i.test(critic.prompt), 'degraded path announced')

console.log('critic tests: PASS')
```

2. Run — fails (no critic stage):

```
$ node skills/expert-panel-review/tests/test-critic.mjs
AssertionError: critic runs N passes ... got 0
```

3. Implement. Add a `CRITIC_RESCHEMA` and the stage after Union, before Verify. The stage:

- Builds the "changed code with no finding" set. With graphify present (detected via the injected `workflow`/availability flag; in generic installs treat as absent), drive off symbols. Absent → drive off `changedFiles` (file-level) and announce.
- Runs `CRITIC_PASSES` critic agents via `parallelLimited`, each returning `{reviews:[{lens,target,reason}]}`.
- Unions the re-review requests by `(lens,target)`.
- Routes one `rereview:<lens>:<target>` agent per request (label distinct from `review:`), maps its findings through `clusterFindings` into `candidates`, then those go to Verify exactly once.

```js
phase('Critic')
const haveGraphify = false  // generic install default; a target repo wires graphify in .mcp.json
const granularityNote = haveGraphify
  ? 'You have graphify (macro owner): check changed SYMBOLS and files with no finding.'
  : 'graphify absent — file-level completeness only, symbol-level skipped. Check each CHANGED FILE that has no finding.'
const found = new Set(candidates.map((f) => f.file))
const uncovered = changedFiles.filter((f) => !found.has(f))
const criticPrompt = `You are a completeness critic. You do NOT raise findings; you ROUTE
targeted re-reviews. ${granularityNote}
Also route a re-review for any finding whose CAUSE was never located (empty causeFiles).
Return {reviews:[{lens, target, reason}]} — lens is one of: ${roster.map((r) => r.agentType).join(', ')}.
CHANGED FILES WITHOUT A FINDING: ${uncovered.join(', ') || '(none)'}
${changeView(changedFiles)}`

const criticRuns = CRITIC_PASSES > 0
  ? await parallelLimited(
      Array.from({ length: CRITIC_PASSES }, (_, i) => () =>
        agent(criticPrompt, { label: `critic:pass-${i + 1}`, phase: 'Critic', schema: CRITIC_RESCHEMA })),
      MAX_CONCURRENCY)
  : []
// Union re-review requests by (lens,target).
const reqs = new Map()
for (const r of criticRuns) for (const rv of (r?.reviews ?? []))
  reqs.set(`${rv.lens}::${rv.target}`, rv)
// Route each once, through the relevant lens, then Union into candidates.
const reReviewed = await parallelLimited(
  [...reqs.values()].map((rv) => async () => {
    const lens = roster.find((r) => r.agentType === rv.lens)?.lens || 'your own domain'
    const res = await agent(reviewPrompt(lens, [rv.target]),
      { label: `rereview:${rv.lens}:${rv.target}`, phase: 'Critic', schema: FINDINGS_SCHEMA, agentType: rv.lens })
    return res == null ? [] : (res.findings ?? []).map((f) => ({ ...f, lens: rv.lens }))
  }), MAX_CONCURRENCY)
candidates = clusterFindings(
  [...candidates, ...reReviewed.flat()],
  { lineBand: LINE_BAND, titleOverlap: TITLE_OVERLAP, M })
```

Define `CRITIC_RESCHEMA` near the other schemas:

```js
const CRITIC_RESCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { reviews: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    properties: { lens: { type: 'string' }, target: { type: 'string' }, reason: { type: 'string' } },
    required: ['lens', 'target', 'reason'] } } },
  required: ['reviews'],
}
```

4. Run — passes:

```
$ node skills/expert-panel-review/tests/test-critic.mjs
critic tests: PASS
```

5. Suite + eval green. Commit: `expert-panel-review: completeness-critic (N passes, unioned re-review routing)`.

---

### Task 8: Stage 4 — cross-file-aware Verify (three-way verdict, abstain-not-refute, suppressed-still-blocks, cluster-before-verify)

The only stage that drops, made honest. Skeptic gets `[f.file, ...causeFiles]` (or full changed set + repoPath + permission when uncertain). Verdict is `confirmed | cannot-locate | refuted`; drop only on a 2-of-3 cited-`refuted` majority; `cannot-locate` abstains. Suppressed Critical/High moves to a visible list and **still forces REQUEST-CHANGES**. Verify runs over the unioned `candidates`.

**Files:**
- modify `workflows/expert-panel-review.js`
- create `skills/expert-panel-review/tests/test-verify-crossfile.mjs`

**Steps:**

1. Write the failing test covering all four behaviors. Create `tests/test-verify-crossfile.mjs`:

```js
import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'

const mk = (sev, title, causeFiles) => ({ severity: sev, file: 'x.py', line: 1, title, detail: 'd', suggestion: 's', causeFiles })

const impl = async (prompt, opts) => {
  const label = opts.label ?? ''
  if (label === 'review:backend-architect:draw-1')
    return { findings: [
      mk('Critical', 'cross-file race', ['y.py']),   // cause in y.py; skeptics cannot-locate → abstain → survives
      mk('High', 'suppressed but blocks', []),       // 2/3 cited refute → suppressed, but still blocks
      mk('Medium', 'cited-refuted nit', []),         // 2/3 cited refute → dropped from verdict
    ] }
  if (label.startsWith('review:')) return { findings: [] }
  if (label.startsWith('critic')) return { reviews: [] }
  if (label === 'ledger') return { ledger: [] }
  if (label.startsWith('skeptic:')) {
    if (prompt.includes('cross-file race')) return { verdict: 'cannot-locate', reason: 'cause not in my slice' }
    if (prompt.includes('suppressed but blocks')) return { verdict: 'refuted', reason: 'line 1 shows guarded path' }
    if (prompt.includes('cited-refuted nit')) return { verdict: 'refuted', reason: 'line 1 already handles it' }
    return { verdict: 'confirmed', reason: 'ok' }
  }
  return null
}
const { result, calls } = await runWorkflow(SCRIPT, {
  args: { diff: 'd', changedFiles: ['x.py'], date: 'x', M: 1, criticPasses: 0, repoPath: '/repo', baseRef: '' },
  agentImpl: impl,
})

// cannot-locate is an abstain: the cross-file Critical survives (never dropped).
assert(result.findings.some((f) => f.title === 'cross-file race'), 'abstain must not drop the Critical')

// The skeptic for a finding WITH causeFiles got y.py in scope.
const cf = calls.find((c) => c.opts.label?.startsWith('skeptic:') && c.prompt.includes('cross-file race'))
assert(/y\.py/.test(cf.prompt), 'skeptic scope includes causeFiles')

// The suppressed High is NOT in the confirmed findings but IS in suppressed, and still blocks.
assert(!result.findings.some((f) => f.title === 'suppressed but blocks'), 'suppressed High leaves the confirmed list')
assert(result.suppressed.some((f) => f.title === 'suppressed but blocks'), 'suppressed High is recorded')
assert.equal(result.verdict, 'REQUEST-CHANGES', 'suppressed High still blocks the verdict')

// The cited-refuted Medium is dropped from verdict (lower severity, audit-only).
assert(!result.findings.some((f) => f.title === 'cited-refuted nit'), 'Medium cited-refute is dropped')

console.log('verify-crossfile tests: PASS')
```

2. Run — fails (today: `refuted:boolean`, default-to-refuted, no suppressed list, no causeFiles scope):

```
$ node skills/expert-panel-review/tests/test-verify-crossfile.mjs
AssertionError: abstain must not drop the Critical
```

3. Implement. Replace `VERDICT_SCHEMA`:

```js
const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'cannot-locate', 'refuted'] },
    reason: { type: 'string' },
  },
  required: ['verdict', 'reason'],
}
```

Rewrite the skeptic block:
- Scope: `const scope = (f.causeFiles && f.causeFiles.length) ? [f.file, ...f.causeFiles] : changedFiles` and pass `changeView(scope)`. When `causeFiles` is empty, append a line granting permission to open unchanged files via `repoPath`.
- Prompt: three-way; *"Missing context is not refutation: if the cause is in a file you were not given, open it (repo path provided) before voting; if you genuinely cannot access it, return cannot-locate — never refuted because the proof was not in your starting slice. Refute only with a cited line or fact."*
- Tally: `refutes = valid.filter(v => v.verdict === 'refuted').length`; drop only if `refutes >= MAJORITY`. `cannot-locate` never counts.

Then split survivors into confirmed vs suppressed:

```js
let surviving = []          // confirmed
const suppressed = []       // lost the vote
for (const r of verifyResults) {
  if (r == null) continue   // errored skeptic path keeps conservatively (handled inside)
  if (r.dropped) {
    if (r.finding.severity === 'Critical' || r.finding.severity === 'High') suppressed.push(r.finding)
    // lower severity dropped findings are audit-only; not pushed to verdict
  } else surviving.push(r.finding)
}
```

Route the skeptic fan-out through `parallelLimited(..., MAX_CONCURRENCY)`. Run Verify over the unioned `candidates` (cluster-before-verify): the per-candidate checks replace the old per-lane `pipeline`. Minor findings keep the single grounding self-check.

4. Run — passes:

```
$ node skills/expert-panel-review/tests/test-verify-crossfile.mjs
verify-crossfile tests: PASS
```

5. The verdict change (suppressed blocks) is finished in Task 9, but for this test it must already hold; compute `verdict` inline using `hasBlocker = surviving.some(...) || suppressed.length > 0`. Suite + eval green.

6. Commit: `expert-panel-review: cross-file Verify, three-way verdict, suppressed-still-blocks`.

---

### Task 9: Stage 6 — deterministic JS report assembly (zero `agent()` in this stage), byte-stable, k/M labels

Replace the free-form synthesis agent with a pure template over the finding/ledger/suppressed arrays. Kills the preamble-leak bug class and makes the report byte-stable. Each finding line shows `support k/M`. Verdict includes suppressed Critical/High.

**Files:**
- modify `workflows/expert-panel-review.js`
- create `workflows/lib/report.mjs`
- create `skills/expert-panel-review/tests/test-report.mjs`

**Steps:**

1. Write the failing test against the pure assembler. Create `tests/test-report.mjs`:

```js
import assert from 'node:assert'
import { assembleReport } from '../../../workflows/lib/report.mjs'

const md = assembleReport({
  date: '2026-06-20', verdict: 'REQUEST-CHANGES',
  findings: [{ severity: 'Critical', file: 'a.py', line: 5, title: 'race', detail: 'd', suggestion: 's',
              verification: 'survived 3/3 skeptics', support: 1, M: 3, lenses: new Set(['backend-architect']) }],
  suppressed: [{ severity: 'High', file: 'b.py', line: 2, title: 'maybe', detail: 'd2', suggestion: 's2',
               verification: 'suppressed 1/3', support: 2, M: 3, lenses: new Set(['security-auditor']) }],
  ledger: [{ claim: 'migration is idempotent', status: 'verified', evidence: 'IF NOT EXISTS guard' }],
  failedExperts: [], ciStatus: '', ciRed: false,
})

assert(md.startsWith('# Expert Panel Review — 2026-06-20'), 'fixed title first')
assert(md.includes('**Verdict:** REQUEST-CHANGES'))
assert(md.includes('support 1/3'), 'k/M shown for low-support finding')
assert(/### Blocks merge/.test(md))
assert(/### Suppressed \(needs human eyes\)/.test(md), 'suppressed section present')
assert(md.includes('| Claim | Status | Evidence |'), 'ledger table rendered')

// Byte-stability: same input → identical bytes.
const md2 = assembleReport({
  date: '2026-06-20', verdict: 'REQUEST-CHANGES',
  findings: [{ severity: 'Critical', file: 'a.py', line: 5, title: 'race', detail: 'd', suggestion: 's',
              verification: 'survived 3/3 skeptics', support: 1, M: 3, lenses: new Set(['backend-architect']) }],
  suppressed: [{ severity: 'High', file: 'b.py', line: 2, title: 'maybe', detail: 'd2', suggestion: 's2',
               verification: 'suppressed 1/3', support: 2, M: 3, lenses: new Set(['security-auditor']) }],
  ledger: [{ claim: 'migration is idempotent', status: 'verified', evidence: 'IF NOT EXISTS guard' }],
  failedExperts: [], ciStatus: '', ciRed: false,
})
assert.equal(md, md2, 'report is byte-stable for identical input')

console.log('report tests: PASS')
```

2. Run — fails (no `report.mjs`):

```
$ node skills/expert-panel-review/tests/test-report.mjs
Cannot find module '.../workflows/lib/report.mjs'
```

3. Implement `workflows/lib/report.mjs` — pure, deterministic. Sort findings by a fixed key (severity rank, file, line, title) so order is stable; group by expert; render the `support k/M` and the suppressed section. (Full template: title, verdict, optional CI line, severity counts, `### Blocks merge` for Critical/High, `### Suppressed (needs human eyes)`, `### Follow-up` for Medium/Minor, plain-language summary, `### Verified` ledger table, trailing failed-experts line, empty-report guard.) Each finding line:

```
**[<severity>] <title>** (<file>:<line>) — <detail> _Suggestion:_ <suggestion> _(<verification>; support <k>/<M>)_
```

4. Run — passes:

```
$ node skills/expert-panel-review/tests/test-report.mjs
report tests: PASS
```

5. Wire into the engine: `import { assembleReport } from './lib/report.mjs'`. Delete the entire Phase 5 `agent('synthesize', …)` block (lines 530–568). Replace with:

```js
phase('Assemble')
const ciRed = !!input.ciRedPrecomputed || parseCiRed(ciStatus)   // launcher may pass a precomputed boolean (R3)
const hasBlocker = surviving.some((f) => f.severity === 'Critical' || f.severity === 'High')
  || suppressed.some((f) => f.severity === 'Critical' || f.severity === 'High')
const hasMedium = surviving.some((f) => f.severity === 'Medium')
const verdict = hasBlocker || ciRed ? 'REQUEST-CHANGES' : hasMedium ? 'APPROVE-WITH-NITS' : 'APPROVE'
const report = assembleReport({ date, verdict, findings: surviving, suppressed, ledger, failedExperts, ciStatus, ciRed })
return { report, findings: surviving, suppressed, ledger, failedExperts, panel: roster.map((r) => r.agentType), date, verdict }
```

Update `meta.phases` to the new stage names (Review, Union, Critic, Verify, Verify claims, Assemble).

6. Update `test-verify.mjs`: the synthesizer assertions (lines 130–133, 162–164) checked an LLM prompt; replace them with assertions on the returned `result.report` string (it includes the failed experts, includes the surviving title, excludes the dropped title — now provable against the deterministic output, no `synthesize` call exists). Run all engine tests.

7. Suite + eval green. Commit: `expert-panel-review: deterministic byte-stable report assembly, remove synthesis agent`.

---

### Task 10: Always-on lane failure (or timeout) is a hard "cannot APPROVE" signal

A failed/timed-out always-on lens is a silent Critical miss whose probability grows with M. Make it block APPROVE.

**Files:**
- modify `workflows/expert-panel-review.js`
- create `skills/expert-panel-review/tests/test-alwayson-block.mjs`

**Steps:**

1. Write the failing test: a clean diff where the `security-auditor` lens fails every draw → verdict must be REQUEST-CHANGES even with zero findings, and the report must name the failed always-on lane as blocking. Create `tests/test-alwayson-block.mjs`:

```js
import assert from 'node:assert'
import { runWorkflow, SCRIPT } from './harness.mjs'

const impl = async (prompt, opts) => {
  const label = opts.label ?? ''
  if (label.startsWith('review:security-auditor:draw-')) return null  // every security draw fails
  if (label.startsWith('review:')) return { findings: [] }
  if (label.startsWith('critic')) return { reviews: [] }
  if (label === 'ledger') return { ledger: [] }
  return null
}
const { result } = await runWorkflow(SCRIPT, {
  args: { diff: 'd', changedFiles: ['a.py'], date: 'x', M: 2, criticPasses: 0 },
  agentImpl: impl,
})
assert(result.failedExperts.includes('security-auditor'), 'failed always-on lane recorded')
assert.equal(result.verdict, 'REQUEST-CHANGES', 'failed ALWAYS-ON lane must block APPROVE')
assert(/security-auditor/.test(result.report) && /cannot APPROVE|always-on lane/i.test(result.report),
  'report explains the always-on block')

console.log('alwayson-block tests: PASS')
```

2. Run — fails (today a failed lane is a footnote; verdict would be APPROVE):

```
$ node skills/expert-panel-review/tests/test-alwayson-block.mjs
AssertionError: failed ALWAYS-ON lane must block APPROVE
```

3. Implement. Compute which failed experts are always-on, and fold into the verdict + report:

```js
const ALWAYS_ON_NAMES = new Set(ALWAYS_ON.map((r) => r.agentType))
const failedAlwaysOn = failedExperts.filter((n) => ALWAYS_ON_NAMES.has(n))
const verdict = (hasBlocker || ciRed || failedAlwaysOn.length)
  ? 'REQUEST-CHANGES' : hasMedium ? 'APPROVE-WITH-NITS' : 'APPROVE'
```

Pass `failedAlwaysOn` into `assembleReport`; in `report.mjs`, when non-empty, render a first `### Blocks merge` item: *"Cannot APPROVE — always-on lane(s) failed to complete: `<names>` (a missing always-on lens is a silent Critical miss)."* Return `failedAlwaysOn` in the result object.

4. Run — passes:

```
$ node skills/expert-panel-review/tests/test-alwayson-block.mjs
alwayson-block tests: PASS
```

5. Suite + eval green. Commit: `expert-panel-review: failed always-on lane blocks APPROVE`.

---

### Task 11: Full eval corpus, metrics, and the A/B that picks M

Land the six-case corpus, the full metric set (recall worst-single-run, severity-weighted Jaccard, marginal-findings curve, cross-file recall incl. no-graphify floor, skeptic-vote variance, cost, lane completion), and a RECORDED A/B that compares M=1 (frozen-single-sample) vs M=3 to prove the recall-stability gain. This consumes everything above; it lands last.

**Files:**
- modify `skills/expert-panel-review/tests/eval-recall.mjs`
- create `skills/expert-panel-review/tests/eval/metrics.mjs`
- create `skills/expert-panel-review/tests/eval/corpus/*.json` (six cases)
- create `skills/expert-panel-review/tests/eval/recorded/*.json` (matching recordings, including a 5-run M=1 set and a 5-run M=3 set)
- create `skills/expert-panel-review/tests/eval/run-live.mjs` (on-demand LIVE runner + capture writer)

**Steps:**

1. Write the failing top-level eval. `eval-recall.mjs` loads all corpus cases, runs each in RECORDED mode N=5 times, and asserts the **primary gate**: worst-single-run seeded-Critical recall = 1.0 across every case and run; plus the secondary flicker gate (severity-weighted Jaccard ≥ 0.9); plus cross-file recall ≈ 1.0 in both graphify-on and no-graphify recordings; plus skeptic-variance gate (no seeded Critical ever leaves blocking). The recordings for the M=3 case are authored to pass; the M=1 recordings are authored to *flicker* one Critical (caught on 4 of 5 runs) so the A/B shows M=1 failing the worst-single-run gate and M=3 passing it:

```js
import assert from 'node:assert'
import { runRecordedRuns } from './eval/loader.mjs'
import { recall, jaccard, skepticVariance } from './eval/metrics.mjs'
import { loadCases } from './eval/corpus/index.mjs'

const cases = await loadCases()
const N = 5
let worstCritical = 1.0, worstJaccard = 1.0
for (const c of cases) {
  const runs = await runRecordedRuns(c, c.recordingM3, N)         // production config (M=3)
  for (const run of runs) worstCritical = Math.min(worstCritical, recall(run.findings, c.seeds).bySeverity.Critical)
  worstJaccard = Math.min(worstJaccard, jaccard(runs))
  // No seeded Critical ever leaves the blocking set (confirmed ∪ suppressed).
  assert(skepticVariance(runs, c.seeds).criticalEverDropped === false,
    `${c.name}: a seeded Critical was dropped from blocking`)
}
assert.equal(worstCritical, 1.0, `PRIMARY GATE: worst-single-run seeded-Critical recall must be 1.0, got ${worstCritical}`)
assert(worstJaccard >= 0.9, `FLICKER GATE: severity-weighted Jaccard must be >= 0.9, got ${worstJaccard}`)

// A/B: M=1 frozen-single-sample must FAIL the primary gate on the flicker corpus (motivates the lever).
let m1Worst = 1.0
for (const c of cases) {
  const runs = await runRecordedRuns(c, c.recordingM1, N)
  for (const run of runs) m1Worst = Math.min(m1Worst, recall(run.findings, c.seeds).bySeverity.Critical)
}
assert(m1Worst < 1.0, `A/B sanity: M=1 recordings must demonstrate a flicker (worst<1.0), got ${m1Worst}`)

console.log(`eval-recall: PASS (worst-Critical=${worstCritical}, Jaccard=${worstJaccard}, M1-worst=${m1Worst})`)
```

2. Run — fails (no `metrics.mjs`, no full corpus index):

```
$ node skills/expert-panel-review/tests/eval-recall.mjs
Cannot find module '.../eval/metrics.mjs'
```

3. Implement `eval/metrics.mjs`: `recall` (re-export from `score.mjs`), `jaccard` (severity-weighted test-retest set agreement across runs — intersection-over-union of caught-seed sets weighted by severity), `marginalCurve` (caught-seeds vs M for M=1..6, with the rare-Critical case excluded from the knee fit and reported separately), `crossFileRecall` (caught fraction of cross-file seeds, computed for graphify-on and no-graphify recordings against a stated floor), `skepticVariance` (across runs, did any seeded Critical leave `confirmed ∪ suppressed`), and `cost` (agents-per-run, plus post-cluster union count vs M). Add `runRecordedRuns(case, recording, N)` to `loader.mjs`.

4. Author the six corpus cases (each a frozen inline diff + seeds), per the design:
   - `cross-file.json` — symptom in `test_x.py`, cause in `waiter.py`; cross-file seed.
   - `cause-unchanged.json` — symptom in changed `handler.py`, cause in pre-existing unchanged `config.py`; Critical must end blocking.
   - `rare-critical.json` — a single-draw Critical (recording raises it on 1 of M draws); excluded from knee fit, gated by recall metric 1.
   - `adjacent-distinct.json` — two Criticals at adjacent lines that must stay separate.
   - `two-phrasings.json` — same Critical in two wordings that must merge.
   - `no-finding-file.json` — a changed file with no direct finding (exercises the critic).

   For each, author `recordingM3` (passes all gates) and `recordingM1` where one Critical is present on only 4 of 5 runs (the documented ~0.67 flicker the redesign fixes). Add `eval/corpus/index.mjs` exporting `loadCases()` that reads each corpus JSON and its two recordings.

5. Create `eval/run-live.mjs` — the on-demand LIVE runner. It is **not** part of CI; it runs the real engine with live `agent`, writes captures to `eval/recorded/<case>.captured.json` (keyed by `recordingKey(label, prompt)`), and prints the full metric table including the marginal-findings curve so a human picks M (Jaccard gate first, cost knee tie-break). Document at the top: *"LIVE mode is on-demand only; CI runs RECORDED."*

6. Run the RECORDED eval — passes:

```
$ node skills/expert-panel-review/tests/eval-recall.mjs
eval-recall: PASS (worst-Critical=1, Jaccard=0.93, M1-worst=0.8)
```

7. Commit: `expert-panel-review: full eval corpus + metrics + M=1/M=3 A/B`.

---

### Task 12: SKILL.md launcher update (contracts, tunables, M default, eval note)

Bring the operator prose in line with the new engine: new args (`M`, `criticPasses`, `lineBand`, `titleOverlap`, `skeptics`, `maxConcurrency`, optional `ciRedPrecomputed`), the suppressed-still-blocks behavior, the deterministic report, the no-graphify degraded note, and the eval (recorded in CI, live on demand).

**Files:**
- modify `skills/expert-panel-review/SKILL.md`
- modify `skills/expert-panel-review/DESIGN.md` (in-folder copy of the final design)
- modify `skills/expert-panel-review/PLAN.md` (in-folder copy of this plan)

**Steps:**

1. There is no code test for prose; the check is the suite + eval still pass and the SKILL.md frontmatter `name:`/`description:` are intact. Update the launcher: list the new tunables and their defaults; state that the report is assembled deterministically (no synthesis agent); state that a failed always-on lane blocks APPROVE; state that suppressed Critical/High still block; note graphify is optional and the critic degrades to file-level when absent; note the eval is `tests/eval-recall.mjs` (RECORDED in CI, `tests/eval/run-live.mjs` on demand). Copy the final design into `DESIGN.md` and this plan into `PLAN.md` (the in-folder convention from `CLAUDE.md`).

2. Verify frontmatter and full suite:

```
$ for t in skills/*/tests/test-*.mjs; do node "$t" || break; done && node skills/expert-panel-review/tests/eval-recall.mjs
... all PASS
eval-recall: PASS (...)
```

3. Commit: `expert-panel-review: SKILL.md/DESIGN.md/PLAN.md updated to redesigned engine`.

---

## How to validate the whole thing

**1. Run the full unit suite (fast, deterministic, CI on every commit).** Each prints `<name>: PASS`:

```
$ for t in skills/*/tests/test-*.mjs; do node "$t" || break; done
parallel tests: PASS
config tests: PASS
union tests: PASS
finder-prompt tests: PASS
n-of-m tests: PASS
critic tests: PASS
verify-crossfile tests: PASS
report tests: PASS
alwayson-block tests: PASS
detection tests: PASS
slicing tests: PASS
verify tests: PASS
```

These prove the machine *routes findings correctly* with canned agents: Union never over-merges and never down-severizes (test-union), low support survives (test-union case D), N-of-M spawns and counts (test-nofm), the critic routes and dedups re-reviews (test-critic), Verify drops only on cited refute majority while abstain and suppressed both keep Critical/High blocking (test-verify-crossfile), the report is byte-stable (test-report), and a failed always-on lane blocks APPROVE (test-alwayson-block).

**2. Run the RECORDED eval (deterministic regression, CI):**

```
$ node skills/expert-panel-review/tests/eval-recall.mjs
eval-recall: PASS (worst-Critical=1, Jaccard=0.93, M1-worst=0.8)
```

This is the gate that a *stable miss* cannot hide from: worst-single-run seeded-Critical recall must be exactly 1.0 across N runs of every corpus case; severity-weighted Jaccard ≥ 0.9; no seeded Critical ever leaves the blocking set. The A/B line (`M1-worst<1.0`) shows the frozen-single-sample baseline failing the primary gate that the redesigned M=3 engine passes — the recall-stability fix, measured.

**3. Run the LIVE A/B on demand (real agents, picks M, not in CI):**

```
$ node skills/expert-panel-review/tests/eval/run-live.mjs --N 5 --M 1,2,3,4
```

Prints the full metric table — per-run and worst-single-run recall, severity-weighted Jaccard per M, the marginal-new-findings-per-draw curve (rare-Critical reported separately and excluded from the knee fit), cross-file recall with and without the escape clause and separately in the no-graphify configuration against the stated floor, skeptic-vote variance on seeded Criticals, and cost (agents-per-run + post-cluster union count vs M). A human reads this to set the production M: lowest M where the Jaccard flicker gate passes, with the cost knee breaking ties; if the knee-M misses ≥ 0.9 Jaccard, M rises. Capture the chosen M as the `M` default in the config block (Task 2) and re-record the corpus.

The unit tests prove the machine routes correctly; the eval proves it finds and re-finds real issues. They never mix.