---
name: test-driven-implementation
description: Build a READY implementation plan into committed code, task by task with TDD. A lead analyses the plan for independent streams, then a fresh subagent builds each task (locate → ground → edit → verify → commit), escalating to you on failures or conflicts. Use when asked to implement a plan, build out a plan's tasks, or turn a READY plan into code.
---

# Test-Driven Implementation

Turn a plan that passed the plan gate into committed code on a feature branch, ready for the
code gate. Quality comes from a tight per-task loop, not a big prompt. Tool ownership follows
**docs/tooling.md** (the bible): the lead uses graphify (macro); per-task subagents use
agent-lsp (micro); Claude Code edits; ripgrep is the fallback.

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
- tools: **agent-lsp** retrieval (symbols/refs/types/diagnostics), **Claude Code** `Edit`/`Write`,
  **Bash** (verify commands + git in its worktree), **ripgrep**, **context7**. **Not** graphify,
  **not** agent-lsp's edit tools.

Each subagent runs the loop: **locate** (agent-lsp → ripgrep) → **ground** unfamiliar APIs
(context7) → **edit test-first** (write failing test → implement → refactor; Claude Code) →
**verify** (sequence with `node "$LIB/verify-gate.mjs" '<cmdsJson>'`, run steps in order; widen
with agent-lsp call-hierarchy for impacted tests) → fix to green → return `{branch, status}`.

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
