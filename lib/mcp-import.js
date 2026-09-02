import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse as parseToml } from 'smol-toml'

const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'
const MAX_CONFIG_BYTES = 2 * 1024 * 1024
const MAX_SCANNED_FILES = 750
const MCP_FILENAMES = new Set(['.mcp.json', 'mcp.json'])

function shortHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12)
}

export function slugServerName(input) {
  const slug = String(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, '-')
    .replace(/^[^a-z0-9]+/u, '')
    .replace(/[^a-z0-9]+$/u, '')
    .slice(0, 63)
  return slug || `srv-${shortHash(String(input))}`
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringRecord(value, label) {
  if (value === undefined) return {}
  if (!isObject(value)) throw new Error(`${label} must be an object`)
  const output = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean') {
      throw new Error(`${label}.${key} must be a string, number, or boolean`)
    }
    output[key] = String(item)
  }
  return output
}

function stringArray(value, label) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  return value.map((item, index) => {
    if (typeof item !== 'string' && typeof item !== 'number') throw new Error(`${label}[${index}] must be a string or number`)
    return String(item)
  })
}

function replaceRootTokens(value, source, cwd) {
  if (typeof value !== 'string') return value
  const root = dirname(source)
  return value
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', root)
    .replaceAll('${CODEX_PLUGIN_ROOT}', root)
    .replaceAll('${workspaceFolder}', cwd)
}

function safeHttpUrl(value) {
  let url
  try { url = new URL(String(value)) } catch { throw new Error('url must be valid') }
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !loopback) throw new Error('url must use HTTPS or loopback HTTP')
  return url.toString()
}

function normalizeDefinition(name, raw, source, cwd, priority) {
  if (!isObject(raw)) throw new Error(`${name} must be an object`)
  const displayName = String(raw.name ?? name).trim()
  if (displayName === '') throw new Error('server name must not be empty')
  const serverName = slugServerName(raw.serverName ?? name)
  const command = typeof raw.command === 'string' ? replaceRootTokens(raw.command.trim(), source, cwd) : ''
  const transportValue = String(raw.transport ?? raw.type ?? (command === '' ? 'streamable-http' : 'stdio')).toLowerCase()
  const transport = transportValue === 'http' || transportValue === 'sse' ? 'streamable-http' : transportValue
  const base = {
    id: shortHash(`${source}\u0000${name}`),
    name: displayName,
    serverName,
    source,
    sourceEnabled: raw.enabled !== false && raw.disabled !== true,
    priority,
  }
  if (transport === 'stdio') {
    if (command === '') throw new Error('stdio server is missing command')
    const configuredCwd = typeof raw.cwd === 'string' && raw.cwd.trim() !== ''
      ? replaceRootTokens(raw.cwd.trim(), source, cwd)
      : cwd
    const resolvedCwd = isAbsolute(configuredCwd) ? configuredCwd : resolve(dirname(source), configuredCwd)
    const env = stringRecord(raw.env, 'env')
    for (const [key, value] of Object.entries(env)) env[key] = replaceRootTokens(value, source, cwd)
    return {
      ...base,
      transport,
      config: {
        transport,
        serverName,
        command,
        args: stringArray(raw.args, 'args').map(value => replaceRootTokens(value, source, cwd)),
        env,
        cwd: resolvedCwd,
        failOnStartupError: false,
      },
    }
  }
  if (transport !== 'streamable-http') throw new Error(`unsupported transport: ${transport}`)
  const url = safeHttpUrl(raw.url)
  return {
    ...base,
    transport,
    config: {
      transport,
      serverName,
      url,
      headers: stringRecord(raw.headers ?? raw.httpHeaders, 'headers'),
      failOnStartupError: false,
    },
  }
}

function definitionsFromJson(value, source, cwd, priority) {
  if (!isObject(value)) throw new Error('configuration root must be an object')
  const definitions = value.mcpServers
    ?? value.mcp_servers
    ?? (isObject(value.mcp) ? value.mcp.servers : undefined)
    ?? (MCP_FILENAMES.has(basename(source)) ? value.servers : undefined)
  if (!isObject(definitions)) return []
  const output = []
  for (const [name, raw] of Object.entries(definitions)) {
    try { output.push(normalizeDefinition(name, raw, source, cwd, priority)) } catch { /* one malformed definition must not hide the others */ }
  }
  return output
}

function definitionsFromToml(value, source, cwd, priority) {
  if (!isObject(value?.mcp_servers)) return []
  const output = []
  for (const [name, raw] of Object.entries(value.mcp_servers)) {
    try { output.push(normalizeDefinition(name, raw, source, cwd, priority)) } catch { /* keep scanning valid siblings */ }
  }
  return output
}

async function readConfig(path, format, cwd, priority) {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return []
    const source = resolve(path)
    const text = await readFile(source, 'utf8')
    return format === 'toml'
      ? definitionsFromToml(parseToml(text), source, cwd, priority)
      : definitionsFromJson(JSON.parse(text), source, cwd, priority)
  } catch {
    return []
  }
}

async function findMcpFiles(root, maxDepth) {
  const files = []
  const visit = async (directory, depth) => {
    if (depth > maxDepth || files.length >= MAX_SCANNED_FILES) return
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (files.length >= MAX_SCANNED_FILES) return
      const path = join(directory, entry.name)
      if (entry.isFile() && MCP_FILENAMES.has(entry.name)) files.push(path)
      else if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(path, depth + 1)
    }
  }
  await visit(root, 0)
  return files
}

function sourceLabel(source, home) {
  const fromHome = relative(home, source)
  if (fromHome !== '' && fromHome !== '..' && !fromHome.startsWith(`..${sep}`) && !isAbsolute(fromHome)) return `~/${fromHome}`
  return source
}

function dedupeCandidates(candidates) {
  const selected = new Map()
  for (const candidate of candidates.sort((a, b) => a.priority - b.priority || a.source.localeCompare(b.source))) {
    const current = selected.get(candidate.serverName)
    if (current === undefined) selected.set(candidate.serverName, { ...candidate, alternateCount: 0 })
    else current.alternateCount += 1
  }
  return [...selected.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function discoverLocalMcpServers(options = {}) {
  const home = resolve(options.home ?? homedir())
  const cwd = resolve(options.cwd ?? process.cwd())
  const explicit = [
    [join(home, '.codex', 'config.toml'), 'toml', 0],
    [join(home, '.cursor', 'mcp.json'), 'json', 1],
    [join(home, '.claude.json'), 'json', 1],
    [join(home, '.claude', 'settings.json'), 'json', 1],
    [join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), 'json', 1],
    [join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json'), 'json', 1],
  ]
  const seenFiles = new Set()
  const candidates = []
  for (const [path, format, priority] of explicit) {
    seenFiles.add(resolve(path))
    candidates.push(...await readConfig(path, format, cwd, priority))
  }
  const roots = options.scanRoots ?? [
    { path: cwd, depth: 4, priority: 5 },
    { path: join(home, '.codex', 'plugins', 'cache'), depth: 7, priority: 20 },
    { path: join(home, '.claude', 'plugins', 'cache'), depth: 7, priority: 30 },
  ]
  for (const root of roots) {
    for (const path of await findMcpFiles(root.path, root.depth)) {
      const absolute = resolve(path)
      if (seenFiles.has(absolute)) continue
      seenFiles.add(absolute)
      candidates.push(...await readConfig(absolute, 'json', cwd, root.priority))
    }
  }
  return dedupeCandidates(candidates).map(candidate => ({
    ...candidate,
    sourceLabel: sourceLabel(candidate.source, home),
  }))
}

function loaderEntryForServer(loader, serverName) {
  if (typeof loader?.entries !== 'function') return undefined
  for (const entry of loader.entries()) {
    if (entry?.options?.name === MCP_CLIENT && entry.options.config?.serverName === serverName) return entry
  }
  return undefined
}

function publicCandidate(candidate, loader) {
  const entry = loaderEntryForServer(loader, candidate.serverName)
  return {
    id: candidate.id,
    name: candidate.name,
    serverName: candidate.serverName,
    transport: candidate.transport,
    source: candidate.sourceLabel,
    sourceEnabled: candidate.sourceEnabled,
    alternateCount: candidate.alternateCount,
    imported: entry !== undefined && !entry.disabled,
    configured: entry !== undefined,
  }
}

export async function localMcpInventory(loader, options) {
  return (await discoverLocalMcpServers(options)).map(candidate => publicCandidate(candidate, loader))
}

export async function importLocalMcp(loader, id, options) {
  const candidates = await discoverLocalMcpServers(options)
  const candidate = candidates.find(value => value.id === id)
  if (candidate === undefined) throw new Error('the selected MCP server is no longer available')
  const existing = loaderEntryForServer(loader, candidate.serverName)
  if (existing !== undefined) {
    if (existing.disabled && typeof loader.update === 'function') await loader.update(existing.id, { disabled: false })
    return { ...publicCandidate(candidate, loader), imported: true, configured: true }
  }
  if (typeof loader?.create !== 'function') throw new Error('the DSH plugin loader is unavailable')
  let entryId = `mcp-local-${candidate.serverName}`
  try {
    const collision = loader.resolve?.(entryId)
    if (collision !== undefined) entryId = `${entryId}-${candidate.id.slice(0, 6)}`
  } catch { /* the preferred id is free */ }
  await loader.create({
    id: entryId,
    name: MCP_CLIENT,
    config: candidate.config,
    disabled: false,
  })
  return { ...publicCandidate(candidate, loader), imported: true, configured: true }
}

export { MCP_CLIENT }
