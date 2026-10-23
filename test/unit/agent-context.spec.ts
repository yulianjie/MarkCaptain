import { describe, expect, it } from 'vitest'
import { createAgentTaskContext, parseAgentContextRead, restoreAgentContextReads, restoreAgentTaskContext } from '../../src/services/agent-context'

const document = { tabId: 'doc-1', name: '项目说明.md', markdown: '头\n正文', from: 2, to: 4, snapshotId: 'task-1' }
const task = createAgentTaskContext({ taskId: 'task-1', paneId: 'right-pane', attached: document, reading: { ...document, from: 0, to: 4 },
  references: [{ documentId: 'ref-1', snapshot: { ...document, tabId: 'ref-tab', name: '词汇表.md' } }],
  skills: [{ id: 'builtin:markdown', name: 'Markdown Writing', selected: true }, { id: 'builtin:eli5', name: 'ELI5', selected: false }],
  config: { baseUrl: 'https://api.example.test/v1', model: 'writing-model', hasKey: true, hasHeaders: false } })

describe('Agent task context', () => {
  it('records task target, authorized range, references, and a secret-free model route', () => {
    expect(task).toMatchObject({ taskId: 'task-1', paneId: 'right-pane', documentId: 'doc-1', scope: 'selection', model: 'writing-model', endpoint: 'api.example.test', localModel: false })
    expect(task.sources).toEqual([
      { documentId: 'doc-1', name: '项目说明.md', kind: 'current', authorizedRange: { from: 2, to: 4 }, readRange: { from: 0, to: 4 } },
      { documentId: 'ref-1', name: '词汇表.md', kind: 'reference', readRange: { from: 2, to: 4 } },
    ])
    expect(task.skills).toEqual([{ id: 'builtin:markdown', name: 'Markdown Writing', selected: true }, { id: 'builtin:eli5', name: 'ELI5', selected: false }])
  })

  it('resolves a backend read to its authorized source and bounds the visible excerpt', () => {
    const read = parseAgentContextRead({ tool: 'read_document', kind: 'range', documentId: 'ref-1', documentName: 'wrong name', startLine: 3, endLine: 4,
      excerpt: 'x'.repeat(3000), totalChars: 5000, truncated: false }, task, 'read-1')
    expect(read).toMatchObject({ documentId: 'ref-1', documentName: '词汇表.md', startLine: 3, endLine: 4, totalChars: 5000, truncated: true })
    expect(read?.excerpt).toHaveLength(2400)
  })

  it('rejects access events from sources outside the task and malformed event fields', () => {
    expect(parseAgentContextRead({ tool: 'read_document', kind: 'range', documentId: 'unattached', documentName: 'x', excerpt: 'secret' }, task, 'x')).toBeNull()
    expect(parseAgentContextRead({ tool: 'write_file', kind: 'range', documentName: 'x', excerpt: 'secret' }, task, 'x')).toBeNull()
    expect(parseAgentContextRead({ tool: 'search_document', kind: 'search', documentId: 'ref-1', documentName: 'x', excerpt: 42 }, task, 'x')).toBeNull()
  })

  it('records skill contents separately from Markdown sources', () => {
    expect(parseAgentContextRead({ tool: 'read_skill_file', kind: 'skill', documentName: 'Markdown Writing · refs.md', field: 'refs.md', excerpt: 'style rules' }, task, 'skill-1'))
      .toMatchObject({ kind: 'skill', documentName: 'Markdown Writing · refs.md', field: 'refs.md', excerpt: 'style rules' })
  })

  it('restores task identity safely and marks an interrupted run instead of resuming it', () => {
    const restored = restoreAgentTaskContext({ ...task, status: 'reading' })
    expect(restored?.status).toBe('interrupted')
    const readOnly = createAgentTaskContext({ taskId: 'read-only-task', paneId: 'pane', attached: document, reading: document, references: [], config: null, readOnly: true })
    expect(restoreAgentTaskContext(readOnly)?.readOnly).toBe(true)
    expect(restoreAgentContextReads([{ tool: 'search_document', kind: 'search', documentId: 'ref-1', documentName: 'x', query: 'term', resultCount: 0, excerpt: 'match', truncated: false }], restored!))
      .toMatchObject([{ documentId: 'ref-1', documentName: '词汇表.md', resultCount: 0, excerpt: 'match' }])
    expect(restoreAgentTaskContext({ ...task, endpoint: 'x'.repeat(600) })).toBeNull()
  })
})
