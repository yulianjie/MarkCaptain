<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ChevronsUpDown, Folder, Home, PanelLeftClose, Plus, Search, Settings as Setting } from '@lucide/vue'
import { INSPECTOR_MAX, SIDEBAR_MIN, useLayoutStore, type NavigationPanel } from '@/stores/layout'
import { usePanelDrawer } from '@/components/documentInspector/use-panel-drawer'
import { openFolder, openSettings } from '@/services/tauri-invoke'
import { useI18n } from '@/i18n'
import { useProjectStore } from '@/stores/project'
import { useEditorStore } from '@/stores/editor'
import { useWorkspaceCopy } from '@/components/welcome/workspace-copy'
import { bus } from '@/bus'
import TreePane from './TreePane.vue'
import SearchPane from './SearchPane.vue'

const layout = useLayoutStore()
const project = useProjectStore()
const editor = useEditorStore()
const copy = useWorkspaceCopy()
const emit = defineEmits<{ home: []; opened: [] }>()
function onNavigationClick(event: Event) {
  if (event instanceof KeyboardEvent && event.target instanceof Element && event.target.closest('button, input')) return
  if (event.target instanceof Element && event.target.closest('[role="listitem"], .row.file, .hit')) {
    emit('opened')
    if (window.innerWidth <= 900) layout.setNavigationPanel('')
  }
}
const { t } = useI18n()
const viewportWidth = ref(typeof window === 'undefined' ? 1440 : window.innerWidth)
const drawerElement = ref<HTMLElement | null>(null)
const closeNavigationDrawer = usePanelDrawer({
  active: computed(() => viewportWidth.value <= 900 && Boolean(layout.navigationPanel)),
  element: drawerElement,
  close: () => layout.setNavigationPanel(''),
  fallback: () => document.querySelector<HTMLElement>('.sidebar-toggle'),
})
const inspectorSpace = computed(() => viewportWidth.value <= 1180 || !layout.showInspector ? 44
  : Math.min(layout.inspectorWidth, INSPECTOR_MAX, Math.floor(viewportWidth.value * .38)))
const panelMaxWidth = computed(() => Math.max(SIDEBAR_MIN + 44,
  viewportWidth.value <= 900 ? viewportWidth.value - 84 : Math.min(viewportWidth.value <= 1180 ? 300 : 380, viewportWidth.value - 481 - inspectorSpace.value)))
const panelMinWidth = computed(() => Math.min(SIDEBAR_MIN + 44, panelMaxWidth.value))
const panelWidth = computed(() => Math.min(layout.sideBarWidth + 44, panelMaxWidth.value))
function setVisibleWidth(width: number) {
  layout.setSideBarWidth(Math.max(panelMinWidth.value, Math.min(width, panelMaxWidth.value)) - 44)
}
const KEYBOARD_RESIZE_STEP = 16
async function pickWorkspace() {
  const path = await openFolder()
  if (path) await project.openRoot(path)
}

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
  const initial = panelWidth.value
  const move = (next: PointerEvent) => setVisibleWidth(initial + next.clientX - start)
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
  if (event.key === 'ArrowLeft') { event.preventDefault(); setVisibleWidth(panelWidth.value - step) }
  else if (event.key === 'ArrowRight') { event.preventDefault(); setVisibleWidth(panelWidth.value + step) }
  else if (event.key === 'Home') { event.preventDefault(); setVisibleWidth(panelMinWidth.value) }
  else if (event.key === 'End') { event.preventDefault(); setVisibleWidth(panelMaxWidth.value) }
}
let narrowViewport = false
function onViewportResize() {
  viewportWidth.value = window.innerWidth
  const nextNarrow = window.innerWidth <= 900
  if (nextNarrow && !narrowViewport) layout.setNavigationPanel('')
  narrowViewport = nextNarrow
}
onMounted(() => { onViewportResize(); window.addEventListener('resize', onViewportResize) })
onBeforeUnmount(() => { endResize(); window.removeEventListener('resize', onViewportResize) })
</script>

<template>
  <button v-if="layout.navigationPanel" type="button" class="navigation-backdrop" :aria-label="copy.closeNavigation" @click="closeNavigationDrawer" />
  <aside id="editor-sidebar" class="side-bar" :class="{ collapsed: !layout.navigationPanel }" :style="{ '--navigation-width': `${panelWidth}px` }">
    <div v-if="!layout.navigationPanel" class="rail">
      <button type="button" class="rail-icon" :title="copy.start" :aria-label="copy.start" @click="$emit('home')"><Home :size="16" /></button>
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
    <div v-if="layout.navigationPanel" :id="`navigation-${layout.navigationPanel}-panel`" ref="drawerElement" class="panel" tabindex="-1"
      :role="viewportWidth <= 900 ? 'dialog' : undefined" :aria-modal="viewportWidth <= 900 ? true : undefined" :aria-label="copy.workspace">
      <header class="workspace-header">
        <button type="button" class="workspace-picker" :title="project.projectTree?.pathname || t('sideBar.openFolder')" @click="pickWorkspace">
          <span class="workspace-mark"><Folder :size="18" :stroke-width="1.5" /></span>
          <span class="workspace-name"><strong>{{ project.projectTree?.name || copy.workspace }}</strong><small>{{ project.projectTree ? t(`sideBar.storageMode.${project.storageMode}`) : copy.localWorkspace }}</small></span>
          <ChevronsUpDown :size="13" :stroke-width="1.5" />
        </button>
        <button type="button" class="collapse-navigation" :title="copy.closeNavigation" :aria-label="copy.closeNavigation" @click="closeNavigationDrawer"><PanelLeftClose :size="15" /></button>
      </header>
      <button type="button" class="command-search" @click="bus.emit('show-command-palette', undefined)"><Search :size="14" /><span>{{ copy.commands }}</span></button>
      <nav class="navigation-tabs" :aria-label="copy.workspace">
        <button type="button" :title="copy.start" :aria-label="copy.start" @click="$emit('home')"><Home :size="15" /><span>{{ copy.start }}</span></button>
        <button v-for="item in rails" :key="item.key" type="button" :class="{ active: layout.navigationPanel === item.key }" :aria-pressed="layout.navigationPanel === item.key" @click="layout.setNavigationPanel(item.key)"><component :is="item.icon" :size="15" /><span>{{ t(item.titleKey) }}</span></button>
      </nav>
      <div class="navigation-content" @click="onNavigationClick" @keydown.enter="onNavigationClick" @keydown.space="onNavigationClick">
        <TreePane v-if="layout.navigationPanel === 'files'" />
        <SearchPane v-else-if="layout.navigationPanel === 'search'" />
      </div>
      <footer class="navigation-footer">
        <button type="button" :title="t('sideBar.preferences')" @click="openSettings"><Setting :size="15" /><span>{{ t('sideBar.preferences') }}</span></button>
        <button type="button" :title="copy.newDocument" :aria-label="copy.newDocument" @click="editor.newUntitledTab()"><Plus :size="16" /></button>
      </footer>
      <div class="resizer" :class="{ dragging }" role="separator" aria-orientation="vertical"
        :aria-label="`${t('sideBar.files')} · ${panelWidth}px`" :aria-valuemin="panelMinWidth" :aria-valuemax="panelMaxWidth"
        :aria-valuenow="panelWidth" tabindex="0" @keydown="onResizeKeydown" @pointerdown="onResizeDown" />
    </div>
  </aside>
</template>

<style scoped>
.side-bar { display: flex; height: 100%; flex-shrink: 0; background: var(--mt-sidebar-bg); color: var(--mt-fg); border-right: 1px solid var(--mt-border); }
.rail { box-sizing: border-box; width: 44px; flex-shrink: 0; background: transparent; display: flex; flex-direction: column; align-items: center; padding: 7px 0; gap: 9px; border-right: 1px solid var(--mt-border); }
.spacer { flex: 1; }
.rail-icon { box-sizing: border-box; width: 32px; height: 32px; flex-shrink: 0; position: relative; border: none; background: transparent; color: var(--mt-fg-muted); cursor: pointer; border-radius: var(--mt-radius-control); display: flex; align-items: center; justify-content: center; transition: background-color 120ms, color 120ms; }
.rail-icon:hover { background: var(--mt-row-hover); color: var(--mt-fg); }
.rail-icon.active { background: var(--mt-icon-active-bg); color: var(--mt-accent); }
.rail-icon.active::before { content: ''; position: absolute; left: -6px; width: 2px; height: 16px; border-radius: 1px; background: var(--mt-accent); }
.rail-icon:focus-visible { outline: 2px solid color-mix(in srgb, var(--mt-accent) 72%, transparent); outline-offset: 1px; }
.panel { box-sizing: border-box; position: relative; width: var(--navigation-width); min-width: 0; background: transparent; overflow: hidden; display: flex; flex-direction: column; }
.workspace-header { display: flex; align-items: center; gap: 4px; padding: 19px 12px 15px 16px; flex-shrink: 0; }
.workspace-picker { display: flex; align-items: center; flex: 1; min-width: 0; gap: 10px; padding: 0; border: 0; background: transparent; color: var(--mt-fg); font: inherit; text-align: left; cursor: pointer; }
.workspace-mark { display: grid; place-items: center; width: 34px; height: 36px; flex-shrink: 0; border-radius: 8px; color: var(--mt-accent); background: var(--mt-accent-soft, var(--mt-icon-active-bg)); }
.workspace-name { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 5px; }
.workspace-name strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
.workspace-name small { color: var(--mt-fg-muted); font-size: 10px; }
.collapse-navigation { display: grid; place-items: center; width: 26px; height: 28px; padding: 0; border: 0; border-radius: 5px; color: var(--mt-fg-muted); background: transparent; cursor: pointer; }
.collapse-navigation:hover { background: var(--mt-row-hover); }
.command-search { display: flex; align-items: center; gap: 8px; min-height: 33px; padding: 0 10px; margin: 0 15px 14px; border: 1px solid var(--mt-border); border-radius: 6px; background: var(--mt-bg); color: var(--mt-fg-muted); font: inherit; font-size: 11px; text-align: left; cursor: pointer; flex-shrink: 0; }
.command-search:hover { color: var(--mt-fg); border-color: color-mix(in srgb, var(--mt-accent) 40%, var(--mt-border)); }
.navigation-tabs { display: flex; gap: 3px; padding: 0 13px 13px; border-bottom: 1px solid var(--mt-border); flex-shrink: 0; }
.navigation-tabs button { display: flex; align-items: center; justify-content: center; flex: 1; min-width: 0; gap: 6px; padding: 7px 5px; border: 0; border-radius: 6px; background: transparent; color: var(--mt-fg-muted); font: inherit; font-size: 11px; cursor: pointer; }
.navigation-tabs button:hover { background: var(--mt-row-hover); color: var(--mt-fg); }
.navigation-tabs button.active { background: var(--mt-accent-soft, var(--mt-icon-active-bg)); color: var(--mt-accent); }
.navigation-content { flex: 1; min-height: 0; overflow: hidden; }
.navigation-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 15px; border-top: 1px solid var(--mt-border); flex-shrink: 0; }
.navigation-footer button { display: inline-flex; align-items: center; gap: 8px; padding: 5px; border: 0; border-radius: 5px; background: transparent; color: var(--mt-fg-muted); font: inherit; font-size: 11px; cursor: pointer; }
.navigation-footer button:hover { background: var(--mt-row-hover); color: var(--mt-fg); }
.panel button:focus-visible { outline: 2px solid var(--mt-accent); outline-offset: 2px; }
.navigation-backdrop { display: none; }
.resizer { position: absolute; right: -2px; top: 0; bottom: 0; width: 4px; cursor: ew-resize; background: transparent; z-index: 1; }
.resizer:hover, .resizer.dragging { background: var(--mt-accent); opacity: .4; }
.resizer:focus-visible { width: 5px; right: -3px; background: var(--mt-accent); opacity: .65; outline: none; }
@media (max-width: 900px) {
  .side-bar:not(.collapsed) { position: absolute; z-index: 45; inset: 0 auto 0 0; box-shadow: 12px 0 36px #0002; }
  .panel { width: var(--navigation-width); }
  .navigation-backdrop { display: block; position: absolute; z-index: 44; inset: 0; border: 0; padding: 0; background: #0003; }
  .resizer { display: none; }
}
</style>
