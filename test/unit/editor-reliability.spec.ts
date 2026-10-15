import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const invokeMocks = vi.hoisted(() => ({
  readMarkdown: vi.fn(),
  localHistoryCapture: vi.fn(),
  saveMarkdown: vi.fn(),
  saveAsDialog: vi.fn(),
  renameFile: vi.fn(),
  pushRecentPath: vi.fn(),
  getPreferences: vi.fn(),
  setPreference: vi.fn(),
  setPreferences: vi.fn(),
  getUserData: vi.fn(),
  setUserData: vi.fn(),
}))
const confirm = vi.hoisted(() => vi.fn())
const notification = vi.hoisted(() => vi.fn())

vi.mock('@/services/tauri-invoke', () => invokeMocks)
vi.mock('element-plus', () => ({
  ElMessageBox: { confirm },
  ElNotification: notification,
}))

import {
  classifyExternalMarkdown,
  pathsReferToSameFile,
  useEditorStore,
} from '../../src/stores/editor'
import { getFileStateFromData } from '../../src/stores/help'

function openedFile(markdown = 'disk baseline') {
  return getFileStateFromData({
    markdown,
    pathname: 'C:\\notes\\draft.md',
    filename: 'draft.md',
    encoding: { encoding: 'utf8', isBom: false },
    lineEnding: 'lf',
  })
}

function loaded(markdown: string) {
  return {
    path: 'C:\\notes\\draft.md',
    markdown,
    encoding: 'UTF-8',
    lineEnding: 'lf',
    hadDecodeErrors: false,
    bom: false,
  }
}

describe('editor reliability', () => {
  it('rejects a file read that outlives a completed reference mutation or its initiating pane', async () => {
    const editor = useEditorStore(); const tab = openedFile()
    editor.tabs = [tab]; editor.setCurrent(tab.id)
    let finishRead!: (value: ReturnType<typeof loaded>) => void
    invokeMocks.readMarkdown.mockImplementation(() => new Promise(resolve => { finishRead = resolve }))
    const opening = editor.openFile('C:/notes/ref.md')
    await editor.beginFileMutation(); editor.endFileMutation()
    finishRead({ ...loaded('old reference'), path: 'C:/notes/ref.md' })
    await expect(opening).rejects.toThrow('notes.changed')
    expect(editor.tabs).toHaveLength(1)
    const anotherOpening = editor.openFile('C:/notes/ref.md')
    editor.splitPane('horizontal'); editor.activatePane(editor.panes[1].id)
    finishRead({ ...loaded('old reference'), path: 'C:/notes/ref.md' })
    await expect(anotherOpening).rejects.toThrow('notes.changed')
    expect(editor.tabs).toHaveLength(1)
  })
  it('drains in-flight saves and rejects new writes and Agent edits during a file transaction', async () => {
    const editor = useEditorStore(); const tab = openedFile()
    editor.tabs = [tab]; editor.setCurrent(tab.id)
    let finishWrite!: () => void
    invokeMocks.saveMarkdown.mockImplementationOnce(() => new Promise<void>(resolve => { finishWrite = resolve }))
    const saving = editor.saveTab(tab)
    await vi.waitFor(() => expect(finishWrite).toBeTypeOf('function'))
    let acquired = false
    const mutation = editor.beginFileMutation().then(() => { acquired = true })
    expect(editor.fileMutationBusy).toBe(true)
    expect(await editor.saveTabAs(tab, 'C:/notes/copy.md')).toBe(false)
    expect(() => editor.applyAgentEdit(tab.id, tab.markdown, 'unsafe')).toThrow('notes.changed')
    await expect(editor.insertText(tab.id, 'unsafe')).rejects.toThrow('notes.changed')
    expect(acquired).toBe(false)
    finishWrite(); expect(await saving).toBe(true); await mutation
    expect(acquired).toBe(true); expect(invokeMocks.saveMarkdown).toHaveBeenCalledOnce()
    editor.endFileMutation(); expect(editor.fileMutationBusy).toBe(false)
    expect(await editor.saveTab(tab)).toBe(true)
  })
  it('keeps initial restored content dirty and lets Cancel prevent closing it', async () => {
    const editor = useEditorStore(); const tab = editor.newUntitledTab('restored history content')
    expect(tab.isSaved).toBe(false); expect(tab.lastSavedMarkdown).toBe('')
    confirm.mockRejectedValue('close')
    expect(await editor.closeTab(tab.id)).toBe(false)
    expect(editor.tabs[0].markdown).toBe('restored history content')
  })
  it('does not block a normal file save when independent history storage fails', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    try {
      const editor = useEditorStore(); const tab = openedFile(); editor.tabs = [tab]; editor.setCurrent(tab.id)
      tab.markdown = 'updated content'; tab.isSaved = false
      invokeMocks.readMarkdown.mockResolvedValue(loaded('disk baseline'))
      invokeMocks.localHistoryCapture.mockRejectedValue(new Error('history snapshot exceeds 4 MiB'))
      invokeMocks.saveMarkdown.mockResolvedValue(undefined)
      expect(await editor.saveTab(tab)).toBe(true)
      expect(invokeMocks.saveMarkdown).toHaveBeenCalledOnce()
    } finally { vi.unstubAllGlobals() }
  })
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    invokeMocks.saveMarkdown.mockResolvedValue(undefined)
    invokeMocks.pushRecentPath.mockResolvedValue([])
  })

  it('compares Windows paths without slash or drive-letter false negatives', () => {
    expect(pathsReferToSameFile('C:\\Notes\\Draft.md', 'c:/notes/draft.md')).toBe(true)
    expect(pathsReferToSameFile('/notes/Draft.md', '/notes/draft.md')).toBe(false)
  })

  it('distinguishes delayed self-save events from real external conflicts', () => {
    expect(classifyExternalMarkdown('base', 'local edit', 'base')).toBe('unchanged-on-disk')
    expect(classifyExternalMarkdown('base', 'local edit', 'local edit')).toBe('matches-editor')
    expect(classifyExternalMarkdown('base', 'local edit', 'external edit')).toBe('conflict')
  })

  it('reloads a clean open tab when its disk content changes', async () => {
    const editor = useEditorStore()
    const tab = openedFile()
    editor.tabs.push(tab)
    editor.currentFileId = tab.id
    invokeMocks.readMarkdown.mockResolvedValue(loaded('external edit'))

    await editor.handleFileWatchEvent({ kind: 'modified', path: 'c:/NOTES/draft.md' })

    expect(tab.markdown).toBe('external edit')
    expect(tab.lastSavedMarkdown).toBe('external edit')
    expect(tab.isSaved).toBe(true)
    expect(tab.history.stack).toEqual([])
  })

  it('keeps a dirty local buffer only after an explicit conflict choice', async () => {
    const editor = useEditorStore()
    const tab = openedFile()
    tab.markdown = 'local edit'
    tab.isSaved = false
    editor.tabs.push(tab)
    editor.currentFileId = tab.id
    invokeMocks.readMarkdown.mockResolvedValue(loaded('external edit'))
    confirm.mockRejectedValue('cancel') // cancel button = Keep My Changes

    await editor.handleFileWatchEvent({ kind: 'modified', path: tab.pathname })

    expect(confirm).toHaveBeenCalledOnce()
    expect(tab.markdown).toBe('local edit')
    expect(tab.lastSavedMarkdown).toBe('external edit')
    expect(tab.isSaved).toBe(false)
    expect(tab.externalChange).toBeNull()
    expect(tab.autoSaveBlocked).toBe(true)
  })

  it('keeps an externally removed document as a detached unsaved tab', async () => {
    const editor = useEditorStore()
    const tab = openedFile()
    editor.tabs.push(tab)
    invokeMocks.readMarkdown.mockRejectedValue(new Error('not found'))

    await editor.handleFileWatchEvent({ kind: 'removed', path: tab.pathname })

    expect(tab.pathname).toBe('')
    expect(tab.markdown).toBe('disk baseline')
    expect(tab.isSaved).toBe(false)
  })

  it('offers Save, Don\'t Save, and Cancel for all unsaved tabs', async () => {
    const editor = useEditorStore()
    const first = openedFile('one')
    const second = openedFile('two')
    second.pathname = 'C:\\notes\\second.md'
    first.isSaved = false
    second.isSaved = false
    editor.tabs.push(first, second)

    confirm.mockRejectedValueOnce('close')
    await expect(editor.prepareWindowClose()).resolves.toBe(false)
    expect(invokeMocks.saveMarkdown).not.toHaveBeenCalled()

    confirm.mockRejectedValueOnce('cancel')
    await expect(editor.prepareWindowClose()).resolves.toBe(true)
    expect(invokeMocks.saveMarkdown).not.toHaveBeenCalled()

    confirm.mockResolvedValueOnce('confirm')
    await expect(editor.prepareWindowClose()).resolves.toBe(true)
    expect(invokeMocks.saveMarkdown).toHaveBeenCalledTimes(2)
  })

  it('holds the placeholder bootstrap until startup restoration is complete', () => {
    const editor = useEditorStore()

    editor.bootstrap()
    expect(editor.tabs).toHaveLength(0)

    editor.finishStartupHydration()
    expect(editor.tabs).toHaveLength(1)
    expect(editor.currentFile?.pathname).toBe('')
  })

  it('keeps a changed disk version attached to a recovered draft as a save conflict', () => {
    const editor = useEditorStore()
    const snapshot = {
      dirty: true as const,
      path: 'C:\\notes\\draft.md',
      filename: 'draft.md',
      markdown: 'recovered draft',
      lastSavedMarkdown: 'old baseline',
      encoding: 'utf8',
      bom: false,
      lineEnding: 'lf' as const,
      sourceMode: false,
    }

    const tab = editor.restoreDirtySessionTab(snapshot, false, loaded('new disk'), true)

    expect(tab.markdown).toBe('recovered draft')
    expect(tab.externalChange?.markdown).toBe('new disk')
    expect(tab.autoSaveBlocked).toBe(true)
    expect(tab.isSaved).toBe(false)
  })

  it('restores source mode independently for each tab', () => {
    const editor = useEditorStore()
    editor.finishStartupHydration()
    const first = editor.currentFile!
    editor.toggleSourceCode()
    expect(first.sourceMode).toBe(true)

    const second = editor.newUntitledTab()
    editor.toggleSourceCode()
    expect(second.sourceMode).toBe(false)

    editor.setCurrent(first.id)
    expect(editor.sourceCodeMode).toBe(true)
    editor.setCurrent(second.id)
    expect(editor.sourceCodeMode).toBe(false)
  })

  it('keeps an existing tab identity and draft when Save As fails', async () => {
    const editor = useEditorStore()
    const tab = openedFile('local draft')
    tab.isSaved = false
    editor.tabs.push(tab)
    invokeMocks.saveMarkdown.mockRejectedValueOnce(new Error('disk full'))

    await expect(editor.saveTabAs(tab, 'C:\\notes\\copy.md')).resolves.toBe(false)

    expect(tab.pathname).toBe('C:\\notes\\draft.md')
    expect(tab.filename).toBe('draft.md')
    expect(tab.markdown).toBe('local draft')
    expect(tab.isSaved).toBe(false)
  })

  it('keeps an untitled identity and draft when its picker target cannot be written', async () => {
    const editor = useEditorStore()
    const tab = editor.newUntitledTab('local draft')
    const originalFilename = tab.filename
    invokeMocks.saveAsDialog.mockResolvedValueOnce('C:\\notes\\draft.md')
    invokeMocks.saveMarkdown.mockRejectedValueOnce(new Error('permission denied'))

    await expect(editor.saveTab(tab)).resolves.toBe(false)

    expect(tab.pathname).toBe('')
    expect(tab.filename).toBe(originalFilename)
    expect(tab.markdown).toBe('local draft')
  })

  it('does not commit a Save As target when an external conflict is cancelled', async () => {
    const editor = useEditorStore()
    const tab = openedFile('local draft')
    tab.markdown = 'local edit'
    tab.isSaved = false
    tab.externalChange = {
      kind: 'modified',
      path: tab.pathname,
      markdown: 'external edit',
      encoding: { encoding: 'utf8', isBom: false },
      lineEnding: 'lf',
    }
    editor.tabs.push(tab)
    confirm.mockRejectedValueOnce('close')

    await expect(editor.saveTabAs(tab, 'C:\\notes\\copy.md')).resolves.toBe(false)

    expect(tab.pathname).toBe('C:\\notes\\draft.md')
    expect(tab.filename).toBe('draft.md')
    expect(tab.markdown).toBe('local edit')
    expect(invokeMocks.saveMarkdown).not.toHaveBeenCalled()
  })

  it('commits a successful Save As path without overwriting an in-flight edit', async () => {
    let finishWrite!: () => void
    invokeMocks.saveMarkdown.mockImplementationOnce(() => new Promise<void>(resolve => {
      finishWrite = resolve
    }))
    const editor = useEditorStore()
    const tab = openedFile('first draft')
    tab.isSaved = false
    editor.tabs.push(tab)
    editor.currentFileId = tab.id

    const saving = editor.saveCurrentAs('C:\\notes\\copy.md')
    await vi.waitFor(() => expect(invokeMocks.saveMarkdown).toHaveBeenCalled())
    editor.setMarkdownExternal(tab.id, 'newer edit')
    finishWrite()
    await expect(saving).resolves.toBe(true)

    expect(tab.pathname).toBe('C:\\notes\\copy.md')
    expect(tab.filename).toBe('copy.md')
    expect(tab.lastSavedMarkdown).toBe('first draft')
    expect(tab.markdown).toBe('newer edit')
    expect(tab.isSaved).toBe(false)
    expect(invokeMocks.pushRecentPath).toHaveBeenCalledWith('recentFiles', tab.pathname)
  })

  it('does not let an old-path save overwrite a watcher-remapped tab identity', async () => {
    let finishWrite!: () => void
    invokeMocks.saveMarkdown.mockImplementationOnce(() => new Promise<void>(resolve => {
      finishWrite = resolve
    }))
    const editor = useEditorStore()
    const tab = openedFile('disk baseline')
    tab.markdown = 'local draft'
    tab.isSaved = false
    editor.tabs.push(tab)

    const saving = editor.saveTab(tab)
    await vi.waitFor(() => expect(invokeMocks.saveMarkdown).toHaveBeenCalledWith(
      'C:\\notes\\draft.md',
      'local draft',
      expect.any(Object),
    ))
    await editor.handleFileWatchEvent({
      kind: 'renamed',
      from: 'C:\\notes',
      to: 'D:\\archive',
    })
    finishWrite()

    await expect(saving).resolves.toBe(false)
    expect(tab.pathname).toBe('D:\\archive\\draft.md')
    expect(tab.filename).toBe('draft.md')
    expect(tab.markdown).toBe('local draft')
    expect(tab.lastSavedMarkdown).toBe('disk baseline')
    expect(tab.isSaved).toBe(false)
    expect(invokeMocks.saveMarkdown).toHaveBeenCalledTimes(1)
    expect(notification).toHaveBeenCalledWith(expect.objectContaining({ type: 'warning' }))
  })
})
