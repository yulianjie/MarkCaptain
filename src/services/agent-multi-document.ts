import { nextTick, reactive, watch } from 'vue'
import type { useEditorStore } from '@/stores/editor'
import type { DocumentState } from '@/stores/help'
import { reviewProposal, reviewedMarkdown, reviewSource, type AgentEvent, type AgentTaskContext, type ReviewedEdit } from './agent'
import { parseAgentContextRead } from './agent-context'
import type { AgentMultiState, AgentMultiTarget } from './agent-multi-types'
import { agentTransport } from './agent-transport'
import { agentDocumentVersions } from './tauri-invoke'
import { createReviewStateTracker } from './agent-review-state'

export interface AgentMultiDocumentDependencies {
  editor: ReturnType<typeof useEditorStore>
  isOtherBusy: () => boolean
  hasConfig: () => boolean
  language: () => string
  onChange?: (state: AgentMultiState) => void
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const normalized = (text: string) => text.replace(/\r\n?/g, '\n')
async function contentHash(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized(text)))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
const applied = (edit: ReviewedEdit) => edit.changes.flatMap((change, index) => change.status === 'applied' ? [index] : [])

/** Session-only, explicit editable scope. Neither selection nor acceptance grants filesystem writes. */
export function createAgentMultiDocumentController(dependencies: AgentMultiDocumentDependencies) {
  const { editor } = dependencies
  const state = reactive<AgentMultiState>({ stage: 'idle', requestId: null, prompt: '', answer: '', error: '', targets: [], reads: [], sources: [], busy: false, actionBusy: false })
  const identities = new Map<string, DocumentState>()
  const encodingsByDocument = new Map<string, string>()
  const revisions = new Map<string, number>()
  const preparationSaves = new Map<string, number>()
  const reviewStates = createReviewStateTracker()
  let generation = 0
  let disposed = false
  let changing = false
  let unlisten: (() => void) | undefined
  let paneRevision = 0
  const publish = () => dependencies.onChange?.(state)
  const stopListening = () => { unlisten?.(); unlisten = undefined }
  const currentTask = (token: number) => !disposed && generation === token
  const conflict = (target: AgentMultiTarget, error = 'agent:conflict') => {
    target.status = 'conflict'; target.error = error
    if (target.proposal) target.proposal.documentChanged = true
  }
  function updateStatus(target: AgentMultiTarget) {
    if (!target.proposal || target.status === 'conflict') return
    const statuses = new Set(target.proposal.changes.map(change => change.status))
    target.proposal.status = statuses.size === 1 ? target.proposal.changes[0]!.status : 'partial'
    target.status = target.proposal.status
  }
  function tabFor(target: AgentMultiTarget, expected?: string) {
    const tab = editor.tabs.find(item => item.id === target.tabId)
    if (!tab || identities.get(target.documentId) !== tab || tab.pathname !== (target.path ?? '')
      || tab.encoding.encoding !== encodingsByDocument.get(target.documentId)
      || tab.externalChange || editor.fileMutationBusy || target.status === 'conflict'
      || (expected !== undefined && tab.markdown !== expected)) throw new Error('agent:conflict')
    return tab
  }
  // Observe actual editor transactions, including native source/Muya undo and redo.
  const stopWatch = watch(() => editor.tabs.map(tab => [tab, tab.id, tab.pathname, tab.markdown, tab.externalChange, tab.lastSavedMarkdown, tab.encoding.encoding]), (rows, previous) => {
    for (const target of state.targets) {
      const before = previous.find(row => row[1] === target.tabId), after = rows.find(row => row[1] === target.tabId)
      if (before && after && before.every((value, index) => value === after[index])) continue
      revisions.set(target.documentId, (revisions.get(target.documentId) ?? 0) + 1)
      if (changing || target.status === 'conflict') continue
      try {
        const tab = tabFor(target)
        if (target.proposal) {
          reviewStates.reconcile(target.proposal, tab.markdown)
          if (target.proposal.documentChanged) conflict(target)
          else updateStatus(target)
        } else if (tab.markdown !== target.snapshot.markdown) conflict(target)
      } catch { conflict(target) }
    }
    publish()
  }, { flush: 'sync' })
  const stopPaneWatch = watch(() => [editor.activePaneId, editor.currentFileId, editor.sourceCodeMode, ...editor.panes.map(pane => `${pane.id}:${pane.documentId}:${pane.sourceMode}`)], () => { paneRevision++ }, { flush: 'sync' })

  function guardTargets(token: number, stamps: Map<string, number>, pane: number) {
    if (!currentTask(token) || pane !== paneRevision || dependencies.isOtherBusy()) throw new Error('agent:conflict')
    for (const target of state.targets) {
      try {
        tabFor(target, target.snapshot.markdown)
        if (stamps.get(target.documentId) !== revisions.get(target.documentId)) throw new Error('agent:conflict')
        const save = editor.getAgentSaveState(target.tabId)
        if (save.pending || save.revision !== preparationSaves.get(target.documentId)) throw new Error('agent:conflict')
      } catch (error) { conflict(target); throw error }
    }
  }
  function handleEvent(event: AgentEvent, token: number) {
    if (!currentTask(token) || event.requestId !== state.requestId || !state.busy || state.stage !== 'running') return
    try {
      if (event.kind === 'delta') state.answer += (event.text ?? '').slice(0, Math.max(0, 1_000_000 - state.answer.length))
      if (event.kind === 'proposal' && event.proposal) {
        const target = state.targets.find(item => item.documentId === event.proposal!.documentId)
        if (!target || target.proposal) throw new Error('agent:invalidEdit')
        const proposal = reviewProposal(target.snapshot, event.proposal, `${state.requestId}:${target.documentId}`)
        proposal.documentId = target.documentId
        target.proposal = proposal
        reviewStates.remember(target.proposal)
        if (target.status !== 'conflict') {
          reviewStates.reconcile(proposal, tabFor(target).markdown)
          if (proposal.documentChanged) conflict(target)
          else updateStatus(target)
        }
      }
      if (event.kind === 'context' && event.text && state.reads.length < 256) {
        const value = JSON.parse(event.text)
        const target = state.targets.find(item => item.documentId === value.documentId)
        if (target) {
          const task = { sources: [{ documentId: target.documentId, name: target.name, kind: 'reference' }] } as AgentTaskContext
          const read = parseAgentContextRead(value, task, `${state.requestId}:${state.reads.length}`)
          if (read) state.reads.push(read)
        }
      }
      if (event.kind === 'source' && event.text && state.sources.length < 32) {
        const value = JSON.parse(event.text)
        const target = state.targets.find(item => item.documentId === value.documentId)
        if (!target) throw new Error('agent:invalidSource')
        state.sources.push(reviewSource(target.snapshot, value))
      }
      if (event.kind === 'done' || event.kind === 'cancelled' || event.kind === 'error') {
        state.busy = false
        state.stage = event.kind === 'done' ? 'review' : event.kind === 'cancelled' ? 'cancelled' : 'failed'
        if (event.kind === 'error') state.error = event.text ?? 'agent:failed'
        stopListening()
      }
    } catch (error) { state.error = message(error) }
    publish()
  }

  async function prepareAndSend(tabIds: string[], prompt: string): Promise<void> {
    if (disposed || state.busy || state.actionBusy || dependencies.isOtherBusy()) { state.error = 'agent:busy'; publish(); return }
    if (!dependencies.hasConfig()) { state.error = 'agent:notConfigured'; publish(); return }
    if (!prompt.trim() || tabIds.length < 1 || tabIds.length > 8 || new Set(tabIds).size !== tabIds.length
      || tabIds.some(id => !editor.tabs.some(tab => tab.id === id))) { state.error = 'agent:multiSelection'; publish(); return }
    const selected = tabIds.map(id => editor.tabs.find(tab => tab.id === id)!)
    const sizes = selected.map(tab => new TextEncoder().encode(tab.markdown).length)
    if (sizes.some(size => size > 2_000_000) || sizes.reduce((a, b) => a + b, 0) > 4_000_000) { state.error = 'agent:multiLimit'; publish(); return }
    const token = ++generation
    stopListening(); identities.clear(); encodingsByDocument.clear(); revisions.clear(); preparationSaves.clear()
    const requestId = crypto.randomUUID()
    state.requestId = requestId; state.prompt = prompt.trim(); state.answer = ''; state.error = ''; state.reads = []; state.sources = []
    state.stage = 'preparing'; state.busy = true
    state.targets = selected.map(tab => {
      const documentId = `edit-${crypto.randomUUID()}`
      identities.set(documentId, tab); revisions.set(documentId, 0)
      encodingsByDocument.set(documentId, tab.encoding.encoding)
      preparationSaves.set(documentId, editor.getAgentSaveState(tab.id).revision)
      const snapshot = Object.freeze({ tabId: tab.id, name: tab.filename, markdown: tab.markdown, from: 0, to: tab.markdown.length,
        ...(tab.pathname ? { path: tab.pathname } : {}), snapshotId: `${requestId}:${documentId}` })
      return { documentId, tabId: tab.id, name: tab.filename, ...(tab.pathname ? { path: tab.pathname } : {}), snapshot,
        diskFingerprint: null, diskContentHash: null, proposal: null, status: 'waiting' as const, error: '' }
    })
    const stamps = new Map(revisions), pane = paneRevision
    publish()
    try {
      await editor.pauseAgentAutoSave([...tabIds])
      guardTargets(token, stamps, pane)
      const paths = state.targets.flatMap(target => target.path ? [target.path] : [])
      const encodings = Object.fromEntries(state.targets.flatMap(target => target.path ? [[target.path, tabFor(target).encoding.encoding]] : []))
      const versions = paths.length ? await agentDocumentVersions(paths, encodings) : []
      guardTargets(token, stamps, pane)
      if (versions.length !== paths.length) throw new Error('agent:conflict')
      let index = 0
      for (const target of state.targets) {
        if (!target.path) continue
        const version = versions[index++]!
        const savedHash = await contentHash(tabFor(target).lastSavedMarkdown)
        guardTargets(token, stamps, pane)
        if (version.error || !version.fingerprint || version.contentHash !== savedHash) { conflict(target); throw new Error('agent:conflict') }
        target.diskFingerprint = version.fingerprint; target.diskContentHash = version.contentHash
      }
      const release = await agentTransport.listen(event => handleEvent(event, token))
      if (!currentTask(token)) { release(); return }
      unlisten = release
      guardTargets(token, stamps, pane)
      if (dependencies.isOtherBusy()) throw new Error('agent:busy')
      state.stage = 'running'; publish()
      await agentTransport.start({ requestId, messages: [{ role: 'user', content: state.prompt }], context: null, language: dependencies.language(),
        editableDocuments: state.targets.map(target => ({ documentId: target.documentId, name: target.name, markdown: target.snapshot.markdown, snapshotId: target.snapshot.snapshotId, offset: 0 })) })
      if (!currentTask(token)) { void agentTransport.cancel(requestId).catch(() => {}); return }
      // Changes during startup cannot retarget this request; its immutable inputs remain reviewable only as conflicts.
      guardTargets(token, stamps, pane)
    } catch (error) {
      if (!currentTask(token)) return
      const wasRunning = state.stage === 'running'
      state.error = message(error); state.stage = 'failed'; state.busy = false; stopListening()
      if (wasRunning) void agentTransport.cancel(requestId).catch(() => {})
    }
    publish()
  }

  async function cancel() {
    if (!state.busy && !state.actionBusy) return
    const requestId = state.busy ? state.requestId : null
    ++generation; stopListening(); state.busy = false; state.stage = 'cancelled'; publish()
    if (requestId) { try { await agentTransport.cancel(requestId) } catch { /* Local cancellation already prevents late events. */ } }
  }

  async function mutate(documentId: string, reverting: boolean, changeIndex?: number): Promise<boolean> {
    if (disposed || state.busy || state.actionBusy || dependencies.isOtherBusy()) return false
    const target = state.targets.find(item => item.documentId === documentId)
    const edit = target?.proposal
    if (!target || !edit || target.status === 'conflict' || edit.documentChanged) return false
    const indices = edit.changes.flatMap((change, index) => change.status === (reverting ? 'applied' : 'pending') && (changeIndex === undefined || changeIndex === index) ? [index] : [])
    if (!indices.length) return false
    const expected = edit.appliedMarkdown ?? edit.snapshot.markdown
    const token = generation, revision = revisions.get(documentId)
    const saveRevision = editor.getAgentSaveState(target.tabId).revision
    state.actionBusy = true; publish()
    let pane = paneRevision
    const guard = (allowPendingSave = false) => {
      if (!currentTask(token) || dependencies.isOtherBusy() || state.targets.find(item => item.documentId === documentId) !== target
        || revision !== revisions.get(documentId) || pane !== paneRevision) throw new Error('agent:conflict')
      const save = editor.getAgentSaveState(target.tabId)
      if (save.revision !== saveRevision || (!allowPendingSave && save.pending)) throw new Error('agent:conflict')
      return tabFor(target, expected)
    }
    try {
      guard(true)
      await editor.pauseAgentAutoSave([target.tabId])
      guard()
      editor.setCurrent(target.tabId)
      pane = paneRevision
      const paneId = editor.activePaneId, sourceMode = editor.sourceCodeMode
      await nextTick()
      guard()
      if (target.path) {
        const versions = await agentDocumentVersions([target.path], { [target.path]: tabFor(target).encoding.encoding })
        guard()
        if (versions.length !== 1 || versions[0]!.error || !target.diskFingerprint || versions[0]!.fingerprint !== target.diskFingerprint) throw new Error('agent:conflict')
      }
      const tab = guard()
      if (editor.currentFileId !== target.tabId || editor.activePaneId !== paneId || editor.sourceCodeMode !== sourceMode) throw new Error('agent:conflict')
      // A manual save may have lifted the pause; restore it before the buffer transaction.
      tab.autoSaveBlocked = true
      const accepted = reverting ? applied(edit).filter(index => !indices.includes(index)) : [...applied(edit), ...indices]
      reviewStates.remember(edit, expected)
      changing = true
      try { edit.appliedMarkdown = editor.applyAgentEdit(target.tabId, expected, reviewedMarkdown(edit, accepted)) }
      finally { changing = false }
      for (const index of indices) edit.changes[index]!.status = reverting ? 'reverted' : 'applied'
      reviewStates.remember(edit, edit.appliedMarkdown, !sourceMode); updateStatus(target); target.error = ''; state.error = ''
      return true
    } catch (error) {
      if (currentTask(token)) { conflict(target, message(error)); state.error = message(error) }
      return false
    } finally { state.actionBusy = false; publish() }
  }
  function dismiss(documentId: string, changeIndex?: number) {
    if (disposed || state.busy || state.actionBusy || dependencies.isOtherBusy()) return
    const target = state.targets.find(item => item.documentId === documentId)
    if (!target?.proposal) return
    for (const [index, change] of target.proposal.changes.entries()) if (change.status === 'pending' && (changeIndex === undefined || changeIndex === index)) change.status = 'dismissed'
    updateStatus(target); publish()
  }
  async function locate(documentId: string): Promise<boolean> {
    const target = state.targets.find(item => item.documentId === documentId)
    if (!target || disposed || state.busy || state.actionBusy) return false
    const token = generation
    try {
      const tab = tabFor(target)
      const markdown = tab.markdown
      editor.setCurrent(target.tabId)
      const pane = paneRevision, revision = revisions.get(documentId)
      await nextTick()
      if (!currentTask(token) || pane !== paneRevision || revision !== revisions.get(documentId)) return false
      return tabFor(target, markdown) === tab && editor.currentFileId === target.tabId
    } catch { return false }
  }
  function dispose() {
    const requestId = state.busy ? state.requestId : null
    disposed = true; ++generation; stopListening(); stopWatch(); stopPaneWatch(); state.busy = false
    if (requestId) void agentTransport.cancel(requestId).catch(() => {})
  }
  return { state, prepareAndSend, cancel, apply: (documentId: string, index?: number) => mutate(documentId, false, index),
    dismiss, revert: (documentId: string, index?: number) => mutate(documentId, true, index), locate, dispose }
}
