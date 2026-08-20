import assert from 'node:assert/strict'
import test from 'node:test'
import { constants, zstdCompressSync } from 'node:zlib'
import { projectKey, scanZstdFrames, rewriteSessionLogBuffer, decodePhysicalLog, decodeStorageEvents, normalizePlan } from '../lib/migration-core.mjs'

const frame = (text) => zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
const id = 'session-11111111-2222-4333-8444-555555555555'

test('projectKey follows DSH UTF-16 encoding', () => {
  assert.equal(projectKey('/Users/a/my project'), '--Users-a-my~0020project--')
  assert.equal(projectKey('C:\\work\\demo'), '--C-work-demo--')
})

test('zstd migration changes only header frame', () => {
  const source = Buffer.concat([
    frame(`${JSON.stringify({ type: 'session', version: 1, id, createdAt: 1, cwd: '/old', delegationDepth: 0 })}\n`),
    frame(`${JSON.stringify({ type: 'user/message', seq: 0, data: { id: 'm', role: 'user', content: [], source: { kind: 'user' } } })}\n`),
    frame(`${JSON.stringify({ type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind: 'completed' } } })}\n`),
  ])
  const before = scanZstdFrames(source).frames
  const result = rewriteSessionLogBuffer(source, 'session.jsonl.zstd', { sessionId: id, expectedCwd: '/old', targetCwd: '/new' })
  const after = scanZstdFrames(result.buffer).frames
  assert.equal(decodePhysicalLog(result.buffer, 'session.jsonl.zstd').header.cwd, '/new')
  assert.equal(after.length, before.length)
  for (let i = 1; i < before.length; i += 1) assert.deepEqual(result.buffer.subarray(after[i].start, after[i].end), source.subarray(before[i].start, before[i].end))
})

test('packed storage records expand with contiguous seq', () => {
  const decode = (row) => row.type === 'packed' ? row.items : [row]
  assert.deepEqual(decodeStorageEvents(`${JSON.stringify({ type: 'packed', items: [{ seq: 0 }, { seq: 1 }] })}\n`, decode), [{ seq: 0 }, { seq: 1 }])
  assert.throws(() => decodeStorageEvents(`${JSON.stringify({ seq: 2 })}\n`, decode), /seq gap/i)
})

test('plan requires explicit harness root', () => {
  assert.throws(() => normalizePlan({ sessionId: id, targetWorkspaceId: 'w' }), /harnessRoot/i)
  assert.equal(normalizePlan({ sessionId: id, targetWorkspaceId: 'w', harnessRoot: '/tmp/h' }).harnessRoot, '/tmp/h')
})
