import { createChapterSummary, summaryJobInput, finishSummaryJob, type ChapterSummary } from '@/services/agent-summary'
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import { createReviewStateTracker } from '@/services/agent-review-state'
import { conversationRequest } from '@/services/agent-conversation-request'
import { openFiles, readMarkdown } from '@/services/tauri-invoke'
import { referenceSnapshot, referenceRequest, validateReferences } from '@/services/agent-references'
import { agentHistoryController } from '@/services/agent-history-controller'
import { defineStore } from 'pinia'
import { useEditorStore, pathsReferToSameFile } from './editor'
import { agentTransport } from '@/services/agent-transport'
import { getLocale, t } from '@/i18n'
import { MAX_MESSAGE_IMAGES, readAgentImage, validateImageBudget } from '@/services/agent-images'
import { bus } from '@/bus'
import { createSearchRevealRequest } from '@/services/search-reveal'
import {
  markdownSelection, reviewProposal, reviewSource, reviewedMarkdown,
  type AgentConfig, type AgentEvent, type AgentHeader, type AgentImage, type AgentMessage, type AgentSettings, type AgentSkill, type AgentSource, type DocumentSnapshot, type ReviewedEdit, type ReferenceSnapshot,
} from '@/services/agent'

export interface ChatItem {
  id: string
  role: 'user' | 'assistant'
  content: string
  attachment?: string
  images?: AgentImage[]
  imagesOmitted?: boolean
  references?: ReferenceSnapshot[]
  contextSnapshot?: DocumentSnapshot | null
  readSnapshot?: DocumentSnapshot | null
  summary?: ChapterSummary
  tools: string[]
  edit?: ReviewedEdit
  error?: string
  cancelled?: boolean
  completed?: boolean
  sources?: AgentSource[]
  targetTabId?: string
  answerTarget?: DocumentSnapshot | null
}
export interface Conversation {
  id: string; createdAt: number; historyRevision: number; restored: boolean
  references: ReferenceSnapshot[]; readingReferences: boolean
  messages: ChatItem[]; draft: string; skillId: string; images: AgentImage[]; readingImages: boolean
  referenceDocument: boolean
  includeDocument: boolean; selection: DocumentSnapshot | null; dismissedSelection: DocumentSnapshot | null
}
function newConversation(): Conversation {
  return { id: crypto.randomUUID(), createdAt: Date.now(), historyRevision: 0, restored: false, references: [], readingReferences: false, referenceDocument: false, messages: [], draft: '', skillId: '', images: [], readingImages: false, includeDocument: true, selection: null, dismissedSelection: null }
}

export function agentError(error: unknown): string {
  const code = String(error).match(/agent:([a-zA-Z]+)/)?.[1] ?? 'unknown'
  const message = t(`agent.errors.${code}`)
  return message.startsWith('agent.errors.') ? t('agent.errors.unknown') : message
}

export const useAgentStore = defineStore('agent', () => {
  const editor = useEditorStore()
  const visible = ref(false)
  const settingsOpen = ref(false)
  const skillsOpen = ref(false)
  const skills = ref<AgentSkill[]>([])
  const skillsLoading = ref(false)
  const skillsError = ref('')
  const config = ref<AgentConfig | null>(null)
  const loadingConfig = ref(false)
  const configError = ref('')
  const error = ref('')
  const contextNotice = ref('')
  const sessions = ref<Record<string, Conversation>>({})
  const reviewStates = createReviewStateTracker()
  let changingReview = false
  function synchronizeReviews() {
    if (changingReview) return
    for (const chat of Object.values(sessions.value)) for (const message of chat.messages) {
      if (message.edit) reviewStates.reconcile(message.edit, editor.tabs.find(tab => tab.id === message.edit!.snapshot.tabId)?.markdown)
    }
  }
  watch(() => editor.tabs.map(tab => [tab.id, tab.markdown]), synchronizeReviews, { flush: 'sync' })
  const currentKey = computed(() => editor.currentFileId ?? 'no-document')
  function getConversation(key = currentKey.value): Conversation {
    if (!sessions.value[key]) sessions.value[key] = newConversation()
    return sessions.value[key]!
  }
  const conversation = computed(() => getConversation())
  const includeDocument = computed({ get: () => conversation.value.includeDocument, set: value => { conversation.value.includeDocument = value } })
  const referenceDocument = computed({ get: () => conversation.value.referenceDocument, set: value => { conversation.value.referenceDocument = value } })
  const selection = computed({ get: () => conversation.value.selection, set: value => { conversation.value.selection = value } })
  const run = ref<{ id: string; key: string; messageId: string; snapshot: DocumentSnapshot | null; readSnapshot?: DocumentSnapshot | null; summaryJob?: number; references?: ReferenceSnapshot[] } | null>(null)
  const summaryActive = ref<{ key: string; messageId: string; cancelled: boolean } | null>(null)
  let summaryBuffer = ''
  let summaryComplete: ((kind: string) => void) | null = null
  const busy = computed(() => run.value !== null || summaryActive.value !== null)
  const runningKey = computed(() => run.value?.key ?? summaryActive.value?.key)
  const runningHere = computed(() => runningKey.value === currentKey.value)
  const stopping = ref(false)
  let startPromise: Promise<void> | null = null
  let unlisten: (() => void) | null = null
  let listening: Promise<void> | null = null
  let disposed = false
  const history = agentHistoryController({ sessions, currentKey, editor, busy, newConversation, errorText: agentError })

  function updateSkills(items: AgentSkill[]) {
    skills.value = items
    for (const chat of Object.values(sessions.value)) {
      if (!items.some(s => s.id === chat.skillId && s.enabled)) chat.skillId = ''
    }
  }
  async function loadSkills() {
    if (skillsLoading.value) return
    skillsLoading.value = true
    skillsError.value = ''
    try { updateSkills(await agentTransport.listSkills()) }
    catch (cause) { skillsError.value = agentError(cause) }
    finally { skillsLoading.value = false }
  }
  async function changeSkills(action: () => Promise<AgentSkill[] | null>) {
    if (skillsLoading.value || busy.value) return
    skillsLoading.value = true
    skillsError.value = ''
    try { const items = await action(); if (items) updateSkills(items) }
    catch (cause) { skillsError.value = agentError(cause) }
    finally { skillsLoading.value = false }
  }

  async function loadConfig() {
    if (loadingConfig.value) return
    loadingConfig.value = true
    configError.value = ''
    try { config.value = await agentTransport.getConfig() }
    catch (cause) { configError.value = agentError(cause) }
    finally { loadingConfig.value = false }
  }

  async function saveConfig(settings: AgentSettings, apiKey?: string, headers?: AgentHeader[]) {
    config.value = await agentTransport.saveConfig(settings, apiKey, headers)
    configError.value = ''
  }

  function toggle() {
    if (!visible.value) attachSelection(true)
    visible.value = !visible.value
    if (visible.value && !config.value) void loadConfig()
    if (visible.value) void history.loadHistory()
  }

  function attachSelection(automatic = false) {
    const tab = editor.currentFile
    if (!tab || automatic && !includeDocument.value) return
    let range: { from: number; to: number } | null = null
    if (editor.sourceCodeMode) {
      const data = tab.sourceSelection as { ranges?: { anchor: number; head: number }[]; main?: number } | null
      const selected = data?.ranges?.[data.main ?? 0]
      if (selected && selected.anchor !== selected.head) range = { from: Math.min(selected.anchor, selected.head), to: Math.max(selected.anchor, selected.head) }
    } else {
      const muya = editor.getMuyaInstance() as { getCursor?: () => unknown } | null
      try { range = markdownSelection(tab.markdown, muya?.getCursor?.()) }
      catch { /* The editor can be switching documents or unmounting. */ }
    }
    if (!range || range.from < 0 || range.to > tab.markdown.length) {
      if (!automatic) error.value = t('agent.errors.noSelection')
      return
    }
    const dismissed = conversation.value.dismissedSelection
    if (automatic && dismissed?.markdown === tab.markdown && dismissed.from === range.from && dismissed.to === range.to) return
    selection.value = { ...referenceSnapshot(tab), ...range }
    conversation.value.dismissedSelection = null
    includeDocument.value = true
    error.value = ''
  }

  function clearSelection() {
    conversation.value.dismissedSelection = selection.value
    selection.value = null
  }

  function addReferenceTab(id: string) {
    if (busy.value) return
    const tab = editor.tabs.find(tab => tab.id === id)
    if (!tab) return
    try {
      const chat = getConversation()
      if (chat.references.some(ref => ref.snapshot.tabId === id)) return
      const references = [...chat.references, { documentId: crypto.randomUUID(), snapshot: referenceSnapshot(tab) }]
      validateReferences(references); chat.references = references; error.value = ''
    } catch (cause) { error.value = agentError(cause) }
  }

  async function chooseReferences() {
    const key = currentKey.value, chat = getConversation()
    if (busy.value || chat.readingReferences) return
    chat.readingReferences = true; error.value = ''
    try {
      const paths = await openFiles()
      const added: ReferenceSnapshot[] = []
      for (const path of paths) {
        if (currentKey.value !== key || sessions.value[key] !== chat || disposed) return
        if (chat.references.some(ref => ref.snapshot.path && pathsReferToSameFile(ref.snapshot.path, path))) continue
        const existing = editor.tabs.find(tab => pathsReferToSameFile(tab.pathname, path))
        let captured: DocumentSnapshot
        if (existing) captured = referenceSnapshot(existing)
        else {
          const file = await readMarkdown(path)
          if (file.hadDecodeErrors) throw new Error('agent:referenceRead')
          // The file may have opened/changed while I/O was pending; prefer its live buffer.
          const opened = editor.tabs.find(tab => pathsReferToSameFile(tab.pathname, path) || pathsReferToSameFile(tab.pathname, file.path))
          const markdown = file.markdown.replace(/\r\n?/g, '\n')
          captured = opened ? referenceSnapshot(opened) : { tabId: `reference-${crypto.randomUUID()}`, name: path.split(/[\\/]/).pop() ?? path, markdown, from: 0, to: markdown.length, path: file.path || path }
        }
        added.push({ documentId: crypto.randomUUID(), snapshot: captured })
        validateReferences([...chat.references, ...added])
      }
      if (currentKey.value === key && sessions.value[key] === chat && !disposed) chat.references.push(...added)
    } catch (cause) { if (currentKey.value === key && sessions.value[key] === chat) error.value = agentError(cause) }
    finally { chat.readingReferences = false }
  }

  async function flushForClose() {
    await stop()
    const deadline = Date.now() + 5000
    while (busy.value && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    if (busy.value) throw new Error(t('agent.stopping'))
    await history.flushHistory()
  }

  async function addImages(files: File[]) {
    const key = currentKey.value, chat = getConversation()
    if (!files.length) return
    if (chat.readingImages) { error.value = t('agent.errors.imageReading'); return }
    if (chat.images.length + files.length > MAX_MESSAGE_IMAGES) { error.value = t('agent.errors.imageCount'); return }
    chat.readingImages = true
    error.value = ''
    try {
      const images: AgentImage[] = []
      for (const file of files) images.push(await readAgentImage(file))
      validateImageBudget([...chat.messages.flatMap(m => m.images ?? []), ...chat.images, ...images])
      // Never attach an asynchronous read to a replacement/new conversation.
      if (!disposed && sessions.value[key] === chat) chat.images.push(...images)
    } catch (cause) {
      if (currentKey.value === key && sessions.value[key] === chat) error.value = agentError(cause)
    } finally { chat.readingImages = false }
  }

  function snapshot(): DocumentSnapshot | null {
    const tab = editor.currentFile
    if (!includeDocument.value || !tab) return null
    if (selection.value?.tabId === tab.id) {
      if (selection.value.markdown !== tab.markdown) throw new Error('agent:selectionChanged')
      return { ...selection.value }
    }
    return referenceSnapshot(tab)
  }

  function receive(event: AgentEvent) {
    const active = run.value
    if (!active || event.requestId !== active.id) return
    const message = sessions.value[active.key]?.messages.find(item => item.id === active.messageId)
    if (!message) return
    if (event.kind === 'delta') {
      if (active.summaryJob !== undefined) {
        summaryBuffer += event.text ?? ''
        if (active.summaryJob === message.summary!.jobs.length - 1) message.content = summaryBuffer
      } else message.content += event.text ?? ''
    }
    if (event.kind === 'tool' && ['read_document', 'search_document', 'cite_document', 'propose_edit', 'read_skill', 'read_skill_file', 'read_review_change'].includes(event.text ?? '')) message.tools.push(event.text!)
    const readSnapshot = active.readSnapshot === undefined ? active.snapshot : active.readSnapshot
    if (event.kind === 'source' && event.text) {
      try {
        const value = JSON.parse(event.text)
        const sourceSnapshot = !value.documentId || value.documentId === 'current' ? readSnapshot : active.references?.find(ref => ref.documentId === value.documentId)?.snapshot
        if (!sourceSnapshot) throw new Error('agent:invalidSource')
        const source = reviewSource(sourceSnapshot, value)
        message.sources ??= []
        if (message.sources.length < 32 && !message.sources.some(item => item.snapshot.tabId === source.snapshot.tabId && item.snapshot.markdown === source.snapshot.markdown && item.snapshot.from === source.snapshot.from && item.snapshot.to === source.snapshot.to && item.label === source.label)) message.sources.push(source)
      } catch { error.value = t('agent.errors.invalidSource') }
    }
    if (event.kind === 'proposal' && event.proposal && active.snapshot) {
      try {
        message.edit = reviewProposal(active.snapshot, event.proposal, message.id)
      } catch { message.error = t('agent.errors.invalidEdit') }
    }
    if (['done', 'error', 'cancelled'].includes(event.kind)) {
      if (active.summaryJob !== undefined) {
        if (event.kind === 'error') message.error = agentError(event.text)
        run.value = null
        const complete = summaryComplete; summaryComplete = null; complete?.(event.kind)
        return
      }
      message.completed = event.kind === 'done'
      if (event.kind !== 'done') delete message.edit
      if (event.kind === 'error') message.error = agentError(event.text)
      if (event.kind === 'cancelled') message.cancelled = true
      run.value = null
      stopping.value = false
      void history.flushHistory().catch(() => {})
    }
  }

  async function ensureListener() {
    if (unlisten) return
    if (!listening) listening = agentTransport.listen(receive).then(off => {
      if (disposed) off()
      else unlisten = off
    }).finally(() => { listening = null })
    await listening
  }

  async function send(prompt = conversation.value.draft, retryContext?: DocumentSnapshot | null, retryReadContext?: DocumentSnapshot | null, retryReferences?: ReferenceSnapshot[]) {
    if (busy.value || skillsLoading.value || conversation.value.readingImages || conversation.value.readingReferences || !prompt.trim() && !conversation.value.images.length) return
    error.value = ''
    contextNotice.value = ''
    synchronizeReviews()
    const chat = getConversation()
    const references = (retryReferences ?? chat.references).map(ref => ({ documentId: ref.documentId, snapshot: { ...ref.snapshot } }))
    const skillIds = chat.skillId ? [chat.skillId] : []
    let attached: DocumentSnapshot | null
    let reading: DocumentSnapshot | null
    let messages: AgentMessage[]
    let reviewChanges: ReturnType<typeof conversationRequest>['reviewChanges']
    try {
      validateReferences(references)
      attached = retryContext === undefined ? snapshot() : retryContext
      if (attached && (attached.tabId !== editor.currentFileId || attached.markdown !== editor.currentFile?.markdown)) throw new Error('agent:selectionChanged')
      reading = retryReadContext === undefined ? (attached && referenceDocument.value ? { ...attached, from: 0, to: attached.markdown.length } : attached) : retryReadContext
      if (reading && (reading.tabId !== attached?.tabId || reading.markdown !== attached.markdown)) throw new Error('agent:selectionChanged')
      validateImageBudget([...chat.messages.flatMap(m => m.images ?? []), ...chat.images])
      if (chat.messages.length >= 22) throw new Error('agent:historyFull')
      const prepared = conversationRequest(chat.messages, prompt, chat.images)
      messages = prepared.messages; reviewChanges = prepared.reviewChanges
      if (prepared.compacted) contextNotice.value = t('agent.feedbackCompacted')
      const documentBytes = new TextEncoder().encode(reading?.markdown.slice(reading.from, reading.to) ?? '').length
      if (documentBytes > 2_000_000) throw new Error('agent:contextTooLarge')
    } catch (cause) { error.value = agentError(cause); return }
    const requestId = crypto.randomUUID()
    const messageId = crypto.randomUUID()
    run.value = { id: requestId, key: currentKey.value, messageId, snapshot: attached, readSnapshot: reading, references }
    chat.messages.push({ id: crypto.randomUUID(), role: 'user', content: prompt.trim(), tools: [], images: chat.images.map(image => ({ ...image })), contextSnapshot: attached, readSnapshot: reading, references,
      attachment: attached ? `${attached.name} · ${reading?.from !== attached.from || reading?.to !== attached.to ? t('agent.referenceDocument') : attached.from !== 0 || attached.to !== attached.markdown.length ? t('agent.selection') : t('agent.document')}` : t('agent.noAttachment') })
    chat.messages.push({ id: messageId, role: 'assistant', content: '', tools: [], targetTabId: editor.currentFileId ?? undefined, answerTarget: currentAnswerTarget() })
    chat.draft = ''
    chat.images = []
    try {
      startPromise = (async () => {
        await ensureListener()
        if (disposed) { run.value = null; return }
        await agentTransport.start({ requestId, messages, language: getLocale(), skillIds,
          ...(reviewChanges.length ? { reviewChanges } : {}),
          references: referenceRequest(references),
          ...(attached && reading && (attached.from !== reading.from || attached.to !== reading.to) ? { editRange: { from: attached.from - reading.from, to: attached.to - reading.from } } : {}),
          context: reading ? { name: reading.name, markdown: reading.markdown.slice(reading.from, reading.to) } : null })
      })()
      await startPromise
    } catch (cause) {
      receive({ requestId, kind: 'error', text: String(cause) })
    } finally { startPromise = null }
  }

  /** Each independent, read-only request has its own timeout and bounded context.
   * Completed jobs survive cancellation; only the currently failed job is retried. */
  async function summarizeChapters(resumeId?: string) {
    if (busy.value || conversation.value.readingImages) return
    const key = currentKey.value, chat = getConversation()
    let message = resumeId ? chat.messages.find(item => item.id === resumeId) : undefined
    try {
      if (!includeDocument.value) throw new Error('agent:summaryNoAttachment')
      const attached = snapshot()
      if (!attached) throw new Error('agent:summaryNoAttachment')
      if (resumeId) {
        const old = message?.summary?.snapshot
        if (!old || old.tabId !== attached.tabId || old.markdown !== attached.markdown || old.from !== attached.from || old.to !== attached.to) throw new Error('agent:summaryChanged')
      } else {
        const summary = createChapterSummary(attached)
        chat.messages.push({ id: crypto.randomUUID(), role: 'user', content: t('agent.chapterSummary'), tools: [], contextSnapshot: attached, attachment: attached.name })
        message = { id: crypto.randomUUID(), role: 'assistant', content: '', tools: [], summary, targetTabId: attached.tabId, answerTarget: currentAnswerTarget() }
        chat.messages.push(message)
        // Work on the reactive proxy, not the original plain object.
        message = chat.messages.at(-1)!
      }
      if (!message?.summary) return
      const summary = message.summary
      summary.status = 'running'; message.error = undefined; message.cancelled = false; message.completed = false; message.content = ''
      error.value = ''
      summaryActive.value = { key, messageId: message.id, cancelled: false }
      await ensureListener()
      for (let index = 0; index < summary.jobs.length; index++) {
        if (summary.jobs[index]!.result !== undefined) continue
        if (disposed || summaryActive.value.cancelled) { summary.status = 'cancelled'; message.cancelled = true; break }
        summary.activeJob = index
        const input = summaryJobInput(summary, index)
        const requestId = crypto.randomUUID()
        summaryBuffer = ''
        run.value = { id: requestId, key, messageId: message.id, snapshot: null, readSnapshot: input.snapshot, summaryJob: index }
        const terminal = new Promise<string>(resolve => { summaryComplete = resolve })
        startPromise = agentTransport.start({ requestId, language: getLocale(), skillIds: [], readOnly: true,
          messages: [{ role: 'user', content: input.prompt }],
          context: input.snapshot ? { name: input.snapshot.name, markdown: input.snapshot.markdown.slice(input.snapshot.from, input.snapshot.to) } : null })
        try { await startPromise } catch (cause) { receive({ requestId, kind: 'error', text: String(cause) }) }
        finally { startPromise = null }
        const kind = await terminal
        if (kind !== 'done') { summary.status = kind === 'cancelled' ? 'cancelled' : 'error'; message.cancelled = kind === 'cancelled'; break }
        finishSummaryJob(summary, index, summaryBuffer)
      }
      if (summary.jobs.every(job => job.result !== undefined)) {
        summary.status = 'done'; message.content = summary.jobs.at(-1)!.result!; message.completed = true
      }
    } catch (cause) {
      if (message?.summary) { message.summary.status = 'error'; message.error = agentError(cause) }
      else error.value = agentError(cause)
    } finally { summaryActive.value = null; run.value = null; stopping.value = false; summaryComplete = null; await history.flushHistory().catch(() => {}) }
  }

  async function stop() {
    if (summaryActive.value) summaryActive.value.cancelled = true
    const active = run.value
    if (!active || stopping.value) return
    stopping.value = true
    try {
      // Listener registration and start acknowledgement must precede cancel.
      if (listening) await listening
      if (startPromise) await startPromise
      if (run.value?.id === active.id) await agentTransport.cancel(active.id)
    } catch (cause) { error.value = agentError(cause); stopping.value = false }
  }

  async function clear() {
    if (busy.value) return
    const key = currentKey.value, previous = getConversation()
    if (history.historyEnabled.value) { try { await history.flushHistory() } catch { return } }
    if (sessions.value[key] !== previous || busy.value) return
    sessions.value[key] = { ...newConversation(), includeDocument: previous.includeDocument, dismissedSelection: previous.selection ?? previous.dismissedSelection }
    error.value = ''
  }

  function currentAnswerTarget(): DocumentSnapshot | null {
    const tab = editor.currentFile
    if (!tab) return null
    let range: { from: number; to: number } | null = null
    if (editor.sourceCodeMode) {
      const data = tab.sourceSelection as { ranges?: { anchor: number; head: number }[]; main?: number } | null
      const current = data?.ranges?.[data.main ?? 0]
      if (current) range = { from: Math.min(current.anchor, current.head), to: Math.max(current.anchor, current.head) }
    } else {
      const muya = editor.getMuyaInstance() as { getCursor?: () => unknown } | null
      try { range = markdownSelection(tab.markdown, muya?.getCursor?.(), true) } catch { /* editor is switching */ }
    }
    if (!range || !Number.isInteger(range.from) || !Number.isInteger(range.to) || range.from < 0 || range.to > tab.markdown.length) return null
    return { ...referenceSnapshot(tab), ...range }
  }

  /** Refresh only while the actual editor has focus; panel focus must not revive stale coordinates. */
  function captureAnswerTarget(leavingEditor: unknown = false) {
    if (leavingEditor !== true && !document.activeElement?.closest('.cm-editor, .muya-host')) return
    const target = currentAnswerTarget()
    if (!target) return
    for (const message of conversation.value.messages) if (message.role === 'assistant' && message.targetTabId === target.tabId) message.answerTarget = target
  }

  function canUseAnswer(message: ChatItem) {
    return !busy.value && message.role === 'assistant' && message.completed === true && !message.error && !message.cancelled && !!message.content.trim()
  }

  function useAnswer(messageId: string, action: 'insert' | 'append' | 'replace' | 'new') {
    const message = conversation.value.messages.find(item => item.id === messageId)
    if (!message || !canUseAnswer(message)) return
    try {
      const content = message.content.replace(/\r\n?/g, '\n')
      if (action === 'new') {
        const tab = editor.newUntitledTab(content)
        tab.isSaved = false
        tab.lastSavedMarkdown = ''
        tab.pendingBaselineUpdate = false
      } else {
        const tab = editor.currentFile
        if (!tab || tab.id !== message.targetTabId) throw new Error('agent:conflict')
        let next: string
        if (action === 'append') next = tab.markdown + (tab.markdown ? '\n\n' : '') + content
        else {
          const target = message.answerTarget
          if (!target || target.tabId !== tab.id || target.markdown !== tab.markdown) throw new Error('agent:answerTargetChanged')
          if (action === 'replace' && target.from === target.to) throw new Error('agent:noSelection')
          next = tab.markdown.slice(0, target.from) + content + tab.markdown.slice(action === 'replace' ? target.to : target.from)
        }
        editor.applyAgentEdit(tab.id, tab.markdown, next)
        selection.value = null
      }
      error.value = ''
    } catch (cause) { error.value = agentError(cause) }
  }

  async function locateSource(snapshot: DocumentSnapshot) {
    try {
      let tab = editor.tabs.find(tab => tab.id === snapshot.tabId) ?? (snapshot.path ? editor.tabs.find(tab => pathsReferToSameFile(tab.pathname, snapshot.path!)) : undefined)
      if (tab && tab.markdown !== snapshot.markdown) throw new Error('agent:sourceChanged')
      if (!tab && snapshot.path) {
        const loaded = await readMarkdown(snapshot.path)
        if (loaded.hadDecodeErrors || loaded.markdown.replace(/\r\n?/g, '\n') !== snapshot.markdown) throw new Error('agent:sourceChanged')
        tab = await editor.openFile(snapshot.path)
        if (tab.markdown !== snapshot.markdown) throw new Error('agent:sourceChanged')
      }
      if (!tab) {
        tab = editor.newUntitledTab(snapshot.markdown)
        tab.filename = snapshot.name; tab.isSaved = false; tab.lastSavedMarkdown = ''; tab.pendingBaselineUpdate = false
      }
      editor.setCurrent(tab.id)
      await nextTick()
      bus.emit('reveal-search-hit', createSearchRevealRequest({ tabId: tab.id, path: tab.pathname ?? '',
        mode: editor.sourceCodeMode ? 'source' : 'wysiwyg', line: 1, column: 1, length: 0,
        exactRange: { markdown: snapshot.markdown, from: snapshot.from, to: snapshot.to } }))
      error.value = ''
    } catch (cause) { error.value = agentError(cause) }
  }

  function updateEditStatus(edit: ReviewedEdit) {
    const statuses = new Set(edit.changes.map(change => change.status))
    edit.status = statuses.size === 1 ? edit.changes[0]!.status : 'partial'
  }

  function setReviewReason(edit: ReviewedEdit, index: number, reason: string) {
    if (busy.value || edit.locked) return
    const change = edit.changes[index]
    if (change) change.reason = reason.slice(0, 1000)
  }

  async function rewrite(edit: ReviewedEdit, index: number) {
    if (busy.value || edit.locked || conversation.value.draft.trim() || conversation.value.images.length) return
    const change = edit.changes[index]
    if (!change || change.status === 'applied') return
    const tab = editor.currentFile
    if (!tab || tab.id !== edit.snapshot.tabId || tab.markdown !== (edit.appliedMarkdown ?? edit.snapshot.markdown)) {
      error.value = t('agent.errors.conflict'); return
    }
    const delta = edit.changes.reduce((sum, c) => sum + (c.status === 'applied' ? c.newText.length - c.oldText.length : 0), 0)
    const attached = { ...edit.snapshot, markdown: tab.markdown, to: edit.snapshot.to + delta }
    const reading = referenceDocument.value ? { ...attached, from: 0, to: tab.markdown.length } : attached
    await send(t('agent.rewritePrompt', { id: change.id, reason: change.reason?.trim() || t('agent.rewriteDefault') }), attached, reading)
  }

  function apply(edit: ReviewedEdit, index?: number) {
    if (busy.value || edit.locked) return
    const pending = edit.changes.map((change, i) => change.status === 'pending' && (index === undefined || i === index) ? i : -1).filter(i => i >= 0)
    if (!pending.length) return
    try {
      const accepted = edit.changes.map((change, i) => change.status === 'applied' ? i : -1).filter(i => i >= 0)
      const next = reviewedMarkdown(edit, [...accepted, ...pending])
      reviewStates.remember(edit)
      changingReview = true
      try { edit.appliedMarkdown = editor.applyAgentEdit(edit.snapshot.tabId, edit.appliedMarkdown ?? edit.snapshot.markdown, next) }
      finally { changingReview = false }
      for (const i of pending) edit.changes[i]!.status = 'applied'
      updateEditStatus(edit)
      reviewStates.remember(edit)
      synchronizeReviews()
      selection.value = null
      error.value = ''
    } catch (cause) { error.value = agentError(cause) }
  }

  function dismiss(edit: ReviewedEdit, index?: number) {
    if (busy.value || edit.locked) return
    for (const [i, change] of edit.changes.entries()) if (change.status === 'pending' && (index === undefined || index === i)) change.status = 'dismissed'
    updateEditStatus(edit)
  }

  function revert(edit: ReviewedEdit, index?: number) {
    if (busy.value || edit.locked || edit.appliedMarkdown === undefined) return
    const reverting = edit.changes.map((change, i) => change.status === 'applied' && (index === undefined || index === i) ? i : -1).filter(i => i >= 0)
    if (!reverting.length) return
    try {
      const remaining = edit.changes.map((change, i) => change.status === 'applied' && !reverting.includes(i) ? i : -1).filter(i => i >= 0)
      reviewStates.remember(edit)
      changingReview = true
      try { edit.appliedMarkdown = editor.applyAgentEdit(edit.snapshot.tabId, edit.appliedMarkdown, reviewedMarkdown(edit, remaining)) }
      finally { changingReview = false }
      for (const i of reverting) edit.changes[i]!.status = 'reverted'
      updateEditStatus(edit)
      reviewStates.remember(edit)
      synchronizeReviews()
      error.value = ''
    } catch (cause) { error.value = agentError(cause) }
  }

  function retry() {
    if (busy.value) return
    const chat = getConversation()
    if (chat.readingImages || chat.draft.trim() || chat.images.length) return
    const last = chat.messages.at(-1)
    const user = chat.messages.at(-2)
    if (last?.summary && (last.error || last.cancelled)) { void summarizeChapters(last.id); return }
    if (last?.role !== 'assistant' || user?.role !== 'user' || !(last.error || last.cancelled)) return
    if (user.imagesOmitted) { error.value = t('agent.errors.historyImages'); return }
    chat.messages.splice(-2)
    chat.draft = user.content
    chat.images = user.images?.map(image => ({ ...image })) ?? []
    if (user.imagesOmitted) { error.value = t('agent.errors.historyImages'); return }
    void send(user.content, user.contextSnapshot, user.readSnapshot, user.references ?? [])
  }

  onScopeDispose(() => {
    history.disposeHistory()
    disposed = true
    void stop()
    unlisten?.()
  })

  return { ...history, addReferenceTab, chooseReferences, flushForClose, visible, settingsOpen, skillsOpen, skills, skillsLoading, skillsError, loadSkills, changeSkills, config, loadingConfig, configError, error, includeDocument, referenceDocument, selection, conversation,
    busy, runningHere, runningKey, stopping, run, toggle, loadConfig, saveConfig, attachSelection, clearSelection, addImages, send, summarizeChapters, stop, clear, apply, dismiss, revert, retry,
    captureAnswerTarget, canUseAnswer, useAnswer, locateSource, setReviewReason, rewrite, contextNotice }
})
