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
| `expert-panel-review` | judge the change (per-unit + cross-cutting reviewers), verify findings by evidence | merge or deploy |

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

## Tooling — see the bible

The full, authoritative tooling strategy lives in **[docs/tooling.md](tooling.md)** — the rules
there govern every skill, and any conflict resolves in its favor. The short version:

Understanding code happens at two zoom levels, each with exactly one owner, so an agent never
calls two tools for the same question:

| Zoom level | Owner | Used in |
|---|---|---|
| **Macro** — architecture, hubs, clusters, dependency paths, module-level blast radius | **graphify** | plan creation + both gates + the `implement` lead's stream analysis |
| **Micro** — exact definitions, all callers, types, diagnostics, symbol-level blast radius | **Serena** (LSP-backed) | `implement` per-task subagents (optional, for caller checks, in the code gate) |
| Change code (every edit) | **Claude Code** native `Edit`/`Write` | `implement` subagents |
| Raw text / unindexed files (fallback) | **ripgrep** | everywhere |

**Short version: graphify maps, Serena gives eyes, Claude Code edits.** graphify and
Serena both surface "blast radius," but at different zoom levels — macro vs symbol — and a
skill answers a given question with only one of them (see the bible's *Overlap resolution*).
Also in play: **context7** for grounding unfamiliar library APIs, **git** everywhere, **gh** for
the code gate's PR mode, and **domain-expert agents** staffing both panels. Tools are wired
per-project in the target repo's `.mcp.json`; shipyard stays generic and degrades to ripgrep
when a richer tool is absent.

## Roadmap

1. **Done** — `plan-readiness-review` (plan gate), `expert-panel-review` (code gate).
2. **Plugin shell** — manifest, README, this doc, the two gates hosted, git repo.
3. **Done** — `expert-advised-planning` (the `plan` stage). A lead drafts the plan after an
   expert panel advises, conflicts are arbitrated, and uncertain/high-stakes ones escalate to
   the human. It pins the plan format both gates and the implement stage depend on, carries its
   own plan-format guide (self-contained), and grounds advisers + arbiter in graphify. ← here.
4. **Done** — `test-driven-implementation` (the `implement` stage). TDD execution; load project rules; use
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
7. **Done** — **Scalable diff review.** The code gate no longer inlines the whole diff into
   every prompt. In **repo mode** (`repoPath` + `baseRef`) each agent reads only its files via
   `git diff`; in **inline mode** the engine slices the diff per file. So large/initial PRs
   review in one run instead of hitting the ~150 KB ceiling. See
   [docs/specs/2026-06-18-scalable-diff-review-design.md](specs/2026-06-18-scalable-diff-review-design.md).
8. **Done** — **Code gate redesign (change-unit).** A first-principles rebuild of the code gate:
   the lens panel + skeptic vote + LLM dedup/synthesis are replaced by a deterministic unit
   coverage map (one expert-matched reviewer per changed file) + a cross-cutting tier + classify-
   by-evidence verification (drop only on cited counter-evidence; Critical/High never silently
   dropped) + deterministic union/verdict/report. Stability is by construction (unit-tested), not
   a live eval. See
   [docs/specs/2026-06-22-code-gate-change-unit-design.md](specs/2026-06-22-code-gate-change-unit-design.md)
   and the paradigm comparison that chose it
   ([2026-06-22-code-gate-paradigm-comparison.md](specs/2026-06-22-code-gate-paradigm-comparison.md)).

## Build order rationale

`plan` before `implement`: the plan is the contract everything downstream reads, so locking
its format first stabilizes the whole chain. With the plan format pinned and both gates in
place, `implement` is the last stage to build.
