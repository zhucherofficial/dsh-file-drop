import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverLocalMcpServers, importLocalMcp, localMcpInventory } from '../lib/mcp-import.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mcp-import-test-'))
  const home = join(root, 'home')
  const cwd = join(root, 'workspace')
  await mkdir(join(home, '.codex'), { recursive: true })
  await mkdir(join(home, '.claude'), { recursive: true })
  await mkdir(cwd, { recursive: true })
  return { root, home, cwd }
}

test('discovers Codex TOML and workspace MCP JSON without exposing secrets', async () => {
  const { home, cwd } = await fixture()
  await writeFile(join(home, '.codex', 'config.toml'), `
[mcp_servers.alpha]
type = "stdio"
command = "npx"
args = ["-y", "alpha-mcp"]

[mcp_servers.alpha.env]
PRIVATE_TOKEN = "secret-value"
`)
  await writeFile(join(cwd, '.mcp.json'), JSON.stringify({
    mcpServers: {
      alpha: { command: 'duplicate-command' },
      docs: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer hidden' } },
    },
  }))

  const candidates = await discoverLocalMcpServers({ home, cwd, scanRoots: [{ path: cwd, depth: 2, priority: 5 }] })
  assert.deepEqual(candidates.map(server => server.serverName), ['alpha', 'docs'])
  assert.equal(candidates[0].config.command, 'npx')
  assert.equal(candidates[0].alternateCount, 1)
  assert.equal(candidates[0].config.env.PRIVATE_TOKEN, 'secret-value')

  const inventory = await localMcpInventory({ entries: function* () {} }, { home, cwd, scanRoots: [{ path: cwd, depth: 2, priority: 5 }] })
  const serialized = JSON.stringify(inventory)
  assert.equal(serialized.includes('secret-value'), false)
  assert.equal(serialized.includes('Bearer hidden'), false)
  assert.match(inventory[0].source, /^~\//u)
})

test('imports one discovered MCP idempotently through the persistent loader', async () => {
  const { home, cwd } = await fixture()
  await writeFile(join(cwd, '.mcp.json'), JSON.stringify({
    mcpServers: { local: { command: 'node', args: ['./server.js'], cwd: '.' } },
  }))
  const entries = []
  const loader = {
    entries: function* () { yield* entries },
    resolve: id => {
      const entry = entries.find(value => value.id === id)
      if (entry === undefined) throw new Error('missing')
      return entry
    },
    create: async options => { entries.push({ id: options.id, disabled: options.disabled, options }) },
    update: async () => { throw new Error('unexpected update') },
  }
  const [candidate] = await discoverLocalMcpServers({ home, cwd, scanRoots: [{ path: cwd, depth: 2, priority: 5 }] })
  const result = await importLocalMcp(loader, candidate.id, { home, cwd, scanRoots: [{ path: cwd, depth: 2, priority: 5 }] })
  assert.equal(result.imported, true)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].options.name, '@deepseek-ai/dsh-mcp-client')
  assert.equal(entries[0].options.config.cwd, cwd)

  await importLocalMcp(loader, candidate.id, { home, cwd, scanRoots: [{ path: cwd, depth: 2, priority: 5 }] })
  assert.equal(entries.length, 1)
})

test('package lock records the TOML parser dependency', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(packageJson.dependencies['smol-toml'], '^1.8.0')
})
