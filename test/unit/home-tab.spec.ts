import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const io = vi.hoisted(() => ({ readMarkdown: vi.fn(), saveMarkdown: vi.fn(), saveAsDialog: vi.fn() }))
vi.mock('@/services/tauri-invoke', () => io)
vi.mock('element-plus', () => ({ ElMessageBox: { confirm: vi.fn() }, ElNotification: vi.fn() }))

import { HOME_TAB_ID, useEditorStore } from '../../src/stores/editor'
import { buildEditorSessionSnapshot } from '../../src/services/editor-session'

describe('Start workspace tab', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('clears document context without adding a document or saving the dirty buffer', async () => {
    const editor = useEditorStore()
    const draft = editor.newUntitledTab('# Draft\n\nUnsaved text')
    editor.listToc = [{ lvl: 1, content: 'Draft' }]
    editor.currentSelectionFormats = ['strong']
    editor.findReplaceOpen = true
    editor.openHomeTab()
    editor.openHomeTab()

    expect(editor.activeTabId).toBe(HOME_TAB_ID)
    expect(editor.currentFileId).toBeNull()
    expect(editor.currentFile).toBeNull()
    expect(editor.toc).toEqual([])
    expect(editor.currentSelectionFormats).toEqual([])
    expect(editor.findReplaceOpen).toBe(false)
    expect(editor.tabs.map(tab => tab.id)).toEqual([draft.id])
    expect(editor.hasUnsaved).toBe(true)
    expect(await editor.saveCurrent()).toBe(false)
    expect(io.saveMarkdown).not.toHaveBeenCalled()
    const session = buildEditorSessionSnapshot({ tabs: editor.tabs, currentFileId: editor.sessionCurrentFileId, cleanShutdown: false, excludeDirty: false })
    expect(session.tabs).toHaveLength(1)
    expect(session.tabs[0]).toMatchObject({ markdown: draft.markdown })
    expect(session.activeTabIndex).toBe(0)
    expect(editor.sessionPanes[0].documentId).toBe(draft.id)
    expect(await editor.closeTab(HOME_TAB_ID)).toBe(true)
    expect(editor.currentFile?.id).toBe(draft.id)
    expect(editor.currentFile?.isSaved).toBe(false)
  })

  it('reselects an already-open file and closes a background Start tab without changing documents', async () => {
    const editor = useEditorStore()
    const tab = editor.newUntitledTab('Document')
    tab.pathname = 'C:/notes/document.md'
    editor.openHomeTab()
    await editor.openFile(tab.pathname)
    expect(editor.homeActive).toBe(false)
    expect(editor.homeTabOpen).toBe(true)
    expect(editor.currentFile?.id).toBe(tab.id)
    expect(io.readMarkdown).not.toHaveBeenCalled()
    editor.closeHomeTab()
    expect(editor.currentFile?.id).toBe(tab.id)
  })

  it('keeps Start selected on an open failure and when its previous document closes', async () => {
    const editor = useEditorStore()
    const first = editor.newUntitledTab('First')
    const previous = editor.newUntitledTab('Previous')
    editor.openHomeTab()
    io.readMarkdown.mockRejectedValueOnce(new Error('Missing file'))
    await expect(editor.openFile('C:/missing.md')).rejects.toThrow('Missing file')
    expect(editor.homeActive).toBe(true)
    await editor.closeTab(previous.id, true)
    expect(editor.homeActive).toBe(true)
    editor.closeHomeTab()
    expect(editor.currentFile?.id).toBe(first.id)
  })

  it('selects the open Start tab after closing the last document', async () => {
    const editor = useEditorStore()
    editor.openHomeTab()
    const draft = editor.newUntitledTab('Last')
    await editor.closeTab(draft.id, true)
    expect(editor.activeTabId).toBe(HOME_TAB_ID)
    editor.closeHomeTab()
    expect(editor.activeTabId).toBeNull()
    expect(editor.tabs).toEqual([])
  })
})
