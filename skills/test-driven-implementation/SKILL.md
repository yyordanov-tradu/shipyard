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
2. Slug = the plan filename without date prefix/extension (used for verdict lookup via substring-matching the gate's report filename). Read the verdict:
   `node "$LIB/verdict.mjs" docs/reviews "<slug>"`.
   - `verdict == "READY"` → proceed.
   - otherwise → **STOP**: tell the user to run `plan-readiness-review` first — unless `--force`
     was passed (record "forced" in the summary).
3. Announce.

## Step 2 — Stream analysis (graphify = the lead's macro tool)

1. Parse tasks: `node "$LIB/plan-parse.mjs" "<plan-path>"`. If it returns **zero tasks**,
   **STOP** — the plan does not follow the task grammar (`### Task N: <title>` headings, a
   `**Files:**` block with backticked paths, the literal "depends on Task N"). Tell the user
   to fix the plan (or re-run `expert-advised-planning`); never guess a schedule from prose.
   Example of a parseable task:
   ```markdown
   ### Task 2: Wire the widget API
   **Files:**
   - Modify: `src/api/routes.js`
   This task depends on Task 1.
   ```
2. If graphify is installed, query it for dependency edges between the areas the tasks touch
   (macro question — graphify owns it; see the bible). Build `depEdges` as `[[fromId,toId],...]`
   and set `graphAvailable=true`. If graphify is absent, `graphAvailable=false` (bias to
   sequential) and say so.
3. Partition: `node "$LIB/streams.mjs" "<plan-path>" '<depEdgesJson>' [--graph]`. Print the
   resulting streams, `parallel`, and `conviction` so the user sees the execution shape before
   any code is written.
4. **Collect project conventions (once).** Run
   `node "${CLAUDE_PLUGIN_ROOT}/lib/collect-rules.mjs" "$(git rev-parse --show-toplevel)"`.
   It returns `{ stack, rules }` from the target repo's `.claude/rules/*.md` (see the tooling
   bible). Print a one-line summary — e.g. `conventions: stack node · 3 rule file(s)`, or
   `conventions: none found — stack defaults` when `rules` is empty. Empty is fine and means the
   build behaves exactly as before. Keep the returned `stack` and `rules` for the subagent contract.

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
- the **project conventions** collected in Step 2: the `stack` label (a one-line "this is a
  <stack> repo" hint) and the full text of each `.claude/rules/*.md` file, given as **binding
  conventions to follow** while writing code. If none were found, say "no project rules — stack
  defaults" so the subagent knows the standard is its own good judgement, not a missing input;
- tools: **Serena** retrieval for symbol/structure visibility — `get_symbols_overview` (map a
  file/module's structure before touching it), `find_symbol` (jump to an exact definition),
  `find_referencing_symbols` (every caller), `get_diagnostics_for_file` (types/errors) — plus
  **Claude Code** `Edit`/`Write`, **Bash** (verify commands + git in its worktree), **ripgrep**,
  **context7**. **Not** graphify, **not** Serena's edit tools.

Each subagent runs the loop: **locate** — map structure first with Serena `get_symbols_overview`,
then `find_symbol` for the exact definition and `find_referencing_symbols` for every caller, so the
edit's blast radius is visible *before* you touch code; fall back to ripgrep and say "Serena absent
— text search only" when Serena isn't wired → **ground** unfamiliar APIs (context7) → **edit
test-first** (write failing test → implement → refactor; Claude Code) → **verify** (sequence with
`node "$LIB/verify-gate.mjs" '<cmdsJson>'`, run steps in order; widen with Serena
`find_referencing_symbols` / call-hierarchy to find the tests this change impacts) → fix to green →
return `{branch, status}`.

## Step 4 — Review between tasks (light)

Before committing a task, confirm the verify gate passed (green, clean diagnostics) and sanity-
check the diff against the task's intent. A plainly off-intent diff is a failure (retry, then
escalate). Also check the diff against the project conventions from Step 2: a change that
**plainly** violates a stated rule (e.g. the repo's naming or error-handling convention) is a
failure — retry, then escalate, the same as an off-intent diff. Keep this light: no rule parsing,
just catch blatant breaks. Deep review is the **code gate's** job — do not duplicate it here. Commit per task:
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
