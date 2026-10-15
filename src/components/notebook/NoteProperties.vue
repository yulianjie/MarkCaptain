<script setup lang="ts">
import { computed, ref } from 'vue'
import { useEditorStore } from '@/stores/editor'
import { editableProperties, parsePropertyInput, updateProperty, type PropertyType } from '@/services/note-properties'
import { t } from '@/i18n'
const editor = useEditorStore()
const fields = computed(() => editableProperties(editor.currentFile?.markdown ?? ''))
const editing = ref<{ id: string; markdown: string; key: string; type: PropertyType; input: string } | null>(null)
const error = ref('')
const types: PropertyType[] = ['text', 'list', 'number', 'boolean', 'date']
function edit(key = '', value: unknown = '', type: PropertyType = 'text') {
  const tab = editor.currentFile; if (!tab) return
  editing.value = { id: tab.id, markdown: tab.markdown, key, type, input: Array.isArray(value) ? value.join('\n') : String(value) }; error.value = ''
}
function apply() {
  const draft = editing.value; if (!draft) return
  try {
    if (editor.currentFileId !== draft.id || editor.currentFile?.markdown !== draft.markdown) throw new Error('notes.changed')
    const value = parsePropertyInput(draft.type, String(draft.input))
    editor.applyAgentEdit(draft.id, draft.markdown, updateProperty(draft.markdown, draft.key, value)); editing.value = null
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    error.value = t(message.startsWith('agent:') ? message.replace(':', '.') : message)
  }
}
function cancelEdit() { editing.value = null; error.value = '' }
</script>
<template>
  <div class="properties">
    <p>{{ t('notes.propertiesHint') }}</p>
    <div v-for="field in fields" :key="field.key" class="field"><strong>{{ field.key }}</strong><pre>{{ field.value }}</pre><button v-if="field.type" @click="edit(field.key, field.value, field.type)">{{ t('notes.edit') }}</button><small v-else>{{ t('notes.readonly') }}</small></div>
    <button :disabled="!editor.currentFile" @click="edit()">{{ t('notes.addProperty') }}</button>
    <form v-if="editing" @submit.prevent="apply">
      <input v-model="editing.key" :placeholder="t('notes.propertyName')" required>
      <select v-model="editing.type"><option v-for="type in types" :key="type" :value="type">{{ t(`notes.type_${type}`) }}</option></select>
      <select v-if="editing.type === 'boolean'" v-model="editing.input"><option value="true">true</option><option value="false">false</option></select>
      <textarea v-else-if="editing.type === 'list'" v-model="editing.input" :placeholder="t('notes.listHint')" />
      <input v-else v-model="editing.input" :type="editing.type === 'number' ? 'number' : editing.type === 'date' ? 'date' : 'text'" :step="editing.type === 'number' ? 'any' : undefined">
      <button type="button" @click="apply">{{ t('notes.save') }}</button><button type="button" @click="cancelEdit">{{ t('notes.cancel') }}</button>
    </form><p v-if="error" role="alert">{{ error }}</p>
  </div>
</template>
<style scoped>
.field { border-bottom: 1px solid var(--mt-border); padding: 8px 0; }pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 120px; overflow: auto; }form { display: grid; gap: 6px; margin-top: 12px; }input, textarea, select, button { box-sizing: border-box; max-width: 100%; background: var(--mt-bg); color: var(--mt-fg); border: 1px solid var(--mt-border); border-radius: 6px; padding: 6px; }button { cursor: pointer; }
</style>
