import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const transport = vi.hoisted(() => ({
  getConfig: vi.fn(), saveConfig: vi.fn(), testConnection: vi.fn(), start: vi.fn(), cancel: vi.fn(), listen: vi.fn(),
  listSkills: vi.fn(), importSkill: vi.fn(),
}))
const invokeMocks = vi.hoisted(() => ({ openFiles: vi.fn(), readMarkdown: vi.fn(), saveMarkdown: vi.fn(), saveAsDialog: vi.fn(), renameFile: vi.fn() }))
vi.mock('@/services/agent-transport', () => ({ agentTransport: transport }))
vi.mock('@/services/tauri-invoke', () => invokeMocks)
vi.mock('element-plus', () => ({ ElMessageBox: { confirm: vi.fn() }, ElNotification: vi.fn() }))

import { useAgentStore } from '../../src/stores/agent'
import { useEditorStore } from '../../src/stores/editor'
import { usePreferencesStore } from '../../src/stores/preferences'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('Agent pane navigation', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    usePreferencesStore().autoSave = false
  })

  it('does not route an async source lookup into a pane selected while the file read is pending', async () => {
    const editor = useEditorStore()
    const first = editor.newUntitledTab('first document')
    editor.splitPane('horizontal')
    const secondPane = editor.panes[1]!
    editor.newUntitledTab('second document')
    const agent = useAgentStore()
    const read = deferred<{
      path: string; markdown: string; encoding: string; lineEnding: 'lf'; hadDecodeErrors: boolean; bom: boolean
    }>()
    invokeMocks.readMarkdown.mockReturnValueOnce(read.promise)

    const locating = agent.locateSource({ tabId: 'not-open', name: 'source.md', markdown: 'source text', from: 0, to: 11, path: 'C:/notes/source.md' })
    expect(invokeMocks.readMarkdown).toHaveBeenCalledOnce()
    editor.activatePane(secondPane.id)
    read.resolve({ path: 'C:/notes/source.md', markdown: 'source text', encoding: 'UTF-8', lineEnding: 'lf', hadDecodeErrors: false, bom: false })
    await locating

    expect(editor.activePaneId).toBe(secondPane.id)
    expect(editor.currentFileId).toBe(first.id)
    expect(editor.findTabByPath('C:/notes/source.md')).toBeUndefined()
  })
})
