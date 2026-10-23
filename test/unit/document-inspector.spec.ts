import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { groupRelationItems, relationItemCount } from '../../src/components/documentInspector/inspector-model'

const tauri = vi.hoisted(() => ({
  getPreferences: vi.fn(async () => ({})), setPreference: vi.fn(async () => undefined), setPreferences: vi.fn(async () => undefined),
  pushRecentPath: vi.fn(async () => undefined), getUserData: vi.fn(async () => ({})), setUserData: vi.fn(async () => undefined),
}))
vi.mock('@/services/tauri-invoke', () => tauri)

import { useLayoutStore } from '../../src/stores/layout'

let storage = new Map<string, string>()
let previousStorage: PropertyDescriptor | undefined

function read(relative: string) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
}

describe('document inspector layout and relation model', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storage = new Map()
    previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    } })
    setActivePinia(createPinia())
  })

  afterEach(() => {
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  })

  it('groups relation rows by source, orders matches, counts them, and filters by context', () => {
    const rows = [
      { kind: 'backlink' as const, sourcePath: 'Team/notes.md', line: 9, from: 30, to: 34, context: 'later mention' },
      { kind: 'mention' as const, sourcePath: 'Guide/start.md', line: 2, from: 4, to: 8, context: 'First target' },
      { kind: 'backlink' as const, sourcePath: 'Team/notes.md', line: 3, from: 8, to: 12, context: 'earlier target' },
    ]

    const groups = groupRelationItems(rows)
    expect(groups.map(group => group.sourcePath)).toEqual(['Guide/start.md', 'Team/notes.md'])
    expect(groups[1]?.items.map(item => item.line)).toEqual([3, 9])
    expect(relationItemCount(groups)).toBe(3)
    expect(groupRelationItems(rows, 'EARLIER')).toEqual([{ sourcePath: 'Team/notes.md', items: [rows[2]!] }])
  })

  it('persists inspector selection, pinned links, visibility, and clamped widths', async () => {
    let layout = useLayoutStore()
    layout.setNavigationPanel('search')
    layout.setInspectorPanel('agent')
    layout.setLinksPinned(true)
    layout.showInspector = false
    layout.setSideBarWidth(320)
    layout.setInspectorWidth(999)
    await vi.waitFor(() => expect(storage.get('mt:documentInspectorWidth')).toBe('620'))

    expect(layout.effectiveSideBarWidth).toBe(364)
    expect(layout.effectiveInspectorWidth).toBe(44)
    expect(storage.get('mt:documentInspectorLinksPinned')).toBe('true')
    expect(storage.get('mt:documentInspectorVisible')).toBe('false')

    setActivePinia(createPinia())
    layout = useLayoutStore()
    expect(layout.navigationPanel).toBe('search')
    expect(layout.inspectorPanel).toBe('agent')
    expect(layout.linksPinned).toBe(true)
    expect(layout.showInspector).toBe(false)
    expect(layout.inspectorWidth).toBe(620)
    expect(layout.sideBarWidth).toBe(320)
  })

  it('exposes separate navigation and inspector surfaces with a pinned split and narrow-window layout', () => {
    const sidebar = read('../../src/components/sideBar/SideBar.vue')
    const inspector = read('../../src/components/documentInspector/DocumentInspector.vue')
    const notebook = read('../../src/components/notebook/NotebookPanel.vue')

    expect(sidebar).toContain('TreePane')
    expect(sidebar).toContain('SearchPane')
    expect(sidebar).not.toContain('NotebookPanel')
    expect(inspector).toContain('name="outline"')
    expect(inspector).toContain('name="agent"')
    expect(inspector).toContain('pinnedLinksVisible')
    expect(inspector).toContain('document-inspector-rail')
    expect(inspector).toContain('@media (max-width: 1050px)')
    expect(inspector).toContain('setInspectorWidth')
    expect(notebook).toContain('notebook.navigateToRelation')
    expect(notebook).toContain('notebook.returnFromRelation')
    expect(notebook).toContain('groupRelationItems')
  })
})
