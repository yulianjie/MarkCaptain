import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AgentDocumentCheckResult } from '../../src/services/agent'

const ipc = vi.hoisted(() => ({ check: vi.fn(), load: vi.fn() }))
vi.mock('@/services/tauri-invoke', () => ({ agentCheckDocument: ipc.check, agentProjectLoadConfig: ipc.load }))
vi.mock('@/services/agent-transport', () => ({ agentTransport: {} }))
vi.mock('element-plus', () => ({ ElMessageBox: { confirm: vi.fn() }, ElNotification: vi.fn() }))

import { useAgentStore } from '../../src/stores/agent'
import { useEditorStore } from '../../src/stores/editor'
import { useProjectStore } from '../../src/stores/project'
import { usePreferencesStore } from '../../src/stores/preferences'

const clean: AgentDocumentCheckResult = { issues: [], complete: true, externalLinksUnchecked: 0,
  localTargetsChecked: 0, truncated: false, scope: 'current buffer' }

beforeEach(() => {
  setActivePinia(createPinia())
  vi.resetAllMocks()
  ipc.check.mockResolvedValue(clean)
  ipc.load.mockResolvedValue({ config: null, fingerprint: null })
  usePreferencesStore().autoSave = false
})

describe('local document check freshness', () => {
  it.each(['edit', 'switch', 'rename', 'root'] as const)('invalidates completed clean results on %s', async change => {
    const editor = useEditorStore(), agent = useAgentStore()
    const tab = editor.newUntitledTab('# Clean document\n')
    await agent.checkCurrentDocument()
    expect(agent.documentCheck?.result).toEqual(clean)
    if (change === 'edit') editor.setMarkdownExternal(tab.id, '# Changed\n')
    if (change === 'switch') editor.newUntitledTab('# Another document\n')
    if (change === 'rename') editor.currentFile!.pathname = 'C:/notes/renamed.md'
    if (change === 'root') useProjectStore().projectTree = { pathname: 'C:/other' } as NonNullable<ReturnType<typeof useProjectStore>['projectTree']>
    expect(agent.documentCheck).toBeNull()
    expect(agent.documentCheckError).not.toBe('')
  })

  it.each(['edit-undo', 'switch-back'] as const)('does not accept an in-flight result after %s restores the original snapshot', async change => {
    const editor = useEditorStore(), agent = useAgentStore()
    const tab = editor.newUntitledTab('# Original\n')
    let finish!: (value: AgentDocumentCheckResult) => void
    ipc.check.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const pending = agent.checkCurrentDocument()
    if (change === 'edit-undo') {
      editor.setMarkdownExternal(tab.id, '# Changed\n')
      editor.setMarkdownExternal(tab.id, '# Original\n')
    } else {
      editor.newUntitledTab('# Other\n')
      editor.setCurrent(tab.id)
    }
    finish(clean)
    await pending
    expect(agent.documentCheck).toBeNull()
    expect(agent.documentCheckError).not.toBe('')
    expect(agent.documentCheckBusy).toBe(false)
  })

  it.each(['success', 'failure'] as const)('prevents obsolete %s from overwriting a newer check or releasing its busy state', async outcome => {
    const editor = useEditorStore(), agent = useAgentStore()
    const tab = editor.newUntitledTab('# Original\n')
    let finishOld!: (value: AgentDocumentCheckResult) => void, failOld!: (cause: Error) => void
    let finishNew!: (value: AgentDocumentCheckResult) => void
    ipc.check.mockImplementationOnce(() => new Promise((resolve, reject) => { finishOld = resolve; failOld = reject }))
      .mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve }))
    const oldCheck = agent.checkCurrentDocument()
    editor.setMarkdownExternal(tab.id, '# New\n')
    const newCheck = agent.checkCurrentDocument()
    expect(ipc.check).toHaveBeenCalledTimes(2)
    if (outcome === 'success') finishOld(clean)
    else failOld(new Error('agent:projectCheckFailed'))
    await oldCheck
    expect(agent.documentCheck).toBeNull()
    expect(agent.documentCheckBusy).toBe(true)
    expect(agent.documentCheckError).toBe('')
    finishNew(clean)
    await newCheck
    expect(agent.documentCheck?.markdown).toBe('# New\n')
    expect(agent.documentCheckBusy).toBe(false)
  })
})
