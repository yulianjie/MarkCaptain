import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { acceptsMuyaViewChange, isMuyaEditBeforeLoadBaseline } from '../../src/services/muya-view-baseline'

const invokeMocks = vi.hoisted(() => ({
  readMarkdown: vi.fn(), localHistoryCapture: vi.fn(), saveMarkdown: vi.fn(), saveAsDialog: vi.fn(),
  renameFile: vi.fn(), pushRecentPath: vi.fn(), getPreferences: vi.fn(), setPreference: vi.fn(),
  setPreferences: vi.fn(), getUserData: vi.fn(), setUserData: vi.fn(),
}))
vi.mock('@/services/tauri-invoke', () => invokeMocks)
vi.mock('element-plus', () => ({ ElMessageBox: { confirm: vi.fn() }, ElNotification: vi.fn() }))

import { useEditorStore } from '../../src/stores/editor'
import { usePreferencesStore } from '../../src/stores/preferences'

describe('Muya per-pane change baseline', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    usePreferencesStore().autoSave = false
  })

  it('rejects an inactive WYSIWYG sync event after the source pane has newer text', () => {
    expect(acceptsMuyaViewChange('restored versionXYZ', 'restored version', 'restored version')).toBe(false)
    expect(acceptsMuyaViewChange('restored versionXYZ', 'restored version', 'restored versionXYZ')).toBe(true)
  })

  it('accepts the active view baseline and harmless no-op events', () => {
    expect(acceptsMuyaViewChange('loaded text', 'loaded text', 'normalized text')).toBe(true)
    expect(acceptsMuyaViewChange('current text', 'stale text', 'current text')).toBe(true)
    expect(acceptsMuyaViewChange('current text', null, 'current text')).toBe(false)
  })

  it('marks a real first edit dirty if it arrives before the scheduled load event', () => {
    expect(isMuyaEditBeforeLoadBaseline(true, 'restored version', 'restored versionX')).toBe(true)
    expect(isMuyaEditBeforeLoadBaseline(true, 'restored version', 'restored version')).toBe(false)
    expect(isMuyaEditBeforeLoadBaseline(false, 'restored version', 'restored versionX')).toBe(false)
  })

  it('keeps the first real edit dirty instead of committing it as a parse baseline', () => {
    const editor = useEditorStore()
    const tab = editor.newUntitledTab('restored version')
    tab.pendingBaselineUpdate = true
    tab.isSaved = true
    tab.lastSavedMarkdown = tab.markdown
    const firstEdit = 'restored versionX'

    if (isMuyaEditBeforeLoadBaseline(tab.pendingBaselineUpdate, tab.markdown, firstEdit)) tab.pendingBaselineUpdate = false
    editor.applyContentChange(tab.id, firstEdit)

    expect(tab.markdown).toBe(firstEdit)
    expect(tab.pendingBaselineUpdate).toBe(false)
    expect(tab.isSaved).toBe(false)
  })
})
