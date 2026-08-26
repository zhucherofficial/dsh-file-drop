import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

const NAME = '@zhucher/dsh-file-drop'
const ROUTE = '/dsh-file-drop/upload'
const CONTEXT_ROUTE = '/dsh-file-drop/context'
const MAX_BODY_BYTES = 60 * 1024 * 1024
const MAX_FILES = 512
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_TOTAL_BYTES = 50 * 1024 * 1024
const DROP_PREFIX = 'dsh-file-drop-'

/**
 * The browser can only expose file bytes reliably in a normal web page. The
 * host stores those bytes in a private temporary directory and returns paths
 * that the existing DSH filesystem tools can read. No project is registered
 * and no workspace directory is modified.
 */

function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address
  return normalized === '127.0.0.1' || normalized === '::1'
}

function isSameOriginBrowserRequest(req) {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return false
  const origin = req.headers.origin
  if (origin === undefined) return req.headers['sec-fetch-site'] === 'same-origin'
  const host = req.headers.host
  if (typeof host !== 'string') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.byteLength
    if (total > MAX_BODY_BYTES) throw new Error('request body is too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function json(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function validRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return false
  if (value.startsWith('/') || value.includes('\\') || /[\u0000-\u001f\u007f]/u.test(value)) return false
  if (value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) return false
  return !value.includes('"')
}

function validBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return false
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return false
  return Buffer.from(value, 'base64').toString('base64') === value
}

function parseItems(payload) {
  if (typeof payload !== 'object' || payload === null || !Array.isArray(payload.items)) {
    throw new Error('items must be an array')
  }
  if (payload.items.length === 0 || payload.items.length > MAX_FILES) throw new Error(`items must contain 1-${MAX_FILES} entries`)
  const seen = new Set()
  let totalBytes = 0
  return payload.items.map((item) => {
    if (typeof item !== 'object' || item === null) throw new Error('each item must be an object')
    const path = item.path
    const kind = item.kind
    if (!validRelativePath(path) || (kind !== 'file' && kind !== 'directory')) throw new Error('invalid dropped path')
    if (seen.has(path)) throw new Error(`duplicate dropped path: ${path}`)
    seen.add(path)
    if (kind === 'directory') return { path, kind }
    if (!validBase64(item.data)) throw new Error(`invalid file data for ${path}`)
    const data = Buffer.from(item.data, 'base64')
    if (data.byteLength > MAX_FILE_BYTES) throw new Error(`${path} exceeds the ${MAX_FILE_BYTES} byte file limit`)
    totalBytes += data.byteLength
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`dropped files exceed the ${MAX_TOTAL_BYTES} byte batch limit`)
    return { path, kind, data }
  })
}

function rootPaths(items) {
  const paths = new Set()
  for (const item of items) {
    const root = item.path.split('/')[0]
    if (root !== undefined) paths.add(root)
  }
  return [...paths]
}

async function stageItems(items) {
  const root = await mkdtemp(join(tmpdir(), DROP_PREFIX))
  try {
    for (const item of items) {
      const target = resolve(root, item.path)
      if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('invalid dropped path')
      if (item.kind === 'directory') {
        await mkdir(target, { recursive: true, mode: 0o700 })
      } else {
        await mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await writeFile(target, item.data, { mode: 0o600, flag: 'wx' })
      }
    }
    return { root, paths: rootPaths(items).map(path => join(root, path)) }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function handleUpload(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
  if (!isSameOriginBrowserRequest(req)) return json(res, 403, { ok: false, error: 'forbidden' })
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) return json(res, 415, { ok: false, error: 'json-required' })
  try {
    const payload = JSON.parse(await readBody(req))
    const items = parseItems(payload)
    const staged = await stageItems(items)
    return json(res, 200, { ok: true, ...staged })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return json(res, message === 'request body is too large' ? 413 : 400, { ok: false, error: message })
  }
}

function handleContext(req, res) {
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
  if (!isSameOriginBrowserRequest(req)) return json(res, 403, { ok: false, error: 'forbidden' })
  return json(res, 200, { ok: true, cwd: process.cwd() })
}

async function purgeOldDrops() {
  try {
    const entries = await readdir(tmpdir(), { withFileTypes: true })
    const now = Date.now()
    await Promise.all(entries
      .filter(entry => entry.isDirectory() && entry.name.startsWith(DROP_PREFIX))
      .map(async entry => {
        const path = join(tmpdir(), entry.name)
        try {
          const age = now - (await stat(path)).mtimeMs
          if (age > 24 * 60 * 60 * 1000) await rm(path, { recursive: true, force: true })
        } catch { /* a concurrent cleanup or user action already removed it */ }
      }))
  } catch { /* temp directory discovery is best effort */ }
}

export const name = NAME
export const inject = ['webServer']

export function apply(ctx) {
  void purgeOldDrops()
  const disposeUpload = ctx.webServer.register({ kind: 'exact', path: ROUTE, handler: handleUpload })
  const disposeContext = ctx.webServer.register({ kind: 'exact', path: CONTEXT_ROUTE, handler: handleContext })
  return () => {
    disposeContext()
    disposeUpload()
  }
}

export { CONTEXT_ROUTE, ROUTE }
