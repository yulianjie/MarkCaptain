<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { useNotebookStore } from '@/stores/notebook'
import { useEditorStore } from '@/stores/editor'
import { localHistoryCapture, localHistoryList, localHistoryRead, localHistorySettings, type LocalVersion, type LocalVersionMetadata } from '@/services/tauri-invoke'
import { createPaneLayoutSnapshot, normalizePaneViewState, parsePaneLayout, type PaneLayout } from '@/services/pane-layouts'
import { getPaneViewState, restorePaneViewState } from '@/services/pane-view-state'
import { t } from '@/i18n'
import { historyDiff } from '@/services/local-history-diff'
import { isHistoryRestoreTargetCurrent } from '@/services/local-history-restore'
const notebook = useNotebookStore(); const editor = useEditorStore()
const versions = ref<LocalVersionMetadata[]>([]); const selected = ref<LocalVersion | null>(null)
let selectionGeneration = 0
async function chooseVersion(version: LocalVersionMetadata) { const generation = ++selectionGeneration; const original = target.value; if (!original) return; await run(async () => { const record = await localHistoryRead(original.path, version.id); if (generation === selectionGeneration && notebook.dialog === 'history') selected.value = record }) }
const failure = ref(''); const working = ref(false); const target = ref<{id: string; path: string; markdown: string} | null>(null)
const settings = ref({ intervalSeconds: 60, retentionDays: 30, maxMegabytes: 256 })
const name = ref(''); const layouts = ref<Record<string, PaneLayout>>({})
const layoutKey = computed(() => `mt:named-layouts:${notebook.root}`)
function snapshot(): PaneLayout {
  return createPaneLayoutSnapshot(editor.splitDirection, editor.splitRatio,
    editor.panes.findIndex(p => p.id === editor.activePaneId), editor.panes, editor.paneSizes, editor.tabs, getPaneViewState)
}
async function run(action: () => Promise<unknown> | unknown) {
  working.value = true; failure.value = ''
  try { await action() } catch(e) { failure.value = String(e) } finally { working.value = false }
}
watch(() => notebook.dialog, async dialog => {
  failure.value = ''; selected.value = null
  if (dialog === 'history') {
    const tab = editor.currentFile; target.value = tab ? { id: tab.id, path: tab.pathname, markdown: tab.markdown } : null
    versions.value = []
    if (tab?.pathname) await run(async () => { versions.value = await localHistoryList(tab.pathname); settings.value = await localHistorySettings() })
  } else if (dialog === 'layouts') {
    try { const raw = JSON.parse(localStorage.getItem(layoutKey.value) ?? '{}'); layouts.value = Object.fromEntries(Object.entries(raw).flatMap(([k,v]) => { const layout = parsePaneLayout(v); return layout ? [[k,layout]] : [] })) } catch { layouts.value = {} }
  }
})
async function restoreCurrent() {
  const current = editor.currentFile; const version = selected.value; const original = target.value
  if (!version || !original || editor.currentFileId !== original.id || !isHistoryRestoreTargetCurrent(current, original)) throw new Error(t('notes.changed'))
  await ElMessageBox.confirm(t('notes.restoreConfirm'), t('notes.history'), { type: 'warning' })
  if (editor.currentFileId !== original.id || !isHistoryRestoreTargetCurrent(editor.currentFile, original)) throw new Error(t('notes.changed'))
  await localHistoryCapture(original.path, original.markdown, true)
  if (editor.currentFileId !== original.id || !isHistoryRestoreTargetCurrent(editor.currentFile, original)) throw new Error(t('notes.changed'))
  editor.applyAgentEdit(original.id, original.markdown, version.markdown)
  notebook.dialog = ''
}
function saveLayout() {
  if (!name.value.trim()) return
  layouts.value = { ...layouts.value, [name.value.trim()]: snapshot() }; localStorage.setItem(layoutKey.value, JSON.stringify(layouts.value)); name.value = ''
}
function removeLayout(key: string) { delete layouts.value[key]; localStorage.setItem(layoutKey.value, JSON.stringify(layouts.value)) }
async function applyLayout(layout: PaneLayout) {
  const originalId = editor.currentFileId
  const documents: (string | null)[] = []
  for (const pane of layout.panes) documents.push(pane.empty ? null : pane.path ? (await editor.openFile(pane.path)).id : originalId)
  const panes = layout.panes.map((p,i) => ({ id: i === 0 ? 'main' : crypto.randomUUID(), documentId: documents[i]!, sourceMode: p.sourceMode }))
  for (const [i, saved] of layout.panes.entries()) {
    const pane = panes[i]!
    const tab = editor.tabs.find(candidate => candidate.id === pane.documentId)
    if (!tab) continue
    const state: { cursor?: unknown | null; sourceSelection?: unknown | null } = {}
    if (Object.prototype.hasOwnProperty.call(saved, 'cursor')) state.cursor = saved.cursor
    if (Object.prototype.hasOwnProperty.call(saved, 'sourceSelection')) state.sourceSelection = saved.sourceSelection
    if (Object.keys(state).length) restorePaneViewState(pane.id, tab.id, normalizePaneViewState(tab.markdown, state))
  }
  editor.panes = panes
  editor.splitDirection = layout.direction; editor.splitRatio = layout.ratio; editor.activePaneId = ''
  editor.paneSizes = Object.fromEntries(editor.panes.map((p,i) => [p.id, layout.sizes?.[i] ?? 1 / editor.panes.length]))
  editor.activatePane(editor.panes[layout.activeIndex ?? 0].id); notebook.dialog = ''
}
</script>
<template>
  <el-dialog :model-value="notebook.dialog === 'history' || notebook.dialog === 'layouts'" :title="t(notebook.dialog === 'history' ? 'notes.history' : 'notes.layouts')" width="min(900px, 90vw)" @close="notebook.dialog = ''">
    <template v-if="notebook.dialog === 'history'">
      <p>{{ t('notes.historyLocal') }}</p><p v-if="!target?.path">{{ t('notes.historySaved') }}</p>
      <div class="history-grid">
        <div class="versions"><button v-for="version in versions" :key="version.id" :class="{ selected: selected?.id === version.id }" @click="chooseVersion(version)">{{ new Date(version.timestamp).toLocaleString() }} · {{ version.size }}</button><p v-if="!versions.length">{{ t('notes.empty') }}</p></div>
        <div v-if="selected" class="diff"><div><strong>{{ t('notes.current') }}</strong><pre>{{ target?.markdown }}</pre></div><div><strong>{{ t('notes.previous') }}</strong><pre>{{ selected.markdown }}</pre></div></div>
      </div>
      <pre v-if="selected" class="history-diff"><div v-for="(line, i) in historyDiff(selected.markdown, target?.markdown ?? '')" :key="i" :style="{ background: line.kind === 'removed' ? '#e6444430' : line.kind === 'added' ? '#22a65530' : 'transparent' }">{{ line.kind === 'removed' ? '−' : line.kind === 'added' ? '+' : ' ' }} {{ line.text }}</div></pre>
      <div v-if="selected" class="actions"><button :disabled="working" @click="run(() => writeText(selected!.markdown))">{{ t('notes.copy') }}</button><button @click="editor.newUntitledTab(selected.markdown); notebook.dialog = ''">{{ t('notes.restoreNew') }}</button><button :disabled="working" @click="run(restoreCurrent)">{{ t('notes.restoreCurrent') }}</button></div>
      <form class="limits" @submit.prevent="run(() => localHistorySettings(settings))"><label>{{ t('notes.interval') }}<input v-model.number="settings.intervalSeconds" type="number" min="5" max="86400"></label><label>{{ t('notes.retention') }}<input v-model.number="settings.retentionDays" type="number" min="1" max="3650"></label><label>{{ t('notes.space') }}<input v-model.number="settings.maxMegabytes" type="number" min="8" max="32768"></label><button :disabled="working">{{ t('notes.save') }}</button></form>
    </template>
    <template v-else-if="notebook.dialog === 'layouts'">
      <form @submit.prevent="run(saveLayout)"><input v-model="name" :placeholder="t('notes.layoutName')" required><button>{{ t('notes.saveLayout') }}</button></form>
      <div v-for="(layout, key) in layouts" :key="key" class="actions"><button :disabled="working" @click="run(() => applyLayout(layout))">{{ key }} · {{ layout.panes.length }}</button><button @click="removeLayout(key)">×</button></div>
    </template>
    <p v-if="failure" role="alert">{{ failure }}</p>
  </el-dialog>
</template>
<style scoped>
.history-grid { display: flex; gap: 12px; }.versions { width: 180px; max-height: 300px; overflow: auto; }.versions button { width: 100%; margin-bottom: 5px; }.diff { display: flex; flex: 1; min-width: 0; gap: 8px; }.diff > div { flex: 1; min-width: 0; }pre { max-height: 300px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--mt-code-bg); padding: 10px; }.actions, .limits { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }input { width: 130px; }button, input { color: var(--mt-fg); background: var(--mt-bg); border: 1px solid var(--mt-border); border-radius: 6px; padding: 6px; }button { cursor: pointer; }.selected { background: var(--mt-row-active); }
</style>
