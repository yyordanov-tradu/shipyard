# shipyard expert-panel-review Redesign: Recall Stability for the Code Gate

## Goal & non-goals

**Primary goal (fixed, non-negotiable):** recall *stability* on real Critical/High findings. The gate must never miss a real Critical/High, and must not flicker — return it on one run and drop it on the next. Cost may rise to buy this.

**Secondary goals:** keep token cost scaling with the *change*, not change × panel; make every non-judgment step deterministic and unit-testable through the existing dry-run harness; make the report byte-stable for the same findings.

**Non-goals:**
- Precision for its own sake. More skeptics that only cut false positives do not serve the primary goal.
- Reworking roster/lane mechanics that are orthogonal to recall (conditional roster, compliance lane, inline mode). They stay unless the eval proves a cut is recall-neutral.
- Perfect cross-file *attribution*. The gate's job is to stop the bad merge, not to name the exact cause file every time.
- Adding any per-project MCP dependency. graphify and Serena are optional; absence must degrade and announce, never block.

## The pipeline (stage graph)

```
Stage 0  Resolve + roster                    [deterministic JS]   no findings
Stage 1  Review: N-of-M warm sampling/lens   [agent]              CREATES recall
Stage 2  Union + cluster + support count     [deterministic JS]   never drops
Stage 3  Completeness-critic (N passes)      [agent]              ADDS recall (routes only)
Stage 4  Verify: cross-file-aware skeptics   [agent]              ONLY stage that drops
Stage 5  Verification ledger                 [agent]              trust signal, never gates recall
Stage 6  Assemble report + verdict           [deterministic JS]   no findings, no LLM
```

Two stages create findings (Review, completeness-critic). Exactly one stage removes them (Verify). Dedup, ledger, and assembly cannot subtract — that single rule is the heart of the fix.

Honest complexity accounting: this is **one stage longer** than today (the critic) and turns **two LLM stages into deterministic JS** (LLM dedup → JS cluster; free-form synthesis → JS assembly). Net code complexity is roughly flat. N-of-M multiplies agent *count*. This is not a net simplification — it is a recall fix that pays for itself by deleting two sources of run-to-run noise.

## Stage-by-stage

### Stage 0 — Resolve + roster (deterministic JS)

Keep today's roster logic. Fix the config-order bug first: parse `args` once at the top, then read every tunable from one config block (M, SKEPTICS, MAJORITY, VERIFY_SEVERITIES, line-band width, title-match threshold, max concurrency, critic passes). This kills the "config read before args parsed" class of bug.

Keep `splitDiffByFile`, `changeView`, repo/inline mode, the conditional roster, and the compliance lane. They are orthogonal to recall, already tested, and a target repo may need a lane. They become **eval-gated cuts with a usage bar** (see Decisions R1), not default deletions.

### Stage 1 — Review: N-of-M warm sampling per lens (agent)

The primary lever. For each lens, spawn **M independent warm draws** instead of one.

- Label each draw `review:<lens>:draw-<i>` (the harness keys on labels).
- Finders stay at normal temperature. Temperature-0 would kill draw-to-draw diversity and *lower* the recall ceiling. Determinism comes from aggregating warm draws in code, not from cold sampling.
- Union recall per run rises as `1 − (1−p)^M`. This is **motivation, not a measured promise**: warm draws of the same model on the same slice are positively correlated, so the real lift sits below the analytic curve. The marginal-findings curve and the Jaccard curve (Stage 7) decide M, not this formula.

**Two prompt changes inside the finder (the cross-lane fix, ~free):**

1. **Lane = TOPIC, not CAUSAL.** Replace "stay in your lane" with: *"Stay on your TOPIC — only raise findings whose symptom belongs to your lens. But you MAY and SHOULD follow your own symptom across files and lanes to find its cause. Tracing a weak test to the broken wait that causes it is required, not lane-crossing."*

2. **Symptom→cause obligation + `causeFiles`.** Extend the finder schema with `causeFiles: [paths]`. The finder names the file(s) where the cause lives, when it can. (`causeConfidence` is dropped — see Decisions R2; it was a self-assessment no stage acted on.)

### Stage 2 — Union + cluster + support count (deterministic JS, replaces LLM dedup)

Merge the M draws of each lens (and later the critic's re-reviews) into one candidate set, in pure JS. For each merged candidate compute **support k/M** = how many draws raised it.

This stage is the most recall-critical operator in the new pipeline, so it is pinned down now, not deferred:

- **Conservative-by-default key.** Merge ONLY when `(same file) AND (line within N) AND (title token-overlap ≥ threshold)`. When uncertain, **keep both**. The failure mode is biased to over-*splitting* (extra verify cost, human-visible) and away from over-*merging* (silent recall loss, invisible). N and the threshold are tunables, but the *direction* is fixed: a false split is acceptable, a false merge is not.
- **Severity is part of the match key.** A Critical/High NEVER merges into a lower-severity cluster. This blocks down-severization.
- **Cluster keeps MAX severity and unions all contributing draws/lenses** — a tested invariant, matching what the old LLM dedup did (engine line 478).
- **Never drops on low support.** k/M is a trust label printed in the report, never a filter. A real Critical can be a single-draw find (k=1/M still flows to verify).

**Dry-run purity (binding constraint).** Union does ZERO IO. It consumes only finding objects plus the already-parsed `fileDiffs` map. The key is **mode-aware**: in inline mode, key on the parsed `fileDiffs` line content; in repo mode (where the engine holds no diff text), key on `(file, normalized-title)` plus the finder-reported `line` integer from the existing schema — **never** shell out to `git diff`. This keeps the stage testable through the current harness, which stubs only agent/parallel/pipeline/phase/log/budget/workflow and cannot stub git.

This replaces the LLM dedup agent with deterministic, unit-testable JS, removing a stage that could subtract and a source of run-to-run noise.

### Stage 3 — Completeness-critic (agent) — the structural-miss killer

The only stage besides Review that can ADD findings. It is grounded by **graphify** (macro owner per `docs/tooling.md`).

Because the critic is a recall-*creating* stage, it obeys the same rule as the finders: **it is not a single warm sample.** Run the critic **N passes** (config tunable, default 2) and **union its re-review requests** the same way Review unions draws. N=1 is allowed only if the eval shows the critic's re-review set is stable across runs on the seeded structural-miss corpus; otherwise N>1. This closes the hole where one stochastic critic draw would re-freeze the ~20% structural miss the lever was meant to fix.

What the critic emits — **structured re-review requests** (never findings directly) for:
- changed symbols/files with **no finding**, and
- findings the finder flagged but never located the cause for.

Each re-review re-runs the relevant lens against the named target. Its output goes back through **Union → Verify** like any other finding. The critic routes; it never injects, so the skeptic majority still filters its noise. **One routing round, re-reviews pass through Verify exactly once** — this bounds the feedback loop (the N passes are of the critic's own analysis, not of the route→verify loop).

**Degraded path (binding — graphify is often absent in generic installs).** When graphify is absent, do NOT treat the path as equivalent. The critic drives the "changed code with no finding" check off `git diff --name-only` + the diff hunks the engine already parses, enumerating changed **files** (not symbols), and routes a re-review per changed file lacking a finding. It **announces the reduced granularity**: *"graphify absent — file-level completeness only, symbol-level skipped."* The eval (Stage 7) measures cross-file recall in this no-graphify configuration against a stated floor, so the degraded path is proven, not assumed.

Why a critic instead of just raising M: more draws of the *same lens on the same slice* cannot find a cause living in a slice the lens never saw. The critic is the cheap, bounded way to reach the structural miss; raising M to 6–8 is the expensive trap.

### Stage 4 — Verify: cross-file-aware skeptics (agent) — the only stage that drops

Keep the counts (3 skeptics per Critical/High/Medium, 1 grounding self-check per Minor) and keep-on-error behavior. Four changes close the cross-file recall leak and make the drop decision honest.

1. **Scope the skeptic to the proof.** Today each skeptic gets `changeView([f.file])` (engine line 439) — only the finding's own file. Change to `changeView([f.file, ...f.causeFiles])`. When `causeFiles` is empty or uncertain, **fail toward more context**: hand the full `changedFiles` list, and pass `repoPath` with explicit permission to open files **outside the diff** (the cause is often in pre-existing unchanged code).

2. **Three-way verdict, drop only on cited counter-evidence.** Replace `refuted: boolean` + "default to refuted when unsure" with `confirmed | cannot-locate | refuted`. A finding is dropped only on a **2-of-3 majority of `refuted` votes that each cite a line or fact**. `cannot-locate` is an **abstain** — it never drops and never counts toward the majority. *"Missing context is not refutation: if the cause is in a file you were not given, open it (repo path provided) before voting; if you genuinely cannot access it, abstain — never refute because the proof was not in your starting slice."* The "documented trade-off" branch collapses into one kind of cited counter-evidence (must quote the doc line).

3. **Suppressed Critical/High still blocks.** A Critical/High that loses the skeptic vote is NOT silently downgraded to APPROVE. It moves to a visible **suppressed** list AND **still forces REQUEST-CHANGES** (suppressed = "needs human eyes"). This is the safe choice for the fixed goal: the gate's job is to stop the merge, not to perfectly attribute. Lower-severity suppressed findings are dropped from the verdict but listed for audit. This resolves the cross-file case end-to-end: a symptom-in-diff / cause-in-unchanged-code Critical ends **blocking**, not parked.

4. **Cluster BEFORE verify.** The pipeline re-orders the current engine (which runs verify inside the per-lane pipeline and dedup after). Union runs first so the skeptic bill is not multiplied on literal duplicates.

**Acknowledged residual:** the 3 skeptics are still one warm 3-vote draw, so the drop decision has run-to-run variance. The eval (Stage 7) measures skeptic-vote variance on seeded Criticals and gates on "no seeded Critical is ever dropped." Because suppressed Critical/High still blocks (change 3), skeptic-vote variance can no longer flip the *verdict* on a Critical — it can only move a Critical between the "confirmed" and "suppressed" lists, both of which block. This bounds the residual to report wording, not gate outcome.

### Stage 5 — Verification ledger (agent, unchanged in spirit)

Keep it: one pass listing load-bearing claims as verified / unable-to-verify / refuted, always runs even with zero findings. It strengthens APPROVE trust. It does not gate recall.

### Stage 6 — Assemble report + verdict (deterministic JS, replaces free-form synthesis)

**100% deterministic. Zero `agent()` calls in this stage.** The verdict is already computed in JS (engine 524–528); keep it: `hasBlocker || ciRed → REQUEST-CHANGES; hasMedium → APPROVE-WITH-NITS; else APPROVE`, where `hasBlocker` now includes suppressed Critical/High (Stage 4 change 3). Assemble the whole markdown from a fixed template over the finding/ledger arrays, using the finders' **existing** structured fields (`title`/`detail`/`suggestion` + verification + k/M). There is no per-finding LLM prose call — the finders already produce all the prose the report needs. This makes the preamble-leak class of bug structurally impossible and the report **byte-stable** for the same findings. Each finding line shows its **support k/M** (e.g. "support 3/3" vs "support 1/3 — single-draw, confirm"). The empty-report guard is preserved (never write an empty review).

## Recall / sampling approach (three layers, in priority order)

1. **Never frozen at one sample (≈70% of the loss).** Each lens is sampled M times warm and unioned in JS. The run-to-run *set* stabilizes because you average over draws instead of betting on one.
2. **Late additions allowed (the structural ≈20%).** The completeness-critic (run N passes, unioned) is the only post-review stage that can add findings; it routes targeted re-reviews back through Union → Verify. Recall is no longer frozen when the lanes finish.
3. **Stop the silent drops.** Conservative cluster key (never over-merge, never down-severize) + cross-file skeptic scope + abstain-not-refute + suppressed-still-blocks + support-never-drops. Every rule biases toward keeping real Critical/High and toward emitting the same findings across runs.

## Verification — how cross-file findings survive (the lesson-B fix, restated)

Today: skeptic sees only file X, "default to refuted when unsure" → a finding proved in file Y is silently dropped. New: (a) the finder declares `causeFiles`; (b) the skeptic gets `[f.file, ...causeFiles]`, or the full changed set + `repoPath` + permission to open unchanged files when uncertain; (c) the verdict is three-way and a drop requires a **cited** refute majority; (d) `cannot-locate` abstains; (e) a Critical/High that still loses goes to a suppressed list that **still blocks the verdict**. A cross-file Critical can now only stop blocking when a skeptic *read the cited cause and quoted why it does not hold* — and even then a human sees it.

## Scaling (cost, honestly)

- **Token size stays solved.** Repo mode + per-file slicing means cost scales with the *change*, not change × panel; the 150 KB ceiling work is preserved. N-of-M multiplies agent *count*, not prompt size. The cross-file skeptic gets `[f.file + causeFiles]` (typically 2–3 files), not the whole diff.
- **The honest hidden cost is Verify, and it grows with M.** Total ≈ `panel × M` (Review) `+ N critic passes + a few re-reviews` `+ 3 × (post-cluster union count of Critical/High/Medium) + 1 × (Minor count)` (Verify) `+ ledger + assembly`. N-of-M plus never-drop-low-support means the verify multiplier is **3 × post-cluster union count**, which *grows with M* — not the smaller "3 × Critical/High/Medium" of today. Cluster-before-verify only removes exact-key duplicates; the N-of-M premise is that draws find *different* real findings, so most of the inflation survives to verify. Budget this explicitly. The marginal-findings eval plots this count's growth with M so M is chosen on **recall-per-run-completable**, not recall alone.
- **Bound concurrency** through a shared helper. The repo already has a proven `parallelLimited(thunks, limit, staggerMs)` (in `workflows/expert-advised-planning.js` and `workflows/plan-readiness-review.js`). Lift it into a shared lib and route every fan-out (M-draws, critic passes, skeptic waves) through it (default ~4). This is a real simplification — three workflows share one helper instead of the engine's bare `parallel` (line 413).
- **Timed-out always-on lens is a HARD verdict signal, not a footnote.** A bounded queue that cannot drain Review(panel × M) + critic + verify in the run budget will time lanes out; today a failed always-on security/backend lens lands in `failedExperts` and shows only as a footnote (engine 554) — indistinguishable from "clean." Change: **cannot APPROVE if any always-on lens failed or timed out.** A missing always-on lens is a silent Critical miss, and this recall hole grows with M. The eval reports the fraction of runs where any always-on lane fails to complete at the chosen M and concurrency.
- **Cost discipline:** M then a critic beats M=6–8. But M is chosen by the *Jaccard gate first*, cost knee second (see eval) — if the cost knee misses the gate, M rises.

## Eval harness — how recall stability is measured and how M is chosen

A standalone zero-dependency `skills/expert-panel-review/tests/eval-recall.mjs` (node:assert), separate from the fast dry-run unit tests, runs the **real engine** against a **fixed corpus of frozen diffs with seeded known-good findings**. This is **ground-truth-BASED** (the seeds *are* ground truth) — the term "ground-truth-free" applies only to live novel-diff stability runs, never to the seeded corpus.

**The corpus must include:**
- a cross-file symptom→cause pair (exercises the cross-file fix),
- a symptom-in-diff / cause-in-**unchanged**-code Critical (must end blocking),
- a single-draw rare Critical (exercises never-drop-low-support),
- two distinct Criticals at adjacent lines that MUST stay separate (exercises over-split bias),
- the same Critical in two phrasings that MUST merge (exercises the merge key),
- a changed file/symbol with no direct finding (exercises the critic).

**Two run modes from one `harness.mjs` loader:** LIVE (real agents, true stability, on demand) and RECORDED (replay captured agent outputs, deterministic CI regression).

**Metrics, in priority order:**

1. **Severity-weighted RECALL against the seeded ground truth** (caught / total seeded, Critical ≫ High ≫ Medium ≫ Minor). Reported per-run, as union-recall across N runs, and as **worst-single-run recall**. **This is the primary gate: worst-single-run seeded-Critical recall must = 1.0** — never miss a seeded Critical on ANY of N runs. This is the metric a *stable miss* cannot hide from: a Critical missed on every run scores 0 here even though it scores a perfect 1.0 on Jaccard.
2. **Severity-weighted test-retest Jaccard** across N ≥ 5 runs of the same diff (target ≥ 0.9; today ~0.67). This is the **flicker gate**, demoted from "the gate." Weighting by severity makes it drop sharply when a Critical flickers between runs.
3. **Marginal-new-findings-per-draw curve** (run a lens M = 1..6) — the cost knee (expect 3–4). **M is chosen by the Jaccard curve first** (the lowest M where the flicker gate passes), and the cost knee only breaks ties. If the knee-M misses ≥ 0.9 Jaccard, M rises until the gate passes — recall stability is the fixed goal, cost yields. The rare-Critical case is **reported separately** and **excluded from the knee fit** (a rare Critical keeps paying past M=5 by definition and would falsely push the knee rightward); its detection is covered by metric 1, not by the cost curve.
4. **Cross-file recall** — fraction of seeded cross-file defects caught; must be ≈1.0. Measured WITH and WITHOUT the cross-file escape clause to justify it, and **separately in the no-graphify (file-level) critic configuration** against a stated floor.
5. **Skeptic-vote variance on seeded Criticals** — gates on "no seeded Critical is ever dropped from blocking."
6. **Cost** — agents-per-run and tokens-per-run, plus the post-cluster union count vs M, so M and skeptic count are chosen on recall-per-dollar.
7. **Always-on lane completion rate** at the chosen M and concurrency.

The unit tests prove the *machine routes findings correctly* with canned agents. The eval proves the *machine finds and re-finds real issues* with live agents. They never mix.

## What is REMOVED vs today

- **LLM dedup agent → deterministic Union + cluster in JS.** Removes a stage that could subtract; makes support count free and testable.
- **Free-form synthesis agent → deterministic JS report assembly, no LLM call at all.** Kills the preamble-leak bug class; makes the report byte-stable.
- **`refuted: boolean` + "default to refuted" + the trade-off special branch → one three-way `confirmed | cannot-locate | refuted` rule** where the trade-off case is just cited counter-evidence. One truth table, fewer prompt special-cases.
- **`causeConfidence` field → removed entirely** (a finder self-assessment no stage acted on). Only `causeFiles` is added.
- **Bare `parallel` (engine 413) → shared `parallelLimited`** lifted from the sibling workflows.
- **Always-on lane failure as a footnote → a hard "cannot APPROVE" verdict signal.**
- **Config read before args → one config block parsed after args.**

**Deliberately KEPT (rejected the simplicity push here):** conditional roster, compliance lane, inline mode, the add-on expert menu, and `parseCiRed` in the engine. These are orthogonal to recall, tested, and may be needed by a target repo. They become eval-gated cuts with a usage bar, not default deletions.

## Key decisions (with rejected alternatives)

- **D1 — N-of-M warm union as the primary lever.** Rejected: temperature-0 finders. Temp-0 lowers the recall ceiling and kills draw diversity. Determinism comes from aggregating warm draws in code.
- **D2 — A completeness-critic that ROUTES re-reviews (run N passes, unioned), not a bigger roster or more skeptics.** Rejected: more lenses / more skeptics. More skeptics are pure precision, zero recall help; a bigger roster is more hand-wiring. Rejected also: a single-pass critic — it would re-freeze the structural miss it exists to fix.
- **D3 — Deterministic Union + JS report assembly with zero LLM in either.** Rejected: keep LLM dedup/synthesis, and rejected: a per-finding LLM prose call in assembly. Both are run-to-run noise and the preamble leak; the finders' existing structured fields already carry the prose.
- **D4 — Conservative cluster key, biased to over-split, severity in the key, MAX-severity retained.** Rejected: a loose semantic key. A false merge is silent recall loss that no later stage recovers and that even a perfect Jaccard cannot see; a false split only costs verify calls.
- **D5 — Three-way verdict, abstain-never-drops, and suppressed Critical/High STILL BLOCKS.** Rejected: keep `default-to-refute`; rejected: suppressed Critical flips to APPROVE with an audit trail (that is the forbidden flicker dressed up).
- **D6 — Never auto-drop low support; k/M is a trust label.** Rejected: drop k=1/M as noise. A real Critical can be a single-draw find.
- **D7 — Primary gate = severity-weighted seeded RECALL (worst-single-run Critical = 1.0); Jaccard is the secondary flicker gate.** Rejected: Jaccard as the headline gate. Jaccard is blind to a *stable* miss — a Critical absent on every run looks like perfect agreement. M is chosen against the Jaccard curve, not the cost knee alone.
- **D8 — Timed-out always-on lens blocks APPROVE.** Rejected: leave it a footnote. A missing always-on lens is an invisible Critical miss whose probability grows with M.
- **R1 — Keep roster/compliance/inline complexity as eval-gated cuts WITH A USAGE BAR** (e.g. cut any add-on expert with zero invocations across the corpus, behind an `extraLenses` escape hatch). Rejected: delete to a fixed four-lens roster now (a target repo may need a lane); rejected also: "eval-gated" with no bar (which deletes nothing, since the eval can never prove a never-triggered lens safe).
- **R2 — Drop `causeConfidence`.** Rejected: keep it. It is a finder self-assessment of dubious reliability that no stage acted on; `causeFiles` + the critic carry the cross-file work without it.
- **R3 — Keep `parseCiRed` pure in the engine; let the launcher optionally pass a precomputed boolean the verdict ORs in.** Rejected: move CI parsing into launcher prose. That trades a tested pure function for untested markdown.

## Risks

- **Cluster key mis-tuned.** A loose key silently merges two real Criticals and no later stage recovers it; the Jaccard gate is blind to a stable over-merge. Mitigation: conservative-by-default key, severity in the key, MAX-severity invariant, and the two corpus cases (adjacent-distinct must split, two-phrasings must merge) so tuning is not blind.
- **Skeptic-vote stochasticity.** The drop decision is still one warm 3-vote draw. Mitigation: suppressed Critical/High still blocks, so variance moves a Critical only between two blocking lists, never out of the gate; metric 5 measures it.
- **causeFiles unreliable → skeptic usually gets the full changed set → dilution (the 10%-attention problem) creeps back into Verify.** Mitigation: measure refute accuracy with full-set vs causeFiles (open question 5); if full-set does not hurt, `causeFiles` can be dropped and the fix collapses to "full changed set + abstain-not-refute," which is simpler.
- **No-graphify install weakens the critic to file-level.** Mitigation: file-level degraded path is concrete and announced; the eval gates cross-file recall in that configuration against a floor.
- **Cost/timeout grows with M and can time out an always-on lens → silent miss.** Mitigation: bounded concurrency, always-on-failure blocks APPROVE, eval reports lane-completion rate at the chosen M.
- **Correlated warm draws** mean realized N-of-M lift is below the analytic curve. Mitigation: M is set by measured curves, not the formula.
- **Tests locking a wrong contract.** The dedup-echo expectations change with the new contract. Mitigation: write the new cluster-invariant tests (adjacent-split, two-phrasings-merge, MAX-severity, low-support-survives) and get them passing *before* removing the old echo assertions.

## Open questions for the human

1. **M = 3 or 4?** Decidable only by the Jaccard curve (gate) then the marginal-findings knee (tie-break) on the corpus. Do not hardcode before measuring.
2. **M on all lenses, or always-on only?** Decide by whether conditional/language lenses ever produce Criticals in the corpus.
3. **Critic passes N = 1 or 2?** N=1 only if the critic's re-review set is stable across runs on the seeded structural-miss corpus; else N=2.
4. **Cause-in-unchanged-code:** the design says such a Critical must end *blocking*, and the skeptic may open files outside the diff. Confirm the gate is allowed to block on a cause that lives in pre-existing, unchanged code — this stretches "only report issues in CHANGED code." Where exactly is the line?
5. **Union match key:** what line-band width N and title-overlap threshold minimize false merges (recall loss) and false splits (cost)? Tune on the two seeded cluster cases.
6. **Cross-file scope rule:** parse `causeFiles` from the finder, or always hand the skeptic the full changed set? Pick by refute accuracy on seeded cross-file Criticals; if full-set is harmless, drop `causeFiles` and simplify.
7. **Rare-Critical in M-selection:** confirm it is reported separately and excluded from the cost-knee fit (its detection is gated by recall metric 1, not the cost curve), so the eval does not argue with itself.
8. **Eval in CI:** recorded-mode regression on every commit, live on demand — or periodic live runs too (cost, nondeterminism)? Likely recorded in CI, live on demand.