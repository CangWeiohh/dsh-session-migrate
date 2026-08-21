import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
const SESSION_ID_RE = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PLAN_VERSION = 1
const TX_VERSION = 1

export class MigrationError extends Error {
  constructor(message, code = 'MIGRATION_FAILED', details) {
    super(message)
    this.name = 'MigrationError'
    this.code = code
    this.details = details
  }
}

export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new TypeError('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

function projectKeysEqual(actual, expected) {
  return process.platform === 'darwin'
    ? actual.toLocaleLowerCase('en-US') === expected.toLocaleLowerCase('en-US')
    : actual === expected
}

export function encodeSegment(raw) {
  const value = String(raw || '')
  if (!value) throw new TypeError('cannot encode an empty path segment')
  if (value === '.') return '~002E'
  if (value === '..') return '~002E~002E'
  let output = ''
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    const ch = String.fromCharCode(code)
    output += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch) ? ch : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return output
}

export function scanZstdFrames(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('scanZstdFrames expects a Buffer')
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new MigrationError(`invalid Zstandard frame magic at byte ${offset}`, 'CORRUPT_ZSTD_LOG')
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset++)
    if ((descriptor & 0x18) !== 0) throw new MigrationError(`reserved Zstandard frame-header bit at byte ${offset - 1}`, 'CORRUPT_ZSTD_LOG')
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 0 ? 0 : dictionaryFlag === 1 ? 1 : dictionaryFlag === 2 ? 2 : 4
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const headerBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < headerBytes) return { frames, tornStart: start }
    offset += headerBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new MigrationError(`reserved Zstandard block type at byte ${offset - 3}`, 'CORRUPT_ZSTD_LOG')
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

function parseHeader(text) {
  let header
  try { header = JSON.parse(text.trim()) } catch (error) {
    throw new MigrationError(`session header is not valid JSON: ${String(error)}`, 'CORRUPT_SESSION_HEADER')
  }
  if (!header || header.type !== 'session' || typeof header.id !== 'string' || !Number.isSafeInteger(header.version)) {
    throw new MigrationError('session log does not begin with a valid session header', 'CORRUPT_SESSION_HEADER')
  }
  return header
}

export function decodePhysicalLog(buffer, filename) {
  if (filename.endsWith('.jsonl.zstd')) {
    const scan = scanZstdFrames(buffer)
    if (scan.tornStart !== undefined) throw new MigrationError(`incomplete Zstandard frame at byte ${scan.tornStart}`, 'TORN_SESSION_LOG')
    if (scan.frames.length === 0) throw new MigrationError('session log contains no frames', 'EMPTY_SESSION_LOG')
    const plaintext = scan.frames.map((frame) => zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
    const headerText = plaintext[0].toString('utf8')
    if (!headerText.endsWith('\n') || headerText.indexOf('\n') !== headerText.length - 1) throw new MigrationError('first frame is not exactly one header line', 'CORRUPT_SESSION_HEADER')
    return { header: parseHeader(headerText), bodyText: Buffer.concat(plaintext.slice(1)).toString('utf8'), frames: scan.frames }
  }
  if (filename.endsWith('.jsonl')) {
    const newline = buffer.indexOf(0x0a)
    if (newline < 0) throw new MigrationError('plaintext log has no header line', 'CORRUPT_SESSION_HEADER')
    return { header: parseHeader(buffer.subarray(0, newline).toString('utf8')), bodyText: buffer.subarray(newline + 1).toString('utf8'), frames: null }
  }
  throw new MigrationError(`unsupported session log encoding: ${filename}`, 'UNSUPPORTED_SESSION_LOG')
}

export function rewriteSessionLogBuffer(source, filename, { sessionId, expectedCwd, targetCwd }) {
  if (!Buffer.isBuffer(source)) throw new TypeError('source must be a Buffer')
  if (!targetCwd) throw new TypeError('targetCwd must be a non-empty string')
  const decoded = decodePhysicalLog(source, filename)
  if (decoded.header.id !== sessionId) throw new MigrationError(`session header id mismatch: ${decoded.header.id}`, 'SESSION_ID_MISMATCH')
  if (expectedCwd !== undefined && decoded.header.cwd !== expectedCwd) throw new MigrationError(`session header cwd mismatch: ${String(decoded.header.cwd)}`, 'SESSION_CWD_MISMATCH')
  const after = { ...decoded.header, cwd: targetCwd }
  let buffer
  if (decoded.frames) {
    const first = zstdCompressSync(Buffer.from(`${JSON.stringify(after)}\n`), { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } })
    buffer = Buffer.concat([first, source.subarray(decoded.frames[0].end)])
    const verify = decodePhysicalLog(buffer, filename)
    if (verify.frames.length !== decoded.frames.length || !buffer.subarray(verify.frames[0].end).equals(source.subarray(decoded.frames[0].end))) {
      throw new MigrationError('event frames changed during header rewrite', 'EVENT_FRAMES_CHANGED')
    }
  } else {
    const newline = source.indexOf(0x0a)
    buffer = Buffer.concat([Buffer.from(`${JSON.stringify(after)}\n`), source.subarray(newline + 1)])
  }
  return { buffer, before: decoded.header, after, frameCount: decoded.frames?.length ?? null }
}

export function decodeStorageEvents(bodyText, decodeStorageRecord) {
  const events = []
  for (const [index, line] of bodyText.split('\n').entries()) {
    if (!line) continue
    let row
    try { row = JSON.parse(line) } catch (error) {
      throw new MigrationError(`invalid event JSON at body line ${index + 1}: ${String(error)}`, 'CORRUPT_EVENT_JSON')
    }
    let expanded
    try { expanded = decodeStorageRecord(row) } catch (error) {
      throw new MigrationError(`unsupported/corrupt storage record at body line ${index + 1}: ${String(error)}`, 'UNSUPPORTED_EVENT_RECORD')
    }
    if (!Array.isArray(expanded)) throw new MigrationError('decodeStorageRecord returned a non-array', 'INVALID_DECODER')
    for (const event of expanded) {
      if (event.seq !== events.length) throw new MigrationError(`event seq gap: expected ${events.length}, got ${String(event.seq)}`, 'EVENT_SEQ_GAP')
      events.push(event)
    }
  }
  return events
}

export function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
export function hashBuffer(value) { return crypto.createHash('sha256').update(value).digest('hex') }
export function sha256Text(value) { return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex') }

async function exists(target) { try { await fsp.access(target); return true } catch (error) { if (error?.code === 'ENOENT') return false; throw error } }
async function isDirectory(target) { try { return (await fsp.stat(target)).isDirectory() } catch (error) { if (error?.code === 'ENOENT') return false; throw error } }
async function readJson(file) { return JSON.parse(await fsp.readFile(file, 'utf8')) }
async function fsyncFile(file) { const h = await fsp.open(file, 'r'); try { await h.sync() } finally { await h.close() } }
async function fsyncDir(dir) { if (process.platform === 'win32') return; const h = await fsp.open(dir, 'r'); try { await h.sync() } finally { await h.close() } }
async function atomicWrite(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  try { await fsp.writeFile(tmp, content, { flag: 'wx', mode: 0o600 }); await fsyncFile(tmp); await fsp.rename(tmp, file); await fsyncDir(path.dirname(file)) }
  finally { await fsp.rm(tmp, { force: true }).catch(() => {}) }
}
async function atomicJson(file, value) { await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`) }
async function copyDir(source, target) { await fsp.cp(source, target, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true }) }
function stamp() { return new Date().toISOString().replace(/[:.]/g, '-') }

export function normalizePlan(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new MigrationError('plan must be an object', 'INVALID_PLAN')
  const sessionId = String(raw.sessionId || '').trim()
  const targetWorkspaceId = String(raw.targetWorkspaceId || '').trim()
  const harnessRoot = path.resolve(String(raw.harnessRoot || ''))
  if (!SESSION_ID_RE.test(sessionId)) throw new MigrationError(`invalid session id: ${sessionId}`, 'INVALID_SESSION_ID')
  if (!targetWorkspaceId) throw new MigrationError('targetWorkspaceId is required', 'TARGET_WORKSPACE_REQUIRED')
  if (!raw.harnessRoot) throw new MigrationError('harnessRoot is required; cwd fallback is forbidden', 'HARNESS_ROOT_REQUIRED')
  return {
    version: PLAN_VERSION, sessionId, targetWorkspaceId, harnessRoot,
    sessionModuleUrl: String(raw.sessionModuleUrl || ''),
    nodeExecutable: path.resolve(String(raw.nodeExecutable || process.execPath)),
    cliFile: raw.cliFile ? path.resolve(String(raw.cliFile)) : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
  }
}

async function artifacts(root) {
  const out = []
  const sessionsRoot = path.join(root, 'sessions')
  for (const project of await fsp.readdir(sessionsRoot, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    for (const session of await fsp.readdir(path.join(sessionsRoot, project.name), { withFileTypes: true })) {
      if (!session.isDirectory()) continue
      for (const filename of ['session.jsonl.zstd', 'session.jsonl']) {
        const logPath = path.join(sessionsRoot, project.name, session.name, filename)
        if (await exists(logPath)) out.push({ projectKey: project.name, sessionDir: path.dirname(logPath), logPath, filename })
      }
    }
  }
  return out
}

async function sessionCatalog(root) {
  const rows = []
  for (const artifact of await artifacts(root)) {
    const buffer = await fsp.readFile(artifact.logPath)
    const { header } = decodePhysicalLog(buffer, artifact.filename)
    rows.push({ ...artifact, buffer, header })
  }
  return rows
}

async function loadDecoder(plan) {
  if (!plan.sessionModuleUrl) throw new MigrationError('plan has no exact DSH session module URL', 'SESSION_DECODER_REQUIRED')
  let mod
  try { mod = await import(plan.sessionModuleUrl) } catch (error) {
    throw new MigrationError(`cannot load exact DSH session decoder: ${String(error)}`, 'SESSION_DECODER_UNAVAILABLE')
  }
  if (typeof mod.decodeStorageRecord !== 'function') throw new MigrationError('DSH session module does not export decodeStorageRecord', 'SESSION_DECODER_UNAVAILABLE')
  return mod.decodeStorageRecord
}

function collectSessionTree(catalog, rootId) {
  const byId = new Map(catalog.map((row) => [String(row.header.id), row]))
  const root = byId.get(rootId)
  if (!root) throw new MigrationError(`session not found: ${rootId}`, 'SESSION_NOT_FOUND')
  if (root.header.parentSession) throw new MigrationError(`selected session is a child of ${root.header.parentSession}; select the root session`, 'SESSION_TREE_ROOT_REQUIRED')
  const childrenByParent = new Map()
  for (const row of catalog) {
    if (!row.header.parentSession) continue
    const parent = String(row.header.parentSession)
    const list = childrenByParent.get(parent) ?? []
    list.push(row)
    childrenByParent.set(parent, list)
  }
  const nodes = []
  const queue = [root]
  const seen = new Set()
  while (queue.length) {
    const row = queue.shift()
    const id = String(row.header.id)
    if (seen.has(id)) throw new MigrationError(`cycle or duplicate in session tree at ${id}`, 'INVALID_SESSION_TREE')
    seen.add(id)
    nodes.push(row)
    for (const child of childrenByParent.get(id) ?? []) queue.push(child)
  }
  return nodes
}

export async function inspectPlan(rawPlan, { allowAlreadyInTarget = false, allowExistingTarget = false } = {}) {
  const plan = normalizePlan(rawPlan)
  const workspaceFile = path.join(plan.harnessRoot, 'storages', 'workspace.json')
  const projectionFile = path.join(plan.harnessRoot, 'storages', 'session_projcache.json')
  if (!(await exists(workspaceFile))) throw new MigrationError(`workspace storage not found: ${workspaceFile}`, 'WORKSPACE_NOT_FOUND')
  const workspace = await readJson(workspaceFile)
  if (workspace?.unit?.name !== 'workspace' || workspace.unit.version !== 2) throw new MigrationError('only workspace domain v2 is supported', 'UNSUPPORTED_WORKSPACE_VERSION')
  const workspaceRows = workspace?.tables?.workspaces
  const target = workspaceRows?.[plan.targetWorkspaceId]
  if (!target) throw new MigrationError('target workspace not found', 'TARGET_WORKSPACE_NOT_FOUND')
  const targetCwd = await fsp.realpath(target.path)
  if (!(await isDirectory(targetCwd))) throw new MigrationError('target workspace is not a directory', 'TARGET_NOT_DIRECTORY')
  const catalog = await sessionCatalog(plan.harnessRoot)
  const treeRows = collectSessionTree(catalog, plan.sessionId)
  const decoder = await loadDecoder(plan)
  const nodes = []
  for (const source of treeRows) {
    const id = String(source.header.id)
    const duplicates = catalog.filter((row) => String(row.header.id) === id)
    if (duplicates.length !== 1) throw new MigrationError(`expected one artifact for ${id}, found ${duplicates.length}`, 'DUPLICATE_SESSION_ARTIFACTS')
    if (!source.header.cwd) throw new MigrationError(`session ${id} has no cwd`, 'SESSION_CWD_MISSING')
    if (!projectKeysEqual(source.projectKey, projectKey(source.header.cwd))) throw new MigrationError(`session ${id} header/path identity mismatch: directory ${source.projectKey}, expected ${projectKey(source.header.cwd)}`, 'SESSION_PATH_MISMATCH')
    const sourceCanonical = await fsp.realpath(source.header.cwd).catch(() => source.header.cwd)
    if (!allowAlreadyInTarget && sourceCanonical === targetCwd) throw new MigrationError(`session ${id} is already in target workspace`, 'ALREADY_IN_TARGET')
    const targetDir = path.join(plan.harnessRoot, 'sessions', projectKey(targetCwd), encodeSegment(id))
    if (!allowExistingTarget && await exists(targetDir)) throw new MigrationError(`target directory exists for ${id}`, 'TARGET_EXISTS')
    const physical = decodePhysicalLog(source.buffer, source.filename)
    const events = decodeStorageEvents(physical.bodyText, decoder)
    nodes.push({
      id,
      source,
      targetDir,
      targetLogPath: path.join(targetDir, source.filename),
      beforeEvents: events,
      beforeEventsHash: hashJson(events),
      sourceHash: hashBuffer(source.buffer),
    })
  }
  const sourceWorkspaceIds = Object.entries(workspaceRows).filter(([, row]) => row.sessionIds?.includes(plan.sessionId)).map(([id]) => id)
  if (sourceWorkspaceIds.length > 1) throw new MigrationError('root session belongs to multiple workspaces', 'MULTIPLE_WORKSPACES')
  return {
    plan, workspaceFile, projectionFile, workspace, workspaceRows, target, targetCwd, catalog, decoder, nodes,
    source: nodes[0].source,
    targetDir: nodes[0].targetDir,
    targetLogPath: nodes[0].targetLogPath,
    beforeEvents: nodes[0].beforeEvents,
    beforeEventsHash: nodes[0].beforeEventsHash,
    sourceHash: nodes[0].sourceHash,
    sourceWorkspaceId: sourceWorkspaceIds[0] ?? null,
  }
}

export function isDshRuntimeProcessLine(line, currentPid = process.pid) {
  const match = /^\s*(\d+)\s+(.*)$/.exec(line)
  if (!match) return false
  const pid = Number(match[1])
  const command = match[2]
  if (pid === currentPid || command.includes('/dsh-session-migrate/bin/migrate-session.mjs')) return false
  return /DSH Desktop\.app\/Contents\/MacOS\/DSH Desktop/.test(command)
    || /harness-node-entry\.mjs/.test(command)
    || /@deepseek-ai\/dsh\/lib\/bin\.js\s+web(?:\s|$)/.test(command)
}

export function assertDshStopped(harnessRoot, { stabilityMs = 1200 } = {}) {
  let processes
  try { processes = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' }) }
  catch (error) { throw new MigrationError(`cannot prove DSH stopped because ps failed: ${String(error)}`, 'STOP_CHECK_UNAVAILABLE') }
  const suspicious = processes.split('\n').filter((line) => isDshRuntimeProcessLine(line))
  if (suspicious.length) throw new MigrationError('DSH Desktop or Harness is still running', 'DSH_RUNNING', { processes: suspicious })
  try {
    const open = execFileSync('lsof', ['+D', harnessRoot], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (open.trim()) throw new MigrationError('a process still has Harness files open', 'DSH_RUNNING', { lsof: open })
  } catch (error) {
    if (error instanceof MigrationError) throw error
    if (error?.status !== 1) throw new MigrationError(`cannot prove Harness files are closed: ${String(error)}`, 'STOP_CHECK_UNAVAILABLE')
  }
  return stabilityMs
}

async function stableFingerprint(files, delayMs) {
  const take = async () => Promise.all(files.filter(Boolean).map(async (file) => { const s = await fsp.stat(file); return [file, String(s.ino), s.size, s.mtimeMs, s.ctimeMs] }))
  const before = await take()
  await new Promise((resolve) => setTimeout(resolve, delayMs))
  const after = await take()
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new MigrationError('Harness files changed during stability window', 'HARNESS_NOT_STABLE')
}

async function migrateRecall({ root, sessionId, sourceCwd, targetCwd, backupDir }) {
  const warnings = []
  const created = []
  const candidates = [
    [path.join(root, 'dsh-recall-snapshots', sha256Text(sourceCwd)), path.join(root, 'dsh-recall-snapshots', sha256Text(targetCwd)), 'harness'],
    [path.join(os.homedir(), 'dsh-recall-snapshots', sha256Text(sourceCwd)), path.join(os.homedir(), 'dsh-recall-snapshots', sha256Text(targetCwd)), 'home'],
    [path.join(sourceCwd, '.dsh-recall-snapshots'), path.join(targetCwd, '.dsh-recall-snapshots'), 'fallback'],
  ]
  const seen = new Set()
  for (const [source, target, label] of candidates) {
    const key = `${path.resolve(source)}\0${path.resolve(target)}`
    if (seen.has(key) || !(await isDirectory(source))) continue
    seen.add(key)
    let entries
    try { entries = JSON.parse(await fsp.readFile(path.join(source, 'index.json'), 'utf8')) } catch { continue }
    const selected = Array.isArray(entries) ? entries.filter((entry) => String(entry?.sessionId || '') === sessionId) : []
    if (!selected.length) continue
    if (await exists(target)) { warnings.push(`${label}: target Recall store exists; source snapshots were preserved unchanged`); continue }
    try {
      await copyDir(source, path.join(backupDir, 'recall', label))
      await fsp.mkdir(path.dirname(target), { recursive: true })
      await copyDir(source, target)
      await atomicJson(path.join(target, 'index.json'), selected.map((entry) => ({ ...entry, root: targetCwd })))
      await atomicWrite(path.join(target, 'root.txt'), `${targetCwd}\n`)
      created.push(target)
    } catch (error) { await fsp.rm(target, { recursive: true, force: true }).catch(() => {}); warnings.push(`${label}: Recall copy skipped: ${String(error)}`) }
  }
  return { warnings, created }
}

async function restore(backupDir) {
  const manifest = await readJson(path.join(backupDir, 'manifest.json'))
  for (const target of manifest.recallCreated ?? []) await fsp.rm(target, { recursive: true, force: true })
  for (const node of manifest.nodes ?? []) {
    await fsp.rm(node.targetDir, { recursive: true, force: true })
    await fsp.rm(node.sourceDir, { recursive: true, force: true })
    const quarantined = path.join(backupDir, 'quarantine', encodeSegment(node.id))
    if (await exists(quarantined)) {
      await fsp.mkdir(path.dirname(node.sourceDir), { recursive: true })
      await fsp.rename(quarantined, node.sourceDir)
    } else {
      await copyDir(path.join(backupDir, 'sessions-original', encodeSegment(node.id)), node.sourceDir)
    }
  }
  await fsp.copyFile(path.join(backupDir, 'workspace.json.orig'), manifest.workspaceFile)
  if (manifest.projectionExisted) await fsp.copyFile(path.join(backupDir, 'session_projcache.json.orig'), manifest.projectionFile)
  else await fsp.rm(manifest.projectionFile, { force: true })
  return manifest
}

export async function executeOffline(rawPlan, { dryRun = false, skipStopCheck = false } = {}) {
  const preview = await inspectPlan(rawPlan)
  if (!skipStopCheck) {
    const delay = assertDshStopped(preview.plan.harnessRoot)
    const stableFiles = [preview.workspaceFile, (await exists(preview.projectionFile)) ? preview.projectionFile : null, ...preview.nodes.map((node) => node.source.logPath)]
    await stableFingerprint(stableFiles, delay)
    Object.assign(preview, await inspectPlan(rawPlan))
  }
  const summary = {
    sessionId: preview.plan.sessionId,
    sessionIds: preview.nodes.map((node) => node.id),
    descendantCount: preview.nodes.length - 1,
    sourceCwd: preview.source.header.cwd,
    targetCwd: preview.targetCwd,
    sourceWorkspaceId: preview.sourceWorkspaceId,
    targetWorkspaceId: preview.plan.targetWorkspaceId,
    eventCount: preview.nodes.reduce((total, node) => total + node.beforeEvents.length, 0),
  }
  if (dryRun) return { ok: true, dryRun: true, summary }
  const lockFile = path.join(preview.plan.harnessRoot, '.session-migrate.lock')
  let lock
  try { lock = await fsp.open(lockFile, 'wx', 0o600) } catch (error) { throw new MigrationError(`migration lock unavailable: ${String(error)}`, 'MIGRATION_LOCKED') }
  const backupDir = path.join(preview.plan.harnessRoot, '.session-migrate-backups', `${stamp()}-${encodeSegment(preview.plan.sessionId)}`)
  await fsp.mkdir(path.join(backupDir, 'sessions-original'), { recursive: true, mode: 0o700 })
  await fsp.mkdir(path.join(backupDir, 'quarantine'), { recursive: true, mode: 0o700 })
  const projectionExisted = await exists(preview.projectionFile)
  for (const node of preview.nodes) await copyDir(node.source.sessionDir, path.join(backupDir, 'sessions-original', encodeSegment(node.id)))
  await fsp.copyFile(preview.workspaceFile, path.join(backupDir, 'workspace.json.orig'))
  if (projectionExisted) await fsp.copyFile(preview.projectionFile, path.join(backupDir, 'session_projcache.json.orig'))
  const manifest = {
    version: TX_VERSION, phase: 'BACKED_UP', plan: preview.plan,
    workspaceFile: preview.workspaceFile, projectionFile: preview.projectionFile, projectionExisted,
    nodes: preview.nodes.map((node) => ({ id: node.id, sourceDir: node.source.sessionDir, targetDir: node.targetDir, sourceHash: node.sourceHash })),
    recallCreated: [],
  }
  await atomicJson(path.join(backupDir, 'manifest.json'), manifest)
  try {
    for (const node of preview.nodes) {
      const rewritten = rewriteSessionLogBuffer(node.source.buffer, node.source.filename, { sessionId: node.id, expectedCwd: node.source.header.cwd, targetCwd: preview.targetCwd })
      const staging = `${node.targetDir}.staging-${process.pid}-${crypto.randomBytes(5).toString('hex')}`
      await fsp.mkdir(path.dirname(node.targetDir), { recursive: true })
      await copyDir(node.source.sessionDir, staging)
      await atomicWrite(path.join(staging, node.source.filename), rewritten.buffer)
      const stagedDecoded = decodePhysicalLog(await fsp.readFile(path.join(staging, node.source.filename)), node.source.filename)
      const stagedEvents = decodeStorageEvents(stagedDecoded.bodyText, preview.decoder)
      if (stagedDecoded.header.cwd !== preview.targetCwd || hashJson(stagedEvents) !== node.beforeEventsHash) throw new MigrationError(`staged verification failed for ${node.id}`, 'STAGING_VERIFY_FAILED')
      await fsp.rename(staging, node.targetDir)
    }
    manifest.phase = 'TARGETS_PUBLISHED'; await atomicJson(path.join(backupDir, 'manifest.json'), manifest)
    const nextWorkspace = structuredClone(preview.workspace)
    for (const row of Object.values(nextWorkspace.tables.workspaces)) row.sessionIds = row.sessionIds.filter((id) => id !== preview.plan.sessionId)
    const target = nextWorkspace.tables.workspaces[preview.plan.targetWorkspaceId]
    target.sessionIds.unshift(preview.plan.sessionId)
    const now = new Date().toISOString(); target.updatedAt = now
    if (preview.sourceWorkspaceId) nextWorkspace.tables.workspaces[preview.sourceWorkspaceId].updatedAt = now
    await atomicJson(preview.workspaceFile, nextWorkspace)
    if (projectionExisted) {
      const projection = await readJson(preview.projectionFile)
      if (projection?.unit?.name !== 'session_projcache' || projection.unit.version !== 3) throw new MigrationError('only projection cache v3 is supported', 'UNSUPPORTED_PROJECTION_VERSION')
      if (projection.tables?.sessions) for (const node of preview.nodes) delete projection.tables.sessions[node.id]
      await atomicJson(preview.projectionFile, projection)
    }
    manifest.phase = 'METADATA_UPDATED'; await atomicJson(path.join(backupDir, 'manifest.json'), manifest)
    for (const node of preview.nodes) await fsp.rename(node.source.sessionDir, path.join(backupDir, 'quarantine', encodeSegment(node.id)))
    manifest.phase = 'SOURCES_QUARANTINED'; await atomicJson(path.join(backupDir, 'manifest.json'), manifest)
    const recall = await migrateRecall({ root: preview.plan.harnessRoot, sessionId: preview.plan.sessionId, sourceCwd: preview.source.header.cwd, targetCwd: preview.targetCwd, backupDir })
    manifest.recallCreated = recall.created
    const final = await inspectPlan(rawPlan, { allowAlreadyInTarget: true, allowExistingTarget: true }).catch((error) => { throw new MigrationError(`post-migration inspection failed: ${String(error)}`, 'POST_VERIFY_FAILED') })
    if (final.nodes.length !== preview.nodes.length) throw new MigrationError('post-migration tree size mismatch', 'POST_VERIFY_FAILED')
    for (const before of preview.nodes) {
      const after = final.nodes.find((node) => node.id === before.id)
      if (!after || after.source.header.cwd !== preview.targetCwd || after.beforeEventsHash !== before.beforeEventsHash) throw new MigrationError(`post-migration content mismatch for ${before.id}`, 'POST_VERIFY_FAILED')
    }
    manifest.phase = 'COMMITTED'; manifest.committedAt = new Date().toISOString(); await atomicJson(path.join(backupDir, 'manifest.json'), manifest)
    return { ok: true, dryRun: false, backupDir, summary, warnings: recall.warnings, reloadRequired: true }
  } catch (error) {
    try { await restore(backupDir) } catch (rollbackError) { throw new MigrationError(`${String(error)}; rollback failed: ${String(rollbackError)}`, 'ROLLBACK_FAILED', { backupDir }) }
    throw new MigrationError(`${String(error)}; changes rolled back`, error?.code || 'MIGRATION_FAILED', { backupDir, rolledBack: true })
  } finally { await lock?.close().catch(() => {}); await fsp.rm(lockFile, { force: true }).catch(() => {}) }
}

export async function rollbackOffline(backupDir, { skipStopCheck = false } = {}) {
  const root = path.resolve(backupDir)
  const manifest = await readJson(path.join(root, 'manifest.json'))
  if (!skipStopCheck) assertDshStopped(manifest.plan.harnessRoot)
  await restore(root)
  await atomicJson(path.join(root, 'rollback.json'), { rolledBackAt: new Date().toISOString(), sessionId: manifest.plan.sessionId })
  return { ok: true, sessionId: manifest.plan.sessionId, backupDir: root }
}

export async function createPlanFile(input) {
  const plan = normalizePlan(input)
  const dir = path.join(plan.harnessRoot, 'plugin-data', 'session-migrate', 'plans')
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, `${Date.now()}-${crypto.randomUUID()}.json`)
  await atomicJson(file, plan)
  return { plan, file }
}
