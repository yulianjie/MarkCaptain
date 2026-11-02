<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useNotebookStore } from '@/stores/notebook'
import { useEditorStore } from '@/stores/editor'
import { BUILTIN_TEMPLATES, noteStem } from '@/services/notebook'
import { t } from '@/i18n'
import { Search, FileText, ArrowUpRight, Plus } from '@lucide/vue'
const notebook = useNotebookStore(); const editor = useEditorStore()
const query = ref(''); const selected = ref(0); const failure = ref(''); const working = ref(false)
const input = ref<HTMLInputElement | null>(null)
const resultsList = ref<HTMLElement | null>(null)
interface TemplateTarget { paneId: string; id: string; sourceMode: boolean; markdown: string; cursor: string }
const templateTarget = ref<TemplateTarget | null>(null)
const settings = ref({ ...notebook.config })
const results = computed(() => notebook.quickResults(query.value))
const exact = computed(() => results.value.some(n => [noteStem(n.relative), noteStem(n.relative.split('/').pop()!), ...n.aliases].some(v => v.toLocaleLowerCase() === query.value.trim().toLocaleLowerCase())))
function cursorSnapshot(tab: NonNullable<typeof editor.currentFile>, sourceMode: boolean) {
  return JSON.stringify(sourceMode ? tab.sourceSelection ?? null : tab.cursor ?? null) ?? 'null'
}
function captureTemplateTarget(): TemplateTarget | null {
  editor.captureCurrentViewState()
  const tab = editor.currentFile
  const sourceMode = editor.sourceCodeMode
  if (!tab || (sourceMode ? tab.sourceSelection == null : tab.cursor == null)) return null
  return { paneId: editor.activePaneId, id: tab.id, sourceMode, markdown: tab.markdown, cursor: cursorSnapshot(tab, sourceMode) }
}
function assertTemplateTarget(target: TemplateTarget | null) {
  if (!target || templateTarget.value !== target || notebook.dialog !== 'templates' || editor.activePaneId !== target.paneId || editor.currentFileId !== target.id || editor.sourceCodeMode !== target.sourceMode) throw new Error('notes.changed')
  const pane = editor.panes.find(p => p.id === target.paneId)
  const tab = editor.tabs.find(t => t.id === target.id)
  editor.captureCurrentViewState()
  if (!pane || pane.documentId !== target.id || !tab || tab.markdown !== target.markdown || cursorSnapshot(tab, target.sourceMode) !== target.cursor) throw new Error('notes.changed')
}
function errorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'cancel' || message === 'close') return ''
  if (message.startsWith('notes.')) return t(message)
  if (message.startsWith('agent:')) return t(message.replace(':', '.'))
  return message
}
watch(() => notebook.dialog, async dialog => {
  query.value = ''; selected.value = 0; failure.value = ''
  templateTarget.value = dialog === 'templates' ? captureTemplateTarget() : null
  settings.value = { ...notebook.config }; if (dialog === 'quick') { await nextTick(); input.value?.focus() }
})
watch(query, () => { selected.value = 0 })
watch([selected, results], () => { resultsList.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }) }, { flush: 'post' })
async function run(action: () => Promise<unknown>) {
  working.value = true; failure.value = ''
  try { await action(); notebook.dialog = '' } catch(e) { failure.value = errorMessage(e) }
  finally { working.value = false }
}
function openSelected() {
  const note = results.value[selected.value]
  if (note) void run(() => editor.openFile(note.path))
  else if (query.value.trim()) void run(() => notebook.create(query.value))
}
function onKey(event: KeyboardEvent) {
  if (event.isComposing) return
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); selected.value = Math.max(0, Math.min(results.value.length - 1, selected.value + (event.key === 'ArrowDown' ? 1 : -1))) }
  else if (event.key === 'Enter') { event.preventDefault(); openSelected() }
}
function insertTemplate(key: string) {
  const target = templateTarget.value
  if (!target || working.value) return
  void run(async () => {
    assertTemplateTarget(target)
    const tab = editor.tabs.find(t => t.id === target.id)
    if (!tab) throw new Error('notes.changed')
    const text = await notebook.templateContent(key, noteStem(tab.filename))
    assertTemplateTarget(target)
    await editor.insertText(target.id, text, { paneId: target.paneId, sourceMode: target.sourceMode })
  })
}
</script>
<template>
  <el-dialog :model-value="['quick','templates','settings'].includes(notebook.dialog)" :title="t(`notes.${notebook.dialog || 'quick'}`)" width="min(600px, 94vw)" top="12vh" class="notebook-dialog" @close="notebook.dialog = ''">
    <div v-if="notebook.dialog === 'quick'" class="note-picker" @keydown="onKey">
      <label class="quick-search"><Search :size="17" aria-hidden="true" /><input ref="input" v-model="query" :aria-label="t('notes.quick')" :placeholder="t('notes.quickHint')" role="combobox" aria-controls="note-results" :aria-expanded="true" :aria-activedescendant="results[selected] ? `note-${selected}` : undefined"></label>
      <p v-if="!notebook.root" class="picker-notice">{{ t('sideBar.openFolderFirst') }}</p>
      <p v-if="notebook.busy || notebook.indexing" class="picker-notice" role="status">{{ t('notes.indexing') }} <button @click="notebook.cancel">{{ t('notes.cancel') }}</button></p>
      <div id="note-results" ref="resultsList" role="listbox" class="results">
        <button v-for="(note, i) in results" :id="`note-${i}`" :key="note.path" role="option" :aria-selected="i === selected" :class="{ selected: i === selected }" @click="run(() => editor.openFile(note.path))">
          <FileText :size="16" aria-hidden="true" /><span><strong>{{ note.relative.split('/').pop() }}</strong><small>{{ note.relative }} <span v-if="note.aliases.length"> · {{ note.aliases.join(', ') }}</span></small></span><ArrowUpRight :size="14" class="result-arrow" aria-hidden="true" />
        </button>
      </div>
      <p v-if="!results.length && !notebook.busy" class="picker-empty">{{ t('notes.empty') }}</p>
      <button v-if="query.trim() && !exact && notebook.root" class="create-note" :disabled="working" @click="run(() => notebook.create(query))"><Plus :size="14" aria-hidden="true" />{{ t('notes.create', { name: query }) }}</button>
      <small class="picker-footer">{{ t('notes.openHint') }}</small>
    </div>
    <div v-else-if="notebook.dialog === 'templates'" class="results template-results">
      <p v-if="!templateTarget">{{ t('agent.editorNotReady') }}</p>
      <button v-for="(_, key) in BUILTIN_TEMPLATES" :key="key" :disabled="working || !templateTarget" @click="insertTemplate(key)"><FileText :size="16" aria-hidden="true" /><span>{{ t(`notes.${key.split(':')[1]}`) }}</span><ArrowUpRight :size="14" aria-hidden="true" /></button>
      <button v-for="note in notebook.templates" :key="note.path" :disabled="working || !templateTarget" @click="insertTemplate(note.relative)"><FileText :size="16" aria-hidden="true" /><span>{{ note.relative }}</span><ArrowUpRight :size="14" aria-hidden="true" /></button>
    </div>
    <form v-else-if="notebook.dialog === 'settings'" class="note-settings" @submit.prevent="run(() => notebook.saveConfig(settings))">
      <label>{{ t('notes.templateDirectory') }}<input v-model="settings.templateDirectory" required></label>
      <label>{{ t('notes.dailyDirectory') }}<input v-model="settings.dailyDirectory" required></label>
      <label>{{ t('notes.dailyFormat') }}<input v-model="settings.dailyFormat" required></label>
      <label>{{ t('notes.dailyTemplate') }}<select v-model="settings.dailyTemplate"><option value="">{{ t('notes.none') }}</option><option v-for="(_, key) in BUILTIN_TEMPLATES" :key="key" :value="key">{{ t(`notes.${key.split(':')[1]}`) }}</option><option v-for="note in notebook.templates" :key="note.path" :value="note.relative">{{ note.relative }}</option></select></label>
      <small>{{ t('notes.variables') }}</small><button :disabled="working || !notebook.root" type="submit" class="primary">{{ t('notes.save') }}</button>
    </form>
    <p v-if="failure || notebook.error" class="dialog-error" role="alert">{{ failure || notebook.error }}</p>
  </el-dialog>
</template>
<style scoped>
:global(.notebook-dialog .el-dialog__body) { max-height: 70dvh; overflow: auto; color: var(--mt-fg); }
input, select { box-sizing: border-box; width: 100%; min-width: 0; padding: 10px 11px; font: inherit; background: var(--mt-surface-raised); color: var(--mt-fg); border: 1px solid var(--mt-border); border-radius: 7px; }
button { font: inherit; cursor: pointer; color: var(--mt-fg); }
.quick-search { display: flex; gap: 10px; align-items: center; min-height: 44px; padding: 0 12px; border: 1px solid var(--mt-border); border-radius: 8px; background: var(--mt-surface-raised); color: var(--mt-fg-muted); }
.quick-search:focus-within { outline: 2px solid var(--mt-accent); outline-offset: 2px; }
.quick-search input { padding: 10px 0; border: 0; outline: 0; background: transparent; font-size: 14px; }
.results { max-height: min(420px, 46dvh); overflow: auto; margin: 14px 0; scrollbar-width: thin; }
.results button { width: 100%; text-align: left; display: flex; align-items: center; gap: 11px; padding: 13px 10px; border: 0; border-radius: 7px; background: transparent; color: var(--mt-fg); cursor: pointer; margin-bottom: 3px; }
.results button > svg { flex: 0 0 auto; color: var(--mt-fg-muted); stroke-width: 1.5; }
.results button > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.results button strong { font-size: 13px; font-weight: 500; }
.results button small { margin-top: 4px; font-size: 11px; line-height: 1.6; }
.results button:hover { background: var(--mt-row-hover); }
.results button.selected { background: var(--mt-accent-soft); color: var(--mt-accent); }
.result-arrow { opacity: 0; }
.results button:hover .result-arrow, .results button.selected .result-arrow { opacity: 1; }
small { display: block; color: var(--mt-fg-muted); overflow-wrap: anywhere; }
.picker-footer { border-top: 1px solid var(--mt-border); padding: 13px 2px 0; margin-top: 12px; font-size: 11px; }
.picker-empty { padding: 26px 12px; text-align: center; color: var(--mt-fg-muted); }
.picker-notice { display: flex; gap: 10px; justify-content: space-between; color: var(--mt-fg-muted); font-size: 12px; line-height: 1.7; }
.picker-notice button { background: transparent; border: 0; color: var(--mt-accent); }
.create-note { display: flex; align-items: center; gap: 7px; width: 100%; padding: 10px 12px; text-align: left; border: 1px dashed var(--mt-border); border-radius: 7px; background: var(--mt-surface); color: var(--mt-accent); overflow-wrap: anywhere; }
.note-settings { display: grid; gap: 18px; padding: 4px 0; }
.note-settings label { display: grid; gap: 7px; font-size: 12px; color: var(--mt-fg-muted); }
.note-settings small { font-size: 11px; line-height: 1.7; }
.primary { justify-self: end; border: 1px solid var(--mt-accent); border-radius: 7px; background: var(--mt-accent); color: var(--mt-text-on-accent); padding: 8px 20px; }
.dialog-error { border: 1px solid var(--mt-border); padding: 10px 12px; border-radius: 7px; color: var(--mt-error); background: var(--mt-error-soft); overflow-wrap: anywhere; }
button:disabled { opacity: .45; cursor: default; }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--mt-accent); outline-offset: 2px; }
.quick-search input:focus-visible { outline: 0; }
</style>
