<script setup lang="ts">
/**
 * Sidebar — icon rail (44px) on the left, optional content panel on the
 * right. Clicking an active icon collapses to just-the-rail; clicking
 * another icon switches the panel.
 *
 * Resizing the panel is a drag on the right edge, tracked through
 * pointermove/pointerup.
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { Folder, ListTree, NotebookTabs, Search, Settings as Setting } from '@lucide/vue'
import { useLayoutStore, SIDEBAR_MIN, SIDEBAR_MAX, type RightColumn } from '@/stores/layout'
import { openSettings } from '@/services/tauri-invoke'
import { useI18n } from '@/i18n'
import TreePane from './TreePane.vue'
import TocPane from './TocPane.vue'
import SearchPane from './SearchPane.vue'
import NotebookPanel from '@/components/notebook/NotebookPanel.vue'

const layout = useLayoutStore()
const { t } = useI18n()

const panelWidth = computed(() => layout.sideBarWidth)
const KEYBOARD_RESIZE_STEP = 16

interface RailItem { key: RightColumn; icon: typeof Folder; titleKey: string }
const rails: RailItem[] = [
  { key: 'files', icon: Folder, titleKey: 'sideBar.files' },
  { key: 'toc', icon: ListTree, titleKey: 'sideBar.toc' },
  { key: 'search', icon: Search, titleKey: 'sideBar.search' },
  { key: 'notes', icon: NotebookTabs, titleKey: 'notes.panel' },
]

function switchTo(key: RightColumn) {
  if (layout.rightColumn === key) layout.setLayout({ rightColumn: '' })
  else layout.setLayout({ rightColumn: key })
}

/* ── resize drag ─────────────────────────────────────────────── */
const dragging = ref(false)
let stopResize: (() => void) | null = null

function endResize() {
  stopResize?.()
  stopResize = null
  dragging.value = false
}

function onResizeDown(ev: PointerEvent) {
  if (ev.button !== 0) return
  ev.preventDefault()
  endResize()
  dragging.value = true
  const start = ev.clientX
  const initial = layout.sideBarWidth
  const onMove = (m: PointerEvent) => layout.setSideBarWidth(initial + (m.clientX - start))
  const onUp = () => endResize()
  stopResize = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

function onResizeKeydown(ev: KeyboardEvent) {
  const step = ev.shiftKey ? KEYBOARD_RESIZE_STEP * 3 : KEYBOARD_RESIZE_STEP
  if (ev.key === 'ArrowLeft') {
    ev.preventDefault()
    layout.setSideBarWidth(layout.sideBarWidth - step)
  } else if (ev.key === 'ArrowRight') {
    ev.preventDefault()
    layout.setSideBarWidth(layout.sideBarWidth + step)
  } else if (ev.key === 'Home') {
    ev.preventDefault()
    layout.setSideBarWidth(SIDEBAR_MIN)
  } else if (ev.key === 'End') {
    ev.preventDefault()
    layout.setSideBarWidth(SIDEBAR_MAX)
  }
}

onBeforeUnmount(endResize)
</script>

<template>
  <aside id="editor-sidebar" class="side-bar">
    <div class="rail">
      <button
        v-for="item in rails"
        :key="item.key"
        type="button"
        class="rail-icon"
        :class="{ active: layout.rightColumn === item.key }"
        :title="t(item.titleKey)"
        :aria-label="t(item.titleKey)"
        :aria-pressed="layout.rightColumn === item.key"
        :aria-expanded="layout.rightColumn === item.key"
        :aria-controls="`${item.key}-sidebar-panel`"
        @click="switchTo(item.key)"
      >
        <component :is="item.icon" :size="16" :stroke-width="1.6" aria-hidden="true" />
      </button>
      <div class="spacer" />
      <button
        type="button"
        class="rail-icon"
        :title="t('sideBar.preferences')"
        :aria-label="t('sideBar.preferences')"
        @click="openSettings"
      >
        <Setting :size="16" :stroke-width="1.6" aria-hidden="true" />
      </button>
    </div>
    <div
      v-if="layout.rightColumn"
      :id="`${layout.rightColumn}-sidebar-panel`"
      class="panel"
      :style="{ width: panelWidth + 'px' }"
    >
      <TreePane v-if="layout.rightColumn === 'files'" />
      <TocPane v-else-if="layout.rightColumn === 'toc'" />
      <SearchPane v-else-if="layout.rightColumn === 'search'" />
      <NotebookPanel v-else-if="layout.rightColumn === 'notes'" />
      <div v-else class="placeholder" />
      <div
        class="resizer"
        :class="{ dragging }"
        role="separator"
        aria-orientation="vertical"
        :aria-label="`${t('sideBar.files')} · ${panelWidth}px`"
        :aria-valuemin="SIDEBAR_MIN"
        :aria-valuemax="SIDEBAR_MAX"
        :aria-valuenow="panelWidth"
        tabindex="0"
        @keydown="onResizeKeydown"
        @pointerdown="onResizeDown"
      />
    </div>
  </aside>
</template>

<style scoped>
.side-bar {
  display: flex;
  height: 100%;
  flex-shrink: 0;
  background: var(--mt-glass-bg);
}
.rail {
  box-sizing: border-box;
  width: 44px;
  flex-shrink: 0;
  background: transparent;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 7px 0;
  gap: 9px;
  border-right: 1px solid var(--mt-border);
}
.spacer { flex: 1; }
.rail-icon {
  box-sizing: border-box;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  position: relative;
  border: none;
  background: transparent;
  color: var(--mt-fg-muted);
  cursor: pointer;
  border-radius: var(--mt-radius-control);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color 120ms, color 120ms, box-shadow 120ms;
}
.rail-icon:hover {
  background: var(--mt-row-hover);
  color: var(--mt-fg);
}
.rail-icon.active {
  background: var(--mt-icon-active-bg);
  color: var(--mt-accent);
  box-shadow: none;
}
.rail-icon.active::before { content: ''; position: absolute; left: -6px; width: 2px; height: 16px; border-radius: 1px; background: var(--mt-accent); }
.rail-icon:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--mt-accent) 72%, transparent);
  outline-offset: 1px;
}

.panel {
  box-sizing: border-box;
  position: relative;
  max-width: max(184px, calc(100vw - 364px));
  border-right: 1px solid var(--mt-border);
  background: transparent;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.placeholder {
  padding: 24px 16px;
  color: var(--mt-fg-muted);
  font-size: 13px;
  text-align: center;
}
.resizer {
  position: absolute;
  right: -2px;
  top: 0;
  bottom: 0;
  width: 4px;
  cursor: ew-resize;
  background: transparent;
  z-index: 1;
}
.resizer:hover,
.resizer.dragging { background: var(--mt-accent); opacity: 0.4; }
.resizer:focus-visible {
  width: 5px;
  right: -3px;
  background: var(--mt-accent);
  opacity: 0.65;
  outline: none;
}
</style>
