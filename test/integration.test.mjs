import assert from 'node:assert/strict'
import test from 'node:test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { constants, zstdCompressSync } from 'node:zlib'
import { executeOffline, rollbackOffline, projectKey } from '../lib/migration-core.mjs'

const id = 'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const frame = (text) => zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })

test('offline execute and rollback on isolated Harness root', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-session-migrate-'))
  const root = path.join(base, 'harness'), oldCwd = path.join(base, 'old'), newCwd = path.join(base, 'new')
  await Promise.all([fsp.mkdir(oldCwd), fsp.mkdir(newCwd), fsp.mkdir(path.join(root, 'storages'), { recursive: true })])
  const decoderFile = path.join(base, 'decoder.mjs')
  await fsp.writeFile(decoderFile, 'export const decodeStorageRecord = (row) => [row]\n')
  const sourceDir = path.join(root, 'sessions', projectKey(oldCwd), id)
  await fsp.mkdir(sourceDir, { recursive: true })
  const log = Buffer.concat([
    frame(`${JSON.stringify({ type: 'session', version: 1, id, createdAt: 1, cwd: oldCwd, delegationDepth: 0 })}\n`),
    frame(`${JSON.stringify({ type: 'turn/end', seq: 0, data: { turn: 1, reason: { kind: 'completed' } } })}\n`),
  ])
  await fsp.writeFile(path.join(sourceDir, 'session.jsonl.zstd'), log)
  const oldWs = '11111111-1111-4111-8111-111111111111', newWs = '22222222-2222-4222-8222-222222222222'
  await fsp.writeFile(path.join(root, 'storages', 'workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: [oldWs, newWs], archivedSessionIds: [id] }, tables: { workspaces: { [oldWs]: { path: oldCwd, title: 'old', sessionIds: [id], createdAt: 'x', updatedAt: 'x' }, [newWs]: { path: newCwd, title: 'new', sessionIds: [], createdAt: 'x', updatedAt: 'x' } } } }, null, 2))
  await fsp.writeFile(path.join(root, 'storages', 'session_projcache.json'), JSON.stringify({ unit: { name: 'session_projcache', version: 3 }, global: null, tables: { sessions: { [id]: { identity: { createdAt: 1, cwd: oldCwd }, rows: { title: { val: 'x' } } } } } }, null, 2))
  const plan = { sessionId: id, targetWorkspaceId: newWs, harnessRoot: root, sessionModuleUrl: pathToFileURL(decoderFile).href }
  const result = await executeOffline(plan, { skipStopCheck: true })
  assert.equal(result.ok, true)
  const workspace = JSON.parse(await fsp.readFile(path.join(root, 'storages', 'workspace.json')))
  assert.deepEqual(workspace.global.archivedSessionIds, [id])
  assert.deepEqual(workspace.tables.workspaces[oldWs].sessionIds, [])
  assert.deepEqual(workspace.tables.workspaces[newWs].sessionIds, [id])
  const canonicalNewCwd = await fsp.realpath(newCwd)
  const projection = JSON.parse(await fsp.readFile(path.join(root, 'storages', 'session_projcache.json')))
  assert.equal(projection.tables.sessions[id].identity.cwd, canonicalNewCwd)
  assert.equal(projection.tables.sessions[id].rows.title.val, 'x')
  assert.equal(await fsp.stat(path.join(root, 'sessions', projectKey(canonicalNewCwd), id, 'session.jsonl.zstd')).then(() => true), true)
  await rollbackOffline(result.backupDir, { skipStopCheck: true })
  assert.equal(await fsp.stat(path.join(sourceDir, 'session.jsonl.zstd')).then(() => true), true)
  assert.deepEqual(await fsp.readFile(path.join(sourceDir, 'session.jsonl.zstd')), log)
})
