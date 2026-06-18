# Scalable diff review for `expert-panel-review` — Design Note

- **Date:** 2026-06-18
- **Status:** proposed
- **Kind:** engine improvement to the `expert-panel-review` code gate

## The problem in one line

The code gate copies the **whole diff into every agent's prompt**, so review cost grows
with `diff size × number of agents`. Past a point the diff no longer fits, and the only
lever we have today is splitting the review by hand.

## Why this matters

Each run spawns roughly `panel (4–8) + 3 skeptics × (Critical/High/Medium findings) +
1 self-check × (Minor findings) + 1 dedup + 1 ledger + 1 synthesis` agents — easily 20–40.
The current engine puts the full diff text into:

- every **expert review** prompt (`reviewPrompt`, ends with `DIFF:\n${diff}`),
- every **skeptic** prompt (3 per Critical/High/Medium finding),
- every **Minor self-check** prompt,
- the **verification ledger** prompt.

So a 140 KB diff is not sent once — it is sent ~30 times. The skill guards against the
blow-up with a **~150 KB ceiling** and tells the operator to split large diffs into
multiple paths-mode runs. The skill text itself notes that *"per-expert chunking of one
huge diff is a future workflow capability — not available yet."* This note is the design
for that capability.

### When it bites

- **Not** normal incremental PRs — a diff only contains what changed, so a typical PR is
  5–50 KB and runs in one pass regardless of how big the repo is.
- It bites on: an initial import / whole-subsystem PR (e.g. shipyard's own first PR, 262 KB),
  a large refactor, a framework migration, a mass rename, or generated/vendored files
  landing in one PR.

## What the engine already does right

Two of the three context channels already scale by reading on demand, not by inlining:

- `designDocs` — only the ADRs/specs the change **touches or references** are passed (in
  full), not every doc in the repo.
- `repoPath` — the checked-out repo is handed to every expert, and the prompt says *"open
  any file there (Read/Grep)... do not raise a finding about code you cannot see."* Plus
  graphify for the macro view.

So unchanged content is already read on demand. The one thing that does **not** scale is the
**changed** content: the diff is the must-review material, so it is embedded explicitly — and
embedded in full, in every prompt.

## Goal

Make a single review run cost scale with **what each expert must actually read for its lane**,
not with the total diff × every agent. Concretely: a 262 KB-style PR should run in one
invocation, with each agent's prompt bounded by the slice relevant to it.

## Approach

The core move: **stop inlining the whole diff. Slice it.** Two layers.

### 1. Per-file diff slices instead of one blob

Split the diff into per-file hunks once, in the launcher (it already has the file list).
Pass the engine a map of `path → that file's diff hunk` plus the `changedFiles` list, instead
of one `diff` string.

- **Expert review:** give each expert the **changed-file list** + the per-file hunks for the
  files in scope for its lane, not the entire diff. A frontend expert gets the `.tsx`/`.css`
  hunks; a DB expert gets the migration/schema hunks; the always-on architecture/QA/security/
  perf experts get the full set of hunks (their lane is the whole change) but still as discrete
  slices so the engine can cap or chunk them.
- **Skeptics and self-checks:** a finding already names its `file` and `line`. Pass that
  finding plus **only that file's hunk** (and `repoPath` to widen if needed) — not the whole
  diff. A skeptic verifying one finding never needs all 43 files.
- **Ledger:** pass the changed-file list + per-file hunks; it already reasons file-by-file
  (migrations, contracts, auth, fallbacks).

This keeps the exact bytes under review (no guessing, no soft "may read") while bounding each
prompt to the slice it needs. It is the same principle `designDocs` already uses — pass the
relevant subset, not everything.

### 2. Read-from-repo as the widen path, not the primary channel

Keep `repoPath` as it is, but make its role explicit: the per-file hunk is what an agent
**must** review; `repoPath` is how it **widens** (callers, related files, cross-file
interactions). This preserves determinism — the must-review material is always passed
explicitly — while letting an expert pull broader context when a finding needs it.

### 3. Optional: chunk very large single files

A single 50 KB changed file still produces a 50 KB hunk. If one file's hunk exceeds a
per-prompt budget, chunk it by hunk-group and run the lane over the chunks, then merge that
lane's findings. This is the rarer tail; layers 1–2 handle the common case.

## Fallback (degrade, announce, never block)

If `repoPath` is absent (no checked-out repo — possible in some invocation paths), fall back
to the **current behavior**: inline the full diff. Announce it in the report (e.g. "no repo
path — reviewed from inline diff only; widen-reads unavailable"). This keeps the engine
working everywhere shipyard runs, per the project's "degrade, announce, never block" rule.

## Why not just raise the ceiling

Raising the number does not remove the `diff × agents` multiplication — it just lets the run
get more expensive before it breaks. Slicing removes the multiplication: each agent reads its
slice, so total tokens scale with the change, not with (change × panel size).

## Trade-offs and risks

- **Cross-file findings.** An expert scoped to its lane's files could miss an interaction with
  a file outside its lane. *Mitigation:* every expert always gets the full `changedFiles` list
  and `repoPath`, so it can open any other changed file; only the always-inlined hunks are
  scoped.
- **Soft reads.** "May open files" depends on the model choosing to. *Mitigation:* the
  must-review hunks are still passed explicitly — reads are only for *widening*, never for the
  primary material. This is strictly better than today, where widening relies on the same soft
  read but the primary material happens to be inlined.
- **Lane→file routing.** Deciding which hunks are "in scope" for which lane is a heuristic
  (extension/path based, the same signals `detectConditional` already uses). Getting it wrong
  under-scopes an expert. *Mitigation:* default the four always-on experts to the full hunk
  set; only the conditional/file-type experts get a narrowed set.

## Scope

- **In:** how the engine packages and passes changed content to its agents; the launcher's
  per-file slicing; the fallback.
- **Out:** the skill's external contract (PR/paths/roster modes stay the same), graphify usage,
  the verdict rules, the skeptic/ledger logic itself. The same plan-readiness-review concern
  exists (it inlines spec+plan) but is smaller and out of scope here.

## Acceptance criteria

1. A 262 KB-style PR (this repo's first PR) runs in **one** invocation, no manual paths split.
2. No single agent prompt contains the entire diff (verified in the dry-run harness: assert
   prompts carry scoped slices, not the full blob).
3. With `repoPath` absent, the engine still runs by inlining the diff and says so in the report.
4. Findings quality on a normal small PR is unchanged (same experts, same hunks they would have
   seen anyway).

## Rough effort

A contained refactor of `workflows/expert-panel-review.js` (prompt builders + the launcher's
input prep), plus harness tests asserting prompt scoping. The external interface stays the
same or gains one additive arg (`fileHunks`), so the skill prose changes little.
