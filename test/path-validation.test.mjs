import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'

test('package metadata exposes a dsh bundle and browser client', async () => {
  const packageJson = await import('../package.json', { with: { type: 'json' } })
  assert.equal(packageJson.default.dsh.bundle.patch, './cordis.patch.yml')
  assert.equal(packageJson.default.exports['./client'], './lib/client.js')
})

test('host and client modules parse as ES modules', async () => {
  const host = await import('../lib/index.js')
  const client = await import('../lib/client.js')
  assert.equal(host.name, 'dsh-file-drop')
  assert.equal(client.name, 'dsh-file-drop/client')
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
