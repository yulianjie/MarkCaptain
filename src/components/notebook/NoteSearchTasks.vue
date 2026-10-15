<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useNotebookStore } from '@/stores/notebook'
import { useEditorStore } from '@/stores/editor'
import { analyzeNote, type NoteTask } from '@/services/note-index'
import { t } from '@/i18n'
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
  <div>
    <template v-if="props.mode === 'tags'"><button v-for="[tag, count] in counts" :key="tag" class="result" :style="{ paddingLeft: `${6 + (tag.split('/').length - 1) * 10}px` }" @click="filterTag(tag)">#{{ tag }} <small>{{ count }}</small></button></template>
    <template v-if="props.mode === 'search'">
      <form @submit.prevent="search"><input v-model="query" :placeholder="t('notes.queryHint')"><button>{{ t('notes.search') }}</button><button v-if="busy" type="button" @click="cancelSearch">{{ t('notes.cancel') }}</button></form>
      <details><summary>{{ t('notes.querySyntax') }}</summary><p>{{ t('notes.queryHelp') }}</p></details><p>{{ total }} {{ t('notes.results') }}</p>
      <button v-for="path in paths" :key="path" class="result" @click="notebook.reveal(path, 0)">{{ path }}</button>
    </template>
    <template v-if="props.mode === 'tasks'"><p>{{ t('notes.taskHint') }}</p><div v-for="(item, i) in tasks" :key="`${item.relative}:${i}`" class="result"><input type="checkbox" :aria-label="t('notes.completeTask')" :checked="false" @change="toggle(item.relative, item.task)"><button @click="notebook.reveal(item.relative, item.task.from, item.task.to)">{{ item.task.text }}<small>{{ item.relative }}:{{ item.task.line }}</small></button></div></template>
    <p v-if="error" role="alert">{{ error }}</p>
  </div>
</template>
<style scoped>
form { display: flex; flex-wrap: wrap; gap: 5px; }form input { min-width: 0; flex: 1; }button, input { background: transparent; color: var(--mt-fg); border: 1px solid var(--mt-border); border-radius: 6px; padding: 6px; }button { cursor: pointer; text-align: left; }small { display: block; color: var(--mt-fg-muted); }.result { display: flex; align-items: center; gap: 6px; padding: 5px; width: 100%; box-sizing: border-box; overflow-wrap: anywhere; }.result button { flex: 1; min-width: 0; }details { margin-top: 10px; }
</style>
