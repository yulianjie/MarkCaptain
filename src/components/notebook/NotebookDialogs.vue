<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useNotebookStore } from '@/stores/notebook'
import { useEditorStore } from '@/stores/editor'
import { BUILTIN_TEMPLATES, noteStem } from '@/services/notebook'
import { t } from '@/i18n'
const notebook = useNotebookStore(); const editor = useEditorStore()
const query = ref(''); const selected = ref(0); const failure = ref(''); const working = ref(false)
const input = ref<HTMLInputElement | null>(null)
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
  <el-dialog :model-value="['quick','templates','settings'].includes(notebook.dialog)" :title="t(`notes.${notebook.dialog || 'quick'}`)" width="560px" @close="notebook.dialog = ''">
    <div v-if="notebook.dialog === 'quick'" class="note-picker" @keydown="onKey">
      <input ref="input" v-model="query" :placeholder="t('notes.quickHint')" role="combobox" aria-controls="note-results" :aria-expanded="true" :aria-activedescendant="results[selected] ? `note-${selected}` : undefined">
      <p v-if="!notebook.root">{{ t('sideBar.openFolderFirst') }}</p>
      <p v-if="notebook.busy || notebook.indexing">{{ t('notes.indexing') }} <button @click="notebook.cancel">{{ t('notes.cancel') }}</button></p>
      <div id="note-results" role="listbox" class="results">
        <button v-for="(note, i) in results" :id="`note-${i}`" :key="note.path" role="option" :aria-selected="i === selected" :class="{ selected: i === selected }" @click="run(() => editor.openFile(note.path))">
          <strong>{{ note.relative.split('/').pop() }}</strong><small>{{ note.relative }} <span v-if="note.aliases.length"> · {{ note.aliases.join(', ') }}</span></small>
        </button>
      </div>
      <p v-if="!results.length && !notebook.busy">{{ t('notes.empty') }}</p>
      <button v-if="query.trim() && !exact && notebook.root" :disabled="working" @click="run(() => notebook.create(query))">{{ t('notes.create', { name: query }) }}</button>
      <small>{{ t('notes.openHint') }}</small>
    </div>
    <div v-else-if="notebook.dialog === 'templates'" class="results">
      <p v-if="!templateTarget">{{ t('agent.editorNotReady') }}</p>
      <button v-for="(_, key) in BUILTIN_TEMPLATES" :key="key" :disabled="working || !templateTarget" @click="insertTemplate(key)">{{ t(`notes.${key.split(':')[1]}`) }}</button>
      <button v-for="note in notebook.templates" :key="note.path" :disabled="working || !templateTarget" @click="insertTemplate(note.relative)">{{ note.relative }}</button>
    </div>
    <form v-else-if="notebook.dialog === 'settings'" class="note-settings" @submit.prevent="run(() => notebook.saveConfig(settings))">
      <label>{{ t('notes.templateDirectory') }}<input v-model="settings.templateDirectory" required></label>
      <label>{{ t('notes.dailyDirectory') }}<input v-model="settings.dailyDirectory" required></label>
      <label>{{ t('notes.dailyFormat') }}<input v-model="settings.dailyFormat" required></label>
      <label>{{ t('notes.dailyTemplate') }}<select v-model="settings.dailyTemplate"><option value="">{{ t('notes.none') }}</option><option v-for="(_, key) in BUILTIN_TEMPLATES" :key="key" :value="key">{{ t(`notes.${key.split(':')[1]}`) }}</option><option v-for="note in notebook.templates" :key="note.path" :value="note.relative">{{ note.relative }}</option></select></label>
      <small>{{ t('notes.variables') }}</small><button :disabled="working || !notebook.root" type="submit">{{ t('notes.save') }}</button>
    </form>
    <p v-if="failure || notebook.error" role="alert">{{ failure || notebook.error }}</p>
  </el-dialog>
</template>
<style scoped>
input, select { box-sizing: border-box; width: 100%; padding: 9px; background: var(--mt-bg); color: var(--mt-fg); border: 1px solid var(--mt-border); border-radius: 6px; }
.results { max-height: 380px; overflow: auto; margin: 10px 0; }
.results button { width: 100%; text-align: left; display: flex; flex-direction: column; padding: 10px; border: 0; background: transparent; color: var(--mt-fg); cursor: pointer; }
.results button:hover, .results button.selected { background: var(--mt-row-active); }
small { display: block; color: var(--mt-fg-muted); overflow-wrap: anywhere; }
.note-settings { display: grid; gap: 12px; }
</style>
