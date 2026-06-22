import assert from 'node:assert/strict'
import { discoverTestCommand } from '../reproduce.mjs'

assert.equal(discoverTestCommand({ packageJson: '{"scripts":{"test":"jest"}}' }), 'npm test', 'package.json test script -> npm test')
assert.equal(discoverTestCommand({ packageJson: '{"name":"x"}' }), null, 'no test script -> null')
assert.equal(discoverTestCommand({ packageJson: 'not json' }), null, 'malformed package.json -> null, no throw')
assert.equal(discoverTestCommand({ pyproject: '[tool.pytest]' }), 'pytest', 'pyproject -> pytest')
assert.equal(discoverTestCommand({ cargo: '[package]' }), 'cargo test', 'Cargo.toml -> cargo test')
assert.equal(discoverTestCommand({ gomod: 'module x' }), 'go test ./...', 'go.mod -> go test')
assert.equal(discoverTestCommand({}), null, 'nothing -> null')
// package.json wins over others when it has a test script
assert.equal(discoverTestCommand({ packageJson: '{"scripts":{"test":"jest"}}', pyproject: '[x]' }), 'npm test')

console.log('reproduce tests: PASS')
