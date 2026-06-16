---
name: expert-advised-planning
description: Design spec for shipyard's plan-creation stage — a lead agent drafts an executable plan after consulting a panel of expert advisers, with disagreements resolved by a neutral arbiter and escalated to a human when needed.
status: approved
created: 2026-06-16T17:27:54Z
updated: 2026-06-16T17:27:54Z
kind: global, reusable Claude Code skill + saved dynamic workflow
---

# expert-advised-planning — Design Spec

## Overview

A global Claude Code skill that turns a **Jira ticket or a spec** into an **executable
implementation plan**. A lead agent writes the plan, but first it **consults a panel of
expert advisers** (architecture, test, security, performance, plus conditional and
caller-added experts). When advisers disagree — with each other or with the lead's intended
direction — a **neutral arbiter** decides, and anything genuinely uncertain or high-stakes
is **escalated to the human**. Every resolution is recorded in the plan.

It is the plan-creation stage of the shipyard pipeline. It **creates**; it does not
validate. Validation is a separate, independent gate (`plan-readiness-review`) run
afterward. This separation is deliberate: advisers help *create* (so the plan arrives
strong), and an independent panel *judges* later (so trust comes from independence, never
from the same agent doing both).

```
idea -> [spec] -> [plan] -> [PLAN GATE] -> [implement] -> [CODE GATE] -> ship
        guided-   expert-    plan-          test-driven-   expert-
        spec-     advised-   readiness-     implementation panel-
        writing   planning   review                        review
                  (this)     (gate)                         (gate)
```

## Place in the pipeline and naming

shipyard names its skills with a simple, intuitive convention: **the last word is the
activity; the modifier names what is distinctive about that stage.** Gates end in
`-review` (they judge); generative stages are named by their activity.

| Stage | Skill | Role | State |
|---|---|---|---|
| spec | `guided-spec-writing` | generative | planned |
| **plan** | **`expert-advised-planning`** | generative | this spec |
| plan gate | `plan-readiness-review` | gate | built |
| implement | `test-driven-implementation` | generative | planned |
| code gate | `expert-panel-review` | gate | built |

## The design principle

**Own the interfaces, borrow the engines.** The hard thinking (drafting an executable plan)
reuses a proven engine — superpowers `writing-plans` — vendored into shipyard, not depended
on at runtime. What must be shipyard's own and stable is the **plan artifact**, because the
plan gate and the implement stage both read it.

**Advise is not validate.** Consultation and validation are different acts. An expert who
helped shape the plan cannot then be trusted to judge it — that destroys independence. So
this skill keeps experts in the *advisory* role during creation and leaves the independent
verdict to `plan-readiness-review`. The same experts may staff both, but never the same
agent for the same plan in both roles.

## Goals

- **Stronger first-draft plans.** Expert advice shapes the approach before a line of the
  plan is written, so the plan that reaches the gate has fewer blockers.
- **No silent overrides.** When the lead would deviate from an adviser, or two advisers
  clash, the disagreement is surfaced and resolved on the record — never buried.
- **Grounded advice and decisions.** Advisers and the arbiter read the real codebase, not
  just the spec text, so advice is concrete and decisions are evidence-based.
- **Executable output.** The plan is bite-sized, test-first, with exact file paths and real
  code per step — ready for `test-driven-implementation` with no guessing.
- **Auditable.** Every resolved conflict, with who decided and why, is recorded in the plan.
- **Reusable across projects.** Nothing project-specific is baked in; rules and architecture
  are read at runtime. Degrades gracefully when optional tools are absent.
- **Under rate limits.** Parallel agents are capped so a run does not trip rate limiting.

## Non-goals (v1)

- Not a validator. It does not judge the plan; `plan-readiness-review` does.
- Not a cloud service — runs locally as a dynamic workflow.
- Does not implement anything; it only produces the plan.
- No persistent architecture graph maintained by the skill (graphify owns the graph).

## Trigger and inputs

Command: `/expert-advised-planning [source] [--add <agents>] [--roster <agents>]`

Two entry forms for `source`:

1. **Spec** — an explicit spec path, or the newest file in `docs/specs/` when none is given.
2. **Jira ticket** — a ticket id; the launcher fetches and assembles the ticket's full
   context (body, acceptance criteria, comments, parent/linked issues).

If the source is missing, empty, or ambiguous (more than one plausible spec), the launcher
asks the user; it does not guess. The repo for grounding is the git root; greenfield
projects simply have no graph.

## The raw bundle (what every adviser receives)

The launcher gathers one bundle and gives the **identical set** to every adviser. No agent
compresses it for the others — one agent summarizing for the rest is a known failure mode
(the summary is lossy, and the summarizer's blind spots become everyone's).

1. **The full raw source** — the entire spec, or the whole assembled ticket context. Whole,
   not a slice; raw, not a summary.
2. **Project grounding** — rules (`CLAUDE.md`, `.claude/rules/*.md`, `docs/rules/*.md`),
   architecture and design docs (`docs/architecture/*`, ADRs, existing specs), and the live
   codebase (see grounding below).
3. **The lead's framing** — the problem statement plus the specific decisions the lead wants
   advice on. This *focuses* the consult; it does not replace the raw source, so advisers can
   challenge the framing itself (for example, flag a decision the lead missed).

## Codebase grounding

Advice and arbitration are grounded in the real codebase, so they are concrete ("reuse the
existing `OrderValidator`, do not add a parallel one") rather than abstract.

- **graphify** (MCP tools `query_graph` / `get_node` / `get_neighbors` / `shortest_path`, or
  the `graphify query` / `path` / `explain` CLI) is preferred for the architecture view. The
  launcher runs `graphify update <repo>` first (incremental, offline for code).
- **Fallback** when graphify is absent: `claude-mem:smart-explore` (tree-sitter) + grep.
- **Greenfield** (no repo/code): text-only, on the spec + rules + docs alone.

Both **advisers** and the **arbiter** have this read access plus tools. The arbiter does not
decide from the two written positions alone — it can query the code itself before ruling.
The report always records which grounding mode was used.

## Expert roster

The panel is the union of three sources:

**Always-on (4):**

| Adviser | agentType | Lane |
|---|---|---|
| Architecture | `architect-review` | principles, patterns, decoupling, module fit |
| Test strategist | `qa-automation-architect` | validation points, testability, definition of done |
| Security | `security-auditor` | how to handle the specific security concern |
| Performance | `performance-engineer` | hot paths, scale, caching |

**Conditional, auto-detected** (same logic as `plan-readiness-review`):

- **Language experts** — one `*-pro` per language present in the repo or named in the source
  (`.py`->`python-pro`, `.ts`/`.tsx`->`typescript-pro`, `.java`->a java expert, etc.).
- **`database-optimizer`** — when schema, queries, or migrations appear.
- **Frontend** — when UI is in scope.

**Caller-added and override:**

- **`--add <agents>`** — append additional predefined expert agents for this run (for example
  `--add integration-expert`, or any agent type in the catalog: network, payments, etc.).
  Added on top of detection.
- **`--roster <agents>`** — replace the whole panel with a named list (full manual control).
- A named agent that does not exist -> warn and skip; never fail the run.
- A **domain expert** is never auto-guessed; add it with `--add` if wanted.

Each adviser **stays in its lane** and gives domain advice on the *approach* — "how to
approach your area" — not a general opinion on the whole plan. Bias when unsure -> include;
the concurrency cap keeps cost bounded.

## The flow

The work splits between the **launcher** (the SKILL.md / main agent — the only thing that
can talk to the human) and the **workflow** (the orchestration that runs agents). The split
exists because a Workflow runs to completion and cannot pause for a human, so the human turn
lives in the launcher.

```
LAUNCHER (setup)
  - resolve input:  spec file  OR  Jira ticket (fetch + assemble body, AC, comments, links)
  - gather raw bundle:  source + rules + architecture docs
  - refresh graphify (if repo + installed); else mark fallback / text-only
  - detect roster:  always-on + conditional + --add extras (or --roster override)
        |
        v
WORKFLOW (run 1)
  PHASE 1  FRAME      (lead)          read bundle -> problem statement + key decisions
        |  -- barrier --
  PHASE 2  ADVISE     (parallel <=cap) each adviser: bundle + framing + live graph -> ADVICE
        |  -- barrier --
  PHASE 3  RECONCILE                  reconciler finds conflicts (expert<->expert AND
        |                             framing<->expert); neutral ARBITER decides each ->
        |                             { resolution, rationale, confidence, stakes }
        |  -- barrier --
        v
  has escalations?  --no-->  PHASE 4 DRAFT runs in the same run --> returns { plan }
        | yes
        v  returns { framing, advice, autoDecisions, escalations, roster, graphMode }
LAUNCHER (human gate)
  - present each escalation (both sides + arbiter's lean) -> collect human decisions
        |
        v
WORKFLOW (run 2, resumeFromRunId = run 1, args += humanDecisions)
  PHASE 1-3 replay from the JOURNAL instantly (no re-run, no extra cost)
  PHASE 4  DRAFT      (lead)          write the full plan with the writing-plans engine,
        |                             bound to ALL resolved decisions (auto + human)
        v  returns { plan }
LAUNCHER (finish)
  - render shipyard sections in code; write plan to docs/plans/<date>-<slug>.md
  - print summary: roster, conflicts (auto vs escalated), graph mode, path
  - remind: next step is the plan-readiness-review gate
```

The resume/journal is what makes the human-escalation split cheap. When escalations exist,
run 2 replays FRAME / ADVISE / RECONCILE from the journal for free and only DRAFT runs live.
When there are no escalations, the whole thing runs FRAME -> ADVISE -> RECONCILE -> DRAFT in
a single pass.

## The disagreement ladder

This is the "not silent" guarantee. Conflicts are caught and resolved *before* the lead
drafts, so the lead cannot quietly override anyone.

1. **Detect** (RECONCILE) — a reconciler agent reads all advice + the framing and emits a
   conflict set of two kinds:
   - **expert <-> expert** — advisers recommend incompatible approaches.
   - **framing <-> expert** — an adviser contradicts the lead's intended direction (the
     "lead does not agree" case, surfaced instead of buried).
2. **Arbitrate** — a **neutral arbiter agent — never one of the two parties** — reads both
   positions + the raw bundle + grounding + rules, and returns a decision with **rationale,
   a confidence level, and a stakes level.** The arbiter may query the code to decide.
3. **Resolve or escalate:**
   - **Auto-resolve** when the arbiter is *high-confidence* **and** the conflict is *not
     high-stakes*.
   - **Escalate to the human** when the arbiter is *low-confidence* **or** the conflict is
     *high-stakes* (security, irreversible architecture, anything Blocker-level).
4. **Record everything** — every resolution, auto or human, lands in the plan's "Decisions &
   trade-offs" section, noting who decided (arbiter vs human) and why.

The lead drafts **bound to these resolved decisions** — it cannot reopen them, which is what
makes the consultation actually stick in the final plan.

## The output artifact

One file -> `docs/plans/<date>-<slug>.md`, in the exact shape `plan-readiness-review` reads
and `test-driven-implementation` builds from.

**Body — writing-plans format (vendored engine):**

- Header: goal (one sentence), architecture (2-3 sentences), tech stack, and the
  agentic-worker preamble.
- Tasks as **bite-sized TDD steps** — exact file paths, real code in every code step, exact
  test commands with expected output, checkbox tracking, **no placeholders**.

**Shipyard sections (appended, rendered in code from structured data):**

- **Source** — link/ref to the spec file or Jira ticket the plan was built from.
- **Decisions & trade-offs** — every resolved conflict: the question, the options, the
  resolution, who decided (arbiter vs human), the confidence, and the rationale.
- **Adviser provenance** — which advisers ran, the key advice each gave, and the graph mode
  used.
- **Panel note** — any adviser that failed to run, so a clean-looking plan cannot hide a
  crashed panel.

## What is agent vs code (determinism)

| Step | Agent or code |
|---|---|
| Framing, advice, conflict detection, arbiter rulings | **agents** (judgment) |
| Auto-resolve vs escalate routing | **code** — a pure function of the arbiter's `confidence` + `stakes`. A flaky agent can never change *whether* a conflict reaches the human. |
| Plan body (tasks/steps) | **agent** — the lead drafts (generative) |
| Decisions / provenance / source / panel sections | **code** — rendered from the structured decision & advice objects, then stitched into the file, so the audit trail is accurate and never hallucinated |

This mirrors `plan-readiness-review`, which computes its verdict in code so a missing or
flaky agent cannot change the outcome.

## Concurrency and rate-limit control

- **`MAX_CONCURRENCY = 4`** — a tunable constant at the top of the workflow, overridable at
  call time via env var / arg.
- A `parallelLimited(thunks, MAX_CONCURRENCY)` helper runs the ADVISE fan-out and the arbiter
  fan-out in **waves**: at most `MAX_CONCURRENCY` agents in flight, the rest queue.
- **`STAGGER_MS = 0`** — optional pause between waves for tokens-per-minute limits; off by
  default.
- FRAME and DRAFT are single agents, so they never add to concurrent load.

## Engine vendoring

The `writing-plans` prompt is **vendored** into the DRAFT phase's lead agent — a reference
implementation, not a runtime dependency, per shipyard's vendor-don't-depend stance. Check
the engine's license before copying; keep attribution.

## Error handling

- **No spec / ticket not found / empty source** -> clear message, exit, never write an empty
  plan.
- **Greenfield (no repo/code)** -> no graph; run text-only; note it.
- **graphify absent** -> grep / smart-explore fallback; report records the mode.
- **An adviser errors** -> its advice `= []` (filtered), noted in the panel line; run
  continues.
- **`--add` / `--roster` names a missing agent** -> warn and skip.
- **Arbiter fails on a conflict** -> that conflict auto-escalates to the human (fail-safe — a
  conflict is never silently dropped because the arbiter crashed).
- **Human cancels at the gate** -> abort cleanly, write nothing.
- **Workflow returns no plan** -> show the error and STOP; never write a partial plan.

## Testing

Plans are non-deterministic, so we test structure, wiring, and the deterministic logic — not
exact text.

- **Smoke:** a spec with a built-in conflict (two requirements implying incompatible
  approaches) -> expect a conflict detected and recorded in "Decisions & trade-offs," and a
  plan produced.
- **Wiring/validity:** the workflow script parses; SKILL.md frontmatter is valid; the schemas
  are valid JSON Schema.
- **Concurrency:** `parallelLimited` never runs more than `MAX_CONCURRENCY` thunks at once
  (counter + delayed thunks, no model calls).
- **Detection:** a sample spec/ticket picks the right conditional experts (`.py` ->
  `python-pro`; security-touching source -> `security-auditor`); `--add` appends; `--roster`
  replaces; a missing agent is skipped.
- **Escalation routing (pure function):** given arbiter outputs with `confidence` / `stakes`,
  the code routes auto vs escalate correctly — no model.
- **Resume path:** run 1 returns escalations -> run 2 with `resumeFromRunId` replays
  FRAME/ADVISE/RECONCILE and only DRAFT runs live.
- **Graph fallback:** with graphify absent, the run completes via grep and the report records
  the downgrade.
- **Output shape:** the produced plan parses as writing-plans format (header + tasks with
  steps) and contains the shipyard sections.

## Schemas

- **FRAMING** `{ problem, keyDecisions: [{ id, question, leadLean }], lanes: [...] }`
- **ADVICE** `{ expert, lane, recommendations: [{ id, text, rationale, evidence }],
  risks: [...], patterns: [...] }`
- **CONFLICT** `{ id, kind: expert-expert | framing-expert, parties, summary,
  positions: [{ party, stance }] }`
- **DECISION** `{ conflictId, resolution, rationale, confidence: high|med|low,
  stakes: high|med|low, evidence }`
- **HUMAN_DECISION** `{ conflictId, resolution, note }`

## Architecture

Two global artifacts, split by responsibility (same pattern as `plan-readiness-review` and
`expert-panel-review`):

- `~/.claude/skills/expert-advised-planning/SKILL.md` — **the launcher** (dynamic,
  environment-dependent): parse args, resolve the source, fetch a Jira ticket if needed, run
  `graphify update`, gather the raw bundle, detect the roster, run the workflow(s), run the
  human gate, render the shipyard sections, write the plan, and print the inline summary.
- `~/.claude/workflows/expert-advised-planning.js` — **the deterministic orchestration**:
  FRAME -> ADVISE -> RECONCILE -> (return escalations | DRAFT), with barriers between phases.
  Holds the `MAX_CONCURRENCY` / `STAGGER_MS` tunables and the schemas. Receives everything via
  `args`.

The skill does the shell + I/O + selection + human interaction; the workflow does the rigid
control flow. It is a **dynamic Workflow**, not Native Teams (no live coordination or shared
mutable state) and not bare Task agents (too many agents and too much conditional flow to
hand-orchestrate). Run durability comes from the Workflow journal and `resumeFromRunId`; no
hand-rolled JSONL.

## File layout

```
~/.claude/skills/expert-advised-planning/SKILL.md     # launcher
~/.claude/skills/expert-advised-planning/DESIGN.md    # this spec (also kept in docs/specs/)
~/.claude/skills/expert-advised-planning/PLAN.md      # implementation plan
~/.claude/skills/expert-advised-planning/tests/       # wiring + detection + routing + smoke
~/.claude/workflows/expert-advised-planning.js        # deterministic workflow
<project>/docs/plans/<date>-<slug>.md                 # output
```

## Cost

Agents per run ~= 1 FRAME + roster (4 + conditional + added) ADVISE + 1 reconciler + arbiter
(one per conflict) + 1 DRAFT. `MAX_CONCURRENCY` bounds how many run at once (not the total),
so it controls peak API load and rate-limit risk. The resume path adds no agent cost — replayed
phases come from the journal.

## Future (out of scope for v1)

- A re-plan delta mode: only re-draft the parts affected by changed advice.
- Promote common conditional experts (for example integration) into the auto-detection map.
- A tighter loop with `plan-readiness-review`: feed gate gaps back as new framing for a
  re-draft.
- Per-invocation stakes/confidence thresholds for the escalation rule.
