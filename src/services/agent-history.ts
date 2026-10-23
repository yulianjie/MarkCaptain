import type { ChatItem } from '@/stores/agent'
import { createChapterSummary, finishSummaryJob } from './agent-summary'
import { reviewProposal, type AgentWebSource, type DocumentSnapshot, type ReferenceSnapshot } from './agent'
import { validateReferences } from './agent-references'
import { restoreAgentContextReads, restoreAgentTaskContext } from './agent-context'
import { validatePublicUrl } from './agent-m2'

export interface HistoryMetadata { id: string; revision: number; title: string; createdAt: number; updatedAt: number }
export interface HistoryRecord extends HistoryMetadata { schemaVersion: 1; data: { snapshots: DocumentSnapshot[]; chat: unknown; document: unknown } }
export interface HistoryChat { messages: ChatItem[]; references: ReferenceSnapshot[]; draft: string; includeDocument: boolean; referenceDocument: boolean; selection: DocumentSnapshot | null; skillId: string }
const invalid = () => new Error('agent:historyInvalid')
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const bytes = (s: string) => new TextEncoder().encode(s).length
const HISTORY_MESSAGE_REFERENCE_LIMIT = 40 // Eight manual references plus up to 32 project reads.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PROJECT_REFERENCE_ID = /^project-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface HistoryWebSource {
  sourceId: string
  title: string
  url: string
  fetchedAt: string
  publishedAt?: string
  status: AgentWebSource['status']
}

function validSnapshot(v: unknown): v is DocumentSnapshot {
  if (!object(v)) return false
  return typeof v.tabId === 'string' && v.tabId.length <= 128 && typeof v.name === 'string' && bytes(v.name) <= 1024
    && typeof v.markdown === 'string' && bytes(v.markdown) <= 2_000_000
    && Number.isInteger(v.from) && Number.isInteger(v.to) && (v.from as number) >= 0 && (v.to as number) >= (v.from as number)
    && (v.to as number) <= v.markdown.length && (v.path === undefined || typeof v.path === 'string' && v.path.length <= 8192)
    && (v.snapshotId === undefined || typeof v.snapshotId === 'string' && v.snapshotId.length > 0 && v.snapshotId.length <= 160)
}

/** Message references are historical read receipts; they do not grant active access. */
function historyMessageReferences(value: unknown): ReferenceSnapshot[] {
  if (!Array.isArray(value) || value.length > HISTORY_MESSAGE_REFERENCE_LIMIT) throw invalid()
  const ids = new Set<string>()
  for (const candidate of value) {
    if (!object(candidate) || typeof candidate.documentId !== 'string' || !validSnapshot(candidate.snapshot)
      || ids.has(candidate.documentId)) throw invalid()
    const isManual = UUID.test(candidate.documentId)
    const isProject = PROJECT_REFERENCE_ID.test(candidate.documentId)
    if (!isManual && !isProject) throw invalid()
    if (isProject && (candidate.snapshot.tabId !== `project-${candidate.documentId}`
      || candidate.snapshot.from !== 0 || candidate.snapshot.to !== candidate.snapshot.markdown.length)) throw invalid()
    ids.add(candidate.documentId)
  }
  return value as ReferenceSnapshot[]
}

export function isArchivedProjectSnapshot(snapshot: DocumentSnapshot): boolean {
  const documentId = snapshot.tabId.startsWith('project-') ? snapshot.tabId.slice('project-'.length) : ''
  return PROJECT_REFERENCE_ID.test(documentId)
}

function restoredProjectSnapshot(snapshot: DocumentSnapshot): DocumentSnapshot {
  return isArchivedProjectSnapshot(snapshot) ? { ...snapshot, path: undefined } : snapshot
}

function restoredMessageReferences(value: unknown): ReferenceSnapshot[] {
  return historyMessageReferences(value).map(reference => PROJECT_REFERENCE_ID.test(reference.documentId)
    ? { ...reference, snapshot: restoredProjectSnapshot(reference.snapshot) }
    : reference)
}

/** Persist only safe source-card metadata; web excerpts are transient research content. */
function historyWebSources(value: unknown): HistoryWebSource[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const safe: HistoryWebSource[] = []
  for (const raw of value.slice(0, 40)) {
    if (!object(raw) || typeof raw.sourceId !== 'string' || !raw.sourceId || raw.sourceId.length > 128 || seen.has(raw.sourceId)
      || typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 300
      || typeof raw.url !== 'string' || !validatePublicUrl(raw.url)
      || typeof raw.fetchedAt !== 'string' || raw.fetchedAt.length > 64 || Number.isNaN(Date.parse(raw.fetchedAt))
      || !['snippet', 'read', 'failed'].includes(String(raw.status))) continue
    if (raw.publishedAt !== undefined && raw.publishedAt !== null && (typeof raw.publishedAt !== 'string' || raw.publishedAt.length > 128)) continue
    seen.add(raw.sourceId)
    safe.push({ sourceId: raw.sourceId, title: raw.title, url: validatePublicUrl(raw.url)!, fetchedAt: raw.fetchedAt,
      ...(typeof raw.publishedAt === 'string' ? { publishedAt: raw.publishedAt } : {}), status: raw.status as AgentWebSource['status'] })
  }
  return safe
}

/** Intern immutable snapshots so long documents are stored once per range, not per message. */
export function packHistory(metadata: HistoryMetadata, chat: HistoryChat, document: DocumentSnapshot | null): HistoryRecord {
  validateReferences(chat.references)
  const snapshots: DocumentSnapshot[] = [], keys = new Map<string, number>()
  function pack(value: unknown, depth = 0): unknown {
    if (depth > 25) throw invalid()
    if (validSnapshot(value)) {
      const { snapshotId, ...content } = value
      const complete = { ...content, from: 0, to: value.markdown.length }
      const key = JSON.stringify(complete)
      let id = keys.get(key)
      if (id === undefined) { id = snapshots.length; keys.set(key, id); snapshots.push(complete) }
      return { $snapshot: id, from: value.from, to: value.to, ...(snapshotId !== undefined ? { snapshotId } : {}) }
    }
    if (Array.isArray(value)) return value.map(item => pack(item, depth + 1))
    if (object(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'images' && key !== 'readingImages').map(([key, val]) => [key, pack(val, depth + 1)]))
    return value
  }
  const messages = chat.messages.map(message => {
    if (message.references !== undefined) historyMessageReferences(message.references)
    const persisted = Object.fromEntries(Object.entries(message).filter(([key]) =>
      !['projectSearchResults', 'projectSearchComplete', 'projectCandidates', 'projectCompleteness'].includes(key)))
    const webSources = historyWebSources(message.webSources)
    if (webSources.length) persisted.webSources = webSources
    else delete persisted.webSources
    persisted.imagesOmitted = message.imagesOmitted || !!message.images?.length
    return persisted
  })
  const data = { chat: pack({ ...chat, messages }), document: pack(document), snapshots }
  const record: HistoryRecord = { ...metadata, schemaVersion: 1, data }
  if (snapshots.length > 512 || bytes(JSON.stringify(record)) > 16_000_000) throw new Error('agent:historyLimit')
  return record
}

export function hydrateHistory(record: HistoryRecord): { chat: HistoryChat; document: DocumentSnapshot | null } {
  if (record.schemaVersion !== 1 || !/^[0-9a-f-]{36}$/i.test(record.id) || bytes(JSON.stringify(record)) > 16_000_000
    || !Array.isArray(record.data?.snapshots) || record.data.snapshots.length > 512 || !record.data.snapshots.every(validSnapshot)) throw invalid()
  let nodes = 0
  function unpack(value: unknown, depth = 0): unknown {
    if (++nodes > 100_000 || depth > 25) throw invalid()
    if (object(value) && '$snapshot' in value) {
      if (!Number.isInteger(value.$snapshot)) throw invalid()
      const snapshot = record.data.snapshots[value.$snapshot as number]
      if (!snapshot) throw invalid()
      const ranged = { ...snapshot, from: value.from, to: value.to, ...(value.snapshotId !== undefined ? { snapshotId: value.snapshotId } : {}) }
      if (!validSnapshot(ranged)) throw invalid()
      return ranged
    }
    if (Array.isArray(value)) return value.map(item => unpack(item, depth + 1))
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, unpack(val, depth + 1)]))
    return value
  }
  const raw = unpack(record.data.chat)
  const document = unpack(record.data.document)
  if (!object(raw) || !Array.isArray(raw.messages) || raw.messages.length > 400 || !Array.isArray(raw.references)
    || typeof raw.draft !== 'string' || bytes(raw.draft) > 80_000 || typeof raw.includeDocument !== 'boolean'
    || typeof raw.referenceDocument !== 'boolean' || typeof raw.skillId !== 'string' || raw.skillId.length > 80
    || document !== null && !validSnapshot(document) || raw.selection !== null && !validSnapshot(raw.selection)) throw invalid()
  const refs = (value: unknown): ReferenceSnapshot[] => {
    if (!Array.isArray(value) || value.some(ref => !object(ref) || typeof ref.documentId !== 'string' || !validSnapshot(ref.snapshot))) throw invalid()
    validateReferences(value); return value
  }
  const messages: ChatItem[] = raw.messages.map((value): ChatItem => {
    if (!object(value) || !['user', 'assistant'].includes(String(value.role)) || typeof value.id !== 'string'
      || typeof value.content !== 'string' || bytes(value.content) > 2_000_000 || !Array.isArray(value.tools)
      || value.tools.length > 3000 || value.tools.some(tool => typeof tool !== 'string')) throw invalid()
    const message: ChatItem = { id: value.id, role: value.role as ChatItem['role'], content: value.content, tools: value.tools as string[],
      completed: value.completed === true, cancelled: value.cancelled === true, imagesOmitted: value.imagesOmitted === true,
      ...(typeof value.error === 'string' ? { error: value.error } : {}), ...(typeof value.attachment === 'string' ? { attachment: value.attachment } : {}) }
    const task = restoreAgentTaskContext(value.task)
    if (task) { message.task = task; message.contextReads = restoreAgentContextReads(value.contextReads, task) }
    for (const key of ['contextSnapshot', 'readSnapshot', 'answerTarget'] as const) {
      if (value[key] !== undefined && value[key] !== null && !validSnapshot(value[key])) throw invalid()
      message[key] = value[key] as DocumentSnapshot | null | undefined
    }
    if (typeof value.targetTabId === 'string') message.targetTabId = value.targetTabId
    if (value.regenerateFrom !== undefined) {
      if (typeof value.regenerateFrom !== 'string' || !value.regenerateFrom || value.regenerateFrom.length > 160) throw invalid()
      message.regenerateFrom = value.regenerateFrom
    }
    if (value.references !== undefined) message.references = restoredMessageReferences(value.references)
    if (value.webSources !== undefined) {
      const sources = historyWebSources(value.webSources)
      if (sources.length) message.webSources = sources.map(source => ({ ...source, excerpt: '' })) as AgentWebSource[]
    }
    if (value.sources !== undefined) {
      if (!Array.isArray(value.sources) || value.sources.length > 32 || value.sources.some(source => !object(source) || !validSnapshot(source.snapshot)
        || typeof source.label !== 'string' || Array.from(source.label).length > 200 || typeof source.quote !== 'string'
        || source.quote !== source.snapshot.markdown.slice(source.snapshot.from, source.snapshot.to))) throw invalid()
      message.sources = value.sources.map(source => ({ ...source, snapshot: restoredProjectSnapshot(source.snapshot),
        startLine: source.snapshot.markdown.slice(0, source.snapshot.from).split('\n').length,
        endLine: source.snapshot.markdown.slice(0, source.snapshot.to).split('\n').length })) as ChatItem['sources']
    }
    if (object(value.edit)) {
      const edit = value.edit
      if (!validSnapshot(edit.snapshot) || typeof edit.title !== 'string' || !Array.isArray(edit.changes)) throw invalid()
      const reviewed = reviewProposal(edit.snapshot, { title: edit.title, changes: edit.changes as never }, message.id)
      const ids = new Set<string>()
      for (const [index, change] of reviewed.changes.entries()) {
        const previous = edit.changes[index]
        if (!object(previous) || !['pending', 'applied', 'dismissed', 'reverted'].includes(String(previous.status))) throw invalid()
        change.status = previous.status as typeof change.status
        if (previous.id !== undefined) {
          if (typeof previous.id !== 'string' || !previous.id || previous.id.length > 160 || ids.has(previous.id)) throw invalid()
          change.id = previous.id
        }
        ids.add(change.id)
        if (previous.sourceChangeIds !== undefined) {
          if (!Array.isArray(previous.sourceChangeIds) || previous.sourceChangeIds.length > 64
            || previous.sourceChangeIds.some(id => typeof id !== 'string' || !id || id.length > 160)
            || new Set(previous.sourceChangeIds).size !== previous.sourceChangeIds.length) throw invalid()
          change.sourceChangeIds = previous.sourceChangeIds as string[]
        }
        if (previous.reason !== undefined) {
          if (typeof previous.reason !== 'string' || previous.reason.length > 1000) throw invalid()
          change.reason = previous.reason
        }
      }
      const states = new Set(reviewed.changes.map(change => change.status))
      reviewed.status = states.size === 1 ? reviewed.changes[0]!.status : 'partial'
      for (const key of ['rebasedFrom', 'rebasedTo'] as const) if (edit[key] !== undefined) {
        if (typeof edit[key] !== 'string' || !edit[key] || edit[key].length > 160) throw invalid()
        reviewed[key] = edit[key]
      }
      if (edit.rebaseConflicts !== undefined) {
        if (!Array.isArray(edit.rebaseConflicts) || edit.rebaseConflicts.length > 32
          || edit.rebaseConflicts.some(id => typeof id !== 'string' || !id || id.length > 160)) throw invalid()
        reviewed.rebaseConflicts = edit.rebaseConflicts as string[]
      }
      reviewed.locked = true // Archived review is readable, never revives stale Apply/Undo actions.
      message.edit = reviewed
    }
    if (object(value.summary)) {
      const old = value.summary
      if (!validSnapshot(old.snapshot) || !Array.isArray(old.jobs) || old.jobs.length > 250) throw invalid()
      const summary = createChapterSummary(old.snapshot)
      if (summary.jobs.length !== old.jobs.length || summary.chunkCount !== old.chunkCount) throw invalid()
      for (const [index, job] of summary.jobs.entries()) {
        const previous = old.jobs[index]
        if (!object(previous) || JSON.stringify(previous.inputs) !== JSON.stringify(job.inputs) || JSON.stringify(previous.chunk) !== JSON.stringify(job.chunk)) throw invalid()
        if (previous.result !== undefined) {
          if (typeof previous.result !== 'string' || job.inputs.some(input => summary.jobs[input]!.result === undefined)) throw invalid()
          finishSummaryJob(summary, index, previous.result)
        }
      }
      summary.activeJob = Math.max(0, summary.jobs.findIndex(job => job.result === undefined))
      summary.status = summary.jobs.every(job => job.result !== undefined) ? 'done' : 'cancelled'
      message.summary = summary
      message.completed = summary.status === 'done'; message.cancelled = summary.status !== 'done'
    }
    return message
  })
  return { document: document as DocumentSnapshot | null, chat: { messages, references: refs(raw.references), draft: raw.draft,
    includeDocument: raw.includeDocument, referenceDocument: raw.referenceDocument, skillId: raw.skillId, selection: raw.selection as DocumentSnapshot | null } }
}

export function exportHistory(record: HistoryRecord): string {
  const { chat } = hydrateHistory(record)
  return `# ${record.title}\n\n` + chat.messages.map(message => `## ${message.role === 'user' ? 'User' : 'Assistant'}\n\n${message.content}${message.imagesOmitted ? '\n\n[Images were not saved in local history.]' : ''}${message.sources?.map(source => `\n\n> ${source.label} — ${source.snapshot.name}:${source.startLine}–${source.endLine}\n\n${source.quote.split('\n').map(line => '> ' + line).join('\n')}`).join('') ?? ''}`).join('\n\n---\n\n') + '\n'
}
