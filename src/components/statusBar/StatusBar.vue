<script setup lang="ts">
/**
 * Read-only document and synchronization status.
 */
import { computed, onMounted } from 'vue'
import { useEditorStore } from '@/stores/editor'
import { usePreferencesStore } from '@/stores/preferences'
import { useCloudStorageStore } from '@/stores/cloudStorage'
import { useI18n } from '@/i18n'

const editor = useEditorStore()
const prefs = usePreferencesStore()
const cloud = useCloudStorageStore()
const { locale, t } = useI18n()

const statusCopy = {
  en: {
    statusBar: 'Document status',
    noDocument: 'No document',
    encoding: 'Encoding',
    lineEnding: 'Line ending',
    withBom: 'with BOM',
    saved: 'Saved',
    unsaved: 'Unsaved',
    autoSaveOff: 'Auto save off',
    autoSaveOn: 'Auto save',
    autoSaveNeedsPath: 'Auto save after first save',
    visualMode: 'Visual',
    sourceMode: 'Source',
    focusMode: 'Focus',
    typewriterMode: 'Typewriter',
    cloudSynced: 'Cloud synced',
    cloudPending: 'Cloud pending',
    cloudSyncing: 'Cloud syncing',
    cloudOffline: 'Cloud offline',
    cloudConflict: 'Cloud conflict',
    cloudError: 'Cloud error',
  },
  'zh-CN': {
    statusBar: '文档状态',
    noDocument: '无文档',
    encoding: '编码',
    lineEnding: '换行符',
    withBom: '含 BOM',
    saved: '已保存',
    unsaved: '未保存',
    autoSaveOff: '自动保存：关',
    autoSaveOn: '自动保存',
    autoSaveNeedsPath: '首次保存后自动保存',
    visualMode: '所见即所得',
    sourceMode: '源码',
    focusMode: '专注',
    typewriterMode: '打字机',
    cloudSynced: '云端已同步',
    cloudPending: '等待云端同步',
    cloudSyncing: '正在同步云端',
    cloudOffline: '云端离线',
    cloudConflict: '云端冲突',
    cloudError: '云端同步错误',
  },
  ja: {
    statusBar: 'ドキュメントの状態',
    noDocument: 'ドキュメントなし',
    encoding: '文字コード',
    lineEnding: '改行コード',
    withBom: 'BOM あり',
    saved: '保存済み',
    unsaved: '未保存',
    autoSaveOff: '自動保存：オフ',
    autoSaveOn: '自動保存',
    autoSaveNeedsPath: '初回保存後に自動保存',
    visualMode: 'ビジュアル',
    sourceMode: 'ソース',
    focusMode: '集中',
    typewriterMode: 'タイプライター',
    cloudSynced: 'クラウド同期済み',
    cloudPending: 'クラウド同期待ち',
    cloudSyncing: 'クラウド同期中',
    cloudOffline: 'クラウドオフライン',
    cloudConflict: 'クラウド競合',
    cloudError: 'クラウド同期エラー',
  },
} as const

const copy = computed(() => statusCopy[locale.value] ?? statusCopy.en)
const file = computed(() => editor.currentFile)
const stats = computed(() => file.value?.wordCount ?? {
  word: 0,
  character: 0,
  paragraph: 0,
  all: 0,
})

function humanizeEncoding(value: string): string {
  const compact = value.trim().toLowerCase().replace(/[-_\s]/g, '')
  const known: Record<string, string> = {
    utf8: 'UTF-8',
    utf16le: 'UTF-16 LE',
    utf16be: 'UTF-16 BE',
    utf32le: 'UTF-32 LE',
    utf32be: 'UTF-32 BE',
  }
  return known[compact] ?? value.toUpperCase()
}

const encodingLabel = computed(() => {
  const encoding = file.value?.encoding
  if (!encoding) return '—'
  const label = humanizeEncoding(encoding.encoding)
  return encoding.isBom ? `${label} · ${copy.value.withBom}` : label
})

const lineEndingLabel = computed(() => file.value?.lineEnding.toUpperCase() ?? '—')
const saveLabel = computed(() => {
  if (!file.value) return copy.value.noDocument
  return file.value.isSaved ? copy.value.saved : copy.value.unsaved
})

const autoSaveLabel = computed(() => {
  if (!prefs.autoSave) return copy.value.autoSaveOff
  if (!file.value?.pathname) return copy.value.autoSaveNeedsPath
  return copy.value.autoSaveOn
})

const saveTitle = computed(() => `${saveLabel.value} · ${autoSaveLabel.value}`)
const modeLabel = computed(() => (
  editor.sourceCodeMode ? copy.value.sourceMode : copy.value.visualMode
))

function normalizedPath(value: string): string {
  let path = value.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^\/\/\?\/UNC\//i.test(path)) path = `//${path.slice(8)}`
  else if (/^\/\/\?\//.test(path)) path = path.slice(4)
  return /^[a-z]:\//i.test(path) || path.startsWith('//') ? path.toLowerCase() : path
}

const cloudConnection = computed(() => {
  const path = normalizedPath(file.value?.pathname ?? '')
  if (!path) return null
  return cloud.connections.find(connection => {
    const root = normalizedPath(connection.localRoot)
    if (!root) return false
    return path === root || path.startsWith(`${root}/`)
  }) ?? null
})
const cloudState = computed(() => {
  const connection = cloudConnection.value
  return connection ? cloud.syncResults[connection.id]?.state ?? 'pending' : null
})
const cloudLabel = computed(() => cloudState.value
  ? copy.value[`cloud${cloudState.value[0].toUpperCase()}${cloudState.value.slice(1)}` as keyof typeof copy.value]
  : '')
onMounted(() => { void cloud.load() })
</script>

<template>
  <footer class="status-bar" :aria-label="copy.statusBar">
    <div class="status-content">
      <div class="status-section document-stats">
        <span class="status-item primary-stat" data-status="words">
          <strong>{{ stats.word }}</strong> {{ t('titleBar.words') }}
        </span>
        <span class="status-separator" aria-hidden="true" />
        <span class="status-item secondary-stat" data-status="characters">
          <strong>{{ stats.character }}</strong> {{ t('titleBar.characters') }}
        </span>
        <span class="status-item tertiary-stat" data-status="paragraphs">
          <strong>{{ stats.paragraph }}</strong> {{ t('titleBar.paragraphs') }}
        </span>
      </div>

      <div class="status-section document-settings">
        <span class="status-item" :title="copy.encoding">
          <span class="visually-hidden">{{ copy.encoding }}</span>
          <span class="status-value" data-status="encoding">{{ encodingLabel }}</span>
        </span>
        <span class="status-item" :title="copy.lineEnding">
          <span class="visually-hidden">{{ copy.lineEnding }}</span>
          <span class="status-value" data-status="line-ending">{{ lineEndingLabel }}</span>
        </span>
      </div>

      <div class="status-spacer" aria-hidden="true" />

      <div class="status-section state-section">
        <span
          class="status-label save-state"
          :class="{ dirty: file && !file.isSaved, empty: !file }"
          data-status="save-state"
          role="status"
          aria-live="polite"
          aria-atomic="true"
          :title="saveTitle"
        >
          <span class="state-dot" aria-hidden="true" />
          {{ saveLabel }}
        </span>
        <span v-if="prefs.autoSave" class="status-hint auto-save" data-status="auto-save">
          {{ autoSaveLabel }}
        </span>
        <span
          v-if="cloudState"
          class="status-label cloud-state"
          :class="cloudState"
          data-status="cloud-state"
          role="status"
        >
          <span class="state-dot" aria-hidden="true" />
          {{ cloudLabel }}
        </span>
        <span class="status-label mode-label" data-status="editor-mode">{{ modeLabel }}</span>
        <span v-if="prefs.focus" class="status-label mode-label" data-status="focus-mode">
          {{ copy.focusMode }}
        </span>
        <span v-if="prefs.typewriter" class="status-label mode-label" data-status="typewriter-mode">
          {{ copy.typewriterMode }}
        </span>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.status-bar {
  box-sizing: border-box;
  container-type: inline-size;
  flex: 0 0 auto;
  min-width: 0;
  height: 28px;
  overflow-x: auto;
  overflow-y: hidden;
  color: var(--mt-fg-muted, #6a737d);
  background: var(--mt-bg);
  border-top: 1px solid var(--mt-border, #e1e4e8);
  font-size: 11px;
  line-height: 1;
  scrollbar-width: none;
  user-select: none;
}

.status-bar::-webkit-scrollbar { display: none; }

.status-content {
  display: flex;
  align-items: center;
  gap: 12px;
  width: max-content;
  min-width: 100%;
  height: 100%;
  padding: 0 19px;
  box-sizing: border-box;
}

.status-section,
.status-item,
.status-label,
.status-hint {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
}

.status-section { gap: 9px; }
.status-item { gap: 4px; white-space: nowrap; }
.status-value,
.status-item strong {
  color: inherit;
  font-weight: 400;
}

.status-separator {
  width: 1px;
  height: 10px;
  background: var(--mt-border, #dfe2e5);
}

.document-settings {
  gap: 6px;
  color: var(--mt-fg-muted, #6a737d);
  font-size: 11px;
}

.status-spacer { flex: 1 0 18px; }

.state-section { gap: 12px; }
.status-label {
  padding: 0;
  border: 0;
  border-radius: 0;
  white-space: nowrap;
  background: transparent;
  cursor: default;
}
.status-hint {
  color: var(--mt-fg-muted, #6a737d);
  white-space: nowrap;
  font-size: 11px;
}

.save-state { gap: 6px; }
.state-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--mt-accent);
}
.save-state.dirty .state-dot { background: var(--mt-warning); }
.save-state.empty .state-dot { background: var(--mt-fg-muted, #8c959f); }
.cloud-state { gap: 6px; }
.cloud-state.pending .state-dot,
.cloud-state.syncing .state-dot { background: var(--mt-info); }
.cloud-state.offline .state-dot { background: var(--mt-fg-muted, #8c959f); }
.cloud-state.conflict .state-dot,
.cloud-state.error .state-dot { background: var(--mt-error); }

.mode-label { gap: 12px; }
.mode-label::before {
  content: '';
  width: 1px;
  height: 10px;
  background: var(--mt-border);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

@container (max-width: 820px) {
  .tertiary-stat,
  .auto-save { display: none; }
}

@container (max-width: 660px) {
  .document-settings,
  .secondary-stat,
  .document-stats .status-separator { display: none; }
  .status-content { gap: 8px; }
}

@container (max-width: 420px) {
  .mode-label:not(:last-child) { display: none; }
}

@media (forced-colors: active) {
  .state-dot { background: CanvasText; }
  .mode-label::before { background: CanvasText; }
}
</style>
