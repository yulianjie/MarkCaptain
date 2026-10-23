import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick, type EffectScope } from 'vue'
import type { AgentEvent, AgentRequest } from '../../src/services/agent'
import type { AgentDocumentVersion } from '../../src/services/tauri-invoke'

const transport = vi.hoisted(() => ({ start: vi.fn(), cancel: vi.fn(), listen: vi.fn() }))
const ipc = vi.hoisted(() => ({ agentDocumentVersions: vi.fn(), readMarkdown: vi.fn(), saveMarkdown: vi.fn(),
  localHistoryCapture: vi.fn(), saveAsDialog: vi.fn(), renameFile: vi.fn() }))
vi.mock('@/services/agent-transport', () => ({ agentTransport: transport }))
vi.mock('@/services/tauri-invoke', () => ipc)
vi.mock('element-plus', () => ({ ElMessageBox: { confirm: vi.fn() }, ElNotification: vi.fn() }))

import { createAgentMultiDocumentController } from '../../src/services/agent-multi-document'
import { useEditorStore } from '../../src/stores/editor'
import { usePreferencesStore } from '../../src/stores/preferences'
import { useAgentStore } from '../../src/stores/agent'
import { reviewProposal } from '../../src/services/agent'

type Controller = ReturnType<typeof createAgentMultiDocumentController>
type Editor = ReturnType<typeof useEditorStore>
type Tab = Editor['tabs'][number]
const hash = (value: string) => createHash('sha256').update(value.replace(/\r\n?/g, '\n')).digest('hex')
const disk = new Map<string, AgentDocumentVersion>()
let listeners: ((event: AgentEvent) => void)[]
let scope: EffectScope
let controller: Controller
let editor: Editor

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function tab(markdown: string, path?: string) {
  const result = editor.newUntitledTab(markdown)
  result.pendingBaselineUpdate = false
  if (path) {
    result.pathname = path
    result.filename = path.split('/').at(-1)!
    result.lastSavedMarkdown = markdown
    result.isSaved = true
    disk.set(path, { path, fingerprint: hash(`raw:${markdown}`), contentHash: hash(markdown) })
  }
  return result
}
const emit = (event: AgentEvent) => listeners.forEach(listener => listener(event))
const request = () => transport.start.mock.calls.at(-1)![0] as AgentRequest
function propose(target: Controller['state']['targets'][number], oldText = target.snapshot.markdown, newText = oldText.toUpperCase()) {
  emit({ requestId: controller.state.requestId!, kind: 'proposal', proposal: { documentId: target.documentId, title: target.name,
    changes: [{ oldText, newText, anchor: { snapshotId: target.snapshot.snapshotId!,
      from: target.snapshot.markdown.indexOf(oldText), to: target.snapshot.markdown.indexOf(oldText) + oldText.length } }] } })
}
async function review(tabs: Tab[]) {
  await controller.prepareAndSend(tabs.map(item => item.id), 'Polish the selected notes')
  controller.state.targets.forEach(target => propose(target))
  emit({ requestId: controller.state.requestId!, kind: 'done' })
  await nextTick()
}

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  disk.clear(); listeners = []
  transport.listen.mockImplementation(async listener => {
    listeners.push(listener)
    return () => { listeners = listeners.filter(item => item !== listener) }
  })
  transport.start.mockResolvedValue(undefined)
  transport.cancel.mockResolvedValue(undefined)
  ipc.agentDocumentVersions.mockImplementation(async (paths: string[]) => paths.map(path => disk.get(path)!))
  usePreferencesStore().autoSave = false
  scope = effectScope()
  scope.run(() => {
    editor = useEditorStore()
    // Exercise the real editor transaction/history implementation. Only the
    // native editor rendering callback is replaced in this Node-only suite.
    for (const mode of ['source', 'wysiwyg'] as const) {
      editor.registerAgentEditHandler(mode, markdown => editor.setMarkdownExternal(editor.currentFileId!, markdown))
    }
    controller = createAgentMultiDocumentController({ editor, isOtherBusy: () => false, hasConfig: () => true, language: () => 'en' })
  })
})
afterEach(() => { controller.dispose(); scope.stop(); vi.useRealTimers() })

describe('explicit multi-document selection and event routing', () => {
  it('coordinates the actual Agent store: single sends, summaries and acceptance wait for a multi-file task', async () => {
    const selected = tab('first')
    const agent = scope.run(() => useAgentStore())!
    agent.config = { baseUrl: 'http://localhost:11434/v1', model: 'fixture', authMode: 'none', hasKey: false, hasHeaders: false }
    const single = reviewProposal({ tabId: selected.id, name: 'first', markdown: 'first', from: 0, to: 5 },
      { title: 'Legacy edit', oldText: 'first', newText: 'LEGACY' })
    await agent.multiDocument.prepareAndSend([selected.id], 'Multi')
    expect(agent.busy).toBe(true)
    await agent.send('Single while multi runs')
    await agent.summarizeChapters()
    agent.apply(single)
    expect(transport.start).toHaveBeenCalledOnce()
    expect(selected.markdown).toBe('first')
    await agent.stop()
    expect(agent.multiDocumentState.stage).toBe('cancelled')
    expect(agent.busy).toBe(false)
    await agent.send('Single after stop')
    expect(transport.start).toHaveBeenCalledTimes(2)
    expect(request().editableDocuments).toBeUndefined()
    expect(request().context?.markdown).toBe('first')
  })

  it('does not start a multi-file task while the normal Agent owns the request', async () => {
    const selected = tab('first')
    const agent = scope.run(() => useAgentStore())!
    agent.config = { baseUrl: 'http://localhost:11434/v1', model: 'fixture', authMode: 'none', hasKey: false, hasHeaders: false }
    await agent.send('Single task')
    expect(agent.run).not.toBeNull()
    await agent.multiDocument.prepareAndSend([selected.id], 'Multi task')
    expect(transport.start).toHaveBeenCalledOnce()
    expect(agent.multiDocumentState.targets).toEqual([])
    emit({ requestId: agent.run!.id, kind: 'done' })
    await agent.multiDocument.prepareAndSend([selected.id], 'Multi task')
    expect(transport.start).toHaveBeenCalledTimes(2)
    expect(request().editableDocuments).toHaveLength(1)
  })

  it.each([0, 9])('rejects %i selected documents before subscribing or sending', async count => {
    const selected = Array.from({ length: count }, () => tab('draft'))
    await controller.prepareAndSend(selected.map(item => item.id), 'Polish')
    expect(transport.listen).not.toHaveBeenCalled()
    expect(transport.start).not.toHaveBeenCalled()
  })

  it('bounds UTF-8 bytes per document and across the selected set', async () => {
    const oversized = tab('汉'.repeat(666_667))
    await controller.prepareAndSend([oversized.id], 'Polish')
    expect(transport.start).not.toHaveBeenCalled()
    const selected = Array.from({ length: 3 }, () => tab('x'.repeat(1_400_000)))
    await controller.prepareAndSend(selected.map(item => item.id), 'Polish')
    expect(transport.start).not.toHaveBeenCalled()
  })

  it('freezes exactly selected tabs with opaque IDs and leaves current/reference/project access absent', async () => {
    const first = tab('first private draft'), second = tab('second draft'), unselected = tab('never send this')
    await controller.prepareAndSend([first.id, second.id], 'Polish')
    const sent = request()
    expect(editor.currentFileId).toBe(unselected.id)
    expect(sent.context).toBeNull()
    expect(sent.references).toBeUndefined()
    expect(sent.projectSearch).toBeUndefined()
    expect(sent.webResearch).toBeUndefined()
    expect(sent.editRange).toBeUndefined()
    expect(sent.editableDocuments?.map(item => item.markdown)).toEqual([first.markdown, second.markdown])
    expect(JSON.stringify(sent)).not.toContain(unselected.markdown)
    for (const doc of sent.editableDocuments!) {
      expect(doc.documentId).toMatch(/^edit-[0-9a-f-]{36}$/i)
      expect(doc.snapshotId).toBe(`${sent.requestId}:${doc.documentId}`)
      expect(doc.offset).toBe(0)
    }
  })

  it.each(['current', 'reference-1', 'project-1', 'edit-unknown', undefined])('rejects an unauthorized routed proposal %s', async documentId => {
    const selected = tab('selected')
    await controller.prepareAndSend([selected.id], 'Polish')
    emit({ requestId: controller.state.requestId!, kind: 'proposal', proposal: { documentId, title: 'Unauthorized', oldText: 'selected', newText: 'BAD' } })
    expect(controller.state.targets[0]!.proposal).toBeNull()
    expect(selected.markdown).toBe('selected')
  })

  it('rejects a different document snapshot anchor and preserves the first proposal', async () => {
    const first = tab('same'), second = tab('same')
    await controller.prepareAndSend([first.id, second.id], 'Polish')
    const [a, b] = controller.state.targets
    emit({ requestId: controller.state.requestId!, kind: 'proposal', proposal: { documentId: a!.documentId, title: 'Crossed anchor',
      changes: [{ oldText: 'same', newText: 'BAD', anchor: { snapshotId: b!.snapshot.snapshotId!, from: 0, to: 4 } }] } })
    expect(a!.proposal).toBeNull()
    propose(b!, 'same', 'FIRST')
    propose(b!, 'same', 'SECOND')
    expect(b!.proposal!.changes[0]!.newText).toBe('FIRST')
    expect([first.markdown, second.markdown]).toEqual(['same', 'same'])
  })

  it('ignores wrong request IDs and late events after cancellation/new task', async () => {
    const selected = tab('first')
    await controller.prepareAndSend([selected.id], 'First')
    const oldId = controller.state.requestId!
    const oldListener = listeners[0]!
    emit({ requestId: 'foreign-task', kind: 'delta', text: 'FOREIGN' })
    expect(controller.state.answer).toBe('')
    await controller.cancel()
    oldListener({ requestId: oldId, kind: 'delta', text: 'LATE' })
    expect(controller.state.answer).toBe('')
    await controller.prepareAndSend([selected.id], 'Second')
    oldListener({ requestId: oldId, kind: 'done' })
    oldListener({ requestId: oldId, kind: 'delta', text: 'OLD TASK' })
    expect(controller.state.requestId).not.toBe(oldId)
    expect(controller.state.stage).toBe('running')
    expect(controller.state.answer).toBe('')
  })

  it('keeps validated proposals reviewable after cancellation, ignoring subsequent proposals', async () => {
    const first = tab('first'), second = tab('second')
    await controller.prepareAndSend([first.id, second.id], 'Polish')
    propose(controller.state.targets[0]!)
    const oldListener = listeners[0]!, id = controller.state.requestId!
    await controller.cancel()
    oldListener({ requestId: id, kind: 'proposal', proposal: { documentId: controller.state.targets[1]!.documentId,
      title: 'Too late', oldText: 'second', newText: 'SECOND' } })
    expect(controller.state.targets[1]!.proposal).toBeNull()
    expect(await controller.apply(controller.state.targets[0]!.documentId)).toBe(true)
    expect(first.markdown).toBe('FIRST')
    expect(second.markdown).toBe('second')
  })

  it('routes context and citations only to selected snapshots and uses their canonical names', async () => {
    const first = tab('first source'), second = tab('second source')
    first.filename = 'first.md'; second.filename = 'second.md'
    await controller.prepareAndSend([first.id, second.id], 'Compare')
    const target = controller.state.targets[1]!, id = controller.state.requestId!
    for (const documentId of ['current', 'reference-other', target.documentId]) {
      emit({ requestId: id, kind: 'context', text: JSON.stringify({ documentId, documentName: 'wrong label',
        tool: 'read_document', kind: 'range', startLine: 1, endLine: 1, excerpt: 'second source' }) })
      emit({ requestId: id, kind: 'source', text: JSON.stringify({ documentId, label: 'Evidence',
        startLine: 1, endLine: 1, quote: 'second source' }) })
    }
    expect(controller.state.reads).toHaveLength(1)
    expect(controller.state.reads[0]).toMatchObject({ documentId: target.documentId, documentName: 'second.md' })
    expect(controller.state.sources).toHaveLength(1)
    expect(controller.state.sources[0]!.snapshot).toMatchObject({ tabId: second.id, markdown: 'second source' })
    emit({ requestId: id, kind: 'source', text: JSON.stringify({ documentId: target.documentId, label: 'Wrong quote',
      startLine: 1, endLine: 1, quote: 'first source' }) })
    expect(controller.state.sources).toHaveLength(1)
  })
})

describe('per-file review with real editor transactions', () => {
  it.each(['new', 'new\n'])('recognizes Muya first Undo of an original with no final newline (replacement=%j)', async replacement => {
    const selected = tab('old')
    editor.registerAgentEditHandler('wysiwyg', markdown => editor.applyContentChange(selected.id, markdown.endsWith('\n') ? markdown : `${markdown}\n`))
    await controller.prepareAndSend([selected.id], 'Rewrite')
    const target = controller.state.targets[0]!
    propose(target, 'old', replacement)
    emit({ requestId: controller.state.requestId!, kind: 'done' })
    expect(await controller.apply(target.documentId)).toBe(true)
    expect(selected.markdown).toBe('new\n')
    editor.stepSharedHistory('undo')
    expect(selected.markdown).toBe('old\n')
    expect(target.status).toBe('reverted')
    expect(target.proposal!.documentChanged).toBe(false)
    editor.stepSharedHistory('redo')
    expect(selected.markdown).toBe('new\n')
    expect(target.status).toBe('applied')
    expect(await controller.revert(target.documentId)).toBe(true)
    expect(selected.markdown).toBe('old\n')
    expect(target.status).toBe('reverted')
    expect(target.snapshot.markdown).toBe('old')
    // The known engine form must not turn arbitrary whitespace edits into undo.
    editor.setMarkdownExternal(selected.id, 'old\n\n')
    expect(target.status).toBe('conflict')
  })

  it('uses actual Muya serialization for subsequent Apply/Revert and native undo/redo checkpoints', async () => {
    const selected = tab('old\n')
    editor.registerAgentEditHandler('wysiwyg', markdown => editor.applyContentChange(selected.id, markdown.endsWith('\n') ? markdown : `${markdown}\n`))
    await controller.prepareAndSend([selected.id], 'Rewrite')
    const target = controller.state.targets[0]!
    propose(target, 'old\n', 'new')
    emit({ requestId: controller.state.requestId!, kind: 'done' })
    expect(await controller.apply(target.documentId)).toBe(true)
    expect(selected.markdown).toBe('new\n')
    expect(target.proposal!.appliedMarkdown).toBe('new\n')
    editor.stepSharedHistory('undo')
    expect(selected.markdown).toBe('old\n')
    expect(target.status).toBe('reverted')
    editor.stepSharedHistory('redo')
    expect(selected.markdown).toBe('new\n')
    expect(target.status).toBe('applied')
    expect(await controller.revert(target.documentId)).toBe(true)
    expect(selected.markdown).toBe('old\n')
    editor.stepSharedHistory('undo')
    expect(selected.markdown).toBe('new\n')
    expect(target.status).toBe('applied')
    editor.stepSharedHistory('redo')
    expect(selected.markdown).toBe('old\n')
    expect(target.status).toBe('reverted')
    expect(target.snapshot.markdown).toBe('old\n')
  })

  it('accepts another change after Muya adds a newline to a prior individual acceptance', async () => {
    const selected = tab('alpha beta')
    editor.registerAgentEditHandler('wysiwyg', markdown => editor.applyContentChange(selected.id, markdown.endsWith('\n') ? markdown : `${markdown}\n`))
    await controller.prepareAndSend([selected.id], 'Polish')
    const target = controller.state.targets[0]!
    emit({ requestId: controller.state.requestId!, kind: 'proposal', proposal: { documentId: target.documentId, title: 'Two changes', changes: [
      { oldText: 'alpha', newText: 'ALPHA', anchor: { snapshotId: target.snapshot.snapshotId!, from: 0, to: 5 } },
      { oldText: 'beta', newText: 'BETA', anchor: { snapshotId: target.snapshot.snapshotId!, from: 6, to: 10 } },
    ] } })
    emit({ requestId: controller.state.requestId!, kind: 'done' })
    expect(await controller.apply(target.documentId, 0)).toBe(true)
    expect(selected.markdown).toBe('ALPHA beta\n')
    expect(await controller.apply(target.documentId, 1)).toBe(true)
    expect(selected.markdown).toBe('ALPHA BETA\n')
    expect(await controller.revert(target.documentId, 0)).toBe(true)
    expect(selected.markdown).toBe('alpha BETA\n')
    expect(target.proposal!.changes.map(change => change.status)).toEqual(['reverted', 'applied'])
    editor.stepSharedHistory('undo')
    expect(selected.markdown).toBe('ALPHA BETA\n')
    expect(target.proposal!.changes.map(change => change.status)).toEqual(['applied', 'applied'])
  })

  it('can activate an approved document whose editor mode differs from the current document', async () => {
    const first = tab('first'), second = tab('second')
    first.sourceMode = true
    await review([first, second])
    expect(editor.sourceCodeMode).toBe(false)
    expect(await controller.apply(controller.state.targets[0]!.documentId)).toBe(true)
    expect(editor.sourceCodeMode).toBe(true)
    expect([first.markdown, second.markdown]).toEqual(['FIRST', 'second'])
  })

  it.each([false, true])('applies, reverts and reconciles independent native history (source=%s)', async source => {
    editor.sourceCodeMode = source
    const first = tab('first'), second = tab('second'), untouched = tab('untouched')
    await nextTick()
    await review([first, second])
    const [a, b] = controller.state.targets
    expect(await controller.apply(a!.documentId)).toBe(true)
    expect([first.markdown, second.markdown, untouched.markdown]).toEqual(['FIRST', 'second', 'untouched'])
    expect(await controller.apply(b!.documentId)).toBe(true)
    editor.setCurrent(first.id)
    editor.stepSharedHistory('undo')
    expect([first.markdown, second.markdown]).toEqual(['first', 'SECOND'])
    expect(a!.proposal!.changes[0]!.status).toBe('reverted')
    expect(b!.proposal!.changes[0]!.status).toBe('applied')
    editor.stepSharedHistory('redo')
    expect(first.markdown).toBe('FIRST')
    expect(a!.proposal!.changes[0]!.status).toBe('applied')
    expect(await controller.revert(b!.documentId)).toBe(true)
    expect([first.markdown, second.markdown]).toEqual(['FIRST', 'second'])
    editor.stepSharedHistory('undo')
    expect([first.markdown, second.markdown]).toEqual(['FIRST', 'SECOND'])
    expect(b!.proposal!.changes[0]!.status).toBe('applied')
    editor.stepSharedHistory('redo')
    expect([first.markdown, second.markdown]).toEqual(['FIRST', 'second'])
    expect(b!.proposal!.changes[0]!.status).toBe('reverted')
    expect(a!.snapshot.markdown).toBe('first')
    expect(b!.snapshot.markdown).toBe('second')
    expect(ipc.saveMarkdown).not.toHaveBeenCalled()
  })

  it('keeps individual acceptance and dismissal decisions independent', async () => {
    const selected = tab('alpha beta')
    await controller.prepareAndSend([selected.id], 'Polish')
    const target = controller.state.targets[0]!
    emit({ requestId: controller.state.requestId!, kind: 'proposal', proposal: { documentId: target.documentId, title: 'Two changes', changes: [
      { oldText: 'alpha', newText: 'ALPHA', anchor: { snapshotId: target.snapshot.snapshotId!, from: 0, to: 5 } },
      { oldText: 'beta', newText: 'BETA', anchor: { snapshotId: target.snapshot.snapshotId!, from: 6, to: 10 } },
    ] } })
    emit({ requestId: controller.state.requestId!, kind: 'done' })
    expect(await controller.apply(target.documentId, 0)).toBe(true)
    controller.dismiss(target.documentId, 1)
    expect(selected.markdown).toBe('ALPHA beta')
    editor.stepSharedHistory('undo')
    expect(selected.markdown).toBe('alpha beta')
    expect(target.proposal!.changes.map(change => change.status)).toEqual(['reverted', 'dismissed'])
  })

  it('pauses only selected autosave timers, applies in memory, and keeps the global preference', async () => {
    vi.useFakeTimers()
    const selected = tab('first', 'C:/notes/first.md'), unselected = tab('other', 'C:/notes/other.md')
    usePreferencesStore().autoSave = true
    editor.setMarkdownExternal(selected.id, 'first draft')
    await review([selected])
    expect(selected.autoSaveBlocked).toBe(true)
    expect(unselected.autoSaveBlocked).not.toBe(true)
    expect(await controller.apply(controller.state.targets[0]!.documentId)).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(selected.markdown).toBe('FIRST DRAFT')
    expect(selected.isSaved).toBe(false)
    expect(usePreferencesStore().autoSave).toBe(true)
    expect(ipc.saveMarkdown).not.toHaveBeenCalled()
  })

  it('drains an in-flight save and restores the pause without allowing its completion to schedule another write', async () => {
    vi.useFakeTimers()
    const selected = tab('first', 'C:/notes/first.md')
    const write = deferred<void>()
    ipc.saveMarkdown.mockReturnValueOnce(write.promise)
    Object.assign(usePreferencesStore(), { autoSave: true, autoSaveDelay: 10 })
    editor.setMarkdownExternal(selected.id, 'first write')
    await nextTick()
    await vi.advanceTimersByTimeAsync(10)
    expect(ipc.saveMarkdown).toHaveBeenCalledOnce()
    editor.setMarkdownExternal(selected.id, 'newer draft')
    const sending = controller.prepareAndSend([selected.id], 'Polish')
    await nextTick()
    expect(selected.autoSaveBlocked).toBe(true)
    expect(transport.start).not.toHaveBeenCalled()
    write.resolve()
    await sending
    await vi.advanceTimersByTimeAsync(10_000)
    expect(selected.markdown).toBe('newer draft')
    expect(selected.autoSaveBlocked).toBe(true)
    expect(ipc.saveMarkdown).toHaveBeenCalledOnce()
    expect(transport.start).not.toHaveBeenCalled()
  })
})

describe('disk baselines and asynchronous target identity', () => {
  it('allows a clean save already in flight to drain before freezing a new request', async () => {
    const selected = tab('first', 'C:/notes/first.md'), write = deferred<void>()
    ipc.saveMarkdown.mockReturnValueOnce(write.promise)
    const saving = editor.saveTab(selected)
    await vi.waitFor(() => expect(ipc.saveMarkdown).toHaveBeenCalledOnce())
    const sending = controller.prepareAndSend([selected.id], 'Polish')
    await nextTick()
    expect(transport.start).not.toHaveBeenCalled()
    write.resolve(); await saving; await sending
    expect(transport.start).toHaveBeenCalledOnce()
    expect(selected.autoSaveBlocked).toBe(true)
  })

  it.each(['pause', 'mount'] as const)('rejects a newly queued manual save while application awaits %s', async phase => {
    const selected = tab('first', 'C:/notes/first.md')
    await review([selected])
    const write = deferred<void>(), pause = deferred<void>()
    ipc.saveMarkdown.mockReturnValueOnce(write.promise)
    let saving: Promise<boolean> | undefined
    if (phase === 'pause') vi.spyOn(editor, 'pauseAgentAutoSave').mockReturnValueOnce(pause.promise)
    else {
      const setCurrent = editor.setCurrent.bind(editor)
      vi.spyOn(editor, 'setCurrent').mockImplementationOnce(id => { setCurrent(id); saving = editor.saveTab(selected) })
    }
    const applying = controller.apply(controller.state.targets[0]!.documentId)
    if (phase === 'pause') saving = editor.saveTab(selected)
    await vi.waitFor(() => expect(ipc.saveMarkdown).toHaveBeenCalledOnce())
    pause.resolve()
    expect(await applying).toBe(false)
    expect(selected.markdown).toBe('first')
    expect(ipc.agentDocumentVersions).toHaveBeenCalledOnce()
    write.resolve(); await saving
  })

  it.each(['pending', 'completed'] as const)('rejects a new manual save during the acceptance probe even when it is %s and the saved text stays unchanged', async completion => {
    const selected = tab('first', 'C:/notes/first.md')
    await review([selected])
    const probe = deferred<AgentDocumentVersion[]>(), write = deferred<void>()
    ipc.agentDocumentVersions.mockReturnValueOnce(probe.promise)
    ipc.saveMarkdown.mockReturnValueOnce(write.promise)
    const applying = controller.apply(controller.state.targets[0]!.documentId)
    await vi.waitFor(() => expect(ipc.agentDocumentVersions).toHaveBeenCalledTimes(2))
    Object.assign(usePreferencesStore(), { autoSave: true, autoSaveDelay: 10 })
    const saving = editor.saveTab(selected)
    await vi.waitFor(() => expect(ipc.saveMarkdown).toHaveBeenCalledOnce())
    if (completion === 'completed') { write.resolve(); await saving }
    expect(selected.lastSavedMarkdown).toBe('first')
    probe.resolve([disk.get(selected.pathname)!])
    expect(await applying).toBe(false)
    expect(selected.markdown).toBe('first')
    if (completion === 'pending') { write.resolve(); await saving }
    expect(controller.state.targets[0]!.status).toBe('conflict')
    expect(ipc.saveMarkdown.mock.calls.map(call => call[1])).toEqual(['first'])
  })

  it('does not lift an Agent autosave pause when an older manual save completes after a buffer edit', async () => {
    vi.useFakeTimers()
    const selected = tab('first', 'C:/notes/first.md'), write = deferred<void>()
    selected.autoSaveBlocked = true
    Object.assign(usePreferencesStore(), { autoSave: true, autoSaveDelay: 10 })
    ipc.saveMarkdown.mockReturnValueOnce(write.promise)
    const saving = editor.saveTab(selected)
    await nextTick(); await nextTick()
    expect(ipc.saveMarkdown).toHaveBeenCalledOnce()
    editor.applyAgentEdit(selected.id, 'first', 'accepted text')
    write.resolve(); await saving
    expect(selected.autoSaveBlocked).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(ipc.saveMarkdown.mock.calls.map(call => call[1])).toEqual(['first'])
    expect(selected.markdown).toBe('accepted text')
  })

  it.each(['probe', 'listen', 'start'] as const)('rejects a new clean manual save during preparation await: %s', async phase => {
    const selected = tab('first', 'C:/notes/first.md'), write = deferred<void>()
    const probe = deferred<AgentDocumentVersion[]>(), listener = deferred<() => void>(), start = deferred<void>()
    if (phase === 'probe') ipc.agentDocumentVersions.mockReturnValueOnce(probe.promise)
    if (phase === 'listen') transport.listen.mockReturnValueOnce(listener.promise)
    if (phase === 'start') transport.start.mockReturnValueOnce(start.promise)
    ipc.saveMarkdown.mockReturnValueOnce(write.promise)
    const sending = controller.prepareAndSend([selected.id], 'Polish')
    await vi.waitFor(() => expect(phase === 'probe' ? ipc.agentDocumentVersions : phase === 'listen' ? transport.listen : transport.start).toHaveBeenCalledOnce())
    const saving = editor.saveTab(selected)
    await vi.waitFor(() => expect(ipc.saveMarkdown).toHaveBeenCalledOnce())
    if (phase === 'probe') probe.resolve([disk.get(selected.pathname)!])
    if (phase === 'listen') listener.resolve(vi.fn())
    if (phase === 'start') start.resolve()
    await sending
    expect(controller.state.stage).toBe('failed')
    if (phase === 'start') expect(transport.cancel).toHaveBeenCalledWith(request().requestId)
    else expect(transport.start).not.toHaveBeenCalled()
    write.resolve(); await saving
  })

  it('probes saved tabs with their explicit encoding and rejects later encoding changes', async () => {
    const selected = tab('Привет', 'C:/notes/cyrillic.md')
    selected.encoding.encoding = 'windows-1251'
    await review([selected])
    expect(ipc.agentDocumentVersions).toHaveBeenLastCalledWith([selected.pathname], { [selected.pathname]: 'windows-1251' })
    expect(await controller.apply(controller.state.targets[0]!.documentId)).toBe(true)
    expect(ipc.agentDocumentVersions).toHaveBeenLastCalledWith([selected.pathname], { [selected.pathname]: 'windows-1251' })
    selected.encoding.encoding = 'utf-8'
    expect(await controller.revert(controller.state.targets[0]!.documentId)).toBe(false)
    expect(controller.state.targets[0]!.status).toBe('conflict')
  })

  it('rejects an encoding change while its baseline probe is pending', async () => {
    const selected = tab('first', 'C:/notes/first.md'), probe = deferred<AgentDocumentVersion[]>()
    ipc.agentDocumentVersions.mockReturnValueOnce(probe.promise)
    const sending = controller.prepareAndSend([selected.id], 'Polish')
    await vi.waitFor(() => expect(ipc.agentDocumentVersions).toHaveBeenCalledOnce())
    selected.encoding.encoding = 'utf-16le'
    probe.resolve([disk.get(selected.pathname)!]); await sending
    expect(transport.start).not.toHaveBeenCalled()
    expect(controller.state.targets[0]!.status).toBe('conflict')
  })

  it('does not let an old awaited listener completion release or overwrite the next task', async () => {
    const selected = tab('first')
    const delayed = deferred<() => void>(), oldRelease = vi.fn()
    transport.listen.mockReturnValueOnce(delayed.promise)
    const first = controller.prepareAndSend([selected.id], 'First task')
    await vi.waitFor(() => expect(transport.listen).toHaveBeenCalledOnce())
    await controller.cancel()
    await controller.prepareAndSend([selected.id], 'Second task')
    const secondId = controller.state.requestId!
    delayed.resolve(oldRelease)
    await first
    expect(oldRelease).toHaveBeenCalledOnce()
    expect(controller.state.requestId).toBe(secondId)
    expect(controller.state.stage).toBe('running')
    emit({ requestId: secondId, kind: 'delta', text: 'Second task answer' })
    expect(controller.state.answer).toBe('Second task answer')
    expect(transport.start).toHaveBeenCalledOnce()
  })

  it('rejects an identity change while the saved-content hash is being calculated', async () => {
    const selected = tab('first', 'C:/notes/first.md')
    const digest = deferred<ArrayBuffer>()
    const spy = vi.spyOn(crypto.subtle, 'digest').mockReturnValueOnce(digest.promise)
    const sending = controller.prepareAndSend([selected.id], 'Polish')
    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce())
    selected.pathname = 'C:/notes/renamed.md'
    const bytes = Uint8Array.from(Buffer.from(hash('first'), 'hex'))
    digest.resolve(bytes.buffer)
    await sending
    expect(transport.start).not.toHaveBeenCalled()
    expect(selected.markdown).toBe('first')
  })

  it.each(['edit', 'rename', 'close', 'pane', 'cancel'] as const)('rechecks selection after listener setup awaits (%s)', async mutation => {
    const selected = tab('first')
    editor.splitPane('horizontal')
    const pending = deferred<() => void>(), release = vi.fn()
    transport.listen.mockReturnValueOnce(pending.promise)
    const sending = controller.prepareAndSend([selected.id], 'Polish')
    await vi.waitFor(() => expect(transport.listen).toHaveBeenCalledOnce())
    if (mutation === 'edit') editor.setMarkdownExternal(selected.id, 'user edit')
    if (mutation === 'rename') selected.pathname = 'C:/notes/renamed.md'
    if (mutation === 'close') await editor.closeTab(selected.id, true)
    if (mutation === 'pane') editor.activatePane(editor.panes[1]!.id)
    if (mutation === 'cancel') await controller.cancel()
    pending.resolve(release)
    await sending
    expect(transport.start).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('invalidates an application if the target changes while autosave queues drain', async () => {
    const selected = tab('first')
    await review([selected])
    const pause = deferred<void>()
    vi.spyOn(editor, 'pauseAgentAutoSave').mockReturnValueOnce(pause.promise)
    const applying = controller.apply(controller.state.targets[0]!.documentId)
    editor.setMarkdownExternal(selected.id, 'user edit')
    pause.resolve()
    expect(await applying).toBe(false)
    expect(selected.markdown).toBe('user edit')
  })

  it('stops an already started request whose target changes before start resolves', async () => {
    const selected = tab('first')
    const started = deferred<void>()
    transport.start.mockReturnValueOnce(started.promise)
    const sending = controller.prepareAndSend([selected.id], 'Polish')
    await vi.waitFor(() => expect(transport.start).toHaveBeenCalledOnce())
    editor.setMarkdownExternal(selected.id, 'user edit')
    started.resolve()
    await sending
    expect(transport.cancel).toHaveBeenCalledWith(request().requestId)
    expect(controller.state.targets[0]!.status).toBe('conflict')
    expect(selected.markdown).toBe('user edit')
  })

  it('rejects an already stale disk baseline before provider start', async () => {
    const selected = tab('cached disk', 'C:/notes/first.md')
    disk.set(selected.pathname!, { path: selected.pathname!, fingerprint: hash('outside'), contentHash: hash('outside') })
    await controller.prepareAndSend([selected.id], 'Polish')
    expect(transport.start).not.toHaveBeenCalled()
    expect(selected.markdown).toBe('cached disk')
    expect(controller.state.targets[0]!.snapshot.markdown).toBe('cached disk')
  })

  it.each(['changed', 'removed'] as const)('blocks a %s disk file while another proposal stays independently applicable', async reason => {
    const first = tab('first', 'C:/notes/first.md'), second = tab('second', 'C:/notes/second.md')
    await review([first, second])
    disk.set(first.pathname!, { path: first.pathname!, fingerprint: reason === 'removed' ? null : hash('changed'),
      contentHash: reason === 'removed' ? null : hash('changed'), ...(reason === 'removed' ? { error: 'missing' } : {}) })
    expect(await controller.apply(controller.state.targets[0]!.documentId)).toBe(false)
    expect(controller.state.targets[0]!.status).toBe('conflict')
    expect(await controller.apply(controller.state.targets[1]!.documentId)).toBe(true)
    expect([first.markdown, second.markdown]).toEqual(['first', 'SECOND'])
  })

  it.each(['edit', 'rename', 'close', 'pane', 'mode', 'cancel'] as const)('does not apply across %s during version probe', async mutation => {
    const selected = tab('first', 'C:/notes/first.md')
    editor.splitPane('horizontal')
    const otherPane = editor.panes[1]!
    await review([selected])
    const pending = deferred<AgentDocumentVersion[]>()
    ipc.agentDocumentVersions.mockReturnValueOnce(pending.promise)
    const applying = controller.apply(controller.state.targets[0]!.documentId)
    await vi.waitFor(() => expect(ipc.agentDocumentVersions).toHaveBeenCalledTimes(2))
    if (mutation === 'edit') editor.setMarkdownExternal(selected.id, 'user edit')
    if (mutation === 'rename') selected.pathname = 'C:/notes/renamed.md'
    if (mutation === 'close') await editor.closeTab(selected.id, true)
    if (mutation === 'pane') editor.activatePane(otherPane.id)
    if (mutation === 'mode') editor.sourceCodeMode = !editor.sourceCodeMode
    if (mutation === 'cancel') await controller.cancel()
    pending.resolve([disk.get('C:/notes/first.md')!])
    expect(await applying).toBe(false)
    expect(selected.markdown).toBe(mutation === 'edit' ? 'user edit' : 'first')
    expect(ipc.saveMarkdown).not.toHaveBeenCalled()
  })

  it.each(['edit', 'rename', 'close'] as const)('rejects %s while preparing a disk snapshot', async mutation => {
    const selected = tab('first', 'C:/notes/first.md')
    const pending = deferred<AgentDocumentVersion[]>()
    ipc.agentDocumentVersions.mockReturnValueOnce(pending.promise)
    const sending = controller.prepareAndSend([selected.id], 'Polish')
    await vi.waitFor(() => expect(ipc.agentDocumentVersions).toHaveBeenCalledOnce())
    if (mutation === 'edit') editor.setMarkdownExternal(selected.id, 'user edit')
    if (mutation === 'rename') selected.pathname = 'C:/notes/renamed.md'
    if (mutation === 'close') await editor.closeTab(selected.id, true)
    pending.resolve([disk.get('C:/notes/first.md')!])
    await sending
    expect(transport.start).not.toHaveBeenCalled()
  })

  it('invalidates a close/reopen at the same path and keeps the protected original', async () => {
    const selected = tab('first', 'C:/notes/first.md')
    await review([selected])
    const target = controller.state.targets[0]!
    await editor.closeTab(selected.id, true)
    const reopened = tab('first', 'C:/notes/first.md')
    expect(reopened.id).not.toBe(selected.id)
    expect(await controller.apply(target.documentId)).toBe(false)
    expect(reopened.markdown).toBe('first')
    expect(target.snapshot.markdown).toBe('first')
  })

  it('rechecks the disk before revert and preserves accepted text on conflict', async () => {
    const selected = tab('first', 'C:/notes/first.md')
    await review([selected])
    const target = controller.state.targets[0]!
    expect(await controller.apply(target.documentId)).toBe(true)
    disk.set(selected.pathname!, { path: selected.pathname!, fingerprint: hash('outside'), contentHash: hash('outside') })
    expect(await controller.revert(target.documentId)).toBe(false)
    expect(selected.markdown).toBe('FIRST')
    expect(target.snapshot.markdown).toBe('first')
  })
})
