import assert from 'node:assert/strict'
import test from 'node:test'
import { isDshRuntimeProcessLine } from '../lib/migration-core.mjs'

test('stop check ignores the migration CLI itself', () => {
  assert.equal(isDshRuntimeProcessLine("77100 /Applications/DSH Desktop.app/Contents/Resources/app/node_modules/node/bin/node /x/dsh-session-migrate/bin/migrate-session.mjs execute --plan /x/p.json", 999), false)
})

test('stop check recognizes Desktop and Harness web processes', () => {
  assert.equal(isDshRuntimeProcessLine('1 /Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop', 999), true)
  assert.equal(isDshRuntimeProcessLine('2 /app/node harness-node-entry.mjs /app/@deepseek-ai/dsh/lib/bin.js web --port 1', 999), true)
})

test('stop check ignores unrelated commands that mention the app resources', () => {
  assert.equal(isDshRuntimeProcessLine('3 /Applications/DSH Desktop.app/Contents/Resources/app/node_modules/node/bin/node some-script.mjs', 999), false)
})
