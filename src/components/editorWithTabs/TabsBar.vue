<script setup lang="ts">
/**
 * Tab bar — one row of file tabs above the editor.
 *
 * Click to activate, middle-click / × to close, drag-to-reorder via the
 * HTML5 native drag API (no extra dependency). The drag-over indicator is
 * just a left-border highlight on the tab being hovered.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useEditorStore } from '@/stores/editor'
import { Close, Plus } from '@element-plus/icons-vue'
import { ChevronLeft, ChevronRight, FileText, Focus, Share, Sparkles } from '@lucide/vue'
import { usePreferencesStore } from '@/stores/preferences'
import { useAgentStore } from '@/stores/agent'
import { useWorkspaceCopy } from '@/components/welcome/workspace-copy'
import { t, useI18n } from '@/i18n'
import { bus } from '@/bus'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { open as shellOpen } from '@tauri-apps/plugin-shell'

const editor = useEditorStore()
const prefs = usePreferencesStore()
const agent = useAgentStore()
const copy = useWorkspaceCopy()
const { locale } = useI18n()
const scrollCopy = computed(() => locale.value === 'zh-CN'
  ? { previous: '向左滚动页签', next: '向右滚动页签' }
  : locale.value === 'ja'
    ? { previous: '前のタブを表示', next: '次のタブを表示' }
    : { previous: 'Scroll tabs left', next: 'Scroll tabs right' })

const draggingId = ref<string | null>(null)
const hoverId = ref<string | null>(null)
const tabRefs = new Map<string, HTMLButtonElement>()
const scrollElement = ref<HTMLElement | null>(null)
const hasOverflow = ref(false)
const canScrollPrevious = ref(false)
const canScrollNext = ref(false)
let resizeObserver: ResizeObserver | null = null

function updateScrollState() {
  const element = scrollElement.value
  if (!element) return
  hasOverflow.value = element.scrollWidth > element.clientWidth + 1
  canScrollPrevious.value = element.scrollLeft > 1
  canScrollNext.value = element.scrollLeft + element.clientWidth < element.scrollWidth - 1
}

function revealTab(element: HTMLElement) {
  const viewport = scrollElement.value
  if (!viewport) return
  const bounds = viewport.getBoundingClientRect()
  const tab = element.getBoundingClientRect()
  // Change only this horizontal scroller; scrollIntoView may also move an
  // editor pane or the application document when it reveals a focused tab.
  if (tab.left < bounds.left) viewport.scrollLeft -= bounds.left - tab.left
  else if (tab.right > bounds.right) viewport.scrollLeft += tab.right - bounds.right
  updateScrollState()
}

function revealCurrentTab() {
  const tab = editor.currentFileId ? tabRefs.get(editor.currentFileId)?.parentElement : null
  if (tab) revealTab(tab)
  else updateScrollState()
}

function scrollTabs(direction: -1 | 1) {
  const viewport = scrollElement.value
  if (!viewport) return
  const bounds = viewport.getBoundingClientRect()
  const tabs = Array.from(viewport.querySelectorAll<HTMLElement>('.tab-shell'))
  const target = direction > 0
    ? tabs.find(tab => tab.getBoundingClientRect().right > bounds.right + 1)
    : tabs.reverse().find(tab => tab.getBoundingClientRect().left < bounds.left - 1)
  if (target) revealTab(target)
}

watch([() => editor.currentFileId, () => editor.tabs.map(tab => [tab.id, tab.filename, tab.isSaved])], async () => {
  await nextTick()
  updateScrollState()
  // Overflow controls reserve space of their own after the first layout.
  await nextTick()
  revealCurrentTab()
}, { flush: 'post' })

onMounted(() => {
  resizeObserver = new ResizeObserver(() => { updateScrollState(); revealCurrentTab() })
  if (scrollElement.value) resizeObserver.observe(scrollElement.value)
  updateScrollState()
  void nextTick(revealCurrentTab)
})
onBeforeUnmount(() => resizeObserver?.disconnect())

function activate(id: string) {
  editor.setCurrent(id)
}

async function close(id: string, ev: MouseEvent) {
  ev.stopPropagation()
  if (!await editor.closeTab(id)) return
  await nextTick()
  if (editor.currentFileId) tabRefs.get(editor.currentFileId)?.focus()
}

function onMiddleClick(id: string, ev: MouseEvent) {
  if (ev.button === 1) {
    ev.preventDefault()
    void editor.closeTab(id)
  }
}

function newTab() {
  editor.newUntitledTab()
}

function setTabRef(id: string, element: unknown) {
  if (element instanceof HTMLButtonElement) tabRefs.set(id, element)
  else tabRefs.delete(id)
}

function tabAriaLabel(filename: string, isSaved: boolean): string {
  return isSaved ? filename : `${filename} · ${t('tabs.unsaved')}`
}

async function focusTabAt(index: number) {
  const tab = editor.tabs[index]
  if (!tab) return
  activate(tab.id)
  await nextTick()
  tabRefs.get(tab.id)?.focus()
}

function onTabKeydown(id: string, ev: KeyboardEvent) {
  const index = editor.tabs.findIndex(tab => tab.id === id)
  if (index < 0) return
  let target = index
  if (ev.key === 'ArrowRight') target = (index + 1) % editor.tabs.length
  else if (ev.key === 'ArrowLeft') target = (index - 1 + editor.tabs.length) % editor.tabs.length
  else if (ev.key === 'Home') target = 0
  else if (ev.key === 'End') target = editor.tabs.length - 1
  else if (ev.key === 'Delete') {
    ev.preventDefault()
    void close(id, new MouseEvent('click'))
    return
  } else return
  ev.preventDefault()
  void focusTabAt(target)
}

async function closeTabsInOrder(ids: string[]): Promise<boolean> {
  for (const tabId of ids) {
    if (!await editor.closeTab(tabId)) return false
  }
  return true
}

/* ── context menu ─────────────────────────────────────────────── */
function parentDirOf(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx >= 0 ? p.slice(0, idx) : p
}

function onTabContextMenu(id: string, ev: MouseEvent) {
  ev.preventDefault()
  ev.stopPropagation()
  const tab = editor.tabs.find(x => x.id === id)
  if (!tab) return
  bus.emit('openContextMenu', {
    x: ev.clientX,
    y: ev.clientY,
    items: [
      { label: t('tabs.closeTab'), action: () => { void editor.closeTab(id) } },
      { label: t('tabs.closeOthers'), action: async () => {
        await closeTabsInOrder(editor.tabs.filter(tab => tab.id !== id).map(tab => tab.id))
      } },
      { label: t('tabs.closeAll'), action: async () => {
        await closeTabsInOrder(editor.tabs.map(tab => tab.id))
      } },
      { divider: true },
      { label: t('tabs.rename'), action: () => { editor.setCurrent(id); bus.emit('rename', undefined) } },
      { label: t('tabs.copyPath'), disabled: !tab.pathname, action: async () => {
        if (tab.pathname) await writeText(tab.pathname)
      } },
      { label: t('tabs.showInFolder'), disabled: !tab.pathname, action: async () => {
        if (tab.pathname) await shellOpen(parentDirOf(tab.pathname))
      } },
    ],
  })
}

/* ── drag-and-drop reordering ─────────────────────────────────── */
function onDragStart(id: string, ev: DragEvent) {
  draggingId.value = id
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move'
    // Required on Firefox; ignored on Chromium.
    ev.dataTransfer.setData('text/plain', id)
  }
}

function onDragOver(id: string, ev: DragEvent) {
  if (!draggingId.value || draggingId.value === id) return
  ev.preventDefault()
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
  hoverId.value = id
}

function onDragLeave(id: string) {
  if (hoverId.value === id) hoverId.value = null
}

function onDrop(id: string, ev: DragEvent) {
  ev.preventDefault()
  const fromId = draggingId.value
  draggingId.value = null
  hoverId.value = null
  if (!fromId || fromId === id) return
  const fromIdx = editor.tabs.findIndex(t => t.id === fromId)
  const toIdx = editor.tabs.findIndex(t => t.id === id)
  if (fromIdx < 0 || toIdx < 0) return
  editor.exchangeTabs(fromIdx, toIdx)
}

function onDragEnd() {
  draggingId.value = null
  hoverId.value = null
}
</script>

<template>
  <div class="tabs-bar">
    <button v-if="hasOverflow" type="button" class="scroll-tabs scroll-tabs-previous" :disabled="!canScrollPrevious"
      :aria-label="scrollCopy.previous" :title="scrollCopy.previous" aria-controls="document-tabs" @click="scrollTabs(-1)">
      <ChevronLeft :size="14" />
    </button>
    <div id="document-tabs" ref="scrollElement" class="tabs-scroll" role="tablist" @scroll.passive="updateScrollState">
      <div
        v-for="tab in editor.tabs"
        :key="tab.id"
        class="tab-shell"
        :class="{
          active: tab.id === editor.currentFileId,
          dirty: !tab.isSaved,
          dragging: tab.id === draggingId,
          'drop-target': tab.id === hoverId,
        }"
        draggable="true"
        @contextmenu="onTabContextMenu(tab.id, $event)"
        @mousedown.middle="onMiddleClick(tab.id, $event)"
        @dragstart="onDragStart(tab.id, $event)"
        @dragover="onDragOver(tab.id, $event)"
        @dragleave="onDragLeave(tab.id)"
        @drop="onDrop(tab.id, $event)"
        @dragend="onDragEnd"
      >
        <button
          :ref="element => setTabRef(tab.id, element)"
          type="button"
          class="tab"
          role="tab"
          :title="tab.pathname || tab.filename"
          :aria-selected="tab.id === editor.currentFileId"
          :aria-label="tabAriaLabel(tab.filename, tab.isSaved)"
          :tabindex="tab.id === editor.currentFileId ? 0 : -1"
          @click="activate(tab.id)"
          @keydown="onTabKeydown(tab.id, $event)"
        >
          <span v-if="!tab.isSaved" class="dot" aria-hidden="true" />
          <FileText v-else class="file-icon" :size="13" :stroke-width="1.6" aria-hidden="true" />
          <span class="label">{{ tab.filename }}</span>
        </button>
        <button
          type="button"
          class="close"
          :aria-label="`${t('tabs.closeTab')}: ${tab.filename}`"
          @click="close(tab.id, $event)"
        >
          <el-icon :size="13"><Close /></el-icon>
        </button>
      </div>
    </div>
    <button v-if="hasOverflow" type="button" class="scroll-tabs scroll-tabs-next" :disabled="!canScrollNext"
      :aria-label="scrollCopy.next" :title="scrollCopy.next" aria-controls="document-tabs" @click="scrollTabs(1)">
      <ChevronRight :size="14" />
    </button>
    <button class="new-tab" @click="newTab" :aria-label="t('tabs.newTab')">
      <el-icon :size="14"><Plus /></el-icon>
    </button>
    <div class="document-actions">
      <button type="button" :title="t('menu.toggleFocus')" :aria-label="t('menu.toggleFocus')" :aria-pressed="prefs.focus" @click="prefs.toggleViewMode('focus')"><Focus :size="15" :stroke-width="1.6" /></button>
      <button type="button" :title="copy.export" :aria-label="copy.export" :disabled="!editor.currentFile" @click="bus.emit('show-export-dialog', { format: 'html' })"><Share :size="15" :stroke-width="1.6" /></button>
      <button type="button" class="agent-action" :title="t('agent.toggle')" aria-label="Agent" :aria-expanded="agent.visible" @click="agent.toggle()"><Sparkles :size="14" :stroke-width="1.6" /><span>Agent</span><i v-if="agent.busy" /></button>
    </div>
  </div>
</template>

<style scoped>
.tabs-bar {
  box-sizing: border-box;
  display: flex;
  height: 45px;
  padding: 5px 14px 0;
  background: var(--mt-bg);
  border-bottom: 1px solid var(--mt-border);
  flex-shrink: 0;
  position: relative;
  z-index: 2;
}
.tabs-scroll {
  display: flex;
  overflow-x: auto;
  overflow-y: hidden;
  flex: 0 1 auto;
  min-width: 0;
  gap: 4px;
  scrollbar-width: none;
  overscroll-behavior-x: contain;
}
.tabs-scroll::-webkit-scrollbar { display: none; }

.tab-shell {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  height: 100%;
  border: 0;
  border-radius: 6px 6px 0 0;
  flex: 0 0 auto;
  min-width: 100px;
  max-width: 215px;
  position: relative;
  transition: background-color 100ms, box-shadow 100ms;
}
.tab-shell:hover { background: var(--mt-row-hover); }
.tab-shell.active {
  background: var(--mt-row-hover);
}
.tab-shell.active::after { content: ''; position: absolute; bottom: 0; left: 9px; right: 9px; height: 2px; border-radius: 1px; background: var(--mt-accent); pointer-events: none; }
.tab-shell.dragging { opacity: 0.5; }
.tab-shell.drop-target { box-shadow: inset 3px 0 0 var(--mt-accent); }
.tab {
  min-width: 0;
  flex: 1;
  align-self: stretch;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px 0 11px;
  border: 0;
  color: var(--mt-fg-muted);
  background: transparent;
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.tab-shell.active .tab {
  color: var(--mt-fg);
  font-weight: 400;
}
.file-icon { color: var(--mt-fg-muted); flex-shrink: 0; }
.tab:focus-visible,
.close:focus-visible,
.new-tab:focus-visible {
  outline: 2px solid var(--mt-accent);
  outline-offset: -3px;
}
.tab .label {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dot {
  width: 6px;
  height: 6px;
  background: var(--mt-accent);
  border-radius: 50%;
  flex: 0 0 auto;
}
.close {
  position: sticky;
  right: 4px;
  z-index: 1;
  display: inline-flex;
  flex: 0 0 24px;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin-right: 4px;
  border: none;
  background: var(--mt-bg);
  box-shadow: -3px 0 0 var(--mt-bg);
  color: var(--mt-fg-muted);
  cursor: pointer;
  padding: 0;
  border-radius: var(--mt-radius-control);
  opacity: 1;
  pointer-events: auto;
  transition: opacity 100ms, background-color 100ms, color 100ms;
}
.tab-shell:hover .close,
.tab-shell:focus-within .close,
.tab-shell.active .close {
  opacity: 1;
  pointer-events: auto;
}
.close:hover { background: var(--mt-row-hover); color: var(--mt-fg); }
.tab-shell:hover .close, .tab-shell.active .close { background: var(--mt-row-hover); box-shadow: -3px 0 0 var(--mt-row-hover); }
.scroll-tabs { display: grid; place-items: center; width: 23px; height: 28px; flex: 0 0 23px; align-self: center; margin-bottom: 5px; border: 0; border-radius: 5px; padding: 0; background: var(--mt-bg); color: var(--mt-fg-muted); cursor: pointer; }
.scroll-tabs:hover:enabled { background: var(--mt-row-hover); color: var(--mt-fg); }
.scroll-tabs:disabled { opacity: .35; cursor: default; }
.scroll-tabs:focus-visible { outline: 2px solid var(--mt-accent); outline-offset: -2px; }

.new-tab {
  border: none;
  background: transparent;
  color: var(--mt-fg-muted);
  cursor: pointer;
  width: 28px;
  height: 26px;
  flex: 0 0 28px;
  align-self: center;
  margin-left: 4px;
  padding: 0;
  border-radius: var(--mt-radius-control);
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 1;
  transition: opacity 100ms;
}
.tabs-bar:hover .new-tab,
.new-tab:focus-visible { opacity: 1; }
.new-tab:hover { background: var(--mt-row-hover); color: var(--mt-fg); }
.document-actions { display: flex; align-items: center; gap: 3px; margin-left: auto; padding: 0 0 5px 12px; flex-shrink: 0; background: var(--mt-bg); }
.document-actions button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; width: 29px; height: 28px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--mt-fg-muted); font: inherit; font-size: 11px; cursor: pointer; }
.document-actions button:hover, .document-actions button[aria-pressed="true"] { background: var(--mt-row-hover); color: var(--mt-accent); }
.document-actions button:disabled { opacity: .35; cursor: default; }
.document-actions button:focus-visible { outline: 2px solid var(--mt-accent); outline-offset: -2px; }
.document-actions .agent-action { width: auto; padding-inline: 9px; margin-left: 4px; color: var(--mt-accent); background: var(--mt-accent-soft, var(--mt-icon-active-bg)); }
.agent-action i { width: 4px; height: 4px; border-radius: 50%; background: currentColor; }
@media (max-width: 900px) { .tabs-bar { padding-inline: 8px; } .tab-shell { min-width: 90px; max-width: 175px; } .document-actions { padding-left: 6px; } }
@media (max-width: 580px) { .agent-action span { display: none; } .document-actions .agent-action { padding-inline: 7px; } }
</style>
