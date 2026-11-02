<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { bus } from '@/bus'
import { useI18n } from '@/i18n'
import { useAgentStore } from '@/stores/agent'
import { useEditorStore } from '@/stores/editor'
import { openFiles } from '@/services/tauri-invoke'
import { agentEndpointInfo } from '@/services/agent-context'
import { agentMultiCopy } from '@/services/agent-multi-copy'
import type { AgentMultiTarget } from '@/services/agent-multi-types'
import AgentDiffView from './AgentDiffView.vue'
import './agent.css'

const agent = useAgentStore()
const editor = useEditorStore()
const { locale } = useI18n()
const copy = computed(() => agentMultiCopy(locale.value))
const state = computed(() => agent.multiDocumentState)
const visible = ref(false)
const selected = ref<string[]>([])
const prompt = ref('')
const opening = ref(false)
const localError = ref('')
const sentRoute = ref('')
const modelRoute = computed(() => `${agent.config?.model ?? ''} · ${agentEndpointInfo(agent.config?.baseUrl ?? '').endpoint}`)
const locked = computed(() => opening.value || agent.busy || state.value.busy || state.value.actionBusy || agent.historyLoading)
const canSend = computed(() => !locked.value && Boolean(agent.config) && selected.value.length > 0 && selected.value.length <= 8 && Boolean(prompt.value.trim()))
let selectionGeneration = 0
let unsubscribe: (() => void) | undefined

watch(selected, () => { selectionGeneration++ }, { flush: 'sync' })
watch(() => editor.tabs.map(tab => tab.id), ids => {
  if (selected.value.some(id => !ids.includes(id))) selected.value = selected.value.filter(id => ids.includes(id))
})
watch(visible, value => {
  if (!value) {
    selectionGeneration++
    if (state.value.busy) void run(() => agent.multiDocument.cancel())
  }
})

async function run(action: () => unknown | Promise<unknown>) {
  localError.value = ''
  try { await action() }
  catch (error) { localError.value = error instanceof Error ? error.message : String(error) }
}
function toggle(id: string, checked: boolean) {
  if (locked.value) return
  selected.value = checked ? [...selected.value, id].slice(0, 8) : selected.value.filter(item => item !== id)
}
async function chooseFiles() {
  if (locked.value) return
  const generation = ++selectionGeneration
  opening.value = true
  localError.value = ''
  try {
    const paths = await openFiles()
    const added = [...selected.value]
    for (const path of paths ?? []) {
      if (!visible.value || generation !== selectionGeneration || added.length >= 8) break
      const tab = await editor.openFile(path)
      if (!visible.value || generation !== selectionGeneration) break
      if (tab && !added.includes(tab.id)) added.push(tab.id)
    }
    if (visible.value && generation === selectionGeneration) selected.value = added
  } catch (error) {
    if (visible.value && generation === selectionGeneration) localError.value = error instanceof Error ? error.message : String(error)
  } finally { opening.value = false }
}
async function send() {
  if (!canSend.value) return
  sentRoute.value = modelRoute.value
  await run(() => agent.multiDocument.prepareAndSend([...selected.value], prompt.value.trim()))
}
function pending(target: AgentMultiTarget) { return target.proposal?.changes.some(change => change.status === 'pending') ?? false }
function applied(target: AgentMultiTarget) { return target.proposal?.changes.some(change => change.status === 'applied') ?? false }
function conflicted(target: AgentMultiTarget) { return target.status === 'conflict' || Boolean(target.proposal?.documentChanged) }
function errorText(error: string) {
  if (error === 'agent:conflict' || error === 'agent:selectionChanged') return copy.value.conflictHelp
  if (error === 'agent:multiSelection') return copy.value.selectionError
  if (error === 'agent:multiLimit') return copy.value.limits
  if (error === 'agent:notConfigured') return copy.value.notConfigured
  return copy.value.operationError
}
async function locate(target: AgentMultiTarget) {
  await run(async () => { if (await agent.multiDocument.locate(target.documentId)) visible.value = false })
}
onMounted(() => { unsubscribe = bus.on('show-agent-multi-dialog', () => { visible.value = true }) })
onBeforeUnmount(() => { selectionGeneration++; unsubscribe?.() })
</script>

<template>
  <el-dialog v-model="visible" class="agent-multi-shell" :title="copy.title" width="min(960px, 94vw)" top="4vh" append-to-body :close-on-click-modal="false" :close-on-press-escape="!state.actionBusy" :show-close="!state.actionBusy">
    <div class="agent-multi-dialog" data-testid="agent-multi-dialog">
      <section class="agent-multi-notices">
        <p>{{ copy.scope }}</p><p>{{ copy.protection }}</p><p>{{ copy.saving }}</p><p>{{ copy.undo }}</p>
      </section>
      <div class="agent-multi-setup">
      <fieldset :disabled="locked">
        <legend>{{ copy.choose }} · {{ selected.length }}/8 {{ copy.selected }}</legend>
        <div class="agent-multi-candidates">
          <label v-for="tab in editor.tabs" :key="tab.id">
            <input type="checkbox" data-testid="agent-multi-candidate" :value="tab.id" :checked="selected.includes(tab.id)" :disabled="locked || selected.length >= 8 && !selected.includes(tab.id)" @change="toggle(tab.id, ($event.target as HTMLInputElement).checked)">
            <span><strong>{{ tab.filename }}</strong><small>{{ tab.pathname || copy.untitled }}</small></span>
          </label>
        </div>
        <button type="button" :disabled="locked || selected.length >= 8" @click="chooseFiles">{{ copy.open }}</button>
        <small>{{ copy.limits }}</small>
      </fieldset>
      <section class="agent-multi-compose">
      <p class="agent-multi-route"><strong>{{ copy.route }}</strong>: {{ state.requestId ? sentRoute : modelRoute }}<br>{{ copy.routeText }}</p>
      <label class="agent-multi-prompt">{{ copy.prompt }}<textarea v-model="prompt" data-testid="agent-multi-prompt" rows="3" maxlength="20000" :placeholder="copy.placeholder" :disabled="locked" /></label>
      <p v-if="!agent.config" role="status">{{ copy.notConfigured }}</p>
      <p v-if="state.targets.length" class="agent-multi-muted">{{ copy.nextTask }}</p>
      <div class="agent-multi-actions">
        <button type="button" class="agent-primary" data-testid="agent-multi-send" :disabled="!canSend" @click="send">{{ copy.send }}</button>
        <button v-if="state.busy" type="button" data-testid="agent-multi-cancel" @click="run(() => agent.multiDocument.cancel())">{{ copy.cancel }}</button>
        <span role="status">{{ copy[state.stage] }}</span>
      </div>
      </section>
      </div>
      <section v-if="localError || state.error" class="agent-multi-error" role="alert">
        <p>{{ errorText(localError || state.error) }}</p><details><summary>{{ copy.details }}</summary>{{ localError || state.error }}</details>
      </section>
      <details v-if="state.requestId" class="agent-multi-reads">
        <summary>{{ copy.reads }} · {{ state.reads.length }}</summary>
        <p v-if="!state.reads.length">{{ copy.noReads }}</p>
        <details v-for="read in state.reads" :key="read.id"><summary>{{ read.documentName }}<template v-if="read.startLine"> · {{ read.startLine }}–{{ read.endLine }}</template></summary><pre>{{ read.excerpt }}</pre><small v-if="read.truncated">{{ copy.truncated }}</small></details>
      </details>
      <details v-if="state.sources.length"><summary>{{ copy.sources }}</summary><blockquote v-for="(source, index) in state.sources" :key="index"><strong>{{ source.label }} · {{ source.snapshot.name }} · {{ source.startLine }}–{{ source.endLine }}</strong><p>{{ source.quote }}</p></blockquote></details>
      <section v-if="state.answer"><h3>{{ copy.answer }}</h3><p class="agent-multi-answer">{{ state.answer }}</p></section>
      <section v-for="target in state.targets" :key="target.documentId" class="agent-multi-target" data-testid="agent-multi-target" :data-document-id="target.documentId" :data-status="target.status">
        <header><h3>{{ target.name }}</h3><span>{{ copy[target.status] }}</span></header>
        <p class="agent-multi-path">{{ target.path || copy.untitled }}</p>
        <p v-if="conflicted(target)" class="agent-multi-error" role="alert">{{ copy.conflictHelp }}</p>
        <div v-if="target.error" class="agent-multi-error" role="alert"><p>{{ errorText(target.error) }}</p><details><summary>{{ copy.details }}</summary>{{ target.error }}</details></div>
        <template v-if="target.proposal">
          <h4>{{ target.proposal.title }}</h4>
          <div v-for="change in target.proposal.changes" :key="change.id" class="agent-edit-change"><AgentDiffView :change="change" :locale="locale" /></div>
        </template>
        <p v-else class="agent-multi-muted">{{ copy.noProposal }}</p>
        <div class="agent-multi-actions">
          <button v-if="pending(target)" type="button" data-testid="agent-multi-apply" class="agent-primary" :disabled="locked || conflicted(target)" @click="run(() => agent.multiDocument.apply(target.documentId))">{{ copy.apply }}</button>
          <button v-if="pending(target)" type="button" data-testid="agent-multi-dismiss" :disabled="locked" @click="run(() => agent.multiDocument.dismiss(target.documentId))">{{ copy.dismiss }}</button>
          <button v-if="applied(target)" type="button" data-testid="agent-multi-revert" :disabled="locked || conflicted(target)" @click="run(() => agent.multiDocument.revert(target.documentId))">{{ copy.revert }}</button>
          <button type="button" data-testid="agent-multi-locate" :disabled="locked" @click="locate(target)">{{ copy.locate }}</button>
        </div>
        <details class="agent-multi-original"><summary>{{ copy.original }}</summary><textarea data-testid="agent-multi-snapshot" :aria-label="copy.originalLabel" :value="target.snapshot.markdown" readonly rows="9" spellcheck="false" /></details>
      </section>
    </div>
    <template #footer><button type="button" class="agent-multi-close" :disabled="state.actionBusy" @click="visible = false">{{ copy.close }}</button></template>
  </el-dialog>
</template>

<style scoped>
.agent-multi-dialog { color: var(--mt-fg); max-height: 72vh; overflow: auto; padding: 2px 4px 12px; overflow-wrap: anywhere; font: 12px/1.75 var(--mt-ui-font, inherit); scrollbar-width: thin; }
.agent-multi-dialog * { box-sizing: border-box; }
.agent-multi-dialog p { margin: 8px 0; }
.agent-multi-notices { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 24px; padding: 16px 18px; border: 1px solid color-mix(in srgb, var(--mt-accent) 20%, var(--mt-border)); background: var(--mt-accent-soft); border-radius: 10px; font-size: 11px; line-height: 1.8; }
.agent-multi-notices p { margin: 0; }
.agent-multi-setup { display: grid; grid-template-columns: minmax(220px, .85fr) minmax(0, 1.15fr); gap: 24px; margin: 23px 0; }
fieldset { min-width: 0; margin: 0; padding: 14px; border: 1px solid var(--mt-border); border-radius: 10px; background: var(--mt-surface, var(--mt-bg)); }
legend { padding: 0 7px; color: var(--mt-fg); font-size: 11px; font-weight: 600; }
.agent-multi-candidates { max-height: 210px; overflow: auto; margin-bottom: 12px; scrollbar-width: thin; }
.agent-multi-candidates label { display: flex; align-items: flex-start; gap: 9px; padding: 10px 8px; border-bottom: 1px solid var(--mt-border); border-radius: 5px; }
.agent-multi-candidates label:last-child { border-bottom: 0; }
.agent-multi-candidates label:has(input:checked) { background: var(--mt-accent-soft); }
.agent-multi-candidates label span { min-width: 0; }
.agent-multi-candidates input { margin: 4px 0 0; accent-color: var(--mt-accent); }
.agent-multi-candidates small, .agent-multi-candidates strong { display: block; overflow-wrap: anywhere; }
.agent-multi-candidates strong { font-size: 12px; font-weight: 500; }
.agent-multi-candidates small { font-size: 10px; line-height: 1.7; }
fieldset > small { display: block; margin: 8px 0 0; font-size: 10px; }
.agent-multi-dialog small, .agent-multi-muted, .agent-multi-path { color: var(--mt-fg-muted); }
.agent-multi-compose { min-width: 0; }
.agent-multi-compose .agent-multi-route { margin: 0 0 14px; font-size: 10px; line-height: 1.8; color: var(--mt-fg-muted); }
.agent-multi-route strong { color: var(--mt-fg); font-weight: 500; }
.agent-multi-prompt { display: grid; gap: 8px; font-size: 11px; font-weight: 500; }
textarea { width: 100%; box-sizing: border-box; resize: vertical; padding: 12px; color: var(--mt-fg); background: var(--mt-surface, var(--mt-bg)); border: 1px solid var(--mt-border); border-radius: 9px; font: 12px/1.8 var(--mt-ui-font, inherit); }
textarea::placeholder { color: var(--mt-fg-muted); }
.agent-multi-prompt textarea { min-height: 116px; }
.agent-multi-actions { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; margin: 14px 0 0; }
.agent-multi-actions > span { margin-left: auto; font-size: 10px; color: var(--mt-fg-muted); }
.agent-multi-dialog button, .agent-multi-close { min-height: 31px; padding: 7px 12px; border: 1px solid var(--mt-border); border-radius: 7px; background: var(--mt-surface-raised, var(--mt-bg)); color: var(--mt-fg); font: 11px/1.5 var(--mt-ui-font, inherit); cursor: pointer; }
.agent-multi-dialog button:hover:not(:disabled), .agent-multi-close:hover:not(:disabled) { background: var(--mt-row-hover); }
.agent-multi-dialog :is(button, input, textarea, summary):focus-visible, .agent-multi-close:focus-visible { outline: 2px solid var(--mt-accent); outline-offset: 2px; }
.agent-multi-dialog button:disabled, .agent-multi-close:disabled { opacity: .45; cursor: default; }
.agent-multi-dialog .agent-primary { background: var(--mt-accent); color: var(--mt-text-on-accent); border-color: var(--mt-accent); }
.agent-multi-dialog .agent-primary:hover:not(:disabled) { background: var(--mt-accent); filter: brightness(.94); }
.agent-multi-target { border: 1px solid var(--mt-border); border-radius: 12px; padding: 20px; margin: 22px 0; background: var(--mt-surface-raised, var(--mt-bg)); }
.agent-multi-target[data-status='conflict'] { border-color: color-mix(in srgb, var(--mt-warning) 45%, var(--mt-border)); }
.agent-multi-target header { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }
.agent-multi-target h3 { margin: 0; font-size: 15px; font-weight: 600; }
.agent-multi-target h4 { margin: 20px 0 13px; font-size: 12px; font-weight: 500; }
.agent-multi-target header span { flex-shrink: 0; font-size: 10px; padding: 3px 8px; border-radius: 5px; background: var(--mt-accent-soft); color: var(--mt-accent); }
.agent-multi-error { padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--mt-error) 25%, var(--mt-border)); border-radius: 8px; color: var(--mt-fg); background: var(--mt-error-soft); font-size: 11px; }
.agent-multi-target .agent-edit-change { margin: 15px 0; padding: 12px; border: 1px solid var(--mt-border); border-radius: 9px; }
.agent-multi-path { margin-top: 4px !important; font-size: 10px; }
.agent-multi-answer, pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.agent-multi-answer { line-height: 1.9; font-size: 13px; }
.agent-multi-reads, .agent-multi-original { margin-top: 16px; padding-top: 13px; border-top: 1px solid var(--mt-border); }
.agent-multi-original textarea { margin-top: 10px; font: 11px/1.8 var(--mt-code-font, ui-monospace, monospace); }
summary { cursor: pointer; font-size: 11px; color: var(--mt-fg-muted); line-height: 1.7; }
pre { max-height: 240px; overflow: auto; padding: 12px; border: 1px solid var(--mt-border); border-radius: 7px; background: var(--mt-surface, var(--mt-bg)); font-size: 11px; }
blockquote { margin: 14px 0; padding: 12px 15px; border-left: 2px solid var(--mt-accent); background: var(--mt-accent-soft); }
@media (max-width: 700px) { .agent-multi-setup { grid-template-columns: minmax(0, 1fr); gap: 18px; } .agent-multi-notices { grid-template-columns: minmax(0, 1fr); gap: 7px; } .agent-multi-target { padding: 14px; } .agent-multi-candidates { max-height: 150px; } }
</style>
