/** Shared IPC contract and deterministic edit validation. */
export type AgentAuthMode = 'system' | 'none'
export interface AgentSettings { baseUrl: string; model: string; authMode?: AgentAuthMode }
export interface AgentHeader { name: string; value: string }
export interface AgentConfig extends AgentSettings { hasKey: boolean; hasHeaders: boolean }
export interface AgentImage { name: string; dataUrl: string }
export interface AgentMessage { role: 'user' | 'assistant'; content: string; images?: AgentImage[] }
export interface AgentContext { name: string; markdown: string; snapshotId?: string; offset?: number }
export interface AgentReference extends AgentContext { documentId: string }
export interface ReferenceSnapshot { documentId: string; snapshot: DocumentSnapshot }
export interface AgentSkill {
  id: string
  name: string
  description: string
  license: string | null
  source: string | null
  builtin: boolean
  enabled: boolean
}
export interface AgentSkillDetail { id: string; instructions: string; files: string[] }
export interface AgentRequest {
  requestId: string
  messages: AgentMessage[]
  context: AgentContext | null
  language: string
  skillIds?: string[]
  /** UTF-16 boundaries relative to the read context; omitted means the whole attachment. */
  editRange?: { from: number; to: number }
  readOnly?: boolean
  references?: AgentReference[]
  /** Kept in the local Rust task; provider sees text only through read_review_change. */
  reviewChanges?: AgentReviewChange[]
}
export interface AgentReviewChange extends AgentChange { id: string; reason?: string }
/** End-exclusive UTF-16 coordinates in the original document, bound to one immutable snapshot. */
export interface AgentAnchor { snapshotId: string; from: number; to: number }
export interface AgentChange { oldText: string; newText: string; anchor?: AgentAnchor }
export interface AgentProposal { title: string; changes?: AgentChange[]; oldText?: string; newText?: string }
export interface AgentEvent {
  requestId: string
  kind: 'delta' | 'tool' | 'proposal' | 'source' | 'done' | 'cancelled' | 'error'
  text?: string
  proposal?: AgentProposal
}
export interface DocumentSnapshot { tabId: string; name: string; markdown: string; from: number; to: number; path?: string; snapshotId?: string }
export interface AgentSource { label: string; startLine: number; endLine: number; quote: string; snapshot: DocumentSnapshot }

/** Citation lines refer to the immutable attachment, including a partial first line. */
export function reviewSource(snapshot: DocumentSnapshot, value: unknown): AgentSource {
  const source = value as Partial<AgentSource> | null
  if (!source || typeof source.label !== 'string' || !source.label.trim() || Array.from(source.label).length > 200
    || !Number.isInteger(source.startLine) || !Number.isInteger(source.endLine) || typeof source.quote !== 'string') throw new Error('agent:invalidSource')
  const lines = snapshot.markdown.slice(snapshot.from, snapshot.to).split('\n')
  const start = source.startLine!, end = source.endLine!
  if (start < 1 || end < start || end > lines.length || end - start >= 200) throw new Error('agent:invalidSource')
  const quote = lines.slice(start - 1, end).join('\n')
  if (!quote.trim() || quote !== source.quote || new TextEncoder().encode(quote).length > 48_000) throw new Error('agent:invalidSource')
  const from = snapshot.from + lines.slice(0, start - 1).reduce((sum, line) => sum + line.length + 1, 0)
  const to = from + quote.length
  return { label: source.label, quote, startLine: snapshot.markdown.slice(0, from).split('\n').length,
    endLine: snapshot.markdown.slice(0, to).split('\n').length, snapshot: { ...snapshot, from, to } }
}
export interface ReviewedEdit extends AgentProposal {
  locked?: boolean
  documentChanged?: boolean
  rebasedFrom?: string
  rebasedTo?: string
  rebaseConflicts?: string[]
  snapshot: DocumentSnapshot
  changes: ReviewedChange[]
  status: EditStatus | 'partial'
  appliedMarkdown?: string
}
export type EditStatus = 'pending' | 'applied' | 'dismissed' | 'reverted'
export interface ReviewedChange extends AgentChange { id: string; sourceChangeIds?: string[]; reason?: string; from: number; to: number; startLine: number; endLine: number; status: EditStatus }

/** JS indices count UTF-16 units, but a valid document position cannot bisect a surrogate pair. */
export function isDocumentBoundary(markdown: string, offset: number): boolean {
  if (!Number.isInteger(offset) || offset < 0 || offset > markdown.length) return false
  const before = markdown.charCodeAt(offset - 1), after = markdown.charCodeAt(offset)
  return !(before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF)
}

export function reviewProposal(snapshot: DocumentSnapshot, proposal: AgentProposal, proposalId: string = crypto.randomUUID()): ReviewedEdit {
  const { markdown, from, to } = snapshot
  if (!isDocumentBoundary(markdown, from) || !isDocumentBoundary(markdown, to) || to < from) throw new Error('agent:invalidEdit')
  if (typeof proposal.title !== 'string' || !proposal.title.trim() || new TextEncoder().encode(proposal.title).length > 300) throw new Error('agent:invalidEdit')
  if (proposal.changes && (proposal.oldText !== undefined || proposal.newText !== undefined)) throw new Error('agent:invalidEdit')
  const inputs = proposal.changes ?? [{ oldText: proposal.oldText!, newText: proposal.newText! }]
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > 32) throw new Error('agent:invalidEdit')
  const scope = markdown.slice(from, to)
  let bytes = 0
  const changes: ReviewedChange[] = inputs.map((change, changeIndex) => {
    if (!change || typeof change.oldText !== 'string' || typeof change.newText !== 'string') throw new Error('agent:invalidEdit')
    const oldText = change.oldText, newText = change.newText.replace(/\r\n?/g, '\n')
    bytes += new TextEncoder().encode(newText).length
    let start: number, end: number
    if (change.anchor !== undefined) {
      const anchor = change.anchor
      if (!anchor || !snapshot.snapshotId || anchor.snapshotId !== snapshot.snapshotId
        || !isDocumentBoundary(markdown, anchor.from) || !isDocumentBoundary(markdown, anchor.to)
        || anchor.from < from || anchor.to > to || anchor.to < anchor.from
        || markdown.slice(anchor.from, anchor.to) !== oldText) throw new Error('agent:invalidEdit')
      start = anchor.from; end = anchor.to
    } else {
      const index = oldText ? scope.indexOf(oldText) : scope.length
      if (index < 0 || oldText && scope.indexOf(oldText, index + 1) !== -1) throw new Error('agent:invalidEdit')
      start = from + index; end = start + oldText.length
      if (!isDocumentBoundary(markdown, start) || !isDocumentBoundary(markdown, end)) throw new Error('agent:invalidEdit')
    }
    if (oldText === newText || bytes > 240_000) throw new Error('agent:invalidEdit')
    return { id: `${proposalId}:${changeIndex + 1}`, oldText, newText, ...(change.anchor ? { anchor: { ...change.anchor } } : {}), from: start, to: end, startLine: markdown.slice(0, start).split('\n').length, endLine: markdown.slice(0, Math.max(start, end - 1)).split('\n').length, status: 'pending' }
  })
  const ordered = [...changes].sort((a, b) => a.from - b.from)
  if (ordered.some((change, i) => i > 0 && (change.from < ordered[i - 1]!.to || change.from === ordered[i - 1]!.from))) throw new Error('agent:invalidEdit')
  return { title: proposal.title, snapshot, changes, status: 'pending' }
}

/** Bound JSON-escaped bytes too: control characters must not expand beyond the budget. */
export function reviewExcerpt(text: string, budget: number): string {
  const encoder = new TextEncoder()
  let size = 0, end = 0
  for (const char of text) {
    size += encoder.encode(JSON.stringify(char)).length - 2
    if (size > budget) break
    end += char.length
  }
  return text.slice(0, end)
}

export function reviewFeedback(edit: ReviewedEdit, excerptBytes = 512, reasonBytes = 512, available?: Set<string>): string {
  return '\n[User review feedback]\n' + JSON.stringify({ title: edit.title, ...(edit.rebasedTo ? { supersededBy: edit.rebasedTo } : {}), changes: edit.changes.map(change => ({
    id: change.id, status: edit.rebasedTo && change.status === 'pending' ? 'superseded' : edit.documentChanged && change.status === 'applied' ? 'unverified' : change.status,
    ...(edit.documentChanged && change.status === 'applied' ? { reviewStatus: change.status } : {}),
    oldText: reviewExcerpt(change.oldText, excerptBytes), newText: reviewExcerpt(change.newText, excerptBytes),
    ...(reviewExcerpt(change.oldText, excerptBytes) !== change.oldText ? { oldTextTruncated: true } : {}),
    ...(reviewExcerpt(change.newText, excerptBytes) !== change.newText ? { newTextTruncated: true } : {}),
    ...(change.reason?.trim() ? { reason: reviewExcerpt(change.reason.trim(), reasonBytes), ...(reviewExcerpt(change.reason.trim(), reasonBytes) !== change.reason.trim() ? { reasonTruncated: true } : {}) } : {}),
    ...(available && !available.has(change.id) ? { detailsAvailable: false } : {}),
  })) })
}

/** Always compose from the immutable original so earlier accepted changes cannot shift later targets. */
export function reviewedMarkdown(edit: ReviewedEdit, accepted: number[]): string {
  let markdown = edit.snapshot.markdown
  for (const change of accepted.map(index => edit.changes[index]!).sort((a, b) => b.from - a.from)) {
    markdown = markdown.slice(0, change.from) + change.newText + markdown.slice(change.to)
  }
  return markdown
}

export function proposalMarkdown(snapshot: DocumentSnapshot, proposal: AgentProposal): string {
  const edit = reviewProposal(snapshot, proposal)
  return reviewedMarkdown(edit, edit.changes.map((_, index) => index))
}

export interface DiffLine { kind: 'same' | 'removed' | 'added'; text: string }
/** Bounded line diff: large replacements fall back to showing removed/added lines. */
export function changeDiff(change: AgentChange): DiffLine[] {
  const before = change.oldText ? change.oldText.split('\n') : [], after = change.newText ? change.newText.split('\n') : []
  if (before.length * after.length > 250_000) return [...before.map(text => ({ kind: 'removed' as const, text })), ...after.map(text => ({ kind: 'added' as const, text }))]
  const table = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1))
  for (let i = before.length - 1; i >= 0; i--) for (let j = after.length - 1; j >= 0; j--) table[i]![j] = before[i] === after[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
  const lines: DiffLine[] = []
  let i = 0, j = 0
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) { lines.push({ kind: 'same', text: before[i++]! }); j++ }
    else if (i < before.length && (j === after.length || table[i + 1]![j]! >= table[i]![j + 1]!)) lines.push({ kind: 'removed', text: before[i++]! })
    else lines.push({ kind: 'added', text: after[j++]! })
  }
  return lines
}

/** Convert Muya's exported Markdown coordinates, not rendered DOM text. */
export function markdownSelection(markdown: string, cursor: unknown, allowCaret = false): { from: number; to: number } | null {
  const position = (value: unknown): number | null => {
    if (!value || typeof value !== 'object') return null
    const { line, ch } = value as { line?: number; ch?: number }
    const lines = markdown.split('\n')
    if (!Number.isInteger(line) || !Number.isInteger(ch) || line! < 0 || line! >= lines.length || ch! < 0 || ch! > lines[line!]!.length) return null
    return lines.slice(0, line).reduce((sum, text) => sum + text.length + 1, 0) + ch!
  }
  if (!cursor || typeof cursor !== 'object') return null
  const { anchor, focus } = cursor as { anchor: unknown; focus: unknown }
  const a = position(anchor), b = position(focus)
  return a === null || b === null || !allowCaret && a === b ? null : { from: Math.min(a, b), to: Math.max(a, b) }
}

export const AGENT_PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', authMode: 'system' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: '', authMode: 'system' },
  { id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: '', authMode: 'none' },
  { id: 'custom', name: 'custom', baseUrl: '', model: '', authMode: 'system' },
] as const

/** Parse one HTTP header per line without ever placing saved values in ordinary config. */
export function parseAgentHeaders(text: string): AgentHeader[] | undefined {
  if (!text.trim()) return undefined
  const headers: AgentHeader[] = []
  const names = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const separator = line.indexOf(':')
    const name = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    const normalized = name.toLowerCase()
    if (separator <= 0 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || !value
      || Array.from(value).some(char => { const code = char.charCodeAt(0); return code <= 31 || code === 127 })
      || names.has(normalized)) throw new Error('agent:invalidHeaders')
    names.add(normalized)
    headers.push({ name, value })
  }
  if (!headers.length || headers.length > 32) throw new Error('agent:invalidHeaders')
  return headers
}
