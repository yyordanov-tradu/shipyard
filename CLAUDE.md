# CLAUDE.md — shipyard

shipyard is a **Claude Code plugin**: a gated AI-SDLC pipeline where each stage is a skill.
This file is the project orientation. Deeper detail lives in [docs/flow.md](docs/flow.md)
(design + roadmap) and [docs/tooling.md](docs/tooling.md) (the tooling bible). When this file
points at one of those, that doc is the authority.

## The pipeline

```
Jira ticket → plan → [PLAN GATE] → implement → [CODE GATE]
              expert-advised-   plan-readiness-   test-driven-   expert-panel-
              planning          review            implementation review
```

Work enters as a **Jira ticket** — there is no spec-authoring stage. The two `-review` skills
are gates (they judge); the others are generative stages (they build).

## Stack rules

- **Plain JavaScript ESM (`.mjs`/`.js`), Node ≥18, zero npm dependencies, no TypeScript.**
- Tests are standalone `.mjs` files using `node:assert/strict`, run directly with `node` — no
  test framework. Each prints `<name>: PASS` on success.
- Run the whole suite: `for t in skills/*/tests/test-*.mjs lib/tests/test-*.mjs; do node "$t" || break; done`

## Versioning (binding)

**Every PR bumps the version.** The plugin ships from a local-directory marketplace, and
`claude plugin update` only re-copies when the version **changes** — an unbumped version makes the
update silently no-op, so your change never reaches the running plugin. A PR that forgets the bump
is not done.

Bump **`.claude-plugin/plugin.json`** and keep **`.claude-plugin/marketplace.json`**
(`metadata.version`) in sync — the two must always match. Size the bump by blast radius (semver):

- **MAJOR** (`x.0.0`) — a breaking change to an inter-stage **interface/artifact** (plan format,
  verdict contract, workflow args) or removing/renaming a skill. Anything that breaks how stages
  interoperate or how the plugin is invoked.
- **MINOR** (`0.x.0`) — a new skill/stage, a new capability, or a backward-compatible feature
  (e.g. a new optional arg).
- **PATCH** (`0.0.x`) — bug fixes, prompt tweaks, refactors, docs, and tests with no interface change.

After merge: `claude plugin update shipyard@shipyard-local` + restart Claude Code to load it.

## How a stage is built (the conventions)

Each stage is a folder `skills/<name>/` containing:
- `SKILL.md` — the launcher (frontmatter `name:` + `description:`, then the operator prose).
- an **engine**: either a `workflows/<name>.js` Workflow-tool engine (the fan-out review/plan
  skills) **or** a plain `lib/*.mjs` of deterministic helpers (the implement skill). Pick the
  fit, not the symmetry — they need not match.
- `tests/` — `.mjs` unit tests for the deterministic logic.

The skill's design spec and implementation plan are **not** kept in the skill folder. They live
once, canonically, in `docs/specs/<date>-<name>-design.md` and `docs/plans/<date>-<name>.md` —
one source of truth, no copies to drift.

Skills read their engine via `${CLAUDE_PLUGIN_ROOT}/workflows/<name>.js` (or `…/lib/…`) — read
straight from the install location, no copy step, nothing written to `~/.claude/`.

## Tooling ownership (binding — see docs/tooling.md)

Understanding code happens at two zoom levels, **one owner each, never both for one question**:
- **Macro** (architecture, where a change fits, module-level blast radius) → **graphify**.
- **Micro** (exact defs, all callers, types, diagnostics) → **Serena**.
- Edits → **Claude Code** native `Edit`/`Write` (the single editor). Fallback → **ripgrep**.

In `implement` the lead uses graphify (stream analysis); per-task subagents get Serena but
**not** graphify. Read `docs/tooling.md` before touching any skill's tool usage.

## Project principles

- **Self-contained / generic.** shipyard ships **no** MCP tools or per-project config; those
  are wired in each *target* repo's `.mcp.json`. Don't add dependencies on a specific repo's
  setup or on personal global conventions (e.g. "Native Teams") — they won't exist in other
  installs.
- **Own the interfaces, borrow the engines.** Stages may reuse proven approaches (superpowers)
  but emit shipyard's own artifact formats and run with those engines absent.
- Specs live in `docs/specs/`, plans in `docs/plans/`, review reports in `docs/reviews/`
  (gitignored).

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
