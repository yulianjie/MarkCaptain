<script setup lang="ts">
import { onBeforeUnmount, watch } from 'vue'
import MuyaEditor from '@/components/editorWithTabs/MuyaEditor.vue'
import SourceCodePane from '@/components/editorWithTabs/SourceCodePane.vue'
import { useEditorStore } from '@/stores/editor'
import { t } from '@/i18n'
import { createPaneLayoutSnapshot, normalizePaneViewState, parsePaneLayout, resolvePaneDocumentId } from '@/services/pane-layouts'
import { getPaneViewState, paneViewStateRevision, restorePaneViewState } from '@/services/pane-view-state'
import { CodeXml, X } from '@lucide/vue'
const props = defineProps<{ restoredSessionTabIdsByIndex?: Record<number, string> }>()
const editor = useEditorStore()
let initialLayout: ReturnType<typeof parsePaneLayout> = null
try { initialLayout = parsePaneLayout(JSON.parse(localStorage.getItem('mt:panes') ?? 'null')) } catch { /* invalid saved preference */ }
watch(() => editor.startupHydrationPending, pending => {
  if (pending || !initialLayout) return
  const layout = initialLayout; initialLayout = null
  const activeDocument = editor.currentFileId
  const restoredPanes = layout.panes.map((p,i) => ({
    id: i === 0 ? 'main' : crypto.randomUUID(),
    documentId: resolvePaneDocumentId(p, activeDocument, props.restoredSessionTabIdsByIndex ?? {}, path => editor.findTabByPath(path)?.id ?? null),
    sourceMode: p.sourceMode,
  }))
  for (const [i, saved] of layout.panes.entries()) {
    const pane = restoredPanes[i]!
    const tab = editor.tabs.find(candidate => candidate.id === pane.documentId)
    if (!tab) continue
    const state: { cursor?: unknown | null; sourceSelection?: unknown | null } = {}
    if (Object.prototype.hasOwnProperty.call(saved, 'cursor')) state.cursor = saved.cursor
    if (Object.prototype.hasOwnProperty.call(saved, 'sourceSelection')) state.sourceSelection = saved.sourceSelection
    if (Object.keys(state).length) restorePaneViewState(pane.id, tab.id, normalizePaneViewState(tab.markdown, state))
  }
  editor.panes = restoredPanes
  editor.splitDirection = layout.direction; editor.splitRatio = layout.ratio
  editor.paneSizes = Object.fromEntries(editor.panes.map((p,i) => [p.id, layout.sizes?.[i] ?? 1 / editor.panes.length]))
  editor.activePaneId = ''; editor.activatePane(editor.panes[layout.activeIndex ?? 0].id)
}, { flush: 'post' })
let stop: (() => void) | undefined
function resize(event: PointerEvent, index: number) {
  const host = (event.currentTarget as HTMLElement).parentElement!
  const rect = host.getBoundingClientRect(); const horizontal = editor.splitDirection === 'horizontal'
  const regions = [...host.querySelectorAll(':scope > .editing-region')].map(e => e.getBoundingClientRect())
  const left = regions[index]; const right = regions[index + 1]
  const start = horizontal ? left.left : left.top; const finish = horizontal ? right.right : right.bottom
  const initialSizes = regions.map(r => horizontal ? r.width / rect.width : r.height / rect.height)
  const move = (e: PointerEvent) => {
    const ratio = Math.max(.15, Math.min(.85, ((horizontal ? e.clientX : e.clientY) - start) / (finish - start)))
    if (editor.panes.length === 2) editor.splitRatio = ratio
    else { const total = initialSizes[index] + initialSizes[index + 1]; editor.paneSizes = Object.fromEntries(editor.panes.map((p,i) => [p.id, i === index ? total * ratio : i === index + 1 ? total * (1 - ratio) : initialSizes[i]])) }
  }
  const end = () => { stop?.(); stop = undefined }
  stop?.(); stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end) }
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', end)
}
function key(event: KeyboardEvent) {
  if (editor.fileMutationBusy) { event.preventDefault(); event.stopImmediatePropagation(); return }
  if (event.isComposing || !editor.usesSharedHistory || !event.target || !(event.target as Element).closest('[data-editor-shortcut-scope]')) return
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return
  if (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y') {
    event.preventDefault(); event.stopPropagation()
    editor.stepSharedHistory(event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo')
  }
}
function resizeKey(index: number, direction: number) {
  if (editor.panes.length === 2) { editor.splitRatio = Math.max(.15, Math.min(.85, editor.splitRatio + direction * .05)); return }
  const left = editor.panes[index].id; const right = editor.panes[index + 1].id
  const a = editor.paneSizes[left] ?? 1 / editor.panes.length; const b = editor.paneSizes[right] ?? 1 / editor.panes.length
  const total = a + b; const ratio = Math.max(.15, Math.min(.85, a / total + direction * .05))
  editor.paneSizes[left] = total * ratio; editor.paneSizes[right] = total * (1 - ratio)
}
// UI layout has its own version; the existing draft/session payload stays untouched.
let layoutPersistTimer: ReturnType<typeof setTimeout> | undefined
function persistPaneLayout() {
  if (editor.startupHydrationPending) return
  const snapshot = createPaneLayoutSnapshot(
    editor.splitDirection,
    editor.splitRatio,
    editor.panes.findIndex(p => p.id === editor.activePaneId),
    editor.sessionPanes,
    editor.paneSizes,
    editor.tabs,
    getPaneViewState,
  )
  try { localStorage.setItem('mt:panes', JSON.stringify(snapshot)) } catch { /* storage unavailable */ }
}
watch(() => [editor.sessionPanes, editor.activePaneId, editor.paneSizes, editor.splitDirection, editor.splitRatio,
  editor.tabs.map(t => [t.id, t.pathname, t.markdown]), paneViewStateRevision.value], () => {
  if (editor.startupHydrationPending) return
  if (layoutPersistTimer) clearTimeout(layoutPersistTimer)
  layoutPersistTimer = setTimeout(() => { layoutPersistTimer = undefined; persistPaneLayout() }, 180)
}, { deep: true })
onBeforeUnmount(() => {
  stop?.()
  if (layoutPersistTimer) clearTimeout(layoutPersistTimer)
  layoutPersistTimer = undefined
  persistPaneLayout()
})
</script>
<template>
  <div class="editor-panes" :class="[editor.splitDirection, { 'has-multiple-panes': editor.panes.length > 1 }]" :inert="editor.fileMutationBusy" @keydown.capture="key">
    <template v-for="(pane, index) in editor.panes" :key="pane.id">
      <section class="editing-region" :class="{ active: editor.activePaneId === pane.id }" :style="{ flex: editor.panes.length === 2 ? index === 0 ? editor.splitRatio : 1 - editor.splitRatio : editor.paneSizes[pane.id] ?? 1 }" @pointerdown.capture="editor.activatePane(pane.id)" @focusin.capture="editor.activatePane(pane.id)">
        <header v-if="editor.panes.length > 1">
          <select :value="pane.documentId ?? ''" :aria-label="t('notes.paneDocument')" @change="editor.activatePane(pane.id); editor.setCurrent(($event.target as HTMLSelectElement).value || null)">
            <option value="">{{ t('notes.none') }}</option><option v-for="tab in editor.tabs" :key="tab.id" :value="tab.id">{{ tab.isSaved ? '' : '● ' }}{{ tab.pathname || tab.filename }}</option>
          </select>
          <button :title="t('notes.source')" :aria-label="t('notes.source')" :aria-pressed="pane.sourceMode" @click="editor.activatePane(pane.id); editor.toggleSourceCode()"><CodeXml :size="14" aria-hidden="true" /></button>
          <button :title="t('notes.closePane')" :aria-label="t('notes.closePane')" @click="editor.closePane(pane.id)"><X :size="14" aria-hidden="true" /></button>
        </header>
        <MuyaEditor :pane-id="pane.id" v-show="pane.documentId && !pane.sourceMode" />
        <SourceCodePane :pane-id="pane.id" v-show="pane.documentId && pane.sourceMode" />
      </section>
      <div v-if="index < editor.panes.length - 1" class="pane-resizer" role="separator" tabindex="0" :aria-label="t('notes.resize')" :aria-orientation="editor.splitDirection === 'horizontal' ? 'vertical' : 'horizontal'" :aria-valuenow="Math.round(editor.splitRatio * 100)" :aria-valuemin="15" :aria-valuemax="85" @pointerdown.prevent="resize($event, index)" @keydown.left.prevent="resizeKey(index, -1)" @keydown.right.prevent="resizeKey(index, 1)" @keydown.up.prevent="resizeKey(index, -1)" @keydown.down.prevent="resizeKey(index, 1)" />
    </template>
  </div>
</template>
<style scoped>
.editor-panes { display: flex; flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
.editor-panes.vertical { flex-direction: column; }
.editing-region { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.has-multiple-panes .editing-region.active > header { box-shadow: inset 0 -2px var(--mt-accent); background: var(--mt-bg); }
header { display: flex; align-items: center; gap: 5px; flex: 0 0 39px; min-height: 0; padding: 0 9px; background: var(--mt-surface); border-bottom: 1px solid var(--mt-border); }
select { min-width: 0; flex: 1; height: 28px; padding: 0 4px; border: 0; border-radius: 5px; background: transparent; color: var(--mt-fg-muted); font: 11px var(--mt-ui-font); text-overflow: ellipsis; }
.active select { color: var(--mt-fg); }
button { display: grid; place-items: center; width: 26px; height: 26px; flex-shrink: 0; padding: 0; border: 0; border-radius: 5px; color: var(--mt-fg-muted); background: transparent; cursor: pointer; }
button:hover { background: var(--mt-row-hover); color: var(--mt-fg); }
button[aria-pressed=true] { color: var(--mt-accent); background: var(--mt-accent-soft); }
button:focus-visible, select:focus-visible { outline: 2px solid var(--mt-accent); outline-offset: 1px; }
.pane-resizer { position: relative; flex: 0 0 5px; cursor: col-resize; background: var(--mt-surface); border-inline: 1px solid var(--mt-border-subtle); }
.pane-resizer:hover, .pane-resizer:focus-visible { background: var(--mt-accent-soft); outline: 0; }
.pane-resizer:focus-visible::after, .pane-resizer:hover::after { content: ''; position: absolute; inset: 0 1px; background: var(--mt-accent); border-radius: 2px; }
.vertical .pane-resizer { cursor: row-resize; }
.vertical .pane-resizer:focus-visible::after, .vertical .pane-resizer:hover::after { inset: 1px 0; }
</style>
