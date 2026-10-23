<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue'
import { BookOpen, Link2, Pin, PinOff, Sparkles, X } from '@lucide/vue'
import NotebookPanel from '@/components/notebook/NotebookPanel.vue'
import { useLayoutStore, INSPECTOR_MAX, INSPECTOR_MIN, type InspectorPanel } from '@/stores/layout'
import { useAgentStore } from '@/stores/agent'
import { useI18n } from '@/i18n'
import { translateInspector, type InspectorMessageKey } from './inspector-i18n'

const layout = useLayoutStore()
const agent = useAgentStore()
const { locale } = useI18n()
const text = (key: Parameters<typeof translateInspector>[1]) => translateInspector(locale.value, key)
const activePanel = computed(() => layout.inspectorPanel)
const pinnedLinksVisible = computed(() => layout.linksPinned && activePanel.value !== 'links')
const panelTitle = computed(() => text(activePanel.value))
const KEYBOARD_RESIZE_STEP = 16
const NARROW_VIEWPORT_WIDTH = 1050
let narrowViewport = typeof window !== 'undefined' && window.innerWidth <= NARROW_VIEWPORT_WIDTH
if (narrowViewport) layout.showInspector = false

interface InspectorTab { key: InspectorPanel; icon: Component; label: InspectorMessageKey }
const tabs: InspectorTab[] = [
  { key: 'outline', icon: BookOpen, label: 'outline' },
  { key: 'links', icon: Link2, label: 'links' },
  { key: 'agent', icon: Sparkles, label: 'agent' },
]

function selectPanel(panel: InspectorPanel) {
  layout.showInspector = true
  layout.setInspectorPanel(panel)
}
function closeInspector() { layout.showInspector = false }
function togglePinnedLinks() {
  const next = !layout.linksPinned
  layout.setLinksPinned(next)
  if (next && layout.inspectorPanel === 'links') selectPanel('agent')
}

watch(() => [layout.showInspector, layout.inspectorPanel] as const, ([visible, panel]) => {
  const shouldShowAgent = visible && panel === 'agent'
  if (shouldShowAgent && !agent.visible) agent.toggle()
  else if (!shouldShowAgent && agent.visible) agent.visible = false
}, { immediate: true })
watch(() => agent.visible, visible => {
  if (visible) {
    layout.showInspector = true
    layout.setInspectorPanel('agent')
  } else if (layout.inspectorPanel === 'agent') {
    layout.setInspectorPanel(layout.linksPinned ? 'links' : 'outline')
  }
})

const dragging = ref(false)
let stopResize: (() => void) | null = null
function endResize() {
  stopResize?.()
  stopResize = null
  dragging.value = false
}
function onResizeDown(event: PointerEvent) {
  if (event.button !== 0) return
  event.preventDefault()
  endResize()
  dragging.value = true
  const start = event.clientX
  const initial = layout.inspectorWidth
  const move = (next: PointerEvent) => layout.setInspectorWidth(initial + start - next.clientX)
  const up = () => endResize()
  stopResize = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}
function onResizeKeydown(event: KeyboardEvent) {
  const step = event.shiftKey ? KEYBOARD_RESIZE_STEP * 3 : KEYBOARD_RESIZE_STEP
  if (event.key === 'ArrowLeft') { event.preventDefault(); layout.setInspectorWidth(layout.inspectorWidth + step) }
  else if (event.key === 'ArrowRight') { event.preventDefault(); layout.setInspectorWidth(layout.inspectorWidth - step) }
  else if (event.key === 'Home') { event.preventDefault(); layout.setInspectorWidth(INSPECTOR_MAX) }
  else if (event.key === 'End') { event.preventDefault(); layout.setInspectorWidth(INSPECTOR_MIN) }
}
function onViewportResize() {
  const nextNarrow = window.innerWidth <= NARROW_VIEWPORT_WIDTH
  if (nextNarrow && !narrowViewport) layout.showInspector = false
  narrowViewport = nextNarrow
}
onMounted(() => window.addEventListener('resize', onViewportResize))
onBeforeUnmount(() => {
  endResize()
  window.removeEventListener('resize', onViewportResize)
})
</script>

<template>
  <aside v-if="layout.showInspector" class="document-inspector" :style="{ width: `${layout.inspectorWidth}px` }" :aria-label="text('inspector')">
    <header class="inspector-header">
      <div class="inspector-tabs" role="tablist" aria-label="Document inspector">
        <button v-for="tab in tabs" :key="tab.key" type="button" role="tab" class="inspector-tab"
          :aria-selected="activePanel === tab.key" :aria-controls="`inspector-${tab.key}`"
          :title="text(tab.label)" :aria-label="text(tab.label)" @click="selectPanel(tab.key)">
          <component :is="tab.icon" :size="15" :stroke-width="1.8" aria-hidden="true" />
          <span>{{ text(tab.label) }}</span>
        </button>
      </div>
      <div class="header-actions">
        <button v-if="activePanel === 'links' || pinnedLinksVisible" type="button" class="icon-button"
          :aria-label="text(layout.linksPinned ? 'unpinLinks' : 'pinLinks')" :title="text(layout.linksPinned ? 'unpinLinks' : 'pinLinks')"
          :aria-pressed="layout.linksPinned" @click="togglePinnedLinks">
          <PinOff v-if="layout.linksPinned" :size="15" aria-hidden="true" />
          <Pin v-else :size="15" aria-hidden="true" />
        </button>
        <button type="button" class="icon-button" :aria-label="text('close')" :title="text('close')" @click="closeInspector">
          <X :size="16" aria-hidden="true" />
        </button>
      </div>
    </header>

    <div v-if="pinnedLinksVisible" class="inspector-split pinned-links">
      <section class="pinned-content" aria-label="Pinned links">
        <NotebookPanel />
      </section>
      <div class="split-divider" aria-hidden="true" />
      <section class="active-content">
        <slot v-if="activePanel === 'outline'" name="outline" />
        <slot v-else-if="activePanel === 'agent' && $slots.agent" name="agent" />
        <p v-else class="empty-slot">{{ text('emptyAgent') }}</p>
      </section>
    </div>
    <section v-else :id="`inspector-${activePanel}`" class="inspector-content" :aria-label="panelTitle">
      <slot v-if="activePanel === 'outline'" name="outline" />
      <NotebookPanel v-else-if="activePanel === 'links'" />
      <slot v-else-if="activePanel === 'agent' && $slots.agent" name="agent" />
      <p v-else-if="activePanel === 'agent'" class="empty-slot">{{ text('emptyAgent') }}</p>
    </section>

    <div class="inspector-resizer" :class="{ dragging }" role="separator" aria-orientation="vertical"
      aria-label="Resize document inspector" :aria-valuemin="INSPECTOR_MIN" :aria-valuemax="INSPECTOR_MAX"
      :aria-valuenow="layout.inspectorWidth" tabindex="0" @keydown="onResizeKeydown" @pointerdown="onResizeDown" />
  </aside>
  <aside v-else class="document-inspector-rail" :aria-label="text('inspector')">
    <button v-for="tab in tabs" :key="tab.key" type="button" class="rail-tab" :title="text(tab.label)" :aria-label="text(tab.label)"
      :aria-expanded="false" @click="selectPanel(tab.key)">
      <component :is="tab.icon" :size="16" :stroke-width="1.7" aria-hidden="true" />
    </button>
  </aside>
</template>

<style scoped>
.document-inspector { box-sizing: border-box; position: relative; display: flex; flex: 0 0 auto; flex-direction: column; min-width: 0; min-height: 0; height: 100%; overflow: hidden; border-left: 1px solid var(--mt-border); background: var(--mt-glass-bg); color: var(--mt-fg); }
.document-inspector-rail { box-sizing: border-box; display: flex; flex: 0 0 44px; flex-direction: column; align-items: center; gap: 8px; height: 100%; padding: 7px 0; border-left: 1px solid var(--mt-border); background: var(--mt-glass-bg); }
.rail-tab { display: grid; place-items: center; width: 32px; height: 32px; border: 0; border-radius: var(--mt-radius-control); background: transparent; color: var(--mt-fg-muted); cursor: pointer; }
.rail-tab:hover, .rail-tab:focus-visible { background: var(--mt-row-hover); color: var(--mt-accent); }
.rail-tab:focus-visible { outline: 2px solid var(--mt-accent); outline-offset: 1px; }
.inspector-header { display: flex; flex: 0 0 40px; align-items: center; justify-content: space-between; min-width: 0; border-bottom: 1px solid var(--mt-border); padding: 0 8px; gap: 4px; }
.inspector-tabs { display: flex; align-items: center; gap: 2px; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.inspector-tabs::-webkit-scrollbar { display: none; }
.inspector-tab, .icon-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 28px; padding: 0 8px; border: 0; border-radius: var(--mt-radius-control); background: transparent; color: var(--mt-fg-muted); cursor: pointer; white-space: nowrap; }
.inspector-tab { font: inherit; font-size: 12px; }
.inspector-tab[aria-selected="true"] { background: var(--mt-icon-active-bg); color: var(--mt-accent); }
.icon-button { width: 28px; flex: 0 0 28px; padding: 0; }
.icon-button:hover, .inspector-tab:hover { background: var(--mt-row-hover); color: var(--mt-fg); }
.header-actions { display: flex; flex: 0 0 auto; gap: 2px; }
.inspector-content { flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
.inspector-content :deep(> *) { height: 100%; min-height: 0; }
.inspector-split { flex: 1; display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.pinned-content { flex: 0 0 42%; min-height: 128px; overflow: hidden; }
.pinned-content > * { height: 100%; }
.split-divider { flex: 0 0 1px; background: var(--mt-border); }
.active-content { flex: 1; min-height: 0; overflow: hidden; }
.active-content :deep(> *) { height: 100%; min-height: 0; }
.document-inspector :deep(.agent-panel) { position: relative; inset: auto; flex: 1 1 auto; width: 100%; min-width: 0; max-width: 100%; min-height: 0; border-left: 0; box-shadow: none; }
.document-inspector :deep(.agent-resize) { display: none; }
.empty-slot { margin: 0; padding: 20px; text-align: center; color: var(--mt-fg-muted); font-size: 12px; }
.inspector-resizer { position: absolute; z-index: 2; left: -2px; top: 0; bottom: 0; width: 4px; cursor: ew-resize; background: transparent; }
.inspector-resizer:hover, .inspector-resizer.dragging { background: var(--mt-accent); opacity: .45; }
.inspector-resizer:focus-visible { width: 5px; left: -3px; background: var(--mt-accent); opacity: .7; outline: none; }
.inspector-tab:focus-visible, .icon-button:focus-visible { outline: 2px solid var(--mt-accent); outline-offset: -2px; }
@media (max-width: 1050px) {
  .document-inspector { position: fixed; z-index: 30; top: 32px; right: 0; bottom: 24px; height: auto; width: min(420px, calc(100vw - 48px)) !important; box-shadow: -12px 0 32px #0003; }
  .document-inspector :deep(.agent-panel) { position: relative; inset: auto; width: 100%; min-width: 0; max-width: 100%; box-shadow: none; }
  .document-inspector-rail { position: fixed; z-index: 29; top: 32px; right: 0; bottom: 24px; height: auto; box-shadow: -8px 0 24px #0002; }
}
@media (max-width: 540px) {
  .document-inspector { width: min(360px, calc(100vw - 36px)) !important; }
  .pinned-content { flex-basis: 46%; min-height: 112px; }
  .inspector-tab { padding-inline: 6px; }
  .inspector-tab span { display: none; }
}
</style>
