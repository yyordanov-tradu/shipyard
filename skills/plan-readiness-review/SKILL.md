---
name: plan-readiness-review
description: Review a spec + implementation plan together, before any code is written, with a flat panel of expert subagents that argue to consensus. Returns a verdict (READY / NEEDS-WORK / MISALIGNED) and the gaps, grounded in the real codebase via graphify. Use when asked to check plan readiness, spec-plan alignment, or whether a plan is good enough to build from.
---

# Plan Readiness Review

Run a flat-panel review of a spec + plan as a local dynamic workflow, then save the report
under the project's `docs/reviews/`.

**Announce at start:** "Running the plan-readiness review."

## Step 1 — Resolve the spec and plan

`/plan-readiness-review [spec] [plan]`.

1. **Two explicit paths given** -> use them as `spec` and `plan`.
2. **No args** -> newest file in `docs/specs/` is the spec, newest in `docs/plans/` is the plan.
   If either is missing or there is more than one plausible match, ask the user — do not guess.

Read both files. If either is empty, tell the user and STOP.

## Step 2 — Gather the raw bundle

`proj="$(git rev-parse --show-toplevel 2>/dev/null)"` (empty if not a git repo).

- **Rules:** if `"$proj/.claude/plan-review-rules.md"` exists, use it; else concatenate
  `"$proj/CLAUDE.md"`, `"$proj"/.claude/rules/*.md`, `"$proj"/docs/rules/*.md` (cap ~8000 chars).
- **Architecture/design docs:** concatenate `"$proj"/docs/architecture/*.md`,
  any `*ADR*`/`docs/architecture/adrs/*`, and existing design/spec docs the plan references
  (cap ~8000 chars). Prefix each with `=== <path> ===`.
- **Project languages:** `git -C "$proj" ls-files | sed 's/.*\.//' | sort | uniq -c | sort -rn`
  -> take the extensions that map to a known language (py, ts, tsx, js, jsx, go, rs, java, rb).

## Step 3 — Refresh the code graph

If graphify is installed and `$proj` has code:
`graphify update "$proj"` (offline, incremental; builds the graph if none exists yet). If
graphify is absent, skip — the experts fall back to smart-explore/grep. Never block the
review on this.

## Step 4 — Run the workflow

Invoke the **Workflow** tool:

- `scriptPath`: `<home>/.claude/workflows/plan-readiness-review.js` (expand `<home>` with `echo "$HOME"`)
- `args`: a JSON object:
  ```json
  {
    "spec": "<full spec text>",
    "plan": "<full plan text>",
    "repoPath": "<$proj, or empty>",
    "rules": "<rules text>",
    "designDocs": "<architecture/design docs text>",
    "projectLangs": ["py", "ts"],
    "rosterOverride": null,
    "date": "<YYYY-MM-DD from `date -u +%F`>"
  }
  ```
  Set `rosterOverride` to an array of agent names only if the user named a roster (e.g.
  `/plan-readiness-review … security-auditor,python-pro`).

The workflow returns `{ report, verdict, consensus, matrix, panel, failedExperts }`. If `report`
is missing or empty, show the error and STOP — never write an empty review.

## Step 5 — Save and summarize

1. Slug: the plan filename without extension, non-alphanumerics -> `-`.
2. `mkdir -p "$proj/docs/reviews"` and write `report` to
   `"$proj/docs/reviews/<date>-<slug>-plan-readiness.md"`.
3. Print inline: the **verdict**, the panel that ran, agreed-gap counts by severity, any
   **failed experts**, the graph mode you used in Step 3 (graphify / fallback / no-code), and
   the saved path.
   If the verdict is not READY, remind the user the next step is to revise the plan and re-run
   until it is READY.

## Cost note

Each run spawns roughly: roster size (5–9) × 2 rounds + 1 synthesis. At most
`MAX_CONCURRENCY` (default 4, env `PRR_MAX_CONCURRENCY`) run at once, to stay under rate limits.
Tell the user this only if they ask about cost; otherwise just run.
