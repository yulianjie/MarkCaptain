<script setup lang="ts">
/**
 * Recent files / folders dialog. Opened from the menu or palette ("File:
 * Open Recent…"). Click to open; "Clear" wipes the list.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Document, Folder, Delete } from '@element-plus/icons-vue'
import { bus } from '@/bus'
import { useEditorStore } from '@/stores/editor'
import { useProjectStore } from '@/stores/project'
import { usePreferencesStore } from '@/stores/preferences'
import { t } from '@/i18n'

const editor = useEditorStore()
const project = useProjectStore()
const prefs = usePreferencesStore()

const visible = ref(false)

function open() { visible.value = true }
function close() { visible.value = false }

async function openFile(path: string) {
  close()
  try { await editor.openFile(path) } catch { /* notify is handled in store */ }
}

async function openFolder(path: string) {
  close()
  await project.openRoot(path)
}

function clear() {
  prefs.clearRecents()
}

let unsub: (() => void) | null = null
onMounted(() => { unsub = bus.on('show-recent', open) })
onBeforeUnmount(() => { unsub?.() })

defineExpose({ open })
</script>

<template>
  <el-dialog v-model="visible" width="min(640px, calc(100vw - 32px))" class="recent-dialog" align-center :show-close="true">
    <template #header>
      <div class="recent-header">
        <h3>{{ t('recent.title') }}</h3>
        <el-button v-if="prefs.recentFiles.length || prefs.recentFolders.length" size="small" link @click="clear">
          <el-icon><Delete /></el-icon> {{ t('recent.clear') }}
        </el-button>
      </div>
    </template>
    <div class="recent-body">
      <div class="section">
        <div class="section-header">{{ t('recent.folders') }}</div>
        <div v-if="!prefs.recentFolders.length" class="empty">{{ t('recent.noFolders') }}</div>
        <button v-for="path in prefs.recentFolders" :key="path" type="button" class="row" :title="path" @click="openFolder(path)">
          <el-icon class="row-icon folder"><Folder /></el-icon>
          <span class="path-col">
            <span class="path-name">{{ path.split(/[\\/]/).pop() }}</span>
            <span class="path-full">{{ path }}</span>
          </span>
        </button>
      </div>
      <div class="section">
        <div class="section-header">{{ t('recent.files') }}</div>
        <div v-if="!prefs.recentFiles.length" class="empty">{{ t('recent.noFiles') }}</div>
        <button v-for="path in prefs.recentFiles" :key="path" type="button" class="row" :title="path" @click="openFile(path)">
          <el-icon class="row-icon"><Document /></el-icon>
          <span class="path-col">
            <span class="path-name">{{ path.split(/[\\/]/).pop() }}</span>
            <span class="path-full">{{ path }}</span>
          </span>
        </button>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.recent-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-right: 24px; }
.recent-header h3 { margin: 0; font-weight: 600; font-size: 16px; color: var(--mt-fg); }
.recent-body { max-height: min(480px, 65vh); overflow-y: auto; }
.section + .section { margin-top: 24px; }
.section-header { font-size: 10px; font-weight: 600; color: var(--mt-fg-muted); letter-spacing: .08em; padding: 0 10px 9px; margin-bottom: 5px; border-bottom: 1px solid var(--mt-border); }
.row { display: flex; align-items: center; gap: 13px; width: 100%; padding: 11px 10px; border: 0; text-align: left; font: inherit; color: var(--mt-fg); background: transparent; cursor: pointer; border-radius: 7px; }
.row:hover { background: var(--mt-row-hover); }
.row:focus-visible { outline: 2px solid var(--mt-accent); outline-offset: -2px; background: var(--mt-accent-soft); }
.row-icon { color: var(--mt-fg-muted); font-size: 18px; flex-shrink: 0; }
.row-icon.folder { color: var(--mt-accent); }
.path-col { flex: 1; overflow: hidden; }
.path-name { display: block; font-size: 13px; font-weight: 500; color: var(--mt-fg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.6; }
.path-full { display: block; font-size: 11px; color: var(--mt-fg-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.6; }
.empty { padding: 25px 12px; color: var(--mt-fg-muted); font-size: 12px; text-align: center; background: var(--mt-surface); border-radius: 7px; }
</style>
