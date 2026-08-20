import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import fsp from 'node:fs/promises'
import { createPlanFile, MigrationError } from '../lib/migration-core.mjs'

const name = 'dsh-session-migrate'
const inject = ['sessionPersistence', 'workspaceRegistry']
const LIST_ENDPOINT = '/__dsh/session-migrate/list'
const PLAN_ENDPOINT = '/__dsh/session-migrate/plan'
const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const cliFile = path.join(packageRoot, 'bin', 'migrate-session.mjs')

function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'` }
async function resolveSessionModuleUrl() {
  const candidates = process.argv.filter((value) => /@deepseek-ai[\/]dsh[\/]lib[\/]bin\.js$/.test(String(value)))
  for (const dshBin of candidates) {
    try {
      const require = createRequire(pathToFileURL(path.resolve(dshBin)))
      return pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href
    } catch {}
  }
  const appCandidate = '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
  try {
    await fsp.access(appCandidate)
    return pathToFileURL(appCandidate).href
  } catch {}
  throw new MigrationError('cannot locate the exact DSH session decoder used by this Host', 'SESSION_DECODER_UNAVAILABLE')
}
function send(res, status, value) { const body = JSON.stringify(value); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' }); res.end(body) }
function readBody(req) { return new Promise((resolve, reject) => { let text = ''; req.setEncoding('utf8'); req.on('data', (chunk) => { text += chunk; if (Buffer.byteLength(text) > 1048576) { req.destroy(); reject(new MigrationError('request too large', 'REQUEST_TOO_LARGE')) } }); req.on('end', () => { try { resolve(text.trim() ? JSON.parse(text) : {}) } catch { reject(new MigrationError('invalid JSON', 'INVALID_JSON')) } }); req.on('error', reject); req.on('aborted', () => reject(new MigrationError('request aborted', 'REQUEST_ABORTED'))) }) }
function projection(ctx) { try { return ctx.get('storageDomain')?.get?.('session_projcache')?.table?.('sessions') } catch { return null } }
function title(record) { const value = record?.rows?.title?.val; return typeof value === 'string' && value.trim() ? value : null }

async function options(ctx) {
  const headers = await ctx.sessionPersistence.list()
  const workspaces = ctx.workspaceRegistry.list()
  let harnessRoot = null
  if (typeof ctx.sessionPersistence.locate === 'function') {
    for (const header of headers) {
      const located = ctx.sessionPersistence.locate(header)
      if (located?.kind === 'jsonl' && typeof located.path === 'string') { harnessRoot = path.dirname(path.dirname(path.dirname(path.dirname(located.path)))); break }
    }
  }
  if (!harnessRoot) harnessRoot = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : null
  if (!harnessRoot) throw new MigrationError('cannot determine Harness root safely', 'HARNESS_ROOT_UNAVAILABLE')
  const bySession = new Map()
  for (const workspace of workspaces) for (const id of workspace.sessionIds) if (!bySession.has(id)) bySession.set(id, String(workspace.id))
  const cache = projection(ctx)
  const agents = ctx.get('agents')
  return {
    harnessRoot,
    sessions: headers.map((header) => ({ sessionId: String(header.id), title: title(cache?.get?.(header.id)), cwd: header.cwd ?? null, workspaceId: bySession.get(header.id) ?? null, active: Boolean(agents?.get?.(header.id)), related: Boolean(header.parentSession) })),
    workspaces: workspaces.map((workspace) => ({ workspaceId: String(workspace.id), title: workspace.title, path: workspace.path })),
  }
}

function register(ctx, webServer, owner) {
  owner.effect(() => webServer.register({ kind: 'exact', path: LIST_ENDPOINT, handler: async (req, res) => { if (req.method !== 'GET') return send(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed' } }); try { send(res, 200, { ok: true, ...(await options(ctx)) }) } catch (error) { send(res, 500, { ok: false, error: { code: error.code || 'LIST_FAILED', message: error.message || String(error) } }) } } }))
  owner.effect(() => webServer.register({ kind: 'exact', path: PLAN_ENDPOINT, handler: async (req, res) => { if (req.method !== 'POST') return send(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed' } }); try {
    const body = await readBody(req); const state = await options(ctx)
    const sessionId = String(body.sessionId || '').trim(); const targetWorkspaceId = String(body.targetWorkspaceId || '').trim()
    const session = state.sessions.find((row) => row.sessionId === sessionId); const target = state.workspaces.find((row) => row.workspaceId === targetWorkspaceId)
    if (!session) throw new MigrationError('session not found', 'SESSION_NOT_FOUND')
    if (!target) throw new MigrationError('target workspace not found', 'TARGET_WORKSPACE_NOT_FOUND')
    if (session.active) throw new MigrationError('session is active', 'SESSION_ACTIVE')
    if (session.related) throw new MigrationError('related/subagent sessions are not supported in v0.1', 'RELATED_SESSIONS')
    if (session.workspaceId === targetWorkspaceId) throw new MigrationError('already in target workspace', 'ALREADY_IN_TARGET')
    const sessionModuleUrl = await resolveSessionModuleUrl()
    const created = await createPlanFile({ harnessRoot: state.harnessRoot, sessionId, targetWorkspaceId, nodeExecutable: process.execPath, cliFile, sessionModuleUrl })
    const prefix = `${quote(process.execPath)} ${quote(cliFile)}`
    send(res, 200, { ok: true, sessionId, targetWorkspaceId, planFile: created.file, dryRunCommand: `${prefix} dry-run --plan ${quote(created.file)}`, command: `${prefix} execute --plan ${quote(created.file)}` })
  } catch (error) { send(res, error instanceof MigrationError ? 409 : 500, { ok: false, error: { code: error.code || 'PLAN_FAILED', message: error.message || String(error) } }) } } }))
}
function apply(ctx) { const web = ctx.get('webServer'); if (web) register(ctx, web, ctx); else ctx.inject(['webServer'], (sub) => register(ctx, sub.webServer, sub)) }
export { apply, inject, LIST_ENDPOINT, name, PLAN_ENDPOINT }
