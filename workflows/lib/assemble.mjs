// Deterministic verdict + report assembly — replaces the free-form synthesis agent.
// No LLM here: the same findings always produce the byte-identical report, which kills
// the preamble-leak class of bug and makes the report stable run-to-run.

const SEV_ORDER = ['Critical', 'High', 'Medium', 'Minor']
const esc = (s) => String(s || '').replace(/\|/g, '\\|')

export function verdictOf(findings, { ciRed = false, blockedByFailure = false } = {}) {
  const hasBlocker = findings.some((f) => f.severity === 'Critical' || f.severity === 'High')
  const hasMedium = findings.some((f) => f.severity === 'Medium')
  if (hasBlocker || ciRed || blockedByFailure) return 'REQUEST-CHANGES'
  if (hasMedium) return 'APPROVE-WITH-NITS'
  return 'APPROVE'
}

function fmtFinding(f) {
  const cause = f.causeFiles && f.causeFiles.length ? ` [cause: ${f.causeFiles.join(', ')}]` : ''
  const ver = f.verification ? ` _(${f.verification})_` : ''
  const sup = f.support ? ` _(support ${f.support})_` : ''
  const repro = f.reproCommand ? `\n  - _Reproduce:_ \`${f.reproCommand}\`` : ''
  return `- **[${f.severity}] ${f.title}** (${f.file}:${f.line})${cause} — ${f.detail} _Suggestion:_ ${f.suggestion}${ver}${sup}${repro}`
}

function groupByExpert(findings) {
  const by = {}
  for (const f of findings) (by[f.expert || 'review'] ||= []).push(f)
  return Object.entries(by).map(([ex, fs]) => `## ${ex}\n${fs.map(fmtFinding).join('\n')}`).join('\n\n')
}

export function assembleReport({ findings = [], ledger = [], failedExperts = [], ciStatus = '', date = '', verdict } = {}) {
  const blockers = findings.filter((f) => f.severity === 'Critical' || f.severity === 'High')
  const followups = findings.filter((f) => f.severity === 'Medium' || f.severity === 'Minor')
  const counts = SEV_ORDER.map((s) => `${s}: ${findings.filter((f) => f.severity === s).length}`).join(' / ')
  const out = [`# Expert Panel Review — ${date || 'undated'}`, `**Verdict:** ${verdict}`]
  if (ciStatus.trim()) out.push(`**CI:** ${ciStatus.trim().split('\n')[0]}`)
  out.push(`Severity counts: ${counts}`)
  if (blockers.length) out.push('\n### Blocks merge', groupByExpert(blockers))
  if (followups.length) out.push('\n### Follow-up', groupByExpert(followups))
  if (!blockers.length && !followups.length) out.push('\nNo findings.')
  if (ledger.length) {
    out.push('\n### Verified', '| Claim | Status | Evidence |', '|---|---|---|')
    for (const l of ledger) out.push(`| ${esc(l.claim)} | ${l.status} | ${esc(l.evidence)} |`)
  }
  if (verdict === 'REQUEST-CHANGES')
    out.push('\n_To override a block, record a reason (e.g. a PR comment/label) — overrides are logged, not silent._')
  out.push(`\nExperts that failed to run: ${failedExperts.join(', ') || 'none'}`)
  return out.join('\n') + '\n'
}
