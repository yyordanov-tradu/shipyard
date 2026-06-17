---
name: expert-panel-review
description: Review a code diff with a panel of domain-expert subagents (backend, QA, performance, security, compliance + conditional frontend/database/language experts), verify Critical/High/Medium findings with 3 independent skeptics, and save one consolidated review grouped by expert. Use when asked for an expert panel review, a multi-expert review, or a deep local review of a diff, PR, or set of files.
---

# Expert Panel Review

Run a multi-expert review of a code diff as a local dynamic workflow, then save the
consolidated review under the project's `docs/reviews/`.

**Announce at start:** "Running the expert panel review."

## Step 1 — Parse the argument

The invocation is `/expert-panel-review [arg]`. Decide the mode, checking in THIS
order (first match wins):

1. **No arg** → review the current project's diff vs its main branch.
2. **All-numeric arg** (e.g. `142`) → review that GitHub PR (numeric wins even if
   a file with that name exists).
3. **Every comma-separated token names an existing file/dir** → review exactly
   those paths.
4. **Any token matches an available agent type** (one name or a comma-separated
   list, e.g. `security-auditor` or `security-auditor,python-pro`) → roster
   override: run ONLY those experts on the default diff. If a named agent does
   not exist in the available agent types, warn the user and continue without it.
5. **Nothing matches** → ask the user what they meant; do not guess.

## Step 2 — Resolve the diff and changed files

First confirm this is a git repository: if `git rev-parse --show-toplevel` fails,
tell the user "Not a git repository — nothing to diff." and STOP. Otherwise
`proj="$(git rev-parse --show-toplevel)"`.

Determine the base: try, in order, `refs/heads/main`, `refs/heads/master`,
`origin/main`, `origin/master` (verify each with
`git -C "$proj" rev-parse -q --verify <ref>`). If none resolves, ask the user
which branch to diff against. Then diff against the **merge-base**, not the
branch tip — otherwise upstream commits on the base would pollute the review:

- **Default mode:**
  ```bash
  mb="$(git -C "$proj" merge-base "$base" HEAD)"
  git -C "$proj" diff "$mb" > /tmp/epr-diff.txt
  for f in $(git -C "$proj" ls-files --others --exclude-standard); do
    git -C "$proj" diff --no-index -- /dev/null "$f" >> /tmp/epr-diff.txt || true
  done
  git -C "$proj" diff --name-only "$mb" > /tmp/epr-files.txt
  git -C "$proj" ls-files --others --exclude-standard >> /tmp/epr-files.txt
  ```
- **PR mode:** `gh pr diff <N> > /tmp/epr-diff.txt` and
  `gh pr diff <N> --name-only > /tmp/epr-files.txt`. If `gh` fails, tell the user:
  "PR mode needs the gh CLI and a GitHub remote" and stop. Then materialize the PR's
  code so experts can read the real files (not just the diff):
  ```bash
  # Materialize the PR's code so experts can read real files (not just the diff).
  prdir="$(mktemp -d)/epr-pr-<N>"
  git -C "$proj" fetch origin "pull/<N>/head"
  git -C "$proj" worktree add --detach "$prdir" FETCH_HEAD
  repoPath="$prdir"
  ```
  Do NOT use `gh pr checkout` — it mutates the user's working tree. The detached
  worktree leaves the working tree untouched.

  Then capture the PR's CI status (the panel reads code but does not run the build —
  GitHub already ran the tests, so read its result instead of guessing):
  ```bash
  gh pr checks <N> > /tmp/epr-ci.txt 2>/dev/null || true
  # For any FAILING check, append its failing job log tail so a red build is explained:
  #   gh run view <run-id> --log-failed 2>/dev/null | tail -c 6000 >> /tmp/epr-ci.txt
  ```
  This is `gh pr checks` raw output (tab-separated `name<TAB>state<TAB>elapsed<TAB>url`).
  A red build outranks every expert finding — the workflow forces REQUEST-CHANGES when
  any check state is fail/error/cancelled.
- **Paths mode:** same as default but append `-- <paths>` to both `git diff`
  commands, and list untracked files with
  `git -C "$proj" ls-files --others --exclude-standard -- <paths>`.

For **default and paths mode**, set `repoPath="$proj"` — the working tree already
contains the code being reviewed, so no worktree is needed. Leave `/tmp/epr-ci.txt`
empty in these modes: a local, unpushed diff has no CI run to read, and the workflow
treats empty `ciStatus` as "no CI line."

`repoPath` is the path experts use to open real files and run `mvn test-compile`;
that is what stops them from guessing about code they cannot see. Honest limitation:
in PR mode this gives the PR author's files as-is (the PR head), not a merge with the
base. A cross-PR merge-race compile break — one that only shows up when the branch
meets newly-landed main under CI — is still out of scope for this local panel.

If `/tmp/epr-diff.txt` is empty or whitespace: tell the user "Nothing to review —
the diff against `<base>` is empty." and STOP. Do not run the workflow.

### Pass the diff verbatim — never trim by hand

**Pass the diff exactly as resolved.** Never paraphrase, summarize, abbreviate file
paths, or hand-edit the diff before passing it to the workflow. The experts review
exactly what you pass — if you trim it, an expert that cannot see the code will
guess about it and emit false findings. The `diff` value in the args must be the
literal bytes of `/tmp/epr-diff.txt`.

**Auto-exclude only generated/vendored noise.** Drop files that are generated, not
authored — lockfiles, vendored/build output, generated code, and local planning
artifacts — because nobody reviews machine-written files, not to make the diff
smaller arbitrarily. Apply the SAME exclusions to BOTH the diff and the changed-files
list, using git pathspec excludes, never manual editing. For default and paths mode,
re-run the diff commands with `:(exclude)` pathspecs:

```bash
EXCLUDES=(
  ':(exclude)**/package-lock.json' ':(exclude)**/yarn.lock'
  ':(exclude)**/pnpm-lock.yaml' ':(exclude)**/*.lock'
  ':(exclude)**/Cargo.lock' ':(exclude)**/go.sum'
  ':(exclude)**/vendor/**' ':(exclude)**/dist/**'
  ':(exclude)**/build/**' ':(exclude)**/node_modules/**'
  ':(exclude)**/*.min.js' ':(exclude)**/*.min.css'
  ':(exclude)**/*.pb.go' ':(exclude)**/*_generated.*' ':(exclude)**/*.generated.*'
  ':(exclude)docs/superpowers/**'
)
git -C "$proj" diff "$mb" -- . "${EXCLUDES[@]}" > /tmp/epr-diff.txt
git -C "$proj" diff --name-only "$mb" -- . "${EXCLUDES[@]}" > /tmp/epr-files.txt
# (then re-append untracked files, applying the same -- . "${EXCLUDES[@]}" filter)
```

For **PR mode**, `gh pr diff` cannot take pathspecs. Apply the same exclusions by
filtering the file list (drop the excluded paths from `/tmp/epr-files.txt`) and, if
you need the diff itself cleaned, regenerate it with `git diff` against the PR range
using the `EXCLUDES` above. The simplest path: drop the excluded files from
`/tmp/epr-files.txt` and leave the diff whole.

**If still larger than ~150 KB after excludes** (`wc -c < /tmp/epr-diff.txt`): do NOT
hand-trim. Either split the review into multiple paths-mode runs over subsets of the
changed files, or tell the user the size and ask which paths to focus on. Per-expert
chunking of one huge diff is a future workflow capability — not available yet — so for
now narrowing is via paths mode only, never by editing the diff text.

## Step 3 — Source the project rules (for the compliance lane)

```bash
if [ -f "$proj/.claude/expert-review-rules.md" ]; then
  head -c 8000 "$proj/.claude/expert-review-rules.md" > /tmp/epr-rules.txt
else
  { cat "$proj/CLAUDE.md" 2>/dev/null; cat "$proj"/docs/rules/*.md 2>/dev/null; } \
    | head -c 8000 > /tmp/epr-rules.txt
fi
```
If the result is empty, the workflow simply skips the compliance lane — that is
expected for projects with no written rules.

### Collect the design docs (ADRs / specs)

Also build `/tmp/epr-designdocs.txt`: the full text of any ADR or design/spec doc the
change touches or references. Experts get this so they do not flag documented,
deliberate trade-offs as fresh gaps. Include:

- The full contents of any changed file (from `/tmp/epr-files.txt`) under
  `docs/architecture/adrs/`, or matching `*ADR*` / `*adr*`, or under `docs/**/specs/**`
  — these are the docs the PR itself adds or edits.
- Any ADR the diff or those docs reference by number (e.g. a mention of `ADR-019`):
  resolve `docs/architecture/adrs/ADR-019*.md` and include it if present.

Concatenate them with a short `=== <path> ===` header before each:

```bash
: > /tmp/epr-designdocs.txt
# 1) changed files that are ADRs/specs
grep -Ei 'docs/architecture/adrs/|adr|docs/.*/specs/' /tmp/epr-files.txt 2>/dev/null \
  | while read -r f; do
      [ -f "$proj/$f" ] || continue
      { echo "=== $f ==="; cat "$proj/$f"; echo; } >> /tmp/epr-designdocs.txt
    done
# 2) ADRs referenced by number in the diff or the collected docs
{ cat /tmp/epr-diff.txt; cat /tmp/epr-designdocs.txt; } \
  | grep -oiE 'ADR-[0-9]+' | tr 'a-z' 'A-Z' | sort -u \
  | while read -r adr; do
      for m in "$proj"/docs/architecture/adrs/${adr}*.md; do
        [ -f "$m" ] && ! grep -q "=== ${m#$proj/} ===" /tmp/epr-designdocs.txt \
          && { echo "=== ${m#$proj/} ==="; cat "$m"; echo; } >> /tmp/epr-designdocs.txt
      done
    done
```

If there are none, the file is empty — that is fine; the workflow treats empty
`designDocs` as "no rationale provided."

## Step 4 — Run the workflow

Read `/tmp/epr-diff.txt`, `/tmp/epr-files.txt`, `/tmp/epr-rules.txt`,
`/tmp/epr-designdocs.txt`, `/tmp/epr-ci.txt` (PR mode; empty otherwise), and get the
date with `date -u +%F`. Then invoke the **Workflow** tool:

- `scriptPath`: `${CLAUDE_PLUGIN_ROOT}/workflows/expert-panel-review.js`
- `args`: a JSON object:
  ```json
  {
    "diff": "<contents of /tmp/epr-diff.txt>",
    "changedFiles": ["<one entry per line of /tmp/epr-files.txt, deduplicated>"],
    "rosterOverride": null,
    "repoPath": "<the repoPath value: PR-mode worktree dir, else $proj>",
    "rules": "<contents of /tmp/epr-rules.txt>",
    "designDocs": "<contents of /tmp/epr-designdocs.txt>",
    "ciStatus": "<contents of /tmp/epr-ci.txt; empty string in default/paths mode>",
    "date": "<YYYY-MM-DD>"
  }
  ```
  In roster-override mode set `rosterOverride` to the array of agent names instead
  of null. `repoPath` is not read from a file — it is the value you set in Step 2
  (the PR-mode worktree directory, or `$proj` in default/paths mode).

The workflow returns `{ report, findings, ledger, failedExperts, panel, date, verdict }`.
`ledger` is the verification ledger (load-bearing claims marked verified /
unable-to-verify / refuted); it is already rendered into `report` as a `### Verified`
table, so you do not need to print it separately.
If it returns `{ error: "empty diff" }`, report that and stop. If `report` is
missing, null, or empty for ANY reason (workflow error, tool failure), show the
error to the user and STOP — never write an empty review file.

## Step 5 — Save and summarize

1. Build a slug: PR mode → `pr-<N>`; otherwise the current branch name
   (`git -C "$proj" branch --show-current`, non-alphanumerics replaced with `-`),
   or `working-tree` if empty.
2. `mkdir -p "$proj/docs/reviews"` and Write the `report` markdown to
   `"$proj/docs/reviews/<date>-<slug>.md"`.
3. Print inline: the workflow's `verdict` (APPROVE / APPROVE-WITH-NITS /
   REQUEST-CHANGES), the panel that ran, findings count by severity, any failed
   experts, the CI status (PR mode, if any check was captured), and the path of the
   saved review. If the verdict is REQUEST-CHANGES because CI is red (not because of a
   finding), say so plainly. (Skeptic-drop counts are not in the return value — skip
   them.)
4. **PR mode only** — remove the throwaway worktree (default and paths mode created
   none, so there is nothing to clean up):
   ```bash
   # PR mode only: remove the throwaway worktree.
   git -C "$proj" worktree remove --force "$prdir" 2>/dev/null || true
   ```
   Always run this in PR mode, whether or not the workflow succeeded — that way a
   failed run never leaks a worktree.

## Cost note

Each run spawns roughly: panel size (4–8) + 3 × (Critical/High/Medium findings) +
1 × (Minor findings) + 1 (dedup) + 1 (verification ledger) + 1 (synthesis) agents.
Critical/High/Medium each get 3 skeptics; Minor findings also cost 1 self-check agent
each; the verification ledger runs once per review (always, even with zero findings).
Tell the user this before running ONLY if they ask about cost; otherwise just run.
