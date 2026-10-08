<script setup lang="ts">
/**
 * Editor page — top-level layout: title bar / tab bar / sidebar / Muya host.
 *
 * Owns the keyboard shortcuts, the file-association open-on-launch handoff,
 * the native menu action router, and webview drag-drop file opens.
 */
import { onBeforeUnmount, onMounted, ref, watch, type WatchStopHandle } from 'vue'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ElMessageBox } from 'element-plus'
import TitleBar from '@/components/titleBar/TitleBar.vue'
import AgentPanel from '@/components/agent/AgentPanel.vue'
import { useAgentStore } from '@/stores/agent'
import TabsBar from '@/components/editorWithTabs/TabsBar.vue'
import EditorToolbar from '@/components/editorToolbar/EditorToolbar.vue'
import MuyaEditor from '@/components/editorWithTabs/MuyaEditor.vue'
import SourceCodePane from '@/components/editorWithTabs/SourceCodePane.vue'
import StatusBar from '@/components/statusBar/StatusBar.vue'
import SideBar from '@/components/sideBar/SideBar.vue'
import CommandPalette from '@/components/commandPalette/CommandPalette.vue'
import AboutDialog from '@/components/about/AboutDialog.vue'
import RenameDialog from '@/components/rename/RenameDialog.vue'
import RecentDialog from '@/components/recent/RecentDialog.vue'
import TableDialog from '@/components/table/TableDialog.vue'
import UpdaterDialog from '@/components/updater/UpdaterDialog.vue'
import ExportSettingsDialog from '@/components/exportSettings/ExportSettingsDialog.vue'
import FindReplaceBar from '@/components/search/FindReplaceBar.vue'
import ContextMenu from '@/components/contextMenu/ContextMenu.vue'
import ImagePreview from '@/components/imagePreview/ImagePreview.vue'
import { useEditorStore } from '@/stores/editor'
import { useLayoutStore } from '@/stores/layout'
import { usePreferencesStore } from '@/stores/preferences'
import { useCommandCenterStore } from '@/stores/commandCenter'
import { useNotificationStore } from '@/stores/notification'
import { useKeybindingsStore, eventAccel } from '@/stores/keybindings'
import { useProjectStore } from '@/stores/project'
import {
  destroyEditorWindow,
  openFiles,
  saveAsDialog,
  exportHtml,
  pandocConvert,
  getEditorSession,
  readMarkdown,
  setEditorSession,
  type LoadedDocument,
} from '@/services/tauri-invoke'
import { listenTyped } from '@/services/tauri-bridge'
import { resolveEditorMenuCommand } from '@/services/editor-menu-actions'
import { PROJECT_ISSUES_URL, PROJECT_WIKI_URL } from '@/services/project-links'
import { handleApplicationShortcut, rendererOwnsApplicationShortcuts } from '@/services/application-shortcuts'
import {
  isEditorShortcutTarget,
  isTextEditingTarget,
  resolveFixedEditorShortcut,
} from '@/services/editor-shortcuts'
import {
  displayAccelerator,
  getShortcutAccelerators,
  getShortcutAction,
  isShortcutAvailable,
  isShortcutRemappable,
  resolveShortcutAction,
  shortcutPlatformFromNavigator,
} from '@/common/shortcut-registry'
import {
  BUILTIN_COMMAND_IDS,
  BUILTIN_COMMAND_SPECS,
  commandCategoryOrder,
  type BuiltinCommandSpec,
} from '@/services/command-palette-actions'
import { bus } from '@/bus'
import { t } from '@/i18n'
import {
  buildEditorSessionSnapshot,
  createEditorSessionRestorePlan,
  createEditorSessionWriter,
  persistCleanEditorSession,
  runBoundedAsyncTasks,
  type DirtyEditorSessionTab,
  type EditorSession,
  type EditorSessionWriter,
  type SessionDiskProbe,
} from '@/services/editor-session'

const editor = useEditorStore()
const agent = useAgentStore()
const layout = useLayoutStore()
const prefs = usePreferencesStore()
const cc = useCommandCenterStore()
const notify = useNotificationStore()
const keys = useKeybindingsStore()
const project = useProjectStore()

const dragOver = ref(false)
const rendererHandlesRemappableShortcuts = typeof window !== 'undefined'
  && rendererOwnsApplicationShortcuts('__TAURI_INTERNALS__' in window, navigator.platform)
let closeWindowPromise: Promise<void> | null = null
let startupReady: Promise<void> | null = null
let startupAbortController: AbortController | null = null
let ownsDefaultSession = false
let sessionWriter: EditorSessionWriter | null = null
let stopSessionChanges: WatchStopHandle | null = null
let stopSessionTransitions: WatchStopHandle | null = null

function currentEditorSessionSnapshot(flags: { cleanShutdown: boolean; excludeDirty: boolean }) {
  editor.captureCurrentViewState()
  return buildEditorSessionSnapshot({
    tabs: editor.tabs,
    currentFileId: editor.currentFileId,
    workspacePath: project.projectTree?.pathname,
    cleanShutdown: flags.cleanShutdown,
    excludeDirty: flags.excludeDirty,
  })
}

function requestWindowClose(): Promise<void> {
  if (closeWindowPromise) return closeWindowPromise
  closeWindowPromise = (async () => {
    // Never abort session hydration for a close request: the user may still
    // cancel the dirty-tab prompt, and a partial restore must not replace the
    // previous crash snapshot. File probes have a bounded timeout, so waiting
    // here cannot be held indefinitely by an offline path.
    const pendingStartup = startupReady
    if (pendingStartup) {
      try { await pendingStartup } catch { /* startup failure must not trap the window */ }
    }
    const decision = await editor.prepareWindowCloseWithDecision()
    if (decision === 'cancel') return
    await agent.flushForClose()
    if (ownsDefaultSession) {
      await persistCleanEditorSession({
        writer: sessionWriter,
        excludeDirty: decision === 'discard',
        snapshot: currentEditorSessionSnapshot,
        write: setEditorSession,
      })
    }
    await destroyEditorWindow()
  })().catch(error => {
    notify.pushToast({
      type: 'error',
      title: t('toast.closeFailed'),
      message: error instanceof Error ? error.message : String(error),
    })
  }).finally(() => {
    closeWindowPromise = null
  })
  return closeWindowPromise
}

/* ── shortcuts ───────────────────────────────────────────────── */
function onApplicationKey(ev: KeyboardEvent) {
  if (!rendererHandlesRemappableShortcuts) return
  const platform = shortcutPlatformFromNavigator(navigator.platform)
  handleApplicationShortcut(ev, keys.byAccel, action => {
    void executeMenuAction(action, 'shortcut')
  }, platform)
}

function onKey(ev: KeyboardEvent) {
  if (ev.defaultPrevented || ev.isComposing) return

  const platform = shortcutPlatformFromNavigator(navigator.platform)
  const availability = {
    hasEditor: Boolean(editor.currentFile),
    sourceCodeMode: editor.sourceCodeMode,
  }
  const accelerator = eventAccel(ev, platform)
  const agentAction = resolveShortcutAction(accelerator, {
    scope: 'agent',
    dispatch: 'agent',
    platform,
  })
  const agentHandler = agentAction?.id === 'view.toggleAgent'
    ? () => agent.toggle()
    : undefined
  if (agentAction && agentHandler && isShortcutAvailable(agentAction, availability)) {
    ev.preventDefault()
    ev.stopPropagation()
    if (!ev.repeat) agentHandler()
    return
  }

  if (!isEditorShortcutTarget(ev.target)) return
  const fixedAction = resolveFixedEditorShortcut(
    accelerator,
    platform === 'macos',
    availability,
  )
  if (!fixedAction) return

  ev.preventDefault()
  ev.stopPropagation()
  if (!ev.repeat) void executeMenuAction(fixedAction, 'shortcut')
}

async function doOpen() {
  const paths = await openFiles()
  if (!paths.length) return
  for (const p of paths) {
    try { await editor.openFile(p) }
    catch (err) {
      notify.pushToast({ type: 'error', title: t('toast.openFailed'), message: err instanceof Error ? err.message : String(err) })
    }
  }
}

async function doOpenFolder() {
  const { openFolder } = await import('@/services/tauri-invoke')
  const path = await openFolder()
  if (!path) return
  await project.openRoot(path)
}

function sessionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isMissingFileError(error: unknown): boolean {
  return /(?:not found|cannot find|no such file|os error 2)/i.test(sessionErrorMessage(error))
}

async function shouldRecoverCrashDrafts(session: EditorSession): Promise<boolean> {
  const dirtyCount = session.tabs.filter(tab => tab.dirty).length
  if (session.cleanShutdown || dirtyCount === 0) return false
  try {
    await ElMessageBox.confirm(
      t('session.crashDetail', { count: dirtyCount }),
      t('session.crashTitle'),
      {
        confirmButtonText: t('session.recoverDrafts'),
        cancelButtonText: t('session.discardDrafts'),
        distinguishCancelAndClose: true,
        showClose: false,
        closeOnPressEscape: false,
        closeOnClickModal: false,
        type: 'warning',
      },
    )
    return true
  } catch (action) {
    // The only normal rejection is the explicit Discard button. If the dialog
    // itself fails, recovery is the lossless default.
    return action === 'cancel' ? false : true
  }
}

async function probeSessionFiles(
  session: EditorSession,
  includeDirty: boolean,
  signal?: AbortSignal,
) {
  const probes = new Map<string, SessionDiskProbe>()
  const loaded = new Map<string, LoadedDocument>()
  const paths: string[] = []
  const seen = new Set<string>()
  for (const tab of session.tabs) {
    if (!tab.path || (tab.dirty && !includeDirty) || seen.has(tab.path)) continue
    seen.add(tab.path)
    paths.push(tab.path)
  }
  const results = await runBoundedAsyncTasks(paths, path => (
    readMarkdown(path, {
      autoGuessEncoding: prefs.autoGuessEncoding,
      defaultEncoding: prefs.defaultEncoding,
    })
  ), { concurrency: 4, timeoutMs: 10_000, signal })

  results.forEach((result, index) => {
    const path = paths[index]
    if (result.status === 'fulfilled') {
      loaded.set(path, result.value)
      probes.set(path, { status: 'ok', markdown: result.value.markdown })
    } else {
      probes.set(path, isMissingFileError(result.reason)
        ? { status: 'missing' }
        : { status: 'error', message: sessionErrorMessage(result.reason) })
    }
  })
  return { probes, loaded }
}

async function restoreSessionTabs(
  session: EditorSession,
  includeDirty: boolean,
  signal?: AbortSignal,
) {
  const { probes, loaded } = await probeSessionFiles(session, includeDirty, signal)
  if (signal?.aborted) return
  const plan = createEditorSessionRestorePlan(
    session,
    probes,
    includeDirty,
    prefs.trimTrailingNewline,
  )
  const restoredIds = new Map<number, string>()

  for (const entry of plan) {
    const document = entry.tab.path ? loaded.get(entry.tab.path) : undefined
    try {
      if (entry.action === 'use-disk' && !entry.tab.dirty && document) {
        const tab = editor.restoreCleanSessionTab(entry.tab, document)
        restoredIds.set(entry.originalIndex, tab.id)
      } else if (entry.action === 'restore-draft' && entry.tab.dirty && document) {
        const tab = editor.restoreDirtySessionTab(entry.tab, false, document)
        restoredIds.set(entry.originalIndex, tab.id)
      } else if (entry.action === 'restore-detached' && entry.tab.dirty) {
        const tab = editor.restoreDirtySessionTab(entry.tab, true)
        restoredIds.set(entry.originalIndex, tab.id)
        if (entry.tab.path) {
          notify.pushToast({
            type: 'warning',
            title: t('session.detachedTitle'),
            message: t('session.detachedDetail', { filename: entry.tab.filename }),
          })
        }
      } else if (entry.action === 'ask-conflict' && entry.tab.dirty && document) {
        let restoreDraft = false
        try {
          await ElMessageBox.confirm(
            t('session.conflictDetail', { filename: entry.tab.filename }),
            t('session.conflictTitle'),
            {
              confirmButtonText: t('session.restoreDraft'),
              cancelButtonText: t('session.useDisk'),
              distinguishCancelAndClose: true,
              showClose: false,
              closeOnPressEscape: false,
              closeOnClickModal: false,
              type: 'warning',
            },
          )
          restoreDraft = true
        } catch (action) {
          // The only normal rejection is the explicit Use Disk button. An
          // unexpected dialog failure keeps the draft, never discards it.
          restoreDraft = action !== 'cancel'
        }
        const tab = restoreDraft
          ? editor.restoreDirtySessionTab(entry.tab, false, document, true)
          : editor.restoreCleanSessionTab({
              dirty: false,
              path: entry.tab.path!,
              cursor: entry.tab.cursor,
              sourceSelection: entry.tab.sourceSelection,
              sourceMode: entry.tab.sourceMode,
            }, document)
        restoredIds.set(entry.originalIndex, tab.id)
      } else if (entry.action === 'skip' && entry.reason !== 'discarded') {
        notify.pushToast({
          type: 'warning',
          title: t('session.restoreSkipped'),
          message: entry.reason ?? t('session.fileMissing'),
        })
      }
    } catch (error) {
      // A dirty buffer must survive even if its disk metadata cannot be
      // materialized. Detach it so the next Save uses Save As.
      if (entry.tab.dirty) {
        const tab = editor.restoreDirtySessionTab(entry.tab as DirtyEditorSessionTab, true)
        restoredIds.set(entry.originalIndex, tab.id)
      }
      notify.pushToast({
        type: 'warning',
        title: t('session.restoreSkipped'),
        message: sessionErrorMessage(error),
      })
    }
  }

  const requested = session.activeTabIndex === undefined
    ? undefined
    : restoredIds.get(session.activeTabIndex)
  const fallback = [...restoredIds.values()].at(-1)
  if (requested || fallback) editor.setCurrent(requested ?? fallback ?? null)
}

async function restoreStartupState(signal?: AbortSignal) {
  let session: EditorSession | null = null
  if (ownsDefaultSession) {
    try { session = await getEditorSession() }
    catch (error) {
      notify.pushToast({ type: 'error', title: t('session.loadFailed'), message: sessionErrorMessage(error) })
    }
  }

  const hasCrashDrafts = Boolean(session && !session.cleanShutdown && session.tabs.some(tab => tab.dirty))
  const recoverCrashDrafts = session ? await shouldRecoverCrashDrafts(session) : false
  if (signal?.aborted) return
  const restoreLastState = prefs.startUpAction === 'lastState'
  const restorePersistedTabs = Boolean(session && (restoreLastState || recoverCrashDrafts))

  if (session && restorePersistedTabs) {
    await restoreSessionTabs(session, recoverCrashDrafts || !hasCrashDrafts, signal)
  } else if (restoreLastState && !session && prefs.recentFiles[0]) {
    // One-time compatibility fallback for users upgrading from builds that
    // only retained recent lists rather than a real session.
    try { await editor.openFile(prefs.recentFiles[0]) }
    catch (error) {
      notify.pushToast({ type: 'error', title: t('toast.openFailed'), message: sessionErrorMessage(error) })
    }
  }
  if (signal?.aborted) return

  // End the hydration gate before opening the workspace: openRoot installs
  // the native watcher, which must not race draft-vs-disk decisions above.
  editor.finishStartupHydration()

  const folder = recoverCrashDrafts && session?.workspacePath
    ? session.workspacePath
    : restoreLastState && session?.workspacePath
      ? session.workspacePath
      : prefs.startUpAction === 'folder'
        ? prefs.defaultDirectoryToOpen.trim()
        : restoreLastState && !session
          ? (prefs.recentFolders[0] ?? '')
          : ''
  if (folder && !signal?.aborted) await project.openRoot(folder)
}

function installSessionPersistence() {
  if (!ownsDefaultSession || sessionWriter) return
  sessionWriter = createEditorSessionWriter({
    delay: 1000,
    snapshot: currentEditorSessionSnapshot,
    write: setEditorSession,
    onError: error => notify.pushToast({
      type: 'error',
      title: t('session.saveFailed'),
      message: sessionErrorMessage(error),
    }),
  })

  // Draft content/cursor changes are debounced; structural transitions and
  // saves flush immediately so a tab switch or close cannot strand a draft.
  stopSessionChanges = watch(
    () => editor.tabs.map(tab => ({
      id: tab.id,
      isSaved: tab.isSaved,
      pathname: tab.pathname,
      filename: tab.filename,
      markdown: tab.markdown,
      lastSavedMarkdown: tab.lastSavedMarkdown,
      encoding: tab.encoding,
      lineEnding: tab.lineEnding,
      trimTrailingNewline: tab.trimTrailingNewline,
      cursor: tab.cursor,
      sourceSelection: tab.sourceSelection,
      sourceMode: tab.sourceMode,
    })),
    () => sessionWriter?.schedule(),
    { deep: true },
  )
  stopSessionTransitions = watch(
    () => [
      editor.currentFileId,
      editor.tabs.length,
      editor.tabs.map(tab => `${tab.id}:${tab.isSaved}:${tab.pathname}`).join('|'),
      project.projectTree?.pathname ?? '',
    ],
    () => { void sessionWriter?.flush().catch(() => undefined) },
    { flush: 'post' },
  )
  void sessionWriter.flush().catch(() => undefined)
}

async function doExportHtml() {
  const tab = editor.currentFile
  if (!tab) return
  const target = await saveAsDialog((tab.filename.replace(/\.md$/i, '') || 'untitled') + '.html')
  if (!target) return
  const muya = editor.getMuyaInstance()
  if (!muya) {
    notify.pushToast({ type: 'error', title: t('toast.exportFailed'), message: t('toast.editorNotReady') })
    return
  }
  try {
    const { default: ExportHtml } = await import('muya/lib/utils/exportHtml')
    const exporter = new ExportHtml(tab.markdown, muya)
    const html = await exporter.generate({
      title: tab.filename.replace(/\.md$/i, ''),
      toc: false,
      printOptimization: false,
      extraCss: '',
    })
    await exportHtml(target, html)
    notify.pushToast({ type: 'success', message: t('toast.exportedTo', { path: target }) })
  } catch (err) {
    notify.pushToast({ type: 'error', title: t('toast.exportFailed'), message: err instanceof Error ? err.message : String(err) })
  }
}

function doPrint() { bus.emit('show-export-dialog', undefined) }

async function doExportPandoc(format: 'docx' | 'odt' | 'epub') {
  const tab = editor.currentFile
  if (!tab) return
  const target = await saveAsDialog((tab.filename.replace(/\.md$/i, '') || 'untitled') + '.' + format)
  if (!target) return
  try {
    await pandocConvert(tab.markdown, target, format)
    notify.pushToast({ type: 'success', message: t('toast.exportedTo', { path: target }) })
  } catch (err) {
    notify.pushToast({
      type: 'error', title: t('toast.exportFailed'),
      message: err instanceof Error ? err.message : String(err),
    })
  }
}

/* ── menu action router ─────────────────────────────────────── */
const MENU_ACTIONS: Record<string, () => void | Promise<void>> = {
  'file.new': () => { editor.newUntitledTab() },
  'file.newWindow': async () => { const { newWindow } = await import('@/services/tauri-invoke'); await newWindow() },
  'file.open': doOpen,
  'file.openFolder': doOpenFolder,
  'file.save': async () => { await editor.saveCurrent() },
  'file.saveAs': async () => {
    const tab = editor.currentFile
    if (!tab) return
    const picked = await saveAsDialog(tab.filename)
    if (!picked) return
    await editor.saveCurrentAs(picked)
  },
  'file.saveAll': async () => { await editor.saveAllTabs() },
  'file.exportHtml': doExportHtml,
  'file.exportDocx': () => doExportPandoc('docx'),
  'file.exportOdt': () => doExportPandoc('odt'),
  'file.exportEpub': () => doExportPandoc('epub'),
  'file.print': doPrint,
  'file.preferences': async () => { const { openSettings } = await import('@/services/tauri-invoke'); await openSettings() },
  'file.closeTab': async () => { if (editor.currentFileId) await editor.closeTab(editor.currentFileId) },
  'file.closeWindow': requestWindowClose,
  'edit.find': () => { bus.emit('request-find-replace', { mode: 'find' }) },
  'edit.replace': () => { bus.emit('request-find-replace', { mode: 'replace' }) },
  'edit.copyAsMarkdown': () => bus.emit('copyAsMarkdown', undefined),
  'edit.copyAsHtml': () => bus.emit('copyAsHtml', undefined),
  'edit.pasteAsPlainText': () => bus.emit('pasteAsPlainText', undefined),
  'view.toggleSidebar': () => layout.toggleSideBar(),
  'view.toggleAgent': () => agent.toggle(),
  'view.toggleTabBar': () => layout.toggleTabBar(),
  'view.toggleToolbar': () => layout.toggleToolBar(),
  'view.toggleStatusBar': () => layout.toggleStatusBar(),
  'view.toggleSourceCode': () => editor.toggleSourceCode(),
  'view.toggleTypewriter': () => { prefs.typewriter = !prefs.typewriter },
  'view.toggleFocus': () => { prefs.focus = !prefs.focus },
  'view.commandPalette': () => bus.emit('show-command-palette', undefined),
  'view.zoomIn': () => { void prefs.set('zoom', Math.min(prefs.zoom + 0.1, 2)) },
  'view.zoomOut': () => { void prefs.set('zoom', Math.max(prefs.zoom - 0.1, 0.5)) },
  'view.zoomReset': () => { void prefs.set('zoom', 1) },
  'window.alwaysOnTop': async () => {
    const win = await import('@tauri-apps/api/window')
    const w = win.getCurrentWindow()
    const cur = await w.isAlwaysOnTop()
    await w.setAlwaysOnTop(!cur)
  },
  'window.fullscreen': async () => {
    const win = await import('@tauri-apps/api/window')
    const w = win.getCurrentWindow()
    const cur = await w.isFullscreen()
    await w.setFullscreen(!cur)
  },
  'help.about': () => bus.emit('aboutDialog', undefined),
  'help.openDocs': async () => { const sh = await import('@tauri-apps/plugin-shell'); await sh.open(PROJECT_WIKI_URL) },
  'help.openIssues': async () => { const sh = await import('@tauri-apps/plugin-shell'); await sh.open(PROJECT_ISSUES_URL) },
  'help.checkForUpdates': () => bus.emit('show-updater-dialog', undefined),
}

type MenuActionSource = 'menu' | 'shortcut' | 'palette'
type EditBusAction = 'undo' | 'redo' | 'selectAll' | 'cut' | 'copy' | 'paste'

const EDIT_ACTIONS: Readonly<Record<string, EditBusAction>> = Object.freeze({
  'edit.undo': 'undo',
  'edit.redo': 'redo',
  // These IDs are emitted only while Preferences has temporarily replaced
  // Muda's accelerator-owning predefined clipboard items for shortcut
  // recording. Keeping a renderer fallback preserves menu clicks in that
  // brief lease without changing normal native clipboard ownership.
  'edit.cut': 'cut',
  'edit.copy': 'copy',
  'edit.paste': 'paste',
  'edit.selectAll': 'selectAll',
})

function executeFocusedNativeEdit(action: EditBusAction): void {
  const active = document.activeElement
  if (action === 'selectAll' && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) {
    active.select()
    return
  }
  try { document.execCommand(action) } catch { /* focused control has no native edit history */ }
}

function routeEditAction(action: EditBusAction, source: MenuActionSource): void {
  if (action === 'cut' || action === 'copy' || action === 'paste') {
    executeFocusedNativeEdit(action)
    return
  }
  const active = document.activeElement
  if (
    source === 'menu'
    && active instanceof Element
    && isTextEditingTarget(active)
    && !isEditorShortcutTarget(active)
  ) {
    executeFocusedNativeEdit(action)
    return
  }
  bus.emit(action, undefined)
}

async function routeMenuAction(id: string, source: MenuActionSource = 'menu'): Promise<void> {
  const editAction = EDIT_ACTIONS[id]
  if (editAction) {
    routeEditAction(editAction, source)
    return
  }
  const editorCommand = resolveEditorMenuCommand(id)
  if (editorCommand?.kind === 'table') {
    // Ask for rows/columns before insertion instead of relying on Muya's
    // default 3×3 table. This matches the upstream Electron behaviour.
    bus.emit('show-table-dialog', undefined)
    return
  }
  if (editorCommand?.kind === 'paragraph') {
    bus.emit('paragraph', editorCommand.value)
    return
  }
  if (editorCommand?.kind === 'format') {
    bus.emit('format', editorCommand.value)
    return
  }
  if (id.startsWith('theme.set:')) {
    const theme = id.slice('theme.set:'.length)
    // Choosing a concrete menu theme explicitly exits follow-system mode so
    // the menu check mark and the rendered palette cannot disagree.
    await prefs.patch({ theme, autoSwitchTheme: 2 })
    return
  }
  if (id.startsWith('file.openRecent:')) {
    const path = id.slice('file.openRecent:'.length)
    await editor.openFile(path)
    return
  }
  if (id === 'file.clearRecent') { prefs.clearRecents(); return }
  if (id === 'file.openRecent.empty') return
  const fn = MENU_ACTIONS[id]
  if (fn) await fn()
  else console.warn('[menu] no handler for action', id)
}

async function executeMenuAction(id: string, source: MenuActionSource = 'menu'): Promise<void> {
  try {
    await routeMenuAction(id, source)
  } catch (error) {
    notify.pushToast({
      type: 'error',
      title: t('command.executionFailed'),
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

/* ── command palette registry ───────────────────────────────── */
function isBuiltinCommandAvailable(spec: BuiltinCommandSpec): boolean {
  const legacyAvailability = spec.availability === 'always'
    || (Boolean(editor.currentFile) && (spec.availability !== 'wysiwyg' || !editor.sourceCodeMode))
  if (!legacyAvailability) return false

  const declaration = getShortcutAction(spec.id)
  return !declaration || isShortcutAvailable(declaration, {
    hasEditor: Boolean(editor.currentFile),
    sourceCodeMode: editor.sourceCodeMode,
  })
}

function registerBuiltinCommands() {
  const platform = shortcutPlatformFromNavigator(navigator.platform)
  const shortcut = (id: string) => {
    const declaration = getShortcutAction(id)
    if (!declaration) return undefined
    if (isShortcutRemappable(declaration)) {
      const accelerator = keys.accel(id)
      return accelerator ? [displayAccelerator(accelerator, platform)] : undefined
    }
    return getShortcutAccelerators(declaration, platform)
      .map(accelerator => displayAccelerator(accelerator, platform))
  }
  for (const spec of BUILTIN_COMMAND_SPECS) {
    const categoryKey = `command.categories.${spec.category}`
    cc.register({
      id: spec.id,
      category: () => t(categoryKey),
      categoryOrder: commandCategoryOrder(spec.category),
      description: () => t(spec.labelKey),
      keywords: [() => t(categoryKey)],
      shortcut: shortcut(spec.id),
      execute: () => routeMenuAction(spec.id, 'palette'),
      when: () => isBuiltinCommandAvailable(spec),
    })
  }
}

watch(() => keys.map, map => {
  for (const cmd of cc.subcommands) {
    if (!(cmd.id in map)) continue
    const accel = map[cmd.id]
    const platform = shortcutPlatformFromNavigator(navigator.platform)
    cc.register({ ...cmd, shortcut: accel ? [displayAccelerator(accel, platform)] : undefined })
  }
}, { deep: true })

let unsubOpenFile: (() => void) | null = null
let unsubDrop: (() => void) | null = null
let unsubMenu: (() => void) | null = null
let unsubPrint: (() => void) | null = null
let unsubFsChange: (() => void) | null = null
let unsubCloseRequested: (() => void) | null = null

onMounted(async () => {
  // Global bootstrap has already subscribed, then loaded the preference and
  // keybinding snapshots before mounting this page.
  registerBuiltinCommands()
  // Focus-sensitive editor shortcuts are renderer-owned in every runtime.
  // Windows application shortcuts run before Muya/CodeMirror keymaps.
  window.addEventListener('keydown', onApplicationKey, true)
  window.addEventListener('keydown', onKey)

  const currentWindow = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
    ? getCurrentWindow()
    : null
  ownsDefaultSession = !currentWindow || currentWindow.label === 'main'

  if (currentWindow) {
    unsubCloseRequested = await currentWindow.onCloseRequested(event => {
      event.preventDefault()
      void requestWindowClose()
    })
  }

  // File-association launches forward to a custom DOM event.
  const handler = (e: Event) => {
    const detail = (e as CustomEvent<{ path: string }>).detail
    void editor.openFile(detail.path).catch(err => {
      notify.pushToast({ type: 'error', title: t('toast.openFailed'), message: err instanceof Error ? err.message : String(err) })
    })
  }
  window.addEventListener('mt:open-file', handler)
  unsubOpenFile = () => window.removeEventListener('mt:open-file', handler)

  // Native menu actions.
  unsubMenu = await listenTyped('mt://menu/action', id => { void executeMenuAction(id) })

  // Print request — Rust's cmd_export_pdf emits this when the user picks
  // "Export PDF" / "Print" from the menu. We invoke the browser's native
  // print dialog so the OS handles "Save as PDF".
  unsubPrint = await listenTyped('mt://export/print', () => { window.print() })

  // Install external-open and menu listeners before potentially slow folder
  // restoration so startup events cannot fall into another listener gap.
  const startupController = new AbortController()
  startupAbortController = startupController
  const ready = (async () => {
    try {
      await restoreStartupState(startupController.signal)
    } finally {
      if (editor.startupHydrationPending) editor.finishStartupHydration()
    }
  })()
  startupReady = ready
  try {
    await ready
  } catch (error) {
    if (!startupController.signal.aborted) {
      notify.pushToast({
        type: 'error',
        title: t('session.loadFailed'),
        message: sessionErrorMessage(error),
      })
    }
  } finally {
    if (startupReady === ready) startupReady = null
    if (startupAbortController === startupController) startupAbortController = null
    // Hydration (including timeout-detached drafts) is complete here, so the
    // initial write can no longer replace a crash snapshot with partial tabs.
    installSessionPersistence()
  }
  unsubFsChange = await listenTyped('mt://fs/change', event => {
    void editor.handleFileWatchEvent(event)
  })

  // Drag-and-drop files onto the webview.
  try {
    const wv = getCurrentWebview()
    unsubDrop = await wv.onDragDropEvent(async ev => {
      const p = ev.payload
      if (p.type === 'enter' || p.type === 'over') {
        dragOver.value = true
      } else if (p.type === 'leave') {
        dragOver.value = false
      } else if (p.type === 'drop') {
        dragOver.value = false
        for (const file of p.paths) {
          try { await editor.openFile(file) }
          catch (err) {
            notify.pushToast({ type: 'error', title: t('toast.openFailed'), message: err instanceof Error ? err.message : String(err) })
          }
        }
      }
    })
  } catch (err) {
    console.warn('[drag-drop] failed to install handler', err)
  }
})

onBeforeUnmount(() => {
  startupAbortController?.abort()
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('keydown', onApplicationKey, true)
  unsubOpenFile?.()
  unsubDrop?.()
  unsubMenu?.()
  unsubPrint?.()
  unsubFsChange?.()
  unsubCloseRequested?.()
  stopSessionChanges?.()
  stopSessionTransitions?.()
  sessionWriter?.dispose()
  for (const id of BUILTIN_COMMAND_IDS) cc.unregister(id)
})
</script>

<template>
  <div class="editor-page" :class="{ 'drag-over': dragOver }">
    <TitleBar />
    <div class="page-body">
      <SideBar v-if="layout.showSideBar" />
      <div class="editor-column">
        <TabsBar v-if="layout.showTabBar" />
        <EditorToolbar v-if="layout.showToolBar" />
        <div class="editor-stage">
          <MuyaEditor v-show="editor.currentFile && !editor.sourceCodeMode" />
          <SourceCodePane v-show="editor.currentFile && editor.sourceCodeMode" />
          <FindReplaceBar />
        </div>
      </div>
      <AgentPanel v-if="agent.visible" />
    </div>
    <StatusBar v-if="layout.showStatusBar" />
    <CommandPalette />
    <AboutDialog />
    <RenameDialog />
    <RecentDialog />
    <TableDialog />
    <UpdaterDialog />
    <ExportSettingsDialog />
    <ContextMenu />
    <ImagePreview />
    <div v-if="dragOver" class="drop-veil">Drop to open</div>
  </div>
</template>

<style scoped>
.editor-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--mt-bg);
  position: relative;
  border-radius: var(--mt-radius-window);
  overflow: hidden;
}
.editor-page:has(.title-bar.is-maximized),
.editor-page:has(.mac-title-bar) { border-radius: 0; }
.page-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.editor-column {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
  min-height: 0;
}
.editor-stage {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
}
.drop-veil {
  position: absolute;
  inset: 0;
  background: rgba(3, 102, 214, 0.10);
  border: 2px dashed rgba(3, 102, 214, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: 500;
  color: #0366d6;
  pointer-events: none;
  z-index: 100;
}
</style>
