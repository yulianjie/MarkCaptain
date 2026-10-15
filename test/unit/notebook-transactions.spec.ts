import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick, reactive } from 'vue'

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(), notesList: vi.fn(), notesRead: vi.fn(), notesCreate: vi.fn(), notesConfig: vi.fn(), notesCancel: vi.fn(),
  notesMove: vi.fn(), notesRestoreTransaction: vi.fn(), localHistoryCapture: vi.fn(), localHistorySettings: vi.fn(),
  project: null as any, editor: null as any, preferences: null as any,
}))

vi.mock('@/services/tauri-invoke', () => mocks)
vi.mock('@/services/tauri-bridge', () => ({ listenTyped: vi.fn(async () => () => {}) }))
vi.mock('@/stores/project', () => {
  const pathIsInsideRoot = (root: string, path: string) => {
    const normalize = (value: string) => value.replace(/[\\/]+/g, '/').replace(/\/$/, '')
    const rootPath = normalize(root); const candidate = normalize(path)
    const folded = /^[a-z]:\//i.test(rootPath) || rootPath.startsWith('//')
    const left = folded ? rootPath.toLowerCase() : rootPath; const right = folded ? candidate.toLowerCase() : candidate
    return right === left || right.startsWith(`${left}/`)
  }
  return {
    useProjectStore: () => mocks.project,
    pathIsInsideRoot,
    remapPathWithinRoot(source: string, destination: string, candidate: string) {
    if (!pathIsInsideRoot(source, candidate)) return null
    const sourcePath = source.replace(/[\\/]+/g, '/').replace(/\/$/, '')
    const candidatePath = candidate.replace(/[\\/]+/g, '/').replace(/\/$/, '')
    const suffix = candidatePath.slice(sourcePath.length).replace(/^\//, '')
    if (!suffix) return destination
    const separator = destination.includes('\\') ? '\\' : '/'
    return `${destination.replace(/[\\/]$/, '')}${separator}${suffix.replace(/\//g, separator)}`
  },
  }
})
vi.mock('@/stores/editor', () => ({
  useEditorStore: () => mocks.editor,
  normalizeComparablePath(path: string) { return path.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase() },
  pathsReferToSameFile(left: string, right: string) { return Boolean(left && right) && left.replace(/[\\/]+/g, '/').toLowerCase() === right.replace(/[\\/]+/g, '/').toLowerCase() },
}))
vi.mock('@/stores/preferences', () => ({ usePreferencesStore: () => mocks.preferences }))
vi.mock('element-plus', () => ({ ElMessageBox: { confirm: mocks.confirm } }))

function absolute(root: string, relative: string) { return `${root.replace(/[\\/]+$/, '')}/${relative}` }
function setup(root = 'C:/notebook', files: Record<string, string> = {}) {
  const diskByRoot = new Map<string, Map<string, string>>([[root, new Map(Object.entries(files))]])
  mocks.project = reactive({ projectTree: { pathname: root } })
  mocks.editor = reactive({
    tabs: [] as Array<{ id: string; pathname: string; filename: string; markdown: string; lastSavedMarkdown: string; isSaved: boolean; externalChange: unknown }>,
    fileMutationBusy: false,
    sourceCodeMode: false,
    currentFile: null as null | { pathname: string },
    beginFileMutation: vi.fn(async function (this: { fileMutationBusy: boolean }) { this.fileMutationBusy = true }),
    endFileMutation: vi.fn(function (this: { fileMutationBusy: boolean; flushDeferredFileEvents: () => void }) { this.fileMutationBusy = false; this.flushDeferredFileEvents() }),
    setMarkdownExternal: vi.fn(function (this: any, id: string, markdown: string) {
      const tab = this.tabs.find((candidate: { id: string }) => candidate.id === id)
      if (tab) { tab.markdown = markdown; tab.isSaved = false }
    }),
    resetSharedHistory: vi.fn(),
    openFile: vi.fn(async (path: string) => ({ id: path, pathname: path, markdown: '', isSaved: true })),
    flushDeferredFileEvents: vi.fn(),
  })
  mocks.preferences = reactive({ recentFiles: [] as string[], pushRecentFile(path: string) { this.recentFiles.unshift(path) } })
  mocks.confirm.mockResolvedValue(undefined)
  mocks.notesList.mockImplementation(async (workspaceRoot: string) => [...(diskByRoot.get(workspaceRoot) ?? new Map()).entries()].map(([relative, markdown]) => ({ relative, path: absolute(workspaceRoot, relative), size: markdown.length, modified: 1 })))
  mocks.notesRead.mockImplementation(async (workspaceRoot: string, relative: string) => {
    const markdown = diskByRoot.get(workspaceRoot)?.get(relative)
    if (markdown === undefined) throw new Error('not found')
    return { path: absolute(workspaceRoot, relative), markdown, encoding: 'utf8', lineEnding: 'lf', bom: false, hadDecodeErrors: false, fingerprint: `hash:${markdown}` }
  })
  mocks.notesCreate.mockResolvedValue(absolute(root, 'created.md'))
  mocks.notesConfig.mockImplementation(async (_workspaceRoot: string, config?: unknown) => config ?? { templateDirectory: 'Templates', dailyDirectory: 'Daily', dailyFormat: 'YYYY-MM-DD', dailyTemplate: 'builtin:work' })
  mocks.notesCancel.mockResolvedValue(undefined)
  mocks.notesMove.mockImplementation(async (workspaceRoot: string, source: string, destination: string, changes: Array<{ relative: string; markdown: string }>) => {
    const disk = diskByRoot.get(workspaceRoot) ?? new Map<string, string>(); diskByRoot.set(workspaceRoot, disk)
    for (const change of changes) disk.set(change.relative, change.markdown)
    const moved = [...disk.entries()].filter(([path]) => path === source || path.startsWith(`${source}/`))
    for (const [path] of moved) disk.delete(path)
    for (const [path, markdown] of moved) disk.set(`${destination}${path.slice(source.length)}`, markdown)
    return 'transaction-1'
  })
  mocks.notesRestoreTransaction.mockImplementation(async (workspaceRoot: string) => {
    const disk = diskByRoot.get(workspaceRoot)!
    disk.set('old/target.md', '# Target\n'); disk.set('references.md', '[target](old/target.md)\n'); disk.delete('new/target.md')
    return { source: 'old/target.md', destination: 'new/target.md', files: [{ relative: 'references.md', markdown: '[target](old/target.md)\n' }] }
  })
  mocks.localHistoryCapture.mockResolvedValue(undefined)
  mocks.localHistorySettings.mockResolvedValue({ intervalSeconds: 3600, retentionDays: 30, maxMegabytes: 50 })
  const scope = effectScope()
  setActivePinia(createPinia())
  const notebook = scope.run(() => notebookStoreFactory())!
  return { root, diskByRoot, scope, notebook, project: mocks.project, editor: mocks.editor }
}
import { useNotebookStore as notebookStoreFactory } from '../../src/stores/notebook'

describe('notebook move and restore transactions', () => {
  let storage: Map<string, string>
  let previousStorage: PropertyDescriptor | undefined
  beforeEach(() => {
    vi.clearAllMocks()
    storage = new Map()
    previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    } })
  })
  afterEach(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  })

  it('rechecks tabs opened during the confirmation and rejects a dirty one before committing', async () => {
    const context = setup('C:/notebook', { 'old/target.md': '# Target\n', 'references.md': '[target](old/target.md)\n' })
    mocks.confirm.mockImplementationOnce(async () => {
      context.editor.tabs.push({ id: 'late', pathname: absolute(context.root, 'late.md'), filename: 'late.md', markdown: 'unsaved', lastSavedMarkdown: '', isSaved: false, externalChange: null })
    })

    await expect(context.notebook.moveWithReferences(absolute(context.root, 'old/target.md'), absolute(context.root, 'new/target.md'))).rejects.toThrow()

    expect(mocks.notesMove).not.toHaveBeenCalled()
    expect(context.editor.fileMutationBusy).toBe(false)
    expect(context.editor.endFileMutation).toHaveBeenCalledOnce()
    context.scope.stop()
  })

  it('cancels a move during its initial scan without showing a preview or writing files', async () => {
    const context = setup('C:/notebook', { 'old/target.md': '# Target\n' })
    await nextTick(); await context.notebook.rebuild(true)
    let release!: (files: unknown[]) => void
    mocks.notesList.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const moving = context.notebook.moveWithReferences(absolute(context.root, 'old/target.md'), absolute(context.root, 'new/target.md'))
    context.notebook.error = 'old project error'
    context.notebook.cancel()
    expect(context.notebook.error).toBe('')
    release([])
    await expect(moving).rejects.toThrow()
    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.notesMove).not.toHaveBeenCalled()
    expect(context.notebook.mutating).toBe(false)
    context.notebook.error = 'stale error'
    context.project.projectTree.pathname = ''
    await nextTick()
    expect(context.notebook.error).toBe('')
    context.scope.stop()
  })

  it('restores tab paths and rewritten text from the response without a filesystem watcher event', async () => {
    const original = '[target](old/target.md)\n'
    const context = setup('C:/notebook', { 'old/target.md': '# Target\n', 'references.md': original })
    const targetTab = { id: 'target', pathname: absolute(context.root, 'old/target.md'), filename: 'target.md', markdown: '# Target\n', lastSavedMarkdown: '# Target\n', isSaved: true, externalChange: null }
    // Windows aliases must synchronize without waiting for the filesystem
    // watcher, even when a tab was opened with different case/slashes.
    const referenceTab = { id: 'references', pathname: 'c:\\NOTEBOOK\\REFERENCES.MD', filename: 'REFERENCES.MD', markdown: original, lastSavedMarkdown: original, isSaved: true, externalChange: null }
    context.editor.tabs.push(targetTab, referenceTab)

    await context.notebook.moveWithReferences(targetTab.pathname, absolute(context.root, 'new/target.md'))
    expect(mocks.notesMove).toHaveBeenCalledWith(
      context.root,
      'old/target.md',
      'new/target.md',
      expect.arrayContaining([{ relative: 'references.md', expected: `hash:${original}`, markdown: '[target](new/target.md)\n' }]),
      expect.arrayContaining([{ relative: 'old/target.md', expected: 'hash:# Target\n' }, { relative: 'references.md', expected: `hash:${original}` }]),
    )
    expect(targetTab.pathname).toBe(absolute(context.root, 'new/target.md'))
    expect(referenceTab.markdown).toContain('new/target.md')
    expect(referenceTab.isSaved).toBe(true)

    await context.notebook.restoreReferences()

    expect(targetTab.pathname).toBe(absolute(context.root, 'old/target.md'))
    expect(referenceTab.markdown).toBe(original)
    expect(referenceTab.lastSavedMarkdown).toBe(original)
    expect(referenceTab.isSaved).toBe(true)
    expect(context.editor.resetSharedHistory).toHaveBeenCalledWith('references')
    context.scope.stop()
  })

  it('stores a completed transaction under its original root when the project changes during IPC', async () => {
    const context = setup('C:/notebook', { 'old/target.md': '# Target\n', 'references.md': '[target](old/target.md)\n' })
    const targetTab = { id: 'target', pathname: absolute(context.root, 'old/target.md'), filename: 'target.md', markdown: '# Target\n', lastSavedMarkdown: '# Target\n', isSaved: true, externalChange: null }
    context.editor.tabs.push(targetTab)
    let finishMove!: () => void
    let enteredMove!: () => void
    const moveStarted = new Promise<void>(resolve => { enteredMove = resolve })
    const moveGate = new Promise<void>(resolve => { finishMove = resolve })
    mocks.notesMove.mockImplementation(async (workspaceRoot: string, source: string, destination: string, changes: Array<{ relative: string; markdown: string }>) => {
      enteredMove()
      await moveGate
      const disk = context.diskByRoot.get(workspaceRoot)!
      for (const change of changes) disk.set(change.relative, change.markdown)
      const markdown = disk.get(source)!
      disk.delete(source); disk.set(destination, markdown)
      return 'transaction-root-a'
    })

    const operation = context.notebook.moveWithReferences(targetTab.pathname, absolute(context.root, 'new/target.md'))
    await moveStarted
    context.project.projectTree.pathname = 'D:/other-project'
    await nextTick()
    finishMove()
    await operation

    expect(storage.get('mt:reference-transaction:c:/notebook')).toBe('transaction-root-a')
    expect(storage.has('mt:reference-transaction:d:/other-project')).toBe(false)
    expect(targetTab.pathname).toBe(absolute(context.root, 'new/target.md'))
    context.scope.stop()
  })

  it('normalizes configured directory separators and rejects templates with decode errors', async () => {
    const context = setup('C:/notebook', { 'Templates/example.md': '# {{title}}\n' })
    await context.notebook.rebuild(true)
    await vi.waitFor(() => expect(context.notebook.notes).toHaveLength(1))
    context.notebook.config.templateDirectory = 'Templates//'
    expect(context.notebook.templates.map((note: { relative: string }) => note.relative)).toEqual(['Templates/example.md'])

    const saved = await context.notebook.saveConfig({ templateDirectory: 'Templates//', dailyDirectory: 'Daily\\', dailyFormat: 'YYYY-MM-DD', dailyTemplate: 'builtin:work' })
    expect(saved.templateDirectory).toBe('Templates')
    expect(saved.dailyDirectory).toBe('Daily')
    mocks.notesRead.mockImplementationOnce(async (root: string, relative: string) => ({ path: absolute(root, relative), markdown: 'replace', encoding: 'utf8', lineEnding: 'lf', bom: false, hadDecodeErrors: true, fingerprint: 'invalid' }))
    await expect(context.notebook.templateContent('Templates/bad.md', 'title')).rejects.toThrow()

    await context.notebook.daily()
    expect(mocks.notesCreate).toHaveBeenCalledWith(context.root, expect.stringMatching(/^Daily\/\d{4}-\d{2}-\d{2}\.md$/), expect.stringContaining('Priorities'))
    context.scope.stop()
  })
  it('waits for project configuration before creating a daily note and never uses the previous project cache', async () => {
    const context = setup('C:/new-project')
    await nextTick(); await context.notebook.rebuild(true)
    context.notebook.config.dailyDirectory = 'previous-project-daily'
    let release!: (value: unknown) => void
    mocks.notesConfig.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const opening = context.notebook.daily()
    expect(mocks.notesCreate).not.toHaveBeenCalled()
    release({ templateDirectory: 'Templates', dailyDirectory: 'CorrectDaily', dailyFormat: 'YYYY-MM-DD', dailyTemplate: '' })
    await opening
    expect(mocks.notesCreate).toHaveBeenCalledWith(context.root, expect.stringMatching(/^CorrectDaily\/\d{4}-\d{2}-\d{2}\.md$/), '')
    mocks.notesCreate.mockClear()
    mocks.notesConfig.mockRejectedValueOnce(new Error('project configuration unreadable'))
    await expect(context.notebook.daily()).rejects.toThrow('project configuration unreadable')
    expect(mocks.notesCreate).not.toHaveBeenCalled()
    context.scope.stop()
  })
  it('does not offer to create a Markdown note for a local non-Markdown link', async () => {
    const context = setup()

    await expect(context.notebook.followLink('source.md', { kind: 'markdown', target: 'manual.pdf' })).rejects.toThrow()

    expect(mocks.confirm).not.toHaveBeenCalled()
    expect(mocks.notesCreate).not.toHaveBeenCalled()
    context.scope.stop()
  })
  it('leaves tabs untouched and releases the editor lock when the backend transaction fails', async () => {
    const original = '[target](old/target.md)\n'
    const context = setup('C:/notebook', { 'old/target.md': '# Target\n', 'references.md': original })
    const targetTab = { id: 'target', pathname: absolute(context.root, 'old/target.md'), filename: 'target.md', markdown: '# Target\n', lastSavedMarkdown: '# Target\n', isSaved: true, externalChange: null }
    const referenceTab = { id: 'references', pathname: absolute(context.root, 'references.md'), filename: 'references.md', markdown: original, lastSavedMarkdown: original, isSaved: true, externalChange: null }
    context.editor.tabs.push(targetTab, referenceTab)
    mocks.notesMove.mockRejectedValueOnce(new Error('transaction conflict'))

    await expect(context.notebook.moveWithReferences(targetTab.pathname, absolute(context.root, 'new/target.md'))).rejects.toThrow('transaction conflict')

    expect(targetTab.pathname).toBe(absolute(context.root, 'old/target.md'))
    expect(referenceTab.markdown).toBe(original)
    expect(referenceTab.lastSavedMarkdown).toBe(original)
    expect(referenceTab.isSaved).toBe(true)
    expect(context.editor.fileMutationBusy).toBe(false)
    context.scope.stop()
  })
})
