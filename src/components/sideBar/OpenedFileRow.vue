<script setup lang="ts">
import { useEditorStore } from '@/stores/editor'
import { Close, Document } from '@element-plus/icons-vue'
import type { DocumentState } from '@/stores/help'
import { bus } from '@/bus'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import { t } from '@/i18n'

interface Props {
  tab: DocumentState
  active: boolean
}
const props = defineProps<Props>()

const editor = useEditorStore()

function activate() { editor.setCurrent(props.tab.id) }
function close(ev: MouseEvent) { ev.stopPropagation(); void editor.closeTab(props.tab.id) }
function onMiddle(ev: MouseEvent) { if (ev.button === 1) { ev.preventDefault(); void editor.closeTab(props.tab.id) } }

function onRowKeydown(ev: KeyboardEvent) {
  if (ev.target !== ev.currentTarget) return
  if (ev.key !== 'Enter' && ev.key !== ' ') return
  ev.preventDefault()
  activate()
}

function parentDirOf(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx >= 0 ? p.slice(0, idx) : p
}

function onContextMenu(ev: MouseEvent) {
  ev.preventDefault()
  ev.stopPropagation()
  const id = props.tab.id
  bus.emit('openContextMenu', {
    x: ev.clientX,
    y: ev.clientY,
    items: [
      { label: t('tabs.closeTab'), action: () => { void editor.closeTab(id) } },
      { label: t('tabs.closeOthers'), action: async () => {
        for (const tt of [...editor.tabs]) if (tt.id !== id) await editor.closeTab(tt.id)
      } },
      { label: t('tabs.closeAll'), action: async () => {
        for (const tt of [...editor.tabs]) await editor.closeTab(tt.id)
      } },
      { divider: true },
      { label: t('tabs.rename'), action: () => { editor.setCurrent(id); bus.emit('rename', undefined) } },
      { label: t('tabs.copyPath'), disabled: !props.tab.pathname, action: async () => {
        if (props.tab.pathname) await writeText(props.tab.pathname)
      } },
      { label: t('tabs.showInFolder'), disabled: !props.tab.pathname, action: async () => {
        if (props.tab.pathname) await shellOpen(parentDirOf(props.tab.pathname))
      } },
    ],
  })
}
</script>

<template>
  <div
    class="row"
    :class="{ active, dirty: !tab.isSaved }"
    :title="tab.pathname || tab.filename"
    role="listitem"
    tabindex="0"
    :aria-label="tab.isSaved ? tab.filename : `${tab.filename} · ${t('tabs.unsaved')}`"
    :aria-current="active ? 'page' : undefined"
    @click="activate"
    @keydown="onRowKeydown"
    @mousedown.middle="onMiddle"
    @contextmenu="onContextMenu"
  >
    <span class="indicator">
      <span class="dot" />
      <button
        type="button"
        class="close"
        :title="t('tabs.closeTab')"
        :aria-label="`${t('tabs.closeTab')}: ${tab.filename}`"
        @click="close"
      >
        <el-icon :size="12"><Close /></el-icon>
      </button>
    </span>
    <el-icon class="icon"><Document /></el-icon>
    <span class="name">{{ tab.filename }}</span>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 33px;
  margin: 1px 12px;
  padding: 0 8px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 12px;
  color: var(--mt-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row:hover { background: var(--mt-row-hover); }
.row.active {
  background: var(--mt-accent-soft, var(--mt-icon-active-bg));
  color: var(--mt-accent);
}
.row:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--mt-accent) 72%, transparent);
  outline-offset: -2px;
}
.indicator {
  order: 3;
  width: 20px;
  height: 24px;
  position: relative;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.dot {
  display: none;
  position: absolute;
  top: 3px;
  right: 3px;
  z-index: 1;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--mt-accent);
  box-shadow: 0 0 0 1px var(--mt-sidebar-bg);
}
.close {
  display: inline-flex;
  border: none;
  background: transparent;
  color: var(--mt-fg-muted);
  cursor: pointer;
  padding: 0;
  width: 24px;
  height: 24px;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  opacity: 0.58;
}
.close:hover,
.close:focus-visible {
  color: var(--mt-fg);
  background: var(--mt-row-hover);
  opacity: 1;
}
.close:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--mt-accent) 72%, transparent);
  outline-offset: -2px;
}
.row:hover .close,
.row:focus-within .close { opacity: 1; }

/* Dirty tabs retain their unsaved marker without hiding the close action. */
.row.dirty .dot { display: inline-block; }

.icon {
  color: var(--mt-fg-muted);
  font-size: 14px;
  flex-shrink: 0;
}
.row.active .icon { color: var(--mt-accent); }
.name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
