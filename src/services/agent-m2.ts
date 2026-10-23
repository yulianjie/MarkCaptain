import projectLimits from '@/common/agent-project-limits.json'
import type {
  AgentDocumentCheckResult, AgentProjectBuffer, AgentProjectConfig,
  AgentProjectSearchConfig, AgentProjectWritingConfig, AgentWebResearchRequest,
  DocumentSnapshot, ReferenceSnapshot,
} from './agent'

export const DEFAULT_PROJECT_INCLUDE = ['**/*.md']
// Match the existing Agent snapshot/history limit (decimal bytes).
export const MAX_PROJECT_BUFFER_BYTES = 2_000_000
export const MAX_PROJECT_BUFFER_TOTAL = 16 * 1024 * 1024
export const MAX_PROJECT_BUFFER_COUNT = 128
export const MAX_PROJECT_READ_REFERENCES = projectLimits.maxReadDocuments
export const MAX_PROJECT_READ_BYTES = 16 * 1024 * 1024
const PROJECT_DOCUMENT_ID = /^project-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isProjectDocumentId(value: string): boolean { return PROJECT_DOCUMENT_ID.test(value) }

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Rust canonical paths use Windows verbatim prefixes; editor tabs use display paths. */
export function portableProjectPath(value: string): string {
  let path = value.replace(/\\/g, '/')
  if (/^\/\/\?\/UNC\//i.test(path)) path = `//${path.slice(8)}`
  else if (/^\/\/\?\//.test(path)) path = path.slice(4)
  let prefix = '', rest = path
  if (/^[a-z]:\//i.test(path)) { prefix = path.slice(0, 3); rest = path.slice(3) }
  else if (path.startsWith('//')) {
    const parts = path.slice(2).split('/').filter(Boolean)
    if (parts.length >= 2) { prefix = `//${parts[0]}/${parts[1]}/`; rest = parts.slice(2).join('/') }
  } else if (path.startsWith('/')) { prefix = '/'; rest = path.slice(1) }
  const parts: string[] = []
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (parts.length) parts.pop() }
    else parts.push(part)
  }
  return parts.length ? `${prefix}${parts.join('/')}` : prefix || parts.join('/')
}

function projectPathInside(root: string, candidate: string, isInside: (root: string, path: string) => boolean): boolean {
  const r = portableProjectPath(root), p = portableProjectPath(candidate)
  const windows = /^[a-z]:\//i.test(r) || r.startsWith('//')
  return isInside(windows ? r.toLowerCase() : r, windows ? p.toLowerCase() : p)
}

/** Adds known defaults without dropping fields written by a newer app version. */
export function normalizeProjectConfig(value: AgentProjectConfig | null): AgentProjectConfig {
  const input = object(value)
  const writing = object(input.writing) as AgentProjectWritingConfig
  const projectSearch = object(input.projectSearch) as AgentProjectSearchConfig
  return {
    ...input,
    schemaVersion: typeof input.schemaVersion === 'number' ? input.schemaVersion : 1,
    writing: { ...writing, language: typeof writing.language === 'string' ? writing.language : '',
      audience: typeof writing.audience === 'string' ? writing.audience : '',
      tone: typeof writing.tone === 'string' ? writing.tone : '',
      glossary: Array.isArray(writing.glossary) ? writing.glossary.filter(term => term && typeof term.preferred === 'string' && Array.isArray(term.avoid)) : [] },
    projectSearch: { ...projectSearch,
      enabledByDefault: projectSearch.enabledByDefault === true,
      include: cleanLines(projectSearch.include, DEFAULT_PROJECT_INCLUDE),
      exclude: cleanLines(projectSearch.exclude, []),
    },
  }
}

export function cleanLines(value: unknown, fallback: string[] = []): string[] {
  const lines = Array.isArray(value) ? value : fallback
  return [...new Set(lines.filter((line): line is string => typeof line === 'string').map(line => line.trim()).filter(Boolean))]
}

export function validateProjectPatterns(include: readonly string[], exclude: readonly string[]): void {
  const valid = (values: readonly string[], max: number) => values.length <= max && values.every(value => {
    const normalized = value.replace(/\\/g, '/')
    return new TextEncoder().encode(normalized).length <= 256 && !normalized.startsWith('/') && !normalized.startsWith('!')
      && !normalized.includes(':') && !normalized.includes('\0')
      && !normalized.split('/').includes('..')
  })
  if (!valid(include, 64) || !valid(exclude, 128)) throw new Error('agent:projectPatternInvalid')
}

/** Freeze root-local buffers for local IPC; Rust applies the authoritative grant globs before model access. */
export function snapshotDirtyProjectBuffers(
  tabs: readonly { pathname?: string; markdown: string; isSaved: boolean }[], root: string,
  isInside: (root: string, path: string) => boolean,
): AgentProjectBuffer[] {
  const buffers: AgentProjectBuffer[] = []
  const byPath = new Map<string, string>()
  const portableRoot = portableProjectPath(root)
  let bytes = 0
  for (const tab of tabs) {
    const portablePath = tab.pathname ? portableProjectPath(tab.pathname) : ''
    if (tab.isSaved || !tab.pathname || !portablePath || !projectPathInside(portableRoot, portablePath, isInside) || !/\.(md|markdown|mkd|mdown|mkdn|mdtxt|mdtext)$/i.test(portablePath)) continue
    const size = new TextEncoder().encode(tab.markdown).length
    const pathKey = /^[a-z]:\//i.test(portablePath) || portablePath.startsWith('//') ? portablePath.toLocaleLowerCase() : portablePath
    const existing = byPath.get(pathKey)
    if (existing !== undefined) {
      if (existing !== tab.markdown) throw new Error('agent:projectBufferConflict')
      continue
    }
    if (size > MAX_PROJECT_BUFFER_BYTES || bytes + size > MAX_PROJECT_BUFFER_TOTAL || buffers.length >= MAX_PROJECT_BUFFER_COUNT) {
      throw new Error('agent:projectBuffersTooLarge')
    }
    bytes += size
    byPath.set(pathKey, tab.markdown)
    buffers.push({ path: tab.pathname, markdown: tab.markdown })
  }
  return buffers
}

export function validateWebResearch(value: AgentWebResearchRequest): AgentWebResearchRequest {
  if (!value.enabled) return { enabled: false, topic: '', allowDocumentQueries: false, approvedQueries: [], urls: [], publicDns: false }
  const topic = value.topic.trim()
  const approvedQueries = cleanLines(value.approvedQueries)
  const urlsInput = cleanLines(value.urls)
  const urls = urlsInput.map(validatePublicUrl).filter((url): url is string => Boolean(url))
  if (approvedQueries.some(query => !isSafeWebQuery(query))) throw new Error('agent:webQueryRejected')
  if (topic.length > 2000 || new TextEncoder().encode(topic).length > 2000
    || approvedQueries.length > 8 || urlsInput.length > 8
    || approvedQueries.some(query => new TextEncoder().encode(query).length > 320)
    || urlsInput.some(url => new TextEncoder().encode(url).length > 4096)
    || urls.some(url => new TextEncoder().encode(url).length > 4096)) throw new Error('agent:webResearchLimit')
  if (urlsInput.some(url => !validatePublicUrl(url))) throw new Error('agent:webUrlInvalid')
  if (!approvedQueries.length && !urls.length) throw new Error('agent:webResearchEmpty')
  return { enabled: true, topic, allowDocumentQueries: value.allowDocumentQueries === true, approvedQueries, urls, publicDns: value.publicDns === true }
}

export function validatePublicUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname || isPrivateHost(url.hostname)) return null
    return url.href
  } catch { return null }
}

export function isSafeWebQuery(query: string): boolean {
  if (!query.trim() || Array.from(query).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return false
  const pathLike = /(?:^|\s)(?:[a-z]:[\\/]|\\\\[^\\\s]+\\|\/(?:users|home|private|var|etc|tmp|windows|program files)\/)/i
  const secretLike = /\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password)\s*[:=]\s*\S+|\bbearer\s+[a-z0-9._~+/-]{12,}|\bsk-[a-z0-9_-]{16,}|\bgh[pousr]_[a-z0-9]{20,}|\bAKIA[A-Z0-9]{16}\b/i
  return !pathLike.test(query) && !secretLike.test(query) && !/https?:\/\/\S+/i.test(query)
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.includes(':')) {
    const mappedV4 = host.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
    return host === '::' || host === '::1' || /^f[cd][0-9a-f]:/i.test(host) || host.startsWith('fe80:')
      || Boolean(mappedV4 && isPrivateHost(mappedV4))
  }
  const octets = host.split('.').map(Number)
  if (octets.length !== 4 || octets.some(value => !Number.isInteger(value) || value < 0 || value > 255)) return false
  const [a, b] = octets
  return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b! >= 16 && b! <= 31
    || a === 192 && (b === 0 || b === 168) || a === 198 && (b === 18 || b === 19)
    || a === 100 && b! >= 64 && b! <= 127 || a >= 224
}

/** Suggestions stay local and editable; callers must never submit them automatically. */
export function suggestDocumentQueries(markdown: string, topic = ''): string[] {
  const headings = markdown.split(/\r?\n/).filter(line => /^#{1,3}\s+\S/.test(line)).map(line => line.replace(/^#{1,3}\s+/, '').trim())
  const candidates = [topic.trim(), ...headings].filter(Boolean).map(value => Array.from(value).slice(0, 100).join(''))
    .filter(value => new TextEncoder().encode(value).length <= 320 && isSafeWebQuery(value))
  return [...new Set(candidates)].slice(0, 8)
}

export function validateDocumentCheck(value: AgentDocumentCheckResult, markdown: string): AgentDocumentCheckResult {
  if (!value || !Array.isArray(value.issues)) throw new Error('agent:checkInvalid')
  const issues = value.issues.filter(issue => Number.isInteger(issue.from) && Number.isInteger(issue.to)
    && issue.from >= 0 && issue.to >= issue.from && issue.to <= markdown.length
    && typeof issue.message === 'string' && typeof issue.evidence === 'string'
    && markdown.slice(issue.from, issue.to) === issue.evidence)
  const invalidIssues = issues.length !== value.issues.length
  return { ...value, issues, complete: value.complete === true && !invalidIssues, truncated: value.truncated === true || invalidIssues,
    externalLinksUnchecked: Math.max(0, Number(value.externalLinksUnchecked) || 0),
    localTargetsChecked: Math.max(0, Number(value.localTargetsChecked) || 0), scope: typeof value.scope === 'string' ? value.scope : '' }
}

/** Project reads are actual read receipts, separate from the 8 manual references. */
export function validateProjectReadReferences(references: ReferenceSnapshot[], root: string, isInside: (root: string, path: string) => boolean): void {
  if (references.length > MAX_PROJECT_READ_REFERENCES) throw new Error('agent:projectReferenceLimit')
  let bytes = 0
  const ids = new Set<string>()
  for (const reference of references) {
    const { documentId, snapshot } = reference
    const size = new TextEncoder().encode(snapshot.markdown).length
    if (!isProjectDocumentId(documentId) || ids.has(documentId) || snapshot.tabId !== `project-${documentId}`
      || snapshot.from !== 0 || snapshot.to !== snapshot.markdown.length || size > MAX_PROJECT_BUFFER_BYTES
      || !snapshot.path || !projectPathInside(root, snapshot.path, isInside)) throw new Error('agent:invalidSource')
    ids.add(documentId); bytes += size
    if (bytes > MAX_PROJECT_READ_BYTES) throw new Error('agent:projectReferenceLimit')
  }
}

export function parseProjectSource(value: unknown, root: string, isInside: (root: string, path: string) => boolean, requestId?: string): { documentId: string; snapshot: DocumentSnapshot } | null {
  const item = object(value), source = object(item.snapshot)
  if (typeof item.documentId !== 'string' || !isProjectDocumentId(item.documentId)
    || typeof source.tabId !== 'string' || source.tabId !== `project-${item.documentId}`
    || typeof source.name !== 'string' || source.name.length > 300
    || typeof source.markdown !== 'string' || new TextEncoder().encode(source.markdown).length > 2_000_000
    || typeof source.path !== 'string' || !projectPathInside(root, source.path, isInside)
    || typeof source.snapshotId !== 'string' || source.snapshotId.length > 200
    || requestId !== undefined && source.snapshotId !== `${requestId}:${item.documentId}`
    || source.from !== 0 || source.to !== source.markdown.length) return null
  return { documentId: item.documentId, snapshot: { tabId: source.tabId, name: source.name,
    markdown: source.markdown, from: source.from, to: source.to, path: portableProjectPath(source.path), snapshotId: source.snapshotId } }
}
