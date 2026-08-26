import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { runInNewContext } from 'node:vm'

test('package metadata exposes a dsh bundle and browser client', async () => {
  const packageJson = await import('../package.json', { with: { type: 'json' } })
  assert.equal(packageJson.default.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(packageJson.default.exports['./client'], './lib/client.js')
  assert.equal(packageJson.default.bin['dsh-file-drop-resolve'], './bin/resolve-conflicts.js')
})

test('host module parses and client bundle registers with ModuleLoader', async () => {
  const host = await import('../lib/index.js')
  assert.equal(host.name, 'dsh-file-drop')

  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const entries = []
  runInNewContext(source, {
    window: { __ModuleLoader__: { load: entry => entries.push(entry) } },
    URL,
  })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].id, 'dsh-file-drop')
  const client = entries[0].factory(() => { throw new Error('unexpected client dependency') })
  assert.equal(client.name, 'dsh-file-drop/client')
  assert.deepEqual(Array.from(client.inject), ['sessions', 'conversation', 'inputTriggers'])
  assert.equal(typeof client.apply, 'function')
  assert.equal(client.shouldClaimDrop({ types: ['Files'], files: [{ type: 'text/plain' }], items: [] }), true)
  assert.equal(client.shouldClaimDrop({ types: ['Files'], files: [{ type: 'image/png' }], items: [] }), false)
  assert.equal(client.shouldClaimDrop({ types: ['Files', 'application/x-dsh-file'], files: [], items: [] }), false)
  assert.equal(client.shouldClaimDrop({ types: ['text/uri-list'], files: [], items: [], getData: () => 'file:///tmp/notes.txt' }), true)
  assert.equal(client.shouldClaimDrop({ types: ['text/uri-list'], files: [], items: [], getData: () => 'https://example.com/notes.txt' }), false)
  assert.equal(client.hasWorkspaceFileDrag({ types: ['application/x-dsh-file'] }), true)
  assert.equal(client.attachmentName('/Users/ken/Documents/notes'), 'notes')
  assert.equal(client.attachmentName('C:\\Users\\Ken\\report.pdf'), 'report.pdf')
  assert.equal(client.formatAttachmentReferences([
    { path: '/tmp/Project Files', kind: 'directory' },
    { path: '/tmp/report.pdf', kind: 'file' },
  ]), '@"/tmp/Project Files/"\n@/tmp/report.pdf')
  assert.deepEqual(Array.from(client.uniqueAttachments([
    { path: '/tmp/a.txt', kind: 'file' },
    { path: '/tmp/a.txt', kind: 'file' },
    { path: '/tmp/a.txt', kind: 'directory' },
  ]), value => ({ ...value })), [
    { path: '/tmp/a.txt', kind: 'file' },
    { path: '/tmp/a.txt', kind: 'directory' },
  ])

  const payloads = new Map([['batch-1', [{ path: '/tmp/a file.txt', kind: 'file' }]]])
  const refSource = client.createReferenceSource(payloads)
  assert.equal(refSource.name, 'dsh-file-drop')
  assert.equal(refSource.codec.clipboardText('batch-1'), '@"/tmp/a file.txt"')
  assert.equal(await refSource.codec.serialize('batch-1', new AbortController().signal), '@"/tmp/a file.txt"')
  await assert.rejects(refSource.codec.serialize('missing', new AbortController().signal), /no longer available/u)
})

async function routeServer() {
  const host = await import('../lib/index.js')
  let handler
  host.apply({ webServer: { register: route => { handler = route.handler; return () => {} } } })
  assert.equal(typeof handler, 'function')
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.equal(typeof address, 'object')
  const origin = `http://127.0.0.1:${address.port}`
  return {
    origin,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

test('upload route stages a dropped folder and rejects traversal', async () => {
  const server = await routeServer()
  let stagedRoot
  try {
    const headers = { 'content-type': 'application/json', origin: server.origin, 'sec-fetch-site': 'same-origin' }
    const response = await fetch(`${server.origin}/dsh-file-drop/upload`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ items: [
        { path: 'notes', kind: 'directory' },
        { path: 'notes/hello.txt', kind: 'file', data: Buffer.from('hello').toString('base64') },
      ] }),
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.paths.length, 1)
    stagedRoot = payload.root
    assert.equal(await readFile(`${payload.paths[0]}/hello.txt`, 'utf8'), 'hello')

    const refused = await fetch(`${server.origin}/dsh-file-drop/upload`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ items: [{ path: '../escape.txt', kind: 'file', data: Buffer.from('no').toString('base64') }] }),
    })
    assert.equal(refused.status, 400)
    assert.equal((await refused.json()).ok, false)
  } finally {
    if (stagedRoot !== undefined) await rm(stagedRoot, { recursive: true, force: true })
    await server.close()
  }
})
