import type { DocumentState } from '@/stores/help'
import {
  normalizeMarkdown,
  normalizeMarkdownLineEndings,
  resolveTrailingNewlinePolicy,
  type TrailingNewlinePolicy,
} from '@/services/trailing-newline'

export const EDITOR_SESSION_VERSION = 1 as const
export const MAX_EDITOR_SESSION_TABS = 100
export const MAX_EDITOR_SESSION_PATH_BYTES = 32 * 1024
export const MAX_EDITOR_SESSION_FILENAME_BYTES = 1024
export const MAX_EDITOR_SESSION_CURSOR_BYTES = 64 * 1024
export const MAX_EDITOR_SESSION_DRAFT_BYTES = 4 * 1024 * 1024
export const MAX_EDITOR_SESSION_TOTAL_DRAFT_BYTES = 16 * 1024 * 1024

export interface CleanEditorSessionTab {
  dirty: false
  path: string
  cursor?: unknown
  sourceSelection?: unknown
  sourceMode: boolean
}

export interface DirtyEditorSessionTab {
  dirty: true
  path?: string
  filename: string
  markdown: string
  lastSavedMarkdown: string
  encoding: string
  bom: boolean
  lineEnding: 'lf' | 'crlf'
  /** Optional for backward compatibility with version-1 snapshots. */
  trimTrailingNewline?: TrailingNewlinePolicy
  cursor?: unknown
  sourceSelection?: unknown
  sourceMode: boolean
}

export type EditorSessionTab = CleanEditorSessionTab | DirtyEditorSessionTab

export interface EditorSession {
  version: typeof EDITOR_SESSION_VERSION
  cleanShutdown: boolean
  timestamp: number
  workspacePath?: string
  activeTabIndex?: number
  tabs: EditorSessionTab[]
}

export interface SessionSnapshotInput {
  tabs: readonly DocumentState[]
  currentFileId: string | null
  workspacePath?: string | null
  cleanShutdown?: boolean
  excludeDirty?: boolean
  timestamp?: number
}

export type SessionDiskProbe =
  | { status: 'ok'; markdown: string }
  | { status: 'missing' }
  | { status: 'error'; message: string }

export interface SessionRestorePlanEntry {
  originalIndex: number
  tab: EditorSessionTab
  action: 'use-disk' | 'restore-draft' | 'ask-conflict' | 'restore-detached' | 'skip'
  reason?: string
}

const encoder = new TextEncoder()

function isRebuildableBlankPlaceholder(tab: DocumentState): boolean {
  return !tab.pathname
    && tab.isSaved
    && tab.markdown === ''
    && tab.lastSavedMarkdown === ''
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength
}

function cloneJsonValue(value: unknown): unknown | undefined {
  if (value === null || value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value)) as unknown
  } catch {
    return undefined
  }
}

function compactCursor(value: unknown): unknown | undefined {
  const cloned = cloneJsonValue(value)
  if (cloned === undefined) return undefined
  const json = JSON.stringify(cloned)
  return byteLength(json) <= MAX_EDITOR_SESSION_CURSOR_BYTES ? cloned : undefined
}

function extractSourceSelection(tab: DocumentState): unknown | undefined {
  if (tab.sourceSelection !== null && tab.sourceSelection !== undefined) {
    return compactCursor(tab.sourceSelection)
  }
  if (!tab.sourceEditorState || typeof tab.sourceEditorState !== 'object') return undefined
  return compactCursor((tab.sourceEditorState as Record<string, unknown>).selection)
}

/**
 * Produce the durable session shape. Clean files deliberately contain no
 * Markdown (nor CodeMirror history, which embeds the document); they are
 * re-read from disk during restore. Dirty buffers carry the minimum data that
 * prevents data loss after a renderer or process crash.
 */
export function buildEditorSessionSnapshot(input: SessionSnapshotInput): EditorSession {
  const included = input.tabs
    .map((tab, originalIndex) => ({ tab, originalIndex }))
    .filter(({ tab }) => !(input.excludeDirty && !tab.isSaved))
    // An untouched new document has no content to recover. Persisting it as a
    // dirty draft would make an otherwise clean-shutdown snapshot invalid.
    .filter(({ tab }) => !isRebuildableBlankPlaceholder(tab))
    .slice(0, MAX_EDITOR_SESSION_TABS)

  const tabs: EditorSessionTab[] = included.map(({ tab }): EditorSessionTab => {
    const cursor = compactCursor(tab.cursor)
    const sourceSelection = extractSourceSelection(tab)
    const common = {
      ...(cursor === undefined ? {} : { cursor }),
      ...(sourceSelection === undefined ? {} : { sourceSelection }),
      sourceMode: Boolean(tab.sourceMode),
    }

    if (tab.isSaved && tab.pathname) {
      return { dirty: false, path: tab.pathname, ...common }
    }

    return {
      dirty: true,
      ...(tab.pathname ? { path: tab.pathname } : {}),
      filename: tab.filename,
      markdown: tab.markdown,
      lastSavedMarkdown: tab.lastSavedMarkdown,
      encoding: tab.encoding.encoding,
      bom: tab.encoding.isBom,
      lineEnding: tab.lineEnding,
      trimTrailingNewline: tab.trimTrailingNewline,
      ...common,
    }
  })

  const activeTabIndex = included.findIndex(({ tab }) => tab.id === input.currentFileId)
  return {
    version: EDITOR_SESSION_VERSION,
    cleanShutdown: Boolean(input.cleanShutdown),
    timestamp: input.timestamp ?? Date.now(),
    ...(input.workspacePath?.trim() ? { workspacePath: input.workspacePath } : {}),
    ...(activeTabIndex >= 0 ? { activeTabIndex } : {}),
    tabs,
  }
}

/** Pure restore classification; UI code only has to resolve ask-conflict. */
export function createEditorSessionRestorePlan(
  session: EditorSession,
  probes: ReadonlyMap<string, SessionDiskProbe>,
  includeDirty: boolean,
  fallbackTrailingNewline: TrailingNewlinePolicy = 2,
): SessionRestorePlanEntry[] {
  return session.tabs.map((tab, originalIndex): SessionRestorePlanEntry => {
    if (!tab.dirty) {
      const probe = probes.get(tab.path)
      if (probe?.status === 'ok') return { originalIndex, tab, action: 'use-disk' }
      return {
        originalIndex,
        tab,
        action: 'skip',
        reason: probe?.status === 'error' ? probe.message : 'missing',
      }
    }
    if (!includeDirty) return { originalIndex, tab, action: 'skip', reason: 'discarded' }
    if (!tab.path) return { originalIndex, tab, action: 'restore-detached' }
    const probe = probes.get(tab.path)
    if (!probe || probe.status === 'missing') {
      return { originalIndex, tab, action: 'restore-detached' }
    }
    if (probe.status === 'error') {
      return { originalIndex, tab, action: 'restore-detached', reason: probe.message }
    }
    const trimTrailingNewline = tab.trimTrailingNewline
      ?? resolveTrailingNewlinePolicy(
        fallbackTrailingNewline,
        normalizeMarkdownLineEndings(tab.markdown),
      )
    const diskMarkdown = normalizeMarkdown(probe.markdown, trimTrailingNewline)
    const lastSavedMarkdown = normalizeMarkdown(tab.lastSavedMarkdown, trimTrailingNewline)
    return {
      originalIndex,
      tab,
      action: diskMarkdown === lastSavedMarkdown ? 'restore-draft' : 'ask-conflict',
    }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], subject: string) {
  const unknown = Object.keys(value).find(key => !allowed.includes(key))
  if (unknown) throw new Error(`${subject} contains unsupported field '${unknown}'`)
}

function assertString(value: unknown, label: string, maxBytes: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  if (byteLength(value) > maxBytes) throw new Error(`${label} is too large`)
}

function assertCompactJson(value: unknown, label: string) {
  if (value === undefined) return
  let json: string
  try { json = JSON.stringify(value) } catch { throw new Error(`${label} must be JSON serializable`) }
  if (json === undefined || byteLength(json) > MAX_EDITOR_SESSION_CURSOR_BYTES) {
    throw new Error(`${label} is too large`)
  }
}

/** Browser fallback and tests use the same structural limits as Rust IPC. */
export function assertValidEditorSession(value: unknown): asserts value is EditorSession {
  if (!isRecord(value)) throw new Error('editor session must be an object')
  assertKeys(value, ['version', 'cleanShutdown', 'timestamp', 'workspacePath', 'activeTabIndex', 'tabs'], 'editor session')
  if (value.version !== EDITOR_SESSION_VERSION) throw new Error(`unsupported editor session version: ${String(value.version)}`)
  if (typeof value.cleanShutdown !== 'boolean') throw new Error('cleanShutdown must be a boolean')
  if (typeof value.timestamp !== 'number' || !Number.isSafeInteger(value.timestamp) || value.timestamp < 0) {
    throw new Error('timestamp must be a non-negative integer')
  }
  if (value.workspacePath !== undefined) assertString(value.workspacePath, 'workspacePath', MAX_EDITOR_SESSION_PATH_BYTES)
  if (!Array.isArray(value.tabs) || value.tabs.length > MAX_EDITOR_SESSION_TABS) {
    throw new Error(`editor session may contain at most ${MAX_EDITOR_SESSION_TABS} tabs`)
  }
  if (value.activeTabIndex !== undefined && (
    !Number.isInteger(value.activeTabIndex)
    || (value.activeTabIndex as number) < 0
    || (value.activeTabIndex as number) >= value.tabs.length
  )) throw new Error('activeTabIndex is outside tabs')

  let totalDraftBytes = 0
  value.tabs.forEach((raw, index) => {
    if (!isRecord(raw)) throw new Error(`tabs[${index}] must be an object`)
    assertKeys(raw, [
      'dirty', 'path', 'filename', 'markdown', 'lastSavedMarkdown', 'encoding', 'bom',
      'lineEnding', 'trimTrailingNewline', 'cursor', 'sourceSelection', 'sourceMode',
    ], `tabs[${index}]`)
    if (typeof raw.dirty !== 'boolean') throw new Error(`tabs[${index}].dirty must be a boolean`)
    if (typeof raw.sourceMode !== 'boolean') throw new Error(`tabs[${index}].sourceMode must be a boolean`)
    if (raw.path !== undefined) assertString(raw.path, `tabs[${index}].path`, MAX_EDITOR_SESSION_PATH_BYTES)
    assertCompactJson(raw.cursor, `tabs[${index}].cursor`)
    assertCompactJson(raw.sourceSelection, `tabs[${index}].sourceSelection`)
    if (!raw.dirty) {
      if (raw.path === undefined) throw new Error(`clean tabs[${index}] requires path`)
      if (['filename', 'markdown', 'lastSavedMarkdown', 'encoding', 'bom', 'lineEnding', 'trimTrailingNewline'].some(key => raw[key] !== undefined)) {
        throw new Error(`clean tabs[${index}] must not persist document contents`)
      }
      return
    }
    assertString(raw.filename, `tabs[${index}].filename`, MAX_EDITOR_SESSION_FILENAME_BYTES)
    if (typeof raw.markdown !== 'string' || typeof raw.lastSavedMarkdown !== 'string') {
      throw new Error(`dirty tabs[${index}] requires markdown and lastSavedMarkdown`)
    }
    const draftBytes = byteLength(raw.markdown) + byteLength(raw.lastSavedMarkdown)
    if (draftBytes > MAX_EDITOR_SESSION_DRAFT_BYTES) throw new Error(`tabs[${index}] draft is too large`)
    totalDraftBytes += draftBytes
    assertString(raw.encoding, `tabs[${index}].encoding`, 64)
    if (typeof raw.bom !== 'boolean') throw new Error(`tabs[${index}].bom must be a boolean`)
    if (raw.lineEnding !== 'lf' && raw.lineEnding !== 'crlf') throw new Error(`tabs[${index}].lineEnding is invalid`)
    if (raw.trimTrailingNewline !== undefined && (
      !Number.isInteger(raw.trimTrailingNewline)
      || (raw.trimTrailingNewline as number) < 0
      || (raw.trimTrailingNewline as number) > 3
    )) throw new Error(`tabs[${index}].trimTrailingNewline is invalid`)
  })
  if (value.cleanShutdown && value.tabs.some(tab => isRecord(tab) && tab.dirty === true)) {
    throw new Error('a clean-shutdown session must not contain dirty drafts')
  }
  if (totalDraftBytes > MAX_EDITOR_SESSION_TOTAL_DRAFT_BYTES) throw new Error('total draft data is too large')
}

export function parseEditorSession(value: unknown): EditorSession {
  assertValidEditorSession(value)
  return structuredClone(value)
}

export interface EditorSessionWriter {
  schedule(): void
  flush(options?: { cleanShutdown?: boolean; excludeDirty?: boolean }): Promise<void>
  dispose(): void
}

export interface BoundedTaskOptions {
  concurrency?: number
  timeoutMs?: number
  signal?: AbortSignal
}

export type BoundedTaskResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }

function taskError(name: 'AbortError' | 'TimeoutError', message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

async function runOneBoundedTask<T>(
  task: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BoundedTaskResult<T>> {
  if (signal?.aborted) {
    return { status: 'rejected', reason: taskError('AbortError', 'Operation aborted') }
  }

  let timeout: ReturnType<typeof setTimeout> | null = null
  let removeAbortListener: () => void = () => undefined
  const work = Promise.resolve().then(task).then(
    value => ({ status: 'fulfilled', value }) as const,
    reason => ({ status: 'rejected', reason }) as const,
  )
  const races: Promise<BoundedTaskResult<T>>[] = [work]
  if (timeoutMs > 0) {
    races.push(new Promise(resolve => {
      timeout = setTimeout(() => resolve({
        status: 'rejected',
        reason: taskError('TimeoutError', `Operation timed out after ${timeoutMs} ms`),
      }), timeoutMs)
    }))
  }
  if (signal) {
    races.push(new Promise(resolve => {
      const onAbort = () => resolve({
        status: 'rejected',
        reason: taskError('AbortError', 'Operation aborted'),
      })
      signal.addEventListener('abort', onAbort, { once: true })
      removeAbortListener = () => signal.removeEventListener('abort', onAbort)
    }))
  }

  try {
    return await Promise.race(races)
  } finally {
    if (timeout) clearTimeout(timeout)
    removeAbortListener()
  }
}

/** Ordered task mapping with bounded concurrency and renderer-side cancellation. */
export async function runBoundedAsyncTasks<Input, Output>(
  inputs: readonly Input[],
  task: (input: Input, index: number) => Promise<Output>,
  options: BoundedTaskOptions = {},
): Promise<BoundedTaskResult<Output>[]> {
  if (!inputs.length) return []
  const concurrency = Math.max(1, Math.min(inputs.length, Math.floor(options.concurrency ?? 4)))
  const timeoutMs = Math.max(0, Math.floor(options.timeoutMs ?? 10_000))
  const results = new Array<BoundedTaskResult<Output>>(inputs.length)
  let cursor = 0
  let terminalReason: unknown

  const worker = async () => {
    while (cursor < inputs.length) {
      const index = cursor++
      const result = await runOneBoundedTask(
        () => task(inputs[index], index),
        timeoutMs,
        options.signal,
      )
      results[index] = result
      if (result.status === 'rejected' && (
        (result.reason as { name?: unknown })?.name === 'TimeoutError'
        || (result.reason as { name?: unknown })?.name === 'AbortError'
      )) {
        // The underlying IPC cannot be cancelled. Retire this worker slot so
        // a timed-out call never allows additional hidden work past the cap.
        terminalReason ??= result.reason
        return
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  for (let index = 0; index < results.length; index += 1) {
    results[index] ??= {
      status: 'rejected',
      reason: terminalReason ?? taskError('AbortError', 'Operation aborted'),
    }
  }
  return results
}

/** Writer-independent close fallback prevents stale crash drafts resurfacing. */
export async function persistCleanEditorSession(options: {
  writer: EditorSessionWriter | null
  excludeDirty: boolean
  snapshot: (flags: { cleanShutdown: boolean; excludeDirty: boolean }) => EditorSession
  write: (session: EditorSession) => Promise<void>
}): Promise<void> {
  const flags = { cleanShutdown: true, excludeDirty: options.excludeDirty }
  if (options.writer) {
    await options.writer.flush(flags)
    return
  }
  await options.write(options.snapshot(flags))
}

/** Ordered debounced writes prevent an older keystroke snapshot winning a race. */
export function createEditorSessionWriter(options: {
  snapshot: (flags: { cleanShutdown: boolean; excludeDirty: boolean }) => EditorSession
  write: (session: EditorSession) => Promise<void>
  delay?: number
  onError?: (error: unknown) => void
}): EditorSessionWriter {
  const delay = options.delay ?? 1000
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let writes: Promise<void> = Promise.resolve()

  const enqueue = (flags: { cleanShutdown: boolean; excludeDirty: boolean }) => {
    const snapshot = options.snapshot(flags)
    const operation = writes.then(() => options.write(snapshot))
    writes = operation.catch(error => {
      options.onError?.(error)
    })
    return operation
  }

  return {
    schedule() {
      if (disposed) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        void enqueue({ cleanShutdown: false, excludeDirty: false }).catch(() => undefined)
      }, delay)
    },
    async flush(flags = {}) {
      if (disposed && !flags.cleanShutdown) return writes
      if (timer) clearTimeout(timer)
      timer = null
      await enqueue({
        cleanShutdown: Boolean(flags.cleanShutdown),
        excludeDirty: Boolean(flags.excludeDirty),
      })
    },
    dispose() {
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
