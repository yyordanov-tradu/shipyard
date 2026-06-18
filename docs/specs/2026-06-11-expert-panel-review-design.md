# expert-panel-review — Design Spec

- **Date:** 2026-06-11
- **Status:** approved
- **Kind:** global, reusable Claude Code skill + saved dynamic workflow

## Overview

A global Claude Code skill that reviews a code diff with a **panel of domain-expert
subagents**, verifies the significant findings with an **adversarial skeptic pass**,
and produces **one consolidated review grouped by expert**. It is the local,
roster-controllable counterpart to `/code-review ultra`: you choose the experts and
it runs on your machine.

## Goals

- **Multi-expert:** several domain experts review the same diff through their own
  lens, in parallel.
- **Deterministic verification:** significant findings are checked by independent
  skeptics before they reach you — false positives are dropped by **counted votes**,
  not judgment.
- **Reusable across projects:** nothing project-specific is baked in; project rules
  are read at runtime.
- **Scoped cost:** experts and verification only run where they add value.

## Non-goals (v1)

- Not a cloud service — runs locally as a dynamic workflow.
- Not a replacement for `/code-review` quick local modes; this is the heavy option.
- Does not auto-apply fixes (reports only).

## Trigger and inputs

Command: `/expert-panel-review [arg]`

- **No arg:** review the current branch's diff vs `main` (committed branch changes +
  uncommitted working tree).
- **`<PR number>`:** review that GitHub PR's diff (needs `gh` + a GitHub remote).
- **`<paths…>`:** review exactly those files/paths.
- **`<roster override>`:** comma-separated agent names to run instead of the
  auto-selected roster (e.g. `security-auditor,python-pro`).

Disambiguation: all-numeric → PR; existing paths → paths; known agent names → roster
override.

## Expert roster

**Always-on (5):**

| Expert | `agentType` | Lens |
|---|---|---|
| Backend | `backend-architect` | architecture & correctness |
| QA automation | `qa-automation-architect` | test coverage & test design |
| Performance | `performance-engineer` | performance hotspots |
| Security | `security-auditor` | security |
| Compliance | *(generic, rule-driven)* | violations of the project's own rules |

**Conditional (activated by what the diff touches):**

- `frontend-developer` — FE files (`*.tsx/.jsx/.vue/.svelte/.css/.scss/.html`, or
  `*.ts/.js` under `web|ui|frontend` dirs), **excluding** infra dirs (e.g. `*/cdk/*`).
- `database-optimizer` — DB files (`*.sql`, `migrations/`, `alembic/`, `prisma/`, ORM
  model files, `schema.*`).
- **Language experts — one `*-pro` per detected language:**
  `.py`→`python-pro`, `.ts/.tsx`→`typescript-pro`, `.js/.jsx`→`javascript-pro`,
  `.go`→`golang-pro`, `.rs`→`rust-pro`, `.java`→`java-pro`, `.rb`→`ruby-pro`
  (map configurable; unknown extension → no language expert).

Language detection is **independent** of FE detection: a change to `*/cdk/*.ts`
activates `typescript-pro` (it is TS code) but not `frontend-developer` (it is infra).

All selections are overridable via the roster-override arg.

## Compliance rules sourcing

The compliance lane is a **generic** reviewer fed the project's own rules. Sources, in
order:

1. `<project>/.claude/expert-review-rules.md` (if present)
2. else `<project>/CLAUDE.md` (hard constraints) + `<project>/docs/rules/*.md`

It flags any diff that violates those rules. Because the rules are read from the
current project at runtime, the same generic lane enforces each project's own
constraints — no per-project agent and nothing project-specific in the skill.

## Verification (skeptics)

- Severity scale: **Critical / High / Medium / Minor.**
- **Critical / High** → spawn **3 independent skeptics** in parallel, each told to
  **refute** the finding (default `refuted=true` if unsure). **Drop if ≥2 of 3
  refute.**
- **Medium / Minor** → skip skeptics; include in the report labeled *"unverified."*
- `SKEPTICS = 3` and the verify threshold (Critical/High) are constants in the script,
  adjustable.

## Output

- Write the full review to `<project>/docs/reviews/YYYY-MM-DD-<name>.md`, grouped by
  expert, with severity counts and a one-paragraph summary.
- Print a short summary inline in chat.

## Architecture

Two global artifacts, split by responsibility:

- `~/.claude/skills/expert-panel-review/SKILL.md` — **the launcher** (dynamic,
  environment-dependent): parse the arg, resolve the diff + changed-file list, detect
  the conditional experts, locate the project rules, run the workflow, then write the
  output file + inline summary.
- `~/.claude/workflows/expert-panel-review.js` — **the deterministic orchestration**:
  Phase 1 parallel experts → Phase 2 skeptic verify (pipeline) → Phase 3 synthesize.
  Receives `{ diff, roster, rules }` via `args`.

The skill does the I/O and selection; the workflow does the rigid control flow.

## Data flow

```
/expert-panel-review [arg]
  → skill resolves: diff text, changed-file list, active roster, project rules text
  → skill runs workflow (scriptPath) with args = { diff, roster, rules }
     Phase 1 (parallel): each expert reviews the diff (+rules for compliance) → FINDINGs
     Phase 2 (pipeline per expert): each Critical/High finding → 3 skeptics
              → keep if <2 refute; Medium and Minor pass through unverified
     Phase 3: synthesize surviving findings → one review grouped by expert
  → skill writes docs/reviews/<date>-<name>.md + prints inline summary
```

## Schemas

- **FINDING:** `{ expert, severity (Critical|High|Medium|Minor), file, line, title,
  detail, suggestion }`
- **VERDICT:** `{ refuted (bool), reason }`

## Error handling

- **No diff / empty** → "nothing to review," exit cleanly.
- **An expert errors** → its findings `= []` (filtered), noted in a "experts that
  failed" line; the review still completes.
- **Roster override names a missing agent** → warn and skip it.
- **PR mode without `gh`/remote** → clear error.
- **Very large diff** → v1 passes the whole diff; known limitation (future: chunk by
  file).

## Testing

Reviews are non-deterministic, so we do not assert exact text.

- **Smoke test:** run on a tiny diff that clearly violates a stated project rule.
  Expect: the compliance lane flags it (Critical/High) and it **survives the
  skeptics** (appears in the final review).
- **Wiring/validity:** the workflow script parses; `SKILL.md` frontmatter valid;
  schemas are valid JSON Schema.
- **Detection checks:** given a sample changed-file list, the conditional selector
  picks the right experts (`.py` + `.ts` → `python-pro` + `typescript-pro`; docs-only
  → no conditional experts).

## Cost

Agents per run ≈ roster size (5 + conditional) + 3 × (Critical/High findings) + 1
synthesis. Conditional gating + skipping Medium/Minor verification keep this scoped.
`SKEPTICS` and the verify threshold are tunable.

## File layout

```
~/.claude/skills/expert-panel-review/SKILL.md     # launcher
~/.claude/skills/expert-panel-review/DESIGN.md    # this spec
~/.claude/workflows/expert-panel-review.js        # deterministic workflow
<project>/.claude/expert-review-rules.md          # optional, per-project rules
<project>/docs/reviews/<date>-<name>.md           # output
```

## Future (out of scope for v1)

- `--fix` to apply suggestions.
- Post findings as PR comments.
- Diff chunking for very large changes.
- Per-invocation severity threshold.
