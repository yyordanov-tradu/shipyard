// Deterministic clustering of findings — replaces the old LLM dedup stage.
//
// Merges findings that describe the SAME issue, computes support k (how many reviewers/
// draws raised it), and is biased to OVER-SPLIT: a false split only costs an extra verify
// call (visible), while a false merge silently loses a real finding (invisible). So the
// rules are conservative and the direction is fixed:
//   merge only when  same file  AND  |line| within lineBand  AND  same severity BAND
//                    AND  title token-overlap >= titleThreshold
// Severity band ('block' = Critical/High, 'advisory' = Medium/Minor) is in the key, so a
// Critical can never fold into a Medium (no down-severization). A cluster keeps the MAX
// severity of its members and the union of contributors. Support is NEVER a drop filter.

const SEV_ORDER = ['Critical', 'High', 'Medium', 'Minor']
const rank = (s) => { const i = SEV_ORDER.indexOf(s); return i < 0 ? SEV_ORDER.length : i }
const band = (s) => (s === 'Critical' || s === 'High') ? 'block' : 'advisory'

function tokens(title) {
  return new Set(String(title || '').toLowerCase().match(/[a-z0-9]+/g) || [])
}
// Overlap coefficient: |A∩B| / min(|A|,|B|) — robust to one title being longer than the other.
function titleOverlap(a, b) {
  const ta = tokens(a), tb = tokens(b)
  if (!ta.size || !tb.size) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  return inter / Math.min(ta.size, tb.size)
}

function sameIssue(x, y, lineBand, titleThreshold) {
  return x.file === y.file &&
    Math.abs((x.line || 0) - (y.line || 0)) <= lineBand &&
    band(x.severity) === band(y.severity) &&
    titleOverlap(x.title, y.title) >= titleThreshold
}

export function unionFindings(findings, { lineBand = 2, titleThreshold = 0.5 } = {}) {
  const clusters = []
  for (const f of findings) {
    const c = clusters.find((c) => sameIssue(c.rep, f, lineBand, titleThreshold))
    if (c) {
      c.members.push(f)
      if (rank(f.severity) < rank(c.rep.severity)) c.rep = f // keep the most-severe framing
    } else {
      clusters.push({ rep: f, members: [f] })
    }
  }
  return clusters.map((c) => ({
    ...c.rep,
    severity: c.rep.severity, // rep is the max-severity member
    support: c.members.length,
    experts: [...new Set(c.members.map((m) => m.expert || m.unit).filter(Boolean))],
  }))
}
