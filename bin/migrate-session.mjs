#!/usr/bin/env node
import path from 'node:path'
import process from 'node:process'
import fsp from 'node:fs/promises'
import { cleanupOffline, executeOffline, rollbackOffline, MigrationError } from '../lib/migration-core.mjs'

function value(name) { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1] || null }
function usage() {
  process.stderr.write([
    'Usage:',
    '  dsh-session-migrate dry-run --plan <absolute-plan.json>',
    '  dsh-session-migrate execute --plan <absolute-plan.json>',
    '  dsh-session-migrate rollback --backup <absolute-backup-dir>',
    '  dsh-session-migrate cleanup --backup <absolute-backup-dir> [--yes]',
    '',
    'Fully quit DSH Desktop before running any command.',
  ].join('\n') + '\n')
}
async function readPlan(file) { return JSON.parse(await fsp.readFile(path.resolve(file), 'utf8')) }
async function main() {
  const command = process.argv[2]
  if (command === 'dry-run' || command === 'execute') {
    const file = value('--plan'); if (!file) { usage(); process.exitCode = 2; return }
    console.log(JSON.stringify(await executeOffline(await readPlan(file), { dryRun: command === 'dry-run' }), null, 2)); return
  }
  if (command === 'cleanup') {
    const backup = value('--backup'); if (!backup) { usage(); process.exitCode = 2; return }
    console.log(JSON.stringify(await cleanupOffline(backup, { confirm: process.argv.includes('--yes') }), null, 2)); return
  }
  if (command === 'rollback') {
    const backup = value('--backup'); if (!backup) { usage(); process.exitCode = 2; return }
    console.log(JSON.stringify(await rollbackOffline(backup), null, 2)); return
  }
  usage(); process.exitCode = 2
}
main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: { code: error instanceof MigrationError ? error.code : 'UNEXPECTED_ERROR', message: error instanceof Error ? error.message : String(error), ...(error instanceof MigrationError && error.details !== undefined ? { details: error.details } : {}) } }, null, 2))
  process.exitCode = 1
})
