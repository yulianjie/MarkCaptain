import { ref, watch, type Ref, type ComputedRef } from 'vue'
import type { ChatItem, Conversation } from '@/stores/agent'
import { pathsReferToSameFile, type useEditorStore } from '@/stores/editor'
import { agentTransport } from './agent-transport'
import { exportHistory, hydrateHistory, isArchivedProjectSnapshot, packHistory, type HistoryMetadata, type HistoryRecord } from './agent-history'
import { referenceSnapshot } from './agent-references'
import { openFiles, saveAsDialog, saveMarkdown } from './tauri-invoke'
import { t } from '@/i18n'
import { rebasePendingReview } from './agent-rebase'
import type { DocumentSnapshot, ReviewedEdit } from './agent'

export function agentHistoryController(options: {
  sessions: Ref<Record<string, Conversation>>; currentKey: ComputedRef<string>; editor: ReturnType<typeof useEditorStore>
  busy: ComputedRef<boolean>; newConversation: () => Conversation; errorText: (error: unknown) => string
  onHistoryReviewRevalidated?: (edit: ReviewedEdit, markdown: string, request?: ChatItem) => void
}) {
  const { sessions, currentKey, editor, busy } = options
  const historyOpen = ref(false), historyEnabled = ref(false), historyLoaded = ref(false), historyLoading = ref(false), historyError = ref(''), historyReviewError = ref('')
  const historyItems = ref<HistoryMetadata[]>([])
  const queues = new Map<string, Promise<void>>(), removed = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined, disposed = false, initialized: Promise<void> | null = null
  const fail = (error: unknown) => { historyError.value = options.errorText(error) }
  async function refreshHistory() { historyItems.value = await agentTransport.historyList() }
  async function loadHistory() {
    if (initialized) return initialized
    initialized = (async () => {
      try { historyEnabled.value = (await agentTransport.historySettings()).enabled; historyLoaded.value = true }
      catch (error) { fail(error) }
    })()
    await initialized
  }
  function serialize(key: string, chat: Conversation): HistoryRecord {
    const document = editor.tabs.find(tab => tab.id === key)
    const firstSnapshot = chat.messages.find(message => message.contextSnapshot)?.contextSnapshot ?? null
    return packHistory({ id: chat.id, revision: chat.historyRevision, title: chat.messages.find(message => message.role === 'user')?.content.trim().slice(0, 100) || t('agent.title'),
      createdAt: chat.createdAt, updatedAt: Date.now() }, {
      messages: chat.messages, references: chat.references, draft: chat.draft, includeDocument: chat.includeDocument, referenceDocument: chat.referenceDocument,
      selection: chat.selection, skillId: chat.skillId,
    }, document ? referenceSnapshot(document) : firstSnapshot)
  }
  function persist(key: string, chat: Conversation): Promise<void> {
    if (!historyEnabled.value || !chat.messages.length || removed.has(chat.id)) return Promise.resolve()
    const previous = queues.get(chat.id) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(async () => {
      if (removed.has(chat.id)) return
      const record = serialize(key, chat)
      const saved = await agentTransport.historyWrite(record)
      chat.historyRevision = saved.revision
    })
    queues.set(chat.id, task)
    return task
  }
  async function flushHistory() {
    clearTimeout(timer)
    await loadHistory()
    try { await Promise.all(Object.entries(sessions.value).map(([key, chat]) => persist(key, chat))) }
    catch (error) { fail(error); throw error }
  }
  async function openHistory() {
    historyOpen.value = !historyOpen.value
    if (!historyOpen.value) return
    historyLoading.value = true; historyError.value = ''
    try { await loadHistory(); await flushHistory(); await refreshHistory() } catch (error) { fail(error) }
    finally { historyLoading.value = false }
  }
  async function setHistoryEnabled(enabled: boolean) {
    if (historyLoading.value) return
    historyLoading.value = true; historyError.value = ''
    try {
      await loadHistory()
      if (!enabled) await flushHistory()
      historyEnabled.value = (await agentTransport.historySetEnabled(enabled)).enabled
      if (enabled) await flushHistory()
      await refreshHistory()
    } catch (error) { fail(error) } finally { historyLoading.value = false }
  }
  async function restoreHistory(id: string) {
    if (busy.value || historyLoading.value) return
    historyLoading.value = true; historyError.value = ''
    try {
      await flushHistory()
      const { chat, document } = hydrateHistory(await agentTransport.historyRead(id))
      let tab = document ? editor.tabs.find(tab => tab.markdown === document.markdown && (document.path ? pathsReferToSameFile(tab.pathname, document.path) : tab.id === document.tabId)) : undefined
      if (!tab) {
        tab = editor.newUntitledTab(document?.markdown ?? '')
        tab.isSaved = false; tab.lastSavedMarkdown = ''; tab.pendingBaselineUpdate = false
        if (document) tab.filename = document.name
      } else editor.setCurrent(tab.id)
      const target = tab
      function rebind(value: unknown): void {
        if (!value || typeof value !== 'object') return
        const snapshot = value as DocumentSnapshot
        if (typeof snapshot.tabId === 'string' && typeof snapshot.markdown === 'string') {
          if (isArchivedProjectSnapshot(snapshot)) return
          if (document && snapshot.tabId === document.tabId) snapshot.tabId = target.id
          else {
            const found = editor.tabs.find(tab => tab.markdown === snapshot.markdown && (snapshot.path ? pathsReferToSameFile(tab.pathname, snapshot.path) : tab.id === snapshot.tabId))
            snapshot.tabId = found?.id ?? `history-${crypto.randomUUID()}`
          }
          return
        }
        for (const child of Object.values(value)) rebind(child)
      }
      rebind(chat)
      for (const message of chat.messages) if (message.role === 'assistant') { message.targetTabId = target.id; message.answerTarget = null }
      // Previously selected document scopes are history, not fresh authorization for the next request.
      chat.includeDocument = false; chat.referenceDocument = false; chat.references = []; chat.selection = null
      sessions.value[target.id] = { ...options.newConversation(), ...chat, restored: true }
      historyOpen.value = false
    } catch (error) { fail(error) } finally { historyLoading.value = false }
  }
  async function revalidateHistoryReview(messageId: string) {
    if (busy.value || historyLoading.value) return false
    historyLoading.value = true
    historyReviewError.value = ''
    try {
      await loadHistory()
      historyEnabled.value = (await agentTransport.historySettings()).enabled
      historyLoaded.value = true
      if (!historyEnabled.value) { historyReviewError.value = t('agent.history.revalidateNeedsHistory'); return false }
      if (busy.value) return false

      const sourceKey = currentKey.value
      const sourceChat = sessions.value[sourceKey]
      const sourceMessage = sourceChat?.messages.find(message => message.id === messageId)
      const oldEdit = sourceMessage?.edit
      const pending = oldEdit?.changes.filter(change => change.status === 'pending') ?? []
      if (!sourceChat?.restored || !sourceMessage || !oldEdit?.locked || oldEdit.rebasedTo || !pending.length) {
        historyReviewError.value = t('agent.history.revalidateUnavailable')
        return false
      }

      const selected = await openFiles()
      if (!selected.length) return false
      if (selected.length !== 1) { historyReviewError.value = t('agent.history.revalidateChooseOne'); return false }
      if (busy.value || currentKey.value !== sourceKey || sessions.value[sourceKey] !== sourceChat || !sourceChat.messages.includes(sourceMessage)) {
        historyReviewError.value = t('agent.history.revalidateChanged')
        return false
      }

      // openFile uses the normal filesystem authorization path and selects an already-open live buffer when available.
      const target = await editor.openFile(selected[0]!)
      // The file read yields control: never move a replaced session or one that acquired an active request.
      if (busy.value || sessions.value[sourceKey] !== sourceChat || !sourceChat.messages.includes(sourceMessage)
        || sourceMessage.edit !== oldEdit || oldEdit.rebasedTo || !oldEdit.locked || currentKey.value !== target.id) {
        historyReviewError.value = t('agent.history.revalidateChanged')
        return false
      }
      if (!target.pathname || !pathsReferToSameFile(target.pathname, selected[0]!)) {
        editor.setCurrent(sourceKey)
        historyReviewError.value = t('agent.history.revalidateNoPath')
        return false
      }
      const result = rebasePendingReview(oldEdit, target.markdown)
      oldEdit.rebaseConflicts = result.conflicts
      if (!result.edit) {
        editor.setCurrent(sourceKey)
        historyReviewError.value = t('agent.rebaseConflict', { count: result.conflicts.length || pending.length })
        return false
      }

      const targetChat = sessions.value[target.id]
      const hasTargetActivity = !!targetChat && targetChat !== sourceChat
        && (targetChat.messages.length > 0 || targetChat.references.length > 0 || !!targetChat.draft.trim()
          || targetChat.images.length > 0 || !!targetChat.selection || !targetChat.includeDocument
          || targetChat.referenceDocument || !!targetChat.skillId || !!targetChat.dismissedSelection)
      if (hasTargetActivity) {
        editor.setCurrent(sourceKey)
        historyReviewError.value = t('agent.history.revalidateTargetBusy')
        return false
      }

      if (target.id !== sourceKey) {
        delete sessions.value[sourceKey]
        sessions.value[target.id] = sourceChat
      }
      result.edit.snapshot = { ...result.edit.snapshot, tabId: target.id, name: target.filename, path: target.pathname }
      result.edit.rebasedFrom = sourceMessage.id
      result.edit.rebaseConflicts = result.conflicts
      const newMessageId = crypto.randomUUID()
      oldEdit.locked = true
      oldEdit.rebasedTo = newMessageId
      const previousUser = sourceMessage.regenerateFrom
        ? sourceChat.messages.find(message => message.id === sourceMessage.regenerateFrom && message.role === 'user')
        : sourceChat.messages.slice(0, sourceChat.messages.indexOf(sourceMessage)).reverse().find(message => message.role === 'user')
      sourceChat.messages.push({ id: newMessageId, role: 'assistant', content: '', tools: [], completed: true, targetTabId: target.id,
        edit: result.edit, ...(previousUser ? { regenerateFrom: previousUser.id } : {}) })
      options.onHistoryReviewRevalidated?.(result.edit, target.markdown, previousUser)
      if (historyEnabled.value) await persist(target.id, sourceChat)
      if (result.conflicts.length) historyReviewError.value = t('agent.rebaseConflict', { count: result.conflicts.length })
      return true
    } catch (error) {
      historyReviewError.value = options.errorText(error)
      return false
    } finally { historyLoading.value = false }
  }
  async function deleteHistory(item: HistoryMetadata) {
    if (historyLoading.value) return
    historyLoading.value = true; historyError.value = ''
    removed.add(item.id)
    try {
      await queues.get(item.id)?.catch(() => {})
      const latest = await agentTransport.historyRead(item.id)
      await agentTransport.historyDelete(item.id, latest.revision)
      await refreshHistory()
    } catch (error) { removed.delete(item.id); fail(error) } finally { historyLoading.value = false }
  }
  async function exportConversation(item: HistoryMetadata) {
    historyError.value = ''
    try {
      const record = await agentTransport.historyRead(item.id), markdown = exportHistory(record)
      if ('__TAURI_INTERNALS__' in window) {
        const path = await saveAsDialog('conversation.md')
        if (path) await saveMarkdown(path, markdown)
      } else {
        const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }))
        const link = document.createElement('a'); link.href = url; link.download = 'conversation.md'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
      }
    } catch (error) { fail(error) }
  }
  // Observe content, not historyRevision: saving must not schedule another save.
  const off = watch(() => Object.entries(sessions.value).map(([key, chat]) => ({ key, messages: chat.messages, draft: chat.draft, references: chat.references, selection: chat.selection })), () => {
    if (!historyEnabled.value || disposed) return
    clearTimeout(timer)
    timer = setTimeout(() => { void flushHistory().catch(() => {}) }, 900)
  }, { deep: true })
  function disposeHistory() { disposed = true; clearTimeout(timer); off() }
  return { historyOpen, historyEnabled, historyLoaded, historyLoading, historyError, historyReviewError, historyItems, loadHistory, openHistory, setHistoryEnabled,
    restoreHistory, revalidateHistoryReview, deleteHistory, exportConversation, flushHistory, disposeHistory,
    persistCurrent: () => { const chat = sessions.value[currentKey.value]; return chat ? persist(currentKey.value, chat) : Promise.resolve() } }
}
