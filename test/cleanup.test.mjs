import assert from 'node:assert/strict'
import test from 'node:test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cleanupOffline, inspectCleanup } from '../lib/migration-core.mjs'

async function committedBackup() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-cleanup-'))
  const backup = path.join(root, '.session-migrate-backups', 'transaction')
  await fsp.mkdir(path.join(backup, 'quarantine'), { recursive: true })
  await fsp.writeFile(path.join(backup, 'quarantine', 'payload'), 'backup bytes')
  await fsp.writeFile(path.join(backup, 'manifest.json'), JSON.stringify({ version: 1, phase: 'COMMITTED', committedAt: '2026-01-01T00:00:00.000Z', plan: { harnessRoot: root, sessionId: 'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }, nodes: [{ id: 'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }] }))
  return { root, backup }
}

test('cleanup previews committed backup without deleting it', async () => {
  const { backup } = await committedBackup()
  const info = await inspectCleanup(backup)
  assert.equal(info.sessionIds.length, 1)
  const preview = await cleanupOffline(backup, { confirm: false, skipStopCheck: true })
  assert.equal(preview.confirmationRequired, true)
  await fsp.stat(backup)
})

test('cleanup deletes only confirmed committed transaction backup', async () => {
  const { backup } = await committedBackup()
  const result = await cleanupOffline(backup, { confirm: true, skipStopCheck: true })
  assert.equal(result.ok, true)
  await assert.rejects(fsp.stat(backup), { code: 'ENOENT' })
})

test('cleanup refuses unfinished transaction backups', async () => {
  const { backup } = await committedBackup()
  const manifest = JSON.parse(await fsp.readFile(path.join(backup, 'manifest.json')))
  manifest.phase = 'SOURCES_QUARANTINED'
  await fsp.writeFile(path.join(backup, 'manifest.json'), JSON.stringify(manifest))
  await assert.rejects(inspectCleanup(backup), /COMMITTED/)
})
