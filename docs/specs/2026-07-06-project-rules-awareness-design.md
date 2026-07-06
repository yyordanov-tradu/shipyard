---
name: project-rules-awareness
status: draft
created: 2026-07-06T00:00:00Z
updated: 2026-07-06T00:00:00Z
---

# Project rules awareness (per-repo conventions)

## The point

Every target repo differs by stack — Java, Python, Node, Go. Each repo keeps its own coding
conventions in `.claude/rules/*.md`. shipyard's build and review stages must **read those rules
and honour them**, so the code we write and the code we judge follow the same, repo-specific
standard.

Today they don't:
- `test-driven-implementation` (the build stage) is convention-blind. Subagents locate, edit, and
  verify with no knowledge of the repo's stack conventions.
- `expert-panel-review` (the code gate) *does* source rules, but from the wrong places
  (`.claude/expert-review-rules.md`, else `CLAUDE.md` + `docs/rules/*.md`) — not `.claude/rules/`.

This change makes `.claude/rules/` the one canonical convention location and wires both stages to it.

## Canonical location and selection

- **Location:** `.claude/rules/*.md` inside the **target repo** (checked into that repo, travels
  with the code). shipyard ships nothing here — this fits the "ship nothing, wire per-repo"
  principle. A Python repo's rules dir holds Python rules; a Node repo's holds Node rules, so
  "the right conventions" falls out for free.
- **Selection:** load **all** `.md` files in the dir, **and** detect the stack from project
  structure to attach as a one-line orientation hint ("this is a Node repo"). No per-file
  filtering — the dir is already stack-scoped.

## Architecture — one shared, deterministic helper

A single new helper does discovery so both stages behave identically and it is unit-testable.

**`lib/collect-rules.mjs`** (new, at plugin root — mirrors the existing root `workflows/` shared
dir). Plain ESM, zero deps, Node ≥18. Exposes a function and a CLI:

```
collectRules(repoRoot) -> { stack: string[], rules: [{ name, content }] }
```

1. **Rules:** read every `*.md` under `<repoRoot>/.claude/rules/` (sorted by name for
   determinism). Each entry is `{ name: <basename>, content: <file text> }`.
2. **Stack:** probe `<repoRoot>` for marker files and return matching labels:
   - `package.json` → `node`
   - `pom.xml` / `build.gradle` / `build.gradle.kts` → `java`
   - `pyproject.toml` / `requirements.txt` / `setup.py` → `python`
   - `go.mod` → `go`
   - `Cargo.toml` → `rust`
   - `*.csproj` / `*.sln` → `dotnet`
   - `Gemfile` → `ruby`
   - `composer.json` → `php`

   Multiple can match (a repo with both `package.json` and `pyproject.toml` → `["node","python"]`).
   None match → `[]`.
3. **CLI form:** `node lib/collect-rules.mjs <repoRoot>` prints the JSON to stdout, so a bash
   launcher can capture it without re-implementing the logic.

### Data flow

The **lead** in each stage calls the helper **once** at start, before any task or review runs.
The result — full rule texts plus the stack hint — becomes a **context block** handed down to
each subagent / reviewer.

### Error handling — degrade, never block

- No `.claude/rules/` dir, or empty → `{ stack, rules: [] }`. The stage prints
  *"No project rules found — using stack defaults"* and behaves exactly as it does today. This is
  what keeps the change backward-compatible: absence = current behaviour.
- A file unreadable → skip it, note it, continue. Never abort a build or a review over a rules read.

## Wiring — `test-driven-implementation` (build stage)

- **Step 2 (lead):** after stream analysis, run `collect-rules.mjs` on the repo root once. Print a
  one-line summary (`stack: node · 3 rule file(s)` or `no project rules found`) so the execution
  shape includes conventions before any code is written.
- **Step 3 (subagent contract):** inject the collected rules + stack hint into every task
  subagent's prompt, alongside its task block and graphify slice, as **binding conventions to
  follow** while it writes code.
- **Step 4 (light gate):** extend the existing between-task sanity check. Today it checks the diff
  against the task's intent; add: a diff that **plainly violates a stated convention** is a failure
  → retry, then escalate. Deliberately light — parse nothing, just catch blatant breaks. Deep
  compliance is the code gate's job (below).

## Wiring — `expert-panel-review` (code gate)

- **Step 3 (source the project rules):** replace the current ad-hoc chain with the shared helper.
  New precedence: if `.claude/rules/*.md` exists, use it (via `collect-rules.mjs`). Otherwise fall
  back to the **existing** chain (`.claude/expert-review-rules.md`, else `CLAUDE.md` +
  `docs/rules/*.md`) so repos already using the old layout keep working. Also pass the stack hint.
- The compliance lane already exists and consumes the `rules` arg — feeding it `.claude/rules/`
  content plus the stack hint means a convention violation the build stage's light gate missed
  becomes a proper code-gate finding. This is the intended safety net.

## Scope (explicitly out)

- `expert-advised-planning` stays as-is — plans rarely need file-level conventions, and adding it
  now is the biggest change for the least value. Can follow later.
- No hard/deterministic compliance gate. Arbitrary prose rules ("prefer composition") can't be
  machine-checked reliably; enforcement is "inject + light gate" in build and "reviewer finding"
  in the code gate.
- No change to any inter-stage artifact (plan format, verdict contract, workflow arg *shapes*).
  The code gate's `rules` arg already exists; we only change how it's populated.

## Testing

- **`lib/tests/test-collect-rules.mjs`** (new), standalone `.mjs` with `node:assert/strict`,
  prints `collect-rules: PASS`. Cases:
  - rules dir with several `.md` → all returned, sorted, content intact;
  - missing `.claude/rules/` → `{ rules: [] }`, no throw;
  - empty dir → `{ rules: [] }`;
  - stack detection per marker (node, java, python, go, rust, dotnet, ruby, php);
  - multiple markers → multiple labels;
  - no markers → `[]`;
  - an unreadable file is skipped, others still returned.
- **Suite runner update:** the documented suite glob (`for t in skills/*/tests/test-*.mjs`) does
  not cover a root `lib/tests/`. Update it to
  `for t in skills/*/tests/test-*.mjs lib/tests/test-*.mjs` in `CLAUDE.md` (and anywhere else the
  command is scripted).

## Versioning

**MINOR** bump (new backward-compatible capability; no interface break; absence of rules = current
behaviour). Bump `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` together
(1.1.0 → 1.2.0).
