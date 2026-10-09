import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { reviewFeedback, reviewProposal, reviewedMarkdown, type AgentEvent } from '../../src/services/agent'
import { rebasePendingReview, refreshedReviewSnapshot } from '../../src/services/agent-rebase'
import { t } from '../../src/i18n'

const transport = vi.hoisted(() => ({ start: vi.fn(), cancel: vi.fn(), listen: vi.fn() }))
vi.mock('@/services/agent-transport', () => ({ agentTransport: transport }))
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
  usePreferencesStore().autoSave = false
})

function proposal(markdown: string, oldText: string, from = 0, to = markdown.length) {
  return reviewProposal({ tabId: 'doc', name: 'note', markdown, from, to }, { title: 'Edit', oldText, newText: oldText.toUpperCase() })
}

describe('Conservative review relocation', () => {
  it('relocates a tail after edits to the opening and requires a fresh snapshot', () => {
    const edit = proposal('opening\n\ntail 😀text', 'tail 😀text')
    const current = 'a longer opening\n\ntail 😀text'
    const result = rebasePendingReview(edit, current)
    expect(result.conflicts).toEqual([])
    expect(result.edit!.snapshot.markdown).toBe(current)
    expect(result.edit!.changes[0]).toMatchObject({ from: current.indexOf('tail'), to: current.length, status: 'pending',
      anchor: { snapshotId: result.edit!.snapshot.snapshotId, from: current.indexOf('tail'), to: current.length } })
    expect(reviewedMarkdown(result.edit!, [0])).toBe('a longer opening\n\nTAIL 😀TEXT')
    expect(edit.changes[0]!.status).toBe('pending')
  })

  it('rejects edits anywhere in the same paragraph, including a table row', () => {
    for (const [old, current, target] of [
      ['opening\n\nparagraph one\nparagraph two', 'new opening\n\nparagraph changed\nparagraph two', 'paragraph two'],
      ['| a | b |\n| 1 | 2 |', '| a | b |\n| 3 | 2 |', 'b'],
    ]) {
      const edit = proposal(old!, target!)
      expect(rebasePendingReview(edit, current!).conflicts).toEqual([edit.changes[0]!.id])
    }
  })

  it('never relocates a deleted repeated paragraph or an ambiguous paragraph order', () => {
    const markdown = 'same\n\nsame\n\ntail'
    const from = 6, to = 10
    const edit = reviewProposal({ tabId: 'doc', name: 'note', markdown, from: 0, to: markdown.length, snapshotId: 'original' },
      { title: 'Second same', changes: [{ oldText: 'same', newText: 'SECOND', anchor: { snapshotId: 'original', from, to } }] })
    expect(rebasePendingReview(edit, 'same\n\ntail').edit).toBeNull()
    const reordered = proposal('alpha\n\nbeta\n\ntail', 'alpha')
    expect(rebasePendingReview(reordered, 'beta\n\nalpha\n\ntail').edit).toBeNull()
    // A missing final separator must not make identical paragraphs appear unique.
    const ending = 'same\n\nsame'
    const last = reviewProposal({ tabId: 'doc', name: 'note', markdown: ending, from: 0, to: ending.length, snapshotId: 'ending' },
      { title: 'Last same', changes: [{ oldText: 'same', newText: 'LAST', anchor: { snapshotId: 'ending', from: 6, to: 10 } }] })
    expect(rebasePendingReview(last, 'same').edit).toBeNull()
  })

  it('moves only pending changes while composing from accepted edits', () => {
    const markdown = 'opening\n\naccepted\n\ndismissed\n\nreverted\n\npending'
    const edit = reviewProposal({ tabId: 'doc', name: 'note', markdown, from: 0, to: markdown.length }, { title: 'All', changes:
      ['accepted', 'dismissed', 'reverted', 'pending'].map(oldText => ({ oldText, newText: oldText.toUpperCase() })) })
    edit.changes[0]!.status = 'applied'; edit.changes[1]!.status = 'dismissed'; edit.changes[2]!.status = 'reverted'
    const current = reviewedMarkdown(edit, [0]).replace('opening', 'my opening')
    const result = rebasePendingReview(edit, current)
    expect(result.edit!.changes).toHaveLength(1)
    expect(result.edit!.changes[0]!.oldText).toBe('pending')
    expect(reviewedMarkdown(result.edit!, [0])).toBe('my opening\n\nACCEPTED\n\ndismissed\n\nreverted\n\nPENDING')
  })

  it('returns safe pending edits alongside conflicts without reviving other decisions', () => {
    const markdown = 'opening\n\nconflicting target\n\nsafe tail'
    const edit = reviewProposal({ tabId: 'doc', name: 'note', markdown, from: 0, to: markdown.length }, {
      title: 'Two changes', changes: [{ oldText: 'target', newText: 'TARGET' }, { oldText: 'tail', newText: 'TAIL' }],
    })
    const result = rebasePendingReview(edit, 'opening\n\nchanged target\n\nsafe tail')
    expect(result.conflicts).toEqual([edit.changes[0]!.id])
    expect(result.edit!.changes).toHaveLength(1)
    expect(result.edit!.changes[0]!.oldText).toBe('tail')
  })

  it('retains explicit ancestry with bounded IDs through repeated relocation', () => {
    const original = proposal('opening\n\ntail', 'tail')
    const first = rebasePendingReview(original, 'changed opening\n\ntail').edit!
    const second = rebasePendingReview(first, 'changed again\n\ntail').edit!
    expect(second.changes[0]!.sourceChangeIds).toEqual([original.changes[0]!.id, first.changes[0]!.id])
    expect(second.changes[0]!.id.length).toBeLessThan(80)
    second.changes[0]!.sourceChangeIds = Array.from({ length: 64 }, (_, i) => `prior:${i}`)
    expect(rebasePendingReview(second, 'third opening\n\ntail').edit).toBeNull()
  })

  it('does not include an already applied adjacent insertion in a pending replacement', () => {
    const markdown = 'opening\n\ntail'
    const edit = reviewProposal({ tabId: 'doc', name: 'note', markdown, from: 0, to: markdown.length }, {
      title: 'Tail and append', changes: [{ oldText: 'tail', newText: 'TAIL' }, { oldText: '', newText: ' APPENDED' }],
    })
    edit.changes[1]!.status = 'applied'
    const result = rebasePendingReview(edit, 'my opening\n\ntail APPENDED')
    expect(result.conflicts).toEqual([])
    expect(reviewedMarkdown(result.edit!, [0])).toBe('my opening\n\nTAIL APPENDED')
  })

  it('preserves selected scope and rejects changed selected paragraphs', () => {
    const original = 'private opening\n\nselected tail'
    const edit = proposal(original, 'selected tail', original.indexOf('selected'), original.length)
    const current = 'new private opening\n\nselected tail'
    const refreshed = refreshedReviewSnapshot(edit, current)!
    expect(current.slice(refreshed.from, refreshed.to)).toBe('selected tail')
    expect(refreshed.from).toBeGreaterThan(0)
    expect(refreshedReviewSnapshot(edit, current + ' changed')).toBeNull()
  })

  it('bounds huge inputs without a quadratic diff or stack overflow', () => {
    const edit = proposal('opening\n\ntail', 'tail')
    expect(rebasePendingReview(edit, 'x'.repeat(2_000_001)).edit).toBeNull()
    expect(rebasePendingReview(edit, 'a\n\n'.repeat(11_000)).edit).toBeNull()
  })
})

describe('Expired review requests', () => {
  async function createReview(markdown = 'opening\n\ntail', selected = false) {
    const editor = useEditorStore(), agent = useAgentStore()
    const tab = editor.newUntitledTab(markdown)
    editor.registerAgentEditHandler('wysiwyg', text => editor.setMarkdownExternal(tab.id, text))
    if (selected) agent.selection = { tabId: tab.id, name: 'note', markdown, from: markdown.indexOf('tail'), to: markdown.length }
    await agent.send('polish the ending')
    emit({ requestId: agent.run!.id, kind: 'proposal', proposal: { title: 'Tail', oldText: 'tail', newText: 'TAIL' } })
    emit({ requestId: agent.run!.id, kind: 'done' })
    return { editor, agent, tab, edit: agent.conversation.messages.at(-1)!.edit! }
  }

  it('marks edits stale before the first proposal arrives', async () => {
    const editor = useEditorStore(), agent = useAgentStore()
    const tab = editor.newUntitledTab('opening\n\ntail')
    await agent.send('polish')
    editor.setMarkdownExternal(tab.id, 'my opening\n\ntail')
    emit({ requestId: agent.run!.id, kind: 'proposal', proposal: { title: 'Tail', oldText: 'tail', newText: 'TAIL' } })
    expect(agent.conversation.messages.at(-1)!.edit!.documentChanged).toBe(true)
  })

  it('creates a new card without applying, and keeps the superseded card read-only after undo', async () => {
    const { editor, agent, tab, edit } = await createReview()
    editor.setMarkdownExternal(tab.id, 'my opening\n\ntail')
    expect(edit.documentChanged).toBe(true)
    agent.apply(edit)
    expect(tab.markdown).toBe('my opening\n\ntail')
    agent.rebaseReview(edit)
    const relocated = agent.conversation.messages.at(-1)!.edit!
    expect(edit.rebasedTo).toBeTruthy()
    const feedback = JSON.parse(reviewFeedback(edit).split('[User review feedback]\n')[1]!)
    expect(feedback.supersededBy).toBe(edit.rebasedTo)
    expect(feedback.changes[0]!.status).toBe('superseded')
    expect(tab.markdown).toBe('my opening\n\ntail')
    agent.apply(relocated)
    expect(tab.markdown).toBe('my opening\n\nTAIL')
    editor.setMarkdownExternal(tab.id, edit.snapshot.markdown)
    agent.apply(edit)
    expect(tab.markdown).toBe(edit.snapshot.markdown)
    agent.rebaseReview(edit)
    expect(agent.conversation.messages).toHaveLength(3)
  })

  it('regenerates the current selected text without sending surrounding private text', async () => {
    const { editor, agent, tab, edit } = await createReview('private opening\n\ntail', true)
    editor.setMarkdownExternal(tab.id, 'changed private opening\n\ntail')
    await agent.regenerateReview(edit)
    const request = transport.start.mock.calls.at(-1)![0]
    expect(request.context.markdown).toBe('tail')
    expect(request.context.snapshotId).toBe(request.requestId)
    expect(request.context.offset).toBe(tab.markdown.indexOf('tail'))
    expect(agent.run!.snapshot!.from).toBe(tab.markdown.indexOf('tail'))
    expect(request.messages.at(-1)!.content).toContain('polish the ending')
  })

  it('requires reselection after selected text changes and rejects revoked or cross-document context', async () => {
    const { editor, agent, tab, edit } = await createReview('private opening\n\ntail', true)
    editor.setMarkdownExternal(tab.id, 'private opening\n\nchanged tail')
    await agent.regenerateReview(edit)
    expect(transport.start).toHaveBeenCalledTimes(1)
    expect(agent.error).toBe(t('agent.errors.reviewSelectionChanged'))
    agent.includeDocument = false
    await agent.regenerateReview(edit)
    expect(transport.start).toHaveBeenCalledTimes(1)
    editor.newUntitledTab('other')
    await agent.regenerateReview(edit)
    agent.rebaseReview(edit)
    expect(transport.start).toHaveBeenCalledTimes(1)
    expect(agent.conversation.messages).toHaveLength(0)
  })

  it('respects a narrower current selection when regenerating an old full-document request', async () => {
    const { editor, agent, tab, edit } = await createReview('private opening\n\ntail')
    editor.setMarkdownExternal(tab.id, 'my private opening\n\ntail')
    agent.selection = { tabId: tab.id, name: 'note', markdown: tab.markdown, from: tab.markdown.indexOf('tail'), to: tab.markdown.length }
    await agent.regenerateReview(edit)
    expect(transport.start.mock.calls.at(-1)![0].context.markdown).toBe('tail')
  })

  it('accepts an explicit fresh selection after the original selected paragraph changes', async () => {
    const { editor, agent, tab, edit } = await createReview('private opening\n\ntail', true)
    editor.setMarkdownExternal(tab.id, 'private opening\n\nchanged tail')
    await agent.regenerateReview(edit)
    expect(agent.error).toBe(t('agent.errors.reviewSelectionChanged'))
    expect(transport.start).toHaveBeenCalledTimes(1)
    editor.sourceCodeMode = true
    tab.sourceSelection = { ranges: [{ anchor: tab.markdown.indexOf('changed'), head: tab.markdown.length }], main: 0 }
    agent.attachSelection()
    await agent.regenerateReview(edit)
    expect(transport.start).toHaveBeenCalledTimes(2)
    const request = transport.start.mock.calls.at(-1)![0]
    expect(request.context.markdown).toBe('changed tail')
    expect(agent.run!.snapshot!.from).toBe(tab.markdown.indexOf('changed'))
    expect(agent.run!.snapshot!.to).toBe(tab.markdown.length)
    expect(agent.error).toBe('')
  })
})
