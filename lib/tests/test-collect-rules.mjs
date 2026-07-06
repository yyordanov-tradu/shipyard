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
  assert.ok(rules.find(r => r.name === 'ok.md').content === 'ok body', 'good content intact');
  chmodSync(join(root, '.claude', 'rules', 'bad.md'), 0o644);
  rmSync(root, { recursive: true, force: true });
}

console.log('collect-rules: PASS');
