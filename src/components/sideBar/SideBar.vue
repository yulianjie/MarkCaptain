<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { Folder, Search, Settings as Setting } from '@lucide/vue'
import { SIDEBAR_MAX, SIDEBAR_MIN, useLayoutStore, type NavigationPanel } from '@/stores/layout'
import { openSettings } from '@/services/tauri-invoke'
import { useI18n } from '@/i18n'
import TreePane from './TreePane.vue'
import SearchPane from './SearchPane.vue'

const layout = useLayoutStore()
const { t } = useI18n()
const panelWidth = computed(() => layout.sideBarWidth)
const KEYBOARD_RESIZE_STEP = 16

interface RailItem { key: NavigationPanel; icon: typeof Folder; titleKey: string }
const rails: RailItem[] = [
  { key: 'files', icon: Folder, titleKey: 'sideBar.files' },
  { key: 'search', icon: Search, titleKey: 'sideBar.search' },
]

function switchTo(key: NavigationPanel) {
  layout.setNavigationPanel(layout.navigationPanel === key ? '' : key)
}

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
  const initial = layout.sideBarWidth
  const move = (next: PointerEvent) => layout.setSideBarWidth(initial + next.clientX - start)
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
  if (event.key === 'ArrowLeft') { event.preventDefault(); layout.setSideBarWidth(layout.sideBarWidth - step) }
  else if (event.key === 'ArrowRight') { event.preventDefault(); layout.setSideBarWidth(layout.sideBarWidth + step) }
  else if (event.key === 'Home') { event.preventDefault(); layout.setSideBarWidth(SIDEBAR_MIN) }
  else if (event.key === 'End') { event.preventDefault(); layout.setSideBarWidth(SIDEBAR_MAX) }
}
onBeforeUnmount(endResize)
</script>

<template>
  <aside id="editor-sidebar" class="side-bar" :class="{ collapsed: !layout.navigationPanel }">
    <div class="rail">
      <button
        v-for="item in rails"
        :key="item.key"
        type="button"
        class="rail-icon"
        :class="{ active: layout.navigationPanel === item.key }"
        :title="t(item.titleKey)"
        :aria-label="t(item.titleKey)"
        :aria-pressed="layout.navigationPanel === item.key"
        :aria-expanded="layout.navigationPanel === item.key"
        :aria-controls="`navigation-${item.key}-panel`"
        @click="switchTo(item.key)"
      >
        <component :is="item.icon" :size="16" :stroke-width="1.6" aria-hidden="true" />
      </button>
      <div class="spacer" />
      <button type="button" class="rail-icon" :title="t('sideBar.preferences')" :aria-label="t('sideBar.preferences')" @click="openSettings">
        <Setting :size="16" :stroke-width="1.6" aria-hidden="true" />
      </button>
    </div>
    <div v-if="layout.navigationPanel" :id="`navigation-${layout.navigationPanel}-panel`" class="panel" :style="{ width: panelWidth + 'px' }">
      <TreePane v-if="layout.navigationPanel === 'files'" />
      <SearchPane v-else-if="layout.navigationPanel === 'search'" />
      <div class="resizer" :class="{ dragging }" role="separator" aria-orientation="vertical"
        :aria-label="`${t('sideBar.files')} · ${panelWidth}px`" :aria-valuemin="SIDEBAR_MIN" :aria-valuemax="SIDEBAR_MAX"
        :aria-valuenow="panelWidth" tabindex="0" @keydown="onResizeKeydown" @pointerdown="onResizeDown" />
    </div>
  </aside>
</template>

<style scoped>
.side-bar { display: flex; height: 100%; flex-shrink: 0; background: var(--mt-glass-bg); }
.rail { box-sizing: border-box; width: 44px; flex-shrink: 0; background: transparent; display: flex; flex-direction: column; align-items: center; padding: 7px 0; gap: 9px; border-right: 1px solid var(--mt-border); }
.spacer { flex: 1; }
.rail-icon { box-sizing: border-box; width: 32px; height: 32px; flex-shrink: 0; position: relative; border: none; background: transparent; color: var(--mt-fg-muted); cursor: pointer; border-radius: var(--mt-radius-control); display: flex; align-items: center; justify-content: center; transition: background-color 120ms, color 120ms; }
.rail-icon:hover { background: var(--mt-row-hover); color: var(--mt-fg); }
.rail-icon.active { background: var(--mt-icon-active-bg); color: var(--mt-accent); }
.rail-icon.active::before { content: ''; position: absolute; left: -6px; width: 2px; height: 16px; border-radius: 1px; background: var(--mt-accent); }
.rail-icon:focus-visible { outline: 2px solid color-mix(in srgb, var(--mt-accent) 72%, transparent); outline-offset: 1px; }
.panel { box-sizing: border-box; position: relative; max-width: max(184px, calc(100vw - 364px)); border-right: 1px solid var(--mt-border); background: transparent; overflow: hidden; display: flex; flex-direction: column; }
.resizer { position: absolute; right: -2px; top: 0; bottom: 0; width: 4px; cursor: ew-resize; background: transparent; z-index: 1; }
.resizer:hover, .resizer.dragging { background: var(--mt-accent); opacity: .4; }
.resizer:focus-visible { width: 5px; right: -3px; background: var(--mt-accent); opacity: .65; outline: none; }
</style>
