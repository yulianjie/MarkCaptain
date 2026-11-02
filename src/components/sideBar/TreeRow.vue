<script setup lang="ts">
/**
 * Recursive tree row — renders a file or folder. Folders expand/collapse
 * on click; files emit `select` which the parent forwards to the editor.
 */
import { computed } from 'vue'
import { ElMessageBox } from 'element-plus'
import type { TreeFile, TreeFolder } from '@/stores/treeCtrl'
import { CaretRight, Document, Folder, Refresh } from '@element-plus/icons-vue'
import {
  closeTabsBeforeDelete,
  treeNodeMatchesFilter,
  useProjectStore,
} from '@/stores/project'
import { useEditorStore } from '@/stores/editor'
import { useNotificationStore } from '@/stores/notification'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import { bus } from '@/bus'
import { t } from '@/i18n'

interface Props {
  node: TreeFolder | TreeFile
  depth: number
  filter?: string
  matchingPaths?: ReadonlySet<string>
}
const props = withDefaults(defineProps<Props>(), {
  filter: '',
  matchingPaths: undefined,
})
const emit = defineEmits<{ (e: 'select', file: TreeFile): void }>()

const project = useProjectStore()
const editor = useEditorStore()
const notify = useNotificationStore()

const isFolder = computed(() => props.node.isDirectory)
const folder = computed(() => (isFolder.value ? (props.node as TreeFolder) : null))
const padding = computed(() => 8 + props.depth * 20 + 'px')
const childPadding = computed(() => 8 + (props.depth + 1) * 20 + 'px')
const visible = computed(() => {
  if (!props.filter.trim()) return true
  return props.matchingPaths
    ? props.matchingPaths.has(props.node.pathname)
    : treeNodeMatchesFilter(props.node, props.filter)
})
const isCut = computed(() => (
  project.clipboard?.kind === 'cut' && project.clipboard.source === props.node.pathname
))

function toggle() {
  if (folder.value) void project.toggleFolder(folder.value)
}

function handleFolderKeydown(event: KeyboardEvent) {
  const value = folder.value
  if (!value) return
  if (event.key === 'ArrowRight') {
    event.preventDefault()
    if (value.isCollapsed) void project.toggleFolder(value)
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault()
    if (!value.isCollapsed) value.isCollapsed = true
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    void project.toggleFolder(value)
  }
}

function pickFile(file: TreeFile) {
  project.setActiveItem({ pathname: file.pathname, isDirectory: false })
  emit('select', file)
}

function parentDirOf(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx >= 0 ? p.slice(0, idx) : p
}

function notifyOperationError(err: unknown) {
  notify.pushToast({
    type: 'error',
    title: t('tree.operationFailed'),
    message: err instanceof Error ? err.message : String(err),
  })
}

function validateName(value: string): boolean | string {
  const name = value.trim()
  if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
    return t('tree.invalidName')
  }
  return true
}

async function askName(
  title: string,
  message: string,
  initialValue = '',
): Promise<string | null> {
  try {
    const { value } = await ElMessageBox.prompt(message, title, {
      inputValue: initialValue,
      inputValidator: validateName,
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
      closeOnClickModal: false,
    })
    return value.trim()
  } catch {
    return null
  }
}

async function createIn(dirname: string, kind: 'file' | 'directory') {
  project.startCreate(dirname, kind)
  try {
    const name = await askName(
      kind === 'file' ? t('tree.newFile') : t('tree.newFolder'),
      kind === 'file' ? t('tree.newFilePrompt') : t('tree.newFolderPrompt'),
      kind === 'file' ? 'untitled.md' : '',
    )
    if (!name) return
    const created = await project.createEntry(dirname, name, kind)
    if (kind === 'file') await editor.openFile(created)
  } catch (err) {
    notifyOperationError(err)
  } finally {
    project.cancelCreate()
  }
}

async function renameEntry(node: TreeFolder | TreeFile) {
  project.startRename(node.pathname)
  try {
    const name = await askName(t('tree.rename'), t('tree.renamePrompt'), node.name)
    if (!name || name === node.name) return
    await project.renameEntry(node.pathname, name)
  } catch (err) {
    notifyOperationError(err)
  } finally {
    project.cancelRename()
  }
}

async function pasteInto(dirname: string) {
  try {
    await project.pasteInto(dirname)
  } catch (err) {
    notifyOperationError(err)
  }
}

async function trashEntry(node: TreeFolder | TreeFile) {
  try {
    const mayDelete = await closeTabsBeforeDelete(
      [...editor.tabs],
      node.pathname,
      node.isDirectory,
      ids => editor.closeTabsTransactionally(ids),
    )
    if (!mayDelete) return
    await project.trashEntry(node.pathname)
  } catch (err) {
    notifyOperationError(err)
  }
}

function fileMenu(file: TreeFile, ev: MouseEvent) {
  ev.preventDefault()
  ev.stopPropagation()
  bus.emit('openContextMenu', {
    x: ev.clientX,
    y: ev.clientY,
    items: [
      { label: t('tree.openFile'), action: () => pickFile(file) },
      { divider: true },
      { label: t('tree.newFile'), action: () => { void createIn(parentDirOf(file.pathname), 'file') } },
      { label: t('tree.newFolder'), action: () => { void createIn(parentDirOf(file.pathname), 'directory') } },
      { label: t('tree.rename'), action: () => { void renameEntry(file) } },
      { label: t('tree.copy'), action: () => project.setClipboard({ kind: 'copy', source: file.pathname }) },
      { label: t('tree.cut'), action: () => project.setClipboard({ kind: 'cut', source: file.pathname }) },
      { divider: true },
      { label: t('tabs.copyPath'), action: () => { void writeText(file.pathname) } },
      { label: t('tabs.showInFolder'), action: () => { void shellOpen(parentDirOf(file.pathname)) } },
      { divider: true },
      { label: t('tree.moveToTrash'), action: () => { void trashEntry(file) } },
    ],
  })
}

function folderMenu(f: TreeFolder, ev: MouseEvent) {
  ev.preventDefault()
  ev.stopPropagation()
  bus.emit('openContextMenu', {
    x: ev.clientX,
    y: ev.clientY,
    items: [
      { label: t('tree.newFile'), action: () => { void createIn(f.pathname, 'file') } },
      { label: t('tree.newFolder'), action: () => { void createIn(f.pathname, 'directory') } },
      {
        label: t('tree.paste'),
        disabled: !project.clipboard,
        action: () => { void pasteInto(f.pathname) },
      },
      { divider: true },
      { label: t('tree.rename'), action: () => { void renameEntry(f) } },
      { label: t('tree.copy'), action: () => project.setClipboard({ kind: 'copy', source: f.pathname }) },
      { label: t('tree.cut'), action: () => project.setClipboard({ kind: 'cut', source: f.pathname }) },
      { divider: true },
      { label: t('tabs.copyPath'), action: () => { void writeText(f.pathname) } },
      { label: t('tabs.showInFolder'), action: () => { void shellOpen(f.pathname) } },
      { divider: true },
      { label: t('tree.moveToTrash'), action: () => { void trashEntry(f) } },
    ],
  })
}
</script>

<template>
  <div v-if="visible && isFolder">
    <div
      class="row"
      :class="{ active: project.activeItem?.pathname === folder!.pathname, cut: isCut }"
      :style="{ paddingLeft: padding }"
      role="treeitem"
      tabindex="0"
      :aria-expanded="!folder!.isCollapsed"
      :aria-busy="folder!.loading"
      :title="folder!.loadError || folder!.pathname"
      @click="toggle"
      @keydown="handleFolderKeydown"
      @contextmenu="folderMenu(folder!, $event)"
    >
      <el-icon class="caret" :class="{ open: !folder!.isCollapsed }"><CaretRight /></el-icon>
      <el-icon class="icon folder"><Folder /></el-icon>
      <span class="name">{{ folder!.name }}</span>
    </div>
    <div v-show="filter || !folder!.isCollapsed">
      <div
        v-if="folder!.loading"
        class="load-state"
        :style="{ paddingLeft: childPadding }"
        role="status"
      >
        <el-icon class="spinning"><Refresh /></el-icon>
        <span>{{ t('sideBar.searching') }}</span>
      </div>
      <div
        v-else-if="folder!.loadError"
        class="load-state error"
        :style="{ paddingLeft: childPadding }"
        role="alert"
        :title="folder!.loadError"
      >
        <span class="load-error">{{ folder!.loadError }}</span>
        <button
          type="button"
          :aria-label="t('common.refresh')"
          :title="t('common.refresh')"
          @click.stop="project.retryFolder(folder!)"
        >
          <el-icon><Refresh /></el-icon>
        </button>
      </div>
      <TreeRow
        v-for="child in folder!.loaded ? folder!.folders : []"
        :key="child.id"
        :node="child"
        :depth="depth + 1"
        :filter="filter"
        :matching-paths="matchingPaths"
        @select="(f: TreeFile) => emit('select', f)"
      />
      <TreeRow
        v-for="file in folder!.loaded ? folder!.files : []"
        :key="file.id"
        :node="file"
        :depth="depth + 1"
        :filter="filter"
        :matching-paths="matchingPaths"
        @select="(f: TreeFile) => emit('select', f)"
      />
    </div>
  </div>
  <div
    v-else-if="visible"
    class="row file"
    :class="{ active: project.activeItem?.pathname === (node as TreeFile).pathname, cut: isCut }"
    :style="{ paddingLeft: padding }"
    :title="(node as TreeFile).pathname"
    role="treeitem"
    tabindex="0"
    @click="pickFile(node as TreeFile)"
    @keydown.enter.prevent="pickFile(node as TreeFile)"
    @keydown.space.prevent="pickFile(node as TreeFile)"
    @contextmenu="fileMenu(node as TreeFile, $event)"
  >
    <span class="caret-spacer" />
    <el-icon class="icon file-icon"><Document /></el-icon>
    <span class="name">{{ (node as TreeFile).name }}</span>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 33px;
  margin-inline: 12px;
  border-radius: 5px;
  padding-right: 8px;
  cursor: pointer;
  font-size: 12px;
  color: var(--mt-fg);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row:hover { background: var(--mt-row-hover); }
.row.cut { opacity: 0.5; }
.row.active {
  background: var(--mt-accent-soft, var(--mt-icon-active-bg));
  color: var(--mt-accent);
}
.caret {
  transition: transform 100ms;
  color: var(--mt-fg-muted);
  font-size: 10px;
}
.caret.open { transform: rotate(90deg); }
.caret-spacer { width: 10px; display: inline-block; }
.spinning { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.icon {
  color: var(--mt-fg-muted);
  font-size: 14px;
  flex-shrink: 0;
}
.icon.folder { color: var(--mt-accent); opacity: .8; }
.name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}
.load-state {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  padding-right: 8px;
  color: var(--mt-fg-muted);
  font-size: 12px;
}
.load-state.error { color: var(--el-color-danger); }
.load-error {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.load-state button {
  display: inline-flex;
  flex-shrink: 0;
  padding: 2px;
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
}
</style>
