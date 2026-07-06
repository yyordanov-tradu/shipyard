# Project Rules Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make shipyard's build stage and code gate read a target repo's `.claude/rules/*.md` conventions and honour them, with one shared, unit-tested discovery helper.

**Architecture:** A new plugin-root helper `lib/collect-rules.mjs` reads `.claude/rules/*.md` and detects the repo's stack from marker files. `test-driven-implementation` (build) injects the result into each task subagent and adds a light convention check between tasks; `expert-panel-review` (code gate) sources rules through the same helper, keeping its old fallbacks. Absence of a rules dir = today's behaviour.

**Tech Stack:** Plain JavaScript ESM (`.mjs`), Node ≥18, zero npm dependencies, no TypeScript. Standalone `node:assert/strict` tests run directly with `node`.

## Global Constraints

- **Language:** Plain JS ESM (`.mjs`/`.js`), Node ≥18, **zero npm dependencies**, no TypeScript.
- **Tests:** standalone `.mjs` using `node:assert/strict`, run directly with `node`; each prints `<name>: PASS` on success. No test framework.
- **Whole-suite run (after the Task 1 glob update):** `for t in skills/*/tests/test-*.mjs lib/tests/test-*.mjs; do node "$t" || break; done`
- **Rules location (canonical):** `<repoRoot>/.claude/rules/*.md` in the **target** repo. shipyard ships none.
- **Degrade, never block:** missing/empty rules dir → empty rule set + current behaviour; an unreadable rule file is skipped, not fatal.
- **Versioning:** every PR bumps the version. This change is **MINOR**: bump `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` **together**, `1.0.0 → 1.1.0`. (If PR #4 / ci-coverage-audit lands first at 1.1.0, rebase and use `1.2.0`.)
- **Helper API (defined in Task 1, consumed by Tasks 2–3):**
  `collectRules(repoRoot) -> { stack: string[], rules: Array<{ name: string, content: string }> }`
  and CLI `node lib/collect-rules.mjs <repoRoot>` printing that object as JSON to stdout.

---

## File Structure

- `lib/collect-rules.mjs` — **new.** The discovery helper: `collectRules()` + `detectStack()`, plus a CLI entry. One responsibility: turn a repo root into `{ stack, rules }`.
- `lib/tests/test-collect-rules.mjs` — **new.** Unit tests for the helper.
- `CLAUDE.md` — **modify.** Update the documented whole-suite run glob to include `lib/tests/`.
- `skills/test-driven-implementation/SKILL.md` — **modify.** Steps 2, 3, 4: collect rules once, inject into subagents, light convention check.
- `skills/expert-panel-review/SKILL.md` — **modify.** Step 3: source rules through the helper, keep old fallbacks; pass the stack hint.
- `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — **modify.** MINOR version bump.

---

### Task 1: `collect-rules.mjs` helper + tests

**Files:**
- Create: `lib/collect-rules.mjs`
- Test: `lib/tests/test-collect-rules.mjs`
- Modify: `CLAUDE.md` (whole-suite run glob)

**Interfaces:**
- Consumes: nothing (leaf helper; `node:fs`, `node:path`, `node:url` only).
- Produces:
  - `collectRules(repoRoot: string) -> { stack: string[], rules: Array<{ name: string, content: string }> }`
  - `detectStack(repoRoot: string) -> string[]` (sorted, unique)
  - CLI: `node lib/collect-rules.mjs <repoRoot>` → prints `JSON.stringify({stack, rules})` to stdout, exit 0.

- [ ] **Step 1: Write the failing test**

Create `lib/tests/test-collect-rules.mjs`:

```javascript
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectRules, detectStack } from '../collect-rules.mjs';

function tmpRepo() {
  return mkdtempSync(join(tmpdir(), 'shipyard-rules-'));
}
function writeRules(root, files) {
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, '.claude', 'rules', name), body);
  }
}

// 1. Missing .claude/rules -> empty rules, no throw
{
  const root = tmpRepo();
  const out = collectRules(root);
  assert.deepEqual(out.rules, [], 'no rules dir -> empty rules');
  assert.ok(Array.isArray(out.stack), 'stack is always an array');
  rmSync(root, { recursive: true, force: true });
}

// 2. Empty rules dir -> empty rules
{
  const root = tmpRepo();
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
  assert.deepEqual(collectRules(root).rules, [], 'empty dir -> empty rules');
  rmSync(root, { recursive: true, force: true });
}

// 3. Several .md files -> all returned, sorted by name, content intact; non-.md ignored
{
  const root = tmpRepo();
  writeRules(root, {
    'z-style.md': 'z body',
    'a-naming.md': 'a body',
    'notes.txt': 'ignored',
  });
  const rules = collectRules(root).rules;
  assert.deepEqual(rules.map(r => r.name), ['a-naming.md', 'z-style.md'], 'sorted, .md only');
  assert.equal(rules[0].content, 'a body', 'content intact');
  assert.equal(rules[1].content, 'z body', 'content intact');
  rmSync(root, { recursive: true, force: true });
}

// 4. Stack detection per marker
{
  const cases = [
    ['package.json', 'node'],
    ['pom.xml', 'java'],
    ['build.gradle', 'java'],
    ['build.gradle.kts', 'java'],
    ['pyproject.toml', 'python'],
    ['requirements.txt', 'python'],
    ['setup.py', 'python'],
    ['go.mod', 'go'],
    ['Cargo.toml', 'rust'],
    ['Gemfile', 'ruby'],
    ['composer.json', 'php'],
    ['app.csproj', 'dotnet'],
    ['app.sln', 'dotnet'],
  ];
  for (const [marker, label] of cases) {
    const root = tmpRepo();
    writeFileSync(join(root, marker), '');
    assert.deepEqual(detectStack(root), [label], `${marker} -> ${label}`);
    rmSync(root, { recursive: true, force: true });
  }
}

// 5. Multiple markers -> multiple labels, sorted & unique
{
  const root = tmpRepo();
  writeFileSync(join(root, 'package.json'), '');
  writeFileSync(join(root, 'pyproject.toml'), '');
  writeFileSync(join(root, 'requirements.txt'), ''); // still python, deduped
  assert.deepEqual(detectStack(root), ['node', 'python'], 'multi stack, sorted, unique');
  rmSync(root, { recursive: true, force: true });
}

// 6. No markers -> []
{
  const root = tmpRepo();
  assert.deepEqual(detectStack(root), [], 'no markers -> []');
  rmSync(root, { recursive: true, force: true });
}

// 7. Unreadable rule file is skipped, others still returned
{
  const root = tmpRepo();
  writeRules(root, { 'ok.md': 'ok body', 'bad.md': 'secret' });
  chmodSync(join(root, '.claude', 'rules', 'bad.md'), 0o000);
  const rules = collectRules(root).rules;
  const names = rules.map(r => r.name);
  assert.ok(names.includes('ok.md'), 'readable file kept');
  // bad.md is either skipped (unreadable) — must not throw and must not break ok.md
  assert.ok(rules.find(r => r.name === 'ok.md').content === 'ok body', 'good content intact');
  chmodSync(join(root, '.claude', 'rules', 'bad.md'), 0o644);
  rmSync(root, { recursive: true, force: true });
}

console.log('collect-rules: PASS');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node lib/tests/test-collect-rules.mjs`
Expected: FAIL — `Cannot find module '.../lib/collect-rules.mjs'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/collect-rules.mjs`:

```javascript
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Fixed-name markers → stack label.
const NAME_MARKERS = [
  ['package.json', 'node'],
  ['pom.xml', 'java'],
  ['build.gradle', 'java'],
  ['build.gradle.kts', 'java'],
  ['pyproject.toml', 'python'],
  ['requirements.txt', 'python'],
  ['setup.py', 'python'],
  ['go.mod', 'go'],
  ['Cargo.toml', 'rust'],
  ['Gemfile', 'ruby'],
  ['composer.json', 'php'],
];

// Detect the repo's stack(s) from marker files in the repo root.
// Returns a sorted, de-duplicated array of labels ([] if nothing matches).
export function detectStack(repoRoot) {
  const labels = new Set();
  for (const [name, label] of NAME_MARKERS) {
    if (existsSync(join(repoRoot, name))) labels.add(label);
  }
  // dotnet uses extension markers, not a fixed filename.
  let entries = [];
  try {
    entries = readdirSync(repoRoot);
  } catch {
    entries = [];
  }
  if (entries.some((f) => f.endsWith('.csproj') || f.endsWith('.sln'))) {
    labels.add('dotnet');
  }
  return [...labels].sort();
}

// Read every *.md under <repoRoot>/.claude/rules/, sorted by name.
// An unreadable file is skipped, not fatal. Missing dir → [].
function readRules(repoRoot) {
  const dir = join(repoRoot, '.claude', 'rules');
  let names;
  try {
    if (!statSync(dir).isDirectory()) return [];
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const rules = [];
  for (const name of names.filter((n) => n.endsWith('.md')).sort()) {
    try {
      rules.push({ name, content: readFileSync(join(dir, name), 'utf8') });
    } catch {
      // unreadable rule file — skip it, keep going
    }
  }
  return rules;
}

// Public: turn a repo root into { stack, rules }.
export function collectRules(repoRoot) {
  return { stack: detectStack(repoRoot), rules: readRules(repoRoot) };
}

// CLI: `node lib/collect-rules.mjs <repoRoot>` → JSON to stdout.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = process.argv[2] || process.cwd();
  process.stdout.write(JSON.stringify(collectRules(repoRoot)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node lib/tests/test-collect-rules.mjs`
Expected: `collect-rules: PASS`.

- [ ] **Step 5: Verify the CLI form and non-.md handling**

Run:
```bash
tmp="$(mktemp -d)"; mkdir -p "$tmp/.claude/rules"; printf 'body' > "$tmp/.claude/rules/x.md"; printf '{}' > "$tmp/package.json"
node lib/collect-rules.mjs "$tmp"
echo; rm -rf "$tmp"
```
Expected: `{"stack":["node"],"rules":[{"name":"x.md","content":"body"}]}`.

- [ ] **Step 6: Update the whole-suite glob in CLAUDE.md**

In `CLAUDE.md`, find the "Stack rules" line:
`Run the whole suite: `for t in skills/*/tests/test-*.mjs; do node "$t" || break; done``
Replace the command with:
`for t in skills/*/tests/test-*.mjs lib/tests/test-*.mjs; do node "$t" || break; done`

- [ ] **Step 7: Run the whole suite (no regressions + new test runs)**

Run: `for t in skills/*/tests/test-*.mjs lib/tests/test-*.mjs; do node "$t" || break; done`
Expected: every test prints `... : PASS`, including `collect-rules: PASS`.

- [ ] **Step 8: Commit**

```bash
git add lib/collect-rules.mjs lib/tests/test-collect-rules.mjs CLAUDE.md
git commit -m "feat: add collect-rules helper for per-repo .claude/rules conventions"
```

---

### Task 2: Wire the build stage (`test-driven-implementation`)

**Files:**
- Modify: `skills/test-driven-implementation/SKILL.md` (Step 2 end, Step 3 subagent contract, Step 4)

**Interfaces:**
- Consumes: `node ${CLAUDE_PLUGIN_ROOT}/lib/collect-rules.mjs <repoRoot>` → `{ stack, rules }` (Task 1).
- Produces: a documented "project conventions" context block passed to each task subagent; no code artifact for later tasks.

- [ ] **Step 1: Add rules collection to Step 2 (lead)**

In `skills/test-driven-implementation/SKILL.md`, at the end of `## Step 2 — Stream analysis`, add a new numbered item after the partition step:

```markdown
4. **Collect project conventions (once).** Run
   `node "${CLAUDE_PLUGIN_ROOT}/lib/collect-rules.mjs" "$(git rev-parse --show-toplevel)"`.
   It returns `{ stack, rules }` from the target repo's `.claude/rules/*.md` (see the tooling
   bible). Print a one-line summary — e.g. `conventions: stack node · 3 rule file(s)`, or
   `conventions: none found — stack defaults` when `rules` is empty. Empty is fine and means the
   build behaves exactly as before. Keep the returned `stack` and `rules` for the subagent contract.
```

- [ ] **Step 2: Inject conventions into the subagent contract (Step 3)**

In `### The subagent contract (one fresh subagent per task)`, the "Give each subagent only:" list, add a bullet after the task-block/graphify-slice bullet:

```markdown
- the **project conventions** collected in Step 2: the `stack` label (a one-line "this is a
  <stack> repo" hint) and the full text of each `.claude/rules/*.md` file, given as **binding
  conventions to follow** while writing code. If none were found, say "no project rules — stack
  defaults" so the subagent knows the standard is its own good judgement, not a missing input.
```

- [ ] **Step 3: Add the light convention check to Step 4**

In `## Step 4 — Review between tasks (light)`, after the sentence ending "sanity-check the diff against the task's intent.", insert:

```markdown
Also check the diff against the project conventions from Step 2: a change that **plainly**
violates a stated rule (e.g. the repo's naming or error-handling convention) is a failure — retry,
then escalate, the same as an off-intent diff. Keep this light: no rule parsing, just catch blatant
breaks. Deep convention compliance is the **code gate's** job, not this step's.
```

- [ ] **Step 4: Verify the referenced command works from the plugin root**

Run (proves the documented command resolves and returns JSON):
```bash
node "$(git rev-parse --show-toplevel)/lib/collect-rules.mjs" "$(git rev-parse --show-toplevel)"; echo
```
Expected: JSON `{"stack":[...],"rules":[...]}` (shipyard itself has no `.claude/rules/`, so `rules` is `[]` — that is the correct "none found" path).

- [ ] **Step 5: Verify the build-stage tests still pass**

Run: `for t in skills/test-driven-implementation/tests/test-*.mjs; do node "$t" || break; done`
Expected: each prints `... : PASS` (prose wiring must not break the deterministic lib tests).

- [ ] **Step 6: Commit**

```bash
git add skills/test-driven-implementation/SKILL.md
git commit -m "feat: build stage injects per-repo .claude/rules conventions"
```

---

### Task 3: Wire the code gate (`expert-panel-review`)

**Files:**
- Modify: `skills/expert-panel-review/SKILL.md` (Step 3 — "Source the project rules")

**Interfaces:**
- Consumes: `node ${CLAUDE_PLUGIN_ROOT}/lib/collect-rules.mjs <proj>` → `{ stack, rules }` (Task 1); the workflow's existing `rules` arg (unchanged shape).
- Produces: `/tmp/epr-rules.txt` now sourced from `.claude/rules/` first; a `stack:` line prepended for reviewer orientation.

- [ ] **Step 1: Replace the rules-sourcing block, keeping the old fallbacks**

In `skills/expert-panel-review/SKILL.md`, `## Step 3 — Source the project rules (for the compliance lane)`, replace the existing bash block with:

```bash
# Prefer the canonical per-repo conventions: .claude/rules/*.md (via the shared helper).
rules_json="$(node "${CLAUDE_PLUGIN_ROOT}/lib/collect-rules.mjs" "$proj")"
: > /tmp/epr-rules.txt
# Stack hint first, so reviewers know which conventions apply.
stack="$(printf '%s' "$rules_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);process.stdout.write((j.stack||[]).join(", "))})')"
[ -n "$stack" ] && printf 'stack: %s\n\n' "$stack" >> /tmp/epr-rules.txt
# Rule bodies from .claude/rules/*.md.
printf '%s' "$rules_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);for(const r of (j.rules||[]))process.stdout.write("=== "+r.name+" ===\n"+r.content+"\n\n")})' >> /tmp/epr-rules.txt
# Fallback: no .claude/rules/ → keep the previous sources so existing repos still work.
if [ ! -s /tmp/epr-rules.txt ]; then
  if [ -f "$proj/.claude/expert-review-rules.md" ]; then
    head -c 8000 "$proj/.claude/expert-review-rules.md" > /tmp/epr-rules.txt
  else
    { cat "$proj/CLAUDE.md" 2>/dev/null; cat "$proj"/docs/rules/*.md 2>/dev/null; } \
      | head -c 8000 > /tmp/epr-rules.txt
  fi
fi
# Cap the size so a huge rules set cannot blow the reviewer prompt.
head -c 8000 /tmp/epr-rules.txt > /tmp/epr-rules.cap && mv /tmp/epr-rules.cap /tmp/epr-rules.txt
```

- [ ] **Step 2: Update the surrounding prose**

Immediately after that block, replace the existing sentence
("If the result is empty, the workflow simply skips the compliance lane — that is expected for projects with no written rules.")
with:

```markdown
Sources, in order of precedence: the target repo's `.claude/rules/*.md` (the canonical location —
read via `${CLAUDE_PLUGIN_ROOT}/lib/collect-rules.mjs`, prefixed with a `stack:` hint), then, only
if that is empty, the legacy fallbacks (`.claude/expert-review-rules.md`, else `CLAUDE.md` +
`docs/rules/*.md`). If everything is empty the workflow simply skips the compliance lane — expected
for projects with no written rules. The `rules` workflow arg is unchanged; only its source changed.
```

- [ ] **Step 3: Verify the sourcing block runs and produces the expected shape**

Run (simulates Step 3 against a repo that has `.claude/rules/`):
```bash
proj="$(mktemp -d)"; mkdir -p "$proj/.claude/rules"; printf '{}' > "$proj/package.json"
printf 'Use 4-space indent.' > "$proj/.claude/rules/style.md"
CLAUDE_PLUGIN_ROOT="$(git rev-parse --show-toplevel)"
rules_json="$(node "${CLAUDE_PLUGIN_ROOT}/lib/collect-rules.mjs" "$proj")"
printf '%s' "$rules_json"; echo
rm -rf "$proj"
```
Expected: `{"stack":["node"],"rules":[{"name":"style.md","content":"Use 4-space indent."}]}`.

- [ ] **Step 4: Verify the code-gate tests still pass**

Run: `for t in skills/expert-panel-review/tests/test-*.mjs; do node "$t" || break; done`
Expected: each prints `... : PASS`.

- [ ] **Step 5: Commit**

```bash
git add skills/expert-panel-review/SKILL.md
git commit -m "feat: code gate sources conventions from .claude/rules via shared helper"
```

---

### Task 4: Version bump

**Files:**
- Modify: `.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

**Interfaces:**
- Consumes: nothing.
- Produces: matching `1.1.0` in both manifests.

- [ ] **Step 1: Bump plugin.json**

In `.claude-plugin/plugin.json`, change `"version": "1.0.0"` → `"version": "1.1.0"`.

- [ ] **Step 2: Bump marketplace.json to match**

In `.claude-plugin/marketplace.json`, change `metadata.version` `"1.0.0"` → `"1.1.0"`.

- [ ] **Step 3: Verify the two versions match**

Run: `grep -h '"version"' .claude-plugin/plugin.json .claude-plugin/marketplace.json`
Expected: both show `1.1.0`. (If ci-coverage-audit merged first, use `1.2.0` in both instead.)

- [ ] **Step 4: Full suite green before handing to the code gate**

Run: `for t in skills/*/tests/test-*.mjs lib/tests/test-*.mjs; do node "$t" || break; done`
Expected: all `... : PASS`.

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: bump to 1.1.0 (project rules awareness)"
```

---

## Self-Review

**Spec coverage:**
- Canonical `.claude/rules/` location + load-all + stack hint → Task 1 (`collectRules`/`detectStack`).
- Shared deterministic helper at plugin root → Task 1.
- Degrade-never-block error handling → Task 1 tests 1, 2, 7; exercised in Tasks 2–3 "none found" paths.
- Build-stage wiring (inject + light gate) → Task 2 (Steps 1–3).
- Code-gate wiring + reconcile old sources → Task 3 (Steps 1–2, keeps legacy fallbacks).
- Suite runner glob update → Task 1 Step 6.
- MINOR version bump, both manifests → Task 4.
- Out of scope (planning stage, hard gate) → not present. Correct.

**Placeholder scan:** No TBD/TODO; every code and prose step shows exact content and commands.

**Type consistency:** `collectRules`/`detectStack` names and the `{ stack: string[], rules: [{name, content}] }` shape are identical across Task 1 (definition), Task 2, and Task 3 (consumers) and the CLI JSON in every verify step.
