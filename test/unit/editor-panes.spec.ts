import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'

const invokeMocks = vi.hoisted(() => ({
  readMarkdown: vi.fn(), localHistoryCapture: vi.fn(), saveMarkdown: vi.fn(), saveAsDialog: vi.fn(),
  renameFile: vi.fn(), pushRecentPath: vi.fn(), getPreferences: vi.fn(), setPreference: vi.fn(),
  setPreferences: vi.fn(), getUserData: vi.fn(), setUserData: vi.fn(),
}))
const confirm = vi.hoisted(() => vi.fn())

vi.mock('@/services/tauri-invoke', () => invokeMocks)
vi.mock('element-plus', () => ({ ElMessageBox: { confirm }, ElNotification: vi.fn() }))

import { usePaneEditor } from '../../src/services/editor-panes'
import { useEditorStore } from '../../src/stores/editor'
import { usePreferencesStore } from '../../src/stores/preferences'

describe('pane editor activation', () => {
  it('rejects a delayed hidden Muya baseline after a source edit', () => {
    const editor = useEditorStore(); const tab = editor.newUntitledTab('initial content')
    editor.sourceCodeMode = true; editor.panes[0].sourceMode = true
    const scope = effectScope(); const adapter = scope.run(() => usePaneEditor('main'))!.editor
    editor.setMarkdownExternal(tab.id, 'initial content plus source edit')
    adapter.applyContentChange(tab.id, 'initial content\n', { cursor: { stale: true } })
    expect(tab.markdown).toBe('initial content plus source edit')
    expect(tab.isSaved).toBe(false)
    scope.stop()
  })
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    usePreferencesStore().autoSave = false
  })

  it('does not leave the previous pane Muya instance active while the new pane is still mounting', () => {
    const editor = useEditorStore()
    editor.newUntitledTab('first document')
    const previousMuya = { getCursor: vi.fn(() => ({ anchor: { line: 0, ch: 0 }, focus: { line: 0, ch: 0 } })) }
    editor.setMuyaInstance(previousMuya)
    editor.splitPane('horizontal')

    const nextPane = editor.panes[1]!
    const scope = effectScope()
    scope.run(() => usePaneEditor(nextPane.id))
    editor.activatePane(nextPane.id)

    expect(editor.getMuyaInstance()).toBeNull()
    scope.stop()
  })

  it('restores the selected source pane Muya instance so HTML export still targets that document', () => {
    const editor = useEditorStore()
    editor.newUntitledTab('first document')
    editor.splitPane('horizontal')
    const nextPane = editor.panes[1]!
    const scope = effectScope()
    const paneEditor = scope.run(() => usePaneEditor(nextPane.id))!.editor
    const targetMuya = { getMarkdown: vi.fn(() => 'second document') }
    paneEditor.setMuyaInstance(targetMuya)
    nextPane.sourceMode = true

    editor.activatePane(nextPane.id)

    expect(editor.getMuyaInstance()).toBe(targetMuya)
    scope.stop()
  })

  it('keeps document edits from a finishing pane update while preserving the active pane cursor', () => {
    const editor = useEditorStore()
    const tab = editor.newUntitledTab('before')
    editor.splitPane('horizontal')
    const mainScope = effectScope()
    const nextScope = effectScope()
    const mainEditor = mainScope.run(() => usePaneEditor('main'))!.editor
    const nextPane = editor.panes[1]!
    const nextEditor = nextScope.run(() => usePaneEditor(nextPane.id))!.editor
    const mainCursor = { anchor: { line: 0, ch: 2 }, focus: { line: 0, ch: 2 } }
    const nextCursor = { anchor: { line: 0, ch: 4 }, focus: { line: 0, ch: 4 } }

    mainEditor.applyContentChange(tab.id, 'main edit', { cursor: mainCursor })
    nextEditor.currentFile!.cursor = nextCursor
    editor.activatePane(nextPane.id)
    mainEditor.applyContentChange(tab.id, 'late main edit', { cursor: mainCursor })

    expect(tab.markdown).toBe('late main edit')
    expect(tab.cursor).toEqual(nextCursor)
    mainScope.stop()
    nextScope.stop()
  })

  it('rejects an async insertion after the active pane or source mode changes', async () => {
    const editor = useEditorStore()
    const tab = editor.newUntitledTab('same document')
    editor.splitPane('horizontal')
    const nextPane = editor.panes[1]!
    const mainHandler = vi.fn()
    const nextHandler = vi.fn()
    editor.registerInsertHandler('wysiwyg', mainHandler, 'main')
    editor.registerInsertHandler('wysiwyg', nextHandler, nextPane.id)
    const captured = { paneId: 'main', sourceMode: false }

    editor.activatePane(nextPane.id)
    await expect(editor.insertText(tab.id, 'inserted', captured)).rejects.toThrow('agent:conflict')
    expect(mainHandler).not.toHaveBeenCalled()
    expect(nextHandler).not.toHaveBeenCalled()

    editor.activatePane('main')
    editor.sourceCodeMode = true
    await expect(editor.insertText(tab.id, 'inserted', captured)).rejects.toThrow('agent:conflict')
    expect(mainHandler).not.toHaveBeenCalled()
  })

  it('invalidates every pane view when a document reset is followed by a new active source state', () => {
    const editor = useEditorStore()
    const tab = editor.newUntitledTab('before external reload')
    editor.splitPane('horizontal')
    const mainScope = effectScope()
    const nextScope = effectScope()
    const mainEditor = mainScope.run(() => usePaneEditor('main'))!.editor
    const nextPane = editor.panes[1]!
    const nextEditor = nextScope.run(() => usePaneEditor(nextPane.id))!.editor
    const oldMainState = { doc: 'old main state' }
    const oldNextState = { doc: 'old second-pane state' }
    const newSourceState = { doc: 'fresh state after reload' }

    mainEditor.currentFile!.sourceEditorState = oldMainState
    nextEditor.currentFile!.sourceEditorState = oldNextState
    editor.resetSharedHistory(tab.id)
    mainEditor.currentFile!.sourceEditorState = newSourceState
    editor.activatePane(nextPane.id)

    expect(nextEditor.currentFile!.sourceEditorState).toEqual(newSourceState)
    mainScope.stop()
    nextScope.stop()
  })

  it('does not let shared undo restore a pre-reload document over the disk version', async () => {
    const editor = useEditorStore()
    const tab = editor.newUntitledTab('disk baseline')
    tab.pathname = 'C:\\Notes\\history.md'
    tab.filename = 'history.md'
    tab.isSaved = true
    tab.lastSavedMarkdown = tab.markdown
    editor.splitPane('horizontal')
    editor.registerAgentEditHandler('wysiwyg', markdown => editor.setMarkdownExternal(tab.id, markdown))

    editor.setMarkdownExternal(tab.id, 'local edit')
    tab.isSaved = true
    tab.lastSavedMarkdown = tab.markdown
    invokeMocks.readMarkdown.mockResolvedValue({
      path: tab.pathname,
      markdown: 'external version',
      encoding: 'UTF-8',
      lineEnding: 'lf',
      hadDecodeErrors: false,
      bom: false,
    })
    await editor.handleFileWatchEvent({ kind: 'modified', path: tab.pathname })

    expect(tab.markdown).toBe('external version')
    expect(editor.hasSharedHistoryStep('undo')).toBe(false)
    editor.stepSharedHistory('undo')
    expect(tab.markdown).toBe('external version')
  })

  it('keeps shared undo available until the active pane edit handler is ready', () => {
    const editor = useEditorStore()
    const tab = editor.newUntitledTab('before')
    editor.splitPane('horizontal')
    editor.setMarkdownExternal(tab.id, 'after')
    expect(editor.hasSharedHistoryStep('undo')).toBe(true)

    editor.stepSharedHistory('undo')
    expect(tab.markdown).toBe('after')
    expect(editor.hasSharedHistoryStep('undo')).toBe(true)

    editor.registerAgentEditHandler('wysiwyg', markdown => editor.setMarkdownExternal(tab.id, markdown))
    editor.stepSharedHistory('undo')
    expect(tab.markdown).toBe('before')
    expect(editor.hasSharedHistoryStep('redo')).toBe(true)
  })
})
