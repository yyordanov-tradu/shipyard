# Code Gate Redesign — Change-Unit Coverage Map (Implementation Plan)

**Goal:** Replace the lens+skeptic code gate with the change-unit design in
`docs/specs/2026-06-22-code-gate-change-unit-design.md`: a deterministic unit coverage map,
expert-matched per-unit reviewers, a tool-derived cross-cutting tier, classify-by-evidence
verification (never silently drops), and deterministic assembly.

**Stability stance (decided):** recall stability is pursued **by construction**, not by a live eval.
The same diff yields the **same units → same reviewers** (Stage 0 is pure), and union/verdict/report
are pure JS (byte-identical every run). The only residual run-to-run variance is each agent's
"noticing" on a small unit + the cross-cutting tier — accepted, **not** empirically measured in v1.
There is **no eval harness and no live A/B** (can be added later if regression protection is wanted).

**Architecture:** `workflows/expert-panel-review.js` becomes a deterministic state machine over five
stages; pure helpers live in `workflows/lib/*.mjs` (canonical, unit-tested) and are inlined into the
engine byte-identically (the engine runs as an AsyncFunction body and cannot `import` at runtime).
Agents are spawned only for Stages 1, 2, 4.

**Tech stack:** plain JS ESM, Node ≥18, zero deps. Unit tests = standalone `.mjs` with
`node:assert/strict` via the existing dry-run `harness.mjs` (stubs `agent()`; no real agents). Each
test prints `<name>: PASS`.

**Task order & why:** foundations and the deterministic, unit-testable pieces first (Tasks 1–4); then
the agent stages (5–7); deterministic assembly (8); opportunistic reproduction (9); launcher + docs
(10). Each task is independently reviewable and ends green.

**Global constraints:** one config block parsed after args; pure helpers in `lib/` mirrored inline;
stable shapes for `Unit`, `Finding`, `Candidate`, `verdictOf`; never silently drop a finding; the new
contract breaks `test-verify.mjs`/`test-slicing.mjs` (rewritten in Tasks 7–8, not left broken).

---

### Task 1: Lift `parallelLimited` into a shared lib

**Files:** Create `workflows/lib/parallel.mjs`; create `workflows/lib/tests/test-parallel.mjs`; modify `workflows/expert-panel-review.js`.
- Test first: `parallelLimited(thunks, 2)` never exceeds 2 in flight, returns results in order; a throwing thunk resolves to `null`.
- Implement `parallelLimited(thunks, limit, staggerMs=0)` (lift the proven sibling-workflow version). Inline a byte-identical copy in the engine; route the engine's fan-out through it.
- Commit: `code gate: shared parallelLimited`.

### Task 2: One config block parsed after args

**Files:** modify `workflows/expert-panel-review.js`; modify `skills/expert-panel-review/tests/test-detection.mjs` (string-args case).
- Test first: pass args as a JSON **string** with an override; assert it is honored (regression guard for config-read-before-args).
- Implement: parse `args` once at top (try/catch); read every tunable from one config object (`granularity` default per-file, `k` default 1, `concurrency`, `staggerMs`, union `lineBand`/`titleThreshold`, `criticalRefuters=2`, failure-blocking xcut set).
- Commit: `code gate: single config block after args`.

### Task 3: `partitionUnits` + `expertForUnit` — the deterministic coverage map

**Files:** Create `workflows/lib/units.mjs`; create `workflows/lib/tests/test-units.mjs`.
- Test first: a fixed multi-file diff → stable, ordered `[{id, path, kind, hunks, deletionOnly}]`; the SAME diff twice → deep-equal (determinism — the core stability guarantee); `.tsx`→`typescript-pro`/frontend, `.sql`/`migrations/`→`database-optimizer`, `.py`→`python-pro`, unknown→`code-reviewer`; deletion-only file → `kind:'removed-safety'`.
- Implement `partitionUnits(changedFiles, fileDiffs)` (default per-file) + `expertForUnit(unit)`. Pure, no IO.
- Commit: `code gate: deterministic unit partition + expert match`.

### Task 4: `unionFindings` — cluster + support (deterministic, replaces LLM dedup)

**Files:** Create `workflows/lib/union.mjs`; create `workflows/lib/tests/test-union.mjs`.
- Test first (cluster invariants): same file/near line/overlapping title/same severity → merge with `support:2`; **adjacent distinct** (different title) → stay separate; **two phrasings** of one issue → merge; Critical + Medium at the same line → **never merge** (severity in key); a `support:1` finding is **kept**; cluster carries **MAX severity** + union of contributors.
- Implement `unionFindings(findings, {lineBand, titleThreshold})` — pure JS, over-split bias, no IO.
- Commit: `code gate: deterministic union + support count`.

### Task 5: Stage 1 — per-unit expert-matched review

**Files:** modify `workflows/expert-panel-review.js`; create `skills/expert-panel-review/tests/test-units-review.mjs`.
- Test first (dry-run harness): for a 3-file diff assert exactly one `review:unit:<path>` agent per unit (×k), each spawned with the **matched agentType**, each prompt scoped to its unit (contains its file, not others); a deletion-only unit gets a `removed-safety` reviewer; findings carry `causeFiles`.
- Implement Stage 1: build units (Task 3), fan out via `parallelLimited`, full-spectrum rubric + symptom→cause + injection guard, `k` replicas (default 1).
- Commit: `code gate: Stage 1 per-unit expert-matched review`.

### Task 6: Stage 2 — cross-cutting tier + tool-derived edges + failure signal

**Files:** modify `workflows/expert-panel-review.js`; create `skills/expert-panel-review/tests/test-crosscutting.mjs`.
- Test first: assert the cross-cutting reviewers run (`review:xcut:security`, `:integration`, `:architecture`, `:performance`, `+compliance` when rules present); each prompt carries the full changed-file list + the edge block; with graphify "absent" (stubbed) the prompt announces file-level edges; a failed/timed-out **failure-blocking** reviewer (security or integration) sets `blockedByFailure=true`, while a failed architecture/performance reviewer is a recorded warning (no auto-block).
- Implement Stage 2: edge derivation (graphify macro + Serena micro, never reconciled; file-level fallback), the fixed roster, degrade-announce, the failure flag.
- Commit: `code gate: Stage 2 cross-cutting tier + tool-derived edges`.

### Task 7: Stage 4 — verify by evidence (cross-file, cited-drop, abstain-blocks)

**Files:** modify `workflows/expert-panel-review.js`; rewrite `skills/expert-panel-review/tests/test-verify.mjs`.
- Test first: a verifier classifies `confirmed|reproduced|plausible|refuted`; a **cross-file** finding's verifier prompt contains `[file, ...causeFiles]` (the lesson-B regression test); a Critical needs **two** cited `refuted` to drop (one cited refute keeps it); a `plausible` Critical/High **still blocks**; a `refuted`-without-citation is treated as plausible (kept).
- Implement Stage 4 after union: per-candidate verifier (≤2 for Critical/High), evidence classes, drop only on cited refute, abstain-blocks. Remove the old `refuted`-vote path.
- Commit: `code gate: Stage 4 classify-by-evidence verify`.

### Task 8: Stage 5 — deterministic verdict + report assembly (zero agent)

**Files:** Create `workflows/lib/assemble.mjs`; create `workflows/lib/tests/test-assemble.mjs`; modify `workflows/expert-panel-review.js`; update `skills/expert-panel-review/tests/test-slicing.mjs` for the new shapes.
- Test first: `verdictOf(findings, {ciRed, blockedByFailure})` → REQUEST-CHANGES on any blocking Critical/High OR ciRed OR blockedByFailure; APPROVE-WITH-NITS on Medium; else APPROVE. `assembleReport(...)` is **byte-identical** for the same inputs (no LLM), shows evidence tier + support k + reproduction command + the override note; empty-report guard.
- Implement Stage 5 as pure JS (lib + inline). No `agent()` in this stage.
- Commit: `code gate: Stage 5 deterministic verdict + report`.

### Task 9: Reproduction subsystem (opportunistic)

**Files:** Create `workflows/lib/reproduce.mjs`; create `workflows/lib/tests/test-reproduce.mjs`; wire into Stage 4.
- Test first: given a discovered test command, the verify prompt offers the reproduce path and marks `reproduced` only on red-on-head/green-on-base; with **no** test command the path is skipped and announced (cap at confirmed) — never blocks on its absence.
- Implement: discover the project test command (CLAUDE.md/package.json/pyproject) in `lib/`; expose a "write scratch test + run" instruction to the verifier (the run is the agent's Bash).
- Commit: `code gate: opportunistic reproduction`.

### Task 10: Launcher rewrite + docs

**Files:** rewrite `skills/expert-panel-review/SKILL.md`; touch `docs/flow.md`, `docs/tooling.md`, `README.md`.
- Update the launcher to the new contract (repo mode + `baseRef`, the new args/tunables, what the report contains, the override note); drop stale inline/lens prose.
- Docs: note the change-unit gate in flow.md/README; confirm tooling.md roles (graphify edges, Serena micro, reproduction) stay consistent.
- Commit: `code gate: launcher + docs for change-unit gate`.

---

## Validation (end to end)

1. Full unit suite green: `for t in workflows/lib/tests/test-*.mjs skills/*/tests/test-*.mjs; do node "$t" || break; done`.
2. The deterministic stages prove stability-by-construction: `partitionUnits` returns deep-equal units for the same diff; `assembleReport` is byte-identical for the same findings (asserted in unit tests).
3. A real review run in repo mode on this repo's own branch; eyeball the report for sense. (No eval harness / no live A/B by decision — stability is structural + unit-tested, not empirically measured in v1.)
