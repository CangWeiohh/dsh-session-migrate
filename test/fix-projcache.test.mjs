import assert from 'node:assert/strict'
import test from 'node:test'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { constants, zstdCompressSync } from 'node:zlib'
import { fixProjectionCache, projectKey } from '../lib/migration-core.mjs'

const id = 'session-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const frame = (text) => zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })

test('fix-projcache rebuilds missing projection cache row with correct identity and title', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-fix-projcache-'))
  const root = path.join(base, 'harness'), cwd = path.join(base, 'workspace')
  await fsp.mkdir(cwd)
  await fsp.mkdir(path.join(root, 'storages'), { recursive: true })
  const decoderFile = path.join(base, 'decoder.mjs')
  await fsp.writeFile(decoderFile, 'export const decodeStorageRecord = (row) => [row]\n')
  const sessionDir = path.join(root, 'sessions', projectKey(cwd), id)
  await fsp.mkdir(sessionDir, { recursive: true })
  const log = Buffer.concat([
    frame(`${JSON.stringify({ type: 'session', version: 1, id, createdAt: 42, cwd, delegationDepth: 0 })}\n`),
    frame(`${JSON.stringify({ type: 'session/title', seq: 0, time: 100, data: { title: 'My Test Title', messageSeqs: [], source: { kind: 'user' } } })}\n`),
    frame(`${JSON.stringify({ type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } })}\n`),
  ])
  await fsp.writeFile(path.join(sessionDir, 'session.jsonl.zstd'), log)
  // Projection cache exists but has NO entry for this session (simulating old delete behavior)
  await fsp.writeFile(path.join(root, 'storages', 'session_projcache.json'), JSON.stringify({ unit: { name: 'session_projcache', version: 3 }, global: null, tables: { sessions: {} } }))

  const result = await fixProjectionCache(root, id, { skipStopCheck: true, sessionModuleUrl: pathToFileURL(decoderFile).href })
  assert.equal(result.ok, true)
  assert.equal(result.title, 'My Test Title')
  assert.equal(result.titleSource, 'user')
  assert.equal(result.headerCwd, cwd)
  assert.equal(result.before, null)

  const projection = JSON.parse(await fsp.readFile(path.join(root, 'storages', 'session_projcache.json')))
  const record = projection.tables.sessions[id]
  assert.equal(record.identity.cwd, cwd)
  assert.equal(record.identity.createdAt, 42)
  assert.equal(record.rows.title.val, 'My Test Title')
  assert.equal(record.rows.title.seq, 0)
})

test('fix-projcache updates existing row with wrong identity.cwd', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-fix-projcache-'))
  const root = path.join(base, 'harness'), cwd = path.join(base, 'workspace')
  await fsp.mkdir(cwd)
  await fsp.mkdir(path.join(root, 'storages'), { recursive: true })
  const decoderFile = path.join(base, 'decoder.mjs')
  await fsp.writeFile(decoderFile, 'export const decodeStorageRecord = (row) => [row]\n')
  const sessionDir = path.join(root, 'sessions', projectKey(cwd), id)
  await fsp.mkdir(sessionDir, { recursive: true })
  const log = Buffer.concat([
    frame(`${JSON.stringify({ type: 'session', version: 1, id, createdAt: 42, cwd, delegationDepth: 0 })}\n`),
    frame(`${JSON.stringify({ type: 'session/title', seq: 0, time: 100, data: { title: 'Correct Title', messageSeqs: [], source: { kind: 'provider', provider: 'test' } } })}\n`),
  ])
  await fsp.writeFile(path.join(sessionDir, 'session.jsonl.zstd'), log)
  // Projection cache has entry with WRONG cwd (old source cwd)
  await fsp.writeFile(path.join(root, 'storages', 'session_projcache.json'), JSON.stringify({ unit: { name: 'session_projcache', version: 3 }, global: null, tables: { sessions: { [id]: { identity: { createdAt: 42, cwd: '/old/path' }, rows: { title: { ver: 1, seq: 0, val: 'Old Title' } } } } } }))

  const result = await fixProjectionCache(root, id, { skipStopCheck: true, sessionModuleUrl: pathToFileURL(decoderFile).href })
  assert.equal(result.ok, true)
  assert.equal(result.title, 'Correct Title')
  assert.equal(result.before.identity.cwd, '/old/path')
  assert.equal(result.before.titleVal, 'Old Title')

  const projection = JSON.parse(await fsp.readFile(path.join(root, 'storages', 'session_projcache.json')))
  const record = projection.tables.sessions[id]
  assert.equal(record.identity.cwd, cwd)
  assert.equal(record.rows.title.val, 'Correct Title')
})

test('fix-projcache handles session without title events', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-fix-projcache-'))
  const root = path.join(base, 'harness'), cwd = path.join(base, 'workspace')
  await fsp.mkdir(cwd)
  await fsp.mkdir(path.join(root, 'storages'), { recursive: true })
  const decoderFile = path.join(base, 'decoder.mjs')
  await fsp.writeFile(decoderFile, 'export const decodeStorageRecord = (row) => [row]\n')
  const sessionDir = path.join(root, 'sessions', projectKey(cwd), id)
  await fsp.mkdir(sessionDir, { recursive: true })
  const log = Buffer.concat([
    frame(`${JSON.stringify({ type: 'session', version: 1, id, createdAt: 42, cwd, delegationDepth: 0 })}\n`),
    frame(`${JSON.stringify({ type: 'turn/end', seq: 0, data: { turn: 1, reason: { kind: 'completed' } } })}\n`),
  ])
  await fsp.writeFile(path.join(sessionDir, 'session.jsonl.zstd'), log)
  await fsp.writeFile(path.join(root, 'storages', 'session_projcache.json'), JSON.stringify({ unit: { name: 'session_projcache', version: 3 }, global: null, tables: { sessions: {} } }))

  const result = await fixProjectionCache(root, id, { skipStopCheck: true, sessionModuleUrl: pathToFileURL(decoderFile).href })
  assert.equal(result.ok, true)
  assert.equal(result.title, null)
  assert.equal(result.headerCwd, cwd)

  const projection = JSON.parse(await fsp.readFile(path.join(root, 'storages', 'session_projcache.json')))
  const record = projection.tables.sessions[id]
  assert.equal(record.identity.cwd, cwd)
  assert.equal(record.rows.title, undefined)
})
