---
name: expert-advised-planning
description: Create an executable implementation plan from a spec or a Jira ticket. A lead drafts the plan after an expert panel advises on the approach; conflicts are arbitrated and escalated to you only when uncertain or high-stakes. Use when asked to write a plan, turn a spec/ticket into a build plan, or plan a feature with expert input.
---

# Expert-Advised Planning

Create a plan as a local dynamic workflow: a lead consults an expert panel, resolves
disagreements, then writes the plan to the project's `docs/plans/`.

**Announce at start:** "Running expert-advised planning."

## Step 1 — Resolve the source

`/expert-advised-planning [source] [--add a,b] [--roster a,b]`.

1. A spec path or Jira key given -> use it.
2. No args -> newest file in `docs/specs/`; missing/ambiguous -> ask, do not guess.
3. Jira key (`^[A-Z]+-\d+$`) -> fetch the ticket and assemble body + acceptance criteria +
   comments + parent/linked issues into one text block.

Read the source. If empty, tell the user and STOP. Record `sourceRef` (path or key).

## Step 2 — Gather the raw bundle

`proj="$(git rev-parse --show-toplevel 2>/dev/null)"`.

- Rules: `"$proj/.claude/plan-review-rules.md"` if present, else `CLAUDE.md` +
  `.claude/rules/*.md` + `docs/rules/*.md` (cap ~8000 chars).
- Design docs: `docs/architecture/*.md`, ADRs, referenced specs (cap ~8000), each prefixed
  `=== <path> ===`.
- Languages: `git -C "$proj" ls-files | sed 's/.*\.//' | sort | uniq -c | sort -rn` -> the
  extensions mapping to a known language.

## Step 3 — Refresh the code graph

If graphify is installed and `$proj` has code: `graphify update "$proj"`. Else fall back to
smart-explore/grep. Record `graphMode` (`graphify` / `fallback` / `no-code`).

## Step 4 — Offer add-on experts (optional)

List available add-on experts; collect any picks as `extraExperts`. Skip if none.

## Step 5 — Run the workflow

Invoke the **Workflow** tool:

- `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/expert-advised-planning.js`
- `args`:
  ```json
  {
    "source": "<full source text>", "sourceRef": "<path or key>", "repoPath": "<$proj or empty>",
    "rules": "<rules text>", "designDocs": "<design docs>", "projectLangs": ["ts"],
    "extraExperts": [], "rosterOverride": null, "graphMode": "graphify", "date": "<YYYY-MM-DD>"
  }
  ```
  Drop any `--add`/`--roster` agent that does not exist (warn the user).

## Step 6 — Human gate (only if escalated)

If the workflow returns `{ phase: "awaiting-human", escalations, carry }`, present each
escalation (both positions + the arbiter's lean) and collect one decision per conflict. Then
**re-invoke the Workflow** with args `{ "mode": "draft", "carry": <the returned carry>,
"humanDecisions": [{ "conflictId": "...", "resolution": "...", "note": "..." }], ...same setup }`.
This is a plain second call (no `resumeFromRunId`): the `mode: "draft"` guard skips phases 1-3
and only DRAFT runs. If the user cancels, STOP and write nothing.

## Step 7 — Save and summarize

The workflow returns `{ plan, resolved, escalations, panel, failedExperts }`. If `plan` is
missing/empty, show the error and STOP — never write an empty plan.

1. Slug: a short kebab-case name from the source title.
2. `mkdir -p "$proj/docs/plans"` and write `plan` to `"$proj/docs/plans/<date>-<slug>.md"`.
3. **Round-trip check** (the plan is machine-read downstream):
   `node "${CLAUDE_PLUGIN_ROOT}/skills/test-driven-implementation/lib/plan-parse.mjs" "<plan-path>"`.
   If it reports **0 tasks**, warn loudly: the plan misses the task grammar (`### Task N: <title>`
   headings, a `**Files:**` block with backticked paths, "depends on Task N") and the readiness
   gate will return NEEDS-WORK until it is fixed. Otherwise print the parsed task count.
4. Print: the panel, conflicts (auto-resolved vs escalated), graph mode, any failed advisers,
   the path.
5. Remind the user the next step is the **plan-readiness-review** gate.

## Cost note

~ 1 frame + roster advisers + 1 reconciler + one arbiter per conflict + 1 draft, at most
`MAX_CONCURRENCY` (default 4, override via the `maxConcurrency` arg) at once. The draft-mode
second call adds only the single DRAFT agent.
