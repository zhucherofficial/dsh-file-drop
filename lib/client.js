window.__ModuleLoader__.load({
  id: '@zhucherofficial/dsh-file-drop',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const NAME = '@zhucherofficial/dsh-file-drop/client'
    const UPLOAD_ROUTE = '/dsh-file-drop/upload'
    const CONTEXT_ROUTE = '/dsh-file-drop/context'
    const MAX_FILES = 512
    const MAX_FILE_BYTES = 20 * 1024 * 1024
    const MAX_TOTAL_BYTES = 50 * 1024 * 1024
    const ENTRY_SELECTOR = '[data-dsh-file-drop-entry]'
    const OVERLAY_SELECTOR = '[data-dsh-file-drop-overlay]'
    const RAIL_SELECTOR = '[data-dsh-file-drop-rail]'
    const STYLE_SELECTOR = '[data-dsh-file-drop-style]'
    const REFERENCE_SOURCE = 'dsh-file-drop'
    const WORKSPACE_FILE_DRAG_MIME = 'application/x-dsh-file'
    const EMPTY_DRAFT_SENTINEL = String.fromCharCode(0x200b)

function service(ctx, key) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(key) : ctx[key]
  } catch {
    return undefined
  }
}

function isTextLikePath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096
    && !/[\u0000-\u001f\u007f"]/u.test(path)
}

function normalizeNativePath(path) {
  if (!isTextLikePath(path)) return undefined
  if (path.startsWith('file://')) {
    try {
      const url = new URL(path)
      if (url.protocol !== 'file:') return undefined
      const decoded = decodeURIComponent(url.pathname)
      if (/^\/[A-Za-z]:\//u.test(decoded)) return decoded.slice(1)
      return decoded
    } catch { return undefined }
  }
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path)) return path
  return undefined
}

function nativeFilePath(file) {
  return normalizeNativePath(file?.path ?? file?.webkitRelativePath)
}

function formatMention(path, kind) {
  if (!isTextLikePath(path)) return undefined
  const value = kind === 'directory' && !path.endsWith('/') ? `${path}/` : path
  return /\s/u.test(value) ? `@"${value}"` : `@${value}`
}

function attachmentName(path) {
  if (typeof path !== 'string') return ''
  const trimmed = path.replace(/[\\/]+$/u, '')
  return trimmed.split(/[\\/]/u).pop() ?? trimmed
}

function formatAttachmentReferences(items) {
  return items.map(item => formatMention(item.path, item.kind))
    .filter(value => value !== undefined)
    .join('\n')
}

function withoutSentinel(draft) {
  return draft.startsWith(EMPTY_DRAFT_SENTINEL) ? draft.slice(EMPTY_DRAFT_SENTINEL.length) : draft
}

function uniqueAttachments(items) {
  const seen = new Set()
  const output = []
  for (const item of items) {
    const key = `${item.kind}\u0000${item.path}`
    if (seen.has(key)) continue
    seen.add(key)
    output.push(item)
  }
  return output
}

function base64FromBuffer(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const step = 0x8000
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + step, bytes.length)))
  }
  return btoa(binary)
}

function readEntryFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

function readDirectoryEntries(entry) {
  return new Promise((resolve, reject) => {
    const reader = entry.createReader()
    const all = []
    const read = () => reader.readEntries(entries => {
      if (entries.length === 0) return resolve(all)
      all.push(...entries)
      read()
    }, reject)
    read()
  })
}

async function walkEntry(entry, path, output) {
  if (output.length >= MAX_FILES) throw new Error(`a drop may contain at most ${MAX_FILES} items`)
  if (entry.isDirectory) {
    output.push({ path, kind: 'directory' })
    for (const child of await readDirectoryEntries(entry)) {
      await walkEntry(child, `${path}/${child.name}`, output)
    }
    return
  }
  const file = await readEntryFile(entry)
  output.push({ path, kind: 'file', file })
}

function parseUriList(dataTransfer) {
  let raw = ''
  try { raw = dataTransfer.getData('text/uri-list') } catch { return [] }
  return raw.split(/\r?\n/u)
    .map(value => value.trim())
    .filter(value => value !== '' && !value.startsWith('#'))
    .map(normalizeNativePath)
    .filter(value => value !== undefined)
}

function isImageOnly(dataTransfer) {
  const items = [...(dataTransfer.items ?? [])]
  if (items.some(item => item.webkitGetAsEntry?.()?.isDirectory)) return false
  const files = [...(dataTransfer.files ?? [])]
  if (files.length > 0) return files.every(file => String(file.type).toLowerCase().startsWith('image/'))
  const fileItems = items.filter(item => item.kind === 'file')
  return fileItems.length > 0 && fileItems.every(item => String(item.type).toLowerCase().startsWith('image/'))
}

function hasWorkspaceFileDrag(dataTransfer) {
  return [...(dataTransfer?.types ?? [])].includes(WORKSPACE_FILE_DRAG_MIME)
}

function hasFilePayload(dataTransfer) {
  if (dataTransfer === null || dataTransfer === undefined) return false
  const types = [...(dataTransfer.types ?? [])]
  return types.includes('Files')
    || [...(dataTransfer.items ?? [])].some(item => item.kind === 'file')
    || [...(dataTransfer.files ?? [])].length > 0
    || parseUriList(dataTransfer).length > 0
}

function shouldClaimDrop(dataTransfer) {
  return hasFilePayload(dataTransfer)
    && !hasWorkspaceFileDrag(dataTransfer)
    && !isImageOnly(dataTransfer)
}

async function collectDrop(dataTransfer) {
  const output = []
  const nativePaths = parseUriList(dataTransfer)
  const items = [...(dataTransfer.items ?? [])]
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.()
    if (entry !== null && entry !== undefined) {
      await walkEntry(entry, entry.name, output)
      continue
    }
    const file = item.getAsFile?.()
    if (file !== null && file !== undefined) output.push({ path: file.name, kind: 'file', file })
  }
  if (output.length === 0) {
    for (const file of [...(dataTransfer.files ?? [])]) output.push({ path: file.name, kind: 'file', file })
  }
  // Some native clients expose only a file:// URI and no File object. There
  // are no bytes to upload in that case, but the absolute path is still a
  // useful direct reference for DSH's filesystem tools.
  if (output.length === 0 && nativePaths.length > 0) {
    return nativePaths.map(path => ({ path, kind: 'file', nativePath: path }))
  }
  // OS URI payloads are the only reliable absolute-path source in ordinary
  // browsers. Prefer them when they line up with the dropped file count.
  if (nativePaths.length === output.length && nativePaths.length > 0) {
    return output.map((item, index) => ({ ...item, nativePath: nativePaths[index] }))
  }
  return output
}

async function uploadItems(items) {
  let totalBytes = 0
  const encoded = []
  for (const item of items) {
    if (item.kind === 'directory') {
      encoded.push({ path: item.path, kind: item.kind })
      continue
    }
    if (item.file.size > MAX_FILE_BYTES) throw new Error(`${item.path} exceeds the ${MAX_FILE_BYTES} byte file limit`)
    totalBytes += item.file.size
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error(`dropped files exceed the ${MAX_TOTAL_BYTES} byte batch limit`)
    encoded.push({
      path: item.path,
      kind: item.kind,
      data: base64FromBuffer(await item.file.arrayBuffer()),
    })
  }
  const response = await fetch(UPLOAD_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: encoded }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.ok !== true || !Array.isArray(payload.paths)) {
    throw new Error(typeof payload.error === 'string' ? payload.error : `upload failed (${response.status})`)
  }
  return payload.paths
}

function textareaFor(target) {
  if (target instanceof HTMLTextAreaElement) return target
  if (!(target instanceof Element)) return undefined
  const composer = target.closest('[data-composer-card]')
  return composer?.querySelector('textarea') ?? undefined
}

function notifyInput(input, level, message) {
  try { input?.notify?.(level, message); return } catch { /* fall through to toast */ }
  let toast = document.querySelector('[data-dsh-file-drop-toast]')
  if (toast === null) {
    toast = document.createElement('div')
    toast.setAttribute('data-dsh-file-drop-toast', '')
    toast.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;padding:9px 13px;border-radius:8px;background:#b42318;color:#fff;font:13px system-ui;box-shadow:0 5px 22px #0005;'
    document.body.append(toast)
  }
  toast.textContent = message
  window.setTimeout(() => toast?.remove(), 5000)
}

function attachmentIcon(kind) {
  if (kind === 'directory') {
    return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6.5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>'
  }
  return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 2.75h7l5 5V21H6z"/><path d="M13 2.75v5h5"/></svg>'
}

function ensureAttachmentStyle() {
  if (document.querySelector(STYLE_SELECTOR) !== null) return
  const style = document.createElement('style')
  style.setAttribute('data-dsh-file-drop-style', '')
  style.textContent = `
    ${RAIL_SELECTOR}{display:flex;flex-wrap:wrap;gap:8px;padding:10px 12px 2px;min-width:0}
    [data-dsh-file-drop-chip]{display:grid;grid-template-columns:36px minmax(0,1fr) 24px;align-items:center;column-gap:9px;width:min(240px,100%);min-height:52px;padding:6px 7px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 94%,currentColor 6%);color:inherit}
    [data-dsh-file-drop-icon]{display:flex;width:36px;height:36px;align-items:center;justify-content:center;border-radius:6px;background:color-mix(in srgb,currentColor 8%,transparent);color:var(--dsw-alias-label-secondary,currentColor)}
    [data-dsh-file-drop-copy]{min-width:0;line-height:1.2}
    [data-dsh-file-drop-name]{display:block;overflow:hidden;color:var(--dsw-alias-label-primary,currentColor);font-size:14px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}
    [data-dsh-file-drop-kind]{display:block;margin-top:3px;color:var(--dsw-alias-label-tertiary,currentColor);font-size:12px}
    [data-dsh-file-drop-remove]{display:flex;width:24px;height:24px;align-items:center;justify-content:center;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,currentColor);font:20px/1 system-ui;cursor:pointer}
    [data-dsh-file-drop-remove]:hover{background:color-mix(in srgb,currentColor 10%,transparent);color:var(--dsw-alias-label-primary,currentColor)}
    [data-dsh-file-drop-remove]:disabled{cursor:default;opacity:.45}
    [data-dsh-file-drop-submit-reference]{display:none!important}
    @media(max-width:560px){[data-dsh-file-drop-chip]{width:100%}}
  `
  document.head.append(style)
}

function railForComposer(composer) {
  let rail = composer.querySelector(`:scope > ${RAIL_SELECTOR}`)
  if (rail !== null) return rail
  rail = document.createElement('div')
  rail.setAttribute('data-dsh-file-drop-rail', '')
  rail.setAttribute('aria-label', 'Attached files and folders')
  const inputScroll = composer.querySelector(':scope > [data-input-scroll]')
  composer.insertBefore(rail, inputScroll ?? composer.firstChild)
  return rail
}

function renderAttachmentRail(ctx, records, removeAttachment) {
  const active = currentInput(ctx)
  const composers = [...document.querySelectorAll('[data-composer-card]')]
  if (active === undefined) {
    for (const composer of composers) composer.querySelector(`:scope > ${RAIL_SELECTOR}`)?.remove()
    return
  }
  const record = records.get(active.id)
  for (const composer of composers) {
    const textarea = composer.querySelector('textarea')
    if (textarea === null || record === undefined || record.items.length === 0) {
      composer.querySelector(`:scope > ${RAIL_SELECTOR}`)?.remove()
      continue
    }
    const busy = active.input.state.getSnapshot().phase === 'adjudicating' || active.input.state.getSnapshot().phase === 'submitting'
    const signature = JSON.stringify([busy, record.items.map(item => [item.path, item.kind])])
    const rail = railForComposer(composer)
    if (rail.dataset.signature === signature) continue
    rail.dataset.signature = signature
    rail.replaceChildren()
    for (const [index, item] of record.items.entries()) {
      const chip = document.createElement('div')
      chip.setAttribute('data-dsh-file-drop-chip', '')
      chip.title = item.path
      const icon = document.createElement('span')
      icon.setAttribute('data-dsh-file-drop-icon', '')
      icon.innerHTML = attachmentIcon(item.kind)
      const copy = document.createElement('span')
      copy.setAttribute('data-dsh-file-drop-copy', '')
      const label = document.createElement('span')
      label.setAttribute('data-dsh-file-drop-name', '')
      label.textContent = attachmentName(item.path)
      const kind = document.createElement('span')
      kind.setAttribute('data-dsh-file-drop-kind', '')
      kind.textContent = item.kind === 'directory' ? 'Folder' : 'File'
      copy.append(label, kind)
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.setAttribute('data-dsh-file-drop-remove', '')
      remove.setAttribute('aria-label', `Remove ${attachmentName(item.path)}`)
      remove.title = 'Remove attachment'
      remove.textContent = '\u00d7'
      remove.disabled = busy
      remove.addEventListener('click', () => removeAttachment(active.id, index))
      chip.append(icon, copy, remove)
      rail.append(chip)
    }
  }
}

function sidebarRoot() {
  const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (!(column instanceof HTMLElement)) return undefined
  return column.querySelector('[class*="logoRow"]')?.parentElement ?? column.firstElementChild
}

function newSessionButton(root) {
  return root?.querySelector('button[class*="newSession"]')
    ?? [...(root?.children ?? [])].find(child => child instanceof HTMLButtonElement)
}

function mountNeutralEntry(onClick) {
  if (document.querySelector(ENTRY_SELECTOR) !== null) return () => {}
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.setAttribute('data-dsh-file-drop-entry', '')
  entry.setAttribute('aria-label', 'General chat')
  entry.title = 'Start a conversation without a workspace'
  entry.innerHTML = '<span aria-hidden="true" style="display:inline-flex;width:18px;height:18px;align-items:center;justify-content:center"><svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 4.5h12v8H8l-3.2 2v-2H3z"/><path d="M6 7.5h6M6 10h4"/></svg></span><span>General chat</span>'
  entry.style.cssText = 'display:flex;align-items:center;gap:9px;width:100%;min-height:38px;padding:7px 12px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;'
  entry.addEventListener('click', onClick)
  let placed = false
  const place = () => {
    if (entry.isConnected) return
    const root = sidebarRoot()
    const button = newSessionButton(root)
    if (!(root instanceof HTMLElement) || !(button instanceof HTMLElement)) return
    const anchor = button.closest('[class*="logoRow"]')?.nextElementSibling ?? button.nextElementSibling
    root.insertBefore(entry, anchor ?? null)
    placed = true
  }
  const observer = new MutationObserver(place)
  observer.observe(document.body, { childList: true, subtree: true })
  place()
  return () => { observer.disconnect(); if (placed) entry.remove() }
}

function ensureOverlay() {
  let overlay = document.querySelector(OVERLAY_SELECTOR)
  if (overlay !== null) return overlay
  overlay = document.createElement('div')
  overlay.setAttribute('data-dsh-file-drop-overlay', '')
  overlay.textContent = 'Drop files or folders into the chat'
  overlay.style.cssText = 'display:none;position:fixed;inset:12px;z-index:2147483646;align-items:center;justify-content:center;border:2px dashed #4d9fff;border-radius:14px;background:#0b1424dd;color:#fff;font:600 17px system-ui;pointer-events:none;'
  document.body.append(overlay)
  return overlay
}

function currentInput(ctx) {
  const sessions = service(ctx, 'sessions')
  const conversation = service(ctx, 'conversation')
  const id = sessions?.list?.getSnapshot?.().current
  if (id === undefined || conversation?.input === undefined) return undefined
  const scope = sessions.scope?.(id)
  if (scope === undefined) return undefined
  return { input: conversation.input.for(scope), id }
}

function createReferenceSource(payloads) {
  const resolve = (ref) => {
    const items = payloads.get(ref)
    if (items === undefined || items.length === 0) throw new Error('the staged attachment reference is no longer available')
    const text = formatAttachmentReferences(items)
    if (text === '') throw new Error('the staged attachment path is invalid')
    return text
  }
  return {
    trigger: '@',
    name: REFERENCE_SOURCE,
    showGroupTitle: false,
    candidates: async () => [],
    onPick: () => undefined,
    codec: {
      clipboardText: resolve,
      serialize: async (ref, signal) => {
        if (signal.aborted) throw new Error('attachment reference serialization was cancelled')
        return resolve(ref)
      },
    },
  }
}

function resolveTextarea(ctx) {
  const current = currentInput(ctx)
  if (current !== undefined) return current
  return undefined
}

function activateNeutralComposer(sessions, id) {
  const session = sessions.binding?.(id)?.session
  if (session?.getSnapshot?.().composerPhase !== 'blank') return false
  if (typeof session.promptAttempted !== 'boolean' || typeof session.notifier?.markDirty !== 'function') return false
  // DSH rc.2 makes a blank ungrouped session inert until its first prompt, so
  // advance only the client-side phase marker without sending a fake message.
  session.promptAttempted = true
  session.notifier.markDirty()
  return true
}

async function startNeutral(ctx) {
  const sessions = service(ctx, 'sessions')
  if (typeof sessions?.create !== 'function' || typeof sessions.open !== 'function') throw new Error('the DSH session runtime is unavailable')
  const response = await fetch(CONTEXT_ROUTE, { headers: { accept: 'application/json' } })
  const payload = await response.json().catch(() => ({}))
  const cwd = normalizeNativePath(payload.cwd)
  if (!response.ok || payload.ok !== true || cwd === undefined) {
    throw new Error(typeof payload.error === 'string' ? payload.error : `failed to determine the General chat directory (${response.status})`)
  }
  const id = await sessions.create({ cwd })
  activateNeutralComposer(sessions, id)
  sessions.open(id)
  return id
}

async function resolveDropped(items) {
  const direct = []
  const upload = []
  for (const item of items) {
    const path = item.nativePath ?? nativeFilePath(item.file)
    if (path !== undefined) direct.push({ path, kind: item.kind })
    else upload.push(item)
  }
  const uploadedPaths = upload.length > 0 ? await uploadItems(upload) : []
  const roots = [...direct, ...uploadedPaths.map(path => ({ path, kind: 'file' }))]
  // `uploadItems` returns one path per top-level root. The server's root path
  // has no type marker, so infer directory roots from the original entries.
  for (let index = 0; index < uploadedPaths.length; index += 1) {
    const source = upload.find(item => item.path.split('/')[0] === uploadedPaths[index].split('/').pop())
    if (source?.kind === 'directory') roots[direct.length + index] = { path: uploadedPaths[index], kind: 'directory' }
  }
  for (const root of roots) {
    if (formatMention(root.path, root.kind) === undefined) throw new Error(`cannot represent dropped path: ${root.path}`)
  }
  return roots
}

const name = NAME
const inject = ['sessions', 'conversation', 'inputTriggers']

function apply(ctx) {
  ensureAttachmentStyle()
  const overlay = ensureOverlay()
  const records = new Map()
  const payloads = new Map()
  let referenceSequence = 0
  let syncQueued = false
  let disposed = false

  const markSubmitReferences = () => {
    const active = currentInput(ctx)
    const record = active === undefined ? undefined : records.get(active.id)
    const ids = new Set((active?.input.state.getSnapshot().occurrences ?? [])
      .filter(occurrence => occurrence.source === REFERENCE_SOURCE && occurrence.ref === record?.ref)
      .map(occurrence => String(occurrence.occurrenceId)))
    for (const node of document.querySelectorAll('[data-occurrence]')) {
      if (ids.has(node.getAttribute('data-occurrence') ?? '')) node.setAttribute('data-dsh-file-drop-submit-reference', '')
      else node.removeAttribute('data-dsh-file-drop-submit-reference')
    }
  }

  const render = () => {
    if (disposed) return
    renderAttachmentRail(ctx, records, removeAttachment)
    markSubmitReferences()
  }

  const restoreVisibleDraft = (record, draft) => {
    record.restoring = true
    record.input.setDraft(draft)
    record.restoring = false
  }

  const settleRecord = (record) => {
    const snapshot = record.input.state.getSnapshot()
    const busy = snapshot.phase === 'adjudicating' || snapshot.phase === 'submitting'
    if (record.submission !== undefined) {
      if (busy) {
        record.submission.started = true
        return
      }
      if (record.submission.started) {
        const failed = snapshot.occurrences.some(occurrence => occurrence.source === REFERENCE_SOURCE && occurrence.ref === record.ref)
        if (failed) restoreVisibleDraft(record, record.submission.originalDraft)
        else {
          record.items = []
          payloads.delete(record.ref)
        }
        record.submission = undefined
      }
    }
    if (record.submission !== undefined || record.restoring) return
    const draft = record.input.state.getSnapshot().draft
    if (record.items.length === 0) {
      if (draft.startsWith(EMPTY_DRAFT_SENTINEL)) restoreVisibleDraft(record, withoutSentinel(draft))
      return
    }
    if (draft.startsWith(EMPTY_DRAFT_SENTINEL)) {
      const visible = withoutSentinel(draft)
      if (visible.trim() !== '') {
        restoreVisibleDraft(record, visible)
        window.setTimeout(() => {
          const active = currentInput(ctx)
          const textarea = active?.id === record.id ? document.querySelector('[data-composer-card] textarea') : undefined
          if (!(textarea instanceof HTMLTextAreaElement)) return
          const start = Math.max(0, (textarea.selectionStart ?? 1) - 1)
          const end = Math.max(start, (textarea.selectionEnd ?? 1) - 1)
          textarea.setSelectionRange(start, end)
        }, 0)
      }
    } else if (draft.trim() === '') {
      restoreVisibleDraft(record, `${EMPTY_DRAFT_SENTINEL}${draft}`)
    }
  }

  const flush = () => {
    syncQueued = false
    if (disposed) return
    for (const record of records.values()) settleRecord(record)
    render()
  }

  const scheduleSync = () => {
    if (syncQueued || disposed) return
    syncQueued = true
    queueMicrotask(flush)
  }

  const rollbackUnstarted = (record) => {
    const originalDraft = record.submission?.originalDraft
    record.submission = undefined
    if (originalDraft !== undefined) restoreVisibleDraft(record, originalDraft)
    scheduleSync()
  }

  const submitRecord = (record, mode) => {
    if (record.items.length === 0 || record.submission !== undefined) return record.originalSubmit.call(record.input, mode)
    const before = record.input.state.getSnapshot()
    if (before.phase === 'adjudicating' || before.phase === 'submitting') return record.originalSubmit.call(record.input, mode)
    const originalDraft = withoutSentinel(before.draft)
    restoreVisibleDraft(record, originalDraft)
    let snapshot = record.input.state.getSnapshot()
    if (snapshot.draft !== '' && !/\s$/u.test(snapshot.draft)) {
      record.input.setDraft(`${snapshot.draft}\n`)
      snapshot = record.input.state.getSnapshot()
    }
    const accepted = record.input.insertReference({
      source: REFERENCE_SOURCE,
      ref: record.ref,
      label: '',
      appearance: 'file',
      clipboardText: formatAttachmentReferences(record.items),
    }, {
      start: snapshot.draft.length,
      end: snapshot.draft.length,
      draftRev: snapshot.draftRev,
    })
    if (!accepted) {
      restoreVisibleDraft(record, originalDraft)
      record.input.notify('error', 'the attachment references could not be prepared for submission')
      scheduleSync()
      return
    }
    snapshot = record.input.state.getSnapshot()
    const occurrence = snapshot.occurrences.find(value => value.source === REFERENCE_SOURCE && value.ref === record.ref)
    const gap = occurrence === undefined ? -1 : occurrence.offset + occurrence.length
    if (gap >= 0 && snapshot.draft[gap] === ' ') {
      record.input.setDraft(snapshot.draft.slice(0, gap) + snapshot.draft.slice(gap + 1))
    }
    record.submission = { originalDraft, started: false }
    try {
      record.originalSubmit.call(record.input, mode)
    } catch (error) {
      rollbackUnstarted(record)
      throw error
    }
    const after = record.input.state.getSnapshot()
    record.submission.started = after.phase === 'adjudicating' || after.phase === 'submitting'
    if (!record.submission.started) rollbackUnstarted(record)
    else scheduleSync()
  }

  const ensureRecord = (id, input) => {
    let record = records.get(id)
    if (record === undefined) {
      record = {
        id,
        ref: `attachment-batch-${++referenceSequence}`,
        items: [],
        input,
        originalSubmit: input.submit,
        wrappedSubmit: undefined,
        unsubscribe: undefined,
        submission: undefined,
        restoring: false,
      }
      record.wrappedSubmit = mode => submitRecord(record, mode)
      input.submit = record.wrappedSubmit
      record.unsubscribe = input.state.subscribe(scheduleSync)
      records.set(id, record)
    }
    return record
  }

  function removeAttachment(id, index) {
    const record = records.get(id)
    if (record === undefined || record.submission !== undefined) return
    record.items = record.items.filter((_, itemIndex) => itemIndex !== index)
    if (record.items.length === 0) payloads.delete(record.ref)
    else payloads.set(record.ref, record.items)
    settleRecord(record)
    render()
  }

  const stageAttachments = (id, input, items) => {
    const record = ensureRecord(id, input)
    record.items = uniqueAttachments([...record.items, ...items])
    payloads.set(record.ref, record.items)
    settleRecord(record)
    render()
  }

  const inputTriggers = service(ctx, 'inputTriggers')
  if (typeof inputTriggers?.registerSource !== 'function') throw new Error('the DSH input-trigger service is unavailable')
  const disposeReferenceSource = inputTriggers.registerSource(createReferenceSource(payloads))
  let dragDepth = 0
  const accepted = event => shouldClaimDrop(event.dataTransfer)
  const onDragEnter = event => {
    if (!accepted(event)) return
    if (!(event.target instanceof Node)) return
    const textarea = textareaFor(event.target)
    if (textarea === undefined) return
    event.preventDefault()
    event.stopPropagation()
    dragDepth += 1
    overlay.style.display = 'flex'
  }
  const onDragOver = event => {
    if (!accepted(event)) return
    if (!(event.target instanceof Node) || textareaFor(event.target) === undefined) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = event => {
    if (!accepted(event)) return
    if (!(event.target instanceof Node) || textareaFor(event.target) === undefined) return
    event.preventDefault()
    event.stopPropagation()
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) overlay.style.display = 'none'
  }
  const onDrop = async event => {
    if (!accepted(event)) return
    if (!(event.target instanceof Node)) {
      return
    }
    const textarea = textareaFor(event.target)
    if (textarea === undefined) return
    event.preventDefault()
    event.stopPropagation()
    dragDepth = 0
    overlay.style.display = 'none'
    try {
      const items = await collectDrop(event.dataTransfer)
      if (items.length === 0) throw new Error('no readable file or folder was found in the drop')
      let target = currentInput(ctx)
      if (target === undefined) {
        await startNeutral(ctx)
        // Session selection is published synchronously by the runtime, but a
        // renderer may not have committed the new textarea yet. Keep the
        // operation bounded and let the normal input notice explain a truly
        // unavailable composer rather than racing forever.
        for (let attempt = 0; attempt < 20 && target === undefined; attempt += 1) {
          await new Promise(resolve => window.setTimeout(resolve, 25))
          target = resolveTextarea(ctx)
        }
      }
      if (target === undefined) throw new Error('the conversation input is not ready yet')
      const roots = await resolveDropped(items)
      stageAttachments(target.id, target.input, roots)
      window.setTimeout(() => textareaFor(event.target)?.focus(), 0)
    } catch (error) {
      const target = currentInput(ctx)
      notifyInput(target?.input, 'error', error instanceof Error ? error.message : String(error))
    }
  }
  const onDragEnd = () => { dragDepth = 0; overlay.style.display = 'none' }
  document.addEventListener('dragenter', onDragEnter, true)
  document.addEventListener('dragover', onDragOver, true)
  document.addEventListener('dragleave', onDragLeave, true)
  document.addEventListener('drop', onDrop, true)
  window.addEventListener('dragend', onDragEnd)
  const domObserver = new MutationObserver(scheduleSync)
  domObserver.observe(document.body, { childList: true, subtree: true })
  scheduleSync()
  const disposeEntry = mountNeutralEntry(async () => {
    try { await startNeutral(ctx) } catch (error) { notifyInput(undefined, 'error', error instanceof Error ? error.message : String(error)) }
  })
  return () => {
    disposed = true
    document.removeEventListener('dragenter', onDragEnter, true)
    document.removeEventListener('dragover', onDragOver, true)
    document.removeEventListener('dragleave', onDragLeave, true)
    document.removeEventListener('drop', onDrop, true)
    window.removeEventListener('dragend', onDragEnd)
    domObserver.disconnect()
    disposeReferenceSource()
    for (const record of records.values()) {
      record.unsubscribe?.()
      if (record.input.submit === record.wrappedSubmit) record.input.submit = record.originalSubmit
      const draft = record.input.state.getSnapshot().draft
      if (draft.startsWith(EMPTY_DRAFT_SENTINEL)) record.input.setDraft(withoutSentinel(draft))
    }
    disposeEntry()
    overlay.remove()
    document.querySelector(STYLE_SELECTOR)?.remove()
    for (const rail of document.querySelectorAll(RAIL_SELECTOR)) rail.remove()
  }
}

exports.name = name
exports.inject = inject
exports.apply = apply
exports.hasWorkspaceFileDrag = hasWorkspaceFileDrag
exports.isImageOnly = isImageOnly
exports.shouldClaimDrop = shouldClaimDrop
exports.attachmentName = attachmentName
exports.formatAttachmentReferences = formatAttachmentReferences
exports.uniqueAttachments = uniqueAttachments
exports.createReferenceSource = createReferenceSource
exports.activateNeutralComposer = activateNeutralComposer
exports.startNeutral = startNeutral
return module.exports
  },
})
