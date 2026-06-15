# plan-readiness-review — Design Spec

- **Date:** 2026-06-14
- **Status:** approved
- **Kind:** global, reusable Claude Code skill + saved dynamic workflow

## Overview

A global Claude Code skill that reviews a **spec + implementation plan together**, before
any code is written, and proves the plan is **ready to build from**. A flat panel of
domain-expert subagents reads the spec and plan (grounded in the real codebase), argues
to **consensus**, and produces **one report: a verdict plus the gaps**.

It is the upstream sibling of `expert-panel-review`. That skill grades *built code* after
the fact; this one gates the *plan* before the fact.

```
  SPEC -> PLAN ->| GATE 1            |-> implementation ->| GATE 2          |-> merge
                 | plan-readiness-   |                    | expert-panel-   |
                 | review (this)     |                    | review          |
                 | "is the plan good |                    | "is the built   |
                 |  to build from?"  |                    |  code good?"    |
```

## The design principle

Plan quality **caps** outcome quality. The best experts produce bad results from a vague
plan, and a downstream code review can only *measure* how bad the result is — it cannot
retroactively make an underspecified plan produce good code. So the highest-leverage place
to apply expert rigor is the plan itself, before a line is written. This skill is that gate.

It is **report-only by design**: it returns a verdict and the gaps. Fixing the plan is a
separate, deliberate iteration the user runs, then re-reviews until the verdict is READY.
The skill never rewrites the plan.

## No agent-to-agent handoff

Every expert reads the **real sources directly** — there is no agent that distills the
codebase or the docs into a summary and hands that summary to the others. One agent
compressing context for the rest is a known failure mode: the summary is lossy, and the
distilling agent's blind spots silently become everyone's blind spots.

Instead, the **launcher** (deterministic code, no model, no compression) gathers the raw
sources and gives the *same bundle* to every expert. Shared context with zero handoff loss.
Each expert also queries the code graph live for itself. This matches how `expert-panel-review`
already works (it passes the raw diff + rules to all experts).

## Goals

- **Guarantee spec ↔ plan alignment:** every spec requirement is covered by plan steps,
  and every plan step traces back to a spec requirement. No orphans, no silent scope creep.
- **Ground the review in reality:** the plan is checked against the actual architecture,
  codebase, code conventions, and module boundaries — not reviewed in a vacuum.
- **Check executability:** every plan task carries enough instruction, clarity, and
  validation points that a builder following it will not have to guess.
- **Surface disagreement honestly:** experts argue to consensus; contested points are shown
  with both sides, not silently dropped.
- **Reusable across projects:** nothing project-specific is baked in; rules and architecture
  are read at runtime. Degrades gracefully when optional tools are absent.
- **Stay under rate limits:** parallel agents are capped so a run does not trip Anthropic
  rate limiting.

## Non-goals (v1)

- Not a cloud service — runs locally as a dynamic workflow.
- Does not rewrite or patch the plan (report-only; fixing is a separate iteration).
- Not a code review — it reviews the spec and plan, not a diff. `expert-panel-review` is the
  code-review counterpart.
- No persistent architecture graph maintained by the skill (graphify owns the graph).

## Trigger and inputs

Command: `/plan-readiness-review [spec] [plan]`

Resolution (first match wins):

1. **Two explicit paths** → review exactly those files as `spec` and `plan`.
2. **No args** → auto-detect the newest file in `docs/specs/` as the spec and the newest in
   `docs/plans/` as the plan. If either is missing or ambiguous (more than one plausible
   match), ask the user; do not guess.

The repo for codebase grounding is the git root. If the project has no source code yet
(greenfield), there is simply no graph to query and the review runs on spec + plan + any
written docs alone.

## The raw bundle (what every expert receives)

The launcher gathers these once and passes the identical set to every expert:

1. **The spec** — full text.
2. **The plan** — full text.
3. **The project rules** — `CLAUDE.md`, `.claude/rules/*.md`, `docs/rules/*.md`.
4. **The architecture & design docs** — `docs/architecture/*`, ADRs
   (`docs/architecture/adrs/*`, `*ADR*`), and existing design/spec docs under
   `docs/**/specs/**`.

No agent compresses any of this. Each expert reads what it needs from the raw set.

## Codebase grounding (graphify)

The hard input is the **tacit architecture** — layering, how similar features are already
structured, naming, error-handling idioms, dependency direction. This lives only in the
code, not in the rules files. The skill surfaces it with
[graphify](https://github.com/safishamsi/graphify), a tree-sitter codebase-to-graph tool
that is offline for code and `uv`-installable.

### Keeping the graph fresh

The **launcher** runs `graphify update <repo>` before the workflow. This is incremental
(re-extracts only changed files) and offline for code (AST, no API calls), so refreshing per
run is cheap and never stale. Optionally the user runs `graphify hook install` once so the
graph stays warm between runs via git post-commit hooks.

### How experts query the graph

graphify offers **two separate integrations** with Claude Code; they are distinct and can
coexist:

- **Skill + hook** (`graphify <platform> install`) — writes a guidance section to `CLAUDE.md`
  plus a PreToolUse hook that nudges the agent to run the graphify **CLI** (`graphify query`
  / `path` / `explain`) before grepping. This drives the CLI; it is NOT an MCP connection.
- **MCP server** — `python -m graphify.serve <graph.json>` over stdio, registered in the
  project's `.mcp.json`. Exposes typed tools: `query_graph`, `get_node`, `get_neighbors`,
  `shortest_path` (plus PR-impact tools). Because graphify is installed via `uv tool install`,
  the command must point at that tool's interpreter
  (`~/.local/share/uv/tools/graphifyy/bin/python`), not a bare `python`. Project `.mcp.json`
  servers need a one-time trust approval before Claude Code starts them.

Experts query the graph live, preferring the most structured access available, in this order:

1. **graphify MCP tools** (`query_graph`, `get_node`, `get_neighbors`, `shortest_path`) — typed,
   scoped subgraphs; reachable by workflow subagents via ToolSearch once the server is approved.
2. **graphify CLI** (`graphify query` / `path` / `explain`, via Bash) — same scoped subgraphs
   through the shell; the installed skill+hook tells the agent which command fits which question.
3. **`graph.json`** (static file) — a fixed view, last resort.

If graphify is not installed at all, experts fall back to `claude-mem:smart-explore`
(tree-sitter) + grep. The report always notes which mode was used.

**This project (`parcel-audit-doc-intake`) setup:** graph built offline with `graphify update .`
(252 nodes / 452 edges); skill+hook installed; MCP server registered in `.mcp.json` (pending
the one-time approval).

## Expert roster (flat panel)

**Always-on (5):**

| Expert | `agentType` | Lens |
|---|---|---|
| Architecture | `architect-review` | architecture fit, module boundaries, does the plan respect the design, code↔docs drift |
| Alignment / traceability | *(generic, prompt-driven)* | spec↔plan coverage both ways; **owns the coverage table** |
| Test & validation strategist | `qa-automation-architect` | validation points, acceptance criteria, testability, definition of done |
| Conventions / compliance | *(generic, rule-driven)* | does the plan honor the project's own written rules |
| Executability critic | *(generic, prompt-driven)* | instruction clarity, task ordering, dependencies, ambiguity that forces guessing |

**Conditional (activated by what the spec/plan touches):**

- `security-auditor` — auth, untrusted input, secrets, data exposure.
- `performance-engineer` — hot paths, scale, data volume.
- **Domain expert** — roster-override only in v1 (the user names it). Not auto-guessed; the
  always-on Architecture expert covers general domain fit.
- **Language experts — one `*-pro` per detected language** (same map as `expert-panel-review`:
  `.py`→`python-pro`, `.ts/.tsx`→`typescript-pro`, etc.), in case plan steps name a
  language-specific approach worth an idiom check.

All experts are peers — none is positioned to feed the others. All selections are overridable
via a roster-override arg (comma-separated agent names).

### Conditional expert detection (no diff to key off)

This skill reviews two documents, not a diff, so there is no changed-file list to key off.
Detection works from the spec + plan text and the project itself:

- **Language experts** — deterministic: the union of (a) file paths named in the plan
  (extension → `*-pro`, same map as the diff skill) and (b) the project's actual languages
  (from graphify / the file tree). A plan that names no files simply activates no language
  expert — which is itself an executability gap the panel will raise.
- **Security / performance** — a **keyword scan** of the spec + plan, biased to *include when
  in doubt* (`auth|token|secret|password|encrypt|...` → `security-auditor`;
  `latency|throughput|scale|cache|hot path|...` → `performance-engineer`). A missed security
  review is worse than one extra expert, and `MAX_CONCURRENCY` caps peak load regardless.
- **Domain expert** — not auto-detected; roster-override only (see above).

The keyword lists are tunable constants in the workflow, and every selection is overridable.

## Compliance / rules sourcing

The compliance lane is a **generic** reviewer fed the project's own rules, sourced in order:

1. `<project>/.claude/plan-review-rules.md` (if present)
2. else `<project>/CLAUDE.md` + `<project>/.claude/rules/*.md` + `<project>/docs/rules/*.md`

Because the rules are read from the current project at runtime, the same generic lane enforces
each project's own constraints — no per-project agent, nothing project-specific in the skill.
These rules are part of the raw bundle every expert gets, not just the compliance lane.

## Phases (the workflow)

Three sequential phases — **Review → Debate → Decide** — with a hard **barrier** between each.
Parallel fan-out happens *inside* the Review and Debate phases; this is **not** a `pipeline()`
(independent per-item flow) — each phase must fully finish before the next starts.

```
REVIEW   parallel(<=MAX_CONCURRENCY): every expert reviews the raw bundle
                     (spec + plan + rules + arch docs), querying the graph live -> GAPs
        -- barrier --   (Debate needs ALL Review gaps)
DEBATE   parallel(<=MAX_CONCURRENCY): every expert argues the merged gap set -> REACTIONs
        -- barrier --   (Decide needs ALL reactions)
DECIDE   fold reactions -> consensus (AGREED | CONTESTED); verdict + report computed IN CODE;
         one agent writes an optional plain-language narrative only
```

## Concurrency & rate-limit control

Too many agents calling the API at once trips Anthropic rate limiting. The workflow caps its
own parallelism tighter than the runtime default (`min(16, cores-2)`):

- **`MAX_CONCURRENCY = 4`** — a tunable constant at the top of the workflow. Overridable at
  call time via env var / arg, so it can be dialed down on a bad day without editing the script.
- A `parallelLimited(thunks, MAX_CONCURRENCY)` helper runs the Review and Debate fan-outs in
  **waves**: at most `MAX_CONCURRENCY` experts in flight, the rest queue until a slot frees.
  So a 9-expert roster at cap 4 runs 4 → 4 → 1 instead of 9-at-once.
- **`STAGGER_MS = 0`** — an optional pause between waves, for when the limit is tokens-per-minute
  rather than concurrent requests. Off by default; raise it if needed.
- Decide is a single agent, so it never adds to the concurrent load.

## Consensus mechanism (the debate)

For *bugs* (the diff skill), the right move is refute-and-drop: a false positive is noise.
For *plan gaps*, a disagreement is **signal** — the user needs to see it. So this skill uses
debate-to-consensus instead of skeptic voting:

- **Review (round 1, parallel).** Each expert emits GAPs with severity and evidence.
- **Debate (round 2, parallel).** Each expert sees *everyone's* Review gaps and responds to
  each: concede, defend, dispute, or add.
- **Decide (synthesis).** Each GAP is classified **AGREED** (experts converge), **CONTESTED**
  (experts disagree — both sides shown), or dropped only if the original raiser retracts.

The debate *is* the verification — there is no separate skeptic fan-out.

**Verdict and report are computed in code** (`foldConsensus`, `computeVerdict`, `renderReport`),
not by an agent. The Decide phase's agent call only writes an optional plain-language narrative;
a flaky or missing agent can never change the verdict. This keeps the gate deterministic and testable.

## Output

Write the full review to `<project>/docs/reviews/YYYY-MM-DD-<slug>-plan-readiness.md`:

- the **verdict** (READY / NEEDS-WORK / MISALIGNED),
- the **Spec↔Plan coverage table** — each spec requirement → covering plan steps, or ⚠ if
  uncovered; plus plan steps with no spec basis. Built in Decide from the Alignment expert's
  matrix, falling back to any other expert's matrix if the Alignment lane failed. Folding
  non-alignment experts' alignment-dimension gaps into the table rows is v2; meanwhile such
  gaps still drive the verdict through the normal gap path.
- **gaps grouped by expert**, each with dimension, severity, evidence, and a suggested fix,
- a **Contested** section showing the disagreements and both sides,
- a **Raised in debate** section for `add` reactions (new angles surfaced during the debate),
- a line naming any **experts that failed to run**, so a clean verdict can't hide a crashed panel.

Print a short summary inline: verdict, panel that ran, gap counts by severity, any failed
experts, which graph access mode was used (graphify MCP / CLI / json / fallback / no-code),
and the saved path.

## Verdict

- **MISALIGNED** — any AGREED Blocker (a spec requirement no plan step covers, the plan
  contradicts the architecture, a boundary is violated).
- **NEEDS-WORK** — AGREED Majors, or any unresolved spec↔plan coverage gap.
- **READY** — only Minors and contested-non-blockers remain.

## Architecture

Two global artifacts, split by responsibility (same pattern as `expert-panel-review`):

- `~/.claude/skills/plan-readiness-review/SKILL.md` — **the launcher** (dynamic,
  environment-dependent): parse the arg, resolve the spec + plan paths, run
  `graphify update`, gather the raw bundle (rules + architecture/design docs), detect the
  conditional roster, run the workflow, then write the report + print the inline summary.
- `~/.claude/workflows/plan-readiness-review.js` — **the deterministic orchestration**:
  Review (parallel, capped) → Debate (parallel, capped) → Decide, with barriers between
  phases. Holds the `MAX_CONCURRENCY` / `STAGGER_MS` tunables. Receives everything via `args`.

The skill does the shell + I/O + selection; the workflow does the rigid control flow. It is a
**dynamic Workflow**, not Native Teams (no live coordination or shared mutable state) and not
bare Task agents (too many agents and too much conditional flow to hand-orchestrate).

## Data flow

```
/plan-readiness-review [spec] [plan]
  -> launcher resolves: spec text, plan text, repoPath, rules text, architecture/design docs, roster
  -> launcher runs `graphify update <repo>`
  -> launcher runs workflow (scriptPath) with args = { spec, plan, repoPath,
                                                       rules, designDocs, roster, maxConcurrency, date }
     REVIEW (parallel, <=cap): each expert reads the raw bundle + queries the graph live -> GAPs
     DEBATE (parallel, <=cap): each expert argues the merged gap set -> REACTIONs
     DECIDE: synthesize -> consensus + coverage table + verdict
  -> launcher writes docs/reviews/<date>-<slug>-plan-readiness.md + prints inline summary
```

## Schemas

- **MATRIX** (the Alignment expert's structured output): `{ requirements: [{ id, specRef,
  text, coveredBy: [planStep], status: covered|partial|uncovered }],
  orphanPlanSteps: [{ planStep, note }] }`
- **GAP:** `{ id, expert, dimension (alignment|grounding|executability|risk), severity
  (Blocker|Major|Minor), planSection, specRef, title, detail, evidence, fix }`
- **REACTION:** `{ gapId, stance (concede|defend|dispute|add), reason }`
- **CONSENSUS:** `{ gapId, status (agreed|contested), endorsers, dissenters }`

## Error handling

- **Missing/empty spec or plan** → clear message, exit cleanly (no empty report file).
- **Not a git repo / no code** → no graph; run on spec + plan + docs.
- **graphify MCP not registered** → graphify skill falls back to the `graphify query` CLI.
- **graphify not installed** → experts fall back to smart-explore/grep; note it in the report.
- **An expert errors** → its GAPs `= []` (filtered), noted in an "experts that failed" line;
  the review still completes.
- **Roster override names a missing agent** → warn and skip it.
- **Workflow returns no report** → show the error and STOP; never write an empty review.

## Testing

Reviews are non-deterministic, so we do not assert exact text.

- **Smoke test:** run on a spec+plan pair with a deliberately uncovered spec requirement.
  Expect: the coverage table flags it and the verdict is not READY.
- **Wiring/validity:** the workflow script parses; `SKILL.md` frontmatter is valid; the
  schemas are valid JSON Schema.
- **Concurrency:** `parallelLimited` never runs more than `MAX_CONCURRENCY` thunks at once
  (unit-testable with a counter + delayed thunks; no model calls).
- **Detection checks:** given a sample spec/plan + changed-file context, the conditional
  selector picks the right experts (`.py` → `python-pro`; security-touching spec →
  `security-auditor`).
- **Graph-access fallback:** with graphify absent, the run completes using smart-explore/grep
  and the report records the downgrade.

## Cost

Agents per run ≈ roster (5 + conditional) × 2 rounds (Review + Debate) + 1 Decide. No skeptic
fan-out (debate replaces it). `MAX_CONCURRENCY` bounds how many run at once (not the total), so
it controls peak API load and rate-limit risk, not the agent count. Conditional gating keeps
the roster scoped.

## File layout

```
~/.claude/skills/plan-readiness-review/SKILL.md    # launcher
~/.claude/skills/plan-readiness-review/DESIGN.md   # this spec
~/.claude/skills/plan-readiness-review/PLAN.md     # implementation plan
~/.claude/skills/plan-readiness-review/tests/      # wiring + detection + smoke tests
~/.claude/workflows/plan-readiness-review.js       # deterministic workflow
<project>/.claude/plan-review-rules.md             # optional, per-project rules
<project>/docs/reviews/<date>-<slug>-plan-readiness.md   # output
```

## Future (out of scope for v1)

- A `--fix` mode that emits an improved plan (v2 file) once the report is trusted.
- Re-review delta mode: only re-check gaps from the previous run.
- Persistent architecture graph queried across many reviews (if one big repo is reviewed often).
- Per-invocation severity threshold for the verdict.
```
