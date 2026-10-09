import { describe, expect, it } from 'vitest'
import { ExternalDocumentSession, type ExternalBuffer, type ExternalRequest } from '../../src/services/agent-external'
import { reviewProposal, type ReviewedEdit } from '../../src/services/agent'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline'

function fixture(markdown = 'same\nsame') {
  const buffer: ExternalBuffer = { snapshot: { tabId: 'tab', name: 'Untitled', markdown, from: 0, to: markdown.length }, selection: { from: 5, to: 9 } }
  const reviews = new Map<string, ReviewedEdit>()
  const session = new ExternalDocumentSession('document', { read: () => buffer,
    receive: (snapshot, proposal, id) => { const edit = reviewProposal(snapshot, proposal, id); reviews.set(id, edit); return edit }, review: id => reviews.get(id) })
  const call = (method: string, args: Record<string, unknown> = {}) => session.handle({ id: 'request', method, arguments: args }) as Record<string, unknown>
  return { session, buffer, reviews, call }
}
function proposalArgs(read: Record<string, unknown>) {
  return { documentId: read.documentId, version: read.version, snapshotId: read.snapshotId,
    proposal: { title: 'Second occurrence', changes: [{ oldText: 'same', newText: 'changed', anchor: { snapshotId: read.snapshotId, from: 5, to: 9 } }] } }
}

describe('external document grant', () => {
  it('reads the unsaved buffer and selection; anchored proposal reaches review without applying', () => {
    const { call, buffer, reviews } = fixture()
    const read = call('read_document')
    expect(read.markdown).toBe('same\nsame')
    expect(read.selection).toEqual({ from: 5, to: 9 })
    const submitted = call('propose_edit', proposalArgs(read))
    expect(submitted.status).toBe('pending')
    expect(reviews.get(submitted.proposalId as string)?.changes[0]?.from).toBe(5)
    expect(buffer.snapshot.markdown).toBe('same\nsame')
  })
  it('rejects edit/undo versions, cross-document requests, arbitrary fields and revoked access', () => {
    const { call, session, buffer } = fixture()
    const original = call('read_document')
    session.invalidate(); buffer.snapshot.markdown = 'other'; session.invalidate(); buffer.snapshot.markdown = 'same\nsame'
    expect(call('propose_edit', proposalArgs(original))).toEqual({ error: 'staleVersion' })
    expect(call('read_document', { documentId: 'other' })).toEqual({ error: 'wrongDocument' })
    expect(call('read_document', { path: '/etc/passwd' })).toEqual({ error: 'invalidRequest' })
    session.revoke()
    expect(call('read_document')).toEqual({ error: 'authorizationRevoked' })
  })
  it('tracks selection changes and rejects out-of-bounds or overlapping anchors', () => {
    const { call, buffer } = fixture()
    const original = call('read_document')
    buffer.selection = { from: 0, to: 4 }
    expect(call('propose_edit', proposalArgs(original))).toEqual({ error: 'staleVersion' })
    const read = call('read_document'), args = proposalArgs(read)
    args.proposal.changes[0]!.anchor.to = 99
    expect(call('propose_edit', args)).toEqual({ error: 'invalidProposal' })
    args.proposal.changes[0]!.anchor.to = 9
    args.proposal.changes.push({ ...args.proposal.changes[0]! })
    expect(call('propose_edit', args)).toEqual({ error: 'invalidProposal' })
  })
  it('reports applied/dismissed/reverted and unverified outcomes, including rebased cards', () => {
    const { call, reviews } = fixture()
    const submitted = call('propose_edit', proposalArgs(call('read_document'))), id = submitted.proposalId as string
    const edit = reviews.get(id)!, change = edit.changes[0]!
    const feedback = () => call('get_review_result', { documentId: 'document', proposalId: id })
    change.status = 'applied'; edit.status = 'applied'
    expect(feedback().status).toBe('applied')
    edit.documentChanged = true
    expect(feedback()).toMatchObject({ status: 'unverified', changes: [{ reviewStatus: 'applied' }] })
    change.status = 'pending'; edit.status = 'pending'; edit.rebasedTo = 'new-card'
    reviews.set('new-card', { ...edit, documentChanged: false, rebasedTo: undefined, status: 'dismissed', changes: [{ ...change, id: 'new:1', sourceChangeIds: [change.id], status: 'dismissed' }] })
    expect(feedback()).toMatchObject({ status: 'dismissed', rebased: true, changes: [{ id: change.id, reviewChangeId: 'new:1' }] })
    reviews.get('new-card')!.changes[0]!.status = 'reverted'
    expect(feedback().status).toBe('reverted')
    const second = reviews.get('new-card')!
    second.rebasedTo = 'third-card'; second.rebaseConflicts = ['new:1']
    reviews.set('third-card', { ...second, rebasedTo: undefined, changes: [{ ...change, id: 'third:1', sourceChangeIds: [change.id, 'new:1'], status: 'applied' }] })
    expect(feedback()).toMatchObject({ status: 'applied', changes: [{ id: change.id, reviewChangeId: 'third:1', conflict: true }] })
  })
})

describe('real stdio MCP adapter', () => {
  it('negotiates MCP and relays read, proposal, review and revoked errors over loopback', async () => {
    const { session } = fixture()
    const token = 'a'.repeat(64)
    const server = net.createServer(socket => {
      let wire = ''
      socket.on('data', chunk => {
        wire += chunk.toString()
        if (!wire.includes('\n')) return
        const request = JSON.parse(wire.slice(0, wire.indexOf('\n')))
        expect(request.token).toBe(token)
        const result = session.handle({ id: 'bridge', method: request.method, arguments: request.arguments } as ExternalRequest)
        socket.end(JSON.stringify(result) + '\n')
      })
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const port = (server.address() as net.AddressInfo).port
    const child = spawn(process.execPath, [resolve('scripts/markcaptain-mcp.mjs')], { env: { ...process.env, MARKCAPTAIN_MCP_PORT: String(port), MARKCAPTAIN_MCP_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] })
    const lines = createInterface({ input: child.stdout })
    const iterator = lines[Symbol.asyncIterator]()
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk.toString() })
    const send = async (id: number, method: string, params?: unknown) => {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n')
      return JSON.parse((await iterator.next()).value!)
    }
    try {
      expect((await send(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).result.protocolVersion).toBe('2025-11-25')
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
      expect((await send(2, 'tools/list')).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['read_document', 'propose_edit', 'get_review_result'])
      const read = (await send(3, 'tools/call', { name: 'read_document', arguments: {} })).result.structuredContent
      expect(read.markdown).toBe('same\nsame')
      const submitted = (await send(4, 'tools/call', { name: 'propose_edit', arguments: proposalArgs(read) })).result.structuredContent
      expect(submitted.status).toBe('pending')
      expect((await send(5, 'tools/call', { name: 'get_review_result', arguments: { documentId: 'document', proposalId: submitted.proposalId } })).result.structuredContent.status).toBe('pending')
      session.revoke()
      expect((await send(6, 'tools/call', { name: 'read_document', arguments: {} })).result).toMatchObject({ isError: true, structuredContent: { error: 'authorizationRevoked' } })
      expect(stderr).toBe('')
    } finally {
      lines.close(); child.kill(); server.close()
    }
  }, 15_000)
})
