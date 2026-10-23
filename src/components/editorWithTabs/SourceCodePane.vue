<script setup lang="ts">
/**
 * Raw-markdown source-code pane backed by CodeMirror 6.
 *
 * One `EditorView` is created on mount; switching tabs `dispatch`-replaces
 * the document instead of rebuilding the editor (cheaper, preserves DOM
 * focus). Edits flow back into the editor store via `setMarkdownExternal`.
 */
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { EditorSelection, EditorState, Transaction, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
import {
  history,
  isolateHistory,
  historyField,
  historyKeymap,
  defaultKeymap,
  indentWithTab,
  redo,
  selectAll,
  undo,
} from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { HighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { usePaneEditor } from '@/services/editor-panes'
import { AGENT_WRITING_COMMANDS, agentWritingCommandLabel } from '@/services/agent-m1-copy'
import { useAgentStore } from '@/stores/agent'
import { useI18n } from '@/i18n'
import type { DocumentState } from '@/stores/help'
import { bus, type SearchOpt } from '@/bus'
import {
  findSourceMatches,
  firstSourceMatchAtOrAfter,
  stepSourceMatch,
  type SourceSearchMatch,
} from '@/services/source-search'
import {
  emptySearchRevealGuard,
  enqueueSearchReveal,
  revealRequestToEditorRange,
  settleSearchReveal,
} from '@/services/search-reveal'
import { publishSourceDocumentChange, restoreSourceEditorState } from '@/services/source-editor-state'
import { noteCompletions } from '@/services/note-completion'
import { useNotebookStore } from '@/stores/notebook'
import { analyzeNote } from '@/services/note-index'

const props = withDefaults(defineProps<{ paneId?: string }>(), { paneId: 'main' })
const { editor, isActive } = usePaneEditor(props.paneId)
const agent = useAgentStore()
const { t, locale } = useI18n()
const hostRef = ref<HTMLDivElement | null>(null)
const viewRef = shallowRef<EditorView | null>(null)
/** Last id the view's content was synced with — used to detect tab swaps. */
const boundId = ref<string | null>(null)
const stateFields = { history: historyField }
const busUnsubs: Array<() => void> = []
let currentQuery = ''
let currentOptions: SearchOpt = {}
let currentMatches: SourceSearchMatch[] = []
let currentMatchIndex = -1
let replaceAllPending = false
let revealGuard = emptySearchRevealGuard()

// Minimal markdown highlighting palette. Inherits font / colours from the
// host stylesheet otherwise.
const mdHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.4em', fontWeight: '600', color: 'var(--mt-syntax-heading)' },
  { tag: tags.heading2, fontSize: '1.25em', fontWeight: '600', color: 'var(--mt-syntax-heading)' },
  { tag: tags.heading3, fontSize: '1.15em', fontWeight: '600', color: 'var(--mt-syntax-heading)' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: '600', color: 'var(--mt-syntax-heading)' },
  { tag: tags.strong, fontWeight: '600' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--mt-syntax-link)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--mt-syntax-link)' },
  { tag: tags.monospace, color: 'var(--mt-syntax-code)', background: 'var(--mt-code-bg)' },
  { tag: tags.list, color: 'var(--mt-syntax-list)' },
  { tag: tags.quote, color: 'var(--mt-fg-muted)', fontStyle: 'italic' },
])

const baseExtensions = (): Extension[] => [
  noteCompletions(),
  EditorView.domEventHandlers({ contextmenu(event, view) {
    if (!isActive.value || !editor.sourceCodeMode || !boundId.value) return false
    event.preventDefault()
    const id = boundId.value
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
    const selection = view.state.selection.main
    if (position !== null && (selection.empty || position < selection.from || position > selection.to)) {
      view.dispatch({ selection: EditorSelection.cursor(position) })
    }
    const contextSelection = view.state.selection.main
    const contextDocument = view.state.doc.toString()
    const contextFrom = contextSelection.from, contextTo = contextSelection.to
    const restore = () => isActive.value && boundId.value === id && editor.currentFileId === id && editor.sourceCodeMode
    const selectionIsCurrent = () => view.state.selection.main.from === contextFrom && view.state.selection.main.to === contextTo
    const writeClipboard = async (text: string) => {
      if ('__TAURI_INTERNALS__' in window) {
        const clipboard = await import('@tauri-apps/plugin-clipboard-manager')
        await clipboard.writeText(text)
      } else await navigator.clipboard.writeText(text)
    }
    const readClipboard = async () => {
      if ('__TAURI_INTERNALS__' in window) {
        const clipboard = await import('@tauri-apps/plugin-clipboard-manager')
        return clipboard.readText()
      }
      return navigator.clipboard.readText()
    }
    const copySelection = async (remove = false) => {
      if (!restore() || contextFrom === contextTo) return
      const value = contextDocument.slice(contextFrom, contextTo)
      try {
        await writeClipboard(value)
        if (remove && restore() && view.state.doc.toString() === contextDocument
          && view.state.selection.main.from === contextFrom && view.state.selection.main.to === contextTo) {
          view.dispatch({ changes: { from: contextFrom, to: contextTo, insert: '' }, selection: { anchor: contextFrom } })
          view.focus()
        }
      } catch { /* Clipboard permissions can be unavailable in browser previews. */ }
    }
    const pasteAtSelection = async () => {
      if (!restore() || view.state.doc.toString() !== contextDocument || !selectionIsCurrent()) return
      try {
        const value = await readClipboard()
        if (!restore() || view.state.doc.toString() !== contextDocument || !selectionIsCurrent()) return
        view.dispatch({ changes: { from: contextFrom, to: contextTo, insert: value }, selection: { anchor: contextFrom + value.length } })
        view.focus()
      } catch { /* Clipboard permissions can be unavailable in browser previews. */ }
    }
    const items = [
      { label: t('editorContextMenu.undo'), action: () => { if (restore()) editor.usesSharedHistory ? editor.stepSharedHistory('undo') : undo(view) } },
      { label: t('editorContextMenu.redo'), action: () => { if (restore()) editor.usesSharedHistory ? editor.stepSharedHistory('redo') : redo(view) } },
      { divider: true },
      { label: t('editorContextMenu.cut'), disabled: contextFrom === contextTo, action: () => copySelection(true) },
      { label: t('editorContextMenu.copy'), disabled: contextFrom === contextTo, action: () => copySelection() },
      { label: t('editorContextMenu.paste'), action: () => pasteAtSelection() },
      { divider: true },
      { label: t('editorContextMenu.selectAll'), action: () => { if (restore()) selectAll(view) } },
      { divider: true },
      ...AGENT_WRITING_COMMANDS.map(command => ({
        label: `AI · ${agentWritingCommandLabel(command, locale.value)}`,
        action: () => { if (restore() && view.state.doc.toString() === contextDocument && selectionIsCurrent()) agent.queueWritingCommand(command) },
      })),
    ]
    bus.emit('openContextMenu', { x: event.clientX, y: event.clientY, items })
    return true
  } }),
  EditorView.domEventHandlers({ click(event, view) {
    if (!(event.ctrlKey || event.metaKey)) return false
    const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
    const notebook = useNotebookStore(); const source = notebook.currentNote?.relative
    if (position === null || !source) return false
    const link = analyzeNote(source, view.state.doc.toString()).links.find(l => position >= (l.sourceFrom ?? l.from) && position <= (l.sourceTo ?? l.to))
    if (!link) return false
    event.preventDefault(); void notebook.followLink(source, link).catch(e => { notebook.error = String(e) }); return true
  } }),
  lineNumbers(),
  highlightActiveLine(),
  highlightActiveLineGutter(),
  history(),
  indentOnInput(),
  bracketMatching(),
  markdown({ base: markdownLanguage }),
  syntaxHighlighting(mdHighlight),
  EditorView.lineWrapping,
  keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
  EditorView.updateListener.of(update => {
    const id = boundId.value
    if (!id) return
    const tab = editor.tabs.find(candidate => candidate.id === id)
    if (tab) {
      tab.sourceEditorState = update.state.toJSON(stateFields)
      tab.sourceSelection = update.state.selection.toJSON()
    }
    publishSourceDocumentChange(update, id, (tabId, value) => editor.setMarkdownExternal(tabId, value))
  }),
]

function buildState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: baseExtensions() })
}

function restoreState(tab: DocumentState): EditorState {
  return restoreSourceEditorState(tab, baseExtensions(), stateFields)
}

function persistBoundState() {
  const id = boundId.value
  const view = viewRef.value
  if (!id || !view) return
  const tab = editor.tabs.find(candidate => candidate.id === id)
  if (tab) {
    tab.sourceEditorState = view.state.toJSON(stateFields)
    tab.sourceSelection = view.state.selection.toJSON()
  }
}

function mountView(tab: DocumentState | null) {
  if (!hostRef.value) return
  viewRef.value = new EditorView({
    state: tab ? restoreState(tab) : buildState(''),
    parent: hostRef.value,
  })
  boundId.value = tab?.id ?? null
  persistBoundState()
}

function swapTab(tab: DocumentState) {
  const view = viewRef.value
  if (!view) { mountView(tab); return }
  persistBoundState()
  boundId.value = null
  view.setState(restoreState(tab))
  boundId.value = tab.id
  persistBoundState()
}

function publishSearchResult() {
  editor.applySearchResult({
    index: currentMatchIndex,
    matches: currentMatches,
    value: currentQuery,
  })
}

function selectSearchMatch(index: number) {
  const view = viewRef.value
  const match = currentMatches[index]
  if (!view || !match) return
  currentMatchIndex = index
  view.dispatch({
    selection: { anchor: match.from, head: match.to },
    effects: EditorView.scrollIntoView(match.from, { y: 'center' }),
  })
  publishSearchResult()
}

function tryRevealSearchHit() {
  const settlement = settleSearchReveal(revealGuard, {
    currentTabId: editor.currentFileId,
    boundTabId: boundId.value,
    consumerMode: 'source',
    activeMode: editor.sourceCodeMode ? 'source' : 'wysiwyg',
  })
  revealGuard = settlement.state
  const request = settlement.request
  const view = viewRef.value
  if (!request || !view) return

  const range = revealRequestToEditorRange(view.state.doc.toString(), request)
  if (!range) return
  view.dispatch({
    selection: { anchor: range.from, head: range.to },
    effects: EditorView.scrollIntoView(range.from, { y: 'center' }),
  })
  view.focus()
}

function refreshSearch(value: string, options: SearchOpt, selectFromCursor = true) {
  const view = viewRef.value
  currentQuery = value
  currentOptions = { ...options }
  currentMatches = view ? findSourceMatches(view.state.doc.toString(), value, options) : []
  currentMatchIndex = view && selectFromCursor
    ? firstSourceMatchAtOrAfter(currentMatches, view.state.selection.main.head)
    : Math.min(currentMatchIndex, currentMatches.length - 1)
  if (currentMatchIndex >= 0) selectSearchMatch(currentMatchIndex)
  else publishSearchResult()
}

function moveSearch(direction: 'next' | 'previous') {
  currentMatchIndex = stepSourceMatch(currentMatches, currentMatchIndex, direction)
  if (currentMatchIndex >= 0) selectSearchMatch(currentMatchIndex)
  else publishSearchResult()
}

function replaceSearchMatch(replacement: string) {
  const view = viewRef.value
  if (!view || !currentQuery) return
  currentMatches = findSourceMatches(view.state.doc.toString(), currentQuery, currentOptions)
  if (!currentMatches.length) { currentMatchIndex = -1; publishSearchResult(); return }

  if (replaceAllPending) {
    replaceAllPending = false
    view.dispatch({
      changes: currentMatches.map(match => ({ from: match.from, to: match.to, insert: replacement })),
    })
    refreshSearch(currentQuery, currentOptions, false)
    return
  }

  if (currentMatchIndex < 0 || currentMatchIndex >= currentMatches.length) {
    currentMatchIndex = firstSourceMatchAtOrAfter(currentMatches, view.state.selection.main.head)
  }
  const match = currentMatches[currentMatchIndex]
  if (!match) return
  view.dispatch({
    changes: { from: match.from, to: match.to, insert: replacement },
    selection: { anchor: match.from, head: match.from + replacement.length },
  })
  refreshSearch(currentQuery, currentOptions, false)
  currentMatchIndex = firstSourceMatchAtOrAfter(currentMatches, match.from + replacement.length)
  if (currentMatchIndex >= 0) selectSearchMatch(currentMatchIndex)
  else publishSearchResult()
}

function installBusHandlers() {
  busUnsubs.push(bus.on('undo', () => {
    if (isActive.value && editor.sourceCodeMode && viewRef.value) editor.usesSharedHistory ? editor.stepSharedHistory('undo') : undo(viewRef.value)
  }))
  busUnsubs.push(bus.on('redo', () => {
    if (isActive.value && editor.sourceCodeMode && viewRef.value) editor.usesSharedHistory ? editor.stepSharedHistory('redo') : redo(viewRef.value)
  }))
  busUnsubs.push(bus.on('selectAll', () => {
    if (isActive.value && editor.sourceCodeMode && viewRef.value) selectAll(viewRef.value)
  }))
  busUnsubs.push(bus.on('find', ({ value, opt }) => {
    if (isActive.value && editor.sourceCodeMode) refreshSearch(value, opt)
  }))
  busUnsubs.push(bus.on('findNext', () => {
    if (isActive.value && editor.sourceCodeMode) moveSearch('next')
  }))
  busUnsubs.push(bus.on('findPrev', () => {
    if (isActive.value && editor.sourceCodeMode) moveSearch('previous')
  }))
  busUnsubs.push(bus.on('find-action', action => {
    if (isActive.value && editor.sourceCodeMode && action === 'replaceAll') replaceAllPending = true
  }))
  busUnsubs.push(bus.on('replace', ({ value }) => {
    if (isActive.value && editor.sourceCodeMode) replaceSearchMatch(value)
  }))
  busUnsubs.push(bus.on('reveal-search-hit', (request) => {
    if (!isActive.value) return
    revealGuard = enqueueSearchReveal(revealGuard, request)
    tryRevealSearchHit()
  }))
}

onMounted(() => {
  mountView(editor.currentFile)
  installBusHandlers()
  busUnsubs.push(editor.registerInsertHandler('source', text => {
    const view = viewRef.value
    if (!view || boundId.value !== editor.currentFileId) throw new Error('agent:editorNotReady')
    const { from, to } = view.state.selection.main
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, annotations: isolateHistory.of('full') })
    view.focus()
  }))
  busUnsubs.push(editor.registerAgentEditHandler('source', markdown => {
    const view = viewRef.value
    if (!view || boundId.value !== editor.currentFileId) throw new Error('agent:editorNotReady')
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: markdown },
      annotations: [Transaction.userEvent.of('input.agent'), isolateHistory.of('full')],
    })
  }))
})

watch(
  () => editor.currentFileId,
  (id) => {
    if (!id) {
      persistBoundState()
      boundId.value = null
      const view = viewRef.value
      view?.contentDOM.blur()
      view?.setState(buildState(''))
      currentMatches = []
      currentMatchIndex = -1
      replaceAllPending = false
      tryRevealSearchHit()
      return
    }
    const tab = editor.tabs.find(t => t.id === id)
    if (tab && boundId.value !== id) {
      swapTab(tab)
      if (editor.sourceCodeMode && editor.findReplaceOpen && currentQuery) {
        refreshSearch(currentQuery, currentOptions)
      }
    }
    tryRevealSearchHit()
  },
)

watch(
  () => editor.sourceCodeMode,
  () => { tryRevealSearchHit() },
)

// External update (Muya saved, file reloaded) — sync into the view.
watch(
  () => editor.currentFile?.markdown,
  (md) => {
    if (md === undefined) return
    const view = viewRef.value
    if (!view) return
    if (md === view.state.doc.toString()) return
    if (!boundId.value) return
    const tab = editor.currentFile
    if (!tab || tab.id !== boundId.value) return
    const id = boundId.value
    boundId.value = null
    if (tab.sourceEditorState === null) {
      view.setState(buildState(md))
    } else {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: md },
        annotations: Transaction.addToHistory.of(false),
      })
    }
    boundId.value = id
    persistBoundState()
    if (editor.sourceCodeMode && editor.findReplaceOpen && currentQuery) {
      refreshSearch(currentQuery, currentOptions, false)
    }
  },
)

watch(
  () => editor.currentFile?.sourceSelection,
  selection => {
    const view = viewRef.value
    if (!view || !boundId.value || boundId.value !== editor.currentFileId) return
    const serialized = selection && typeof selection === 'object'
      ? selection as { ranges: Array<{ anchor: number; head: number }>; main: number }
      : { ranges: [{ anchor: 0, head: 0 }], main: 0 }
    try {
      const next = EditorSelection.fromJSON(serialized)
      if (JSON.stringify(view.state.selection.toJSON()) === JSON.stringify(next.toJSON())) return
      view.dispatch({ selection: next })
    } catch {
      view.dispatch({ selection: EditorSelection.cursor(0) })
    }
  },
  { deep: true, flush: 'post' },
)

onBeforeUnmount(() => {
  persistBoundState()
  for (const off of busUnsubs) { try { off() } catch { /* ignore */ } }
  busUnsubs.length = 0
  viewRef.value?.destroy()
  viewRef.value = null
})
</script>

<template>
  <div class="source-pane" data-editor-shortcut-scope="true">
    <div ref="hostRef" class="cm-host" />
  </div>
</template>

<style scoped>
.source-pane {
  flex: 1;
  display: flex;
  background: var(--mt-code-bg, #fafbfc);
  overflow: hidden;
}
.cm-host {
  flex: 1;
  overflow: auto;
  font-family: ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace;
  font-size: 13px;
  background: var(--mt-bg, #fff);
  color: var(--mt-fg, #24292e);
}
.cm-host :deep(.cm-editor) {
  height: 100%;
}
.cm-host :deep(.cm-scroller) {
  font-family: inherit;
  line-height: 1.6;
}
.cm-host :deep(.cm-gutters) {
  background: var(--mt-sidebar-bg, #fafbfc);
  border-right: 1px solid var(--mt-border, #eaecef);
  color: var(--mt-fg-muted, #959da5);
}
.cm-host :deep(.cm-activeLineGutter) {
  background: var(--mt-row-active, #f1f8ff);
  color: var(--mt-fg, #24292e);
}
.cm-host :deep(.cm-activeLine) {
  background: var(--mt-row-hover, #f6f8fa);
}
.cm-host :deep(.cm-content) {
  padding: 24px 0;
}
.cm-host :deep(.cm-line) { padding-inline: 12px 24px; }
</style>
