import { pathToFileURL } from 'node:url'

export function sequenceGate({ typecheck, lint, test } = {}) {
  const order = [['typecheck', typecheck], ['lint', lint], ['test', test]]
  const steps = []
  const skipped = []
  for (const [name, cmd] of order) {
    if (cmd) steps.push({ name, cmd })
    else skipped.push(name)
  }
  return { steps, skipped }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmds = process.argv[2] ? JSON.parse(process.argv[2]) : {}
  process.stdout.write(JSON.stringify(sequenceGate(cmds)) + '\n')
}
