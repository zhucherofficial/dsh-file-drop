const CONFLICT_PATTERNS = [
  { kind: 'tool', pattern: /tool "([^"]+)" is already registered/u },
  { kind: 'web-route', pattern: /webserver: duplicate (?:exact|prefix|upgrade) route "([^"]+)"/u },
  { kind: 'input-source', pattern: /slash source "([^"]+)" is already registered/u },
  { kind: 'sidebar-tab', pattern: /tab type "([^"]+)" already registered/u },
  { kind: 'file-viewer', pattern: /file viewer "([^"]+)" already registered/u },
  { kind: 'web-provider', pattern: /web provider with id "([^"]+)" is already registered/u },
]

export function parseStartupConflict(output) {
  for (const candidate of CONFLICT_PATTERNS) {
    const match = candidate.pattern.exec(output)
    if (match !== null) return { kind: candidate.kind, key: match[1], message: match[0] }
  }
  return undefined
}

export function preferenceKey(conflict) {
  return `${conflict.kind}:${conflict.key}`
}

export function selectConflictOwners(conflict, candidates, preferences = {}) {
  const unique = candidates.filter((candidate, index) => candidates.findIndex(value => value.id === candidate.id && value.name === candidate.name) === index)
  if (unique.length < 2) return { status: 'unresolved', reason: 'fewer than two owning entries were identified', candidates: unique }
  const preferredName = preferences[preferenceKey(conflict)]
  if (typeof preferredName === 'string') {
    const winner = unique.find(candidate => candidate.name === preferredName || candidate.id === preferredName)
    if (winner === undefined) return { status: 'unresolved', reason: `preferred owner ${preferredName} is not enabled`, candidates: unique }
    return { status: 'resolved', winner, losers: unique.filter(candidate => candidate !== winner), rule: 'configured preference' }
  }
  if (unique.every(candidate => candidate.name === unique[0].name)) {
    return { status: 'resolved', winner: unique[0], losers: unique.slice(1), rule: 'exact duplicate package' }
  }
  return { status: 'unresolved', reason: 'the owners have different implementations and no preference is configured', candidates: unique }
}

export function registrationHints(conflict) {
  switch (conflict.kind) {
    case 'tool': return ['tools.register', 'defineTool']
    case 'web-route': return ['webServer.register', 'webserver.register', 'registerRoute']
    case 'input-source': return ['registerSource']
    case 'sidebar-tab': return ['tab type', 'registerTab', 'tabs.set']
    case 'file-viewer': return ['file viewer', 'registerViewer', 'viewers.set']
    case 'web-provider': return ['registerSearch', 'registerFetch', 'providers.set']
    default: return []
  }
}

export function sourceClaimsConflict(source, conflict) {
  if (typeof source !== 'string' || !source.includes(conflict.key)) return false
  return registrationHints(conflict).some(hint => source.includes(hint))
}

export function disablePatch(entries, conflict) {
  const lines = [
    '',
    `# dsh-file-drop resolver: ${preferenceKey(conflict)}`,
  ]
  for (const entry of entries) {
    lines.push(`- id: ${JSON.stringify(entry.id)}`)
    lines.push(`  name: ${JSON.stringify(entry.name)}`)
    lines.push('  disabled: true')
  }
  return `${lines.join('\n')}\n`
}

export const DEFAULT_PREFERENCES = Object.freeze({
  'tool:describe_image': '@dsh-plugin/dsh-auxiliary',
})
