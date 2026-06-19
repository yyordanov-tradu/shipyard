# shipyard

A gated AI-SDLC pipeline for Claude Code, built to be shared across a team and many projects.

Work enters, moves through stages, and passes inspection gates before it ships — like a real shipyard.

```
Jira ticket  →  plan  →  [PLAN GATE]  →  implement  →  [CODE GATE]
                         plan-readiness              expert-panel
                           -review                     -review
```

Work enters as a Jira ticket. Each stage is a skill; the two **gates** are the skills you already rely on:

| Stage | Skill | What it does | Tools it uses |
|---|---|---|---|
| plan | `expert-advised-planning` ✅ | turn a Jira ticket (or pasted spec) into a plan; lead drafts after an expert panel advises, conflicts arbitrated, escalated to a human when uncertain/high-stakes | graphify, expert subagents |
| **plan gate** | `plan-readiness-review` ✅ | ticket ↔ plan alignment; panel argues to consensus. Verdict: READY / NEEDS-WORK / MISALIGNED | git, graphify, expert subagents |
| implement | `test-driven-implementation` ✅ | build the plan task-by-task with TDD; a lead splits the plan into independent streams, a fresh subagent builds each task | Serena (find/diagnostics, optional — ripgrep fallback), Claude Code (edit) |
| **code gate** | `expert-panel-review` ✅ | multi-expert diff/PR review; findings verified by 3 skeptics | git, gh, graphify, expert subagents |

The plan stage and both gates run as **local dynamic Workflow engines** (explained below),
ground their experts in the real codebase via **graphify**, and the gates save their reports
under the project's `docs/reviews/`.

## How a stage works: launcher + engine

Every stage is two pieces that split *judgment* from *orchestration*:

- A **launcher** (`SKILL.md`) — the prose Claude Code runs. It does I/O only: resolve the
  input (ticket / plan / diff), gather rules and context, then hand off to the engine.
- An **engine** — the deterministic core. For the fan-out stages (`expert-advised-planning`
  and both gates) the engine is a **dynamic Workflow** script (`workflows/<skill>.js`) that the
  **Workflow** tool executes. The orchestration — looping, fanning out N experts in parallel,
  routing on a verdict, escalating a conflict, deduping, synthesizing — is **plain JavaScript,
  not model improvisation**. Subagents are spawned *only* for the parts that genuinely need
  judgment (an expert's opinion, a skeptic's attempt to refute a finding); everything around
  them is ordinary code.

Why this "dynamic workflow for a deterministic approach" matters:

- **Deterministic orchestration.** Who runs, in what order, when to stop, when to escalate to a
  human — all decided by code. The pipeline's shape is repeatable and auditable, not re-invented
  by an LLM on each run.
- **Testable without spawning a single agent.** Each engine has a dry-run harness
  (`skills/*/tests/`) that stubs the `agent()` calls and asserts the control flow itself: roster
  detection, concurrency caps, verdict rules, escalation routing, per-file diff slicing. The
  whole suite runs with plain `node` — no API calls, no cost.
- **Grounded cheaply.** The engine hands each agent only what it needs. The code gate runs in
  **repo mode**: it gives each expert a changed-file list + a base ref, and the agent reads its
  slice with `git diff` from the repo — so even a large PR reviews in one pass instead of
  inlining the whole diff into every prompt.

The one deliberate exception is **implement** (`test-driven-implementation`): its engine is a set
of plain `lib/*.mjs` helpers (plan parsing, stream partitioning, gate-verdict reading, verify-gate
sequencing), not a Workflow script — its work is a per-task TDD loop the launcher drives directly,
so it needs no fan-out. Pick the fit, not the symmetry.

## Dependencies (the team must have these)

These stages call external tools. The gates fail loudly with a clear message when a required tool is missing — they do not guess or silently degrade beyond the documented fallback.

| Tool | Needed for | Required? |
|---|---|---|
| **Claude Code** | everything — runs the skills and spawns the expert subagents | **required** |
| **git** | both gates (operate on a repo / a diff) | **required** |
| **domain-expert agents** (backend, qa, security, performance, compliance, + conditional frontend, database, language) | staffing the panels in both gates | **required for the gates** — these agent types must exist in the host's agent catalog |
| **graphify** (MCP server + CLI) | grounding the experts in the real codebase | **recommended** — if absent, experts fall back to smart-explore/grep; never blocks a review |
| **gh CLI** | `expert-panel-review` PR mode (review a GitHub PR by number) | **required for PR mode only**; local-diff modes work without it |
| **Node.js ≥ 18** | running shipyard's own test harnesses (`skills/*/tests/*.mjs`) | **dev only** — needed to maintain/validate shipyard, not to use it |

Two more tools, optional or per-project:

| Tool | Needed for | State |
|---|---|---|
| **Serena** (MCP) | symbol-level code intelligence (find symbols & references, types, diagnostics) in the `implement` stage — edits always stay with Claude Code. Install/config: [docs/serena.md](docs/serena.md); rules: [docs/tooling.md](docs/tooling.md) | **optional** — the `implement` stage is built and runs today; without Serena it falls back to ripgrep |
| **superpowers** | *not a runtime dependency.* It was useful inspiration while authoring the stages, but each shipyard stage carries its own logic and runs with superpowers absent (e.g. `expert-advised-planning` ships its own plan-format guide) | not required |

**Per-project wiring:** graphify (and later Serena) are configured in each *target* repo's `.mcp.json`, not in shipyard. shipyard stays generic; each project brings its own MCP tools, rules, and conventions. The authoritative tool-ownership rules live in [docs/tooling.md](docs/tooling.md).

## Status

All four stages are built, and their deterministic logic is covered by unit tests (run
`for t in skills/*/tests/test-*.mjs; do node "$t" || break; done`). See
[docs/flow.md](docs/flow.md) for the full design and roadmap.

| Stage | Skill | State |
|---|---|---|
| plan | `expert-advised-planning` | ✅ built + tested |
| plan gate | `plan-readiness-review` | ✅ built + tested |
| implement | `test-driven-implementation` | ✅ built + tested |
| code gate | `expert-panel-review` | ✅ built + tested |

## Install (team)

Until this is published to a shared marketplace, install from the local path:

```
/plugin marketplace add ~/dev/shipyard
/plugin install shipyard
```

The deterministic engines live in `workflows/` inside the plugin. Each skill points the **Workflow**
tool at `${CLAUDE_PLUGIN_ROOT}/workflows/<skill>.js`, so the engine is read straight from wherever the
plugin is installed — no copy step, nothing written to `~/.claude/`. (Publishing via a shared git
remote + marketplace entry is still a follow-up — see docs/flow.md.)

## Design principles

- **Own the interfaces, borrow the engines.** The generative stages reuse proven approaches (superpowers) but emit *shipyard's* artifact formats, so the gates never drift.
- **Self-contained.** Engine logic is vendored, not depended on, so one install gives the team the whole pipeline.
- **Gates are enforced, not optional.** A gate you can skip is not a gate (CI/hook enforcement is on the roadmap).
- **Per-project config lives in the repo.** Rules, conventions, and `.mcp.json` (graphify, later Serena) ship with each project.

## Layout

```
shipyard/
  .claude-plugin/plugin.json     plugin manifest
  skills/
    expert-advised-planning/     plan stage (SKILL.md + tests/)
    plan-readiness-review/       plan gate (SKILL.md + tests/)
    test-driven-implementation/  implement stage (SKILL.md + lib/ + tests/)
    expert-panel-review/         code gate (SKILL.md + tests/)
  workflows/                     dynamic-Workflow engines for the fan-out stages (one .js each),
                                 read via ${CLAUDE_PLUGIN_ROOT} — implement uses lib/ instead
  docs/specs/                    design specs (one per skill, <date>-<topic>-design.md) — canonical
  docs/plans/                    implementation plans (one per skill, <date>-<skill>.md) — canonical
  docs/reviews/                  gate reports land here (gitignored — local, not shared)
  docs/flow.md                   pipeline design + roadmap
  docs/tooling.md                tool-ownership bible (graphify / Serena / Claude Code)
```
