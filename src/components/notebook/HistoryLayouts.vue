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
import { Clock3, PanelsTopLeft, Trash2, ArrowUpRight } from '@lucide/vue'
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
  <el-dialog :model-value="notebook.dialog === 'history' || notebook.dialog === 'layouts'" :title="t(notebook.dialog === 'history' ? 'notes.history' : 'notes.layouts')" width="min(1040px, 94vw)" top="5vh" class="history-layouts-dialog" @close="notebook.dialog = ''">
    <template v-if="notebook.dialog === 'history'">
      <p class="history-intro">{{ t('notes.historyLocal') }}</p><p v-if="!target?.path" class="history-notice">{{ t('notes.historySaved') }}</p>
      <p v-if="target?.path" class="history-target">{{ target.path }}</p>
      <div class="history-grid">
        <div class="versions"><button v-for="version in versions" :key="version.id" :class="{ selected: selected?.id === version.id }" :aria-pressed="selected?.id === version.id" @click="chooseVersion(version)"><Clock3 :size="14" aria-hidden="true" /><span><strong>{{ new Date(version.timestamp).toLocaleString() }}</strong><small>{{ version.size }} B</small></span></button><p v-if="!versions.length" class="empty-state">{{ t('notes.empty') }}</p></div>
        <div v-if="selected" class="diff"><div><strong>{{ t('notes.current') }}</strong><pre>{{ target?.markdown }}</pre></div><div><strong>{{ t('notes.previous') }}</strong><pre>{{ selected.markdown }}</pre></div></div>
        <div v-else class="history-placeholder"><Clock3 :size="30" aria-hidden="true" /><p>{{ t('notes.history') }}</p></div>
      </div>
      <pre v-if="selected" class="history-diff"><div v-for="(line, i) in historyDiff(selected.markdown, target?.markdown ?? '')" :key="i" :class="`diff-${line.kind}`"><span aria-hidden="true">{{ line.kind === 'removed' ? '−' : line.kind === 'added' ? '+' : ' ' }}</span>{{ line.text }}</div></pre>
      <details class="history-settings"><summary>{{ t('notes.history') }} · {{ t('notes.settings') }}</summary><form class="limits" @submit.prevent="run(() => localHistorySettings(settings))"><label>{{ t('notes.interval') }}<input v-model.number="settings.intervalSeconds" type="number" min="5" max="86400"></label><label>{{ t('notes.retention') }}<input v-model.number="settings.retentionDays" type="number" min="1" max="3650"></label><label>{{ t('notes.space') }}<input v-model.number="settings.maxMegabytes" type="number" min="8" max="32768"></label><button :disabled="working">{{ t('notes.save') }}</button></form></details>
    </template>
    <template v-else-if="notebook.dialog === 'layouts'">
      <form class="save-layout" @submit.prevent="run(saveLayout)"><input v-model="name" :aria-label="t('notes.layoutName')" :placeholder="t('notes.layoutName')" required><button class="primary" :disabled="working">{{ t('notes.saveLayout') }}</button></form>
      <div class="layout-list"><div v-for="(layout, key) in layouts" :key="key" class="layout-row"><PanelsTopLeft :size="20" aria-hidden="true" /><button :disabled="working" class="layout-name" @click="run(() => applyLayout(layout))"><strong>{{ key }}</strong><small>{{ t('notes.layouts') }} · {{ layout.panes.length }}</small></button><button class="layout-open" :disabled="working" :aria-label="`${t('notes.layouts')}: ${key}`" @click="run(() => applyLayout(layout))"><ArrowUpRight :size="16" aria-hidden="true" /></button><button :aria-label="`${t('common.delete')}: ${key}`" class="remove-layout" @click="removeLayout(key)"><Trash2 :size="15" aria-hidden="true" /></button></div></div>
      <p v-if="!Object.keys(layouts).length" class="empty-state">{{ t('notes.empty') }}</p>
    </template>
    <p v-if="failure" class="history-error" role="alert">{{ failure }}</p>
    <template #footer>
      <div v-if="notebook.dialog === 'history' && selected" class="history-footer"><button :disabled="working" @click="run(() => writeText(selected!.markdown))">{{ t('notes.copy') }}</button><button :disabled="working" @click="editor.newUntitledTab(selected.markdown); notebook.dialog = ''">{{ t('notes.restoreNew') }}</button><button class="primary" :disabled="working" @click="run(restoreCurrent)">{{ t('notes.restoreCurrent') }}</button></div>
    </template>
  </el-dialog>
</template>
<style scoped>
:global(.history-layouts-dialog.el-dialog) { max-height: 90dvh; display: flex; flex-direction: column; }
:global(.history-layouts-dialog .el-dialog__body) { min-height: 0; overflow: auto; color: var(--mt-fg); }
:global(.history-layouts-dialog .el-dialog__footer) { flex-shrink: 0; }
.history-intro { margin: 0 0 9px; color: var(--mt-fg-muted); font-size: 12px; line-height: 1.7; }
.history-target { margin: 0 0 20px; font-size: 11px; overflow-wrap: anywhere; color: var(--mt-fg-muted); }
.history-notice { color: var(--mt-warning); font-size: 12px; }
.history-grid { display: grid; grid-template-columns: 205px minmax(0, 1fr); gap: 20px; min-height: 220px; }
.versions { max-height: 340px; overflow: auto; padding-right: 12px; border-right: 1px solid var(--mt-border); scrollbar-width: thin; }
.versions button { display: flex; align-items: flex-start; gap: 9px; text-align: left; width: 100%; margin-bottom: 5px; padding: 10px; border: 0; background: transparent; }
.versions button > svg { flex-shrink: 0; margin-top: 3px; color: var(--mt-fg-muted); }
.versions button strong { display: block; font-size: 11px; line-height: 1.7; font-weight: 500; }
.versions button small { display: block; font-size: 10px; color: var(--mt-fg-muted); margin-top: 4px; }
.versions button.selected { color: var(--mt-accent); background: var(--mt-accent-soft); }
.diff { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; min-width: 0; }
.diff > div { display: flex; flex-direction: column; min-width: 0; }
.diff > div > strong { padding: 0 2px 9px; color: var(--mt-fg-muted); font-size: 11px; font-weight: 500; }
pre { margin: 0; max-height: 310px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--mt-surface); border: 1px solid var(--mt-border); border-radius: 7px; padding: 13px; font: 12px/1.8 'Cascadia Code', Consolas, monospace; }
.diff pre { flex: 1; }
.history-placeholder { min-height: 220px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; color: var(--mt-fg-muted); background: var(--mt-surface); border: 1px dashed var(--mt-border); border-radius: 8px; }
.history-placeholder svg { stroke-width: 1.2; color: var(--mt-accent); opacity: .6; }
.history-placeholder p { font-size: 12px; }
.history-diff { margin-top: 18px; padding: 9px 0; background: var(--mt-bg); }
.history-diff > div { display: flex; align-items: flex-start; padding: 1px 12px; }
.history-diff > div > span { flex: 0 0 24px; color: var(--mt-fg-muted); user-select: none; }
.diff-removed { background: var(--mt-error-soft); color: var(--mt-error); }
.diff-added { background: var(--mt-success-soft); color: var(--mt-success); }
.history-settings { margin-top: 20px; padding-top: 15px; border-top: 1px solid var(--mt-border); }
.history-settings summary { cursor: pointer; color: var(--mt-fg-muted); font-size: 12px; }
.limits { display: grid; align-items: end; grid-template-columns: repeat(3, minmax(0, 1fr)) auto; gap: 12px; margin-top: 16px; }
.limits label { display: grid; gap: 7px; font-size: 11px; color: var(--mt-fg-muted); }
button, input { box-sizing: border-box; min-width: 0; color: var(--mt-fg); font: inherit; background: var(--mt-surface-raised); border: 1px solid var(--mt-border); border-radius: 6px; padding: 8px 11px; }
input { width: 100%; }
button { cursor: pointer; }
button:hover { background: var(--mt-row-hover); }
.primary { color: var(--mt-text-on-accent); background: var(--mt-accent); border-color: var(--mt-accent); }
.primary:hover { background: var(--mt-accent); filter: brightness(1.08); }
.history-footer { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
.save-layout { display: flex; gap: 10px; margin: 0 0 24px; }
.save-layout input { flex: 1; }
.save-layout button { flex-shrink: 0; }
.layout-row { display: flex; align-items: center; gap: 12px; padding: 15px 2px; border-bottom: 1px solid var(--mt-border); }
.layout-row > svg { color: var(--mt-accent); flex-shrink: 0; }
.layout-name { display: flex; flex-direction: column; gap: 5px; flex: 1; min-width: 0; text-align: left; padding: 0; border: 0; background: transparent; overflow-wrap: anywhere; }
.layout-name strong { font-size: 13px; font-weight: 500; }
.layout-name small { font-size: 11px; color: var(--mt-fg-muted); }
.layout-open, .remove-layout { display: grid; place-items: center; border: 0; background: transparent; padding: 7px; color: var(--mt-fg-muted); }
.remove-layout:hover { color: var(--mt-error); background: var(--mt-error-soft); }
.empty-state { padding: 25px 10px; text-align: center; color: var(--mt-fg-muted); font-size: 12px; }
.history-error { padding: 10px 12px; border-radius: 7px; color: var(--mt-error); background: var(--mt-error-soft); overflow-wrap: anywhere; }
button:disabled { opacity: .45; cursor: default; }
button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--mt-accent); outline-offset: 2px; }
@media (max-width: 750px) { .history-grid { grid-template-columns: minmax(0, 1fr); gap: 16px; } .versions { display: flex; gap: 6px; max-height: 125px; padding: 0 0 12px; border-right: 0; border-bottom: 1px solid var(--mt-border); } .versions button { flex: 0 0 165px; } .limits { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 500px) { .diff { grid-template-columns: minmax(0, 1fr); } .save-layout { flex-wrap: wrap; } .save-layout input { flex-basis: 100%; } .save-layout button { margin-left: auto; } .history-footer button { padding: 7px 9px; font-size: 12px; } }
</style>
