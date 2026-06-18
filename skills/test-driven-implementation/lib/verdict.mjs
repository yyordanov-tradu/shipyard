import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function parseVerdict(text) {
  const m = String(text).match(/verdict\b.*?(READY|NEEDS-WORK|MISALIGNED)/i)
  return m ? m[1].toUpperCase() : null
}

export function pickLatestReport(filenames, slug) {
  const matches = filenames
    .filter(f => f.includes(slug) && /plan-readiness/.test(f) && f.endsWith('.md'))
    .sort()
    .reverse()
  return matches[0] || null
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , reviewsDir, slug] = process.argv
  let out = { verdict: null, reportPath: null }
  try {
    const file = pickLatestReport(readdirSync(reviewsDir), slug)
    if (file) {
      const reportPath = join(reviewsDir, file)
      out = { verdict: parseVerdict(readFileSync(reportPath, 'utf8')), reportPath }
    }
  } catch { /* dir missing -> verdict null */ }
  process.stdout.write(JSON.stringify(out) + '\n')
}
