<script setup lang="ts">
import { useNotebookStore } from '@/stores/notebook'
import { t } from '@/i18n'
import { computed } from 'vue'
import NoteProperties from './NoteProperties.vue'
import NoteSearchTasks from './NoteSearchTasks.vue'
const notebook = useNotebookStore()
const searchMode = computed(() => notebook.panel === 'tags' || notebook.panel === 'tasks' ? notebook.panel : 'search')
const outgoing = computed(() => notebook.currentAnalysis?.links.filter(link => !link.referenceDefinition) ?? [])
const tabs = ['links', 'tags', 'properties', 'search', 'tasks'] as const
</script>
<template>
  <div class="notebook-panel">
    <header><select v-model="notebook.panel" :aria-label="t('notes.panel')"><option v-for="tab in tabs" :key="tab" :value="tab">{{ t(`notes.${tab}`) }}</option></select><button :title="t('notes.rebuild')" @click="notebook.rebuild(true)">↻</button><button :title="t('notes.quick')" @click="notebook.dialog = 'quick'">⌕</button></header>
    <div v-if="notebook.busy || notebook.indexing || notebook.relationsBusy">{{ t('notes.indexing') }} <button @click="notebook.cancel">{{ t('notes.cancel') }}</button></div>
    <p v-if="!notebook.root">{{ t('sideBar.openFolderFirst') }}</p>
    <template v-if="notebook.panel === 'links'">
      <h4>{{ t('notes.backlinks') }}</h4>
      <button v-for="(item, i) in notebook.backlinks" :key="i" class="result" @click="notebook.reveal(item.note.relative, item.link.from, item.link.to)"><strong>{{ item.note.relative }}:{{ item.link.line }}</strong><small>{{ item.context }}</small></button>
      <p v-if="!notebook.backlinks.length">{{ t('notes.empty') }}</p>
      <h4>{{ t('notes.mentions') }}</h4>
      <button v-for="(item, i) in notebook.mentions" :key="i" class="result" @click="notebook.reveal(item.note.relative, item.from, item.to)"><strong>{{ item.note.relative }}:{{ item.line }}</strong><small>{{ item.context }}</small></button>
      <h4>{{ t('notes.outgoing') }}</h4>
      <button v-for="(link, i) in outgoing" :key="i" class="result" @click="notebook.followLink(notebook.currentAnalysis!.relative, link).catch(e => notebook.error = String(e))">{{ link.target }}</button>
    </template>
    <NoteProperties v-if="notebook.panel === 'properties'" />
    <NoteSearchTasks v-if="['tags','search','tasks'].includes(notebook.panel)" :mode="searchMode" />
    <p v-if="notebook.error" role="alert">{{ notebook.error }}</p>
    <details v-if="notebook.notes.some(n => n.error)"><summary>{{ t('notes.indexIncomplete') }}</summary><p v-for="note in notebook.notes.filter(n => n.error).slice(0,20)" :key="note.path">{{ note.relative }}: {{ note.error }}</p></details>
  </div>
</template>
<style scoped>
.notebook-panel { overflow: auto; height: 100%; padding: 10px; box-sizing: border-box; font-size: 12px; }header { display: flex; gap: 6px; }select { min-width: 0; flex: 1; }button, select { background: transparent; color: var(--mt-fg); border: 1px solid var(--mt-border); padding: 5px; border-radius: 6px; }button { cursor: pointer; }.result { display: flex; flex-direction: column; text-align: left; width: 100%; margin-bottom: 6px; overflow-wrap: anywhere; }small { color: var(--mt-fg-muted); }h4 { margin: 14px 0 8px; }
</style>
