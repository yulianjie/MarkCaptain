import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { packHistory, hydrateHistory, exportHistory, type HistoryChat } from '../../src/services/agent-history'
import { createChapterSummary, finishSummaryJob } from '../../src/services/agent-summary'
import { reviewFeedback, reviewProposal, reviewSource, type AgentEvent } from '../../src/services/agent'

const transport = vi.hoisted(() => ({ start: vi.fn(), cancel: vi.fn(), listen: vi.fn(), historySettings: vi.fn(), historySetEnabled: vi.fn(), historyList: vi.fn(), historyRead: vi.fn(), historyWrite: vi.fn(), historyDelete: vi.fn() }))
const files = vi.hoisted(() => ({ openFiles: vi.fn(), readMarkdown: vi.fn(), saveMarkdown: vi.fn(), saveAsDialog: vi.fn(), renameFile: vi.fn() }))
vi.mock('@/services/agent-transport', () => ({ agentTransport: transport }))
vi.mock('@/services/tauri-invoke', () => files)
vi.mock('element-plus', () => ({ ElMessageBox: { confirm: vi.fn() }, ElNotification: vi.fn() }))
import { useAgentStore } from '../../src/stores/agent'
import { useEditorStore } from '../../src/stores/editor'
import { usePreferencesStore } from '../../src/stores/preferences'
let emit: (event: AgentEvent) => void
beforeEach(() => {
  setActivePinia(createPinia()); vi.clearAllMocks()
  transport.listen.mockImplementation(async handler => { emit = handler; return () => {} })
  transport.start.mockResolvedValue(undefined)
  transport.historySettings.mockResolvedValue({ enabled: false }); transport.historyList.mockResolvedValue([])
  transport.historySetEnabled.mockImplementation(async enabled => ({ enabled }))
  transport.historyWrite.mockImplementation(async record => ({ ...record, revision: record.revision + 1 }))
  usePreferencesStore().autoSave = false
})
const snapshot = { tabId: 'tab', name: 'note.md', markdown: '# Header\nhello world', from: 0, to: 20 }
const metadata = () => ({ id: crypto.randomUUID(), revision: 0, title: 'Test history', createdAt: 1, updatedAt: 2 })
const blank = (): HistoryChat => ({ messages: [], references: [], draft: '', includeDocument: true, referenceDocument: false, selection: null, skillId: '' })

describe('Local transcript snapshots', () => {
  it('deduplicates document bodies across citations and omits images explicitly', () => {
    const chat = blank()
    const source = reviewSource(snapshot, { label: 'Greeting', startLine: 2, endLine: 2, quote: 'hello world' })
    chat.messages.push({ id: 'u', role: 'user', content: 'hello', tools: [], contextSnapshot: snapshot, images: [{ name: 'picture', dataUrl: 'SECRET_IMAGE_BYTES' }] },
      { id: 'a', role: 'assistant', content: 'answer', tools: [], sources: [source] })
    const packed = packHistory(metadata(), chat, snapshot)
    expect(packed.data.snapshots).toHaveLength(1)
    expect(JSON.stringify(packed)).not.toContain('SECRET_IMAGE_BYTES')
    const restored = hydrateHistory(packed)
    expect(restored.chat.messages[0]?.imagesOmitted).toBe(true)
    expect(restored.chat.messages[1]?.sources?.[0]?.snapshot).toEqual(source.snapshot)
    expect(exportHistory(packed)).toContain('Images were not saved')
  })
  it('interns identical text once while preserving each request version and anchor', () => {
    const chat = blank()
    for (const snapshotId of ['first-request', 'second-request']) {
      const versioned = { ...snapshot, snapshotId }
      const edit = reviewProposal(versioned, { title: 'Greeting', changes: [{ oldText: 'hello', newText: 'Hello',
        anchor: { snapshotId, from: 9, to: 14 } }] }, snapshotId)
      chat.messages.push({ id: `${snapshotId}-user`, role: 'user', content: 'polish', tools: [], contextSnapshot: versioned },
        { id: snapshotId, role: 'assistant', content: '', tools: [], edit })
    }
    const record = packHistory(metadata(), chat, snapshot)
    expect(record.data.snapshots).toHaveLength(1)
    expect(record.data.snapshots[0]!.snapshotId).toBeUndefined()
    const restored = hydrateHistory(record).chat.messages
    for (const [i, snapshotId] of ['first-request', 'second-request'].entries()) {
      expect(restored[i * 2]!.contextSnapshot!.snapshotId).toBe(snapshotId)
      expect(restored[i * 2 + 1]!.edit!.snapshot.snapshotId).toBe(snapshotId)
      expect(restored[i * 2 + 1]!.edit!.changes[0]!.anchor!.snapshotId).toBe(snapshotId)
    }
    for (const invalidId of ['', null, 42, 'x'.repeat(161)]) {
      const corrupt = JSON.parse(JSON.stringify(record))
      corrupt.data.chat.messages[0].contextSnapshot.snapshotId = invalidId
      expect(() => hydrateHistory(corrupt)).toThrow('agent:historyInvalid')
    }
  })
  it('accepts legacy snapshots with their version stored on the interned document', () => {
    const chat = blank(), snapshotId = 'legacy-request'
    const versioned = { ...snapshot, snapshotId }
    const edit = reviewProposal(versioned, { title: 'Greeting', changes: [{ oldText: 'hello', newText: 'Hello',
      anchor: { snapshotId, from: 9, to: 14 } }] })
    chat.messages.push({ id: 'legacy', role: 'assistant', content: '', tools: [], edit })
    const legacy = JSON.parse(JSON.stringify(packHistory(metadata(), chat, versioned)))
    legacy.data.snapshots[0].snapshotId = snapshotId
    delete legacy.data.chat.messages[0].edit.snapshot.snapshotId
    delete legacy.data.document.snapshotId
    const restored = hydrateHistory(legacy)
    expect(restored.document!.snapshotId).toBe(snapshotId)
    expect(restored.chat.messages[0]!.edit!.snapshot.snapshotId).toBe(snapshotId)
    expect(restored.chat.messages[0]!.edit!.changes[0]!.anchor!.snapshotId).toBe(snapshotId)
  })
  it('rebuilds a bounded summary graph, preserves completed work and locks historical edits', () => {
    const chat = blank(), summary = createChapterSummary(snapshot)
    finishSummaryJob(summary, 0, 'partial notes')
    const edit = reviewProposal(snapshot, { title: 'Greeting', changes: [{ oldText: 'hello', newText: 'Hello' }] })
    edit.changes[0]!.status = 'applied'; edit.status = 'applied'
    chat.messages.push({ id: 'a', role: 'assistant', content: '', tools: [], summary, edit })
    const record = packHistory(metadata(), chat, snapshot)
    const restored = hydrateHistory(record).chat.messages[0]!
    expect(restored.summary?.jobs[0]?.result).toBe('partial notes')
    expect(restored.summary?.status).toBe('cancelled')
    expect(restored.edit?.locked).toBe(true)
    expect(restored.edit?.status).toBe('applied')
    const corrupt = JSON.parse(JSON.stringify(record))
    corrupt.data.chat.messages[0].summary.jobs[1].inputs = [1]
    expect(() => hydrateHistory(corrupt)).toThrow('agent:historyInvalid')
  })
  it('does not write when disabled and serializes revisions before new chat', async () => {
    const editor = useEditorStore(), agent = useAgentStore()
    editor.newUntitledTab('original')
    await agent.send('hello'); emit({ requestId: agent.run!.id, kind: 'done' })
    await agent.flushHistory(); expect(transport.historyWrite).not.toHaveBeenCalled()
    await agent.setHistoryEnabled(true)
    const old = agent.conversation.id
    await agent.flushHistory(); await agent.clear()
    expect(agent.conversation.id).not.toBe(old)
    const revisions = transport.historyWrite.mock.calls.map(call => call[0].revision)
    expect(revisions).toEqual(revisions.map((_, index) => index))
    expect(transport.historyWrite.mock.calls.at(-1)?.[0].id).toBe(old)
    agent.$dispose()
  })
  it('retains review IDs and reasons and migrates legacy item IDs deterministically', () => {
    const chat = blank()
    const edit = reviewProposal(snapshot, { title: 'Greeting', oldText: 'hello', newText: 'Hello' }, 'a')
    edit.changes[0]!.status = 'dismissed'; edit.changes[0]!.reason = 'Keep my voice'
    chat.messages.push({ id: 'a', role: 'assistant', content: '', tools: [], edit })
    const record = packHistory(metadata(), chat, snapshot)
    const restored = hydrateHistory(record).chat.messages[0]!.edit!
    expect(restored.changes[0]).toMatchObject({ id: 'a:1', status: 'dismissed', reason: 'Keep my voice' })
    const legacy = JSON.parse(JSON.stringify(record))
    delete legacy.data.chat.messages[0].edit.changes[0].id
    expect(hydrateHistory(legacy).chat.messages[0]!.edit!.changes[0]!.id).toBe('a:1')
    legacy.data.chat.messages[0].edit.changes[0].reason = 'x'.repeat(1001)
    expect(() => hydrateHistory(legacy)).toThrow('agent:historyInvalid')
  })
  it('retains bounded relocation ancestry and superseded feedback when restoring history', () => {
    const chat = blank()
    const edit = reviewProposal(snapshot, { title: 'Greeting', oldText: 'hello', newText: 'Hello' }, 'a')
    edit.rebasedFrom = 'old:1'; edit.rebasedTo = 'new-card'; edit.rebaseConflicts = ['conflict:1']
    edit.changes[0]!.sourceChangeIds = ['root:1', 'old:1']
    chat.messages.push({ id: 'a', role: 'assistant', content: '', tools: [], edit })
    const record = packHistory(metadata(), chat, snapshot)
    const restored = hydrateHistory(record).chat.messages[0]!.edit!
    expect(restored).toMatchObject({ rebasedFrom: 'old:1', rebasedTo: 'new-card', rebaseConflicts: ['conflict:1'], locked: true })
    expect(restored.changes[0]!.sourceChangeIds).toEqual(['root:1', 'old:1'])
    expect(JSON.parse(reviewFeedback(restored).split('[User review feedback]\n')[1]!).changes[0].status).toBe('superseded')
    const corrupt = JSON.parse(JSON.stringify(record))
    corrupt.data.chat.messages[0].edit.changes[0].sourceChangeIds = ['duplicate', 'duplicate']
    expect(() => hydrateHistory(corrupt)).toThrow('agent:historyInvalid')
    corrupt.data.chat.messages[0].edit.changes[0].sourceChangeIds = Array.from({ length: 65 }, (_, i) => `old:${i}`)
    expect(() => hydrateHistory(corrupt)).toThrow('agent:historyInvalid')
  })
  it('restores changed documents into independent tabs, never replacing unsaved text', async () => {
    const editor = useEditorStore(), agent = useAgentStore(), tab = editor.newUntitledTab('live unsaved')
    tab.pathname = 'C:\\notes\\test.md'
    const chat = blank(); chat.messages.push({ id: 'a', role: 'assistant', content: 'historical', tools: [] })
    transport.historyRead.mockResolvedValue(packHistory(metadata(), chat, { ...snapshot, tabId: tab.id, path: tab.pathname }))
    await agent.restoreHistory('record')
    expect(tab.markdown).toBe('live unsaved')
    expect(editor.tabs).toHaveLength(2)
    expect(editor.currentFile?.markdown).toBe(snapshot.markdown)
    expect(agent.conversation.restored).toBe(true)
    agent.$dispose()
  })
})

describe('Read-only manual reference documents', () => {
  it('uses unsaved buffers and captures source/retry reference snapshots independently of later choices', async () => {
    const editor = useEditorStore(), agent = useAgentStore()
    const reference = editor.newUntitledTab('unsaved reference')
    const target = editor.newUntitledTab('target')
    agent.addReferenceTab(reference.id); agent.includeDocument = false
    await agent.send('compare')
    const request = transport.start.mock.calls[0]![0]
    expect(request.context).toBeNull(); expect(request.references[0].markdown).toBe('unsaved reference')
    emit({ requestId: agent.run!.id, kind: 'source', text: JSON.stringify({ documentId: request.references[0].documentId, label: 'Reference', startLine: 1, endLine: 1, quote: 'unsaved reference' }) })
    expect(agent.conversation.messages.at(-1)?.sources?.[0]?.snapshot.tabId).toBe(reference.id)
    emit({ requestId: agent.run!.id, kind: 'error', text: 'agent:network' })
    agent.conversation.references = []; reference.markdown = 'changed'
    agent.retry(); await new Promise(resolve => setTimeout(resolve, 0))
    expect(transport.start.mock.calls[1]?.[0].references).toEqual(request.references)
    expect(target.markdown).toBe('target')
    agent.$dispose()
  })
  it('does not attach picker results after switching or clearing, and prefers case-equivalent open paths', async () => {
    const editor = useEditorStore(), agent = useAgentStore()
    const reference = editor.newUntitledTab('live buffer'); reference.pathname = 'C:\\Notes\\Ref.md'
    const target = editor.newUntitledTab('target')
    files.openFiles.mockResolvedValue(['c:/notes/ref.md'])
    await agent.chooseReferences()
    expect(files.readMarkdown).not.toHaveBeenCalled()
    expect(agent.conversation.references[0]?.snapshot.markdown).toBe('live buffer')
    let resolve!: (paths: string[]) => void
    files.openFiles.mockReturnValue(new Promise<string[]>(done => { resolve = done }))
    const pending = agent.chooseReferences()
    await agent.clear(); resolve(['c:/notes/ref.md']); await pending
    expect(agent.conversation.references).toEqual([])
    editor.setCurrent(target.id)
    agent.$dispose()
  })
})
