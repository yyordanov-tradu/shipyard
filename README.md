# shipyard

A gated AI-SDLC pipeline for Claude Code, built to be shared across a team and many projects.

Work enters, moves through stages, and passes inspection gates before it ships — like a real shipyard.

```
spec  →  plan  →  [PLAN GATE]  →  implement  →  [CODE GATE]
                  plan-readiness              expert-panel
                    -review                     -review
```

Each stage is a skill. The two **gates** are the skills you already rely on:

| Stage | Skill | What it does | Tools it uses |
|---|---|---|---|
| spec | `spec` | turn an idea into a spec (planned) | superpowers (engine) |
| plan | `plan` | turn a spec into a build plan (planned) | superpowers (engine) |
| **plan gate** | `plan-readiness-review` ✅ | spec ↔ plan alignment; panel argues to consensus. Verdict: READY / NEEDS-WORK / MISALIGNED | git, graphify, expert subagents |
| implement | `implement` | build the plan task-by-task with TDD (planned) | superpowers (engine), Serena (find), Claude Code (edit) |
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
| **superpowers** | engine for `spec` / `plan` / `implement` — to be **vendored**, so it stops being a runtime dependency once integrated | transitional |

**Per-project wiring:** graphify (and later Serena) are configured in each *target* repo's `.mcp.json`, not in shipyard. shipyard stays generic; each project brings its own MCP tools, rules, and conventions.

## Status

Early. The two review gates are built and tested. The generative stages (spec, plan, implement) are planned — see [docs/flow.md](docs/flow.md) for the full design and roadmap.

| Stage | Skill | State |
|---|---|---|
| spec | `spec` | planned |
| plan | `plan` | planned |
| plan gate | `plan-readiness-review` | ✅ built + tested |
| implement | `implement` | planned |
| code gate | `expert-panel-review` | ✅ built + tested |

## Install (team)

Until this is published to a shared marketplace, install from the local path:

```
/plugin marketplace add ~/dev/shipyard
/plugin install shipyard
```

(Distribution via a shared git remote + marketplace entry is a follow-up — see docs/flow.md.)

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
    plan-readiness-review/       plan gate (SKILL.md + DESIGN.md + PLAN.md + tests/)
    expert-panel-review/         code gate (SKILL.md + DESIGN.md + PLAN.md + tests/)
  docs/flow.md                   pipeline design + roadmap
```
