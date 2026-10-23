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
  <el-dialog v-model="visible" :title="copy.title" width="min(960px, 94vw)" top="4vh" append-to-body :close-on-click-modal="false" :close-on-press-escape="!state.actionBusy" :show-close="!state.actionBusy">
    <div class="agent-multi-dialog" data-testid="agent-multi-dialog">
      <section class="agent-multi-notices">
        <p>{{ copy.scope }}</p><p>{{ copy.protection }}</p><p>{{ copy.saving }}</p><p>{{ copy.undo }}</p>
      </section>
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
      <p class="agent-multi-route"><strong>{{ copy.route }}</strong>: {{ state.requestId ? sentRoute : modelRoute }}<br>{{ copy.routeText }}</p>
      <label class="agent-multi-prompt">{{ copy.prompt }}<textarea v-model="prompt" data-testid="agent-multi-prompt" rows="3" maxlength="20000" :placeholder="copy.placeholder" :disabled="locked" /></label>
      <p v-if="!agent.config" role="status">{{ copy.notConfigured }}</p>
      <p v-if="state.targets.length" class="agent-multi-muted">{{ copy.nextTask }}</p>
      <div class="agent-multi-actions">
        <button type="button" class="agent-primary" data-testid="agent-multi-send" :disabled="!canSend" @click="send">{{ copy.send }}</button>
        <button v-if="state.busy" type="button" data-testid="agent-multi-cancel" @click="run(() => agent.multiDocument.cancel())">{{ copy.cancel }}</button>
        <span role="status">{{ copy[state.stage] }}</span>
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
      <section v-for="target in state.targets" :key="target.documentId" class="agent-multi-target" data-testid="agent-multi-target" :data-document-id="target.documentId">
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
    <template #footer><button type="button" :disabled="state.actionBusy" @click="visible = false">{{ copy.close }}</button></template>
  </el-dialog>
</template>

<style scoped>
.agent-multi-dialog { color: var(--mt-fg); max-height: 74vh; overflow: auto; padding: 0 8px; overflow-wrap: anywhere; }
.agent-multi-dialog p { margin: 8px 0; }
.agent-multi-notices { padding: 10px 14px; background: var(--mt-sidebar-bg); border-radius: 6px; font-size: 12px; }
fieldset { margin: 16px 0; padding: 12px; border: 1px solid var(--mt-border); border-radius: 6px; }
.agent-multi-candidates { max-height: 180px; overflow: auto; margin-bottom: 10px; }
.agent-multi-candidates label { display: flex; align-items: flex-start; gap: 8px; padding: 6px; }
.agent-multi-candidates small, .agent-multi-candidates strong { display: block; }
fieldset > small { margin-left: 10px; }
.agent-multi-dialog small, .agent-multi-muted, .agent-multi-path { color: var(--mt-fg-muted); }
.agent-multi-prompt { display: grid; gap: 7px; }
textarea { width: 100%; box-sizing: border-box; resize: vertical; padding: 9px; color: var(--mt-fg); background: var(--mt-bg); border: 1px solid var(--mt-border); border-radius: 4px; font: inherit; }
.agent-multi-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 12px 0; }
.agent-multi-dialog button { padding: 6px 10px; border: 1px solid var(--mt-border); border-radius: 4px; background: var(--mt-bg); color: var(--mt-fg); cursor: pointer; }
.agent-multi-dialog :is(button, input, textarea, summary):focus-visible { outline: 2px solid var(--mt-accent); outline-offset: 2px; }
.agent-multi-dialog button:disabled { opacity: .5; cursor: default; }
.agent-multi-dialog .agent-primary { background: var(--mt-accent); color: white; }
.agent-multi-target { border: 1px solid var(--mt-border); border-radius: 6px; padding: 14px; margin: 16px 0; }
.agent-multi-target header { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; }
.agent-multi-target h3 { margin: 0; }
.agent-multi-target header span { font-size: 12px; }
.agent-multi-error { color: var(--mt-error, #b42318); }
.agent-multi-route, .agent-multi-path { font-size: 12px; }
.agent-multi-answer, pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.agent-multi-reads, .agent-multi-original { margin-top: 14px; }
.agent-multi-original textarea { margin-top: 8px; font-family: monospace; }
summary { cursor: pointer; }
pre { max-height: 240px; overflow: auto; }
</style>
