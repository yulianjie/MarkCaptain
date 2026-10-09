<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useEditorStore } from '@/stores/editor'
import { useAgentStore } from '@/stores/agent'
import { useI18n } from '@/i18n'
import { isDocumentBoundary, markdownSelection } from '@/services/agent'
import { agentExternalGrant, agentExternalRevoke, agentExternalTake, agentExternalReply } from '@/services/tauri-invoke'
import { ExternalDocumentSession, type ExternalConnection } from '@/services/agent-external'

const editor = useEditorStore(), agent = useAgentStore()
const { locale } = useI18n()
const labels = computed(() => ({
  'zh-CN': { title: '外部 Agent（MCP）', grant: '授权当前文档', revoke: '撤销授权', description: '读取当前未保存正文和选区，提交修改供你审阅。关闭面板、切换或关闭文档即撤销。', active: '此文档已授权', reveal: '查看临时连接凭据', copy: '复制临时环境变量', copied: '已复制', error: '外部 Agent 连接不可用，请重新授权。', secret: '凭据仅本次授权有效。仅交给你信任的本机 MCP 客户端，不要保存到项目配置或提交到 Git。', native: '请在桌面应用中授权。' },
  en: { title: 'External Agent (MCP)', grant: 'Authorize current document', revoke: 'Revoke access', description: 'Read the unsaved buffer and selection; submit edits for your review. Closing this panel or switching/closing the document revokes access.', active: 'This document is authorized', reveal: 'Show temporary connection credentials', copy: 'Copy temporary environment variables', copied: 'Copied', error: 'External Agent connection unavailable. Authorize again.', secret: 'Credentials last only for this grant. Share only with a trusted local MCP client. Do not save in project configuration or commit to Git.', native: 'Authorize in the desktop application.' },
  ja: { title: '外部 Agent (MCP)', grant: '現在の文書を許可', revoke: '許可を取り消す', description: '未保存の本文と選択範囲を読み、変更案をレビューへ送信します。パネルを閉じるか文書を切り替えると許可を取り消します。', active: 'この文書は許可済みです', reveal: '一時接続情報を表示', copy: '一時環境変数をコピー', copied: 'コピーしました', error: '接続できません。再度許可してください。', secret: '接続情報は今回の許可中のみ有効です。信頼するローカル MCP クライアントにのみ渡し、設定や Git に保存しないでください。', native: 'デスクトップアプリで許可してください。' },
}[locale.value]))
const native = '__TAURI_INTERNALS__' in window
const connection = ref<ExternalConnection | null>(null)
const revealed = ref(false), copied = ref(false), error = ref(false), granting = ref(false)
let session: ExternalDocumentSession | null = null
let tabId: string | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let generation = 0

function readBuffer() {
  const tab = editor.currentFile
  if (!tab || tab.id !== tabId) return null
  let selection: { from: number; to: number } | null = null
  if (editor.sourceCodeMode) {
    const data = tab.sourceSelection as { ranges?: { anchor: number; head: number }[]; main?: number } | null
    const selected = data?.ranges?.[data.main ?? 0]
    if (selected) selection = { from: Math.min(selected.anchor, selected.head), to: Math.max(selected.anchor, selected.head) }
  } else {
    try { selection = markdownSelection(tab.markdown, (editor.getMuyaInstance() as { getCursor?: () => unknown } | null)?.getCursor?.(), true) }
    catch { /* No stable editor cursor during an editor transition. */ }
  }
  if (selection && (!isDocumentBoundary(tab.markdown, selection.from) || !isDocumentBoundary(tab.markdown, selection.to))) selection = null
  return { snapshot: { tabId: tab.id, name: tab.filename, markdown: tab.markdown, from: 0, to: tab.markdown.length }, selection }
}

function revoke() {
  generation++; clearTimeout(timer)
  session?.revoke(); session = null; tabId = null
  const previous = connection.value
  connection.value = null; revealed.value = false; copied.value = false
  if (previous) void agentExternalRevoke(previous.documentId).catch(() => { /* Backend lease also expires closed renderers. */ })
}

async function poll(current: ExternalConnection, currentSession: ExternalDocumentSession, epoch: number) {
  if (epoch !== generation) return
  try {
    const requests = await agentExternalTake(current.documentId)
    for (const request of requests) {
      if (epoch !== generation || editor.currentFileId !== tabId) break
      const result = currentSession.handle(request)
      await agentExternalReply(current.documentId, request.id, result)
    }
    if (epoch === generation) timer = setTimeout(() => { void poll(current, currentSession, epoch) }, 150)
  } catch {
    if (epoch === generation) { revoke(); error.value = true }
  }
}

async function grant() {
  if (!native || !editor.currentFile || granting.value) return
  revoke(); error.value = false; granting.value = true
  const selectedTab = editor.currentFile.id, epoch = generation
  try {
    const current = await agentExternalGrant()
    if (epoch !== generation || editor.currentFileId !== selectedTab) { await agentExternalRevoke(current.documentId); return }
    tabId = selectedTab; connection.value = current
    session = new ExternalDocumentSession(current.documentId, { read: readBuffer,
      receive: agent.receiveExternalProposal, review: agent.externalReview })
    await poll(current, session, epoch)
  } catch { if (epoch === generation) error.value = true }
  finally { granting.value = false }
}

const environment = computed(() => connection.value ? JSON.stringify({ MARKCAPTAIN_MCP_PORT: String(connection.value.port), MARKCAPTAIN_MCP_TOKEN: connection.value.token }, null, 2) : '')
async function copy() {
  try { const clipboard = await import('@tauri-apps/plugin-clipboard-manager'); await clipboard.writeText(environment.value); copied.value = true }
  catch { error.value = true }
}
watch(() => editor.currentFileId, revoke, { flush: 'sync' })
watch(() => editor.currentFile?.markdown, () => session?.invalidate(), { flush: 'sync' })
watch(() => editor.currentFile?.sourceSelection, () => session?.invalidate(), { deep: true, flush: 'sync' })
onBeforeUnmount(revoke)
</script>

<template>
  <details class="agent-external">
    <summary>{{ labels.title }}</summary>
    <p>{{ labels.description }}</p>
    <p v-if="!native">{{ labels.native }}</p>
    <template v-else-if="connection">
      <p role="status">{{ labels.active }}: {{ editor.currentFile?.filename }}</p>
      <p>MCP stdio: <code>node {{ JSON.stringify(connection.adapterPath) }}</code></p>
      <button type="button" @click="revoke">{{ labels.revoke }}</button>
      <button type="button" :aria-expanded="revealed" @click="revealed = !revealed">{{ labels.reveal }}</button>
      <div v-if="revealed"><p>{{ labels.secret }}</p><pre>{{ environment }}</pre><button type="button" @click="copy">{{ copied ? labels.copied : labels.copy }}</button></div>
    </template>
    <button v-else type="button" :disabled="!native || !editor.currentFile || granting" @click="grant">{{ labels.grant }}</button>
    <p v-if="error" role="alert">{{ labels.error }}</p>
  </details>
</template>

<style scoped>
.agent-external { padding: 8px 14px; border-bottom: 1px solid var(--el-border-color); font-size: 12px; }
summary { cursor: pointer; }
p { margin: 8px 0; line-height: 1.5; }
button { margin: 0 8px 6px 0; cursor: pointer; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
</style>
