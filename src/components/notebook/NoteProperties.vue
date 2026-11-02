<script setup lang="ts">
import { computed, ref } from 'vue'
import { useEditorStore } from '@/stores/editor'
import { editableProperties, parsePropertyInput, updateProperty, type PropertyType } from '@/services/note-properties'
import { t } from '@/i18n'
import { Plus, Pencil, SlidersHorizontal } from '@lucide/vue'
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
    <div class="properties-heading"><SlidersHorizontal :size="14" aria-hidden="true" /><span>{{ t('notes.properties') }}</span><span>{{ fields.length }}</span></div>
    <p class="properties-hint">{{ t('notes.propertiesHint') }}</p>
    <div class="property-list">
      <div v-for="field in fields" :key="field.key" class="field"><div class="field-heading"><strong>{{ field.key }}</strong><button v-if="field.type" class="edit-property" :aria-label="`${t('notes.edit')}: ${field.key}`" @click="edit(field.key, field.value, field.type)"><Pencil :size="12" aria-hidden="true" /><span>{{ t('notes.edit') }}</span></button><small v-else>{{ t('notes.readonly') }}</small></div><pre>{{ field.value }}</pre></div>
    </div>
    <button class="add-property" :disabled="!editor.currentFile" @click="edit()"><Plus :size="14" aria-hidden="true" />{{ t('notes.addProperty') }}</button>
    <form v-if="editing" class="property-editor" @submit.prevent="apply">
      <label>{{ t('notes.propertyName') }}<input v-model="editing.key" :placeholder="t('notes.propertyName')" required></label>
      <select v-model="editing.type" :aria-label="t('notes.properties')"><option v-for="type in types" :key="type" :value="type">{{ t(`notes.type_${type}`) }}</option></select>
      <select v-if="editing.type === 'boolean'" v-model="editing.input" :aria-label="editing.key"><option value="true">true</option><option value="false">false</option></select>
      <textarea v-else-if="editing.type === 'list'" v-model="editing.input" :aria-label="editing.key" :placeholder="t('notes.listHint')" rows="4" />
      <input v-else v-model="editing.input" :aria-label="editing.key" :type="editing.type === 'number' ? 'number' : editing.type === 'date' ? 'date' : 'text'" :step="editing.type === 'number' ? 'any' : undefined">
      <div class="property-actions"><button type="button" @click="cancelEdit">{{ t('notes.cancel') }}</button><button type="submit" class="primary">{{ t('notes.save') }}</button></div>
    </form><p v-if="error" class="property-error" role="alert">{{ error }}</p>
  </div>
</template>
<style scoped>
.properties { flex: 1; min-height: 0; overflow: auto; padding: 16px 0 8px; scrollbar-width: thin; }
.properties-heading { display: flex; gap: 7px; align-items: center; color: var(--mt-fg-muted); font-size: 11px; }
.properties-heading > span:last-child { margin-left: auto; font-variant-numeric: tabular-nums; }
.properties-hint { margin: 12px 0; color: var(--mt-fg-muted); font-size: 11px; line-height: 1.7; }
.field { border-bottom: 1px solid var(--mt-border); padding: 12px 1px; }
.field-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.field-heading strong { overflow-wrap: anywhere; font-weight: 500; font-size: 12px; }
.field-heading small { color: var(--mt-fg-muted); font-size: 10px; }
pre { margin: 8px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 140px; overflow: auto; font: 12px/1.7 var(--mt-ui-font); color: var(--mt-fg-muted); }
input, textarea, select, button { box-sizing: border-box; max-width: 100%; font: inherit; background: var(--mt-surface-raised); color: var(--mt-fg); border: 1px solid var(--mt-border); border-radius: 6px; padding: 7px 9px; }
button { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
button:hover { background: var(--mt-row-hover); }
button:disabled { opacity: .45; cursor: default; }
.edit-property { border: 0; background: transparent; padding: 3px 5px; font-size: 10px; color: var(--mt-fg-muted); }
.add-property { width: 100%; justify-content: center; margin-top: 15px; color: var(--mt-accent); border-style: dashed; background: transparent; }
.property-editor { display: grid; gap: 10px; margin-top: 15px; padding: 13px; border-radius: 8px; background: var(--mt-surface); border: 1px solid var(--mt-border); }
.property-editor label { display: grid; gap: 6px; font-size: 11px; color: var(--mt-fg-muted); }
.property-editor input, .property-editor select, .property-editor textarea { width: 100%; min-width: 0; }
.property-actions { display: flex; justify-content: flex-end; gap: 7px; padding-top: 2px; }
.primary { color: var(--mt-text-on-accent); border-color: var(--mt-accent); background: var(--mt-accent); }
.primary:hover { background: var(--mt-accent); filter: brightness(1.08); }
.property-error { color: var(--mt-error); overflow-wrap: anywhere; }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--mt-accent); outline-offset: 2px; }
</style>
