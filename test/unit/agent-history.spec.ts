import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { packHistory, hydrateHistory, exportHistory, type HistoryChat } from '../../src/services/agent-history'
import { createChapterSummary, finishSummaryJob } from '../../src/services/agent-summary'
import { reviewedMarkdown, reviewFeedback, reviewProposal, reviewSource, type AgentEvent } from '../../src/services/agent'
import { createAgentTaskContext } from '../../src/services/agent-context'

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

function archiveEdit(edit: ReturnType<typeof reviewProposal>, documentMarkdown = edit.snapshot.markdown) {
  const chat = blank()
  chat.includeDocument = true; chat.referenceDocument = true; chat.selection = edit.snapshot
  chat.references.push({ documentId: crypto.randomUUID(), snapshot: edit.snapshot })
  chat.messages.push({ id: 'request-message', role: 'user', content: 'Please revise this document', tools: [], contextSnapshot: edit.snapshot },
    { id: 'archived-message', role: 'assistant', content: 'Review proposal', tools: [], edit })
  return packHistory(metadata(), chat, { tabId: edit.snapshot.tabId, name: edit.snapshot.name, markdown: documentMarkdown,
    from: 0, to: documentMarkdown.length, path: edit.snapshot.path })
}

function archivedReview(statuses: Array<'pending' | 'applied' | 'dismissed' | 'reverted'>, markdown = 'opening\n\naccepted item\n\ndismissed item\n\nreverted item\n\npending item') {
  const values = ['accepted item', 'dismissed item', 'reverted item', 'pending item']
  const edit = reviewProposal({ tabId: 'archived-tab', name: 'note.md', markdown, from: 0, to: markdown.length, path: 'C:\\notes\\note.md' }, {
    title: 'Archived review', changes: values.map(value => ({ oldText: value, newText: value.toUpperCase() })),
  }, 'archived-message')
  edit.changes.forEach((change, index) => { change.status = statuses[index]! })
  const applied = reviewedMarkdown(edit, statuses.flatMap((status, index) => status === 'applied' ? [index] : []))
  edit.appliedMarkdown = applied
  edit.status = new Set(statuses).size === 1 ? statuses[0]! : 'partial'
  return { record: archiveEdit(edit, applied), edit, applied }
}

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
  it('round-trips bounded project read receipts beyond the manual attachment limit and omits retrieval snippets', () => {
    const chat = blank()
    const manual = Array.from({ length: 8 }, (_, index) => ({
      documentId: crypto.randomUUID(),
      snapshot: { tabId: `manual-${index}`, name: `manual-${index}.md`, markdown: `Manual source ${index}`, from: 0,
        to: `Manual source ${index}`.length, path: `C:\\manual\\${index}.md` },
    }))
    const grant = crypto.randomUUID()
    const project = Array.from({ length: 12 }, (_, index) => {
      const documentId = `project-${grant}-${crypto.randomUUID()}`
      const markdown = 'Shared project evidence.'
      return { documentId, snapshot: { tabId: `project-${documentId}`, name: `docs/${index}.md`, markdown, from: 0,
        to: markdown.length, path: `C:\\project\\docs\\${index}.md` } }
    })
    chat.references.push(...manual)
    const messageReferences = [...manual, ...project]
    const privateSnippet = 'PROJECT_SEARCH_EXCERPT_MUST_NOT_BE_ARCHIVED'
    const candidates = [{ documentId: 'candidate', path: 'docs/candidate.md', title: 'Candidate', snippet: privateSnippet, line: 4 }]
    const firstRead = Object.assign({ id: 'read-one', role: 'assistant' as const, content: 'Read project sources', tools: [], references: messageReferences,
      projectSearchResults: candidates, projectSearchComplete: false }, { projectCandidates: candidates, projectCompleteness: { complete: false } })
    chat.messages.push(
      firstRead,
      { id: 'read-two', role: 'assistant', content: 'Repeated source receipt', tools: [], references: messageReferences },
    )

    const record = packHistory(metadata(), chat, snapshot)
    const serialized = JSON.stringify(record)
    expect(serialized).not.toContain(privateSnippet)
    expect(serialized).not.toContain('projectSearchResults')
    expect(serialized).not.toContain('projectCandidates')
    expect(serialized).not.toContain('projectCompleteness')
    expect(record.data.snapshots).toHaveLength(1 + manual.length + project.length)
    const restored = hydrateHistory(record)
    expect(restored.chat.references).toHaveLength(8)
    expect(restored.chat.messages[0]!.references).toHaveLength(20)
    expect(restored.chat.messages[0]!.references!.filter(reference => reference.documentId.startsWith('project-'))).toHaveLength(12)
    expect(restored.chat.messages[0]!.projectSearchResults).toBeUndefined()
    expect(restored.chat.messages[0]!.projectSearchComplete).toBeUndefined()
    expect((restored.chat.messages[0] as unknown as Record<string, unknown>).projectCandidates).toBeUndefined()
    expect(restored.chat.messages[0]!.references![8]!.snapshot.markdown).toBe('Shared project evidence.')
    expect(restored.chat.messages[0]!.references![8]!.snapshot.path).toBeUndefined() // A read receipt cannot reopen the old project path.

    const tooManyAttached = blank()
    tooManyAttached.references.push(...Array.from({ length: 9 }, (_, index) => ({ documentId: crypto.randomUUID(), snapshot: { ...snapshot, tabId: `too-many-${index}` } })))
    expect(() => packHistory(metadata(), tooManyAttached, null)).toThrow('agent:referenceLimit')

    const tooManyHistorical = JSON.parse(JSON.stringify(record))
    const template = tooManyHistorical.data.chat.messages[0].references[0]
    tooManyHistorical.data.chat.messages[0].references = Array.from({ length: 41 }, () => ({ documentId: crypto.randomUUID(), snapshot: template.snapshot }))
    expect(() => hydrateHistory(tooManyHistorical)).toThrow('agent:historyInvalid')
  })
  it('stores web source cards as validated metadata without excerpt or error text', () => {
    const chat = blank()
    chat.messages.push({ id: 'web', role: 'assistant', content: 'Research complete', tools: [], webSources: [
      { sourceId: 'source-1', title: 'Public article', url: 'https://example.com/article', fetchedAt: '2026-10-22T00:00:00.000Z',
        publishedAt: '2026-10-01', excerpt: 'PRIVATE_WEB_EXCERPT_BODY', status: 'read', error: 'PRIVATE_WEB_ERROR' },
      { sourceId: 'source-private', title: 'Local target', url: 'http://127.0.0.1/private', fetchedAt: '2026-10-22T00:00:00.000Z',
        excerpt: 'PRIVATE_LOCAL_BODY', status: 'read' },
    ] })
    const record = packHistory(metadata(), chat, null)
    const serialized = JSON.stringify(record)
    expect(serialized).not.toContain('PRIVATE_WEB_EXCERPT_BODY')
    expect(serialized).not.toContain('PRIVATE_WEB_ERROR')
    expect(serialized).not.toContain('PRIVATE_LOCAL_BODY')
    expect(serialized).not.toContain('http://127.0.0.1')
    expect(serialized).not.toContain('"excerpt"')
    expect(hydrateHistory(record).chat.messages[0]!.webSources).toEqual([{
      sourceId: 'source-1', title: 'Public article', url: 'https://example.com/article', fetchedAt: '2026-10-22T00:00:00.000Z',
      publishedAt: '2026-10-01', status: 'read', excerpt: '',
    }])
  })
  it('does not write a history record that exceeds the 512 interned snapshot cap', () => {
    const chat = blank()
    for (let messageIndex = 0; messageIndex < 17; messageIndex += 1) {
      const sources = Array.from({ length: 32 }, (_, sourceIndex) => {
        const markdown = `Distinct source ${messageIndex}:${sourceIndex}`
        return { label: 'Source', startLine: 1, endLine: 1, quote: markdown,
          snapshot: { tabId: `source-${messageIndex}-${sourceIndex}`, name: `${messageIndex}-${sourceIndex}.md`, markdown, from: 0,
            to: markdown.length, path: `C:\\source\\${messageIndex}-${sourceIndex}.md` } }
      })
      chat.messages.push({ id: `sources-${messageIndex}`, role: 'assistant', content: '', tools: [], sources })
    }
    expect(() => packHistory(metadata(), chat, null)).toThrow('agent:historyLimit')
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
  it('preserves visible context reads and task identity but never resumes an in-flight task', () => {
    const chat = blank()
    const task = createAgentTaskContext({ taskId: 'task', paneId: 'pane', attached: { ...snapshot, snapshotId: 'task' }, reading: snapshot, references: [],
      config: { baseUrl: 'https://api.example.test/v1', model: 'model-a', hasKey: true, hasHeaders: false } })
    task.status = 'reading'
    chat.messages.push({ id: 'task', role: 'assistant', content: '', tools: [], task, contextReads: [{ id: 'task:0', tool: 'read_document', kind: 'range', documentId: 'tab', documentName: 'note.md', startLine: 2, endLine: 2, totalChars: 11, excerpt: 'hello world', truncated: false }] })
    const record = packHistory(metadata(), chat, snapshot)
    const restored = hydrateHistory(record).chat.messages[0]!
    expect(restored.task).toMatchObject({ taskId: 'task', paneId: 'pane', documentId: 'tab', status: 'interrupted', endpoint: 'api.example.test' })
    expect(restored.contextReads).toMatchObject([{ documentId: 'tab', excerpt: 'hello world', startLine: 2 }])
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
  it('restores a mixed review read-only, revalidates only pending changes against a chosen live file, then reports undo', async () => {
    const { record, applied } = archivedReview(['applied', 'dismissed', 'reverted', 'pending'])
    transport.historySettings.mockResolvedValue({ enabled: true })
    transport.historyRead.mockResolvedValue(record)
    files.openFiles.mockResolvedValue(['C:\\notes\\note.md'])
    files.readMarkdown.mockResolvedValue({ path: 'C:\\notes\\note.md', markdown: applied, encoding: 'utf-8', lineEnding: 'lf', hadDecodeErrors: false, bom: false })
    const editor = useEditorStore(), agent = useAgentStore()

    await agent.restoreHistory(record.id)
    expect(agent.historyError).toBe('')
    const archivedTab = editor.currentFile!
    const archivedMessage = agent.conversation.messages.find(message => message.id === 'archived-message')!
    expect(archivedTab.pathname).toBe('') // The history snapshot is not treated as a disk-validated document.
    expect(archivedTab.markdown).toBe(applied) // Restore does not replay any pending proposal.
    expect(archivedMessage.edit).toMatchObject({ locked: true, status: 'partial' })
    expect(archivedMessage.edit!.changes.map(change => change.status)).toEqual(['applied', 'dismissed', 'reverted', 'pending'])
    expect(agent.includeDocument).toBe(false)
    expect(agent.referenceDocument).toBe(false)
    expect(agent.conversation.references).toEqual([])
    expect(agent.selection).toBeNull()

    expect(await agent.revalidateHistoryReview('archived-message')).toBe(true)
    const target = editor.currentFile!
    const oldEdit = agent.conversation.messages.find(message => message.id === 'archived-message')!.edit!
    const newCard = agent.conversation.messages.at(-1)!
    const newEdit = newCard.edit!
    expect(target.pathname).toBe('C:\\notes\\note.md')
    expect(target.markdown).toBe(applied)
    expect(oldEdit).toMatchObject({ locked: true, rebasedTo: newCard.id })
    expect(oldEdit.changes.map(change => change.status)).toEqual(['applied', 'dismissed', 'reverted', 'pending'])
    expect(newEdit.changes).toHaveLength(1)
    expect(newEdit.changes[0]).toMatchObject({ status: 'pending', oldText: 'pending item', sourceChangeIds: ['archived-message:4'] })
    expect(newEdit.changes[0]!.id).not.toBe('archived-message:4')
    expect(newEdit.rebasedFrom).toBe('archived-message')
    expect(target.markdown).toBe(applied) // Revalidation creates a card; it never applies it.
    expect(transport.historyWrite).toHaveBeenCalled()

    editor.registerAgentEditHandler('wysiwyg', text => editor.setMarkdownExternal(target.id, text))
    agent.apply(newEdit)
    expect(target.markdown).toContain('PENDING ITEM')
    editor.setMarkdownExternal(target.id, applied) // Simulate Undo after applying the restored pending card.
    expect(newEdit.changes[0]!.status).toBe('reverted')
    await agent.send('Continue after undo')
    const message = [...transport.start.mock.calls.at(-1)![0].messages].reverse().find(item => item.content.includes('[User review feedback]'))!
    const feedback = JSON.parse(message.content.split('[User review feedback]\n')[1]!)
    expect(feedback.changes.find((change: { id: string }) => change.id === newEdit.changes[0]!.id).status).toBe('reverted')
    emit({ requestId: agent.run!.id, kind: 'done' })
    await agent.flushHistory()
    const saved = transport.historyWrite.mock.calls.at(-1)![0]
    const savedMessages = hydrateHistory(saved).chat.messages
    expect(savedMessages.find(item => item.id === 'archived-message')!.edit!.changes.map(change => change.status)).toEqual(['applied', 'dismissed', 'reverted', 'pending'])
    expect(savedMessages.find(item => item.id === newCard.id)!.edit!.changes[0]!.status).toBe('reverted')
    agent.$dispose()
  })
  it('leaves ambiguous duplicate targets and externally changed paragraphs read-only with an explanation', async () => {
    for (const current of ['opening\n\nchanged target\n\ntail', 'opening\n\nsame\n\ninserted\n\nsame\n\ntail']) {
      setActivePinia(createPinia()); vi.clearAllMocks()
      transport.listen.mockImplementation(async handler => { emit = handler; return () => {} })
      transport.historySettings.mockResolvedValue({ enabled: true })
      transport.historyList.mockResolvedValue([])
      transport.historyWrite.mockImplementation(async record => ({ ...record, revision: record.revision + 1 }))
      files.openFiles.mockResolvedValue(['C:\\notes\\note.md'])
      files.readMarkdown.mockResolvedValue({ path: 'C:\\notes\\note.md', markdown: current, encoding: 'utf-8', lineEnding: 'lf', hadDecodeErrors: false, bom: false })
      const base = current.includes('same') ? 'opening\n\nsame\n\ntail' : 'opening\n\ntarget\n\ntail'
      const targetText = base.includes('same') ? 'same' : 'target'
      const edit = reviewProposal({ tabId: 'archived-tab', name: 'note.md', markdown: base, from: 0, to: base.length, path: 'C:\\notes\\note.md' },
        { title: 'Pending', oldText: targetText, newText: 'changed' }, 'ambiguous-card')
      const record = archiveEdit(edit, base)
      transport.historyRead.mockResolvedValue(record)
      const editor = useEditorStore(), agent = useAgentStore()
      await agent.restoreHistory(record.id)
      expect(agent.historyError).toBe('')
      expect(await agent.revalidateHistoryReview('archived-message')).toBe(false)
      expect(agent.conversation.messages.at(-1)!.edit!.changes[0]!.status).toBe('pending')
      expect(agent.conversation.messages.at(-1)!.edit!.rebasedTo).toBeUndefined()
      expect(agent.historyReviewError).toBeTruthy()
      expect(editor.currentFile!.pathname).toBe('')
      agent.$dispose()
    }
  })
  it('does not open a file, create a review card, or save a patch when local history is disabled', async () => {
    const { record } = archivedReview(['pending', 'pending', 'pending', 'pending'])
    transport.historySettings.mockResolvedValue({ enabled: false })
    transport.historyRead.mockResolvedValue(record)
    const agent = useAgentStore()
    await agent.restoreHistory(record.id)
    const messageCount = agent.conversation.messages.length
    expect(await agent.revalidateHistoryReview('archived-message')).toBe(false)
    expect(agent.conversation.messages).toHaveLength(messageCount)
    expect(files.openFiles).not.toHaveBeenCalled()
    expect(transport.historyWrite).not.toHaveBeenCalled()
    agent.$dispose()
  })
  it.each(['done', 'cancelled', 'error'] as const)('blocks sends during relink IO and receives %s after relinking', async terminal => {
    const { record, applied } = archivedReview(['pending', 'pending', 'pending', 'pending'])
    transport.historySettings.mockResolvedValue({ enabled: true }); transport.historyRead.mockResolvedValue(record)
    files.openFiles.mockResolvedValue(['C:\\notes\\note.md'])
    let finishRead!: (value: unknown) => void
    files.readMarkdown.mockImplementation(() => new Promise(resolve => { finishRead = resolve }))
    const editor = useEditorStore(), agent = useAgentStore()
    await agent.restoreHistory(record.id)
    const oldChat = agent.conversation
    const relinking = agent.revalidateHistoryReview('archived-message')
    await vi.waitFor(() => expect(files.readMarkdown).toHaveBeenCalled())
    await agent.send('Send while file is loading')
    expect(agent.run).toBeNull()
    expect(transport.start).not.toHaveBeenCalled()
    expect(oldChat.messages).toHaveLength(2)
    finishRead({ path: 'C:\\notes\\note.md', markdown: applied, encoding: 'utf-8', lineEnding: 'lf', hadDecodeErrors: false, bom: false })
    expect(await relinking).toBe(true)
    expect(agent.conversation).toBe(oldChat)
    await agent.send('Continue after relinking')
    const requestId = agent.run!.id
    expect(agent.run!.key).toBe(editor.currentFileId)
    emit({ requestId, kind: 'delta', text: 'model answer' })
    emit({ requestId, kind: terminal, ...(terminal === 'error' ? { text: 'agent:network' } : {}) })
    expect(agent.conversation.messages.at(-1)!.content).toBe('model answer')
    expect(agent.busy).toBe(false)
    agent.$dispose()
  })
  it('regenerates a relinked historical review with fresh document consent and no restored research grants', async () => {
    const { record, applied } = archivedReview(['pending', 'pending', 'pending', 'pending'])
    transport.historySettings.mockResolvedValue({ enabled: true }); transport.historyRead.mockResolvedValue(record)
    files.openFiles.mockResolvedValue(['C:\\notes\\note.md'])
    files.readMarkdown.mockResolvedValue({ path: 'C:\\notes\\note.md', markdown: applied, encoding: 'utf-8', lineEnding: 'lf', hadDecodeErrors: false, bom: false })
    const editor = useEditorStore(), agent = useAgentStore()
    await agent.restoreHistory(record.id)
    const archivedRequest = agent.conversation.messages[0]!
    const archivedSnapshot = { ...archivedRequest.contextSnapshot! }
    expect(await agent.revalidateHistoryReview('archived-message')).toBe(true)
    const card = agent.conversation.messages.at(-1)!
    editor.setMarkdownExternal(editor.currentFileId!, applied.replace('pending item', 'locally revised item'))
    expect(card.edit!.documentChanged).toBe(true)
    expect(agent.canRegenerateReview(card.edit!)).toBe(false)
    await agent.regenerateReview(card.edit!)
    expect(transport.start).not.toHaveBeenCalled()
    expect(agent.conversation.projectAccess.grantId).toBeNull()
    expect(agent.conversation.webResearch.enabled).toBe(false)
    expect(agent.conversation.references).toEqual([])
    agent.includeDocument = true
    expect(agent.canRegenerateReview(card.edit!)).toBe(true)
    await agent.regenerateReview(card.edit!)
    const request = transport.start.mock.calls.at(-1)![0]
    expect(request.context.markdown).toBe(editor.currentFile!.markdown)
    expect(request.messages.at(-1).content).toContain(archivedRequest.content)
    expect(request.projectSearch).toBeUndefined()
    expect(request.webResearch).toBeUndefined()
    expect(request.references).toEqual([])
    expect(archivedRequest.contextSnapshot).toEqual(archivedSnapshot)
    expect(agent.conversation.messages.find(message => message.id === 'archived-message')!.edit!.locked).toBe(true)
    emit({ requestId: agent.run!.id, kind: 'done' })
    await agent.flushHistory()
    expect(hydrateHistory(transport.historyWrite.mock.calls.at(-1)![0]).chat.messages.find(message => message.id === card.id)!.regenerateFrom).toBe(archivedRequest.id)
    agent.$dispose()
  })
  it('does not migrate a session that acquires an active request during file IO', async () => {
    const { record, applied } = archivedReview(['pending', 'pending', 'pending', 'pending'])
    transport.historySettings.mockResolvedValue({ enabled: true }); transport.historyRead.mockResolvedValue(record)
    files.openFiles.mockResolvedValue(['C:\\notes\\note.md'])
    let finishRead!: (value: unknown) => void
    files.readMarkdown.mockImplementation(() => new Promise(resolve => { finishRead = resolve }))
    const editor = useEditorStore(), agent = useAgentStore()
    await agent.restoreHistory(record.id)
    // Initialize the real event listener, then simulate an independent request acquiring this session.
    await agent.send('Initialize listener')
    const request = { ...agent.run! }
    emit({ requestId: request.id, kind: 'done' })
    const oldChat = agent.conversation, oldKey = editor.currentFileId!
    const relinking = agent.revalidateHistoryReview('archived-message')
    await vi.waitFor(() => expect(files.readMarkdown).toHaveBeenCalled())
    agent.run = request
    finishRead({ path: 'C:\\notes\\note.md', markdown: applied, encoding: 'utf-8', lineEnding: 'lf', hadDecodeErrors: false, bom: false })
    expect(await relinking).toBe(false)
    emit({ requestId: request.id, kind: 'delta', text: 'still routed' })
    emit({ requestId: request.id, kind: 'done' })
    expect(agent.busy).toBe(false)
    editor.setCurrent(oldKey)
    expect(agent.conversation).toBe(oldChat)
    expect(oldChat.messages.at(-1)!.content).toBe('still routed')
    expect(oldChat.messages.find(message => message.id === 'archived-message')!.edit!.rebasedTo).toBeUndefined()
    agent.$dispose()
  })
  it('keeps relink regeneration inside the selected scope and requires reselection after that paragraph changes', async () => {
    const markdown = 'private prefix\n\nselected paragraph\n\nprivate suffix'
    const from = markdown.indexOf('selected paragraph'), to = from + 'selected paragraph'.length
    const edit = reviewProposal({ tabId: 'archived-tab', name: 'note.md', path: 'C:\\notes\\note.md', markdown, from, to },
      { title: 'Selected edit', oldText: 'selected paragraph', newText: 'Selected paragraph' }, 'archived-message')
    const record = archiveEdit(edit)
    transport.historySettings.mockResolvedValue({ enabled: true }); transport.historyRead.mockResolvedValue(record)
    files.openFiles.mockResolvedValue(['C:\\notes\\note.md'])
    files.readMarkdown.mockResolvedValue({ path: 'C:\\notes\\note.md', markdown, encoding: 'utf-8', lineEnding: 'lf', hadDecodeErrors: false, bom: false })
    const editor = useEditorStore(), agent = useAgentStore()
    await agent.restoreHistory(record.id)
    expect(await agent.revalidateHistoryReview('archived-message')).toBe(true)
    const card = agent.conversation.messages.at(-1)!
    agent.includeDocument = true
    await agent.regenerateReview(card.edit!)
    expect(transport.start.mock.calls.at(-1)![0].context.markdown).toBe('selected paragraph')
    emit({ requestId: agent.run!.id, kind: 'done' })
    const changed = markdown.replace('selected paragraph', 'locally changed paragraph')
    editor.setMarkdownExternal(editor.currentFileId!, changed)
    await agent.regenerateReview(card.edit!)
    expect(transport.start).toHaveBeenCalledTimes(1)
    expect(agent.error).toBeTruthy()
    agent.selection = { ...card.edit!.snapshot, markdown: changed, from, to: from + 'locally changed paragraph'.length }
    await agent.regenerateReview(card.edit!)
    expect(transport.start).toHaveBeenCalledTimes(2)
    expect(transport.start.mock.calls.at(-1)![0].context.markdown).toBe('locally changed paragraph')
    emit({ requestId: agent.run!.id, kind: 'done' })
    agent.$dispose()
  })
  it('restores project/web read receipts as history but never restores their access grants', async () => {
    const chat = blank()
    const projectId = `project-${crypto.randomUUID()}-${crypto.randomUUID()}`
    const projectMarkdown = 'Historical project evidence.'
    const projectRef = { documentId: projectId, snapshot: { tabId: `project-${projectId}`, name: 'docs/source.md', markdown: projectMarkdown,
      from: 0, to: projectMarkdown.length, path: 'C:\\project\\docs\\source.md' } }
    chat.references.push({ documentId: crypto.randomUUID(), snapshot })
    chat.messages.push({ id: 'read-receipt', role: 'assistant', content: 'Read source', tools: [], references: [projectRef],
      sources: [{ label: 'Project source', startLine: 1, endLine: 1, quote: projectMarkdown, snapshot: projectRef.snapshot }], webSources: [
      { sourceId: 'source-1', title: 'Article', url: 'https://example.com/article', fetchedAt: '2026-10-22T00:00:00.000Z', excerpt: 'discarded excerpt', status: 'snippet' },
    ] })
    const record = packHistory(metadata(), chat, snapshot)
    const rawChat = record.data.chat as Record<string, unknown>
    rawChat.projectAccess = { root: 'C:\\secret\\project', grantId: 'old-project-grant', include: ['**/*.md'], exclude: [], busy: false }
    rawChat.webResearch = { enabled: true, topic: 'old topic', allowDocumentQueries: true, approvedQueries: ['private query'], urls: ['https://example.com/private'] }
    rawChat.applyProjectWritingRules = true
    transport.historySettings.mockResolvedValue({ enabled: true })
    transport.historyRead.mockResolvedValue(record)
    const agent = useAgentStore()

    await agent.restoreHistory(record.id)
    expect(agent.conversation.messages[0]!.references).toHaveLength(1)
    expect(agent.conversation.messages[0]!.references![0]!.documentId).toBe(projectId)
    expect(agent.conversation.messages[0]!.references![0]!.snapshot.path).toBeUndefined()
    expect(agent.conversation.messages[0]!.sources![0]!.snapshot.path).toBeUndefined()
    expect(agent.conversation.messages[0]!.webSources?.[0]).toMatchObject({ title: 'Article', excerpt: '', status: 'snippet' })
    expect(agent.conversation.references).toEqual([])
    expect(agent.conversation.projectAccess).toMatchObject({ root: '', grantId: null, busy: false })
    expect(agent.conversation.webResearch).toMatchObject({ enabled: false, allowDocumentQueries: false, approvedQueries: [], urls: [] })
    expect(agent.conversation.applyProjectWritingRules).toBe(false)
    await agent.flushHistory()
    const saved = transport.historyWrite.mock.calls.at(-1)![0]
    const savedText = JSON.stringify(saved)
    expect(savedText).not.toContain('old-project-grant')
    expect(savedText).not.toContain('private query')
    expect(hydrateHistory(saved).chat.messages[0]!.references![0]!.snapshot.path).toBeUndefined()
    agent.$dispose()
  })
  it('does not replace an existing conversation when a recovered review is associated', async () => {
    const { record } = archivedReview(['pending', 'pending', 'pending', 'pending'])
    transport.historySettings.mockResolvedValue({ enabled: true })
    transport.historyRead.mockResolvedValue(record)
    files.openFiles.mockResolvedValue(['C:\\notes\\note.md'])
    const editor = useEditorStore(), agent = useAgentStore()
    await agent.restoreHistory(record.id)
    const historyKey = editor.currentFileId!
    const target = editor.newUntitledTab(record.data.snapshots[0]!.markdown)
    target.pathname = 'C:\\notes\\note.md'
    agent.conversation.messages.push({ id: 'keep-this-conversation', role: 'user', content: 'Keep me', tools: [] })
    const targetSession = agent.conversation
    editor.setCurrent(historyKey)
    expect(await agent.revalidateHistoryReview('archived-message')).toBe(false)
    expect(editor.currentFileId).toBe(historyKey)
    expect(agent.conversation.messages.some(message => message.id === 'archived-message')).toBe(true)
    expect(targetSession.messages.map(message => message.id)).toEqual(['keep-this-conversation'])
    expect(agent.historyReviewError).toBeTruthy()
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
