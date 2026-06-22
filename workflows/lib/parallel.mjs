// Bounded-concurrency fan-out, shared by the workflow engines.
//
// Runs `thunks` (each a zero-arg function returning a promise) at most `limit` at a
// time, in waves, optionally pausing `staggerMs` between waves so a burst is rate-
// smeared (rate, not volume, was the prior cliff). Results come back in INPUT order.
// A thunk that throws resolves to `null` in its slot (mirrors the workflow runtime's
// `parallel`), so a single failure never rejects the whole batch — callers filter.
//
// Self-contained (no workflow-runtime `parallel` global) so it is unit-testable with
// plain `node`, AND inlined byte-identically into the engine where the runtime runs it.
export async function parallelLimited(thunks, limit = 4, staggerMs = 0) {
  const n = Math.max(1, limit | 0)
  const out = []
  const settle = (t) => Promise.resolve().then(t).then((v) => v, () => null)
  for (let i = 0; i < thunks.length; i += n) {
    const wave = thunks.slice(i, i + n)
    out.push(...(await Promise.all(wave.map(settle))))
    if (staggerMs && i + n < thunks.length) await new Promise((r) => setTimeout(r, staggerMs))
  }
  return out
}
