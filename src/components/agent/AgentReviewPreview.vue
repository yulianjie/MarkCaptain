<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { X } from '@lucide/vue'
import { bus } from '@/bus'
import { useI18n } from '@/i18n'
import { agentM1Copy } from '@/services/agent-m1-copy'
import type { DocumentSnapshot, ReviewedEdit } from '@/services/agent'
import { useAgentStore } from '@/stores/agent'
import { useEditorStore } from '@/stores/editor'
import AgentDiffView from './AgentDiffView.vue'

const agent = useAgentStore()
const editor = useEditorStore()
const { locale } = useI18n()
const messageId = ref('')
const changeId = ref('')
const visible = ref(false)
const copy = (key: Parameters<typeof agentM1Copy>[1], params?: Record<string, string | number>) => agentM1Copy(locale.value, key, params)
const message = computed(() => agent.conversation.messages.find(item => item.id === messageId.value))
const edit = computed<ReviewedEdit | undefined>(() => message.value?.edit)
const changeIndex = computed(() => edit.value?.changes.findIndex(item => item.id === changeId.value) ?? -1)
const change = computed(() => changeIndex.value >= 0 ? edit.value?.changes[changeIndex.value] : undefined)
const current = computed(() => editor.currentFile)

function rangeInCurrent(editValue: ReviewedEdit, index: number): { from: number; to: number } {
  const target = editValue.changes[index]!
  const shift = editValue.changes.reduce((total, item, itemIndex) => total + (itemIndex !== index && item.status === 'applied' && item.to <= target.from ? item.newText.length - item.oldText.length : 0), 0)
  const from = target.from + shift
  return { from, to: from + (target.status === 'applied' ? target.newText.length : target.oldText.length) }
}

const targetRange = computed(() => edit.value && changeIndex.value >= 0 ? rangeInCurrent(edit.value, changeIndex.value) : null)
const valid = computed(() => {
  const target = edit.value
  return Boolean(target && current.value && target.snapshot.tabId === editor.currentFileId
    && !target.documentChanged && !target.locked && !target.rebasedTo
    && current.value.markdown === (target.appliedMarkdown ?? target.snapshot.markdown)
    && message.value?.task?.documentId !== null && (!message.value?.task || message.value.task.snapshotId === target.snapshot.snapshotId))
})

function close() { visible.value = false; messageId.value = ''; changeId.value = '' }
function open(request: { messageId: string; changeId: string }) {
  if (typeof request?.messageId !== 'string' || typeof request?.changeId !== 'string') return
  const candidate = agent.conversation.messages.find(item => item.id === request.messageId)
  const candidateEdit = candidate?.edit
  if (!candidateEdit || candidateEdit.changes.some(change => change.id === request.changeId) === false
    || candidateEdit.snapshot.tabId !== editor.currentFileId || candidateEdit.documentChanged || candidateEdit.locked || candidateEdit.rebasedTo
    || current.value?.markdown !== (candidateEdit.appliedMarkdown ?? candidateEdit.snapshot.markdown)
    || candidate?.task && candidate.task.snapshotId !== candidateEdit.snapshot.snapshotId) return
  messageId.value = request.messageId
  changeId.value = request.changeId
  visible.value = true
}

function locate() {
  if (!valid.value || !edit.value || !targetRange.value || !current.value) return
  const snapshot: DocumentSnapshot = { ...edit.value.snapshot, markdown: current.value.markdown, ...targetRange.value, snapshotId: undefined }
  void agent.locateSource(snapshot)
}

watch([() => editor.currentFileId, () => editor.currentFile?.markdown, valid], () => {
  if (visible.value && !valid.value) close()
}, { flush: 'sync' })

let offOpen: (() => void) | undefined
let offClose: (() => void) | undefined
onMounted(() => {
  offOpen = bus.on('agent-review-preview/open', open)
  offClose = bus.on('agent-review-preview/close', close)
})
onBeforeUnmount(() => { offOpen?.(); offClose?.() })
</script>

<template>
  <aside v-if="visible && valid && change && edit" class="agent-review-preview" aria-live="polite" :aria-label="copy('previewChange')">
    <header>
<strong>{{ edit.title }} · {{ copy('lineRange', { start: change.startLine, end: change.endLine }) }}</strong>
      <button type="button" :aria-label="copy('closePreview')" :title="copy('closePreview')" @click="close"><X :size="14" /></button>
    </header>
    <p class="agent-review-preview-note">{{ copy('previewReadOnly') }}</p>
    <AgentDiffView :change="change" :locale="locale" />
    <footer><button type="button" @click="locate">{{ copy('locateChange') }}</button></footer>
  </aside>
</template>
