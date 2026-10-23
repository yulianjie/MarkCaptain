import { createChapterSummary, summaryJobInput, finishSummaryJob, type ChapterSummary } from '@/services/agent-summary'
import { computed, nextTick, onScopeDispose, ref, shallowRef, toRaw, watch } from 'vue'
import { createAgentMultiDocumentController } from '@/services/agent-multi-document'
import { createAgentMultiState } from '@/services/agent-multi-types'
import { createReviewStateTracker } from '@/services/agent-review-state'
import { createAgentTaskContext, MAX_CONTEXT_PREVIEW_CHARS, MAX_CONTEXT_READS_PER_TURN, parseAgentContextRead, type AgentContextRead, type AgentTaskContext } from '@/services/agent-context'
import { AGENT_WRITING_COMMANDS, agentWritingCommandPrompt, type AgentWritingCommand } from '@/services/agent-m1-copy'
import type { AgentProposal } from '@/services/agent'
import { rebasePendingReview, refreshedReviewSnapshot } from '@/services/agent-rebase'
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
import { useProjectStore, pathIsInsideRoot } from './project'
import { agentProjectGrant, agentProjectRevoke, agentProjectLoadConfig, agentProjectSaveConfig, agentCheckDocument } from '@/services/tauri-invoke'
import { cleanLines, isProjectDocumentId, isSafeWebQuery, normalizeProjectConfig, parseProjectSource, snapshotDirtyProjectBuffers, suggestDocumentQueries, validateDocumentCheck, validateProjectPatterns, validateProjectReadReferences, validatePublicUrl, validateWebResearch } from '@/services/agent-m2'
import { agentM2Copy, agentM2ModelCheckPrompt, agentM2RepairPrompt } from '@/services/agent-m2-copy'
import {
  isDocumentBoundary, markdownSelection, reviewProposal, reviewSource, reviewedMarkdown,
  type AgentConfig, type AgentDocumentCheckResult, type AgentEvent, type AgentHeader, type AgentImage, type AgentMessage, type AgentProjectConfig, type AgentSettings, type AgentSkill, type AgentSource, type AgentWebSource, type DocumentSnapshot, type ReviewedEdit, type ReferenceSnapshot,
} from '@/services/agent'

export interface ChatItem {
  externalProposalId?: string
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
  task?: AgentTaskContext
  contextReads?: AgentContextRead[]
  edit?: ReviewedEdit
  error?: string
  cancelled?: boolean
  completed?: boolean
  sources?: AgentSource[]
  webSources?: AgentWebSource[]
  readOnlyRequest?: boolean
  projectSearchResults?: { documentId: string; path: string; title: string; snippet: string; line: number }[]
  projectSearchComplete?: boolean
  targetTabId?: string
  answerTarget?: DocumentSnapshot | null
  /** Local source request retained when a stale proposal becomes a new review card. */
  regenerateFrom?: string
}
export interface Conversation {
  id: string; createdAt: number; historyRevision: number; restored: boolean
  references: ReferenceSnapshot[]; readingReferences: boolean
  messages: ChatItem[]; draft: string; skillId: string; images: AgentImage[]; readingImages: boolean
  referenceDocument: boolean
  includeDocument: boolean; selection: DocumentSnapshot | null; dismissedSelection: DocumentSnapshot | null
  /** Session-only consent. These fields are deliberately omitted from history serialization. */
  projectAccess: { root: string; include: string[]; exclude: string[]; authorizedInclude: string[]; authorizedExclude: string[]; grantId: string | null; busy: boolean; error: string }
  webResearch: { enabled: boolean; topic: string; allowDocumentQueries: boolean; approvedQueries: string[]; suggestedQueries: string[]; urls: string[]; publicDns: boolean }
  applyProjectWritingRules: boolean
}
function newConversation(): Conversation {
  return { id: crypto.randomUUID(), createdAt: Date.now(), historyRevision: 0, restored: false, references: [], readingReferences: false, referenceDocument: false, messages: [], draft: '', skillId: '', images: [], readingImages: false, includeDocument: true, selection: null, dismissedSelection: null,
    projectAccess: { root: '', include: ['**/*.md'], exclude: [], authorizedInclude: [], authorizedExclude: [], grantId: null, busy: false, error: '' },
    webResearch: { enabled: false, topic: '', allowDocumentQueries: false, approvedQueries: [], suggestedQueries: [], urls: [], publicDns: false }, applyProjectWritingRules: false }
}

export function agentError(error: unknown): string {
  const code = String(error).match(/agent:([a-zA-Z]+)/)?.[1] ?? 'unknown'
  const m2Errors: Record<string, Parameters<typeof agentM2Copy>[1]> = {
    projectBuffersTooLarge: 'projectBuffersTooLarge', projectBufferConflict: 'projectBufferConflict', projectReferenceLimit: 'projectReferenceLimit', projectPatternInvalid: 'projectPatternInvalid', projectUnavailable: 'projectUnavailable',
    projectPatternLimit: 'projectPatternInvalid', projectScopeEmpty: 'projectScopeEmpty', projectConfigConflict: 'projectConfigConflict', projectScopeChanged: 'projectScopeChanged',
    projectConfigVersion: 'projectConfigVersion', projectConfigInvalid: 'projectConfigInvalid', projectConfigTooLarge: 'projectConfigTooLarge', projectConfigContainsCredentials: 'projectConfigContainsCredentials',
    projectGrantChanged: 'projectGrantNeedsRenewal', projectGrantExpired: 'projectGrantNeedsRenewal', projectGrantInvalid: 'projectGrantNeedsRenewal', projectGrantLimit: 'projectGrantNeedsRenewal', projectNotOwned: 'projectNotOwned',
    projectBufferLimit: 'projectBufferLimit', projectBufferInvalid: 'projectBufferScope', projectBufferOutsideRoot: 'projectBufferScope', projectDocumentOutsideScope: 'projectBufferScope', projectSearchLimit: 'projectSearchUnavailable', projectReadBudgetReached: 'projectSearchUnavailable',
    webResearchEmpty: 'webResearchEmpty', webResearchLimit: 'webResearchLimit', webUrlInvalid: 'urlInvalid', webInvalidUrl: 'urlInvalid',
    webQueryRejected: 'webQueryRejected', webQueryNotApproved: 'webQueryNotApproved', webResearchDisabled: 'webResearchDisabled',
    webSearchUnavailable: 'webUnavailable', webSourceUnavailable: 'webUnavailable', webSourceLimit: 'webResearchLimit', webPublicDnsUnavailable: 'webPublicDnsUnavailable',
    projectCheckFailed: 'checkFailed', projectCheckSourceNotAuthorized: 'checkFailed',
    checkStale: 'checkStale', checkInvalid: 'checkInvalid',
  }
  if (m2Errors[code]) return agentM2Copy(getLocale(), m2Errors[code]!)
  const message = t(`agent.errors.${code}`)
  return message.startsWith('agent.errors.') ? t('agent.errors.unknown') : message
}

export const useAgentStore = defineStore('agent', () => {
  const editor = useEditorStore()
  const project = useProjectStore()
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
  const run = ref<{ id: string; key: string; messageId: string; snapshot: DocumentSnapshot | null; readSnapshot?: DocumentSnapshot | null; summaryJob?: number; references?: ReferenceSnapshot[]; projectRoot?: string; projectGrantId?: string; readOnly?: boolean } | null>(null)
  const summaryActive = ref<{ key: string; messageId: string; cancelled: boolean } | null>(null)
  let summaryBuffer = ''
  let summaryComplete: ((kind: string) => void) | null = null
  const multiDocumentState = shallowRef(createAgentMultiState())
  const busy = computed(() => run.value !== null || summaryActive.value !== null || multiDocumentState.value.busy || multiDocumentState.value.actionBusy)
  const runningKey = computed(() => run.value?.key ?? summaryActive.value?.key)
  const runningHere = computed(() => runningKey.value === currentKey.value)
  const stopping = ref(false)
  let startPromise: Promise<void> | null = null
  let unlisten: (() => void) | null = null
  let listening: Promise<void> | null = null
  let disposed = false
  // Verified relinks retain their source prompt without rewriting archived snapshots or restoring consent.
  const relinkedReviewRequests = new WeakMap<ReviewedEdit, { request: ChatItem; tabId: string }>()
  const history = agentHistoryController({ sessions, currentKey, editor, busy, newConversation, errorText: agentError,
    onHistoryReviewRevalidated: (edit, markdown, request) => {
      if (request) relinkedReviewRequests.set(toRaw(edit), { request, tabId: edit.snapshot.tabId })
      reviewStates.reconcile(edit, markdown)
    } })
  const multiDocument = createAgentMultiDocumentController({
    editor,
    isOtherBusy: () => run.value !== null || summaryActive.value !== null || history.historyLoading.value,
    hasConfig: () => Boolean(config.value) && !loadingConfig.value,
    language: getLocale,
    onChange: state => { multiDocumentState.value = { ...state } },
  })

  const projectConfig = ref<AgentProjectConfig>(normalizeProjectConfig(null))
  const projectConfigFingerprint = ref<string | null>(null)
  const projectConfigRoot = ref('')
  const projectConfigLoading = ref(false)
  const projectConfigSaving = ref(false)
  const projectConfigError = ref('')
  const projectConfigSaved = ref(false)
  const documentCheck = ref<{ tabId: string; markdown: string; result: AgentDocumentCheckResult } | null>(null)
  const documentCheckBusy = ref(false)
  const documentCheckError = ref('')
  let documentCheckRevision = 0
  watch([() => editor.currentFileId, () => editor.currentFile, () => editor.currentFile?.pathname,
    () => editor.currentFile?.markdown, () => project.projectTree?.pathname], () => {
    documentCheckRevision++
    if (documentCheck.value || documentCheckBusy.value) documentCheckError.value = agentError('agent:checkStale')
    documentCheck.value = null
    documentCheckBusy.value = false
  }, { flush: 'sync' })
  let projectRootRevision = 0
  watch(projectConfig, () => {
    if (!projectConfigLoading.value && !projectConfigSaving.value) projectConfigSaved.value = false
  }, { deep: true, flush: 'sync' })

  async function loadProjectConfig(root = project.projectTree?.pathname ?? '') {
    if (!root) { projectConfigRoot.value = ''; projectConfig.value = normalizeProjectConfig(null); projectConfigFingerprint.value = null; return }
    const revision = ++projectRootRevision
    projectConfigLoading.value = true; projectConfigError.value = ''; projectConfigSaved.value = false
    try {
      const snapshot = await agentProjectLoadConfig(root)
      if (revision !== projectRootRevision || (project.projectTree?.pathname ?? '') !== root) return
      projectConfigRoot.value = root
      projectConfig.value = normalizeProjectConfig(snapshot.config)
      projectConfigFingerprint.value = snapshot.fingerprint
    } catch (cause) {
      if (revision === projectRootRevision) projectConfigError.value = agentError(cause)
    } finally { if (revision === projectRootRevision) projectConfigLoading.value = false }
  }

  async function saveProjectConfig() {
    const root = project.projectTree?.pathname ?? ''
    if (!root || root !== projectConfigRoot.value || projectConfigSaving.value) return
    projectConfigSaving.value = true; projectConfigError.value = ''; projectConfigSaved.value = false
    try {
      const normalized = normalizeProjectConfig(projectConfig.value)
      validateProjectPatterns(normalized.projectSearch?.include ?? ['**/*.md'], normalized.projectSearch?.exclude ?? [])
      const submittedConfig = JSON.stringify(normalized)
      const saved = await agentProjectSaveConfig(root, normalized, projectConfigFingerprint.value)
      if ((project.projectTree?.pathname ?? '') !== root) return
      projectConfigFingerprint.value = saved.fingerprint
      if (JSON.stringify(projectConfig.value) === submittedConfig) {
        projectConfig.value = normalizeProjectConfig(saved.config); projectConfigSaved.value = true
      }
      // Saved defaults are suggestions only; the current conversation still needs an explicit grant.
      if (!conversation.value.projectAccess.grantId) {
        conversation.value.projectAccess.include = [...(projectConfig.value.projectSearch?.include ?? ['**/*.md'])]
        conversation.value.projectAccess.exclude = [...(projectConfig.value.projectSearch?.exclude ?? [])]
      }
    } catch (cause) { projectConfigError.value = agentError(cause) }
    finally { projectConfigSaving.value = false }
  }

  async function revokeProjectAccess(chat: Conversation = conversation.value) {
    const id = chat.projectAccess.grantId
    chat.projectAccess.grantId = null; chat.projectAccess.root = ''; chat.projectAccess.authorizedInclude = []; chat.projectAccess.authorizedExclude = []
    if (id) try { await agentProjectRevoke(id) } catch { /* Revocation is also enforced when the project/session expires. */ }
  }

  watch(() => project.projectTree?.pathname ?? '', (root, previous) => {
    if (root === previous) return
    documentCheck.value = null; documentCheckError.value = ''; conversation.value.applyProjectWritingRules = false
    for (const chat of Object.values(sessions.value)) {
      chat.applyProjectWritingRules = false
      if (chat.projectAccess.grantId) void revokeProjectAccess(chat)
      chat.projectAccess.root = ''
      chat.projectAccess.authorizedInclude = []; chat.projectAccess.authorizedExclude = []
      chat.projectAccess.include = ['**/*.md']; chat.projectAccess.exclude = []
      // A root change is a consent boundary; clear query approvals derived for the previous workspace.
      chat.webResearch.enabled = false; chat.webResearch.publicDns = false; chat.webResearch.allowDocumentQueries = false
      chat.webResearch.approvedQueries = []; chat.webResearch.suggestedQueries = []; chat.webResearch.urls = []
    }
    if (root) {
      projectConfigRoot.value = root
      projectConfig.value = normalizeProjectConfig(null)
      projectConfigFingerprint.value = null
      void loadProjectConfig(root)
    }
    else { projectConfigRoot.value = ''; projectConfig.value = normalizeProjectConfig(null); projectConfigFingerprint.value = null }
  }, { immediate: true })

  async function setProjectSearchEnabled(enabled: boolean) {
    const chat = conversation.value, root = project.projectTree?.pathname ?? ''
    if (chat.projectAccess.busy) return
    if (!enabled) { await revokeProjectAccess(chat); chat.projectAccess.error = ''; return }
    if (!root) { chat.projectAccess.error = agentError('agent:projectUnavailable'); return }
    const include = cleanLines(chat.projectAccess.include, ['**/*.md'])
    const exclude = cleanLines(chat.projectAccess.exclude)
    try { validateProjectPatterns(include, exclude) }
    catch (cause) { chat.projectAccess.error = agentError(cause); return }
    if (!include.length) { chat.projectAccess.error = agentError('agent:projectScopeEmpty'); return }
    chat.projectAccess.busy = true; chat.projectAccess.error = ''
    try {
      const previous = chat.projectAccess.grantId
      if (previous) {
        chat.projectAccess.grantId = null
        chat.projectAccess.authorizedInclude = []; chat.projectAccess.authorizedExclude = []
        await agentProjectRevoke(previous)
      }
      const grant = await agentProjectGrant(root, include, exclude)
      if ((project.projectTree?.pathname ?? '') !== root || conversation.value !== chat) {
        await agentProjectRevoke(grant.grantId); return
      }
      chat.projectAccess.root = root; chat.projectAccess.include = include; chat.projectAccess.exclude = exclude
      chat.projectAccess.authorizedInclude = [...include]; chat.projectAccess.authorizedExclude = [...exclude]; chat.projectAccess.grantId = grant.grantId
    } catch (cause) { chat.projectAccess.error = agentError(cause) }
    finally { chat.projectAccess.busy = false }
  }

  async function checkCurrentDocument() {
    const tab = editor.currentFile, root = project.projectTree?.pathname ?? ''
    if (!tab || documentCheckBusy.value) return
    const tabId = tab.id, markdown = tab.markdown, sourcePath = tab.pathname || undefined
    const revision = ++documentCheckRevision
    documentCheckBusy.value = true; documentCheckError.value = ''; documentCheck.value = null
    const authorizedRoot = root && sourcePath && pathIsInsideRoot(root, sourcePath) ? root : undefined
    try {
      const raw = await agentCheckDocument(markdown, authorizedRoot, sourcePath)
      if (disposed || revision !== documentCheckRevision) return
      const result = validateDocumentCheck(raw, markdown)
      const current = editor.currentFile
      if (editor.currentFileId === tabId && current?.id === tabId && current.markdown === markdown) documentCheck.value = { tabId, markdown, result }
      else documentCheckError.value = agentError('agent:checkStale')
    } catch (cause) {
      if (!disposed && revision === documentCheckRevision) documentCheckError.value = agentError(cause)
    } finally {
      if (!disposed && revision === documentCheckRevision) documentCheckBusy.value = false
    }
  }

  function locateDocumentIssue(issue: AgentDocumentCheckResult['issues'][number]) {
    const checked = documentCheck.value, tab = editor.tabs.find(item => item.id === checked?.tabId)
    if (!checked || !tab || tab.markdown !== checked.markdown || issue.from < 0 || issue.to > tab.markdown.length) return
    editor.setCurrent(tab.id)
    bus.emit('reveal-search-hit', createSearchRevealRequest({ tabId: tab.id, path: tab.pathname ?? '', mode: editor.sourceCodeMode ? 'source' : 'wysiwyg', line: issue.line, column: issue.column, length: Math.max(0, issue.to - issue.from), exactRange: { markdown: tab.markdown, from: issue.from, to: issue.to } }))
  }

  function suggestWebQueries() {
    const chat = conversation.value
    if (!chat.webResearch.allowDocumentQueries || !editor.currentFile) return
    chat.webResearch.suggestedQueries = suggestDocumentQueries(editor.currentFile.markdown, chat.webResearch.topic)
  }

  function approveWebQuery(candidate: string) {
    const query = candidate.trim()
    if (!isSafeWebQuery(query)) { error.value = agentError('agent:webQueryRejected'); return }
    if (new TextEncoder().encode(query).length > 320 || conversation.value.webResearch.approvedQueries.length >= 8) {
      error.value = agentError('agent:webResearchLimit'); return
    }
    if (!conversation.value.webResearch.approvedQueries.includes(query)) conversation.value.webResearch.approvedQueries.push(query)
    error.value = ''
  }

  async function openWebSource(value: string) {
    const url = validatePublicUrl(value)
    if (!url) { error.value = agentError('agent:webUrlInvalid'); return }
    try { const shell = await import('@tauri-apps/plugin-shell'); await shell.open(url) }
    catch (cause) { error.value = agentError(cause) }
  }

  function requestModelCheck() {
    const tab = editor.currentFile
    if (!tab) return
    void send(agentM2ModelCheckPrompt(getLocale()), referenceSnapshot(tab), referenceSnapshot(tab), undefined, { readOnly: true })
  }

  function requestDocumentRepair(issue: AgentDocumentCheckResult['issues'][number]) {
    const tab = editor.currentFile
    if (!tab || !documentCheck.value || documentCheck.value.tabId !== tab.id || documentCheck.value.markdown !== tab.markdown) {
      error.value = agentError('agent:checkStale'); return
    }
    void send(agentM2RepairPrompt(getLocale(), issue), referenceSnapshot(tab), referenceSnapshot(tab))
  }

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

  /** Shared entry point for the panel, command palette, selection menu, and shortcuts. */
  function queueWritingCommand(command: AgentWritingCommand) {
    if (!AGENT_WRITING_COMMANDS.includes(command)) return
    attachSelection(true)
    conversation.value.draft = agentWritingCommandPrompt(command, getLocale())
    visible.value = true
    error.value = ''
  }

  function taskSkills(selected: string[] = []) {
    return skills.value.filter(skill => skill.enabled).map(skill => ({ id: skill.id, name: skill.name, selected: selected.includes(skill.id) }))
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
    const activeChat = sessions.value[active.key]
    const message = activeChat?.messages.find(item => item.id === active.messageId)
    if (!message) return
    const projectGrantIsCurrent = Boolean(active.projectGrantId && active.projectRoot
      && activeChat?.projectAccess.grantId === active.projectGrantId
      && activeChat.projectAccess.root === active.projectRoot
      && project.projectTree?.pathname === active.projectRoot)
    if (event.kind === 'error' && activeChat?.projectAccess.grantId === active.projectGrantId
      && /agent:projectGrant(?:Changed|Expired|Invalid)|agent:projectNotOwned/.test(event.text ?? '')) void revokeProjectAccess(activeChat)
    if (event.kind === 'delta') {
      if (message.task?.status === 'preparing') message.task.status = 'generating'
      if (active.summaryJob !== undefined) {
        summaryBuffer += event.text ?? ''
        if (active.summaryJob === message.summary!.jobs.length - 1) message.content = summaryBuffer
      } else message.content += event.text ?? ''
    }
    if (event.kind === 'tool' && ['read_document', 'search_document', 'cite_document', 'search_project', 'read_project_document', 'search_web', 'open_web_source', 'propose_edit', 'read_skill', 'read_skill_file', 'read_review_change'].includes(event.text ?? '')) {
      message.tools.push(event.text!)
      if (message.task) message.task.status = ['read_document', 'search_document', 'cite_document', 'search_project', 'read_project_document', 'search_web', 'open_web_source'].includes(event.text ?? '') ? 'reading' : 'generating'
    }
    if (event.kind === 'context' && event.text && message.task) {
      try {
        const read = parseAgentContextRead(JSON.parse(event.text), message.task, `${active.id}:${message.contextReads?.length ?? 0}`)
        if (read) {
          message.contextReads ??= []
          if (message.contextReads.length < MAX_CONTEXT_READS_PER_TURN) message.contextReads.push(read)
        }
      } catch { /* A malformed diagnostic event must not interfere with model output. */ }
      message.task.status = 'generating'
    }
    if (event.kind === 'project_search' && event.text && active.projectRoot && active.projectGrantId && projectGrantIsCurrent) {
      try {
        const value = JSON.parse(event.text) as { results?: unknown; matches?: unknown; complete?: unknown; completeness?: { complete?: unknown } }
        const candidates = value.matches ?? value.results
        const results = Array.isArray(candidates) ? candidates.slice(0, 100).flatMap((candidate: unknown) => {
          if (!candidate || typeof candidate !== 'object') return []
          const item = candidate as Record<string, unknown>
          if (typeof item.documentId !== 'string' || !isProjectDocumentId(item.documentId)
            || typeof item.path !== 'string' || item.path.length > 1000 || item.path.startsWith('/') || /^[a-z]:/i.test(item.path) || item.path.split(/[\\/]/).includes('..')
            || typeof item.title !== 'string' || typeof item.snippet !== 'string' || !Number.isInteger(item.line)) return []
          return [{ documentId: item.documentId, path: item.path, title: item.title.slice(0, 300), snippet: item.snippet.slice(0, 1200), line: Number(item.line) }]
        }) : []
        message.projectSearchResults ??= []
        for (const item of results) if (!message.projectSearchResults.some(existing => existing.documentId === item.documentId)) message.projectSearchResults.push(item)
        message.projectSearchComplete = value.complete === true || value.completeness?.complete === true
      } catch { /* Malformed candidate metadata is discarded. */ }
    }
    const readSnapshot = active.readSnapshot === undefined ? active.snapshot : active.readSnapshot
    if (event.kind === 'project_source' && event.text && active.projectRoot && active.projectGrantId && projectGrantIsCurrent) {
      try {
        const value = parseProjectSource(JSON.parse(event.text), active.projectRoot, pathIsInsideRoot, active.id)
        if (!value) throw new Error('agent:invalidSource')
        const existingRef = active.references?.find(item => item.documentId === value.documentId)
        if (!existingRef) {
          const ref: ReferenceSnapshot = { documentId: value.documentId, snapshot: value.snapshot }
          const projectReferences = [...(message.references ?? []), ref]
          validateProjectReadReferences(projectReferences, active.projectRoot, pathIsInsideRoot)
          active.references = [...(active.references ?? []), ref]
          message.references = projectReferences
          if (message.task && !message.task.sources.some(source => source.documentId === ref.documentId)) {
            message.task.sources.push({ documentId: ref.documentId, name: ref.snapshot.name, kind: 'reference' })
          }
        }
      } catch (cause) { error.value = agentError(cause) }
    }
    if (event.kind === 'web_source' && event.text) {
      try {
        const value = JSON.parse(event.text) as Partial<AgentWebSource>
        const url = typeof value.url === 'string' ? validatePublicUrl(value.url) : null
        if (!url || typeof value.sourceId !== 'string' || value.sourceId.length > 128 || typeof value.title !== 'string'
          || typeof value.fetchedAt !== 'string' || value.fetchedAt.length > 64 || Number.isNaN(Date.parse(value.fetchedAt))
          || value.publishedAt != null && (typeof value.publishedAt !== 'string' || value.publishedAt.length > 128)
          || url.length > 4096
          || typeof value.excerpt !== 'string' || !['snippet', 'read', 'failed'].includes(value.status ?? '')) throw new Error('agent:invalidSource')
        const source: AgentWebSource = { sourceId: value.sourceId, title: value.title.slice(0, 300), url,
          fetchedAt: value.fetchedAt, ...(typeof value.publishedAt === 'string' ? { publishedAt: value.publishedAt } : {}),
          excerpt: value.excerpt.slice(0, 6000), status: value.status!, ...(typeof value.error === 'string' ? { error: value.error.slice(0, 500) } : {}) }
        message.webSources ??= []
        const existing = message.webSources.findIndex(item => item.sourceId === source.sourceId)
        if (existing >= 0) message.webSources.splice(existing, 1, source)
        else if (message.webSources.length < 40) message.webSources.push(source)
      } catch { /* Invalid source cards are discarded; never render event HTML. */ }
    }
    if (event.kind === 'source' && event.text) {
      try {
        const value = JSON.parse(event.text)
        const sourceSnapshot = !value.documentId || value.documentId === 'current' ? readSnapshot
          : active.references?.find(ref => ref.documentId === value.documentId)?.snapshot
        if (!sourceSnapshot) throw new Error('agent:invalidSource')
        const source = reviewSource(sourceSnapshot, value)
        message.sources ??= []
        if (message.sources.length < 32 && !message.sources.some(item => item.snapshot.tabId === source.snapshot.tabId && item.snapshot.markdown === source.snapshot.markdown && item.snapshot.from === source.snapshot.from && item.snapshot.to === source.snapshot.to && item.label === source.label)) message.sources.push(source)
      } catch { error.value = t('agent.errors.invalidSource') }
    }
    if (event.kind === 'proposal' && event.proposal && active.snapshot && !active.readOnly) {
      try {
        message.edit = reviewProposal(active.snapshot, event.proposal, message.id)
        reviewStates.reconcile(message.edit, editor.tabs.find(tab => tab.id === active.snapshot!.tabId)?.markdown)
        if (message.task) message.task.status = message.edit.changes.some(change => change.status === 'pending') ? 'awaitingReview' : 'completed'
      } catch { message.error = t('agent.errors.invalidEdit') }
    }
    if (['done', 'error', 'cancelled'].includes(event.kind)) {
      if (active.summaryJob !== undefined) {
        if (event.kind === 'error') message.error = agentError(event.text)
        if (message.task) message.task.status = event.kind === 'error' ? 'failed' : event.kind === 'cancelled' ? 'cancelled' : 'reading'
        run.value = null
        const complete = summaryComplete; summaryComplete = null; complete?.(event.kind)
        return
      }
      message.completed = event.kind === 'done'
      if (event.kind !== 'done') delete message.edit
      if (event.kind === 'error') message.error = agentError(event.text)
      if (event.kind === 'cancelled') message.cancelled = true
      if (message.task) message.task.status = event.kind === 'error' ? 'failed' : event.kind === 'cancelled' ? 'cancelled' : message.edit?.changes.some(change => change.status === 'pending') ? 'awaitingReview' : 'completed'
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

  async function send(prompt = conversation.value.draft, retryContext?: DocumentSnapshot | null, retryReadContext?: DocumentSnapshot | null, retryReferences?: ReferenceSnapshot[], options: { readOnly?: boolean } = {}) {
    if (busy.value || history.historyLoading.value || skillsLoading.value || conversation.value.readingImages || conversation.value.readingReferences || conversation.value.projectAccess.busy || !prompt.trim() && !conversation.value.images.length) return
    error.value = ''
    contextNotice.value = ''
    synchronizeReviews()
    const chat = getConversation()
    const references = (retryReferences ?? chat.references).map(ref => ({ documentId: ref.documentId, snapshot: { ...ref.snapshot } }))
    const projectRoot = project.projectTree?.pathname ?? ''
    const grantId = chat.projectAccess.grantId
    const samePatterns = (left: string[], right: string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort())
    if (!options.readOnly && grantId && (chat.projectAccess.root !== projectRoot
      || !samePatterns(chat.projectAccess.include, chat.projectAccess.authorizedInclude)
      || !samePatterns(chat.projectAccess.exclude, chat.projectAccess.authorizedExclude))) {
      error.value = agentError('agent:projectScopeChanged'); return
    }
    const activeGrant = !options.readOnly && grantId && chat.projectAccess.root === projectRoot ? { ...chat.projectAccess, grantId } : null
    let projectSearch: { grantId: string; buffers: { path: string; markdown: string }[] } | undefined
    let webResearch: ReturnType<typeof validateWebResearch> | undefined
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
      if (activeGrant) projectSearch = { grantId: activeGrant.grantId,
        buffers: snapshotDirtyProjectBuffers(editor.tabs, activeGrant.root, pathIsInsideRoot) }
      if (!options.readOnly && chat.webResearch.enabled) webResearch = validateWebResearch(chat.webResearch)
    } catch (cause) { error.value = agentError(cause); return }
    const requestId = crypto.randomUUID()
    if (attached) attached = { ...attached, snapshotId: requestId }
    if (reading) reading = { ...reading, snapshotId: requestId }
    const messageId = crypto.randomUUID()
    const task = createAgentTaskContext({ taskId: requestId, paneId: editor.activePaneId, attached, reading, references,
      skills: taskSkills(skillIds), config: config.value, readOnly: options.readOnly })
    run.value = { id: requestId, key: currentKey.value, messageId, snapshot: attached, readSnapshot: reading, references,
      ...(projectSearch ? { projectRoot: activeGrant!.root, projectGrantId: projectSearch.grantId } : {}), ...(options.readOnly ? { readOnly: true } : {}) }
    chat.messages.push({ id: crypto.randomUUID(), role: 'user', content: prompt.trim(), tools: [], images: chat.images.map(image => ({ ...image })), contextSnapshot: attached, readSnapshot: reading, references, readOnlyRequest: options.readOnly,
      attachment: attached ? `${attached.name} · ${reading?.from !== attached.from || reading?.to !== attached.to ? t('agent.referenceDocument') : attached.from !== 0 || attached.to !== attached.markdown.length ? t('agent.selection') : t('agent.document')}` : t('agent.noAttachment') })
    chat.messages.push({ id: messageId, role: 'assistant', content: '', tools: [], task, contextReads: [], targetTabId: attached?.tabId ?? editor.currentFileId ?? undefined, answerTarget: currentAnswerTarget() })
    chat.draft = ''
    chat.images = []
    try {
      startPromise = (async () => {
        await ensureListener()
        if (disposed) { run.value = null; return }
        await agentTransport.start({ requestId, messages, language: getLocale(), skillIds, ...(options.readOnly ? { readOnly: true } : {}),
          ...(reviewChanges.length ? { reviewChanges } : {}),
          references: referenceRequest(references),
          ...(projectSearch ? { projectSearch } : {}),
          ...(!options.readOnly && chat.applyProjectWritingRules && projectRoot === projectConfigRoot.value ? { writingProjectRoot: projectRoot } : {}),
          ...(webResearch ? { webResearch } : {}),
          ...(attached && reading && (attached.from !== reading.from || attached.to !== reading.to) ? { editRange: { from: attached.from - reading.from, to: attached.to - reading.from } } : {}),
          context: reading ? { name: reading.name, markdown: reading.markdown.slice(reading.from, reading.to), snapshotId: requestId, offset: reading.from } : null })
      })()
      // Web permission is explicitly per request; retain editable fields but require an opt-in each send.
      if (webResearch) { chat.webResearch.enabled = false; chat.webResearch.publicDns = false }
      await startPromise
    } catch (cause) {
      receive({ requestId, kind: 'error', text: String(cause) })
    } finally { startPromise = null }
  }

  /** Each independent, read-only request has its own timeout and bounded context.
   * Completed jobs survive cancellation; only the currently failed job is retried. */
  async function summarizeChapters(resumeId?: string) {
    if (busy.value || history.historyLoading.value || conversation.value.readingImages) return
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
        message = { id: crypto.randomUUID(), role: 'assistant', content: '', tools: [], summary, targetTabId: attached.tabId, answerTarget: currentAnswerTarget(),
          task: createAgentTaskContext({ taskId: crypto.randomUUID(), paneId: editor.activePaneId, attached, reading: attached, references: [],
            skills: taskSkills(), config: config.value }), contextReads: [] }
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
        if (message.task && message.contextReads && message.contextReads.length < MAX_CONTEXT_READS_PER_TURN) {
          if (input.snapshot) {
            const excerpt = input.snapshot.markdown.slice(input.snapshot.from, input.snapshot.to)
            message.contextReads.push({ id: `${message.task.taskId}:summary:${index}`, tool: 'chapter_summary', kind: 'range',
              ...(message.task.documentId ? { documentId: message.task.documentId } : {}), documentName: input.snapshot.name,
              startLine: input.snapshot.markdown.slice(0, input.snapshot.from).split('\n').length,
              endLine: input.snapshot.markdown.slice(0, Math.max(input.snapshot.from, input.snapshot.to - 1)).split('\n').length,
              totalChars: excerpt.length, excerpt: excerpt.slice(0, MAX_CONTEXT_PREVIEW_CHARS), truncated: excerpt.length > MAX_CONTEXT_PREVIEW_CHARS })
          } else {
            const excerpt = input.prompt.match(/<notes>\n([\s\S]*?)\n<\/notes>/)?.[1] ?? input.prompt
            message.contextReads.push({ id: `${message.task.taskId}:summary:${index}`, tool: 'chapter_summary', kind: 'summary',
              documentName: t('agent.chapterSummary'), resultCount: summary.jobs[index]!.inputs.length,
              totalChars: excerpt.length, excerpt: excerpt.slice(0, MAX_CONTEXT_PREVIEW_CHARS), truncated: excerpt.length > MAX_CONTEXT_PREVIEW_CHARS })
          }
        }
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
        if (message.task) message.task.status = 'completed'
      }
    } catch (cause) {
      if (message?.summary) { message.summary.status = 'error'; message.error = agentError(cause); if (message.task) message.task.status = 'failed' }
      else error.value = agentError(cause)
    } finally {
      if (message?.task && message.summary?.status === 'cancelled') message.task.status = 'cancelled'
      summaryActive.value = null; run.value = null; stopping.value = false; summaryComplete = null; await history.flushHistory().catch(() => {})
    }
  }

  async function stop() {
    if (multiDocumentState.value.busy || multiDocumentState.value.actionBusy) { await multiDocument.cancel(); return }
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

  function receiveExternalProposal(snapshot: DocumentSnapshot, proposal: AgentProposal, proposalId: string): ReviewedEdit {
    const tab = editor.tabs.find(item => item.id === snapshot.tabId)
    if (!tab || editor.currentFileId !== tab.id || tab.markdown !== snapshot.markdown) throw new Error('agent:selectionChanged')
    const edit = reviewProposal(snapshot, proposal, proposalId)
    reviewStates.reconcile(edit, tab.markdown)
    const chat = getConversation(snapshot.tabId)
    chat.messages.push({ id: proposalId, externalProposalId: proposalId, role: 'assistant', content: '', tools: [], edit })
    visible.value = true
    return chat.messages[chat.messages.length - 1]!.edit!
  }

  function externalReview(proposalId: string): ReviewedEdit | undefined {
    for (const chat of Object.values(sessions.value)) {
      const item = chat.messages.find(message => message.id === proposalId)
      if (item?.edit) return item.edit
    }
    return undefined
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
      const requestedPaneId = editor.activePaneId
      const requestedTabId = editor.currentFileId
      let tab = editor.tabs.find(tab => tab.id === snapshot.tabId) ?? (snapshot.path ? editor.tabs.find(tab => pathsReferToSameFile(tab.pathname, snapshot.path!)) : undefined)
      if (tab && tab.markdown !== snapshot.markdown) throw new Error('agent:sourceChanged')
      if (!tab && snapshot.path) {
        const loaded = await readMarkdown(snapshot.path)
        if (editor.activePaneId !== requestedPaneId || editor.currentFileId !== requestedTabId) throw new Error('agent:conflict')
        if (loaded.hadDecodeErrors || loaded.markdown.replace(/\r\n?/g, '\n') !== snapshot.markdown) throw new Error('agent:sourceChanged')
        tab = await editor.openFile(snapshot.path)
        if (editor.activePaneId !== requestedPaneId || editor.currentFileId !== tab.id) throw new Error('agent:conflict')
        if (tab.markdown !== snapshot.markdown) throw new Error('agent:sourceChanged')
      }
      if (!tab) {
        tab = editor.newUntitledTab(snapshot.markdown)
        tab.filename = snapshot.name; tab.isSaved = false; tab.lastSavedMarkdown = ''; tab.pendingBaselineUpdate = false
      }
      editor.setCurrent(tab.id)
      await nextTick()
      if (editor.activePaneId !== requestedPaneId || editor.currentFileId !== tab.id) return
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
    if (busy.value || edit.locked || edit.rebasedTo) return
    const change = edit.changes[index]
    if (change) change.reason = reason.slice(0, 1000)
  }

  async function rewrite(edit: ReviewedEdit, index: number) {
    if (busy.value || edit.locked || edit.rebasedTo || edit.documentChanged || conversation.value.draft.trim() || conversation.value.images.length) return
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
    if (busy.value || edit.locked || edit.rebasedTo || edit.documentChanged) return
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
    if (busy.value || edit.locked || edit.rebasedTo) return
    for (const [i, change] of edit.changes.entries()) if (change.status === 'pending' && (index === undefined || index === i)) change.status = 'dismissed'
    updateEditStatus(edit)
  }

  function revert(edit: ReviewedEdit, index?: number) {
    if (busy.value || edit.locked || edit.rebasedTo || edit.documentChanged || edit.appliedMarkdown === undefined) return
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

  function originalReviewRequest(edit: ReviewedEdit) {
    const messages = conversation.value.messages
    const index = messages.findIndex(message => message.edit === edit)
    if (index < 0) return undefined
    const message = messages[index]!
    if (message.externalProposalId) return undefined
    const relinked = relinkedReviewRequests.get(toRaw(edit))
    if (relinked?.tabId === edit.snapshot.tabId && messages.includes(relinked.request) && relinked.request.role === 'user') return relinked.request
    const user = message.regenerateFrom ? messages.find(item => item.id === message.regenerateFrom) : messages[index - 1]
    return user?.role === 'user' && user.contextSnapshot?.tabId === edit.snapshot.tabId ? user : undefined
  }

  function canRegenerateReview(edit: ReviewedEdit) {
    return !busy.value && !history.historyLoading.value && !edit.locked && !edit.rebasedTo && includeDocument.value && editor.currentFileId === edit.snapshot.tabId
      && (edit.changes.some(change => change.status === 'pending') || !!edit.rebaseConflicts?.length)
      && !conversation.value.draft.trim() && !conversation.value.images.length && !!originalReviewRequest(edit)
  }

  function currentReviewScope(edit: ReviewedEdit, allowReselection = false): DocumentSnapshot | null {
    const tab = editor.currentFile
    if (!includeDocument.value || !tab || tab.id !== edit.snapshot.tabId) return null
    const refreshed = refreshedReviewSnapshot(edit, tab.markdown)
    const attached = selection.value
    if (!refreshed) {
      // A new selection is explicit authorization; never infer a whole-document fallback.
      return allowReselection && attached?.tabId === tab.id && attached.markdown === tab.markdown
        && isDocumentBoundary(tab.markdown, attached.from) && isDocumentBoundary(tab.markdown, attached.to) && attached.from < attached.to
        ? { ...referenceSnapshot(tab), from: attached.from, to: attached.to, snapshotId: crypto.randomUUID() } : null
    }
    if (!attached) return refreshed
    if (attached.tabId !== tab.id) return null
    if (attached.markdown !== tab.markdown) {
      // Only the original captured selection can be safely carried forward.
      return attached.markdown === edit.snapshot.markdown && attached.from === edit.snapshot.from && attached.to === edit.snapshot.to ? refreshed : null
    }
    if (attached.from < refreshed.from || attached.to > refreshed.to) return null
    return { ...refreshed, from: attached.from, to: attached.to }
  }

  async function regenerateReview(edit: ReviewedEdit) {
    if (!canRegenerateReview(edit)) return
    const user = originalReviewRequest(edit)!
    if (user.imagesOmitted) { error.value = t('agent.errors.historyImages'); return }
    const attached = currentReviewScope(edit, true)
    if (!attached) { error.value = t('agent.errors.reviewSelectionChanged'); return }
    const reading = referenceDocument.value ? { ...attached, from: 0, to: attached.markdown.length } : attached
    await send(t('agent.regeneratePrompt', { prompt: user.content }), attached, reading, conversation.value.references)
  }

  function rebaseReview(edit: ReviewedEdit) {
    if (busy.value || edit.locked || edit.rebasedTo || !edit.documentChanged || editor.currentFileId !== edit.snapshot.tabId) return
    const tab = editor.currentFile
    if (!tab) return
    const result = rebasePendingReview(edit, tab.markdown)
    edit.rebaseConflicts = result.conflicts
    if (!result.edit) { error.value = t('agent.rebaseConflict', { count: result.conflicts.length }); return }
    const scope = currentReviewScope(edit)
    if (!scope || result.edit.changes.some(change => change.from < scope.from || change.to > scope.to)) {
      error.value = t('agent.errors.reviewSelectionChanged'); return
    }
    const id = crypto.randomUUID()
    const user = originalReviewRequest(edit)
    const relinked = relinkedReviewRequests.get(toRaw(edit))
    if (relinked) relinkedReviewRequests.set(toRaw(result.edit), relinked)
    conversation.value.messages.push({ id, role: 'assistant', content: '', tools: [], completed: true, edit: result.edit,
      ...(user ? { regenerateFrom: user.id } : {}) })
    edit.rebasedTo = id
    reviewStates.reconcile(result.edit, tab.markdown)
    error.value = result.conflicts.length ? t('agent.rebaseConflict', { count: result.conflicts.length }) : ''
  }

  function retry() {
    if (busy.value || history.historyLoading.value) return
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
    void send(user.content, user.contextSnapshot, user.readSnapshot, user.references ?? [], { readOnly: user.readOnlyRequest === true || last.task?.readOnly === true })
  }

  onScopeDispose(() => {
    multiDocument.dispose()
    history.disposeHistory()
    disposed = true
    void stop()
    unlisten?.()
  })

  return { ...history, addReferenceTab, chooseReferences, flushForClose, visible, settingsOpen, skillsOpen, skills, skillsLoading, skillsError, loadSkills, changeSkills, config, loadingConfig, configError, error, includeDocument, referenceDocument, selection, conversation,
    busy, multiDocument, multiDocumentState, runningHere, runningKey, stopping, run, toggle, loadConfig, saveConfig, attachSelection, clearSelection, addImages, send, summarizeChapters, stop, clear, apply, dismiss, revert, retry,
    captureAnswerTarget, canUseAnswer, useAnswer, locateSource, setReviewReason, rewrite, canRegenerateReview, regenerateReview, rebaseReview, receiveExternalProposal, externalReview, queueWritingCommand, contextNotice,
    projectConfig, projectConfigRoot, projectConfigLoading, projectConfigSaving, projectConfigError, projectConfigSaved, loadProjectConfig, saveProjectConfig,
    documentCheck, documentCheckBusy, documentCheckError, checkCurrentDocument, locateDocumentIssue, requestModelCheck, requestDocumentRepair,
    setProjectSearchEnabled, suggestWebQueries, approveWebQuery, openWebSource }
})
