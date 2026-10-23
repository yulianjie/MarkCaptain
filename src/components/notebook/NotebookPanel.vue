<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowLeft, CornerDownRight, Search, X } from '@lucide/vue'
import { useNotebookStore } from '@/stores/notebook'
import { useEditorStore } from '@/stores/editor'
import { useI18n } from '@/i18n'
import NoteProperties from './NoteProperties.vue'
import NoteSearchTasks from './NoteSearchTasks.vue'
import { groupRelationItems, relationItemCount, type InspectorRelationItem } from '@/components/documentInspector/inspector-model'
import { translateInspector } from '@/components/documentInspector/inspector-i18n'

const notebook = useNotebookStore()
const editor = useEditorStore()
const { t, locale } = useI18n()
const text = (key: Parameters<typeof translateInspector>[1]) => translateInspector(locale.value, key)
const query = ref('')
const searchMode = computed(() => notebook.panel === 'tags' || notebook.panel === 'tasks' ? notebook.panel : 'search')
const outgoing = computed(() => notebook.relationTargetAnalysis?.links.filter(link => !link.referenceDefinition) ?? [])
const tabs = ['links', 'tags', 'properties', 'search', 'tasks'] as const

const backlinkRows = computed(() => notebook.backlinks.map((item, index) => ({
  id: `backlink:${item.note.relative}:${item.link.from}:${index}`,
  sourcePath: item.note.relative,
  line: item.link.line,
  from: item.link.from,
  to: item.link.to,
  context: item.context,
  target: item.link.target,
  kind: 'backlink' as const,
} satisfies InspectorRelationItem & { id: string })))
const mentionRows = computed(() => notebook.mentions.map((item, index) => ({
  id: `mention:${item.note.relative}:${item.from}:${index}`,
  sourcePath: item.note.relative,
  line: item.line,
  from: item.from,
  to: item.to,
  context: item.context,
  kind: 'mention' as const,
} satisfies InspectorRelationItem & { id: string })))
const backlinkGroups = computed(() => groupRelationItems(backlinkRows.value, query.value))
const mentionGroups = computed(() => groupRelationItems(mentionRows.value, query.value))
const backlinkCount = computed(() => relationItemCount(backlinkGroups.value))
const mentionCount = computed(() => relationItemCount(mentionGroups.value))
const filteredOutgoing = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  return outgoing.value.filter(link => !needle || `${link.target} ${link.context ?? ''}`.toLocaleLowerCase().includes(needle))
})
const statusKey = computed(() => {
  const status = notebook.relationTargetStatus
  return status === 'noWorkspace' || status === 'noDocument' || status === 'noPath' || status === 'outsideWorkspace'
    || status === 'notIndexed' || status === 'indexing' || status === 'pinnedMissing' || status === 'targetError' || status === 'partial'
    ? status : ''
})
const statusMessage = computed(() => statusKey.value ? text(statusKey.value) : '')
const canShowRelations = computed(() => ['ready', 'partial'].includes(notebook.relationTargetStatus))
const targetLabel = computed(() => notebook.relationTarget?.relative || notebook.relationTargetRelative || text('target'))
const activeTargetIsCurrent = computed(() => notebook.relationTarget?.path === editor.currentFile?.pathname)

async function openRelation(item: InspectorRelationItem, openInOtherPane = false) {
  try { await notebook.navigateToRelation(item.sourcePath, item.from, item.to, { openInOtherPane }) }
  catch (error) { notebook.error = String(error) }
}
async function followOutgoing(target: string) {
  const analysis = notebook.relationTargetAnalysis
  const link = analysis?.links.find(item => item.target === target && !item.referenceDefinition)
  if (!analysis || !link) return
  try { await notebook.followLink(analysis.relative, link) }
  catch (error) { notebook.error = String(error) }
}
async function openTarget() {
  const target = notebook.relationTarget
  if (!target) return
  try { await notebook.navigateToRelation(target.relative, 0, 0) }
  catch (error) { notebook.error = String(error) }
}
function toggleTarget() {
  if (notebook.relationTargetPinned) notebook.followActiveRelationTarget()
  else notebook.fixRelationTarget()
}
</script>

<template>
  <section class="notebook-panel" aria-label="Document links">
    <header class="notebook-toolbar">
      <select v-model="notebook.panel" :aria-label="t('notes.panel')">
        <option v-for="tab in tabs" :key="tab" :value="tab">{{ t(`notes.${tab}`) }}</option>
      </select>
      <button type="button" :title="t('notes.rebuild')" :aria-label="t('notes.rebuild')" @click="notebook.rebuild(true)">↻</button>
      <button type="button" :title="t('notes.quick')" :aria-label="t('notes.quick')" @click="notebook.dialog = 'quick'">⌕</button>
    </header>

    <template v-if="notebook.panel === 'links'">
      <div class="target-header">
        <div class="target-name">
          <span class="eyebrow">{{ text('target') }}</span>
          <strong :title="targetLabel">{{ targetLabel || text(notebook.relationTargetPinned ? 'pinnedMissing' : 'noDocument') }}</strong>
          <small>{{ notebook.relationTargetPinned ? text('fixed') : text('followActive') }}</small>
        </div>
        <div class="target-actions">
          <button v-if="notebook.relationTargetPinned || notebook.relationTarget" type="button" class="target-action"
            :title="text(notebook.relationTargetPinned ? 'useActive' : 'fixTarget')"
            :aria-label="text(notebook.relationTargetPinned ? 'useActive' : 'fixTarget')" @click="toggleTarget">
            {{ text(notebook.relationTargetPinned ? 'useActive' : 'fixTarget') }}
          </button>
          <button v-if="notebook.canReturnFromRelation" type="button" class="icon-action" :title="text('back')" :aria-label="text('back')" @click="notebook.returnFromRelation()">
            <ArrowLeft :size="15" aria-hidden="true" />
          </button>
          <button v-if="!activeTargetIsCurrent && notebook.relationTarget" type="button" class="icon-action" :title="text('openTarget')" :aria-label="text('openTarget')" @click="openTarget">
            <CornerDownRight :size="15" aria-hidden="true" />
          </button>
        </div>
      </div>

      <label class="relation-filter">
        <Search :size="14" aria-hidden="true" />
        <input v-model="query" type="search" :placeholder="text('filter')" :aria-label="text('filter')">
        <button v-if="query" type="button" :aria-label="text('clearFilter')" @click="query = ''"><X :size="13" aria-hidden="true" /></button>
      </label>

      <div v-if="statusMessage" class="relation-status" :class="{ warning: ['partial', 'targetError'].includes(notebook.relationTargetStatus) }" role="status">
        <span v-if="notebook.relationTargetStatus === 'indexing'" class="loading-dot" aria-hidden="true" />
        {{ statusMessage }}
        <button v-if="notebook.relationTargetStatus === 'indexing'" type="button" @click="notebook.cancel">{{ t('notes.cancel') }}</button>
        <button v-if="notebook.relationTargetStatus === 'notIndexed' || notebook.relationTargetStatus === 'targetError'" type="button" @click="notebook.rebuild(true)">{{ t('notes.rebuild') }}</button>
      </div>

      <div v-if="canShowRelations" class="relation-scroll">
        <p v-if="notebook.relationTargetStatus === 'partial'" class="partial-note">{{ text('partial') }}</p>
        <details class="relation-section" open>
          <summary><span>{{ text('backlinks') }}</span><span class="count">{{ backlinkCount }}</span></summary>
          <p v-if="!backlinkCount" class="section-empty">{{ query ? text('noMatches') : text('noBacklinks') }}</p>
          <details v-for="group in backlinkGroups" :key="`b:${group.sourcePath}`" class="source-group">
            <summary><span class="source-path">{{ group.sourcePath }}</span><span class="count">{{ group.items.length }}</span></summary>
            <article v-for="item in group.items" :key="item.id" class="relation-row">
              <div class="relation-row-main">
                <button type="button" class="location-button" :aria-label="`${text('selectResult')}: ${item.sourcePath}:${item.line}`" @click="openRelation(item)">
                  <span class="line-number">{{ item.line }}</span><span class="row-target">{{ item.target }}</span>
                </button>
                <button type="button" class="open-other" :title="text('openOtherPane')" :aria-label="text('openOtherPane')" @click="openRelation(item, true)">
                  <CornerDownRight :size="14" aria-hidden="true" />
                </button>
              </div>
              <details class="context-details"><summary>{{ text('expandContext') }}</summary><p>{{ item.context }}</p></details>
            </article>
          </details>
        </details>

        <details class="relation-section" open>
          <summary><span>{{ text('mentions') }}</span><span class="count">{{ mentionCount }}</span></summary>
          <p v-if="!mentionCount" class="section-empty">{{ query ? text('noMatches') : text('noMentions') }}</p>
          <details v-for="group in mentionGroups" :key="`m:${group.sourcePath}`" class="source-group">
            <summary><span class="source-path">{{ group.sourcePath }}</span><span class="count">{{ group.items.length }}</span></summary>
            <article v-for="item in group.items" :key="`${item.sourcePath}:${item.from}`" class="relation-row">
              <div class="relation-row-main">
                <button type="button" class="location-button" :aria-label="`${text('selectResult')}: ${item.sourcePath}:${item.line}`" @click="openRelation(item)">
                  <span class="line-number">{{ item.line }}</span><span class="row-target">{{ item.context }}</span>
                </button>
                <button type="button" class="open-other" :title="text('openOtherPane')" :aria-label="text('openOtherPane')" @click="openRelation(item, true)">
                  <CornerDownRight :size="14" aria-hidden="true" />
                </button>
              </div>
              <details class="context-details"><summary>{{ text('expandContext') }}</summary><p>{{ item.context }}</p></details>
            </article>
          </details>
        </details>

        <details class="relation-section" open>
          <summary><span>{{ text('outgoing') }}</span><span class="count">{{ filteredOutgoing.length }}</span></summary>
          <p v-if="!filteredOutgoing.length" class="section-empty">{{ query ? text('noMatches') : text('noOutgoing') }}</p>
          <button v-for="(link, index) in filteredOutgoing" :key="`${link.target}:${index}`" type="button" class="outgoing-row" @click="followOutgoing(link.target)">
            <span>{{ link.target }}</span><small>{{ link.context }}</small>
          </button>
        </details>
      </div>
    </template>

    <NoteProperties v-else-if="notebook.panel === 'properties'" />
    <NoteSearchTasks v-else-if="['tags', 'search', 'tasks'].includes(notebook.panel)" :mode="searchMode" />

    <p v-if="notebook.error" class="notebook-error" role="alert">{{ notebook.error }}</p>
    <details v-if="notebook.notes.some(note => note.error)" class="index-errors">
      <summary>{{ t('notes.indexIncomplete') }}</summary>
      <p v-for="note in notebook.notes.filter(item => item.error).slice(0, 20)" :key="note.path">{{ note.relative }}: {{ note.error }}</p>
    </details>
  </section>
</template>

<style scoped>
.notebook-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; padding: 8px 10px; box-sizing: border-box; font-size: 12px; }
.notebook-toolbar { display: flex; flex: 0 0 auto; gap: 6px; align-items: center; }
.notebook-toolbar select { min-width: 0; flex: 1; height: 30px; }
.notebook-toolbar button, .notebook-toolbar select, .target-action, .icon-action, .relation-filter button { background: transparent; color: var(--mt-fg); border: 1px solid var(--mt-border); padding: 5px; border-radius: 6px; }
.notebook-toolbar button, .target-action, .icon-action, .relation-filter button { cursor: pointer; }
.target-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 12px 2px 9px; border-bottom: 1px solid var(--mt-border); }
.target-name { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
.target-name strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 600; }
.target-name small, .eyebrow { color: var(--mt-fg-muted); font-size: 10px; }
.eyebrow { text-transform: uppercase; letter-spacing: .05em; }
.target-actions { display: flex; flex: 0 0 auto; gap: 4px; align-items: center; }
.target-action { max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }
.icon-action { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; }
.relation-filter { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; min-height: 30px; margin: 9px 0; padding: 0 7px; border: 1px solid var(--mt-border); border-radius: 6px; color: var(--mt-fg-muted); }
.relation-filter:focus-within { outline: 2px solid var(--mt-accent); outline-offset: 1px; }
.relation-filter input { width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--mt-fg); font: inherit; }
.relation-filter button { display: grid; place-items: center; padding: 2px; border: 0; }
.relation-status { display: flex; align-items: center; gap: 6px; margin: 0 0 8px; padding: 7px 8px; border-radius: 6px; background: var(--mt-sidebar-bg); color: var(--mt-fg-muted); line-height: 1.4; }
.relation-status.warning { color: var(--mt-warning, #a46600); }
.relation-status button { margin-left: auto; flex: 0 0 auto; border: 0; background: transparent; color: var(--mt-accent); cursor: pointer; font: inherit; }
.loading-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--mt-accent); animation: pulse 1s ease-in-out infinite alternate; }
.relation-scroll { flex: 1; min-height: 0; overflow: auto; scrollbar-width: thin; }
.relation-section { border-bottom: 1px solid var(--mt-border); }
.relation-section > summary, .source-group > summary { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-height: 32px; cursor: pointer; list-style: none; }
.relation-section > summary::-webkit-details-marker, .source-group > summary::-webkit-details-marker { display: none; }
.relation-section > summary::before, .source-group > summary::before { content: '›'; width: 10px; color: var(--mt-fg-muted); transition: transform 120ms; }
.relation-section[open] > summary::before, .source-group[open] > summary::before { transform: rotate(90deg); }
.relation-section > summary { font-weight: 600; }
.count { margin-left: auto; color: var(--mt-fg-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.source-group { margin: 2px 0 6px 11px; }
.source-group > summary { min-height: 28px; font-weight: 400; color: var(--mt-fg-muted); }
.source-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.relation-row { padding: 2px 0 6px 10px; }
.relation-row-main { display: flex; align-items: stretch; gap: 4px; }
.location-button, .outgoing-row { display: flex; min-width: 0; flex: 1; align-items: center; gap: 8px; border: 0; border-radius: 5px; padding: 5px 6px; background: transparent; color: var(--mt-fg); cursor: pointer; text-align: left; font: inherit; }
.location-button:hover, .outgoing-row:hover { background: var(--mt-row-hover); }
.line-number { flex: 0 0 auto; color: var(--mt-fg-muted); font: 10px/1.4 'Cascadia Code', Consolas, monospace; }
.row-target { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.open-other { display: grid; place-items: center; width: 28px; flex: 0 0 28px; border: 0; border-radius: 5px; background: transparent; color: var(--mt-fg-muted); cursor: pointer; }
.open-other:hover { background: var(--mt-row-hover); color: var(--mt-accent); }
.context-details { padding: 0 6px; color: var(--mt-fg-muted); }
.context-details summary { cursor: pointer; font-size: 10px; }
.context-details p { margin: 5px 0 3px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--mt-fg); }
.outgoing-row { width: 100%; flex-direction: column; align-items: flex-start; gap: 3px; overflow-wrap: anywhere; }
.outgoing-row span { overflow-wrap: anywhere; }
.outgoing-row small { color: var(--mt-fg-muted); }
.section-empty, .no-relations, .partial-note { margin: 4px 0 9px; padding: 5px 8px; color: var(--mt-fg-muted); font-size: 11px; }
.no-relations { text-align: center; }
.partial-note { color: var(--mt-warning, #a46600); }
.notebook-error { flex: 0 0 auto; color: var(--mt-danger, #b42318); overflow-wrap: anywhere; }
.index-errors { flex: 0 0 auto; max-height: 25%; overflow: auto; }
.index-errors p { overflow-wrap: anywhere; color: var(--mt-fg-muted); }
button:focus-visible, select:focus-visible, summary:focus-visible { outline: 2px solid var(--mt-accent); outline-offset: 1px; }
@keyframes pulse { from { opacity: .4; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .loading-dot { animation: none; } }
</style>
