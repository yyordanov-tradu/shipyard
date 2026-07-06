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
