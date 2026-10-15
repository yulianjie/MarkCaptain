/**
 * Editor store — port of the original `editor` Vuex module.
 *
 * Owns:
 * - `tabs`: every open document (in-memory state including markdown + history)
 * - `currentFileId`: which tab is active
 * - `toc`: hierarchical TOC for the current document
 *
 * Save / load round-trip through Tauri commands. File-system events
 * (`mt://fs/change`) are forwarded into reload prompts.
 *
 * The `pendingBaselineUpdate` flag preserves the legacy "first parse-roundtrip
 * after load isn't dirty" behaviour from the upstream editor — without it,
 * every freshly opened file is flagged as modified by Muya's normaliser.
 */

import { defineStore } from 'pinia'
import { computed, onScopeDispose, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import {
  getBlankFileState,
  getFileStateFromData,
  type DocumentState,
  type Encoding,
  type ExternalDocumentChange,
  type HistoryStack,
} from './help'
import { usePreferencesStore } from './preferences'
import { useNotificationStore } from './notification'
import {
  readMarkdown,
  localHistoryCapture,
  saveMarkdown,
  saveAsDialog,
  renameFile as renameFileCmd,
  type LoadedDocument,
} from '@/services/tauri-invoke'
import type { FileWatchEvent } from '@/services/tauri-bridge'
import type { CleanEditorSessionTab, DirtyEditorSessionTab } from '@/services/editor-session'
import { invalidatePaneViewState, setPaneViewField } from '@/services/pane-view-state'
import {
  normalizeMarkdown,
  normalizeMarkdownLineEndings,
  resolveTrailingNewlinePolicy,
} from '@/services/trailing-newline'
import { computeMarkdownWordCount } from '@/services/markdown-word-count'
import { t } from '@/i18n'

export function resolveDefaultLineEnding(
  setting: 'default' | 'lf' | 'crlf',
  platformName = typeof navigator === 'undefined' ? '' : navigator.platform,
): 'lf' | 'crlf' {
  if (setting === 'lf' || setting === 'crlf') return setting
  return /win/i.test(platformName) ? 'crlf' : 'lf'
}

export function requiresBomForReliableDetection(encoding: string): boolean {
  const compact = encoding.toLowerCase().replace(/[-_\s]/g, '')
  return compact.startsWith('utf16') || compact.startsWith('utf32')
}

export function normalizeComparablePath(pathname: string): string {
  const normalized = pathname.replace(/[\\/]+/g, '/').replace(/\/$/, '')
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}

export function pathsReferToSameFile(left: string, right: string): boolean {
  return Boolean(left && right) && normalizeComparablePath(left) === normalizeComparablePath(right)
}

function watcherPathParts(pathname: string): string[] {
  return pathname.replace(/[\\/]+/g, '/').replace(/\/$/, '').split('/')
}

/** Component-aware descendant check used for directory watcher events. */
export function pathIsSameOrDescendant(rootPath: string, candidatePath: string): boolean {
  if (!rootPath || !candidatePath) return false
  const windowsStyle = /^[a-z]:[\\/]/i.test(rootPath)
    || rootPath.startsWith('\\\\')
    || rootPath.startsWith('//')
  const root = watcherPathParts(rootPath)
  const candidate = watcherPathParts(candidatePath)
  if (candidate.length < root.length) return false
  return root.every((part, index) => windowsStyle
    ? part.toLocaleLowerCase() === candidate[index].toLocaleLowerCase()
    : part === candidate[index])
}

/** Map a file or directory descendant onto a watcher-provided rename target. */
export function remapWatchedDocumentPath(
  source: string,
  destination: string,
  candidate: string,
): string | null {
  if (!pathIsSameOrDescendant(source, candidate)) return null
  const suffix = watcherPathParts(candidate).slice(watcherPathParts(source).length)
  if (suffix.length === 0) return destination
  const separator = destination.includes('\\') ? '\\' : '/'
  return `${destination.replace(/[\\/]$/, '')}${separator}${suffix.join(separator)}`
}

export type ExternalMarkdownRelation = 'matches-editor' | 'unchanged-on-disk' | 'conflict'

export function classifyExternalMarkdown(
  lastSavedMarkdown: string,
  editorMarkdown: string,
  diskMarkdown: string,
): ExternalMarkdownRelation {
  if (diskMarkdown === editorMarkdown) return 'matches-editor'
  if (diskMarkdown === lastSavedMarkdown) return 'unchanged-on-disk'
  return 'conflict'
}

function cloneHistory(history: HistoryStack): HistoryStack {
  if (typeof structuredClone === 'function') return structuredClone(history)
  return JSON.parse(JSON.stringify(history)) as HistoryStack
}

export interface TocItem {
  level: number
  content: string
  slug?: string
  children?: TocItem[]
}

export type WindowCloseDecision = 'clean' | 'save' | 'discard' | 'cancel'

function flatToTree(flat: { lvl: number; content: string; slug?: string }[]): TocItem[] {
  const root: TocItem[] = []
  const stack: { level: number; node: TocItem }[] = []
  for (const it of flat) {
    const node: TocItem = { level: it.lvl, content: it.content, slug: it.slug, children: [] }
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop()
    if (!stack.length) root.push(node)
    else stack[stack.length - 1].node.children!.push(node)
    stack.push({ level: node.level, node })
  }
  return root
}

export const useEditorStore = defineStore('editor', () => {
  const prefs = usePreferencesStore()
  const notify = useNotificationStore()

  const tabs = ref<DocumentState[]>([])
  const currentFileId = ref<string | null>(null)
  const panes = ref([{ id: 'main', documentId: null as string | null, sourceMode: false }])
  const activePaneId = ref('main')
  const splitDirection = ref<'horizontal' | 'vertical'>('horizontal')
  const splitRatio = ref(0.5)
  const paneSizes = ref<Record<string, number>>({})
  const sharedHistoryDocuments = ref(new Set<string>())
  const usesSharedHistory = computed(() => Boolean(currentFileId.value && sharedHistoryDocuments.value.has(currentFileId.value)))
  const fileMutationBusy = ref(false)
  let fileMutationGeneration = 0
  const deferredFileEvents: FileWatchEvent[] = []
  function flushDeferredFileEvents() { for (const event of deferredFileEvents.splice(0)) void handleFileWatchEvent(event) }
  async function beginFileMutation() {
    if (fileMutationBusy.value) throw new Error('notes.changed')
    fileMutationGeneration++
    fileMutationBusy.value = true
    for (const tab of tabs.value) clearAutoSave(tab.id)
    // A clean buffer can still have a manual save in flight. Drain writes and
    // external reconciliation before a transaction takes its final snapshots.
    await Promise.allSettled([...saveQueues.values(), ...externalChangeQueues.values()])
  }
  function endFileMutation() {
    fileMutationBusy.value = false
    flushDeferredFileEvents()
    for (const tab of tabs.value) scheduleAutoSave(tab)
  }
  function activatePane(id: string) {
    if (activePaneId.value === id) return
    const pane = panes.value.find(p => p.id === id)
    if (!pane) return
    captureCurrentViewState()
    const previousHistory = currentFileId.value ? sharedHistory.get(currentFileId.value) : undefined
    if (previousHistory) previousHistory.time = 0
    // The destination pane may still be mounting. Never expose the previous
    // pane's cursor through the global Muya handle during that gap.
    clearMuyaInstance()
    activePaneId.value = id
    currentFileId.value = pane.documentId
    if (pane.documentId && panes.value.length > 1) sharedHistoryDocuments.value.add(pane.documentId)
    sourceCodeMode.value = pane.sourceMode
    listToc.value = []; currentSelectionFormats.value = []
  }
  function splitPane(direction: 'horizontal' | 'vertical') {
    splitDirection.value = direction
    if (panes.value.length >= 4) return
    if (currentFileId.value) sharedHistoryDocuments.value.add(currentFileId.value)
    panes.value.push({ id: crypto.randomUUID(), documentId: currentFileId.value, sourceMode: sourceCodeMode.value })
  }
  function closePane(id: string) {
    if (panes.value.length === 1) return
    panes.value = panes.value.filter(p => p.id !== id)
    if (activePaneId.value === id) activatePane(panes.value[0].id)
  }
  const sharedHistory = new Map<string, { undo: string[]; redo: string[]; last: string; time: number }>()
  let replayingHistory = false
  let separateHistoryEdit = false
  function recordSharedEdit(id: string, before: string, after: string) {
    if (before === after || replayingHistory) return
    const history = sharedHistory.get(id) ?? { undo: [], redo: [], last: before, time: 0 }
    if (separateHistoryEdit || Date.now() - history.time > 500 || history.last !== before) history.undo.push(before)
    if (history.undo.length > 200) history.undo.shift()
    history.redo = []; history.last = after; history.time = separateHistoryEdit ? 0 : Date.now(); sharedHistory.set(id, history)
  }
  function resetSharedHistory(id: string) {
    const tab = tabs.value.find(candidate => candidate.id === id)
    sharedHistory.set(id, { undo: [], redo: [], last: tab?.markdown ?? '', time: 0 })
    invalidatePaneViewState(id)
    if (!tab) return
    tab.history = { stack: [], index: -1 }
    tab.historyMarkdown = tab.markdown
    tab.sourceEditorState = null
    tab.sourceSelection = null
    tab.cursor = null
  }
  function stepSharedHistory(direction: 'undo' | 'redo') {
    const tab = currentFile.value; if (!tab) return
    const history = sharedHistory.get(tab.id); if (!history) return
    const source = direction === 'undo' ? history.undo : history.redo
    const destination = direction === 'undo' ? history.redo : history.undo
    const markdown = source.at(-1); if (markdown === undefined) return
    const handlerKey = `${activePaneId.value}:${sourceCodeMode.value ? 'source' : 'wysiwyg'}`
    if (!agentEditHandlers.has(handlerKey)) return
    source.pop()
    destination.push(tab.markdown); replayingHistory = true
    try { applyAgentEdit(tab.id, tab.markdown, markdown); history.last = tab.markdown }
    catch (error) { source.push(markdown); destination.pop(); throw error }
    finally { replayingHistory = false; history.time = 0 }
  }
  function hasSharedHistoryStep(direction: 'undo' | 'redo') { const history = currentFileId.value ? sharedHistory.get(currentFileId.value) : undefined; return Boolean(history?.[direction].length) }
  // Child editors mount before EditorPage's async startup restore. Keep their
  // bootstrap from creating an Untitled placeholder until restoration ends.
  const startupHydrationPending = ref(true)
  const listToc = ref<{ lvl: number; content: string; slug?: string }[]>([])
  /** True when the editor shows raw markdown source instead of WYSIWYG Muya. */
  const sourceCodeMode = ref(prefs.sourceCodeModeEnabled)
  /** True when the in-editor find/replace bar is visible. */
  const findReplaceOpen = ref(false)
  /** Flat list of "active" inline-format token names at the current Muya
   *  selection (e.g. `['strong', 'em']` on bold+italic text). Refreshed by
   *  the `selectionFormats` listener in MuyaEditor.vue and consumed by the
   *  toolbar / native menu ✓ marks. */
  const currentSelectionFormats = ref<string[]>([])
  /** Non-reactive handle to the live Muya instance, set by MuyaEditor on
   *  mount. Lets non-component code (e.g. menu actions / export) reach into
   *  Muya without dragging a ref around. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let muyaInstance: any = null
  const agentEditHandlers = new Map<string, (markdown: string) => void>()
  const insertHandlers = new Map<string, (text: string) => void | Promise<void>>()
  function registerInsertHandler(mode: 'source' | 'wysiwyg', handler: (text: string) => void | Promise<void>, paneId = 'main') {
    const key = `${paneId}:${mode}`
    insertHandlers.set(key, handler)
    return () => { if (insertHandlers.get(key) === handler) insertHandlers.delete(key) }
  }
  async function insertText(id: string, text: string, expectedView?: { paneId: string; sourceMode: boolean }) {
    if (fileMutationBusy.value) throw new Error('notes.changed')
    const paneId = expectedView?.paneId ?? activePaneId.value
    const sourceMode = expectedView?.sourceMode ?? sourceCodeMode.value
    if (currentFileId.value !== id || activePaneId.value !== paneId || sourceCodeMode.value !== sourceMode) throw new Error('agent:conflict')
    const handler = insertHandlers.get(`${paneId}:${sourceMode ? 'source' : 'wysiwyg'}`)
    if (!handler) throw new Error('agent:editorNotReady')
    separateHistoryEdit = true
    try { await handler(text) } finally { separateHistoryEdit = false }
  }

  function registerAgentEditHandler(mode: 'source' | 'wysiwyg', handler: (markdown: string) => void, paneId = 'main') {
    const key = `${paneId}:${mode}`
    agentEditHandlers.set(key, handler)
    return () => { if (agentEditHandlers.get(key) === handler) agentEditHandlers.delete(key) }
  }

  function applyAgentEdit(id: string, expected: string, markdown: string): string {
    if (fileMutationBusy.value) throw new Error('notes.changed')
    const tab = currentFile.value
    if (!tab || tab.id !== id || tab.markdown !== expected) throw new Error('agent:conflict')
    const handler = agentEditHandlers.get(`${activePaneId.value}:${sourceCodeMode.value ? 'source' : 'wysiwyg'}`)
    if (!handler) throw new Error('agent:editorNotReady')
    tab.pendingBaselineUpdate = false
    separateHistoryEdit = true
    try { handler(markdown) } finally { separateHistoryEdit = false }
    return tab.markdown
  }
  const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Reference-counted because directory-remove events may overlap. */
  const removalProbeCounts = new Map<string, number>()
  const saveQueues = new Map<string, Promise<boolean>>()
  const externalChangeQueues = new Map<string, Promise<void>>()
  const inFlightSaveMarkdown = new Map<string, string>()

  const currentFile = computed<DocumentState | null>(() => {
    if (!currentFileId.value) return null
    return tabs.value.find(t => t.id === currentFileId.value) ?? null
  })

  const toc = computed<TocItem[]>(() => flatToTree(listToc.value))

  const hasUnsaved = computed(() => tabs.value.some(t => !t.isSaved))

  /* ─── tab management ─────────────────────────────────────────── */

  function findTabByPath(pathname: string): DocumentState | undefined {
    return tabs.value.find(t => pathsReferToSameFile(t.pathname, pathname))
  }

  function setCurrent(id: string | null) {
    const previous = currentFile.value
    if (previous) previous.sourceMode = sourceCodeMode.value
    currentFileId.value = id
    if (id && panes.value.length > 1) sharedHistoryDocuments.value.add(id)
    const pane = panes.value.find(p => p.id === activePaneId.value)
    if (pane) pane.documentId = id
    const next = tabs.value.find(tab => tab.id === id)
    if (next) sourceCodeMode.value = next.sourceMode
    else {
      listToc.value = []
      currentSelectionFormats.value = []
      findReplaceOpen.value = false
    }
  }

  function newUntitledTab(initialMarkdown = '') {
    const normalized = normalizeMarkdownLineEndings(initialMarkdown)
    const trimTrailingNewline = resolveTrailingNewlinePolicy(
      prefs.trimTrailingNewline,
      normalized,
    )
    const file = getBlankFileState(
      tabs.value,
      prefs.defaultEncoding,
      resolveDefaultLineEnding(prefs.endOfLine),
      normalized,
    )
    file.trimTrailingNewline = trimTrailingNewline
    if (normalized !== '') { file.isSaved = false; file.lastSavedMarkdown = '' }
    file.sourceMode = sourceCodeMode.value
    tabs.value.push(file)
    setCurrent(file.id)
    return file
  }

  async function openFile(pathname: string) {
    if (fileMutationBusy.value) throw new Error('notes.changed')
    const expectedMutation = fileMutationGeneration
    const expectedPane = activePaneId.value
    const existing = findTabByPath(pathname)
    if (existing) {
      setCurrent(existing.id)
      return existing
    }
    const doc = await readMarkdown(pathname, {
      autoGuessEncoding: prefs.autoGuessEncoding,
      defaultEncoding: prefs.defaultEncoding,
    })
    if (fileMutationBusy.value || expectedMutation !== fileMutationGeneration || expectedPane !== activePaneId.value) throw new Error('notes.changed')
    return appendLoadedDocument(doc, pathname)
  }

  function appendLoadedDocument(doc: LoadedDocument, requestedPath = doc.path) {
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      void localHistoryCapture(doc.path, normalizeMarkdownLineEndings(doc.markdown), true).catch(error => notify.pushToast({ type: 'error', message: String(error) }))
    }
    const existing = findTabByPath(doc.path || requestedPath)
    if (existing) {
      setCurrent(existing.id)
      return existing
    }
    // Never put replacement characters into an editable/autosaved tab. Once
    // that tab is saved the original bytes are irrecoverable, so require the
    // user to choose a matching encoding in Preferences and reopen the file.
    if (doc.hadDecodeErrors) {
      throw new Error(t('toast.decodeFailed', { encoding: doc.encoding }))
    }
    const normalized = normalizeMarkdownLineEndings(doc.markdown)
    const trimTrailingNewline = resolveTrailingNewlinePolicy(
      prefs.trimTrailingNewline,
      normalized,
    )
    const filename = (doc.path || requestedPath).split(/[\\/]/).pop() || requestedPath
    const file = getFileStateFromData({
      markdown: normalized,
      pathname: doc.path || requestedPath,
      filename,
      encoding: { encoding: doc.encoding.toLowerCase(), isBom: doc.bom } as Encoding,
      lineEnding: (doc.lineEnding === 'crlf' ? 'crlf' : 'lf') as 'lf' | 'crlf',
      trimTrailingNewline,
    })
    file.pendingBaselineUpdate = true
    file.sourceMode = sourceCodeMode.value
    tabs.value.push(file)
    setCurrent(file.id)
    prefs.pushRecentFile(doc.path)
    return file
  }

  /**
   * Close a tab. If the tab has unsaved changes (and `force` is not set),
   * prompt the user with Save / Don't Save / Cancel:
   *   - Save     → save the tab, then close (aborts close if the save fails
   *                or the Save-As dialog is dismissed for an untitled tab)
   *   - Don't Save → close, discarding changes
   *   - Cancel   → keep the tab open
   * Returns `true` if the tab was closed.
   */
  async function requestTabCloseDecision(tab: DocumentState): Promise<WindowCloseDecision> {
    if (tab.isSaved) return 'clean'
    try {
      await ElMessageBox.confirm(
        t('closeConfirm.detail'),
        t('closeConfirm.message', { filename: tab.filename }),
        {
          confirmButtonText: t('closeConfirm.save'),
          cancelButtonText: t('closeConfirm.dontSave'),
          distinguishCancelAndClose: true,
          type: 'warning',
          closeOnClickModal: false,
        },
      )
      return 'save'
    } catch (action) {
      // ElMessageBox rejects with 'cancel' (cancel button) or 'close' (X / Esc).
      return action === 'cancel' ? 'discard' : 'cancel'
    }
  }

  async function closeTab(id: string, force = false): Promise<boolean> {
    const tab = tabs.value.find(t => t.id === id)
    if (!tab) return false

    const decision = force ? 'discard' : await requestTabCloseDecision(tab)
    if (decision === 'cancel') return false
    if (decision === 'save' && !await saveTab(tab)) return false

    removeTab(id)
    return true
  }

  /**
   * Close a set of tabs as one transaction for destructive project actions.
   * No tab is removed until every prompt has been accepted and every requested
   * save has completed successfully.
   */
  async function closeTabsTransactionally(ids: readonly string[]): Promise<boolean> {
    const uniqueIds = [...new Set(ids)]
    const candidates = uniqueIds
      .map(id => tabs.value.find(tab => tab.id === id))
      .filter((tab): tab is DocumentState => Boolean(tab))
    const decisions = new Map<string, WindowCloseDecision>()
    const decisionMarkdown = new Map<string, string>()

    // Phase 1: collect every decision without saving or removing any tab.
    for (const tab of candidates) {
      const decision = await requestTabCloseDecision(tab)
      if (decision === 'cancel') return false
      decisions.set(tab.id, decision)
      decisionMarkdown.set(tab.id, tab.markdown)
    }

    // Phase 2: perform requested saves. A failed write or cancelled Save As
    // leaves every candidate open, including tabs already marked for discard.
    for (const tab of candidates) {
      if (decisions.get(tab.id) !== 'save') continue
      if (!await saveTab(tab) || !tab.isSaved) return false
    }

    // A clean or successfully saved tab may become dirty again while another
    // save is still in flight. Only an explicit discard decision permits a
    // dirty tab at commit time.
    for (const tab of candidates) {
      if (!tabs.value.some(candidate => candidate.id === tab.id)) return false
      const decision = decisions.get(tab.id)
      if (decision === 'discard') {
        if (tab.markdown !== decisionMarkdown.get(tab.id)) return false
      } else if (!tab.isSaved) {
        return false
      }
    }

    for (const tab of candidates) removeTab(tab.id)
    return true
  }

  /**
   * Resolve all unsaved tabs before the native window is destroyed. The
   * renderer owns the prompt so the title-bar X and File → Close Window can
   * share exactly the same Save / Don't Save / Cancel decision.
   */
  async function prepareWindowCloseWithDecision(): Promise<WindowCloseDecision> {
    const unsaved = tabs.value.filter(tab => !tab.isSaved)
    if (!unsaved.length) return 'clean'

    const names = unsaved.slice(0, 5).map(tab => tab.filename).join(', ')
    const suffix = unsaved.length > 5 ? ` (+${unsaved.length - 5})` : ''
    let choice: 'save' | 'dontSave' | 'cancel'
    try {
      await ElMessageBox.confirm(
        t('closeConfirm.windowDetail', { files: `${names}${suffix}` }),
        t('closeConfirm.windowMessage', { count: unsaved.length }),
        {
          confirmButtonText: t('closeConfirm.saveAll'),
          cancelButtonText: t('closeConfirm.dontSave'),
          distinguishCancelAndClose: true,
          type: 'warning',
          closeOnClickModal: false,
        },
      )
      choice = 'save'
    } catch (action) {
      choice = action === 'cancel' ? 'dontSave' : 'cancel'
    }

    if (choice === 'cancel') return 'cancel'
    if (choice === 'dontSave') return 'discard'
    return await saveAllTabs() ? 'save' : 'cancel'
  }

  async function prepareWindowClose(): Promise<boolean> {
    return await prepareWindowCloseWithDecision() !== 'cancel'
  }

  /** Remove a tab from the list and pick a sensible next active tab. */
  function removeTab(id: string) {
    sharedHistoryDocuments.value.delete(id)
    sharedHistory.delete(id)
    for (const pane of panes.value) if (pane.documentId === id) pane.documentId = null
    clearAutoSave(id)
    removalProbeCounts.delete(id)
    saveQueues.delete(id)
    externalChangeQueues.delete(id)
    inFlightSaveMarkdown.delete(id)
    const idx = tabs.value.findIndex(t => t.id === id)
    if (idx === -1) return
    tabs.value.splice(idx, 1)
    if (currentFileId.value === id) {
      const next = tabs.value[idx] || tabs.value[idx - 1] || null
      setCurrent(next?.id ?? null)
    }
  }

  function exchangeTabs(fromIndex: number, toIndex: number) {
    if (
      fromIndex < 0 || fromIndex >= tabs.value.length ||
      toIndex < 0 || toIndex >= tabs.value.length
    ) return
    const [item] = tabs.value.splice(fromIndex, 1)
    tabs.value.splice(toIndex, 0, item)
  }

  /* ─── content change & save ──────────────────────────────────── */

  function clearAutoSave(id: string): void {
    const timer = autoSaveTimers.get(id)
    if (timer !== undefined) clearTimeout(timer)
    autoSaveTimers.delete(id)
  }

  function beginRemovalProbe(id: string): void {
    removalProbeCounts.set(id, (removalProbeCounts.get(id) ?? 0) + 1)
  }

  /** Returns true only when this was the tab's final active probe. */
  function finishRemovalProbe(id: string): boolean {
    const remaining = (removalProbeCounts.get(id) ?? 0) - 1
    if (remaining <= 0) {
      removalProbeCounts.delete(id)
      return true
    }
    removalProbeCounts.set(id, remaining)
    return false
  }

  function scheduleAutoSave(tab: DocumentState): void {
    clearAutoSave(tab.id)
    // Never open a Save-As dialog merely because the user enabled autosave.
    if (
      fileMutationBusy.value
      || (removalProbeCounts.get(tab.id) ?? 0) > 0
      || !prefs.autoSave
      || tab.isSaved
      || !tab.pathname
      || tab.autoSaveBlocked
      || tab.externalChange
    ) return
    const delay = Math.max(0, Number(prefs.autoSaveDelay) || 0)
    autoSaveTimers.set(tab.id, setTimeout(() => {
      autoSaveTimers.delete(tab.id)
      void saveTab(tab)
    }, delay))
  }

  /**
   * Called from the Muya `change` handler. The first call after load is the
   * parse-roundtrip baseline — don't dirty the buffer for that one.
   */
  function applyContentChange(id: string, markdown: string, payload?: {
    wordCount?: DocumentState['wordCount']
    cursor?: unknown
    history?: HistoryStack
    toc?: { lvl: number; content: string; slug?: string }[]
  }) {
    const tab = tabs.value.find(t => t.id === id)
    if (!tab) return
    const normalized = normalizeMarkdownLineEndings(markdown)
    // Muya represents an otherwise empty document as one synthetic line.
    // Keep that implementation detail out of the document and disk baseline.
    const nextMarkdown = tab.markdown === '' && normalized === '\n' ? '' : normalized
    if (!tab.pendingBaselineUpdate) recordSharedEdit(id, tab.markdown, nextMarkdown)
    if (tab.pendingBaselineUpdate) {
      tab.pendingBaselineUpdate = false
      tab.markdown = nextMarkdown
      tab.isSaved = true
    } else if (tab.markdown !== nextMarkdown) {
      // Muya always serializes a final newline. A save may have removed it
      // according to this file's policy; the next selection/change event
      // must not turn that same saved content into a new unsaved edit.
      const remainsSaved = tab.isSaved
        && tab.trimTrailingNewline === 0
        && !tab.markdown.endsWith('\n')
        && nextMarkdown === `${tab.markdown}\n`
      tab.markdown = nextMarkdown
      tab.isSaved = remainsSaved
      scheduleAutoSave(tab)
    }
    if (payload?.wordCount) tab.wordCount = payload.wordCount
    if (payload?.cursor !== undefined) tab.cursor = payload.cursor
    if (payload?.history) {
      tab.history = cloneHistory(payload.history)
      tab.historyMarkdown = nextMarkdown
    }
    if (payload?.toc && id === currentFileId.value) listToc.value = payload.toc
  }

  function externalChangeFromLoaded(
    loaded: LoadedDocument,
    kind: ExternalDocumentChange['kind'],
    previousPath?: string,
  ): ExternalDocumentChange {
    return {
      kind,
      path: loaded.path,
      previousPath,
      markdown: normalizeMarkdownLineEndings(loaded.markdown),
      encoding: { encoding: loaded.encoding.toLowerCase(), isBom: loaded.bom },
      lineEnding: loaded.lineEnding === 'crlf' ? 'crlf' : 'lf',
    }
  }

  function applyExternalDocument(tab: DocumentState, change: ExternalDocumentChange): void {
    clearAutoSave(tab.id)
    tab.pathname = change.path
    tab.filename = change.path.split(/[\\/]/).pop() || tab.filename
    tab.markdown = change.markdown
    tab.lastSavedMarkdown = change.markdown
    tab.encoding = { ...change.encoding }
    tab.lineEnding = change.lineEnding
    tab.adjustLineEndingOnSave = change.lineEnding === 'crlf'
    tab.isSaved = true
    tab.pendingBaselineUpdate = false
    resetSharedHistory(tab.id)
    tab.externalChange = null
    tab.autoSaveBlocked = false
    if (tab.id === currentFileId.value) listToc.value = []
  }

  async function promptForExternalConflict(tab: DocumentState): Promise<void> {
    const change = tab.externalChange
    if (!change) return

    let choice: 'reload' | 'keepLocal' | 'cancel'
    try {
      await ElMessageBox.confirm(
        t('externalChange.detail', { filename: tab.filename }),
        t('externalChange.title'),
        {
          confirmButtonText: t('externalChange.reload'),
          cancelButtonText: t('externalChange.keepLocal'),
          distinguishCancelAndClose: true,
          type: 'warning',
          closeOnClickModal: false,
        },
      )
      choice = 'reload'
    } catch (action) {
      choice = action === 'cancel' ? 'keepLocal' : 'cancel'
    }

    if (!tabs.value.some(candidate => candidate.id === tab.id)) return
    if (choice === 'reload') {
      applyExternalDocument(tab, change)
      return
    }
    if (choice === 'keepLocal') {
      // The user explicitly chose their editor buffer. Record the new disk
      // baseline, but leave autosave paused so only a later manual Save can
      // overwrite that external content.
      tab.lastSavedMarkdown = change.markdown
      tab.externalChange = null
      tab.autoSaveBlocked = true
      notify.pushToast({
        type: 'warning',
        title: t('externalChange.title'),
        message: t('externalChange.autoSavePaused'),
      })
    }
    // Closing/Esc leaves externalChange intact. saveTab() will ask again before
    // it permits the editor buffer to overwrite the disk version.
  }

  async function processLoadedExternalChange(
    tab: DocumentState,
    loaded: LoadedDocument,
    kind: ExternalDocumentChange['kind'],
    previousPath?: string,
  ): Promise<void> {
    if (loaded.hadDecodeErrors) {
      clearAutoSave(tab.id)
      tab.autoSaveBlocked = true
      notify.pushToast({
        type: 'error',
        title: t('externalChange.title'),
        message: t('toast.decodeFailed', { encoding: loaded.encoding }),
      })
      return
    }

    const change = externalChangeFromLoaded(loaded, kind, previousPath)
    const inFlightMarkdown = inFlightSaveMarkdown.get(tab.id)
    if (inFlightMarkdown !== undefined && change.markdown === inFlightMarkdown) {
      tab.lastSavedMarkdown = change.markdown
      tab.isSaved = tab.markdown === change.markdown
      return
    }

    const relation = classifyExternalMarkdown(
      normalizeMarkdown(tab.lastSavedMarkdown, tab.trimTrailingNewline),
      normalizeMarkdown(tab.markdown, tab.trimTrailingNewline),
      normalizeMarkdown(change.markdown, tab.trimTrailingNewline),
    )
    if (relation === 'matches-editor') {
      clearAutoSave(tab.id)
      tab.lastSavedMarkdown = change.markdown
      tab.encoding = { ...change.encoding }
      tab.lineEnding = change.lineEnding
      tab.adjustLineEndingOnSave = change.lineEnding === 'crlf'
      // Keep a clean Muya buffer clean when disk uses an equivalent EOF
      // representation, but do not discard still-unsaved blank-line edits.
      tab.isSaved = tab.isSaved || tab.markdown === change.markdown
      tab.externalChange = null
      tab.autoSaveBlocked = false
      if (!tab.isSaved) scheduleAutoSave(tab)
      return
    }
    if (relation === 'unchanged-on-disk') {
      // Metadata-only events and our own delayed watcher notifications don't
      // invalidate a newer local buffer.
      return
    }
    if (tab.isSaved) {
      applyExternalDocument(tab, change)
      notify.pushToast({
        type: 'info',
        title: t('externalChange.title'),
        message: t('externalChange.reloaded', { filename: tab.filename }),
      })
      return
    }

    clearAutoSave(tab.id)
    tab.externalChange = change
    tab.autoSaveBlocked = true
    await promptForExternalConflict(tab)
  }

  function queueExternalChange(tab: DocumentState, operation: () => Promise<void>): Promise<void> {
    const previous = externalChangeQueues.get(tab.id) ?? Promise.resolve()
    const queued = previous.catch(() => undefined).then(operation)
    externalChangeQueues.set(tab.id, queued)
    const cleanup = () => {
      if (externalChangeQueues.get(tab.id) === queued) externalChangeQueues.delete(tab.id)
    }
    void queued.then(cleanup, cleanup)
    return queued
  }

  async function readExternalPath(pathname: string): Promise<LoadedDocument> {
    return await readMarkdown(pathname, {
      autoGuessEncoding: prefs.autoGuessEncoding,
      defaultEncoding: prefs.defaultEncoding,
    })
  }

  function detachRemovedTab(tab: DocumentState): void {
    clearAutoSave(tab.id)
    tab.pathname = ''
    tab.isSaved = false
    tab.lastSavedMarkdown = ''
    tab.externalChange = null
    tab.autoSaveBlocked = false
    notify.pushToast({
      type: 'warning',
      title: t('externalChange.removedTitle'),
      message: t('externalChange.removed', { filename: tab.filename }),
    })
  }

  async function reconcileRemovedDirectoryTabs(affected: DocumentState[]): Promise<void> {
    const pending = affected.map(tab => ({ tab, pathname: tab.pathname }))
    for (const { tab } of pending) {
      beginRemovalProbe(tab.id)
      clearAutoSave(tab.id)
    }

    // Reads are bounded and per-tab queued. This confirms that a directory
    // remove event was not a transient atomic replacement without serially
    // blocking on every open descendant.
    const concurrency = 4
    let cursor = 0

    async function probeNext(): Promise<void> {
      while (cursor < pending.length) {
        const { tab, pathname } = pending[cursor++]
        let pathStillExists = false
        try {
          await queueExternalChange(tab, async () => {
            const stillOpen = tabs.value.some(candidate => candidate.id === tab.id)
            if (!stillOpen || !pathsReferToSameFile(tab.pathname, pathname)) return
            try {
              await readExternalPath(pathname)
              pathStillExists = true
            } catch {
              const remainsOpen = tabs.value.some(candidate => candidate.id === tab.id)
              if (remainsOpen && pathsReferToSameFile(tab.pathname, pathname)) {
                detachRemovedTab(tab)
              }
            }
          })
        } catch {
          // Read failures are handled inside the queued operation. Any other
          // per-tab failure must not stop workers from releasing later gates.
        } finally {
          const finalProbe = finishRemovalProbe(tab.id)
          const stillOpen = tabs.value.some(candidate => candidate.id === tab.id)
          const pathChanged = Boolean(tab.pathname)
            && !pathsReferToSameFile(tab.pathname, pathname)
          if (finalProbe && stillOpen && !tab.isSaved && (pathStillExists || pathChanged)) {
            scheduleAutoSave(tab)
          }
        }
      }
    }

    const workers = Array.from(
      { length: Math.min(concurrency, pending.length) },
      () => probeNext(),
    )
    await Promise.allSettled(workers)
  }

  /** Safely reconcile watcher events for documents that are already open. */
  async function handleFileWatchEvent(event: FileWatchEvent): Promise<void> {
    if (fileMutationBusy.value) { deferredFileEvents.push(event); return }
    if (event.kind === 'created') return

    if (event.kind === 'renamed') {
      const affected = tabs.value.flatMap(tab => {
        const mapped = tab.pathname
          ? remapWatchedDocumentPath(event.from, event.to, tab.pathname)
          : null
        return mapped ? [{ tab, mapped, exact: pathsReferToSameFile(tab.pathname, event.from) }] : []
      })
      for (const { tab, mapped, exact } of affected) {
        const previousPath = tab.pathname
        // Update the identity synchronously so a following Modified event for
        // the new name can find this tab even while the read is queued.
        tab.pathname = mapped
        tab.filename = mapped.split(/[\\/]/).pop() || tab.filename
        if (tab.externalChange) {
          const mappedChangePath = remapWatchedDocumentPath(
            event.from,
            event.to,
            tab.externalChange.path,
          )
          const mappedPreviousPath = tab.externalChange.previousPath
            ? remapWatchedDocumentPath(event.from, event.to, tab.externalChange.previousPath)
            : null
          tab.externalChange = {
            ...tab.externalChange,
            ...(mappedChangePath ? { path: mappedChangePath } : {}),
            ...(mappedPreviousPath ? { previousPath: mappedPreviousPath } : {}),
          }
        }
        // A directory rename preserves each child's contents. Re-reading all
        // descendants would create spurious conflict prompts and unnecessary
        // IPC; exact file renames retain the existing reconciliation path.
        if (!exact) continue
        await queueExternalChange(tab, async () => {
          try {
            const loaded = await readExternalPath(mapped)
            await processLoadedExternalChange(tab, loaded, 'renamed', previousPath)
          } catch (error) {
            clearAutoSave(tab.id)
            tab.autoSaveBlocked = true
            notify.pushToast({
              type: 'warning',
              title: t('externalChange.title'),
              message: error instanceof Error ? error.message : String(error),
            })
          }
        })
      }
      return
    }

    if (event.kind === 'removed') {
      const descendants = tabs.value.filter(tab => (
        tab.pathname
        && !pathsReferToSameFile(tab.pathname, event.path)
        && pathIsSameOrDescendant(event.path, tab.pathname)
      ))
      if (descendants.length) await reconcileRemovedDirectoryTabs(descendants)
    }

    const affected = tabs.value.filter(tab => pathsReferToSameFile(tab.pathname, event.path))
    for (const tab of affected) {
      await queueExternalChange(tab, async () => {
        if (event.kind === 'modified') {
          try {
            const loaded = await readExternalPath(event.path)
            await processLoadedExternalChange(tab, loaded, 'modified')
          } catch (error) {
            clearAutoSave(tab.id)
            tab.autoSaveBlocked = true
            notify.pushToast({
              type: 'warning',
              title: t('externalChange.title'),
              message: error instanceof Error ? error.message : String(error),
            })
          }
          return
        }

        // Atomic replacements may briefly surface as Removed even though the
        // destination already exists again. Re-read first; only detach the tab
        // when the file is genuinely gone.
        try {
          const loaded = await readExternalPath(event.path)
          await processLoadedExternalChange(tab, loaded, 'modified')
          return
        } catch { /* genuinely removed */ }

        detachRemovedTab(tab)
      })
    }
  }

  async function saveCurrent(): Promise<boolean> {
    const tab = currentFile.value
    if (!tab) return false
    return await saveTab(tab)
  }

  function queueTabSave(tab: DocumentState, targetPath?: string): Promise<boolean> {
    if (fileMutationBusy.value) return Promise.resolve(false)
    clearAutoSave(tab.id)
    const previous = saveQueues.get(tab.id) ?? Promise.resolve(true)
    const operation = previous.then(
      () => saveTabNow(tab, targetPath),
      () => saveTabNow(tab, targetPath),
    )
    saveQueues.set(tab.id, operation)
    const cleanup = () => {
      if (saveQueues.get(tab.id) === operation) saveQueues.delete(tab.id)
    }
    void operation.then(cleanup, cleanup)
    return operation
  }

  function saveTab(tab: DocumentState): Promise<boolean> {
    return queueTabSave(tab)
  }

  function saveTabAs(tab: DocumentState, targetPath: string): Promise<boolean> {
    if (!targetPath.trim()) return Promise.resolve(false)
    return queueTabSave(tab, targetPath)
  }

  async function resolveExternalChangeBeforeSave(tab: DocumentState): Promise<boolean> {
    const change = tab.externalChange
    if (!change) return true

    try {
      await ElMessageBox.confirm(
        t('externalChange.overwriteDetail', { filename: tab.filename }),
        t('externalChange.overwriteTitle'),
        {
          confirmButtonText: t('externalChange.overwrite'),
          cancelButtonText: t('externalChange.reload'),
          distinguishCancelAndClose: true,
          type: 'warning',
          closeOnClickModal: false,
        },
      )
      tab.lastSavedMarkdown = change.markdown
      tab.externalChange = null
      tab.autoSaveBlocked = false
      return true
    } catch (action) {
      if (action === 'cancel') applyExternalDocument(tab, change)
      return false
    }
  }

  async function saveTabNow(tab: DocumentState, requestedPath?: string): Promise<boolean> {
    if (fileMutationBusy.value) return false
    try {
      if (!await resolveExternalChangeBeforeSave(tab)) return false
      const originalPath = tab.pathname
      let path = requestedPath ?? originalPath
      const wasUntitled = !originalPath
      if (!path) {
        const picked = await saveAsDialog(tab.filename.endsWith('.md') ? tab.filename : `${tab.filename}.md`)
        if (!picked) return false
        path = picked
      }
      const nextFilename = path.split(/[\\/]/).pop() || tab.filename
      const editorSnapshot = tab.markdown
      const markdown = normalizeMarkdown(editorSnapshot, tab.trimTrailingNewline)
      const bom = tab.encoding.isBom || (
        wasUntitled && requiresBomForReliableDetection(tab.encoding.encoding)
      )
      inFlightSaveMarkdown.set(tab.id, markdown)
      try {
        if (tab.pathname && typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
          try {
            await localHistoryCapture(tab.pathname, tab.lastSavedMarkdown, true)
            await localHistoryCapture(tab.pathname, markdown, true)
          } catch (error) { notify.pushToast({ type: 'warning', message: t('notes.historyWarning', { error: String(error) }) }) }
        }
        await saveMarkdown(path, markdown, {
          encoding: tab.encoding.encoding,
          lineEnding: tab.lineEnding,
          bom,
        })
      } finally {
        if (inFlightSaveMarkdown.get(tab.id) === markdown) inFlightSaveMarkdown.delete(tab.id)
      }
      const identityMovedDuringNormalSave = requestedPath === undefined
        && originalPath !== ''
        && !pathsReferToSameFile(tab.pathname, originalPath)
      if (identityMovedDuringNormalSave) {
        // A watcher may remap the tab while the old path is still being
        // written. That write belongs only to the old identity: never make
        // the remapped document clean or replace its path/baseline with it.
        tab.isSaved = false
        scheduleAutoSave(tab)
        notify.pushToast({
          type: 'warning',
          title: t('toast.saveFailed'),
          message: t('externalChange.savePathChanged', { filename: tab.filename }),
        })
        return false
      }
      tab.encoding.isBom = bom
      tab.pathname = path
      tab.filename = nextFilename
      tab.lastSavedMarkdown = markdown
      tab.externalChange = null
      tab.autoSaveBlocked = false
      // Only collapse the editor to the persisted newline style after a
      // successful write, and never overwrite keystrokes made in flight.
      if (tab.markdown === editorSnapshot) tab.markdown = markdown
      // An edit may have landed while the async write was in flight. Only the
      // exact snapshot written to disk is clean; queue another autosave for a
      // newer snapshot.
      tab.isSaved = tab.markdown === markdown
      if (!tab.isSaved) scheduleAutoSave(tab)
      if (!pathsReferToSameFile(originalPath, path)) prefs.pushRecentFile(path)
      return true
    } catch (err) {
      notify.pushToast({
        type: 'error',
        title: 'Save failed',
        message: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  async function saveAllTabs(): Promise<boolean> {
    let ok = true
    for (const tab of tabs.value) {
      if (!tab.isSaved) ok = (await saveTab(tab)) && ok
    }
    return ok && !tabs.value.some(tab => !tab.isSaved)
  }

  async function saveCurrentAs(targetPath: string): Promise<boolean> {
    const tab = currentFile.value
    return tab ? await saveTabAs(tab, targetPath) : false
  }

  async function renameTab(id: string, newPath: string) {
    const tab = tabs.value.find(t => t.id === id)
    if (!tab) return
    if (tab.pathname && tab.pathname !== newPath) {
      try { await renameFileCmd(tab.pathname, newPath) } catch (err) {
        notify.pushToast({
          type: 'error',
          title: 'Rename failed',
          message: err instanceof Error ? err.message : String(err),
        })
        return
      }
    }
    tab.pathname = newPath
    tab.filename = newPath.split(/[\\/]/).pop() || tab.filename
  }

  /* ─── view modes ────────────────────────────────────────────── */

  function toggleSourceCode() {
    sourceCodeMode.value = !sourceCodeMode.value
    if (currentFile.value) currentFile.value.sourceMode = sourceCodeMode.value
  }
  function toggleFindReplace() { findReplaceOpen.value = !findReplaceOpen.value }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function setMuyaInstance(m: any) { muyaInstance = m }
  function clearMuyaInstance() { muyaInstance = null }
  function getMuyaInstance(): unknown { return muyaInstance }

  /** Replace the cached selection-format set. Pass an empty array on blur. */
  function setSelectionFormats(types: string[]) {
    currentSelectionFormats.value = types
  }

  /** Capture selection-only movement before a durable session snapshot. */
  function captureCurrentViewState() {
    const tab = currentFile.value
    if (!tab) return
    tab.sourceMode = sourceCodeMode.value
    if (sourceCodeMode.value || !muyaInstance) return
    try {
      const cursor = muyaInstance.getCursor?.() ?? tab.cursor
      setPaneViewField(activePaneId.value, tab.id, 'cursor', cursor)
      tab.cursor = cursor
    } catch { /* editor is tearing down */ }
  }

  /** Forward a Muya search-result blob into the current tab's state so the
   *  find bar can show "n of m" counters. */
  function applySearchResult(matches: { index: number; matches: unknown[]; value: string }) {
    const tab = currentFile.value
    if (!tab) return
    tab.searchMatches = matches
  }

  /**
   * Update a tab's markdown from an external editor (e.g. the source-code
   * pane writing back to the in-memory document). Doesn't go through the
   * baseline shim — assumes the caller already knows what's a real edit.
   */
  function setMarkdownExternal(id: string, markdown: string) {
    const tab = tabs.value.find(t => t.id === id)
    if (!tab) return
    // A source-mode edit is already a real user change; it must not be
    // mistaken for Muya's one-time parse baseline after switching modes.
    tab.pendingBaselineUpdate = false
    const normalized = normalizeMarkdownLineEndings(markdown)
    if (tab.markdown !== normalized) {
      recordSharedEdit(id, tab.markdown, normalizeMarkdownLineEndings(markdown))
    tab.markdown = normalized
      tab.isSaved = false
      scheduleAutoSave(tab)
    }
    tab.wordCount = computeMarkdownWordCount(normalized)
  }

  function applySessionViewState(
    tab: DocumentState,
    snapshot: Pick<CleanEditorSessionTab, 'cursor' | 'sourceSelection' | 'sourceMode'>,
  ) {
    resetSharedHistory(tab.id)
    tab.cursor = snapshot.cursor ?? null
    tab.sourceSelection = snapshot.sourceSelection ?? null
    tab.sourceEditorState = null
    tab.sourceMode = snapshot.sourceMode
    if (currentFileId.value === tab.id) sourceCodeMode.value = snapshot.sourceMode
  }

  function restoreCleanSessionTab(
    snapshot: CleanEditorSessionTab,
    loaded: LoadedDocument,
  ): DocumentState {
    const tab = appendLoadedDocument(loaded, snapshot.path)
    tab.pendingBaselineUpdate = false
    applySessionViewState(tab, snapshot)
    return tab
  }

  function restoreDirtySessionTab(
    snapshot: DirtyEditorSessionTab,
    detached: boolean,
    loaded?: LoadedDocument,
    diskConflict = false,
  ): DocumentState {
    const trimTrailingNewline = snapshot.trimTrailingNewline
      ?? resolveTrailingNewlinePolicy(
        prefs.trimTrailingNewline,
        normalizeMarkdownLineEndings(snapshot.markdown),
      )
    const markdown = normalizeMarkdownLineEndings(snapshot.markdown)
    const lastSavedMarkdown = normalizeMarkdownLineEndings(snapshot.lastSavedMarkdown)
    let tab: DocumentState
    if (!detached && snapshot.path && loaded) {
      tab = appendLoadedDocument(loaded, snapshot.path)
    } else {
      tab = newUntitledTab(markdown)
      tab.pathname = ''
      tab.filename = snapshot.filename
    }
    clearAutoSave(tab.id)
    tab.trimTrailingNewline = trimTrailingNewline
    tab.markdown = markdown
    tab.lastSavedMarkdown = lastSavedMarkdown
    tab.encoding = { encoding: snapshot.encoding, isBom: snapshot.bom }
    tab.lineEnding = snapshot.lineEnding
    tab.adjustLineEndingOnSave = snapshot.lineEnding === 'crlf'
    tab.pendingBaselineUpdate = false
    tab.isSaved = false
    tab.externalChange = diskConflict && snapshot.path && loaded
      ? externalChangeFromLoaded(loaded, 'modified')
      : null
    // Never let auto-save turn "Restore Draft" into an implicit overwrite of
    // a disk version that changed after the crash baseline.
    tab.autoSaveBlocked = diskConflict
    tab.history = { stack: [], index: -1 }
    tab.historyMarkdown = markdown
    applySessionViewState(tab, snapshot)
    return tab
  }

  /* ─── notifications ─────────────────────────────────────────── */

  function pushTabNotification(id: string, message: string, type: 'info' | 'warning' | 'error' = 'info') {
    const tab = tabs.value.find(t => t.id === id)
    if (!tab) return
    tab.notifications.push({ type, message })
  }

  function clearTabNotifications(id: string) {
    const tab = tabs.value.find(t => t.id === id)
    if (tab) tab.notifications.length = 0
  }

  /* ─── bootstrap ─────────────────────────────────────────────── */

  /** Default state on fresh window — a single Untitled tab. */
  function bootstrap() {
    if (startupHydrationPending.value) return
    if (!tabs.value.length) newUntitledTab()
  }

  function finishStartupHydration() {
    startupHydrationPending.value = false
    bootstrap()
  }

  watch(
    () => prefs.sourceCodeModeEnabled,
    enabled => { sourceCodeMode.value = enabled },
    { immediate: true },
  )
  watch(sourceCodeMode, enabled => {
    const pane = panes.value.find(p => p.id === activePaneId.value)
    if (pane) pane.sourceMode = enabled
    if (currentFile.value) currentFile.value.sourceMode = enabled
    prefs.sourceCode = enabled
  }, { immediate: true })
  watch(
    () => [prefs.autoSave, prefs.autoSaveDelay] as const,
    ([enabled]) => {
      for (const timer of autoSaveTimers.values()) clearTimeout(timer)
      autoSaveTimers.clear()
      if (enabled) {
        for (const tab of tabs.value) scheduleAutoSave(tab)
      }
    },
  )
  onScopeDispose(() => {
    for (const timer of autoSaveTimers.values()) clearTimeout(timer)
    autoSaveTimers.clear()
    inFlightSaveMarkdown.clear()
  })

  return {
    // state
    tabs,
    panes, activePaneId, splitDirection, splitRatio, paneSizes, activatePane, splitPane, closePane, stepSharedHistory, hasSharedHistoryStep, resetSharedHistory, usesSharedHistory, fileMutationBusy, beginFileMutation, endFileMutation, flushDeferredFileEvents,
    currentFileId,
    startupHydrationPending,
    listToc,
    sourceCodeMode,
    findReplaceOpen,
    currentSelectionFormats,
    // getters
    currentFile,
    toc,
    hasUnsaved,
    // tab mgmt
    findTabByPath,
    setCurrent,
    newUntitledTab,
    openFile,
    closeTab,
    closeTabsTransactionally,
    prepareWindowClose,
    prepareWindowCloseWithDecision,
    exchangeTabs,
    // content & save
    applyContentChange,
    setMarkdownExternal,
    restoreCleanSessionTab,
    restoreDirtySessionTab,
    saveCurrent,
    saveCurrentAs,
    saveTab,
    saveTabAs,
    saveAllTabs,
    renameTab,
    handleFileWatchEvent,
    // notifications
    pushTabNotification,
    clearTabNotifications,
    // view modes
    toggleSourceCode,
    toggleFindReplace,
    applySearchResult,
    setMuyaInstance,
    clearMuyaInstance,
    getMuyaInstance,
    registerAgentEditHandler,
    registerInsertHandler,
    insertText,
    applyAgentEdit,
    setSelectionFormats,
    captureCurrentViewState,
    // lifecycle
    bootstrap,
    finishStartupHydration,
  }
})
