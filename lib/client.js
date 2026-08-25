window.__ModuleLoader__.load({
  id: 'dsh-file-drop',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const NAME = 'dsh-file-drop/client'
    const UPLOAD_ROUTE = '/dsh-file-drop/upload'
    const MAX_FILES = 512
    const MAX_FILE_BYTES = 20 * 1024 * 1024
    const MAX_TOTAL_BYTES = 50 * 1024 * 1024
    const ENTRY_SELECTOR = '[data-dsh-file-drop-entry]'
    const OVERLAY_SELECTOR = '[data-dsh-file-drop-overlay]'

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

function insertAtCaret(text, mention, textarea) {
  const start = textarea && typeof textarea.selectionStart === 'number' ? textarea.selectionStart : text.length
  const end = textarea && typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : start
  const before = text.slice(0, start)
  const after = text.slice(end)
  const left = before !== '' && !/\s$/u.test(before) ? ' ' : ''
  const right = after !== '' && !/^\s/u.test(after) ? ' ' : ''
  const next = `${before}${left}${mention}${right}${after}`
  return { next, caret: before.length + left.length + mention.length + right.length }
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
  if (document.activeElement instanceof HTMLTextAreaElement) return document.activeElement
  return document.querySelector('textarea')
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

function resolveTextarea(ctx) {
  const current = currentInput(ctx)
  if (current !== undefined) return current
  return undefined
}

async function startNeutral(ctx) {
  const sessions = service(ctx, 'sessions')
  if (typeof sessions?.create !== 'function' || typeof sessions.open !== 'function') throw new Error('the DSH session runtime is unavailable')
  const id = await sessions.create()
  sessions.open(id)
  return id
}

async function insertDropped(ctx, target, items) {
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
  let draft = target.input.state.getSnapshot().draft
  const textarea = textareaFor(target.target)
  let caret = textarea && typeof textarea.selectionStart === 'number' ? textarea.selectionStart : draft.length
  for (const root of roots) {
    const mention = formatMention(root.path, root.kind)
    if (mention === undefined) throw new Error(`cannot represent dropped path: ${root.path}`)
    const insertion = insertAtCaret(draft, mention, { selectionStart: caret, selectionEnd: caret })
    draft = insertion.next
    caret = insertion.caret
  }
  target.input.setDraft(draft)
  window.setTimeout(() => {
    const nextTextarea = textareaFor(target.target)
    nextTextarea?.focus()
    nextTextarea?.setSelectionRange(caret, caret)
  }, 0)
}

const name = NAME
const inject = ['sessions', 'conversation']

function apply(ctx) {
  const overlay = ensureOverlay()
  let dragDepth = 0
  const accepted = event => event.dataTransfer !== null && !isImageOnly(event.dataTransfer)
  const onDragEnter = event => {
    if (!accepted(event) || !(event.target instanceof Node)) return
    const textarea = textareaFor(event.target)
    if (textarea === null) return
    event.preventDefault()
    dragDepth += 1
    overlay.style.display = 'flex'
  }
  const onDragOver = event => {
    if (!accepted(event) || !(event.target instanceof Node) || textareaFor(event.target) === null) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }
  const onDragLeave = event => {
    if (!accepted(event)) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) overlay.style.display = 'none'
  }
  const onDrop = async event => {
    if (!accepted(event) || !(event.target instanceof Node)) {
      dragDepth = 0
      overlay.style.display = 'none'
      return
    }
    const textarea = textareaFor(event.target)
    if (textarea === null) return
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
      target.target = event.target
      await insertDropped(ctx, target, items)
    } catch (error) {
      const target = currentInput(ctx)
      notifyInput(target?.input, 'error', error instanceof Error ? error.message : String(error))
    }
  }
  const onDragEnd = () => { dragDepth = 0; overlay.style.display = 'none' }
  document.addEventListener('dragenter', onDragEnter)
  document.addEventListener('dragover', onDragOver)
  document.addEventListener('dragleave', onDragLeave)
  document.addEventListener('drop', onDrop, true)
  window.addEventListener('dragend', onDragEnd)
  const disposeEntry = mountNeutralEntry(async () => {
    try { await startNeutral(ctx) } catch (error) { notifyInput(undefined, 'error', error instanceof Error ? error.message : String(error)) }
  })
  return () => {
    document.removeEventListener('dragenter', onDragEnter)
    document.removeEventListener('dragover', onDragOver)
    document.removeEventListener('dragleave', onDragLeave)
    document.removeEventListener('drop', onDrop, true)
    window.removeEventListener('dragend', onDragEnd)
    disposeEntry()
    overlay.remove()
  }
}

exports.name = name
exports.inject = inject
exports.apply = apply
return module.exports
  },
})
