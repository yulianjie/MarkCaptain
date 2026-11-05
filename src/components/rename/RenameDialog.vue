<script setup lang="ts">
/**
 * Rename-current-file dialog. Triggered by the `rename` bus event.
 *
 * If the file is on disk we ask Rust to rename it via `cmd_rename_file`;
 * for an Untitled buffer we just update the in-memory filename. The dirty
 * state isn't touched here — saving still goes through the normal flow.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { bus } from '@/bus'
import { useEditorStore } from '@/stores/editor'
import { useProjectStore, pathIsInsideRoot } from '@/stores/project'
import { useNotificationStore } from '@/stores/notification'
import { t } from '@/i18n'

const editor = useEditorStore()
const notify = useNotificationStore()

const visible = ref(false)
const draft = ref('')
const input = ref<HTMLInputElement | null>(null)

function open() {
  const tab = editor.currentFile
  if (!tab) return
  draft.value = tab.filename
  visible.value = true
}
function cancel() { visible.value = false }

async function apply() {
  const tab = editor.currentFile
  if (!tab) { visible.value = false; return }
  const name = draft.value.trim()
  if (!name || name === tab.filename) { visible.value = false; return }
  if (tab.pathname) {
    const dir = tab.pathname.replace(/[\\/][^\\/]+$/, '')
    const sep = tab.pathname.includes('\\') ? '\\' : '/'
    const next = `${dir}${sep}${name}`
    try {
      const project = useProjectStore()
      if (project.projectTree && pathIsInsideRoot(project.projectTree.pathname, tab.pathname)) {
        if (await project.renameEntry(tab.pathname, name) === null) return
      } else await editor.renameTab(tab.id, next)
    } catch (err) {
      notify.pushToast({ type: 'error', title: 'Rename failed', message: err instanceof Error ? err.message : String(err) })
      return
    }
  } else {
    // Untitled — just update the displayed name.
    tab.filename = name
  }
  visible.value = false
}

let unsub: (() => void) | null = null
onMounted(() => { unsub = bus.on('rename', open) })
onBeforeUnmount(() => { unsub?.() })

watch(visible, async (v) => { if (v) { await Promise.resolve(); input.value?.focus(); input.value?.select() } })
</script>

<template>
  <el-dialog v-model="visible" width="min(420px, calc(100vw - 32px))" class="rename-dialog" align-center :show-close="false">
    <template #header>
      <h3 class="rename-title">{{ t('rename.title') }}</h3>
    </template>
    <input
      ref="input"
      v-model="draft"
      class="rename-input"
      spellcheck="false"
      :aria-label="t('rename.title')"
      :placeholder="t('rename.placeholder')"
      @keyup.enter="apply"
      @keyup.escape="cancel"
    />
    <template #footer>
      <div class="footer">
        <el-button size="small" @click="cancel">{{ t('rename.cancel') }}</el-button>
        <el-button size="small" type="primary" @click="apply">{{ t('rename.apply') }}</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.rename-title { margin: 0; font-size: 16px; font-weight: 600; color: var(--mt-fg); }
.rename-input {
  width: 100%;
  box-sizing: border-box;
  min-height: 40px;
  padding: 9px 12px;
  border: 1px solid var(--mt-border);
  border-radius: 7px;
  outline: none;
  font-size: 13px;
  font-family: inherit;
  color: var(--mt-fg);
  background: var(--mt-surface-raised);
}
.rename-input:focus { border-color: var(--mt-accent); box-shadow: 0 0 0 3px var(--mt-accent-soft); }
.footer { display: flex; justify-content: flex-end; gap: 8px; }
.footer :deep(.el-button + .el-button) { margin-left: 0; }
</style>
