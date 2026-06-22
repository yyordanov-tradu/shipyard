// The deterministic coverage map: turn a change into review UNITS.
//
// `partitionUnits` is a pure function — the SAME changed files yield the SAME ordered
// units and the SAME expert assignment on every run. That determinism is the foundation
// of "same Critical/High across repeated runs": only the agents' noticing inside a unit
// is stochastic, never which code gets a reviewer.

const FE_EXT = ['.tsx', '.jsx', '.vue', '.svelte', '.css', '.scss', '.html']
const FE_DIRS = /(^|\/)(web|ui|frontend)\//
const INFRA_DIRS = /(^|\/)(cdk|infra|infrastructure|terraform|pulumi)\//
const INFRA_EXT = ['.tf', '.tfvars', '.bicep']
const DB_HINTS = [/\.sql$/i, /(^|\/)migrations\//, /(^|\/)alembic\//, /(^|\/)prisma\//, /(^|\/)schema\.[a-z]+$/i]
const LANG_MAP = {
  '.py': 'python-pro', '.ts': 'typescript-pro', '.tsx': 'typescript-pro',
  '.js': 'javascript-pro', '.jsx': 'javascript-pro', '.go': 'golang-pro',
  '.rs': 'rust-pro', '.java': 'java-pro', '.rb': 'ruby-pro', '.kt': 'android-expert',
  '.swift': 'ios-expert', '.php': 'php-pro', '.cs': 'csharp-pro', '.scala': 'scala-pro',
  '.ex': 'elixir-pro', '.exs': 'elixir-pro', '.cpp': 'cpp-pro', '.cc': 'cpp-pro',
  '.cxx': 'cpp-pro', '.c': 'c-pro', '.sql': 'sql-pro',
}

function ext(f) {
  const i = f.lastIndexOf('.')
  return i < 0 ? '' : f.slice(i).toLowerCase()
}

function isFrontend(path) {
  const e = ext(path)
  return !INFRA_DIRS.test(path) && (FE_EXT.includes(e) || (['.ts', '.js'].includes(e) && FE_DIRS.test(path)))
}
function isInfra(path) { return INFRA_DIRS.test(path) || INFRA_EXT.includes(ext(path)) }
function isDb(path) { return DB_HINTS.some((rx) => rx.test(path)) }

// Coarse, human-readable category for the report. Deletion-only overrides it (see partitionUnits).
export function kindForUnit(path) {
  if (isInfra(path)) return 'infra'
  if (isDb(path)) return 'database'
  if (isFrontend(path)) return 'frontend'
  return 'code'
}

// The single reviewer agentType matched to a unit. A frontend file gets the FE expert;
// a plain language file gets its language expert; db/infra get theirs; deletion-only and
// unknown fall to the generalist code-reviewer.
export function expertForUnit(unit) {
  if (unit.deletionOnly) return 'code-reviewer' // removed-safety: focus on what the deletion breaks
  if (isInfra(unit.path)) return 'terraform-specialist'
  if (isDb(unit.path)) return 'database-optimizer'
  if (isFrontend(unit.path)) return 'frontend-developer'
  return LANG_MAP[ext(unit.path)] || 'code-reviewer'
}

// A patch that only removes lines (no added content) — a deleted guard/validation/test.
function isDeletionOnly(patch) {
  if (!patch) return false
  const lines = patch.split('\n')
  const added = lines.some((l) => l.startsWith('+') && !l.startsWith('+++'))
  const removed = lines.some((l) => l.startsWith('-') && !l.startsWith('---'))
  return removed && !added
}

export function partitionUnits(changedFiles, fileDiffs = new Map()) {
  const get = (p) => (typeof fileDiffs.get === 'function' ? fileDiffs.get(p) : fileDiffs[p]) || ''
  const paths = [...new Set(changedFiles)].sort() // dedupe + stable order = determinism
  return paths.map((path, i) => {
    const hunks = get(path)
    const deletionOnly = isDeletionOnly(hunks)
    return { id: `u${i + 1}`, path, kind: deletionOnly ? 'removed-safety' : kindForUnit(path), hunks, deletionOnly }
  })
}
