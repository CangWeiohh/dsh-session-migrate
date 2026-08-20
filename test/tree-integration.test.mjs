import assert from 'node:assert/strict'
import test from 'node:test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { constants, zstdCompressSync } from 'node:zlib'
import { executeOffline, rollbackOffline, projectKey } from '../lib/migration-core.mjs'

const rootId = 'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const childId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'
const frame = (text) => zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })

async function writeSession(root, cwd, id, parentSession) {
  const dir = path.join(root, 'sessions', projectKey(cwd), id)
  await fsp.mkdir(dir, { recursive: true })
  const header = { type: 'session', version: 1, id, createdAt: 1, cwd, delegationDepth: parentSession ? 1 : 0, ...(parentSession ? { parentSession, origin: 'subagent' } : {}) }
  const log = Buffer.concat([
    frame(`${JSON.stringify(header)}\n`),
    frame(`${JSON.stringify({ type: 'turn/end', seq: 0, data: { turn: 1, reason: { kind: 'completed' } } })}\n`),
  ])
  await fsp.writeFile(path.join(dir, 'session.jsonl.zstd'), log)
  return { dir, log }
}

test('offline execute and rollback migrate the whole session tree', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-session-tree-'))
  const root = path.join(base, 'harness'), oldCwd = path.join(base, 'old'), newCwd = path.join(base, 'new')
  await Promise.all([fsp.mkdir(oldCwd), fsp.mkdir(newCwd), fsp.mkdir(path.join(root, 'storages'), { recursive: true })])
  const decoderFile = path.join(base, 'decoder.mjs')
  await fsp.writeFile(decoderFile, 'export const decodeStorageRecord = (row) => [row]\n')
  const rootSession = await writeSession(root, oldCwd, rootId)
  const childSession = await writeSession(root, oldCwd, childId, rootId)
  const oldWs = '11111111-1111-4111-8111-111111111111', newWs = '22222222-2222-4222-8222-222222222222'
  await fsp.writeFile(path.join(root, 'storages', 'workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 }, global: { initialized: true, workspaceIds: [oldWs, newWs], archivedSessionIds: [] }, tables: { workspaces: { [oldWs]: { path: oldCwd, title: 'old', sessionIds: [rootId], createdAt: 'x', updatedAt: 'x' }, [newWs]: { path: newCwd, title: 'new', sessionIds: [], createdAt: 'x', updatedAt: 'x' } } } }, null, 2))
  await fsp.writeFile(path.join(root, 'storages', 'session_projcache.json'), JSON.stringify({ unit: { name: 'session_projcache', version: 3 }, global: null, tables: { sessions: { [rootId]: { identity: { cwd: oldCwd }, rows: {} }, [childId]: { identity: { cwd: oldCwd }, rows: {} } } } }, null, 2))
  const plan = { sessionId: rootId, targetWorkspaceId: newWs, harnessRoot: root, sessionModuleUrl: pathToFileURL(decoderFile).href }
  const dry = await executeOffline(plan, { dryRun: true, skipStopCheck: true })
  assert.deepEqual(dry.summary.sessionIds, [rootId, childId])
  const result = await executeOffline(plan, { skipStopCheck: true })
  const canonical = await fsp.realpath(newCwd)
  for (const id of [rootId, childId]) await fsp.stat(path.join(root, 'sessions', projectKey(canonical), id, 'session.jsonl.zstd'))
  const workspace = JSON.parse(await fsp.readFile(path.join(root, 'storages', 'workspace.json')))
  assert.deepEqual(workspace.tables.workspaces[newWs].sessionIds, [rootId])
  const projection = JSON.parse(await fsp.readFile(path.join(root, 'storages', 'session_projcache.json')))
  assert.equal(projection.tables.sessions[rootId], undefined)
  assert.equal(projection.tables.sessions[childId], undefined)
  await rollbackOffline(result.backupDir, { skipStopCheck: true })
  assert.deepEqual(await fsp.readFile(path.join(rootSession.dir, 'session.jsonl.zstd')), rootSession.log)
  assert.deepEqual(await fsp.readFile(path.join(childSession.dir, 'session.jsonl.zstd')), childSession.log)
})
