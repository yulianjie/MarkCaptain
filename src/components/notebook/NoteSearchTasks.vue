<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useNotebookStore } from '@/stores/notebook'
import { useEditorStore } from '@/stores/editor'
import { analyzeNote, type NoteTask } from '@/services/note-index'
import { t } from '@/i18n'
import { Hash, Search, CheckSquare, ArrowUpRight } from '@lucide/vue'
const props = defineProps<{ mode: 'search' | 'tasks' | 'tags' }>()
const notebook = useNotebookStore(); const editor = useEditorStore()
const query = ref(''); const paths = ref<string[]>([]); const total = ref(0); const error = ref(''); const busy = ref(false)
const worker = new Worker(new URL('../../services/structured-search.worker.ts', import.meta.url), { type: 'module' })
let generation = 0
worker.onmessage = event => { if (event.data.id !== generation) return; busy.value = false; paths.value = event.data.paths ?? []; total.value = event.data.total ?? 0; error.value = event.data.error ? t(event.data.error, { field: event.data.detail }) : '' }
worker.onerror = () => { generation++; busy.value = false; paths.value = []; total.value = 0; error.value = t('notes.queryFailed') }
function search() { busy.value = true; error.value = ''; paths.value = []; total.value = 0; worker.postMessage({ id: ++generation, query: query.value, notes: notebook.analyses }) }
function cancelSearch() { worker.postMessage({ id: ++generation, cancel: true }); busy.value = false; paths.value = []; total.value = 0; error.value = '' }
watch(() => notebook.analyses, () => { if (query.value) search() })
const counts = computed(() => {
  const map = new Map<string, number>()
  for (const note of notebook.analyses) {
    const tags = new Set<string>()
    for (const tag of note.tags) { const parts = tag.split('/'); for (let i = 1; i <= parts.length; i++) tags.add(parts.slice(0,i).join('/')) }
    for (const tag of tags) map.set(tag, (map.get(tag) ?? 0) + 1)
  }
  return [...map.entries()].sort((a,b) => a[0].localeCompare(b[0]))
})
const tasks = computed(() => notebook.analyses.flatMap(note => note.tasks.filter(t => !t.checked).map(task => ({ relative: note.relative, task }))).slice(0, 1000))
async function toggle(relative: string, task: NoteTask) {
  error.value = ''
  try {
    const note = notebook.liveNotes.find(n => n.relative === relative); if (!note) throw new Error('notes.changed')
    const snapshot = note.markdown
    const tab = await editor.openFile(note.path); await nextTick()
    const current = analyzeNote(relative, tab.markdown).tasks.find(t => t.from === task.from && t.text === task.text && t.checked === task.checked)
    if (!current || tab.markdown !== snapshot) throw new Error('notes.changed')
    editor.applyAgentEdit(tab.id, snapshot, snapshot.slice(0, current.from) + (current.checked ? ' ' : 'x') + snapshot.slice(current.to))
    await notebook.reveal(relative, current.from, current.to)
  } catch(e) { const message = e instanceof Error ? e.message : String(e); error.value = t(message.startsWith('agent:') ? message.replace(':', '.') : message) }
}
function filterTag(tag: string) { query.value = `tag:"${tag}"`; notebook.panel = 'search'; search() }
onBeforeUnmount(() => { generation++; worker.terminate() })
</script>
<template>
  <div class="note-search-tasks">
    <template v-if="props.mode === 'tags'">
      <div class="list-heading"><Hash :size="14" aria-hidden="true" /><span>{{ t('notes.tags') }}</span><span>{{ counts.length }}</span></div>
      <div class="result-list tag-list">
        <button v-for="[tag, count] in counts" :key="tag" class="result tag-result" :style="{ paddingLeft: `${8 + (tag.split('/').length - 1) * 12}px` }" @click="filterTag(tag)"><span>#{{ tag }}</span><small>{{ count }}</small><ArrowUpRight :size="12" aria-hidden="true" /></button>
        <p v-if="!counts.length" class="empty-state">{{ t('notes.empty') }}</p>
      </div>
    </template>
    <template v-if="props.mode === 'search'">
      <form class="query-form" @submit.prevent="search"><input v-model="query" :aria-label="t('notes.search')" :placeholder="t('notes.queryHint')"><button class="search-submit"><Search :size="13" aria-hidden="true" />{{ t('notes.search') }}</button><button v-if="busy" type="button" @click="cancelSearch">{{ t('notes.cancel') }}</button></form>
      <details class="query-help"><summary>{{ t('notes.querySyntax') }}</summary><p>{{ t('notes.queryHelp') }}</p></details>
      <p class="result-count" role="status" aria-live="polite">{{ total }} {{ t('notes.results') }}</p>
      <div class="result-list"><button v-for="path in paths" :key="path" class="result search-result" @click="notebook.reveal(path, 0)"><span><strong>{{ path.split('/').pop() }}</strong><small>{{ path }}</small></span><ArrowUpRight :size="13" aria-hidden="true" /></button></div>
    </template>
    <template v-if="props.mode === 'tasks'">
      <div class="list-heading"><CheckSquare :size="14" aria-hidden="true" /><span>{{ t('notes.tasks') }}</span><span>{{ tasks.length }}</span></div>
      <p class="task-hint">{{ t('notes.taskHint') }}</p>
      <div class="result-list"><div v-for="(item, i) in tasks" :key="`${item.relative}:${i}`" class="result task-result"><input type="checkbox" :aria-label="t('notes.completeTask')" :checked="false" @change="toggle(item.relative, item.task)"><button @click="notebook.reveal(item.relative, item.task.from, item.task.to)"><span>{{ item.task.text }}</span><small>{{ item.relative }}:{{ item.task.line }}</small></button></div><p v-if="!tasks.length" class="empty-state">{{ t('notes.empty') }}</p></div>
    </template>
    <p v-if="error" class="query-error" role="alert">{{ error }}</p>
  </div>
</template>
<style scoped>
.note-search-tasks { display: flex; flex: 1; flex-direction: column; min-height: 0; padding-top: 15px; }
.list-heading { display: flex; align-items: center; gap: 7px; color: var(--mt-fg-muted); font-size: 11px; margin-bottom: 10px; }
.list-heading > span:last-child { margin-left: auto; font-variant-numeric: tabular-nums; }
.query-form { display: flex; flex-wrap: wrap; gap: 7px; }
.query-form input { min-width: 100%; flex: 1; padding: 9px 10px; background: var(--mt-surface-raised); }
button, input { box-sizing: border-box; font: inherit; background: transparent; color: var(--mt-fg); border: 1px solid var(--mt-border); border-radius: 6px; padding: 6px 9px; }
button { cursor: pointer; text-align: left; }
button:hover { background: var(--mt-row-hover); }
.search-submit { display: flex; align-items: center; gap: 6px; color: var(--mt-accent); background: var(--mt-accent-soft); border-color: transparent; }
.query-help { margin-top: 12px; color: var(--mt-fg-muted); font-size: 11px; }
.query-help summary { cursor: pointer; }
.query-help p { padding: 8px 10px; background: var(--mt-surface); border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; }
.result-count { color: var(--mt-fg-muted); font-size: 11px; padding-bottom: 10px; margin: 14px 0 4px; border-bottom: 1px solid var(--mt-border); }
.result-list { min-height: 0; flex: 1; overflow: auto; scrollbar-width: thin; }
small { display: block; color: var(--mt-fg-muted); font-size: 11px; line-height: 1.6; overflow-wrap: anywhere; }
.result { display: flex; align-items: flex-start; gap: 8px; padding: 11px 7px; width: 100%; box-sizing: border-box; overflow-wrap: anywhere; border: 0; border-bottom: 1px solid var(--mt-border); border-radius: 0; }
.result > svg { flex-shrink: 0; color: var(--mt-fg-muted); margin-top: 3px; }
.result > span { min-width: 0; flex: 1; }
.result strong { display: block; font-size: 12px; font-weight: 500; margin-bottom: 4px; }
.tag-result { align-items: center; border-bottom: 0; border-radius: 6px; margin-bottom: 3px; padding-top: 8px; padding-bottom: 8px; }
.tag-result small { font-variant-numeric: tabular-nums; margin-left: auto; }
.tag-result > svg { opacity: 0; margin: 0; }
.tag-result:hover > svg, .tag-result:focus-visible > svg { opacity: 1; }
.task-hint { margin: 0 0 11px; color: var(--mt-fg-muted); font-size: 11px; line-height: 1.7; }
.task-result input { flex: 0 0 auto; margin: 5px 0 0; accent-color: var(--mt-accent); }
.task-result button { flex: 1; min-width: 0; padding: 0; border: 0; background: transparent; line-height: 1.7; }
.task-result small { margin-top: 5px; }
.task-result:hover { background: var(--mt-row-hover); }
.empty-state { padding: 24px 10px; color: var(--mt-fg-muted); text-align: center; font-size: 11px; }
.query-error { margin: 12px 0 0; padding: 10px; border-radius: 6px; background: var(--mt-error-soft); color: var(--mt-error); overflow-wrap: anywhere; }
button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--mt-accent); outline-offset: 2px; }
</style>
