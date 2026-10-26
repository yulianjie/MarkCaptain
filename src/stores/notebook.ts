import { computed, nextTick, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import dayjs from 'dayjs'
import { notesList, notesRead, notesCreate, notesConfig, notesCancel, type NoteFile, type NotesConfig } from '@/services/tauri-invoke'
import { BUILTIN_TEMPLATES, expandTemplate, fuzzyScore, newNotePath, noteAliases, noteStem } from '@/services/notebook'
import { pathIsInsideRoot, remapPathWithinRoot, useProjectStore } from './project'
import { useEditorStore, pathsReferToSameFile, normalizeComparablePath } from './editor'
import { usePreferencesStore } from './preferences'
import { listenTyped } from '@/services/tauri-bridge'
import { t } from '@/i18n'
import { analyzeNote, hasFileExtension, hasNoteExtension, resolveNoteHeading, resolveNoteLink, splitTarget, normalizeNotePath, type NoteAnalysis, type NoteLink } from '@/services/note-index'
import { planMoveInBackground } from '@/services/reference-plan'
import { relationsFromSource, type NoteRelations } from '@/services/note-relations'
import { notesMove, notesRestoreTransaction, type ReferenceRewrite } from '@/services/tauri-invoke'
import type { IndexResponse } from '@/services/note-index.worker'
import { bus } from '@/bus'
import { createSearchRevealRequest } from '@/services/search-reveal'
import { localHistoryCapture, localHistorySettings } from '@/services/tauri-invoke'
import { getPaneViewState, restorePaneViewState, type PaneViewState } from '@/services/pane-view-state'
import { normalizePaneViewState } from '@/services/pane-layouts'
import { resolveDocumentLink } from '@/services/document-link'

interface RelationNavigationFrame {
  paneId: string
  documentId: string
  path: string
  sourceMode: boolean
  viewState: PaneViewState
}

const RELATION_TARGETS_STORAGE_KEY = 'mt:document-inspector-fixed-targets:v1'
const MAX_RELATION_NAVIGATION_HISTORY = 40
function readFixedTargets(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RELATION_TARGETS_STORAGE_KEY) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(Object.entries(value).filter(([root, relative]) =>
      root.length > 0 && root.length < 32768 && typeof relative === 'string' && relative.length > 0 && relative.length < 32768,
    ))
  } catch { return {} }
}

export interface IndexedNote extends NoteFile { markdown: string; aliases: string[]; fingerprint?: string; error?: string }
export const useNotebookStore = defineStore('notebook', () => {
  const project = useProjectStore(); const editor = useEditorStore(); const prefs = usePreferencesStore()
  const root = computed(() => project.projectTree?.pathname ?? '')
  const notes = ref<IndexedNote[]>([]); const busy = ref(false); const error = ref('')
  const analyses = shallowRef<NoteAnalysis[]>([])
  const indexing = ref(false)
  const panel = ref<'links' | 'tags' | 'properties' | 'search' | 'tasks'>('links')
  const mutating = ref(false)
  const lastTransaction = ref('')
  let lastTransactionRoot = ''
  let refreshAfterMutation = false
  const worker = typeof Worker !== 'undefined' ? new Worker(new URL('../services/note-index.worker.ts', import.meta.url), { type: 'module' }) : null
  const indexed = new Map<string, string>(); let indexGeneration = 0
  let cancelledIndexGeneration = -1
  const analysisMap = new Map<string, NoteAnalysis>()
  let pendingIndexDocuments: { relative: string; markdown: string }[] = []
  if (worker) worker.onmessage = (event: MessageEvent<IndexResponse>) => {
    if (event.data.id !== indexGeneration || event.data.id === cancelledIndexGeneration) return
    indexing.value = false
    if (event.data.error) { error.value = event.data.error; pendingIndexDocuments = []; indexed.clear(); analysisMap.clear(); analyses.value = []; return }
    for (const document of pendingIndexDocuments) indexed.set(document.relative, document.markdown)
    for (const analysis of event.data.analyses) analysisMap.set(analysis.relative, analysis)
    analyses.value = [...analysisMap.values()]
  }
  if (worker) worker.onerror = _event => {
    indexing.value = false; pendingIndexDocuments = []; indexed.clear(); analysisMap.clear(); analyses.value = []; error.value = t('notes.indexIncomplete')
  }
  const dialog = ref<'' | 'quick' | 'templates' | 'settings' | 'history' | 'layouts'>('')
  const config = ref<NotesConfig>({ templateDirectory: 'Templates', dailyDirectory: 'Daily', dailyFormat: 'YYYY-MM-DD', dailyTemplate: 'builtin:work' })
  let generation = 0; let refreshTimer: ReturnType<typeof setTimeout> | undefined; let off: (() => void) | undefined
  let scanId = ''
  let movePlanController: AbortController | null = null
  let cancellationRevision = 0
  let disposed = false
  let historyTimer: ReturnType<typeof setTimeout> | undefined
  async function captureHistory() {
    if (disposed || !(typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window)) return
    let interval = 60
    try {
      interval = (await localHistorySettings()).intervalSeconds
      for (const tab of editor.tabs) if (tab.pathname) await localHistoryCapture(tab.pathname, tab.markdown)
    } catch (e) { error.value = String(e) }
    if (!disposed) historyTimer = setTimeout(() => { void captureHistory() }, interval * 1000)
  }
  void captureHistory()
  function cancel() {
    cancellationRevision++; generation++; busy.value = false; error.value = ''
    if (scanId) void notesCancel(scanId).catch(() => {})
    indexing.value = false; pendingIndexDocuments = []
    cancelledIndexGeneration = ++indexGeneration
    worker?.postMessage({ id: cancelledIndexGeneration, documents: [] })
    relationsBusy.value = false
    relationsWorker?.postMessage({ id: ++relationGeneration, current: '', notes: [] })
    movePlanController?.abort()
  }
  function normalizeNotebookDirectory(value: string) { return value.replace(/\\/g, '/').replace(/\/+$/, '') }
  async function rebuild(force = false) {
    const currentRoot = root.value; const token = ++generation
    if (!currentRoot) { notes.value = []; return }
    busy.value = true; error.value = ''
    try {
      if (scanId) void notesCancel(scanId).catch(() => {})
      scanId = crypto.randomUUID()
      const files = await notesList(currentRoot, scanId)
      const previous = new Map(notes.value.map(n => [n.relative, n]))
      const output: IndexedNote[] = []
      let totalSize = 0
      // Bounded reads yield to the webview between batches; cancel never publishes a partial index.
      for (let i = 0; i < files.length; i += 8) {
        if (token !== generation) return
        output.push(...await Promise.all(files.slice(i, i + 8).map(async file => {
          totalSize += file.size
          if (totalSize > 128 * 1024 * 1024) return { ...file, markdown: '', aliases: [], error: t('notes.indexLimit') }
          const old = previous.get(file.relative)
          if (!force && old && old.modified === file.modified && old.size === file.size) return { ...old, ...file }
          try {
            const doc = await notesRead(currentRoot, file.relative)
            if (doc.hadDecodeErrors) throw new Error(t('toast.decodeFailed', { encoding: doc.encoding }))
            return { ...file, markdown: doc.markdown.replace(/\r\n/g, '\n'), aliases: noteAliases(doc.markdown), fingerprint: doc.fingerprint }
          } catch (e) { return { ...file, markdown: '', aliases: [], error: String(e) } }
        })))
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      if (token === generation) notes.value = output
    } catch (e) { if (token === generation) error.value = String(e) }
    finally { if (token === generation) busy.value = false }
  }
  async function rebuildStable(workspaceRoot: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      await rebuild(true)
      if (root.value !== workspaceRoot) throw new Error(t('notes.changed'))
      if (!busy.value) return
    }
    throw new Error(t('notes.changed'))
  }
  const liveNotes = computed(() => notes.value.map(note => {
    const tab = editor.tabs.find(tab => pathsReferToSameFile(tab.pathname, note.path))
    return tab ? { ...note, markdown: tab.markdown, aliases: noteAliases(tab.markdown) } : note
  }))
  function quickResults(query: string) {
    if (!query.trim()) {
      const byPath = new Map(liveNotes.value.map(n => [normalizeComparablePath(n.path), n]))
      return prefs.recentFiles.flatMap(path => { const note = byPath.get(normalizeComparablePath(path)); return note ? [note] : [] }).slice(0, 80)
    }
    return liveNotes.value.map(note => ({ note, score: Math.max(...[note.relative, noteStem(note.relative.split('/').pop()!), ...note.aliases].map(s => fuzzyScore(query.trim(), s))) }))
      .filter(result => result.score >= 0).sort((a,b) => b.score - a.score).slice(0, 80).map(result => result.note)
  }
  const templates = computed(() => {
    const directory = normalizeNotebookDirectory(config.value.templateDirectory)
    return liveNotes.value.filter(note => directory
      ? note.relative.startsWith(`${directory}/`)
      : !note.relative.includes('/'))
  })
  watch(liveNotes, documents => {
    const id = ++indexGeneration; const paths = new Set(documents.map(d => d.relative))
    for (const key of indexed.keys()) if (!paths.has(key)) { indexed.delete(key); analysisMap.delete(key) }
    const changes = documents.filter(d => indexed.get(d.relative) !== d.markdown)
    // Include all pending changes until the worker publishes them; this keeps rapid keystrokes from dropping earlier files.
    pendingIndexDocuments = changes.map(d => ({ relative: d.relative, markdown: d.markdown }))
    if (worker) { indexing.value = true; worker.postMessage({ id, documents: pendingIndexDocuments }) }
    else { for (const d of changes) { indexed.set(d.relative, d.markdown); analysisMap.set(d.relative, analyzeNote(d.relative, d.markdown)) }; analyses.value = [...analysisMap.values()] }
    if (!documents.length) analyses.value = []
  }, { immediate: true })
  const currentNote = computed(() => liveNotes.value.find(n => pathsReferToSameFile(n.path, editor.currentFile?.pathname ?? '')) ?? null)
  const currentAnalysis = computed(() => analyses.value.find(n => n.relative === currentNote.value?.relative) ?? null)
  const fixedRelationTargets = ref(readFixedTargets())
  const relationTargetRootKey = computed(() => root.value ? normalizeComparablePath(root.value) : '')
  const fixedRelationTargetRelative = computed(() => relationTargetRootKey.value ? fixedRelationTargets.value[relationTargetRootKey.value] ?? '' : '')
  const relationTargetPinned = computed(() => Boolean(fixedRelationTargetRelative.value))
  const relationTargetRelative = computed(() => fixedRelationTargetRelative.value || currentNote.value?.relative || '')
  const relationTarget = computed(() => liveNotes.value.find(note => note.relative === relationTargetRelative.value) ?? null)
  const relationTargetAnalysis = computed(() => analyses.value.find(note => note.relative === relationTargetRelative.value) ?? null)
  const relationTargetStatus = computed(() => {
    if (!root.value) return 'noWorkspace'
    const isIndexing = busy.value || indexing.value || relationsBusy.value
    if (relationTargetPinned.value) {
      if (!relationTarget.value) return isIndexing ? 'indexing' : 'pinnedMissing'
      if (relationTarget.value.error) return 'targetError'
      if (!relationTargetAnalysis.value || relationsBusy.value) return isIndexing ? 'indexing' : 'notIndexed'
      return notes.value.some(note => note.error) ? 'partial' : 'ready'
    }
    const active = editor.currentFile
    if (!active) return 'noDocument'
    if (!active.pathname) return 'noPath'
    if (!pathIsInsideRoot(root.value, active.pathname)) return 'outsideWorkspace'
    if (!relationTarget.value) return isIndexing ? 'indexing' : 'notIndexed'
    if (relationTarget.value.error) return 'targetError'
    if (!relationTargetAnalysis.value || relationsBusy.value) return isIndexing ? 'indexing' : 'notIndexed'
    return notes.value.some(note => note.error) ? 'partial' : 'ready'
  })
  function persistFixedTargets() {
    try { localStorage.setItem(RELATION_TARGETS_STORAGE_KEY, JSON.stringify(fixedRelationTargets.value)) } catch { /* local preference unavailable */ }
  }
  function fixRelationTarget(relative = relationTarget.value?.relative ?? '') {
    const rootKey = relationTargetRootKey.value
    if (!rootKey || !relative) return false
    fixedRelationTargets.value = { ...fixedRelationTargets.value, [rootKey]: relative }
    persistFixedTargets()
    return true
  }
  function followActiveRelationTarget() {
    const rootKey = relationTargetRootKey.value
    if (!rootKey || !fixedRelationTargets.value[rootKey]) return
    const next = { ...fixedRelationTargets.value }
    delete next[rootKey]
    fixedRelationTargets.value = next
    persistFixedTargets()
  }
  const relations = shallowRef<NoteRelations>({ backlinks: [], mentions: [] })
  const relationsBusy = ref(false)
  const relationsWorker = typeof Worker !== 'undefined' ? new Worker(new URL('../services/note-relations.worker.ts', import.meta.url), { type: 'module' }) : null
  let relationGeneration = 0
  if (relationsWorker) relationsWorker.onmessage = event => { if (event.data.id === relationGeneration) { relations.value = event.data.result; relationsBusy.value = false } }
  if (relationsWorker) relationsWorker.onerror = event => { error.value = event.message; relationsBusy.value = false }
  watch(() => [analyses.value, relationTargetRelative.value] as const, ([documents, current]) => {
    const id = ++relationGeneration
    relationsBusy.value = Boolean(current && relationsWorker)
    relations.value = { backlinks: [], mentions: [] }
    if (!current) { relationsWorker?.postMessage({ id, current: '', notes: [] }); return }
    if (relationsWorker) relationsWorker.postMessage({ id, current: current ?? '', notes: documents })
    else if (current) { const target = documents.find(n => n.relative === current); if (target) for (const source of documents) { const found = relationsFromSource(source, target, documents); relations.value.backlinks.push(...found.backlinks); relations.value.mentions.push(...found.mentions) } }
  }, { immediate: true })
  const backlinks = computed(() => relations.value.backlinks)
  const mentions = computed(() => relations.value.mentions)
  const relationNavigationHistory = ref<RelationNavigationFrame[]>([])
  const canReturnFromRelation = computed(() => relationNavigationHistory.value.length > 0)
  function captureRelationNavigationFrame(): RelationNavigationFrame | null {
    const tab = editor.currentFile
    const paneId = editor.activePaneId
    if (!tab) return null
    editor.captureCurrentViewState()
    const view = getPaneViewState(paneId, tab.id) ?? {}
    return {
      paneId,
      documentId: tab.id,
      path: tab.pathname,
      sourceMode: editor.sourceCodeMode,
      viewState: {
        ...view,
        ...(tab.cursor !== undefined ? { cursor: tab.cursor } : {}),
        ...(tab.sourceSelection !== undefined ? { sourceSelection: tab.sourceSelection } : {}),
      },
    }
  }
  function revealRelationTarget(tab: { id: string; pathname: string; markdown: string }, from: number, to: number) {
    bus.emit('reveal-search-hit', createSearchRevealRequest({
      tabId: tab.id, path: tab.pathname, mode: editor.sourceCodeMode ? 'source' : 'wysiwyg',
      line: 1, column: 1, length: 0, exactRange: { markdown: tab.markdown, from, to },
    }))
  }
  async function navigateToRelation(relative: string, from: number, to = from, options: { openInOtherPane?: boolean } = {}) {
    const note = liveNotes.value.find(candidate => candidate.relative === relative)
    if (!note) throw new Error(t('notes.changed'))
    const origin = captureRelationNavigationFrame()
    const expectedRoot = root.value
    let createdPaneId = ''
    try {
      if (options.openInOtherPane) {
        let destination = editor.panes.find(pane => pane.id !== editor.activePaneId)
        if (!destination) {
          if (editor.panes.length >= 4) throw new Error(t('notes.changed'))
          editor.splitPane(editor.splitDirection)
          destination = editor.panes.at(-1)
          if (destination) createdPaneId = destination.id
        }
        if (!destination) throw new Error(t('notes.changed'))
        editor.activatePane(destination.id)
      }
      const tab = await editor.openFile(note.path)
      if (root.value !== expectedRoot) throw new Error(t('notes.changed'))
      if (origin) relationNavigationHistory.value = [...relationNavigationHistory.value, origin].slice(-MAX_RELATION_NAVIGATION_HISTORY)
      revealRelationTarget(tab, from, to)
    } catch (cause) {
      if (createdPaneId) editor.closePane(createdPaneId)
      else if (origin && editor.panes.some(pane => pane.id === origin.paneId)) editor.activatePane(origin.paneId)
      throw cause
    }
  }
  function updateFixedRelationTargetAfterMove(workspaceRoot: string, source: string, destination: string) {
    const rootKey = normalizeComparablePath(workspaceRoot)
    const relative = fixedRelationTargets.value[rootKey]
    if (!relative) return
    const remapped = remapPathWithinRoot(nativePath(workspaceRoot, source), nativePath(workspaceRoot, destination), nativePath(workspaceRoot, relative))
    if (!remapped) return
    const nextRelative = relativeNative(remapped, workspaceRoot)
    if (nextRelative === relative) return
    fixedRelationTargets.value = { ...fixedRelationTargets.value, [rootKey]: nextRelative }
    persistFixedTargets()
  }
  async function returnFromRelation() {
    const frame = relationNavigationHistory.value.at(-1)
    if (!frame) return false
    let pane = editor.panes.find(candidate => candidate.id === frame.paneId)
    if (!pane) pane = editor.panes.find(candidate => candidate.documentId === frame.documentId) ?? editor.panes[0]
    if (!pane) return false
    try {
      editor.activatePane(pane.id)
      let tab = editor.tabs.find(candidate => candidate.id === frame.documentId)
      if (!tab && frame.path) tab = await editor.openFile(frame.path)
      if (!tab) return false
      editor.setCurrent(tab.id)
      pane.sourceMode = frame.sourceMode
      editor.sourceCodeMode = frame.sourceMode
      restorePaneViewState(pane.id, tab.id, normalizePaneViewState(tab.markdown, frame.viewState))
      await nextTick()
      relationNavigationHistory.value = relationNavigationHistory.value.slice(0, -1)
      return true
    } catch (cause) {
      error.value = String(cause)
      return false
    }
  }
  async function reveal(relative: string, from: number, to = from) {
    await navigateToRelation(relative, from, to)
  }
  async function followMarkdownLink(target: string) {
    const current = editor.currentFile
    const resolved = resolveDocumentLink(target, current?.pathname ?? '')
    if (!resolved.path) throw new Error(t('notes.invalidPath'))
    const source = currentNote.value?.relative
    // Preserve indexed navigation, ambiguity handling and note creation inside
    // the project. Standalone files and links outside it use normal file open.
    if (source && !/^(?:[\w+.-]+:|\\|\/\/)/.test(target) && (target.startsWith('/') || pathIsInsideRoot(root.value, resolved.path))) {
      await followLink(source, { kind: 'markdown', target })
      return
    }
    if (!hasNoteExtension(resolved.path)) throw new Error(t('notes.unsupportedNoteTarget'))
    const origin = captureRelationNavigationFrame()
    const tab = await editor.openFile(resolved.path)
    const heading = resolved.heading ? resolveNoteHeading(analyzeNote(tab.pathname, tab.markdown), resolved.heading) : undefined
    if (resolved.heading && !heading) throw new Error(t('notes.headingMissing'))
    if (origin) relationNavigationHistory.value = [...relationNavigationHistory.value, origin].slice(-MAX_RELATION_NAVIGATION_HISTORY)
    revealRelationTarget(tab, heading?.from ?? 0, heading?.from ?? 0)
  }
  async function followLink(source: string, link: Pick<NoteLink, 'target' | 'kind'>) {
    const expectedRoot = root.value
    const candidates = resolveNoteLink(source, link, analyses.value)
    if (candidates.length > 1) { dialog.value = 'quick'; throw new Error(t('notes.ambiguous')) }
    const { path, heading } = splitTarget(link.target, link.kind)
    if (!candidates.length) {
      if (link.kind === 'markdown' && !hasNoteExtension(path) && hasFileExtension(path)) throw new Error(t('notes.unsupportedNoteTarget'))
      const directory = source.slice(0, source.lastIndexOf('/') + 1)
      const target = normalizeNotePath(path.startsWith('/') ? path.slice(1) : link.kind === 'markdown' || path.startsWith('./') || path.startsWith('../') || !path.includes('/') ? directory + path : path)
      if (!target) throw new Error(t('notes.invalidPath'))
      const { ElMessageBox } = await import('element-plus')
      try { await ElMessageBox.confirm(t('notes.create', { name: target }), t('notes.links')) }
      catch (e) {
        const action = (e instanceof Error ? e.message : String(e)).trim().toLowerCase()
        if (action === 'cancel' || action === 'close') return
        throw e
      }
      if (root.value !== expectedRoot) throw new Error(t('notes.changed'))
      const origin = captureRelationNavigationFrame()
      await create(target, '', expectedRoot)
      if (origin) relationNavigationHistory.value = [...relationNavigationHistory.value, origin].slice(-MAX_RELATION_NAVIGATION_HISTORY)
      return
    }
    const note = candidates[0]; const h = heading ? resolveNoteHeading(note, heading) : undefined
    if (heading && !h) throw new Error(t('notes.headingMissing'))
    await navigateToRelation(note.relative, h?.from ?? 0)
  }
  function relativeNative(path: string, workspaceRoot = root.value) {
    const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/$/, '')
    const normalized = path.replace(/\\/g, '/')
    if (!normalized.toLowerCase().startsWith(normalizedRoot.toLowerCase() + '/')) throw new Error(t('notes.invalidPath'))
    return normalized.slice(normalizedRoot.length + 1)
  }
  function nativePath(workspaceRoot: string, relative: string) { return `${workspaceRoot.replace(/[\\/]+$/, '')}/${relative.replace(/\\/g, '/')}` }
  function workspaceTabs(workspaceRoot: string) { return editor.tabs.filter(tab => tab.pathname && pathIsInsideRoot(workspaceRoot, tab.pathname)) }
  function requireCleanWorkspaceTabs(tabs: ReturnType<typeof workspaceTabs>) {
    if (tabs.some(tab => !tab.isSaved || tab.externalChange)) throw new Error(t('notes.saveBeforeMove'))
  }
  function fingerprintSnapshot(documents: readonly IndexedNote[]) {
    return JSON.stringify(documents.map(note => [note.relative, note.fingerprint] as const).sort((a, b) => a[0].localeCompare(b[0])))
  }
  function samePlan(first: Awaited<ReturnType<typeof planMoveInBackground>>, second: Awaited<ReturnType<typeof planMoveInBackground>>) {
    return JSON.stringify(first) === JSON.stringify(second)
  }
  function transactionRootKey(workspaceRoot: string) { return normalizeComparablePath(workspaceRoot) }
  function transactionStorageKey(workspaceRoot: string) { return `mt:reference-transaction:${transactionRootKey(workspaceRoot)}` }
  function transactionId(workspaceRoot: string) {
    if (lastTransactionRoot === transactionRootKey(workspaceRoot) && lastTransaction.value) return lastTransaction.value
    try { return localStorage.getItem(transactionStorageKey(workspaceRoot)) ?? localStorage.getItem(`mt:reference-transaction:${workspaceRoot}`) ?? '' } catch { return '' }
  }
  async function buildMovePlan(source: string, destination: string) {
    const controller = new AbortController(); movePlanController = controller
    try { return await planMoveInBackground(source, destination, notes.value, controller.signal) }
    finally { if (movePlanController === controller) movePlanController = null }
  }
  async function moveWithReferences(sourcePath: string, destinationPath: string) {
    if (mutating.value || movePlanController || editor.fileMutationBusy) throw new Error(t('notes.changed'))
    const expectedRoot = root.value
    const source = relativeNative(sourcePath, expectedRoot); const destination = relativeNative(destinationPath, expectedRoot)
    if (source === destination) return
    const cancellation = cancellationRevision
    const requireCurrentOperation = () => {
      if (root.value !== expectedRoot || cancellation !== cancellationRevision) throw new Error(t('notes.changed'))
    }
    mutating.value = true
    let editorMutation = false
    try {
      requireCleanWorkspaceTabs(workspaceTabs(expectedRoot))
      await rebuildStable(expectedRoot)
      requireCurrentOperation()
      if (error.value || notes.value.some(n => n.error || !n.fingerprint)) throw new Error(t('notes.indexIncomplete'))
      const previewFingerprints = fingerprintSnapshot(notes.value)
      const previewPlan = await buildMovePlan(source, destination)
      requireCurrentOperation()
      const { ElMessageBox } = await import('element-plus')
      const preview = t('notes.movePreview', { count: previewPlan.changes.length }) + '\n' + previewPlan.changes.map(c => c.relative).join('\n') + (previewPlan.warnings.length ? '\n' + t('notes.ambiguous') + '\n' + previewPlan.warnings.join('\n') : '')
      await ElMessageBox.confirm(preview, t('notes.references'), { type: 'warning', message: preview })
      requireCurrentOperation()

      // Freeze edits, drain in-flight writes/reloads, then base the commit and
      // editor snapshots on the complete state the user just reviewed.
      await editor.beginFileMutation(); editorMutation = true
      requireCurrentOperation()
      requireCleanWorkspaceTabs(workspaceTabs(expectedRoot))
      await rebuildStable(expectedRoot)
      requireCurrentOperation()
      if (error.value || notes.value.some(n => n.error || !n.fingerprint)) throw new Error(t('notes.indexIncomplete'))
      if (fingerprintSnapshot(notes.value) !== previewFingerprints) throw new Error(t('notes.changed'))
      const plan = await buildMovePlan(source, destination)
      requireCurrentOperation()
      if (!samePlan(plan, previewPlan)) throw new Error(t('notes.changed'))
      const snapshots = workspaceTabs(expectedRoot).map(tab => ({ tab, markdown: tab.markdown, path: tab.pathname! }))
      requireCleanWorkspaceTabs(snapshots.map(snapshot => snapshot.tab))
      const changes: ReferenceRewrite[] = plan.changes.map(change => {
        const expected = notes.value.find(note => note.relative === change.relative)?.fingerprint
        if (!expected) throw new Error(t('notes.indexIncomplete'))
        return { relative: change.relative, expected, markdown: change.after }
      })
      const checks = notes.value.map(note => {
        if (!note.fingerprint || note.error) throw new Error(t('notes.indexIncomplete'))
        return { relative: note.relative, expected: note.fingerprint }
      })
      const transaction = await notesMove(expectedRoot, source, destination, changes, checks)
      updateFixedRelationTargetAfterMove(expectedRoot, source, destination)
      lastTransaction.value = transaction; lastTransactionRoot = transactionRootKey(expectedRoot)
      try { localStorage.setItem(transactionStorageKey(expectedRoot), transaction) } catch { /* storage unavailable */ }
      for (const snapshot of snapshots) {
        if (!editor.tabs.some(tab => tab.id === snapshot.tab.id)) continue
        const nextPath = remapPathWithinRoot(nativePath(expectedRoot, source), nativePath(expectedRoot, destination), snapshot.path) ?? snapshot.path
        snapshot.tab.pathname = nextPath; snapshot.tab.filename = nextPath.split(/[\\/]/).pop()!
        if (nextPath !== snapshot.path) prefs.pushRecentFile(nextPath)
        const change = plan.changes.find(candidate => pathsReferToSameFile(nativePath(expectedRoot, candidate.relative), snapshot.path))
        if (change && snapshot.tab.markdown === snapshot.markdown) {
          editor.setMarkdownExternal(snapshot.tab.id, change.after); snapshot.tab.lastSavedMarkdown = change.after; snapshot.tab.isSaved = true
          editor.resetSharedHistory(snapshot.tab.id)
        }
      }
      if (root.value === expectedRoot) await rebuild(true)
    } catch (error) {
      if (editorMutation) refreshAfterMutation = true
      throw error
    } finally {
      if (editorMutation) editor.endFileMutation()
      mutating.value = false
      if (refreshAfterMutation) { refreshAfterMutation = false; clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { void rebuild() }, 500) }
    }
  }
  async function restoreReferences() {
    if (mutating.value || movePlanController || editor.fileMutationBusy) throw new Error(t('notes.changed'))
    const expectedRoot = root.value
    const id = transactionId(expectedRoot)
    if (!id) throw new Error(t('notes.empty'))
    mutating.value = true
    let editorMutation = false
    try {
      await editor.beginFileMutation(); editorMutation = true
      if (root.value !== expectedRoot) throw new Error(t('notes.changed'))
      const snapshots = workspaceTabs(expectedRoot).map(tab => ({ tab, markdown: tab.markdown, path: tab.pathname! }))
      requireCleanWorkspaceTabs(snapshots.map(snapshot => snapshot.tab))
      const restored = await notesRestoreTransaction(expectedRoot, id)
      updateFixedRelationTargetAfterMove(expectedRoot, restored.destination, restored.source)
      const from = nativePath(expectedRoot, restored.destination); const to = nativePath(expectedRoot, restored.source)
      for (const snapshot of snapshots) {
        if (!editor.tabs.some(tab => tab.id === snapshot.tab.id)) continue
        const nextPath = remapPathWithinRoot(from, to, snapshot.path) ?? snapshot.path
        snapshot.tab.pathname = nextPath; snapshot.tab.filename = nextPath.split(/[\\/]/).pop()!
        if (nextPath !== snapshot.path) prefs.pushRecentFile(nextPath)
        const file = restored.files.find(candidate => pathsReferToSameFile(nativePath(expectedRoot, candidate.relative), nextPath))
        if (file && snapshot.tab.markdown === snapshot.markdown) {
          const markdown = file.markdown.replace(/\r\n/g, '\n')
          editor.setMarkdownExternal(snapshot.tab.id, markdown); snapshot.tab.lastSavedMarkdown = markdown; snapshot.tab.isSaved = true
          editor.resetSharedHistory(snapshot.tab.id)
        }
      }
      try {
        localStorage.removeItem(transactionStorageKey(expectedRoot))
        localStorage.removeItem(`mt:reference-transaction:${expectedRoot}`)
      } catch { /* storage unavailable */ }
      if (lastTransactionRoot === transactionRootKey(expectedRoot) && lastTransaction.value === id) { lastTransaction.value = ''; lastTransactionRoot = '' }
      if (root.value === expectedRoot) await rebuild(true)
    } catch (error) {
      if (editorMutation) refreshAfterMutation = true
      throw error
    } finally {
      if (editorMutation) editor.endFileMutation()
      mutating.value = false
      if (refreshAfterMutation) { refreshAfterMutation = false; clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { void rebuild() }, 500) }
    }
  }
  async function templateContent(key: string, title: string, expectedRoot = root.value) {
    const builtin = BUILTIN_TEMPLATES[key as keyof typeof BUILTIN_TEMPLATES]
    let content: string = builtin ?? ''
    if (!builtin) {
      const loaded = await notesRead(expectedRoot, key)
      if (root.value !== expectedRoot) throw new Error(t('notes.changed'))
      if (loaded.hadDecodeErrors) throw new Error(t('toast.decodeFailed', { encoding: loaded.encoding }))
      content = loaded.markdown
    }
    return expandTemplate(content, title)
  }
  async function create(name: string, content = '', expectedRoot = root.value) {
    if (!expectedRoot) throw new Error(t('sideBar.openFolderFirst'))
    const path = await notesCreate(expectedRoot, newNotePath(name), content)
    if (root.value !== expectedRoot) throw new Error(t('notes.changed'))
    await editor.openFile(path); void rebuild(); return path
  }
  async function daily() {
    if (!root.value) throw new Error(t('sideBar.openFolderFirst'))
    const expectedRoot = root.value
    // A project can change before its asynchronous configuration hydration
    // finishes. Read this project's durable settings instead of another
    // project's still-visible cache, and fail before creating on read errors.
    const settings = await notesConfig(expectedRoot)
    if (root.value !== expectedRoot) throw new Error(t('notes.changed'))
    const name = dayjs().format(settings.dailyFormat)
    const dailyDirectory = normalizeNotebookDirectory(settings.dailyDirectory)
    const relative = newNotePath(dailyDirectory ? `${dailyDirectory}/${name}` : name)
    const existing = notes.value.find(n => n.relative === relative)
    if (existing) { if (root.value !== expectedRoot) throw new Error(t('notes.changed')); await editor.openFile(existing.path); return }
    // Read-before-create handles an index still loading. create_new handles races.
    try { await notesRead(expectedRoot, relative); if (root.value !== expectedRoot) throw new Error(t('notes.changed')); await editor.openFile(`${expectedRoot}/${relative}`); return } catch { /* absent or an error; exclusive creation below cannot overwrite */ }
    if (root.value !== expectedRoot) throw new Error(t('notes.changed'))
    const content = settings.dailyTemplate ? await templateContent(settings.dailyTemplate, name, expectedRoot) : ''
    if (root.value !== expectedRoot) throw new Error(t('notes.changed'))
    try { await create(relative, content, expectedRoot) }
    catch (e) { if (root.value === expectedRoot && /exists|os error 80|os error 183/i.test(String(e))) await editor.openFile(nativePath(expectedRoot, relative)); else throw e }
  }
  async function saveConfig(value: NotesConfig) {
    const expectedRoot = root.value
    const saved = await notesConfig(expectedRoot, {
      ...value,
      templateDirectory: normalizeNotebookDirectory(value.templateDirectory),
      dailyDirectory: normalizeNotebookDirectory(value.dailyDirectory),
    })
    if (root.value !== expectedRoot) throw new Error(t('notes.changed'))
    config.value = saved
    return saved
  }
  watch(root, async () => {
    movePlanController?.abort(); movePlanController = null
    const expectedRoot = root.value
    dialog.value = ''
    config.value = { templateDirectory: 'Templates', dailyDirectory: 'Daily', dailyFormat: 'YYYY-MM-DD', dailyTemplate: 'builtin:work' }
    notes.value = []; cancel()
    if (!root.value) return
    try { const loaded = await notesConfig(expectedRoot); if (root.value !== expectedRoot) return; config.value = loaded } catch(e) { if (root.value !== expectedRoot) return; error.value = String(e) }
    void rebuild()
  }, { immediate: true })
  void listenTyped('mt://fs/change', () => {
    if (mutating.value) { refreshAfterMutation = true; return }
    clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { void rebuild() }, 500)
  }).then(fn => { off = fn }).catch(() => {})
  onScopeDispose(() => { disposed = true; clearTimeout(historyTimer); cancel(); relationsWorker?.terminate(); worker?.terminate(); clearTimeout(refreshTimer); off?.() })
  return { root, notes, liveNotes, busy, indexing, relationsBusy, error, dialog, config, templates, rebuild, cancel, quickResults, create, daily, templateContent, saveConfig, analyses, panel, currentNote, currentAnalysis, relationTarget, relationTargetRelative, relationTargetPinned, relationTargetStatus, relationTargetAnalysis, fixRelationTarget, followActiveRelationTarget, backlinks, mentions, canReturnFromRelation, navigateToRelation, returnFromRelation, reveal, followLink, followMarkdownLink, mutating, moveWithReferences, restoreReferences }
})
