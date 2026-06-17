# shipyard — pipeline design & roadmap

## The idea

One repeatable flow that takes an idea to shipped code, with two inspection gates that
catch problems early (in the plan) and late (in the code). It is built as a Claude Code
plugin so a whole team gets the identical pipeline from one install.

```
Jira ticket  →  plan  →  [PLAN GATE]  →  implement  →  [CODE GATE]
                expert-   plan-          test-driven-  expert-
                advised-  readiness      implementation panel-
                planning  -review ✅                   -review ✅
                   ✅
```

Work enters as a Jira ticket; there is no separate spec-authoring stage.

Skills are named `<modifier>-<activity>`; a `-review` suffix marks a gate (it judges), an
activity noun marks a generative stage (it builds).

## Why gates

The plan is the contract that gets implemented. If the plan is wrong or drifts from the
ticket, every line of code built from it is wrong. So we check **alignment before code**
(plan gate) and **result after code** (code gate). The two gates are the high-value parts
and they already exist.

## Stage responsibilities

| Stage | Owns | Does NOT do |
|---|---|---|
| `plan` | turn the ticket into a task-by-task build plan in shipyard's format | write code |
| `plan-readiness-review` | judge ticket↔plan alignment, return READY / NEEDS-WORK / MISALIGNED | fix the plan |
| `implement` | build the plan with TDD, using the right tools | re-decide the design |
| `expert-panel-review` | judge the diff, verify findings with skeptics | merge or deploy |

## Core principle: own the interfaces, borrow the engines

- **Engine** = the thinking (brainstorming dialogue, planning reasoning, TDD execution).
  Reuse a proven engine (superpowers) — do not reinvent it.
- **Interface** = the artifacts that pass between stages (`plan.md` and the review
  reports). These must be **shipyard's** and **stable**, because the gates and the
  implement stage are coupled to their shape.

A stage = a thin shipyard skill that delegates the hard thinking to the engine, then
normalizes the output to shipyard's format.

## Dependency stance: vendor, don't depend

For a team product, an external plugin dependency means an extra install for every dev and
every CI runner, plus version drift you do not control — which would let an upstream change
silently break the gates. So:

- **Vendor** the engine skills we use (copy + adapt into shipyard). One install, full
  control, no drift. This is the plan for `plan` / `implement`.
- Treat superpowers as a **reference implementation**, not a runtime dependency.
- Check the engine's license before copying; keep attribution.

(Open item: confirm whether Claude Code plugins can declare and auto-install another plugin
as a dependency. If they cannot, vendoring is the only clean option.)

## Three tools, three jobs — no overlap

The rule: **one tool per job.** If two tools can do the same thing (e.g. two editors), the
model wastes turns deciding between them and makes mistakes. So each job has exactly one
owner.

| Job | Owner | Phase |
|---|---|---|
| Understand the architecture (the map) | **graphify** | plan creation + review gates |
| Find code precisely (symbols, references) | **Serena** — search/navigation only | building |
| Change code (every edit) | **Claude Code** native tools (Edit / Write) | building |

In `implement`: Serena to locate the exact method / class / reference → Claude Code to
make the change → run tests. (graphify is a review-side tool; it is not used here.)

### graphify — the helicopter view (planning side)

**What it is:** an open-source knowledge-graph skill for AI coding assistants. It parses a
codebase (and docs/diagrams) into a queryable graph using Tree-sitter, NetworkX, and Leiden
community detection. Runs locally — code is not sent anywhere.

**Strong where:** the high-level view. It surfaces "god nodes" (the most-connected hubs),
community clusters, surprising cross-module connections, and dependency paths — and answers
architecture questions at a small fraction of the tokens of reading raw files. That is
exactly what the `plan-readiness-review` gate needs to judge whether a plan fits the real
structure; the code gate also uses it to ground the expert reviewers. The `plan` *creation*
stage (`expert-advised-planning`) now uses it too — advisers and the arbiter ground their
reasoning in the real codebase, falling back to smart-explore/grep when graphify is absent.
Read-only throughout.

Source: <https://graphify.net/> · MCP tools `query_graph`, `get_node`, `get_neighbors`,
`shortest_path`.

### Serena — precise search & navigation (building side)

**What it is:** an open-source MCP coding-agent toolkit built on the Language Server
Protocol (LSP). It understands code at the **symbol level** (methods, classes, references)
across 40+ languages, instead of line numbers or text search.

**Strong where, and how shipyard uses it:** precise semantic search — find the exact symbol
and all the places that reference it, reliably, even in large codebases. shipyard uses
Serena **only to find and navigate**. All edits are made with Claude Code's native tools.
Serena can also edit, but we deliberately do not use that: two editors would force the model
to choose, which wastes turns and invites errors. Configure Serena (or the `implement`
skill's tool allowlist) so only its retrieval tools are in play.

Source: <https://github.com/oraios/serena>

**Short version: graphify maps, Serena locates, Claude Code edits.**

Other tools: **git** everywhere; **gh** for the code gate's PR mode; **domain-expert
agents** staff both panels. Each target repo wires the MCP tools it needs in its own
`.mcp.json` — shipyard stays generic.

## Roadmap

1. **Done** — `plan-readiness-review` (plan gate), `expert-panel-review` (code gate).
2. **Plugin shell** — manifest, README, this doc, the two gates hosted, git repo.
3. **Done** — `expert-advised-planning` (the `plan` stage). A lead drafts the plan after an
   expert panel advises, conflicts are arbitrated, and uncertain/high-stakes ones escalate to
   the human. It pins the plan format both gates and the implement stage depend on, carries its
   own plan-format guide (self-contained), and grounds advisers + arbiter in graphify. ← here.
4. **`implement` skill** (`test-driven-implementation`) — TDD execution; load project rules; use
   **Serena** to locate symbols/references and **Claude Code** to edit; run tests each task;
   hand off to the code gate.
5. **Enforcement** — make the gates non-skippable: a hook or CI check that the plan gate
   returned READY before implementation, and the code gate runs in the PR pipeline.
6. **Distribution** — the deterministic engines ship **inside** the plugin (`workflows/`). Each
   skill invokes the Workflow tool with `scriptPath: ${CLAUDE_PLUGIN_ROOT}/workflows/<skill>.js`,
   so the engine is read straight from the install location — no copy step, nothing written to
   `~/.claude/`. So the plugin is self-contained on install. Still pending: a shared git remote +
   `.claude-plugin/marketplace.json` so the team installs with `/plugin marketplace add <remote>`
   then `/plugin install shipyard`.

## Build order rationale

`plan` before `implement`: the plan is the contract everything downstream reads, so locking
its format first stabilizes the whole chain. With the plan format pinned and both gates in
place, `implement` is the last stage to build.
