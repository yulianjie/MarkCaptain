import { reviewProposal, type AgentProposal, type DocumentSnapshot, type ReviewedEdit } from './agent'

export interface ExternalConnection { documentId: string; port: number; token: string; adapterPath: string }
export interface ExternalRequest { id: string; method: string; arguments: Record<string, unknown> }
export interface ExternalBuffer { snapshot: DocumentSnapshot; selection: { from: number; to: number } | null }
interface ExternalHost {
  read: () => ExternalBuffer | null
  receive: (snapshot: DocumentSnapshot, proposal: AgentProposal, id: string) => ReviewedEdit
  review: (id: string) => ReviewedEdit | undefined
}

/** One in-memory grant. Versions never become valid again after edit/undo. */
export class ExternalDocumentSession {
  private active = true
  private version = 0
  private snapshotId = ''
  private lastFingerprint = ''
  private readonly proposals = new Set<string>()
  constructor(readonly documentId: string, private readonly host: ExternalHost) {}

  invalidate(): void { this.version++; this.snapshotId = crypto.randomUUID(); this.lastFingerprint = '' }
  revoke(): void { this.active = false; this.proposals.clear() }

  private current(): ExternalBuffer {
    if (!this.active) throw new Error('authorizationRevoked')
    const buffer = this.host.read()
    if (!buffer) throw new Error('authorizationRevoked')
    if (new TextEncoder().encode(buffer.snapshot.markdown).length > 2_000_000) throw new Error('documentTooLarge')
    const fingerprint = JSON.stringify([buffer.snapshot.tabId, buffer.snapshot.name, buffer.snapshot.markdown, buffer.selection])
    if (fingerprint !== this.lastFingerprint) {
      this.version++; this.snapshotId = crypto.randomUUID(); this.lastFingerprint = fingerprint
    }
    return { snapshot: { ...buffer.snapshot, snapshotId: this.snapshotId }, selection: buffer.selection }
  }

  handle(request: ExternalRequest): unknown {
    try {
      if (!this.active) throw new Error('authorizationRevoked')
      const args = request.arguments
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalidRequest')
      const keys = request.method === 'read_document' ? ['documentId'] : request.method === 'propose_edit'
        ? ['documentId', 'version', 'snapshotId', 'proposal'] : request.method === 'get_review_result' ? ['documentId', 'proposalId'] : []
      if (!keys.length || Object.keys(args).some(key => !keys.includes(key))) throw new Error('invalidRequest')
      if (args.documentId !== undefined && args.documentId !== this.documentId || request.method !== 'read_document' && args.documentId !== this.documentId) throw new Error('wrongDocument')
      if (request.method === 'get_review_result') {
        if (typeof args.proposalId !== 'string' || !this.proposals.has(args.proposalId)) throw new Error('unknownProposal')
        const edit = this.host.review(args.proposalId)
        if (!edit) return { proposalId: args.proposalId, status: 'unavailable', changes: [] }
        const chain = [edit], seen = new Set<string>()
        while (chain.length < 65 && chain[chain.length - 1]!.rebasedTo) {
          const id = chain[chain.length - 1]!.rebasedTo!
          if (seen.has(id)) break
          seen.add(id)
          const next = this.host.review(id)
          if (!next) break
          chain.push(next)
        }
        const changes = edit.changes.map(original => {
          let change = original, owner = edit
          for (const migrated of chain.slice(1)) {
            const next = migrated.changes.find(item => item.id === original.id || item.sourceChangeIds?.includes(original.id))
            if (next) { change = next; owner = migrated }
          }
          return { id: original.id, reviewChangeId: change.id,
            status: owner.documentChanged && change.status === 'applied' ? 'unverified' : change.status,
            ...(owner.documentChanged && change.status === 'applied' ? { reviewStatus: change.status } : {}),
            ...(change.reason ? { reason: change.reason } : {}),
            ...(chain.some(card => card.rebaseConflicts?.some(id => id === original.id || card.changes.some(item => item.id === id && item.sourceChangeIds?.includes(original.id)))) ? { conflict: true } : {}) }
        })
        return { proposalId: args.proposalId, status: changes.every(change => change.status === changes[0]?.status) ? changes[0]?.status : 'partial',
          documentChanged: Boolean(chain[chain.length - 1]!.documentChanged), rebased: chain.length > 1, changes }
      }
      const { snapshot, selection } = this.current()
      if (request.method === 'read_document') return { documentId: this.documentId, version: this.version, snapshotId: this.snapshotId,
        name: snapshot.name, markdown: snapshot.markdown, selection,
        anchor: { snapshotId: this.snapshotId, from: 0, to: snapshot.markdown.length }, offsetEncoding: 'utf-16' }
      if (args.version !== this.version || args.snapshotId !== this.snapshotId) throw new Error('staleVersion')
      if (this.proposals.size >= 32) throw new Error('proposalLimit')
      const proposalId = crypto.randomUUID()
      const proposal = args.proposal as AgentProposal
      // Shared deterministic validation protects the host even if a caller bypasses MCP schemas.
      reviewProposal(snapshot, proposal, proposalId)
      const edit = this.host.receive(snapshot, proposal, proposalId)
      this.proposals.add(proposalId)
      return { proposalId, status: edit.status }
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : ''
      const known = ['authorizationRevoked', 'documentTooLarge', 'invalidRequest', 'wrongDocument', 'unknownProposal', 'staleVersion', 'proposalLimit']
      return { error: known.includes(code) ? code : 'invalidProposal' }
    }
  }
}
