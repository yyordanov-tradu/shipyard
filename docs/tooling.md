# shipyard — tooling bible

**This is the authoritative tooling reference for the whole plugin.** When any skill needs to
understand code, locate a symbol, edit, or verify a change, it follows the rules here. Every
other doc (`flow.md`, the skills) defers to this one. If another doc and this doc disagree,
**this doc wins.**

The goal of this doc is one thing above all: **no ambiguity.** For any question an agent asks
about the code, exactly one tool owns the answer. An agent must never call two understanding
tools for the same question and then try to reconcile their answers — they work at different
resolutions and are not meant to be cross-checked against each other.

---

## The core principle: two zoom levels of "understanding code"

Understanding a codebase happens at two distinct zoom levels. Each has exactly one owner.

- **Macro — architecture.** Hubs, clusters, where a change fits, module-level ripple,
  dependency paths. Owner: **graphify**. It is a knowledge graph (Tree-sitter + community
  detection) and can also ingest docs/diagrams. It is approximate by design — it answers in
  clusters and paths, not exact callers.
- **Micro — symbols.** Exact definition, *all* callers, call hierarchy, types, diagnostics,
  and the precise tests a change breaks. Owner: **agent-lsp** (language-server-backed). It is
  compiler-grade and exact, but blind to architecture and docs.

They are not duplicates. They are different lenses. "Blast radius" exists at *both* zoom
levels and that is the trap to avoid — see [Overlap resolution](#overlap-resolution).

---

## The tools and their roles

| Tool | Use it for | Do NOT use it for |
|---|---|---|
| **graphify** | Macro understanding: architecture, hubs, clusters, cross-module connections, dependency paths, module-level blast radius. Grounding planners and reviewers in the real structure. | Exact symbol lookups, finding all callers, types, diagnostics. Editing. |
| **agent-lsp** | Micro understanding: go-to-definition, find-all-references, call hierarchy, types, diagnostics, symbol-level blast radius. | Architecture / "where does this fit" questions. Editing (it *can* edit; we never use that). |
| **Claude Code** native `Edit`/`Write` | Every code change. The single editor. | Searching/understanding — use the tools above. |
| **ripgrep** | Raw text: literal strings, log lines, comments, config values, any unindexed file. The fallback when no language server exists. | Symbol references or architecture — that is what the two owners above are for. |
| **context7** (MCP) | Grounding an unfamiliar or low-use library API in current docs before calling it. | General code search; anything about *this* repo's own code. |
| **git** / **gh** | Repo, branch, diff, and PR operations. `gh` for the code gate's PR mode. | — |
| **project verify commands** (typecheck → lint → tests) | Proving a change is correct. Discovered from the target repo (`CLAUDE.md`, `package.json`, `pyproject.toml`, …). | — |

---

## The routing rule (read this before calling any tool)

Classify the question by its zoom level **first**, then call **only** that one owner:

| The question you are answering | Owner | Never call for this |
|---|---|---|
| How is the system organized? Where does this change fit? What clusters/hubs/paths does it touch? (macro impact) | **graphify** | agent-lsp, ripgrep |
| Where exactly is this symbol defined? Who are all its callers? What breaks if I change it? What are its types/diagnostics? (micro impact) | **agent-lsp** | graphify |
| Find a literal string / log line / comment / config value / unindexed text | **ripgrep** | — |
| What is the correct signature/usage of this third-party API? | **context7** | (don't guess from memory) |
| Change code | **Claude Code** `Edit`/`Write` | graphify/agent-lsp edit features |
| Repo / branch / diff / PR operations | **git** / **gh** | — |
| Does the change pass? | project **typecheck → lint → tests** | — |

**Hard rule:** if you find yourself wanting *both* graphify and agent-lsp for the same
question, you have mis-classified it. Macro → graphify. Micro → agent-lsp. Pick one by zoom
level and call only that one. The owner's answer is authoritative; the other tool is not a
second opinion.

---

## Ownership by skill

Each skill has one **primary** understanding tool, set by the zoom level its job needs.

| Skill (phase) | Primary understanding | Secondary (use-if-present) | Edits | Fallback |
|---|---|---|---|---|
| **expert-advised-planning** (plan) | **graphify** (macro) | — | — | ripgrep |
| **plan-readiness-review** (plan gate) | **graphify** (macro) | — | — | ripgrep |
| **implement** (`test-driven-implementation`) | **agent-lsp** (micro) + graphify map *carried* from the plan for macro context | context7 (unfamiliar APIs) | **Claude Code** | ripgrep |
| **expert-panel-review** (code gate) | **graphify** (macro, grounds the experts) | **agent-lsp** for exact "are all callers of this changed symbol updated?" checks | — | ripgrep |

Notes:
- **graphify is primary in 3 of 4 skills** (plan + both gates) because planning and judging are
  architectural questions.
- **agent-lsp is primary only in implement**, where a safe edit needs exact references, types,
  diagnostics, and symbol-level blast radius.
- In the **code gate**, agent-lsp is **secondary and optional**, and it is only ever called for a
  *different* question than graphify (exact caller checks during verification), never the same
  architecture question. graphify stays primary there.

---

## Overlap resolution

graphify and agent-lsp both surface "blast radius," and that is the one place ambiguity could
creep in. It is resolved by zoom level **and** by phase:

- **Macro blast radius** ("touching the auth hub ripples into these clusters") → **graphify**,
  used while *reasoning about* the plan or architecture (plan, both gates).
- **Micro blast radius** ("changing this signature breaks these 7 callers — run these tests")
  → **agent-lsp**, used while *making or verifying* an actual edit (implement; optionally the
  code gate).

A skill answers a given blast-radius question with **one** of them, chosen by whether it is
reasoning about structure (macro) or touching code (micro). They are never run against the
same question for comparison.

---

## When a tool is absent

shipyard stays generic; tools are wired per-project (the target repo's `.mcp.json` and its
build/test config), never bundled in shipyard. So a tool may be missing. The rule:

- **Degrade, announce, never block.** If the primary understanding tool is absent, fall back
  to ripgrep (and reading), and say so in the skill's output (e.g. "graphify not installed —
  used grep fallback"). Never silently pretend the richer tool ran.
- The **verify gate** runs whatever of typecheck/lint/tests the project actually has, in that
  order, and reports which steps it skipped. At minimum it runs the tests.
- A required tool that is genuinely needed for a mode (e.g. `gh` for the code gate's PR mode)
  fails loudly with a clear message — it does not guess.

---

## Per-project wiring

graphify, agent-lsp, and context7 are configured in each *target* repo's `.mcp.json`, and the
verify commands come from that repo's own config. shipyard ships none of them. This keeps the
plugin generic and lets each project bring the language servers and rules it needs.
