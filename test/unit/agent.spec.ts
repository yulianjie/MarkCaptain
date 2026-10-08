import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { changeDiff, markdownSelection, parseAgentHeaders, proposalMarkdown, reviewProposal, type AgentEvent, type AgentImage } from '../../src/services/agent'
import { readAgentImage } from '../../src/services/agent-images'

const transport = vi.hoisted(() => ({ getConfig: vi.fn(), saveConfig: vi.fn(), testConnection: vi.fn(), start: vi.fn(), cancel: vi.fn(), listen: vi.fn(), listSkills: vi.fn(), importSkill: vi.fn() }))
vi.mock('@/services/agent-transport', () => ({ agentTransport: transport }))
vi.mock('@/services/agent-images', async importOriginal => ({ ...await importOriginal<typeof import('../../src/services/agent-images')>(), readAgentImage: vi.fn() }))
vi.mock('@/services/tauri-invoke', () => ({ readMarkdown: vi.fn(), saveMarkdown: vi.fn(), saveAsDialog: vi.fn(), renameFile: vi.fn() }))
vi.mock('element-plus', () => ({ ElMessageBox: { confirm: vi.fn() }, ElNotification: vi.fn() }))

import { useAgentStore } from '../../src/stores/agent'
import { useEditorStore } from '../../src/stores/editor'
import { usePreferencesStore } from '../../src/stores/preferences'

let emit: (event: AgentEvent) => void
beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  transport.listen.mockImplementation(async handler => { emit = handler; return () => {} })
  transport.start.mockResolvedValue(undefined)
  transport.cancel.mockResolvedValue(undefined)
  transport.listSkills.mockResolvedValue([])
  usePreferencesStore().autoSave = false
})

const snapshot = { tabId: 'doc', name: 'note.md', markdown: 'same\nhello world\nsame', from: 5, to: 16 }
describe('Agent document edits', () => {
  const picture: AgentImage = { name: 'image.png', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5WQAAAAASUVORK5CYII=' }
  it('parses custom headers without losing colons and rejects ambiguous input', () => {
    expect(parseAgentHeaders('X-Tenant-ID: tenant-1\nAuthorization: Token abc:def')).toEqual([
      { name: 'X-Tenant-ID', value: 'tenant-1' },
      { name: 'Authorization', value: 'Token abc:def' },
    ])
    expect(parseAgentHeaders('  ')).toBeUndefined()
    for (const value of ['Missing separator', 'Bad Header: x', 'X-Test:', 'X-Test: one\nx-test: two', 'X-Test: one\u0007']) {
      expect(() => parseAgentHeaders(value)).toThrow('agent:invalidHeaders')
    }
  })
  it('automatically captures reversed source selections, respects removal and isolates attachment settings', () => {
    const editor = useEditorStore(), agent = useAgentStore()
    const first = editor.newUntitledTab('private\nselected text\nprivate')
    editor.sourceCodeMode = true
    first.sourceSelection = { ranges: [{ anchor: 21, head: 8 }], main: 0 }
    agent.toggle()
    expect(agent.selection?.markdown.slice(agent.selection.from, agent.selection.to)).toBe('selected text')
    agent.clearSelection()
    agent.attachSelection(true)
    expect(agent.selection).toBeNull()
    agent.attachSelection()
    expect(agent.selection).not.toBeNull()
    agent.includeDocument = false
    agent.clearSelection()
    agent.attachSelection(true)
    expect(agent.includeDocument).toBe(false)
    expect(agent.selection).toBeNull()
    editor.newUntitledTab('another')
    expect(agent.includeDocument).toBe(true)
    editor.setCurrent(first.id)
    expect(agent.includeDocument).toBe(false)
    agent.clear()
    expect(agent.includeDocument).toBe(false)
  })
  it('sends image-only messages, retains images in follow-ups and retries the same immutable context', async () => {
    const editor = useEditorStore(), agent = useAgentStore()
    const tab = editor.newUntitledTab('hello world')
    agent.conversation.images = [{ ...picture }]
    await agent.send('')
    expect(transport.start.mock.calls[0]![0].messages).toEqual([{ role: 'user', content: '', images: [picture] }])
    expect(agent.conversation.images).toEqual([])
    emit({ requestId: agent.run!.id, kind: 'error', text: 'agent:network' })
    agent.includeDocument = false
    agent.retry()
    await vi.waitFor(() => expect(transport.start).toHaveBeenCalledTimes(2))
    expect(transport.start.mock.calls[1]![0].context?.markdown).toBe(tab.markdown)
    expect(transport.start.mock.calls[1]![0].messages[0].images).toEqual([picture])
    emit({ requestId: agent.run!.id, kind: 'done' })
    await agent.send('What is in the image?')
    expect(transport.start.mock.calls[2]![0].messages[0].images).toEqual([picture])
    expect(transport.start.mock.calls[2]![0].messages.at(-1).images).toBeUndefined()
  })
  it('keeps pending image reads with their document and discards reads after clearing a conversation', async () => {
    const editor = useEditorStore(), agent = useAgentStore()
    const tab = editor.newUntitledTab('first')
    let finish!: (image: AgentImage) => void
    vi.mocked(readAgentImage).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const adding = agent.addImages([{} as File])
    await agent.addImages([{} as File])
    expect(agent.error).not.toBe('')
    await agent.send('not ready')
    expect(transport.start).not.toHaveBeenCalled()
    editor.newUntitledTab('second')
    finish(picture)
    await adding
    expect(agent.conversation.images).toEqual([])
    editor.setCurrent(tab.id)
    expect(agent.conversation.images).toEqual([picture])
    const discarded = agent.addImages([{} as File])
    agent.clear()
    finish(picture)
    await discarded
    expect(agent.conversation.images).toEqual([])
    expect(agent.conversation.readingImages).toBe(false)
  })
  it('rejects a failed batch without losing existing images and guards count limits', async () => {
    const agent = useAgentStore()
    agent.conversation.images = [{ ...picture }]
    vi.mocked(readAgentImage).mockResolvedValueOnce(picture).mockRejectedValueOnce(new Error('agent:imageRead'))
    await agent.addImages([{} as File, {} as File])
    expect(agent.conversation.images).toEqual([picture])
    expect(agent.error).not.toBe('')
    await agent.addImages(Array.from({ length: 4 }, () => ({} as File)))
    expect(agent.conversation.images).toEqual([picture])
    expect(agent.conversation.readingImages).toBe(false)
  })
  it('refuses stale selection sends and stale retries without sending a different document', async () => {
    const editor = useEditorStore(), agent = useAgentStore()
    const tab = editor.newUntitledTab('hello world')
    editor.sourceCodeMode = true
    tab.sourceSelection = { ranges: [{ anchor: 0, head: 5 }], main: 0 }
    agent.attachSelection(true)
    await agent.send('revise')
    emit({ requestId: agent.run!.id, kind: 'error', text: 'agent:network' })
    editor.setMarkdownExternal(tab.id, 'changed document')
    agent.retry()
    expect(transport.start).toHaveBeenCalledTimes(1)
    expect(agent.conversation.draft).toBe('revise')
    await agent.send()
    expect(transport.start).toHaveBeenCalledTimes(1)
  })
  it('keeps document size separate from chat context and defaults to automatic skills', async () => {
    useEditorStore().newUntitledTab('x'.repeat(400_000))
    const agent = useAgentStore()
    await agent.send('Explain Markdown tables')
    expect(transport.start).toHaveBeenCalledOnce()
    expect(transport.start.mock.calls[0]![0].skillIds).toEqual([])
  })
  it('sends chosen skills and clears selections when disabled or removed', async () => {
    useEditorStore().newUntitledTab('hello')
    const agent = useAgentStore()
    const skill = { id: 'user:sample', name: 'sample', description: 'Explain', enabled: true, builtin: false, source: null, license: 'MIT' }
    transport.listSkills.mockResolvedValue([skill])
    await agent.loadSkills()
    agent.conversation.skillId = skill.id
    agent.includeDocument = false
    await agent.send('Explain this concept')
    expect(transport.start.mock.calls[0]![0].skillIds).toEqual(['user:sample'])
    const id = agent.run!.id
    emit({ requestId: id, kind: 'tool', text: 'read_skill' })
    emit({ requestId: id, kind: 'tool', text: 'read_skill_file' })
    emit({ requestId: id, kind: 'done' })
    expect(agent.conversation.messages.at(-1)!.tools).toEqual(['read_skill', 'read_skill_file'])
    await agent.changeSkills(async () => [{ ...skill, enabled: false }])
    expect(agent.conversation.skillId).toBe('')
    await agent.changeSkills(async () => null)
    expect(agent.skills).toHaveLength(1)
    await agent.changeSkills(async () => { throw new Error('agent:skillInvalid') })
    expect(agent.skillsError).not.toBe('')
    expect(agent.skills).toHaveLength(1)
    await agent.changeSkills(async () => [])
    expect(agent.skills).toHaveLength(0)
  })
  it('edits within the attached scope and preserves all surrounding content', () => {
    expect(proposalMarkdown(snapshot, { title: 'Edit', oldText: 'hello', newText: '你好' })).toBe('same\n你好 world\nsame')
    expect(proposalMarkdown(snapshot, { title: 'Append', oldText: '', newText: '!' })).toBe('same\nhello world!\nsame')
    expect(() => proposalMarkdown(snapshot, { title: 'Outside', oldText: 'same', newText: 'x' })).toThrow()
    expect(() => proposalMarkdown({ ...snapshot, from: 0, to: snapshot.markdown.length }, { title: 'Ambiguous', oldText: 'same', newText: 'x' })).toThrow()
  })
  it('maps reversed Markdown selections and rejects invalid coordinates', () => {
    expect(markdownSelection('你好\nworld', { anchor: { line: 1, ch: 3 }, focus: { line: 0, ch: 1 } })).toEqual({ from: 1, to: 6 })
    expect(markdownSelection('hi', { anchor: { line: 4, ch: 0 }, focus: { line: 0, ch: 0 } })).toBeNull()
  })
  it('validates disjoint UTF-16 edits, adjacent edits, and bounded nonempty batches', () => {
    const snapshot = { tabId: 'doc', name: 'note', markdown: '😀one\n中文two\nthree', from: 0, to: 17 }
    const proposal = { title: 'Batch', changes: [{ oldText: 'one', newText: 'ONE' }, { oldText: '中文two', newText: '二' }] }
    expect(proposalMarkdown(snapshot, proposal)).toBe('😀ONE\n二\nthree')
    expect(reviewProposal(snapshot, proposal).changes.map(c => [c.from, c.startLine])).toEqual([[2, 1], [6, 2]])
    expect(proposalMarkdown(snapshot, { title: 'Adjacent', changes: [{ oldText: '😀', newText: '😎' }, { oldText: 'one', newText: 'ONE' }] })).toBe('😎ONE\n中文two\nthree')
    for (const changes of [[], [{ oldText: 'one', newText: 'ONE' }, { oldText: '😀one', newText: 'x' }], [{ oldText: '', newText: 'a' }, { oldText: '', newText: 'b' }], [{ oldText: 'one\n', newText: 'one\r\n' }], Array.from({ length: 33 }, () => ({ oldText: '', newText: 'a' }))]) {
      expect(() => proposalMarkdown(snapshot, { title: 'Invalid', changes })).toThrow('agent:invalidEdit')
    }
    expect(() => proposalMarkdown({ ...snapshot, markdown: 'aaa', to: 3 }, { title: 'Ambiguous', oldText: 'aa', newText: 'b' })).toThrow()
    expect(changeDiff({ oldText: 'same\nold\ntail', newText: 'same\nnew\ntail' })).toEqual([
      { kind: 'same', text: 'same' }, { kind: 'removed', text: 'old' }, { kind: 'added', text: 'new' }, { kind: 'same', text: 'tail' },
    ])
  })
  it('accepts disjoint changes sequentially, rejects external typing, and reverts only selected changes', async () => {
    const editor = useEditorStore(), agent = useAgentStore()
    const tab = editor.newUntitledTab('😀one\n中文two\nthree')
    const handler = vi.fn((text: string) => editor.setMarkdownExternal(tab.id, text))
    editor.registerAgentEditHandler('wysiwyg', handler)
    await agent.send('edit')
    const id = agent.run!.id
    emit({ requestId: id, kind: 'proposal', proposal: { title: 'Batch', changes: [
      { oldText: 'one', newText: 'a longer first part' }, { oldText: '中文two', newText: '二' }, { oldText: 'three', newText: 'THREE' },
    ] } })
    emit({ requestId: id, kind: 'done' })
    const edit = agent.conversation.messages.at(-1)!.edit!
    agent.apply(edit, 0)
    expect(tab.markdown).toBe('😀a longer first part\n中文two\nthree')
    agent.apply(edit, 1)
    expect(tab.markdown).toBe('😀a longer first part\n二\nthree')
    expect(edit.status).toBe('partial')
    const expected = tab.markdown
    editor.setMarkdownExternal(tab.id, expected + '!')
    agent.apply(edit, 2)
    agent.revert(edit, 0)
    expect(tab.markdown).toBe(expected + '!')
    expect(edit.changes.map(c => c.status)).toEqual(['applied', 'applied', 'pending'])
    editor.setMarkdownExternal(tab.id, expected)
    agent.revert(edit, 0)
    expect(tab.markdown).toBe('😀one\n二\nthree')
    agent.dismiss(edit, 2)
    agent.revert(edit)
    expect(tab.markdown).toBe('😀one\n中文two\nthree')
    expect(edit.changes.map(c => c.status)).toEqual(['reverted', 'reverted', 'dismissed'])
  })
  it('sends exact per-item acceptance, rejection, reasons and withdrawal on following turns', async () => {
    const editor = useEditorStore(), agent = useAgentStore()
    const tab = editor.newUntitledTab('one two three')
    editor.registerAgentEditHandler('wysiwyg', text => editor.setMarkdownExternal(tab.id, text))
    await agent.send('edit')
    emit({ requestId: agent.run!.id, kind: 'proposal', proposal: { title: 'Batch', changes: ['one', 'two', 'three'].map(oldText => ({ oldText, newText: oldText.toUpperCase() })) } })
    emit({ requestId: agent.run!.id, kind: 'done' })
    const edit = agent.conversation.messages.at(-1)!.edit!
    const ids = edit.changes.map(c => c.id)
    expect(new Set(ids).size).toBe(3)
    agent.apply(edit, 0); agent.dismiss(edit, 1)
    agent.setReviewReason(edit, 1, '保留原来的语气 "two"')
    await agent.send('continue')
    let request = transport.start.mock.calls.at(-1)![0]
    expect(request.context.markdown).toBe('ONE two three')
    let feedback = JSON.parse(request.messages[1].content.split('[User review feedback]\n')[1])
    expect(feedback.changes).toEqual([
      { id: ids[0], status: 'applied', oldText: 'one', newText: 'ONE' },
      { id: ids[1], status: 'dismissed', oldText: 'two', newText: 'TWO', reason: '保留原来的语气 "two"' },
      { id: ids[2], status: 'pending', oldText: 'three', newText: 'THREE' },
    ])
    emit({ requestId: agent.run!.id, kind: 'done' })
    agent.revert(edit, 0)
    await agent.send('continue again')
    request = transport.start.mock.calls.at(-1)![0]
    feedback = JSON.parse(request.messages[1].content.split('[User review feedback]\n')[1])
    expect(feedback.changes[0]).toMatchObject({ id: ids[0], status: 'reverted' })
    expect(feedback.changes[1]).toMatchObject({ id: ids[1], status: 'dismissed' })
  })
  it('rewrites a rejected item against the updated selected scope while keeping accepted changes', async () => {
    const editor = useEditorStore(), agent = useAgentStore()
    const tab = editor.newUntitledTab('outside\none two\nprivate')
    editor.registerAgentEditHandler('wysiwyg', text => editor.setMarkdownExternal(tab.id, text))
    agent.selection = { tabId: tab.id, name: 'note', markdown: tab.markdown, from: 8, to: 15 }
    await agent.send('edit')
    emit({ requestId: agent.run!.id, kind: 'proposal', proposal: { title: 'Batch', changes: [{ oldText: 'one', newText: 'one expanded' }, { oldText: 'two', newText: 'TWO' }] } })
    emit({ requestId: agent.run!.id, kind: 'done' })
    const edit = agent.conversation.messages.at(-1)!.edit!
    agent.apply(edit, 0); agent.dismiss(edit, 1); agent.setReviewReason(edit, 1, '更口语一些')
    await agent.rewrite(edit, 1)
    const request = transport.start.mock.calls.at(-1)![0]
    expect(request.context.markdown).toBe('one expanded two')
    expect(request.messages.at(-1).content).toContain(edit.changes[1]!.id)
    expect(request.messages.at(-1).content).toContain('更口语一些')
    expect(tab.markdown).toBe('outside\none expanded two\nprivate')
    emit({ requestId: agent.run!.id, kind: 'done' })
    editor.setMarkdownExternal(tab.id, 'manually changed')
    await agent.rewrite(edit, 1)
    expect(transport.start).toHaveBeenCalledTimes(2)
  })
  it('counts review payloads in context limits before mutating the conversation', async () => {
    const editor = useEditorStore(), agent = useAgentStore()
    editor.newUntitledTab('one')
    await agent.send('edit')
    emit({ requestId: agent.run!.id, kind: 'proposal', proposal: { title: 'Large', oldText: 'one', newText: 'x'.repeat(80_000) } })
    emit({ requestId: agent.run!.id, kind: 'done' })
    await agent.send('continue')
    expect(transport.start).toHaveBeenCalledOnce()
    expect(agent.conversation.messages).toHaveLength(2)
    expect(agent.error).not.toBe('')
  })
  it('applies a batch in one editor transaction and keeps dismissed changes out', async () => {
    const editor = useEditorStore(), agent = useAgentStore()
    const tab = editor.newUntitledTab('one two three')
    const handler = vi.fn((text: string) => editor.setMarkdownExternal(tab.id, text))
    editor.registerAgentEditHandler('wysiwyg', handler)
    await agent.send('edit')
    const id = agent.run!.id
    emit({ requestId: id, kind: 'proposal', proposal: { title: 'Batch', changes: ['one', 'two', 'three'].map(oldText => ({ oldText, newText: oldText.toUpperCase() })) } })
    emit({ requestId: id, kind: 'done' })
    const edit = agent.conversation.messages.at(-1)!.edit!
    agent.dismiss(edit, 1)
    agent.apply(edit)
    expect(handler).toHaveBeenCalledOnce()
    expect(tab.markdown).toBe('ONE two THREE')
    expect(edit.changes.map(c => c.status)).toEqual(['applied', 'dismissed', 'applied'])
    agent.revert(edit)
    expect(tab.markdown).toBe('one two three')
  })
  it('requires explicit apply and refuses stale documents, then supports exact revert', async () => {
    const editor = useEditorStore(), agent = useAgentStore()
    const tab = editor.newUntitledTab('hello world')
    editor.registerAgentEditHandler('wysiwyg', text => editor.setMarkdownExternal(tab.id, text))
    await agent.send('polish')
    const id = agent.run!.id
    emit({ requestId: id, kind: 'proposal', proposal: { title: 'Polish', oldText: 'hello', newText: 'Hello' } })
    const edit = agent.conversation.messages.at(-1)!.edit!
    expect(tab.markdown).toBe('hello world')
    agent.apply(edit)
    expect(tab.markdown).toBe('hello world') // no applying while streaming
    emit({ requestId: id, kind: 'done' })
    editor.setMarkdownExternal(tab.id, 'my edit')
    agent.apply(edit)
    expect(tab.markdown).toBe('my edit')
    expect(edit.status).toBe('pending')
    editor.setMarkdownExternal(tab.id, 'hello world')
    agent.apply(edit)
    expect(tab.markdown).toBe('Hello world')
    expect(edit.status).toBe('applied')
    agent.revert(edit)
    expect(tab.markdown).toBe('hello world')
    expect(edit.status).toBe('reverted')
  })
  it('isolates document conversations and does not attach a document when unchecked', async () => {
    const editor = useEditorStore(), agent = useAgentStore()
    const first = editor.newUntitledTab('private first document')
    agent.includeDocument = false
    await agent.send('hello')
    const id = agent.run!.id
    expect(transport.start.mock.calls[0]![0].context).toBeNull()
    editor.newUntitledTab('second')
    expect(agent.conversation.messages).toHaveLength(0)
    emit({ requestId: id, kind: 'delta', text: 'first reply' })
    emit({ requestId: id, kind: 'done' })
    expect(agent.conversation.messages).toHaveLength(0)
    editor.setCurrent(first.id)
    expect(agent.conversation.messages.at(-1)?.content).toBe('first reply')
  })
  it('drops proposals on interrupted runs and ignores late events', async () => {
    useEditorStore().newUntitledTab('text')
    const agent = useAgentStore()
    await agent.send('edit')
    const id = agent.run!.id
    emit({ requestId: id, kind: 'proposal', proposal: { title: 'Edit', oldText: 'text', newText: 'next' } })
    emit({ requestId: id, kind: 'cancelled' })
    emit({ requestId: id, kind: 'delta', text: 'late' })
    expect(agent.busy).toBe(false)
    expect(agent.conversation.messages.at(-1)!.edit).toBeUndefined()
    expect(agent.conversation.messages.at(-1)!.content).toBe('')
  })
  it('waits for start acknowledgement before cancelling', async () => {
    useEditorStore().newUntitledTab('text')
    let resolveStart!: () => void
    transport.start.mockImplementation(() => new Promise<void>(resolve => { resolveStart = resolve }))
    const agent = useAgentStore()
    const send = agent.send('hello')
    await vi.waitFor(() => expect(transport.start).toHaveBeenCalledOnce())
    const stop = agent.stop()
    expect(transport.cancel).not.toHaveBeenCalled()
    resolveStart()
    await send; await stop
    expect(transport.cancel).toHaveBeenCalledWith(agent.run!.id)
  })
})
