import type { AgentConfig, DocumentSnapshot, ReferenceSnapshot } from './agent'

export type AgentTaskStatus = 'preparing' | 'reading' | 'generating' | 'awaitingReview' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
export type AgentContextReadTool = 'read_document' | 'search_document' | 'cite_document' | 'read_review_change' | 'read_skill' | 'read_skill_file' | 'chapter_summary'

export interface AgentTaskSource {
  documentId: string
  name: string
  kind: 'current' | 'reference'
  authorizedRange?: { from: number; to: number }
  readRange?: { from: number; to: number }
}

export interface AgentTaskSkill { id: string; name: string; selected: boolean }

export interface AgentTaskContext {
  taskId: string
  paneId: string
  documentId: string | null
  snapshotId: string | null
  documentName: string | null
  scope: 'none' | 'document' | 'selection'
  sources: AgentTaskSource[]
  skills: AgentTaskSkill[]
  model: string
  endpoint: string
  localModel: boolean
  status: AgentTaskStatus
  startedAt: number
  /** Read-only request mode is safe to restore as metadata so retries retain their boundary. */
  readOnly?: boolean
}

export interface AgentContextRead {
  id: string
  tool: AgentContextReadTool
  kind: 'outline' | 'range' | 'search' | 'citation' | 'review' | 'skill' | 'summary'
  documentId?: string
  documentName: string
  startLine?: number
  endLine?: number
  query?: string
  changeId?: string
  field?: string
  resultCount?: number
  totalChars?: number
  excerpt: string
  truncated: boolean
}

const CONTEXT_PREVIEW_LIMIT = 2400
export const MAX_AGENT_TASK_SOURCES = 49 // Current document + eight manual references + forty project reads.

export function agentEndpointInfo(baseUrl: string): { endpoint: string; local: boolean } {
  try {
    const parsed = new URL(baseUrl)
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    const local = host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host)
    return { endpoint: parsed.host || 'configured service', local }
  } catch {
    return { endpoint: 'configured service', local: false }
  }
}

export function createAgentTaskContext(options: {
  taskId: string
  paneId: string
  attached: DocumentSnapshot | null
  reading: DocumentSnapshot | null
  references: ReferenceSnapshot[]
  skills?: AgentTaskSkill[]
  config: AgentConfig | null
  startedAt?: number
  readOnly?: boolean
}): AgentTaskContext {
  const { attached, reading } = options
  const endpoint = agentEndpointInfo(options.config?.baseUrl ?? '')
  const sources: AgentTaskSource[] = []
  if (attached) sources.push({
    documentId: attached.tabId,
    name: attached.name,
    kind: 'current',
    authorizedRange: { from: attached.from, to: attached.to },
    ...(reading ? { readRange: { from: reading.from, to: reading.to } } : {}),
  })
  for (const reference of options.references) sources.push({
    documentId: reference.documentId,
    name: reference.snapshot.name,
    kind: 'reference',
    readRange: { from: reference.snapshot.from, to: reference.snapshot.to },
  })
  const scope = !attached ? 'none' : attached.from !== 0 || attached.to !== attached.markdown.length ? 'selection' : 'document'
  return {
    taskId: options.taskId,
    paneId: options.paneId,
    documentId: attached?.tabId ?? null,
    snapshotId: attached?.snapshotId ?? null,
    documentName: attached?.name ?? null,
    scope,
    sources,
    skills: options.skills?.map(skill => ({ ...skill })) ?? [],
    model: options.config?.model ?? '',
    endpoint: endpoint.endpoint,
    localModel: endpoint.local,
    status: 'preparing',
    startedAt: options.startedAt ?? Date.now(),
    ...(options.readOnly ? { readOnly: true } : {}),
  }
}

/** Validate a backend access event before showing it as a record of model context. */
export function parseAgentContextRead(value: unknown, task: AgentTaskContext, id: string): AgentContextRead | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const tools: AgentContextReadTool[] = ['read_document', 'search_document', 'cite_document', 'read_review_change', 'read_skill', 'read_skill_file', 'chapter_summary']
  if (typeof item.tool !== 'string' || !tools.includes(item.tool as AgentContextReadTool)
    || typeof item.kind !== 'string' || !['outline', 'range', 'search', 'citation', 'review', 'skill', 'summary'].includes(item.kind)
    || typeof item.documentName !== 'string' || item.documentName.length > 1024
    || typeof item.excerpt !== 'string') return null
  const rawDocumentId = typeof item.documentId === 'string' ? item.documentId : undefined
  const source = rawDocumentId === 'current'
    ? task.sources.find(candidate => candidate.kind === 'current')
    : task.sources.find(candidate => candidate.documentId === rawDocumentId)
  if (rawDocumentId && !source && item.kind !== 'review' && item.kind !== 'skill') return null
  const excerpt = item.excerpt.slice(0, CONTEXT_PREVIEW_LIMIT)
  const boundedInteger = (n: unknown): n is number => Number.isInteger(n) && Number(n) >= 1
  const nonNegativeInteger = (n: unknown): n is number => Number.isInteger(n) && Number(n) >= 0
  return {
    id,
    tool: item.tool as AgentContextReadTool,
    kind: item.kind as AgentContextRead['kind'],
    ...(source ? { documentId: source.documentId } : {}),
    documentName: source?.name ?? item.documentName,
    ...(boundedInteger(item.startLine) ? { startLine: item.startLine } : {}),
    ...(boundedInteger(item.endLine) ? { endLine: item.endLine } : {}),
    ...(typeof item.query === 'string' ? { query: item.query.slice(0, 2000) } : {}),
    ...(typeof item.changeId === 'string' ? { changeId: item.changeId.slice(0, 160) } : {}),
    ...(typeof item.field === 'string' ? { field: item.field.slice(0, 32) } : {}),
    ...(nonNegativeInteger(item.resultCount) ? { resultCount: item.resultCount } : {}),
    ...(nonNegativeInteger(item.totalChars) ? { totalChars: item.totalChars } : {}),
    excerpt,
    truncated: item.truncated === true || (item.excerpt as string).length > CONTEXT_PREVIEW_LIMIT,
  }
}

export function restoreAgentTaskContext(value: unknown): AgentTaskContext | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const statuses: AgentTaskStatus[] = ['preparing', 'reading', 'generating', 'awaitingReview', 'completed', 'failed', 'cancelled', 'interrupted']
  const scopes: AgentTaskContext['scope'][] = ['none', 'document', 'selection']
  if (typeof item.taskId !== 'string' || !item.taskId || item.taskId.length > 160
    || typeof item.paneId !== 'string' || !item.paneId || item.paneId.length > 160
    || (item.documentId !== null && typeof item.documentId !== 'string')
    || (item.snapshotId !== null && typeof item.snapshotId !== 'string')
    || (item.documentName !== null && typeof item.documentName !== 'string')
    || typeof item.scope !== 'string' || !scopes.includes(item.scope as AgentTaskContext['scope'])
    || !Array.isArray(item.sources) || item.sources.length > MAX_AGENT_TASK_SOURCES
    || !Array.isArray(item.skills) || item.skills.length > 64
    || typeof item.model !== 'string' || item.model.length > 256
    || typeof item.endpoint !== 'string' || item.endpoint.length > 512
    || typeof item.localModel !== 'boolean' || !Number.isFinite(item.startedAt)
    || item.readOnly !== undefined && typeof item.readOnly !== 'boolean'
    || typeof item.status !== 'string' || !statuses.includes(item.status as AgentTaskStatus)) return null
  const sources: AgentTaskSource[] = []
  for (const source of item.sources) {
    if (!source || typeof source !== 'object') return null
    const candidate = source as Record<string, unknown>
    if (typeof candidate.documentId !== 'string' || !candidate.documentId || candidate.documentId.length > 160
      || typeof candidate.name !== 'string' || candidate.name.length > 1024
      || !['current', 'reference'].includes(String(candidate.kind))) return null
    const range = (raw: unknown) => {
      if (raw === undefined) return undefined
      if (!raw || typeof raw !== 'object') return null
      const value = raw as Record<string, unknown>
      return Number.isInteger(value.from) && Number.isInteger(value.to) && Number(value.from) >= 0 && Number(value.to) >= Number(value.from)
        ? { from: Number(value.from), to: Number(value.to) } : null
    }
    const authorizedRange = range(candidate.authorizedRange), readRange = range(candidate.readRange)
    if (authorizedRange === null || readRange === null) return null
    sources.push({ documentId: candidate.documentId, name: candidate.name, kind: candidate.kind as AgentTaskSource['kind'],
      ...(authorizedRange ? { authorizedRange } : {}), ...(readRange ? { readRange } : {}) })
  }
  const skills: AgentTaskSkill[] = []
  for (const skill of item.skills) {
    if (!skill || typeof skill !== 'object') return null
    const candidate = skill as Record<string, unknown>
    if (typeof candidate.id !== 'string' || !candidate.id || candidate.id.length > 80
      || typeof candidate.name !== 'string' || candidate.name.length > 200 || typeof candidate.selected !== 'boolean') return null
    skills.push({ id: candidate.id, name: candidate.name, selected: candidate.selected })
  }
  const status = ['preparing', 'reading', 'generating'].includes(String(item.status)) ? 'interrupted' : item.status as AgentTaskStatus
  return {
    taskId: item.taskId, paneId: item.paneId, documentId: item.documentId as string | null,
    snapshotId: item.snapshotId as string | null, documentName: item.documentName as string | null,
    scope: item.scope as AgentTaskContext['scope'], sources, skills, model: item.model, endpoint: item.endpoint,
    localModel: item.localModel, status, startedAt: item.startedAt as number,
    ...(item.readOnly === true ? { readOnly: true } : {}),
  }
}

export function restoreAgentContextReads(value: unknown, task: AgentTaskContext): AgentContextRead[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_CONTEXT_READS_PER_TURN).flatMap((item, index) => {
    const read = parseAgentContextRead(item, task, `${task.taskId}:${index}`)
    return read ? [read] : []
  })
}

export const MAX_CONTEXT_READS_PER_TURN = 256
export const MAX_CONTEXT_PREVIEW_CHARS = CONTEXT_PREVIEW_LIMIT
