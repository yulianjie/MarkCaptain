import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick, reactive } from 'vue'
import { getPaneViewState } from '../../src/services/pane-view-state'

const mocks = vi.hoisted(() => ({
  notesList: vi.fn(), notesRead: vi.fn(), notesCreate: vi.fn(), notesConfig: vi.fn(), notesCancel: vi.fn(),
  localHistoryCapture: vi.fn(), localHistorySettings: vi.fn(),
  project: null as any, editor: null as any, preferences: null as any,
}))

vi.mock('@/services/tauri-invoke', () => mocks)
vi.mock('@/services/tauri-bridge', () => ({ listenTyped: vi.fn(async () => () => {}) }))
vi.mock('@/stores/project', () => ({
  useProjectStore: () => mocks.project,
  pathIsInsideRoot(root: string, path: string) {
    const normalize = (value: string) => value.replace(/[\\/]+/g, '/').replace(/\/$/, '')
    const base = normalize(root); const candidate = normalize(path)
    return candidate.toLowerCase() === base.toLowerCase() || candidate.toLowerCase().startsWith(`${base.toLowerCase()}/`)
  },
  remapPathWithinRoot: () => null,
}))
vi.mock('@/stores/editor', () => ({
  useEditorStore: () => mocks.editor,
  normalizeComparablePath(path: string) { return path.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase() },
  pathsReferToSameFile(left: string, right: string) {
    return Boolean(left && right) && left.replace(/[\\/]+/g, '/').toLowerCase() === right.replace(/[\\/]+/g, '/').toLowerCase()
  },
}))
vi.mock('@/stores/preferences', () => ({ usePreferencesStore: () => mocks.preferences }))

import { useNotebookStore } from '../../src/stores/notebook'
import { setPaneViewField } from '../../src/services/pane-view-state'

let storage = new Map<string, string>()
let previousStorage: PropertyDescriptor | undefined

function absolute(root: string, relative: string) { return `${root.replace(/[\\/]+$/, '')}/${relative}` }

function setup(root: string, files: Record<string, string>) {
  mocks.project = reactive({ projectTree: { pathname: root } })
  const initialTab = {
    id: 'origin-document', pathname: absolute(root, 'current.md'), filename: 'current.md', markdown: '# Current\n',
    isSaved: true, lastSavedMarkdown: '# Current\n', cursor: { anchor: { line: 0, ch: 2 }, focus: { line: 0, ch: 3 } },
    sourceSelection: null, sourceMode: false, externalChange: null,
  }
  const editor = reactive({
    tabs: [initialTab] as any[], panes: [{ id: 'main', documentId: initialTab.id, sourceMode: false }] as any[],
    activePaneId: 'main', currentFileId: initialTab.id, sourceCodeMode: false, fileMutationBusy: false,
    splitDirection: 'horizontal', splitRatio: .5, paneSizes: {},
    get currentFile() { return this.tabs.find(tab => tab.id === this.currentFileId) ?? null },
    captureCurrentViewState() {
      const tab = this.currentFile
      if (tab) setPaneViewField(this.activePaneId, tab.id, 'cursor', tab.cursor)
    },
    setCurrent(id: string | null) {
      this.currentFileId = id ?? ''
      const pane = this.panes.find(item => item.id === this.activePaneId)
      if (pane) pane.documentId = id
      const tab = this.tabs.find(item => item.id === id)
      this.sourceCodeMode = tab?.sourceMode ?? false
    },
    activatePane(id: string) {
      const pane = this.panes.find(item => item.id === id)
      if (!pane) return
      this.activePaneId = id
      this.currentFileId = pane.documentId ?? ''
      this.sourceCodeMode = pane.sourceMode
    },
    splitPane(direction: 'horizontal' | 'vertical') {
      this.splitDirection = direction
      this.panes.push({ id: `pane-${this.panes.length + 1}`, documentId: this.currentFileId || null, sourceMode: this.sourceCodeMode })
    },
    closePane(id: string) {
      this.panes = this.panes.filter(item => item.id !== id)
      if (this.activePaneId === id && this.panes[0]) this.activatePane(this.panes[0].id)
    },
    async openFile(path: string) {
      let tab = this.tabs.find(item => item.pathname.toLowerCase() === path.toLowerCase())
      if (!tab) {
        const relative = path.slice(root.length + 1).replace(/\\/g, '/')
        tab = { id: path, pathname: path, filename: relative.split('/').at(-1), markdown: files[relative] ?? '', isSaved: true, lastSavedMarkdown: files[relative] ?? '', cursor: null, sourceSelection: null, sourceMode: false, externalChange: null }
        this.tabs.push(tab)
      }
      this.setCurrent(tab.id)
      return tab
    },
  })
  mocks.editor = editor
  mocks.preferences = reactive({ recentFiles: [] as string[], pushRecentFile(path: string) { this.recentFiles.unshift(path) } })
  mocks.notesList.mockImplementation(async (workspaceRoot: string) => Object.entries(files).map(([relative, markdown]) => ({ relative, path: absolute(workspaceRoot, relative), size: markdown.length, modified: 1 })))
  mocks.notesRead.mockImplementation(async (workspaceRoot: string, relative: string) => {
    const markdown = files[relative]
    if (markdown === undefined) throw new Error('not found')
    return { path: absolute(workspaceRoot, relative), markdown, encoding: 'utf8', lineEnding: 'lf', bom: false, hadDecodeErrors: false, fingerprint: `hash:${markdown}` }
  })
  mocks.notesCreate.mockResolvedValue(absolute(root, 'created.md'))
  mocks.notesConfig.mockResolvedValue({ templateDirectory: 'Templates', dailyDirectory: 'Daily', dailyFormat: 'YYYY-MM-DD', dailyTemplate: 'builtin:work' })
  mocks.notesCancel.mockResolvedValue(undefined)
  mocks.localHistoryCapture.mockResolvedValue(undefined)
  mocks.localHistorySettings.mockResolvedValue({ intervalSeconds: 3600, retentionDays: 30, maxMegabytes: 50 })

  setActivePinia(createPinia())
  const scope = effectScope()
  const notebook = scope.run(() => useNotebookStore())!
  return { notebook, editor, scope }
}

describe('notebook relation target and navigation', () => {
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

  it('pins a project note independently from the active editor document', async () => {
    const root = 'C:/local-notes'
    const context = setup(root, { 'current.md': '# Current\n', 'target.md': '# Target\n', 'reference.md': 'See [[target]].\n' })
    await vi.waitFor(() => expect(context.notebook.relationTargetStatus).toBe('ready'))

    expect(context.notebook.relationTargetRelative).toBe('current.md')
    expect(context.notebook.fixRelationTarget('target.md')).toBe(true)
    await nextTick()
    await vi.waitFor(() => expect(context.notebook.backlinks).toHaveLength(1))
    expect(context.notebook.relationTargetPinned).toBe(true)
    expect(context.notebook.relationTargetRelative).toBe('target.md')
    expect(JSON.stringify([...storage.values()])).toContain('target.md')

    await context.editor.openFile(absolute(root, 'reference.md'))
    expect(context.notebook.relationTargetRelative).toBe('target.md')
    context.notebook.followActiveRelationTarget()
    expect(context.notebook.relationTargetPinned).toBe(false)
    expect(context.notebook.relationTargetRelative).toBe('reference.md')
    context.scope.stop()
  })

  it('opens a relation in another split and returns to the origin pane, document, and cursor', async () => {
    const root = 'C:/relation-test'
    const context = setup(root, { 'current.md': '# Current\n', 'reference.md': 'References [[current]].\n' })
    await vi.waitFor(() => expect(context.notebook.relationTargetStatus).toBe('ready'))
    const originalCursor = context.editor.currentFile.cursor

    await context.notebook.navigateToRelation('reference.md', 12, 21, { openInOtherPane: true })
    expect(context.editor.panes).toHaveLength(2)
    expect(context.editor.activePaneId).toBe('pane-2')
    expect(context.editor.currentFile.pathname).toBe(absolute(root, 'reference.md'))
    expect(context.notebook.canReturnFromRelation).toBe(true)

    expect(await context.notebook.returnFromRelation()).toBe(true)
    expect(context.editor.activePaneId).toBe('main')
    expect(context.editor.currentFileId).toBe('origin-document')
    expect(context.editor.currentFile.pathname).toBe(absolute(root, 'current.md'))
    expect(getPaneViewState('main', 'origin-document')?.cursor).toEqual(originalCursor)
    expect(context.notebook.canReturnFromRelation).toBe(false)
    context.scope.stop()
  })
})
