# test-driven-implementation — design spec

**Stage:** `implement` — the fourth shipyard stage. Turns a READY plan into committed code,
task by task, with TDD, then hands off to the code gate.

**Status:** design approved 2026-06-18; next step is the implementation plan.

---

## Goal

Take an implementation plan that has passed the plan gate and build it — one task at a time,
test-first — landing small, verified commits on a feature branch that is ready for the code
gate (`expert-panel-review`). Quality comes from a tight per-task feedback loop (locate →
ground → edit → verify), not from a big upfront prompt.

## Non-goals (explicit, to prevent scope creep)

- **No deep code review.** Spotting subtle bugs, security, and design smells is the *code
  gate's* job. implement does a light sanity check only (see Step 4).
- **No design re-decisions.** If the plan is wrong or a task can't be built as written,
  implement escalates to the human — it does not silently redesign.
- **No merge to main, no PR creation, no deploy.** implement stops at "feature branch is
  green and ready." Opening the PR / merging is a later step.
- **No new plan-format fields.** implement works with the plan format
  `expert-advised-planning` already produces; it *infers* task independence rather than
  requiring the plan to declare streams.

## Entry contract

Invocation: `/test-driven-implementation [plan-path] [--force] [--max-parallel N]`.

1. Resolve the plan: the given path, else the newest file in `docs/plans/`. If none, STOP.
2. **Gate enforcement.** Look for a `plan-readiness-review` verdict of **READY** tied to this
   plan (the gate saves a report under `docs/reviews/` whose verdict line is parseable, keyed
   by the plan's slug). 
   - READY → proceed.
   - Not READY, or no review found → **STOP** and tell the user to run the plan gate first —
     **unless** `--force` is passed (honest escape hatch for tiny changes or when the gate
     tool is unavailable). `--force` is recorded in the run summary.
   - Note: `docs/reviews/` is gitignored/local, so this is a local check; a teammate without
     the report re-runs the gate (or uses `--force`).
3. Announce: "Running test-driven implementation."

## Architecture

**A SKILL.md launcher with no `workflows/*.js` engine.** This is a deliberate divergence from
the other three skills. Their engines fan out *advisory* agents that return structured data
for code to aggregate deterministically. implement fans out *builder* agents that edit files
and iterate against tests — the determinism lives in the **verify gate** (the tests), not in
JS orchestration, and the loop is interactive (subagents, worktrees), which the Workflow
engine handles poorly. We optimize for fit over symmetry; the engine-vs-launcher split is an
implementation detail, not a principle.

The launcher (the "lead") does: gate check, stream analysis, dispatching per-task subagents,
the light between-task review, integration, escalation, and the final handoff message.

## Tooling

implement follows **[docs/tooling.md](../tooling.md)** — the authoritative tool-ownership
bible. implement is the one skill that uses *both* understanding tools, **split by agent role**
so they never collide:

- **Lead → graphify (macro):** stream analysis — which task groups are independent and where
  work happens (Step 1). This is an architecture question, so graphify owns it.
- **Subagents → Serena (micro):** the per-task loop — exact definitions, all callers, types,
  diagnostics, and which tests a change affects.
- **context7** (subagents) grounds unfamiliar / low-use third-party APIs before they're called.
- **Claude Code** native `Edit`/`Write` (subagents) makes every edit (the single editor).
- **ripgrep** is the fallback when no language server / graph exists.
- The bible's rule holds: one owner per question, never two understanding tools for the same
  question. A subagent is given Serena but **not** graphify — it receives the lead's macro
  orientation pre-digested as text — so "one owner per question" is enforced by *access*, not
  just discipline. Absent tools degrade to ripgrep and are announced, never silently skipped.

## Execution flow

### Step 1 — Stream analysis (always first)

The lead parses the plan into tasks (heading, **Files** list, any explicit "depends on Task
N" notes) and partitions them into **streams**:

- Build a dependency/conflict relation: two tasks belong to the same stream if their Files
  sets intersect, OR **graphify** (queried by the lead, refreshed if stale) shows a dependency
  path between the areas they touch, OR an explicit cross-reference links them, OR one consumes
  an artifact the other creates. (Partitioning is a macro/architecture question, so graphify
  owns the dependency signal here — per the bible; Serena's micro view is used inside the
  per-task loop, not for stream analysis.)
- A **stream** is a connected component of that relation — internally ordered, independent of
  other streams.
- **High-conviction gate:** two streams may run in parallel only when they are *clearly*
  disjoint — no shared files, no dependency path, no explicit cross-reference. Any doubt →
  merge them / keep sequential. If graphify is absent (fallback mode), the macro dependency
  signal is weaker, so bias harder toward sequential.

Output: an execution schedule — an ordered list of streams, with independent streams marked
parallelizable. The common case (tightly-coupled plans) is a single stream → fully
sequential. The lead prints the schedule (which tasks run in parallel vs sequence) before
building.

### Step 2 — The per-task loop (one fresh subagent per task)

Each task is built by a fresh subagent, for focused context. The loop:

1. **Locate** the code to change — Serena (symbols/refs) → ripgrep fallback.
2. **Ground** unfamiliar APIs — context7, if the task calls into an unfamiliar library.
3. **Edit, test-first (TDD)** — write the failing test from the task's steps (red),
   implement until it passes (green), refactor. Edits via Claude Code.
4. **Verify, cheap → expensive** — typecheck → lint → run the task's tests. Widen safely
   using Serena call-hierarchy to find impacted tests; fall back to the full suite. Run
   whatever of typecheck/lint/tests the project actually has, in that order.
5. **Fix until green**, then return to the lead: branch/worktree ref + status.

### Step 2b — Subagent contract (what each subagent gets)

Each task-subagent gets a **scoped slice**, not the whole plan — this is the reason
fresh-subagent-per-task exists (focused context, no drift):

- **Its own task block** in full (goal, Files, steps, embedded tests).
- **The plan's shared header** (goal, architecture, shared object shapes, conventions /
  tech-stack), which tasks reference.
- **A text slice of the lead's macro orientation** (where this change sits) — *not* the
  graphify tool.
- It does **not** get other tasks' descriptions. It sees what earlier tasks produced through
  the **repo itself** (committed code in its branch/worktree), never their task text.

Tool allowlist — deliberately scoped so it enforces the bible by *access*:

| Subagent has | Subagent does NOT have | Why |
|---|---|---|
| **Serena** retrieval (symbols, refs, types, diagnostics, call-hierarchy) | Serena's edit tools | Claude Code is the one editor |
| **Claude Code** `Edit`/`Write` | — | the single editor |
| **Bash** (typecheck / lint / tests; git in its worktree) | — | runs the verify gate |
| **ripgrep**, **context7** | **graphify** (the tool) | macro is the lead's job; the subagent gets the map slice as text |

Because the subagent only has Serena for code intelligence (never graphify), it *cannot*
call two understanding tools for the same question.

Division of labor:
- **Lead:** graphify (stream analysis), git (branch / worktree / integrate), reads the plan,
  dispatches subagents, runs the full suite at integration. Does not edit code.
- **Subagent:** the scoped slice + the micro toolset above; works in its worktree (or the
  feature branch for sequential); returns "done + branch" or "failed + reason."

### Step 3 — Parallel mechanics

- Parallel streams run as **concurrent, worktree-isolated subagents** (the Agent tool's
  native `isolation: "worktree"`). Each stream runs its own tasks sequentially via the loop
  above, inside its worktree.
- **Cap:** `maxParallel`, default **3**, overridable via `--max-parallel` / per-project
  config. Excess streams queue and start as slots free.
- **No coordination layer.** Streams are independent by construction, so there is no Native
  Teams, no JSONL findings file, and no inter-agent messaging. **Git is the persistence and
  handoff:** each stream's output is committed code on its worktree branch; the only "message"
  is the subagent's return value (done + branch, or failed + reason).

### Step 4 — Review between tasks (light)

Before committing a task, the lead verifies the gate passed (green tests, clean diagnostics)
and sanity-checks the diff against the task's stated intent. A diff that is plainly off-intent
is treated as a failure (retry, then escalate). Deliberately light — the deep multi-expert
review is the code gate's job; implement must not duplicate it.

### Step 5 — Failure and conflict handling (escalate, never guess)

- **Task can't go green** after the self-correction budget (default **2 retries**, then
  escalate) → STOP, present the task, the failing output, and what was tried; ask the user how
  to proceed (fix manually / skip / abort). Reuses the plan stage's human-gate spirit.
- **Integration/merge conflict** when folding a stream into the feature branch → STOP; the
  human resolves it (agent-coordination rule: agents never auto-resolve conflicts). Conflicts
  should be rare given the high-conviction disjointness gate; treat one as a signal the gate
  mis-classified.

### Step 6 — Integration and handoff

- The lead integrates streams into the **feature branch sequentially** — merge one, run the
  full suite, then the next. Sequential work is already on the branch.
- When the last task is integrated and the full suite is green, **instruct, don't auto-run**:
  print the feature branch, the tasks completed (and any skipped/escalated), the suite status,
  any tools that fell back, and `--force` if used. End with: "Next: run `expert-panel-review`
  on this branch." The user decides when to spend the code gate.

## Git model

- A **feature branch** is the integration target; the lead creates/uses it.
- **Commit per task** (`Task N: <description>`) — small, reviewable, bisectable.
- **Sequential** tasks commit directly onto the branch.
- **Parallel** streams commit inside their own worktrees, then integrate back to the branch.

## Configuration

Per-project / per-invocation, no shipyard-bundled defaults beyond the constants below:

- `maxParallel` (default 3) — cap on concurrent streams.
- retry budget (default 2) — self-correction attempts before escalation.
- Verify commands (typecheck / lint / test) — discovered from the target repo
  (`CLAUDE.md`, `package.json`, `pyproject.toml`, …).

## Artifacts and layout

```
skills/test-driven-implementation/
  SKILL.md      the launcher (orchestration prose)
  lib/          deterministic helpers (.mjs): plan parsing, stream partition,
                verdict lookup, verify-gate sequencing — each importable AND
                runnable as a CLI (the launcher calls them via `node`)
  tests/        .mjs unit tests for lib/
  DESIGN.md     in-folder copy of this spec
  PLAN.md       the implementation plan
```

The launcher keeps the model-driven work (querying graphify, dispatching subagents, editing,
integrating). The deterministic decisions — parsing the plan, partitioning streams, reading the
gate verdict, sequencing the verify gate — live in `lib/` as pure functions, so they are exact
and unit-tested rather than left to model reasoning. "No `workflows/*.js` engine" refers to the
Workflow-tool fan-out engine the other three skills use; these plain helpers are not that.

## Testing

Unit tests (`.mjs`, `node:assert`, mirroring the other skills' style) cover the **pure logic**:

- Stream analysis: parsed tasks → correct stream partition and parallelizable/sequential
  classification (incl. the high-conviction and graphify-absent cases).
- Gate-verdict parsing: READY / not-READY / missing → proceed / stop / `--force`.
- Verify-gate sequencing: typecheck → lint → tests ordering and skip-reporting.

The agent-driven parts (dispatching subagents, editing, the TDD loop itself) are not unit-
tested the same way — coverage focuses on the deterministic helpers the launcher relies on.

## Dependencies

- **git** — required (branch, commit, worktree, integrate).
- **Serena** (MCP) — recommended; primary code-intelligence in this stage. Falls back to
  ripgrep when absent.
- **graphify** — recommended; the lead's macro tool for stream analysis. Falls back to
  grep/smart-explore.
- **context7** (MCP) — recommended; API grounding.
- **project verify commands** — required for the gate to be meaningful; degrades to whatever
  exists (at minimum, tests), reporting what it skipped.
- **Node ≥ 18** — dev only, to run shipyard's own test harnesses.

All MCP tools are wired per-project in the target repo's `.mcp.json`; shipyard ships none of
them. See [docs/tooling.md](../tooling.md).

## Future (out of scope for v1)

- The plan stage could later emit explicit stream/dependency metadata, making parallelization
  more reliable than inference. v1 infers and biases to sequential.
- Auto-opening a PR / driving the code gate straight through, if the team wants the pipeline
  to flow without a manual step.
