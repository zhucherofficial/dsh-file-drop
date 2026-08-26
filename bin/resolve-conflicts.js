#!/usr/bin/env node
import { appendFile, copyFile, readFile, readdir, stat } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import process from 'node:process'
import {
  DEFAULT_PREFERENCES,
  disablePatch,
  parseStartupConflict,
  preferenceKey,
  selectConflictOwners,
  sourceClaimsConflict,
} from '../lib/conflicts.js'

function usage() {
  return `Usage: dsh-file-drop-resolve [options]\n\nOptions:\n  --profile <name>       DSH profile to inspect (default: web)\n  --check                Diagnose only; do not edit the profile\n  --prefer <key=owner>   Select an owner, e.g. tool:describe_image=@dsh-plugin/dsh-auxiliary\n  --timeout <ms>         Healthy-start probe duration (default: 8000)\n  -h, --help             Show this help\n`
}

function parseArgs(argv) {
  const options = { profile: 'web', check: false, timeout: 8000, preferences: { ...DEFAULT_PREFERENCES } }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '-h' || arg === '--help') return { ...options, help: true }
    if (arg === '--check') { options.check = true; continue }
    if (arg === '--profile') { options.profile = argv[++index]; continue }
    if (arg === '--timeout') { options.timeout = Number(argv[++index]); continue }
    if (arg === '--prefer') {
      const value = argv[++index] ?? ''
      const separator = value.lastIndexOf('=')
      if (separator <= 0 || separator === value.length - 1) throw new Error('--prefer must use conflict-kind:key=entry-id-or-package')
      options.preferences[value.slice(0, separator)] = value.slice(separator + 1)
      continue
    }
    throw new Error(`unknown option: ${arg}`)
  }
  if (!Number.isFinite(options.timeout) || options.timeout < 1000 || options.timeout > 60000) throw new Error('--timeout must be between 1000 and 60000 milliseconds')
  return options
}

function dshHome() {
  return process.env.DSH_HOME === undefined ? join(homedir(), '.dsh') : resolve(process.env.DSH_HOME)
}

function composedEntries(profile) {
  const result = spawnSync('dsh', ['--profile', profile, '--dump-config'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'dsh config composition failed')
  const entries = []
  const scalar = (raw) => {
    const value = raw.trim()
    if (value.startsWith('"')) return JSON.parse(value)
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/gu, "'")
    return value
  }
  let current
  for (const line of result.stdout.split(/\r?\n/u)) {
    const id = /^(\s*)- id:\s*(.+)$/u.exec(line)
    if (id !== null) {
      if (current?.name !== undefined) entries.push(current)
      current = { indent: id[1].length, id: scalar(id[2]), name: undefined, disabled: false }
      continue
    }
    if (current === undefined) continue
    const field = /^(\s+)(name|disabled):\s*(.+)$/u.exec(line)
    if (field === null || field[1].length !== current.indent + 2) continue
    if (field[2] === 'name') current.name = scalar(field[3])
    else current.disabled = field[3].trim() === 'true'
  }
  if (current?.name !== undefined) entries.push(current)
  return entries.filter(entry => !entry.disabled)
}

async function packageRoot(profileDir, name) {
  const require = createRequire(join(profileDir, 'package.json'))
  let entry
  try { entry = require.resolve(name) } catch { return undefined }
  let cursor = dirname(entry)
  for (;;) {
    const manifest = join(cursor, 'package.json')
    try {
      const parsed = JSON.parse(await readFile(manifest, 'utf8'))
      if (parsed.name === name) return cursor
    } catch { /* keep walking */ }
    const parent = dirname(cursor)
    if (parent === cursor) return undefined
    cursor = parent
  }
}

async function packageSources(root, budget = 12 * 1024 * 1024) {
  const output = []
  let consumed = 0
  const visit = async (directory, depth) => {
    if (depth > 5 || consumed >= budget) return
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) { await visit(path, depth + 1); continue }
      if (!entry.isFile() || !/\.(?:c?js|mjs|tsx?|json)$/u.test(entry.name)) continue
      const size = (await stat(path)).size
      if (size > 3 * 1024 * 1024 || consumed + size > budget) continue
      consumed += size
      output.push(await readFile(path, 'utf8'))
    }
  }
  await visit(root, 0)
  return output
}

async function discoverOwners(profileDir, entries, conflict) {
  const cache = new Map()
  const candidates = []
  for (const entry of entries) {
    let claims = cache.get(entry.name)
    if (claims === undefined) {
      const root = await packageRoot(profileDir, entry.name)
      claims = root === undefined ? false : (await packageSources(root)).some(source => sourceClaimsConflict(source, conflict))
      cache.set(entry.name, claims)
    }
    if (claims) candidates.push(entry)
  }
  return candidates
}

function probe(profile, timeoutMs) {
  return new Promise((resolveProbe) => {
    const child = spawn('dsh', ['--profile', profile, '--no-open', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveProbe({ ...result, output })
    }
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    child.on('error', error => finish({ healthy: false, error }))
    child.on('exit', code => finish({ healthy: code === 0, code }))
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ healthy: true, code: null })
    }, timeoutMs)
  })
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) { process.stdout.write(usage()); return }
  const profileDir = join(dshHome(), 'profiles', options.profile)
  const patchPath = join(profileDir, 'cordis.patch.yml')
  let backedUp = false
  const reports = []
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const result = await probe(options.profile, options.timeout)
    if (result.healthy) {
      if (reports.length === 0) console.log(`No startup registration conflicts detected in profile ${options.profile}.`)
      else console.log(`Profile ${options.profile} starts after ${reports.length} conflict resolution(s).`)
      return
    }
    const conflict = parseStartupConflict(result.output)
    if (conflict === undefined) {
      process.stderr.write(result.output)
      throw new Error('startup failed, but the failure is not a recognized duplicate-registration conflict')
    }
    const entries = composedEntries(options.profile)
    const candidates = await discoverOwners(profileDir, entries, conflict)
    const decision = selectConflictOwners(conflict, candidates, options.preferences)
    const report = { conflict: preferenceKey(conflict), candidates, decision }
    reports.push(report)
    if (decision.status !== 'resolved') {
      console.error(JSON.stringify(report, null, 2))
      throw new Error(`${preferenceKey(conflict)} is ambiguous: ${decision.reason}; rerun with --prefer ${preferenceKey(conflict)}=<entry-id-or-package>`)
    }
    console.log(`${preferenceKey(conflict)}: keeping ${decision.winner.id} (${decision.winner.name}); disabling ${decision.losers.map(value => value.id).join(', ')} via ${decision.rule}.`)
    if (options.check) return
    if (!backedUp) {
      const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
      await copyFile(patchPath, `${patchPath}.dsh-file-drop-backup-${stamp}`)
      backedUp = true
    }
    await appendFile(patchPath, disablePatch(decision.losers, conflict), 'utf8')
  }
  throw new Error('too many consecutive conflicts; stopped after 12 resolutions')
}

main().catch(error => {
  console.error(`dsh-file-drop-resolve: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
