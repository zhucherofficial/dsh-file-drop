import test from 'node:test'
import assert from 'node:assert/strict'
import {
  disablePatch,
  parseStartupConflict,
  selectConflictOwners,
  sourceClaimsConflict,
} from '../lib/conflicts.js'

test('startup conflict parser classifies supported registry failures', () => {
  assert.deepEqual(parseStartupConflict('Error: tool "describe_image" is already registered'), {
    kind: 'tool',
    key: 'describe_image',
    message: 'tool "describe_image" is already registered',
  })
  assert.deepEqual(parseStartupConflict('webserver: duplicate exact route "/upload"'), {
    kind: 'web-route',
    key: '/upload',
    message: 'webserver: duplicate exact route "/upload"',
  })
  assert.equal(parseStartupConflict('connection refused'), undefined)
})

test('resolver uses explicit preferences and exact-package deduplication', () => {
  const candidates = [
    { id: 'aggregate-vision', name: '@vendor/vision' },
    { id: 'auxiliary', name: '@dsh-plugin/dsh-auxiliary' },
  ]
  const preferred = selectConflictOwners(
    { kind: 'tool', key: 'describe_image' },
    candidates,
    { 'tool:describe_image': '@dsh-plugin/dsh-auxiliary' },
  )
  assert.equal(preferred.status, 'resolved')
  assert.equal(preferred.winner.id, 'auxiliary')
  assert.deepEqual(preferred.losers, [candidates[0]])

  const duplicate = selectConflictOwners(
    { kind: 'web-route', key: '/same' },
    [{ id: 'one', name: 'same-package' }, { id: 'two', name: 'same-package' }],
  )
  assert.equal(duplicate.status, 'resolved')
  assert.equal(duplicate.winner.id, 'one')
})

test('resolver reports semantically different owners without a preference', () => {
  const decision = selectConflictOwners(
    { kind: 'input-source', key: '@files' },
    [{ id: 'one', name: 'plugin-one' }, { id: 'two', name: 'plugin-two' }],
  )
  assert.equal(decision.status, 'unresolved')
  assert.match(decision.reason, /no preference/u)
})

test('source ownership and generated patch stay capability- and id-specific', () => {
  const conflict = { kind: 'tool', key: 'describe_image' }
  assert.equal(sourceClaimsConflict('ctx.tools.register(defineTool({ name: "describe_image" }))', conflict), true)
  assert.equal(sourceClaimsConflict('const message = "describe_image"', conflict), false)
  assert.equal(disablePatch([{ id: 'vision-old', name: '@vendor/vision' }], conflict), `
# dsh-file-drop resolver: tool:describe_image
- id: "vision-old"
  name: "@vendor/vision"
  disabled: true
`)
})
