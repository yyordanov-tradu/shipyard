// Discover the target repo's test command from its manifest files (pure — the caller
// reads the files; this just maps them to a command). Used to offer the verifier an
// OPTIONAL reproduction path (red-on-head / green-on-base). Returns null when none is
// found, in which case reproduction is simply unavailable and the gate says so.
export function discoverTestCommand({ packageJson = '', pyproject = '', cargo = '', gomod = '' } = {}) {
  if (packageJson) {
    try {
      const p = JSON.parse(packageJson)
      if (p.scripts && p.scripts.test) return 'npm test'
    } catch { /* malformed package.json -> fall through */ }
  }
  if (pyproject) return 'pytest'
  if (cargo) return 'cargo test'
  if (gomod) return 'go test ./...'
  return null
}
