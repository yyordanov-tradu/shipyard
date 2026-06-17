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
| implement | `test-driven-implementation` | build the plan task-by-task with TDD (planned) | Serena (find), Claude Code (edit) |
| **code gate** | `expert-panel-review` ✅ | multi-expert diff/PR review; findings verified by 3 skeptics | git, gh, graphify, expert subagents |

Both gates run as local dynamic workflows, ground themselves in the codebase via **graphify**, and save reports under the project's `docs/reviews/`.

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

Planned stages add two more:

| Tool | Needed for | State |
|---|---|---|
| **Serena** (MCP) | symbol-level semantic **search/navigation** (find symbols & references) in the `implement` stage — edits stay with Claude Code | planned |
| **superpowers** | *not a runtime dependency.* It was useful inspiration while authoring the stages, but each shipyard stage carries its own logic and runs with superpowers absent. `expert-advised-planning` already does (it ships its own plan-format guide) | not required |

**Per-project wiring:** graphify (and later Serena) are configured in each *target* repo's `.mcp.json`, not in shipyard. shipyard stays generic; each project brings its own MCP tools, rules, and conventions.

## Status

Early. The two review gates and the plan stage are built and tested. The remaining generative stage (implement) is planned — see [docs/flow.md](docs/flow.md) for the full design and roadmap.

| Stage | Skill | State |
|---|---|---|
| plan | `expert-advised-planning` | ✅ built + tested |
| plan gate | `plan-readiness-review` | ✅ built + tested |
| implement | `test-driven-implementation` | planned |
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
    expert-advised-planning/     plan stage (SKILL.md + DESIGN.md + PLAN.md + tests/)
    plan-readiness-review/       plan gate (SKILL.md + DESIGN.md + PLAN.md + tests/)
    expert-panel-review/         code gate (SKILL.md + DESIGN.md + PLAN.md + tests/)
  workflows/                     the deterministic engines (one .js per skill), read via ${CLAUDE_PLUGIN_ROOT}
  docs/flow.md                   pipeline design + roadmap
```
