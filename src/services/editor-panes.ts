import { computed, onScopeDispose, reactive, watch } from 'vue'
import { useEditorStore } from '@/stores/editor'
import { forgetPaneViewState, getPaneViewState, paneViewStateGeneration, paneViewStateRevision, setPaneViewField } from '@/services/pane-view-state'
import type { DocumentState } from '@/stores/help'

// Components retain the existing editor contract. Only view identity is local;
// document mutations, saves and Agent access continue through the shared store.
export function usePaneEditor(paneId: string) {
  const store = useEditorStore()
  const pane = computed(() => store.panes.find(p => p.id === paneId))
  const views = reactive(new Map<string, { sourceEditorState?: unknown }>())
  const viewGenerations = new Map<string, number>()
  const muya = { value: null as unknown }
  const viewFor = (tabId: string) => {
    const generation = paneViewStateGeneration(tabId)
    if (viewGenerations.get(tabId) !== generation) {
      views.delete(tabId)
      viewGenerations.set(tabId, generation)
    }
    return views.get(tabId)
  }
  const localTab = (tab: DocumentState) => new Proxy(tab, {
    get(target, key) {
      if (['cursor', 'sourceSelection', 'sourceEditorState'].includes(String(key))) {
        const stored = Reflect.get(target, key)
        if (key === 'cursor' || key === 'sourceSelection') {
          void paneViewStateRevision.value
          const view = getPaneViewState(paneId, tab.id)
          if (view && Object.prototype.hasOwnProperty.call(view, key)) return view[key]
          return stored
        }
        // A disk reload/session restore deliberately clears CodeMirror's
        // history state and invalidates every pane's cached copy.
        if (stored === null) return null
        const view = viewFor(tab.id)
        if (view && Object.prototype.hasOwnProperty.call(view, key)) return view.sourceEditorState
        return stored
      }
      return Reflect.get(target, key)
    },
    set(target, key, value) {
      if (key === 'cursor' || key === 'sourceSelection') {
        setPaneViewField(paneId, tab.id, key, value)
        if (store.activePaneId === paneId) Reflect.set(target, key, value)
        return true
      }
      if (key === 'sourceEditorState') {
        const view = viewFor(tab.id) ?? {}; Reflect.set(view, key, value); views.set(tab.id, view)
        if (store.activePaneId === paneId) Reflect.set(target, key, value)
        return true
      }
      return Reflect.set(target, key, value)
    },
  })
  const activate = () => {
    store.activatePane(paneId)
    if (store.activePaneId !== paneId) return
    // The target pane's WYSIWYG instance is still useful for exports while
    // source mode is visible; the active-pane check keeps hidden other panes out.
    if (muya.value) store.setMuyaInstance(muya.value)
  }
  watch(() => store.activePaneId, id => {
    if (id !== paneId) {
      const tab = store.tabs.find(candidate => candidate.id === pane.value?.documentId)
      const instance = muya.value as { getCursor?: () => unknown } | null
      if (tab && !pane.value?.sourceMode && instance?.getCursor) {
        try { localTab(tab).cursor = instance.getCursor() } catch { /* editor is tearing down */ }
      }
      return
    }
    if (muya.value) store.setMuyaInstance(muya.value)
    const tab = store.tabs.find(t => t.id === pane.value?.documentId)
    const view = tab ? viewFor(tab.id) : undefined
    const instance = muya.value as { getCursor?: () => unknown; setCursor?: (cursor: unknown) => void } | null
    if (tab) {
      const paneView = getPaneViewState(paneId, tab.id)
      if (paneView && Object.prototype.hasOwnProperty.call(paneView, 'cursor')) {
        const cursor = paneView.cursor ?? { anchor: { line: 0, ch: 0 }, focus: { line: 0, ch: 0 } }
        try { instance?.setCursor?.(cursor) } catch { /* stale caret is ignored */ }
        Reflect.set(tab, 'cursor', paneView.cursor)
      } else if (instance?.getCursor) {
        try { localTab(tab).cursor = instance.getCursor() } catch { /* editor is tearing down */ }
      }
      if (paneView && Object.prototype.hasOwnProperty.call(paneView, 'sourceSelection')) Reflect.set(tab, 'sourceSelection', paneView.sourceSelection)
      if (view && Object.prototype.hasOwnProperty.call(view, 'sourceEditorState')) Reflect.set(tab, 'sourceEditorState', view.sourceEditorState)
    }
  }, { flush: 'sync' })
  const editor = new Proxy(store, {
    get(target, key) {
      if (key === 'currentFileId') return pane.value?.documentId ?? null
      if (key === 'currentFile') { const tab = store.tabs.find(t => t.id === pane.value?.documentId); return tab ? localTab(tab) : null }
      if (key === 'tabs') return store.tabs.map(localTab)
      if (key === 'sourceCodeMode') return pane.value?.sourceMode ?? false
      if (key === 'setMuyaInstance') return (instance: unknown) => { muya.value = instance; if (store.activePaneId === paneId) store.setMuyaInstance(instance) }
      if (key === 'clearMuyaInstance') return () => { muya.value = null; if (store.activePaneId === paneId) store.clearMuyaInstance() }
      if (key === 'applyContentChange') return (id: string, markdown: string, payload?: Parameters<typeof store.applyContentChange>[2]) => {
        // Both engines stay mounted. A delayed hidden Muya baseline must not
        // replace a newer edit in the visible source editor.
        if (pane.value?.sourceMode) return
        const tab = store.tabs.find(candidate => candidate.id === id)
        const active = store.activePaneId === paneId
        if (tab && payload?.cursor !== undefined) localTab(tab).cursor = payload.cursor
        // An asynchronous Muya update can finish after another pane became
        // active. Keep its document edit, but do not replace the new pane's
        // session cursor with the old view's coordinates.
        const forwarded = !active && payload ? { ...payload, cursor: undefined } : payload
        return store.applyContentChange(id, markdown, forwarded)
      }
      if (key === 'registerAgentEditHandler') return (mode: 'source' | 'wysiwyg', handler: (markdown: string) => void) => store.registerAgentEditHandler(mode, handler, paneId)
      if (key === 'registerInsertHandler') return (mode: 'source' | 'wysiwyg', handler: (text: string) => void | Promise<void>) => store.registerInsertHandler(mode, handler, paneId)
      if (key === 'setSelectionFormats') return (formats: string[]) => { if (store.activePaneId === paneId) store.setSelectionFormats(formats) }
      return Reflect.get(target, key)
    },
  })
  onScopeDispose(() => {
    if (!store.panes.some(candidate => candidate.id === paneId)) forgetPaneViewState(paneId)
  })
  return { editor, activate, isActive: computed(() => store.activePaneId === paneId) }
}
