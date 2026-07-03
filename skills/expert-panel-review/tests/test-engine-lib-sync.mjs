import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The engine runs as a Workflow AsyncFunction body — it cannot `import`, so it carries
// HAND-COPIED inline duplicates of workflows/lib/{parallel,union,units,assemble}.mjs.
// The lib is unit-tested; the inline copy is what actually runs. Nothing links them, so a
// lib fix can go green in tests while the shipped engine keeps the bug (and vice versa).
//
// This guard closes that gap BEHAVIORALLY: it evaluates the engine's real inline functions
// and asserts they produce identical output to the lib on a battery of inputs. It compares
// behavior, not source text — so intentional formatting/helper-name differences are fine,
// but any logic drift between the tested copy and the running copy fails here.

import { parallelLimited as libParallel } from '../../../workflows/lib/parallel.mjs'
import { unionFindings as libUnion } from '../../../workflows/lib/union.mjs'
import { partitionUnits as libPartition, expertForUnit as libExpert, kindForUnit as libKind } from '../../../workflows/lib/units.mjs'
import { verdictOf as libVerdict, assembleReport as libAssemble } from '../../../workflows/lib/assemble.mjs'

// ---- extract the engine's actual inline functions ----
const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '../../../workflows/expert-panel-review.js'), 'utf8')
const START = '// ---------- bounded fan-out'
const END = '// ---------- schemas ----------'
const s = src.indexOf(START), e = src.indexOf(END)
assert.ok(s >= 0 && e > s, 'engine prelude markers moved — update START/END in this guard')
// The slice is the engine's pure prelude (inline lib copies + a few engine helpers); it has
// no runtime globals (args/agent/log/CONFIG all live after the `schemas`/`inputs` markers),
// so it evaluates standalone. Public names match the lib exports; private helpers may differ.
// Import the engine's inline prelude as a real ES module via a data: URL. The source is our
// OWN trusted file (read above from workflows/expert-panel-review.js), not external input;
// this just lets us call the exact functions the engine runs, the same way we import the lib.
const prelude = src.slice(s, e)
const mod = prelude + '\nexport { parallelLimited, unionFindings, partitionUnits, expertForUnit, kindForUnit, verdictOf, assembleReport }\n'
const engine = await import('data:text/javascript,' + encodeURIComponent(mod))

const same = (name, a, b) => assert.deepEqual(a, b, `engine's inline ${name} drifted from workflows/lib — re-sync the inline copy`)

// ---- unionFindings: clustering, support count, max-severity rep ----
{
  const findings = [
    { severity: 'Critical', file: 'a.py', line: 10, title: 'sql injection', detail: 'd1', suggestion: 's1', expert: 'security' },
    { severity: 'High', file: 'a.py', line: 11, title: 'sql injection risk', detail: 'd2', suggestion: 's2', expert: 'python-pro' }, // merges
    { severity: 'Medium', file: 'a.py', line: 40, title: 'unused var', detail: 'd3', suggestion: 's3', expert: 'python-pro' },
    { severity: 'Minor', file: 'b.ts', line: 5, title: 'nit naming', detail: 'd4', suggestion: 's4', unit: 'b.ts' },
    // Boundary pair: token-overlap is EXACTLY 0.5 ({input} shared / min(2,3)), same file, 1 line
    // apart, same band. So the default titleThreshold (0.5) merges these but a drift to a higher
    // default would not — this makes the `undefined`/default-arg vector discriminating.
    { severity: 'Medium', file: 'c.py', line: 20, title: 'unvalidated input', detail: 'd5', suggestion: 's5', expert: 'python-pro' },
    { severity: 'Medium', file: 'c.py', line: 21, title: 'missing input check', detail: 'd6', suggestion: 's6', expert: 'golang-pro' },
  ]
  for (const opts of [undefined, { lineBand: 2, titleThreshold: 0.5 }, { lineBand: 0, titleThreshold: 0.9 }])
    same('unionFindings', engine.unionFindings(findings, opts), libUnion(findings, opts))
}

// ---- partitionUnits: deterministic units + expert routing (incl. deletion-only) ----
{
  const files = ['web/app.tsx', 'svc/handler.py', 'db/001.sql', 'infra/main.tf', 'z.unknown']
  const diffs = new Map([['db/001.sql', '@@ -1,2 +1,1 @@\n-  DROP TABLE x;\n keep']]) // deletion-only
  same('partitionUnits', engine.partitionUnits(files, diffs), libPartition(files, diffs))
  same('partitionUnits(no diffs)', engine.partitionUnits(files), libPartition(files))
}

// ---- kindForUnit / expertForUnit across categories ----
for (const p of ['a.py', 'b.ts', 'c.tsx', 'd.tf', 'm/002_migrate.sql', 'web/x.ts', 'weird.zzz', 'Makefile']) {
  assert.equal(engine.kindForUnit(p), libKind(p), `kindForUnit(${p}) drifted`)
  assert.equal(engine.expertForUnit({ path: p, deletionOnly: false }), libExpert({ path: p, deletionOnly: false }), `expertForUnit(${p}) drifted`)
}
assert.equal(
  engine.expertForUnit({ path: 'a.py', deletionOnly: true }),
  libExpert({ path: 'a.py', deletionOnly: true }),
  'expertForUnit(deletion-only) drifted'
)

// ---- verdictOf across severity / CI / failure combinations ----
for (const [f, opts] of [
  [[{ severity: 'Critical' }], {}],
  [[{ severity: 'High' }, { severity: 'Medium' }], {}],
  [[{ severity: 'Medium' }], {}],
  [[{ severity: 'Minor' }], {}],
  [[], {}],
  [[], { ciRed: true }],
  [[{ severity: 'Minor' }], { blockedByFailure: true }],
])
  assert.equal(engine.verdictOf(f, opts), libVerdict(f, opts), `verdictOf(${JSON.stringify(opts)}) drifted`)

// ---- assembleReport: byte-identical report ----
{
  const arg = {
    findings: [
      { severity: 'Critical', file: 'a.py', line: 1, title: 'boom', detail: 'd', suggestion: 's', expert: 'security', causeFiles: ['x.py'], support: 2, verification: 'confirmed' },
      { severity: 'Medium', file: 'b.py', line: 9, title: 'nit', detail: 'd2', suggestion: 's2', expert: 'python-pro', reproCommand: 'npm test' },
    ],
    ledger: [{ claim: 'migration is idempotent | safe', status: 'verified', evidence: 'e' }],
    failedExperts: ['xcut:security'],
    ciStatus: 'build\tfail\t2m\thttps://x',
    date: '2026-07-03',
    verdict: 'REQUEST-CHANGES',
  }
  assert.equal(engine.assembleReport(arg), libAssemble(arg), "engine's inline assembleReport drifted from workflows/lib/assemble.mjs")
  const empty = { findings: [], ledger: [], failedExperts: [], ciStatus: '', date: '', verdict: 'APPROVE' }
  assert.equal(engine.assembleReport(empty), libAssemble(empty), 'assembleReport(empty) drifted')
}

// ---- parallelLimited: input order + throw→null, identical to the lib ----
{
  const mk = () => [() => Promise.resolve(1), () => { throw new Error('x') }, () => Promise.resolve(3), () => Promise.resolve(4)]
  same('parallelLimited', await engine.parallelLimited(mk(), 2), await libParallel(mk(), 2))
}

console.log('engine-lib sync tests: PASS')
