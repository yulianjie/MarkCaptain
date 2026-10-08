<script setup lang="ts">
/**
 * Muya host — one Muya instance for the lifetime of this component;
 * tab switches swap content via setMarkdown rather than destroying and
 * rebuilding (mirrors the original Electron marktext editor.vue).
 *
 * Having both onMounted and watch(currentFileId) call a destroy/recreate
 * `mount()` produced a microtask race where two Muya instances were
 * constructed for the initial Untitled tab, leaving the DOM half-built
 * and breaking the first inline conversion (e.g. `## hi` → H2).
 *
 * Layered services this host wires together (Step 1–6 of the
 * "对齐 marktext 编辑效果" plan):
 *
 *   1. Constructor options come straight from `usePreferencesStore` —
 *      no hardcoded defaults; the Muya engine reads what the user has
 *      configured.
 *   2. `applyPreferencesToMuya(muya)` installs 24 reactive watchers so
 *      every later prefs change is pushed into the live instance.
 *   3. Subscribes to Muya's `selectionChange` / `selectionFormats` /
 *      `format-click` events for typewriter scroll, native-menu ✓ marks,
 *      and Ctrl/Cmd-click on links/images.
 *   4. Image-picker / autocomplete / clipboard-path callbacks are routed
 *      through `muya-image-picker.ts` (Tauri dialog + listDirectory).
 *   5. Prism light/dark CSS is hot-swapped from `muya-preferences-applier.ts`'s
 *      `theme` watcher — no static `import`.
 *   6. Extra bus handlers (`duplicate`, `insertParagraph`, `insert-image`,
 *      `invalidate-image-cache`, …) are
 *      installed in `installBusHandlers()`.
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager'
import { open as openExternal } from '@tauri-apps/plugin-shell'
import { useEditorStore } from '@/stores/editor'
import type { DocumentState, HistoryStack } from '@/stores/help'
import { usePreferencesStore } from '@/stores/preferences'
import { useI18n } from '@/i18n'
import { muyaImageAction } from '@/services/muya-image-action'
import { resolveLocalImageSrc } from '@/services/local-image-src'
import {
  muyaImagePathPicker,
  muyaImagePathAutoComplete,
  muyaClipboardFilePath,
} from '@/services/muya-image-picker'
import { applyPreferencesToMuya } from '@/services/muya-preferences-applier'
import { effectiveThemeId } from '@/services/preferences-applier'
import { normalizeMarkdown } from '@/services/trailing-newline'
import { installMuyaContentHistory, stepMuyaHistory } from '@/services/muya-history'
import { setFormatMenuState } from '@/services/tauri-invoke'
import { spellchecker } from '@/services/spellchecker'
import {
  currentShortcutPlatform,
  displayAccelerator,
  getShortcutAccelerators,
} from '@/common/shortcut-registry'
import {
  buildEditorContextMenuItems,
  extractContextWord,
  LatestContextMenuRequest,
  normalizeSpellingSuggestions,
  type ContextSelection,
  type EditorContextMenuActions,
  type EditorContextSpellingState,
} from '@/services/editor-context-menu'
import {
  emptySearchRevealGuard,
  enqueueSearchReveal,
  revealRequestToEditorRange,
  settleSearchReveal,
} from '@/services/search-reveal'
import { bus } from '@/bus'

const editor = useEditorStore()
const prefs = usePreferencesStore()
const { t, locale } = useI18n()

const editorRoot = ref<HTMLDivElement | null>(null)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const muyaRef = shallowRef<any>(null)
watch(locale, () => muyaRef.value?.quickInsert?.refresh())
const activeBoundId = ref<string | null>(null)
let disposePrefsApplier: (() => void) | null = null
const contextMenuRequests = new LatestContextMenuRequest()
let revealGuard = emptySearchRevealGuard()

interface CapturedMuyaCursor {
  anchor: { key: string; offset: number }
  focus: { key: string; offset: number }
  start: { key: string; offset: number }
  end: { key: string; offset: number }
}

function captureContextCursor(selection: ContextSelection): CapturedMuyaCursor | null {
  const { start, end } = selection
  if (!start?.key || !end?.key) return null
  if (typeof start.offset !== 'number' || typeof end.offset !== 'number') return null
  const capturedStart = { key: start.key, offset: start.offset }
  const capturedEnd = { key: end.key, offset: end.offset }
  return {
    anchor: capturedStart,
    focus: capturedEnd,
    start: capturedStart,
    end: capturedEnd,
  }
}

function contextMenuShortcuts() {
  const platform = currentShortcutPlatform()
  const shortcut = (actionId: string) => getShortcutAccelerators(actionId, platform)
    .map(accelerator => displayAccelerator(accelerator, platform))
    .join(' / ')
  return {
    undo: shortcut('edit.undo'),
    redo: shortcut('edit.redo'),
    cut: shortcut('edit.cut'),
    copy: shortcut('edit.copy'),
    paste: shortcut('edit.paste'),
    selectAll: shortcut('edit.selectAll'),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function contextMenuCapabilities(muya: any, selection: ContextSelection) {
  const history = muya.contentState?.history
  const hasPendingHistory = Boolean(history?.pending)
  const stackLength = Array.isArray(history?.stack) ? history.stack.length : 0
  const historyIndex = typeof history?.index === 'number' ? history.index : -1
  const hasRange = selection.start?.key !== selection.end?.key
    || selection.start?.offset !== selection.end?.offset
  const hasSpecialSelection = Boolean(
    muya.contentState?.selectedTableCells || muya.contentState?.selectedImage,
  )
  const hasSelection = hasRange || hasSpecialSelection
  return {
    undo: hasPendingHistory || historyIndex > 0,
    redo: !hasPendingHistory && historyIndex >= 0 && historyIndex < stackLength - 1,
    cut: hasSelection,
    copy: hasSelection,
    paste: typeof muya.contentState?.pasteHandler === 'function',
    selectAll: Boolean(muya.getMarkdown?.()),
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function restoreContext(muya: any, cursor: CapturedMuyaCursor, tabId: string): boolean {
  if (editor.sourceCodeMode || muyaRef.value !== muya || activeBoundId.value !== tabId) return false
  muya.contentState.cursor = {
    anchor: { ...cursor.anchor },
    focus: { ...cursor.focus },
    start: { ...cursor.start },
    end: { ...cursor.end },
  }
  muya.focus?.()
  return true
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function copyOrCut(muya: any, cursor: CapturedMuyaCursor, tabId: string, command: 'copy' | 'cut') {
  if (!restoreContext(muya, cursor, tabId)) return
  const before = muya.getMarkdown?.()
  let fallbackText = ''
  try {
    fallbackText = muya.contentState?.getClipBoardData?.()?.text
      ?? window.getSelection()?.toString()
      ?? ''
  } catch { /* use an empty fallback */ }

  let executed = false
  try { executed = Boolean(document.execCommand?.(command)) } catch { /* use host clipboard */ }
  const changedByCut = command === 'cut' && muya.getMarkdown?.() !== before
  if (executed || changedByCut || !fallbackText) return

  // WebView clipboard command support varies. Preserve a plain-text fallback
  // through the Tauri plugin, and mutate only after the write succeeds.
  try {
    await writeText(fallbackText)
    if (command === 'cut' && restoreContext(muya, cursor, tabId)) {
      muya.contentState?.cutHandler?.()
      muya.dispatchSelectionChange?.()
      muya.dispatchSelectionFormats?.()
      muya.dispatchChange?.()
    }
  } catch { /* clipboard unavailable: leave document unchanged */ }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pasteFromClipboard(muya: any, cursor: CapturedMuyaCursor, tabId: string) {
  if (!restoreContext(muya, cursor, tabId)) return
  const before = muya.getMarkdown?.()
  try {
    const text = await readText()
    if (!restoreContext(muya, cursor, tabId)) return
    const pasteHandler = muya.contentState?.pasteHandler
    if (typeof pasteHandler === 'function') {
      const event = {
        preventDefault() {},
        stopPropagation() {},
        clipboardData: {
          items: [],
          getData: (format: string) => format === 'text/plain' ? text : '',
        },
      }
      await pasteHandler.call(muya.contentState, event, 'pasteAsPlainText', text, '')
      return
    }
  } catch {
    // Fall through to the WebView command when the Tauri clipboard is not
    // available (for example in browser-only development mode).
  }
  if (muya.getMarkdown?.() !== before || !restoreContext(muya, cursor, tabId)) return
  try { document.execCommand?.('paste') } catch { /* no safe paste channel */ }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleEditorContextMenu(muya: any, event: MouseEvent, selection: ContextSelection) {
  if (editor.sourceCodeMode) return
  event.preventDefault()

  const cursor = captureContextCursor(selection)
  const tabId = activeBoundId.value
  if (!cursor || !tabId) return

  const token = contextMenuRequests.begin()
  const position = { x: event.clientX, y: event.clientY }
  const wordInfo = prefs.spellcheckerEnabled ? extractContextWord(selection) : null
  const closeRequest = () => contextMenuRequests.invalidate(token)

  const restore = () => restoreContext(muya, cursor, tabId)
  const actions: EditorContextMenuActions = {
    undo: () => { if (restore()) stepMuyaHistory(muya, 'undo') },
    redo: () => { if (restore()) stepMuyaHistory(muya, 'redo') },
    cut: () => copyOrCut(muya, cursor, tabId, 'cut'),
    copy: () => copyOrCut(muya, cursor, tabId, 'copy'),
    paste: () => pasteFromClipboard(muya, cursor, tabId),
    selectAll: () => { if (restore()) muya.selectAll?.() },
    replaceWord: replacement => {
      if (wordInfo && restore()) {
        muya._replaceCurrentWordInlineUnsafe?.(wordInfo.word, replacement)
      }
    },
    addToDictionary: () => wordInfo ? spellchecker.addWord(wordInfo.word) : undefined,
  }

  const showMenu = (spelling?: EditorContextSpellingState) => {
    if (!contextMenuRequests.isCurrent(token)) return
    bus.emit('openContextMenu', {
      ...position,
      onClose: closeRequest,
      items: buildEditorContextMenuItems({
        labels: {
          undo: t('editorContextMenu.undo'),
          redo: t('editorContextMenu.redo'),
          cut: t('editorContextMenu.cut'),
          copy: t('editorContextMenu.copy'),
          paste: t('editorContextMenu.paste'),
          selectAll: t('editorContextMenu.selectAll'),
          checkingSpelling: t('editorContextMenu.checkingSpelling'),
          noSuggestions: t('editorContextMenu.noSuggestions'),
          addToDictionary: t('editorContextMenu.addToDictionary', { word: wordInfo?.word ?? '' }),
        },
        capabilities: contextMenuCapabilities(muya, selection),
        actions,
        spelling,
        shortcuts: contextMenuShortcuts(),
      }),
    })
  }

  if (!wordInfo) {
    showMenu()
    return
  }

  showMenu({ word: wordInfo.word, checking: true })
  void (async () => {
    const misspelled = await spellchecker.check([wordInfo.word])
    if (!contextMenuRequests.isCurrent(token)) return
    if (!misspelled.includes(wordInfo.word)) {
      showMenu()
      return
    }
    const suggestions = normalizeSpellingSuggestions(
      wordInfo.word,
      await spellchecker.suggest(wordInfo.word),
    )
    if (!contextMenuRequests.isCurrent(token)) return
    showMenu({ word: wordInfo.word, misspelled: true, suggestions })
  })()
}

async function loadMuya() {
  const { default: Muya } = await import('muya/lib')
  if (!Muya.__pluginsRegistered) {
    const mods = await Promise.all([
      import('muya/lib/ui/tablePicker'),
      import('muya/lib/ui/quickInsert'),
      import('muya/lib/ui/codePicker'),
      import('muya/lib/ui/emojiPicker'),
      import('muya/lib/ui/imagePicker'),
      import('muya/lib/ui/imageSelector'),
      import('muya/lib/ui/imageToolbar'),
      import('muya/lib/ui/transformer'),
      import('muya/lib/ui/formatPicker'),
      import('muya/lib/ui/linkTools'),
      import('muya/lib/ui/footnoteTool'),
      import('muya/lib/ui/tableTools'),
      import('muya/lib/ui/frontMenu'),
    ])
    const [TablePicker, QuickInsert, CodePicker, EmojiPicker, ImagePathPicker,
      ImageSelector, ImageToolbar, Transformer, FormatPicker, LinkTools,
      FootnoteTool, TableBarTools, FrontMenu] = mods.map(m => m.default)
    Muya.use(TablePicker)
    Muya.use(QuickInsert)
    Muya.use(CodePicker)
    Muya.use(EmojiPicker)
    Muya.use(ImagePathPicker)
    Muya.use(ImageSelector, {
      unsplashAccessKey: '',
      photoCreatorClick: (url: string) => { void openExternal(url) },
    })
    Muya.use(Transformer)
    Muya.use(ImageToolbar)
    Muya.use(FormatPicker)
    Muya.use(FrontMenu)
    Muya.use(LinkTools, {
      jumpClick: (linkInfo: { href?: string }) => {
        const href = linkInfo?.href
        if (href) void openExternal(href)
      },
    })
    Muya.use(FootnoteTool)
    Muya.use(TableBarTools)
    Muya.__pluginsRegistered = true
  }
  return Muya
}

/** Build the single Muya instance. Idempotent: subsequent calls no-op. */
async function construct() {
  if (muyaRef.value || !editorRoot.value) return
  const Muya = await loadMuya()
  const isDark = /dark/i.test(effectiveThemeId.value)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let muya: any
  try {
    muya = new Muya(editorRoot.value, {
      // ── content / focus ───────────────────────────────────────
      markdown: '',
      baseUrl: '',
      imageSrcResolver: resolveLocalImageSrc,
      focusMode: prefs.focus,
      // ── typography ────────────────────────────────────────────
      fontSize: prefs.fontSize,
      lineHeight: prefs.lineHeight,
      // ── lists / indentation ───────────────────────────────────
      bulletListMarker: prefs.bulletListMarker,
      // Muya's actual option key is `orderListDelimiter` — the old code
      // passed `orderListMarker`, which Muya silently ignored.
      orderListDelimiter: prefs.orderListDelimiter,
      preferLooseListItem: prefs.preferLooseListItem,
      preferHeadingStyle: prefs.preferHeadingStyle,
      tabSize: prefs.tabSize,
      listIndentation: prefs.listIndentation,
      // ── auto-pair ─────────────────────────────────────────────
      autoPairBracket: prefs.autoPairBracket,
      autoPairMarkdownSyntax: prefs.autoPairMarkdownSyntax,
      autoPairQuote: prefs.autoPairQuote,
      // ── Markdown extensions ───────────────────────────────────
      frontmatterType: prefs.frontmatterType,
      superSubScript: prefs.superSubScript,
      footnote: prefs.footnote,
      isGitlabCompatibilityEnabled: prefs.isGitlabCompatibilityEnabled,
      // Muya reads `disableHtml`; the prefs flag is the opposite ("is HTML
      // enabled?") so invert. Previously the wrapper passed the original
      // pref key which Muya didn't recognise → HTML render permanently off.
      disableHtml: !prefs.isHtmlEnabled,
      trimUnnecessaryCodeBlockEmptyLines: prefs.trimUnnecessaryCodeBlockEmptyLines,
      codeBlockLineNumbers: prefs.codeBlockLineNumbers,
      // ── behaviour ─────────────────────────────────────────────
      hideQuickInsertHint: prefs.hideQuickInsertHint,
      hideLinkPopup: prefs.hideLinkPopup,
      autoCheck: prefs.autoCheck,
      spellcheckEnabled: prefs.spellcheckerEnabled,
      // ── diagram themes ────────────────────────────────────────
      sequenceTheme: prefs.sequenceTheme,
      mermaidTheme: isDark ? 'dark' : 'default',
      vegaTheme: isDark ? 'dark' : 'latimes',
      // ── host callbacks ────────────────────────────────────────
      translate: t,
      imageAction: muyaImageAction,
      imagePathPicker: muyaImagePathPicker,
      imagePathAutoComplete: muyaImagePathAutoComplete,
      clipboardFilePath: muyaClipboardFilePath,
      clipboardWriteText: writeText,
    })
  } catch (err) {
    console.error('[Muya constructor failed]', err)
    return
  }

  // ── content change ──────────────────────────────────────────
  // Resolve the active tab at event-fire time, not closure time — the single
  // instance survives tab switches so the listener must always write into
  // whichever tab is currently mounted.
  muya.on('change', (changes: {
    markdown: string
    wordCount?: unknown
    cursor?: unknown
    history?: HistoryStack
    toc?: unknown
  }) => {
    const id = activeBoundId.value
    if (!id) return
    editor.applyContentChange(id, changes.markdown, {
      wordCount: changes.wordCount as never,
      cursor: changes.cursor,
      history: changes.history,
      toc: changes.toc as { lvl: number; content: string; slug?: string }[] | undefined,
    })
  })

  // ── selectionChange: typewriter scroll + cursor-stay-in-view ───
  muya.on('selectionChange', (changes: { cursorCoords?: { y: number } }) => {
    const container = editorRoot.value?.parentElement
    const y = changes?.cursorCoords?.y
    if (!container || typeof y !== 'number') return
    if (prefs.typewriter) {
      const target = container.scrollTop + y - container.clientHeight / 2
      if (Math.abs(container.scrollTop - target) > 2) {
        animatedScrollTo(container, target, 100)
      }
    }
    // Mirror upstream fix #628: keep cursor visible when it sinks below the
    // last 100px of the viewport.
    if (container.clientHeight - y < 100) {
      const editableHeight = container.clientHeight - 100
      animatedScrollTo(container, container.scrollTop + (y - editableHeight), 0)
    }
  })

  // ── selectionFormats: drive native-menu ✓ marks + future toolbar ──
  // Muya hands us an array of `{ type, … }` tokens. We strip down to the
  // type names so both the renderer toolbar and the Rust menu see a flat
  // list of strings.
  muya.on('selectionFormats', (formats: Array<{ type: string }>) => {
    const types = Array.isArray(formats) ? formats.map(f => f?.type).filter(Boolean) : []
    editor.setSelectionFormats(types)
    void setFormatMenuState(types).catch(() => {
      // Settings window doesn't have a menu — invocations from there will
      // fail; not a real error.
    })
  })

  // ── format-click: Ctrl/Cmd+click on link / image ──────────────
  muya.on('format-click', ({ event, formatType, data }: {
    event: MouseEvent
    formatType: string
    data: string | { text: string; href: string }
  }) => {
    const isOsx = navigator.platform.toLowerCase().includes('mac')
    const ctrlOrMeta = (isOsx && event.metaKey) || (!isOsx && event.ctrlKey)
    if (!ctrlOrMeta) return
    if (formatType === 'link' && typeof data === 'object' && data.href) {
      void openExternal(data.href)
    } else if (formatType === 'image' && typeof data === 'string' && data) {
      bus.emit('image-preview/open', { src: data })
    }
  })

  // Muya suppresses the WebView's native menu. Route its normalized cursor
  // payload into our single global menu, including async Hunspell results.
  muya.on('contextmenu', (event: MouseEvent, selection: ContextSelection) => {
    handleEditorContextMenu(muya, event, selection)
  })

  muyaRef.value = muya
  editor.setMuyaInstance(muya)
  busUnsubs.push(installMuyaContentHistory(muya.contentState.history))
  busUnsubs.push(editor.registerAgentEditHandler('wysiwyg', markdown => {
    const state = muya.contentState
    state.history.commitPending()
    if (!state.history.stack.length) {
      state.history.push({ blocks: state.blocks, cursor: state.cursor, renderRange: state.renderRange })
    }
    muya.setMarkdown(markdown)
    state.history.commitPending()
    muya.dispatchChange()
  }))
  disposePrefsApplier = applyPreferencesToMuya(muya)
  console.info('[Muya] constructed')
}

/** Lightweight ease-out scroll-to-y. Used for typewriter mode. */
function animatedScrollTo(el: HTMLElement, to: number, durationMs: number) {
  if (durationMs <= 0) { el.scrollTop = to; return }
  const start = el.scrollTop
  const delta = to - start
  const startTime = performance.now()
  function step(now: number) {
    const t = Math.min(1, (now - startTime) / durationMs)
    // easeOutCubic
    const eased = 1 - Math.pow(1 - t, 3)
    el.scrollTop = start + delta * eased
    if (t < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

function cloneMuyaHistory(history: HistoryStack): HistoryStack {
  return JSON.parse(JSON.stringify(history)) as HistoryStack
}

function persistActiveSession() {
  const muya = muyaRef.value
  const id = activeBoundId.value
  if (!muya || !id) return
  const tab = editor.tabs.find(candidate => candidate.id === id)
  if (!tab) return

  const markdown = muya.getMarkdown?.()
  // Source mode may have updated the shared document while Muya was hidden.
  // Never attach an old block history to that newer Markdown snapshot.
  if (typeof markdown !== 'string' || !matchesDocument(markdown, tab)) return
  muya.contentState?.history?.commitPending?.()
  const history = muya.getHistory?.()
  if (history) tab.history = cloneMuyaHistory(history)
  tab.historyMarkdown = tab.markdown
  tab.cursor = muya.getCursor?.() ?? tab.cursor
}

function matchesDocument(markdown: string, tab: DocumentState): boolean {
  return markdown === tab.markdown || (
    tab.isSaved
    && normalizeMarkdown(markdown, tab.trimTrailingNewline)
      === normalizeMarkdown(tab.markdown, tab.trimTrailingNewline)
  )
}

/** Swap the displayed document and restore only that tab's Muya history. */
function loadFile(tab: DocumentState, persistCurrent = true) {
  const muya = muyaRef.value
  if (!muya) return
  if (persistCurrent) persistActiveSession()
  // Suspend `change` writes until the new tab is bound — otherwise the
  // setMarkdown round-trip's dispatchChange fires under the *old* tab id.
  activeBoundId.value = null
  muya.setOptions({ baseUrl: tab.pathname })
  muya.clearHistory()
  if (tab.cursor) {
    muya.setMarkdown(tab.markdown, tab.cursor, true)
  } else {
    muya.setMarkdown(tab.markdown)
  }
  if (tab.historyMarkdown === tab.markdown && tab.history.stack.length) {
    muya.setHistory(cloneMuyaHistory(tab.history))
  } else {
    tab.history = { stack: [], index: -1 }
    tab.historyMarkdown = tab.markdown
  }
  activeBoundId.value = tab.id
}

function clearFile() {
  persistActiveSession()
  activeBoundId.value = null
  contextMenuRequests.invalidate()
  const muya = muyaRef.value
  if (!muya) return
  muya.blur(false, true)
  muya.setOptions({ baseUrl: '' })
  muya.setMarkdown('', undefined, false)
  muya.clearHistory()
  void setFormatMenuState([]).catch(() => { /* no native menu in browser mode */ })
}

// React to current-tab changes — content swap only, never destroy/recreate.
watch(
  () => editor.currentFileId,
  (id) => {
    if (!id) { clearFile(); tryRevealSearchHit(); return }
    const tab = editor.tabs.find(t => t.id === id)
    if (tab && activeBoundId.value !== id) loadFile(tab)
    tryRevealSearchHit()
  },
  { immediate: false },
)

function syncActiveMarkdownFromStore() {
  const tab = editor.currentFile
  const muya = muyaRef.value
  if (!tab || !muya || activeBoundId.value !== tab.id) return
  // Saving can change only the on-disk trailing-newline representation.
  // Re-parsing that equivalent content resets history/cursor and Muya adds
  // its synthetic newline again, making the just-saved file dirty forever.
  if (matchesDocument(muya.getMarkdown(), tab)) return
  // Disk reloads and source-mode edits deliberately reset Muya's incompatible
  // block history rather than allowing an undo to resurrect stale content.
  loadFile(tab, false)
}

// A clean external reload while WYSIWYG is visible must appear immediately.
// Source-mode keystrokes are synced once when that mode is left, avoiding a
// costly hidden Muya parse on every character.
watch(
  () => editor.currentFile?.markdown,
  () => { if (!editor.sourceCodeMode) syncActiveMarkdownFromStore() },
)

watch(
  () => editor.sourceCodeMode,
  enabled => {
    if (!enabled) syncActiveMarkdownFromStore()
    tryRevealSearchHit()
  },
)

// Save As gives an untitled document its first base directory without changing
// the tab id. Re-render in place so relative images start resolving immediately
// while preserving the editor history and Markdown source.
watch(
  () => editor.currentFile?.pathname ?? '',
  (pathname) => {
    const muya = muyaRef.value
    if (!muya || activeBoundId.value !== editor.currentFileId) return
    if (muya.options.baseUrl === pathname) return
    muya.contentState?.stateRender?.loadImageMap?.clear?.()
    muya.setOptions({ baseUrl: pathname }, true)
  },
)

/* ── bus subscriptions: forward editor actions into the live Muya instance.
 * Each handler short-circuits if no instance is mounted yet. */
const busUnsubs: Array<() => void> = []

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withMuya(fn: (muya: any) => void) {
  const m = muyaRef.value
  if (!m) return
  try { fn(m) } catch (err) { console.warn('[Muya action failed]', err) }
}

// The Muya instance remains mounted behind source mode. Mutating it while it
// is hidden would write stale Markdown back into the active tab.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withVisibleMuya(fn: (muya: any) => void) {
  if (!editor.currentFile || editor.sourceCodeMode) return
  withMuya(fn)
}

function centerMuyaSelection() {
  const root = editorRoot.value
  const focusNode = document.getSelection()?.focusNode
  const element = focusNode instanceof Element ? focusNode : focusNode?.parentElement
  if (!root || !element || !root.contains(element)) return
  const paragraph = element.closest('.ag-paragraph') ?? element
  paragraph.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
}

function tryRevealSearchHit() {
  const settlement = settleSearchReveal(revealGuard, {
    currentTabId: editor.currentFileId,
    boundTabId: activeBoundId.value,
    consumerMode: 'wysiwyg',
    activeMode: editor.sourceCodeMode ? 'source' : 'wysiwyg',
  })
  revealGuard = settlement.state
  const request = settlement.request
  const muya = muyaRef.value
  if (!request || !muya) return

  const markdown = muya.getMarkdown?.() ?? editor.currentFile?.markdown ?? ''
  const range = revealRequestToEditorRange(markdown, request)
  if (!range) return
  muya.setCursor({
    anchor: { line: range.line, ch: range.startCh },
    focus: { line: range.endLine ?? range.line, ch: range.endCh },
  })
  muya.focus()
  window.requestAnimationFrame(centerMuyaSelection)
}

function installBusHandlers() {
  // ── paragraph / format / clipboard ────────────────────────────
  busUnsubs.push(bus.on('paragraph', (type) => withVisibleMuya(m => m.updateParagraph(type))))
  busUnsubs.push(bus.on('format', (type) => withVisibleMuya(m => m.format(type))))
  busUnsubs.push(bus.on('undo', () => withVisibleMuya(m => stepMuyaHistory(m, 'undo'))))
  busUnsubs.push(bus.on('redo', () => withVisibleMuya(m => stepMuyaHistory(m, 'redo'))))
  busUnsubs.push(bus.on('selectAll', () => withVisibleMuya(m => m.selectAll())))
  busUnsubs.push(bus.on('copyAsMarkdown', () => withVisibleMuya(m => m.copyAsMarkdown?.())))
  busUnsubs.push(bus.on('copyAsHtml', () => withVisibleMuya(m => m.copyAsHtml?.())))
  busUnsubs.push(bus.on('pasteAsPlainText', () => withVisibleMuya(m => m.pasteAsPlainText?.())))

  // ── paragraph manipulation (mirrors upstream bus channels) ────
  busUnsubs.push(bus.on('duplicate', () => withVisibleMuya(m => m.duplicate?.())))
  busUnsubs.push(bus.on('createParagraph', () => withVisibleMuya(m => m.insertParagraph?.('after'))))
  busUnsubs.push(bus.on('deleteParagraph', () => withVisibleMuya(m => m.deleteParagraph?.())))
  busUnsubs.push(bus.on('insertParagraph', ({ location, text, outMost }) =>
    withVisibleMuya(m => m.insertParagraph?.(location, text, outMost))))

  // ── images ─────────────────────────────────────────────────────
  busUnsubs.push(bus.on('insert-image', (imageInfo) => withVisibleMuya(m => m.insertImage?.(imageInfo))))
  busUnsubs.push(bus.on('invalidate-image-cache', () => withVisibleMuya(m => m.invalidateImageCache?.())))

  // ── tables (dialog-driven) ────────────────────────────────────
  busUnsubs.push(bus.on('insert-table', ({ rows, columns }) =>
    withVisibleMuya(m => m.createTable?.({ rows, columns }))))

  // ── find / replace ────────────────────────────────────────────
  busUnsubs.push(bus.on('find', ({ value, opt }) => withVisibleMuya(m => {
    const matches = m.search(value, opt)
    if (matches) editor.applySearchResult(matches)
    scrollToHighlight()
  })))
  busUnsubs.push(bus.on('replace', ({ value, opt }) => withVisibleMuya(m => {
    const matches = m.replace(value, opt)
    if (matches) editor.applySearchResult(matches)
  })))
  busUnsubs.push(bus.on('findNext', () => withVisibleMuya(m => {
    const matches = m.find('next')
    if (matches) editor.applySearchResult(matches)
    scrollToHighlight()
  })))
  busUnsubs.push(bus.on('findPrev', () => withVisibleMuya(m => {
    const matches = m.find('prev')
    if (matches) editor.applySearchResult(matches)
    scrollToHighlight()
  })))
  busUnsubs.push(bus.on('find-action', (action) => withVisibleMuya(m => {
    const matches = m.find(action)
    if (matches) editor.applySearchResult(matches)
    scrollToHighlight()
  })))
  busUnsubs.push(bus.on('reveal-search-hit', (request) => {
    revealGuard = enqueueSearchReveal(revealGuard, request)
    tryRevealSearchHit()
  }))

  // ── TOC click navigation ──────────────────────────────────────
  busUnsubs.push(bus.on('scroll-to-header', (slug) => {
    const el = document.getElementById(slug)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }))
}

function scrollToHighlight() {
  const el = document.querySelector('.ag-highlight')
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

onMounted(async () => {
  // Construct the single Muya instance BEFORE touching the store. If we
  // bootstrapped first, the watch(currentFileId) microtask would fire while
  // construct() was awaiting Muya's dynamic imports, racing this path.
  await construct()
  editor.bootstrap()
  const active = editor.currentFile
  if (active) loadFile(active)
  installBusHandlers()
})

onBeforeUnmount(() => {
  contextMenuRequests.invalidate()
  persistActiveSession()
  for (const off of busUnsubs) { try { off() } catch { /* ignore */ } }
  busUnsubs.length = 0
  try { disposePrefsApplier?.() } catch { /* ignore */ }
  disposePrefsApplier = null
  editor.clearMuyaInstance()
  // Clear any leftover ✓ marks before the window/menu may be GC'd.
  void setFormatMenuState([]).catch(() => { /* ignore */ })
  try { muyaRef.value?.destroy?.() } catch (err) {
    console.warn('[Muya destroy] non-fatal:', err)
  }
})
</script>

<template>
  <div class="muya-host" data-editor-shortcut-scope="true" :style="{ '--muya-quick-insert-hint': JSON.stringify(t('quickInsert.hint')) }">
    <div ref="editorRoot" class="muya-container">
      <div></div>
    </div>
  </div>
</template>

<style scoped>
.muya-host {
  flex: 1;
  overflow: auto;
  background: var(--mt-bg, #fff);
  padding: 24px 0;
  font-family: var(--mt-editor-font);
  font-size: var(--mt-font-size);
  line-height: var(--mt-line-height);
  color: var(--mt-fg);
}
.muya-container {
  box-sizing: border-box;
  max-width: var(--mt-editor-line-width, none);
  margin: 0 auto;
  /* Muya places the 20px paragraph control 30px to the left of the text.
   * Reserve that gutter plus 10px inside the host's scroll boundary. */
  padding: 0 40px;
  outline: none;
}
/* Keep document typography local to Muya; never style diagram label elements. */
.muya-container :deep(h1.ag-paragraph) {
  margin: 22px 0 13px;
  font-size: 1.75em;
  line-height: 1.4;
  font-weight: 600;
}
.muya-container :deep(h2.ag-paragraph) {
  margin: 22px 0 8px;
  font-size: 1.1875em;
  line-height: 1.5;
  font-weight: 600;
}
.muya-container :deep(h3.ag-paragraph) { font-size: 1.125em; }
.muya-container :deep(p.ag-paragraph) { margin-block: 0 12px; }
.muya-container :deep(blockquote.ag-paragraph) {
  margin: 18px 0;
  padding: 3px 0 3px 14px;
  border-left: 3px solid var(--mt-accent);
  color: var(--mt-fg-muted);
}
.muya-container :deep(blockquote.ag-paragraph > :last-child) { margin-bottom: 0; }
.muya-container :deep(#ag-editor-id > :first-child) { margin-top: 0; }
.muya-host :deep(code),
.muya-host :deep(pre) {
  font-family: var(--mt-code-font);
  font-size: var(--mt-code-font-size);
}
</style>
