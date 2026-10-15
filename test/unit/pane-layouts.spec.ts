import { expect, it } from 'vitest'
import { createPaneLayoutSnapshot, normalizePaneViewState, parsePaneLayout, resolvePaneDocumentId } from '../../src/services/pane-layouts'
import { getPaneViewState, invalidatePaneViewState, paneViewStateRevision, restorePaneViewState, setPaneViewField } from '../../src/services/pane-view-state'
import { historyDiff } from '../../src/services/local-history-diff'
it('validates layout data without changing the crash-draft schema', () => {
  const layout = { version: 1, direction: 'vertical', ratio: .4, panes: [{ path: 'C:/笔记/a.md', sourceMode: true }] }
  expect(parsePaneLayout(layout)).toEqual(layout)
  expect(parsePaneLayout({ ...layout, ratio: NaN })).toBeNull()
  expect(parsePaneLayout({ ...layout, panes: Array(5).fill(layout.panes[0]) })).toBeNull()
  expect(parsePaneLayout({ ...layout, panes: [{ path: '', sourceMode: false, empty: true }] })).not.toBeNull()
  expect(parsePaneLayout({ ...layout, panes: [{ path: '', sourceMode: false, tabIndex: -1 }] })).toBeNull()
})
it('does not bind a missing saved path to a shifted tab, while retaining detached drafts by original session index', () => {
  const find = (path: string) => path === 'C:/notes/kept.md' ? 'kept-tab' : null
  expect(resolvePaneDocumentId({ path: 'C:/notes/deleted.md', sourceMode: false, tabIndex: 1 }, 'kept-tab', {}, find)).toBeNull()
  expect(resolvePaneDocumentId({ path: 'C:/notes/detached.md', sourceMode: true, tabIndex: 1 }, 'kept-tab', { 1: 'detached-draft' }, find)).toBe('detached-draft')
  expect(resolvePaneDocumentId({ path: 'C:/notes/kept.md', sourceMode: false }, null, {}, find)).toBe('kept-tab')
  expect(resolvePaneDocumentId({ path: 'old', sourceMode: false, empty: true }, 'kept-tab', {}, find)).toBeNull()
})
it('round-trips an empty editor region through persistence and restart', () => {
  const saved = createPaneLayoutSnapshot('horizontal', .5, 0,
    [{ id: 'main', documentId: null, sourceMode: true }], {}, [])

  expect(saved.panes[0]).toEqual({ path: '', empty: true, sourceMode: true })
  expect(parsePaneLayout(JSON.parse(JSON.stringify(saved)))).toEqual(saved)
  expect(resolvePaneDocumentId(saved.panes[0]!, 'bootstrap-untitled', {}, () => null)).toBeNull()

  const oldSaved = { ...saved, panes: [{ path: '', sourceMode: true, empty: true, tabIndex: -1 }] }
  expect(parsePaneLayout(oldSaved)).not.toBeNull()
  expect(resolvePaneDocumentId(oldSaved.panes[0]!, 'bootstrap-untitled', {}, () => null)).toBeNull()
})
it('restores distinct cursor and source selections for two panes showing one document', () => {
  const tabId = 'same-document-pane-layout-test'
  const markdown = 'first line\nsecond line'
  const views = {
    'same-document-pane-layout-test-a': { cursor: { anchor: { line: 0, ch: 2 }, focus: { line: 0, ch: 5 } } },
    'same-document-pane-layout-test-b': { sourceSelection: { ranges: [{ anchor: 12, head: 22 }], main: 0 } },
  }
  const saved = createPaneLayoutSnapshot('horizontal', .5, 0, [
    { id: 'same-document-pane-layout-test-a', documentId: tabId, sourceMode: false },
    { id: 'same-document-pane-layout-test-b', documentId: tabId, sourceMode: true },
  ], {}, [{ id: tabId, pathname: 'C:/notes/shared.md', markdown }], paneId => views[paneId as keyof typeof views])
  const restored = parsePaneLayout(JSON.parse(JSON.stringify(saved)))!
  expect(restored.panes[0]!.cursor).toEqual(views['same-document-pane-layout-test-a'].cursor)
  expect(restored.panes[1]!.sourceSelection).toEqual(views['same-document-pane-layout-test-b'].sourceSelection)

  const restoredPaneIds = ['same-document-pane-layout-test-a', 'same-document-pane-layout-test-b']
  for (const [index, pane] of restored.panes.entries()) {
    const view = normalizePaneViewState(markdown, {
      ...(Object.prototype.hasOwnProperty.call(pane, 'cursor') ? { cursor: pane.cursor } : {}),
      ...(Object.prototype.hasOwnProperty.call(pane, 'sourceSelection') ? { sourceSelection: pane.sourceSelection } : {}),
    })
    restorePaneViewState(restoredPaneIds[index]!, tabId, view)
  }

  expect(getPaneViewState('same-document-pane-layout-test-a', tabId)?.cursor).toEqual(views['same-document-pane-layout-test-a'].cursor)
  expect(getPaneViewState('same-document-pane-layout-test-b', tabId)?.sourceSelection).toEqual(views['same-document-pane-layout-test-b'].sourceSelection)
  expect(getPaneViewState('same-document-pane-layout-test-a', tabId)?.sourceSelection).toBeUndefined()
  expect(normalizePaneViewState('one line', { cursor: { anchor: { line: 8, ch: 0 }, focus: { line: 8, ch: 0 } }, sourceSelection: { ranges: [{ anchor: 1, head: 99 }], main: 0 } })).toEqual({ cursor: null, sourceSelection: null })
})
it('only advances the view revision for semantic changes and clears all views on reset', () => {
  const tabId = 'pane-view-revision-test'
  const before = paneViewStateRevision.value
  const cursor = { anchor: { line: 0, ch: 1 }, focus: { line: 0, ch: 1 } }
  setPaneViewField('revision-a', tabId, 'cursor', cursor)
  const afterChange = paneViewStateRevision.value
  expect(afterChange).toBeGreaterThan(before)
  setPaneViewField('revision-a', tabId, 'cursor', structuredClone(cursor))
  expect(paneViewStateRevision.value).toBe(afterChange)
  setPaneViewField('revision-b', tabId, 'sourceSelection', { ranges: [{ anchor: 0, head: 1 }], main: 0 })
  invalidatePaneViewState(tabId)
  expect(getPaneViewState('revision-a', tabId)).toBeUndefined()
  expect(getPaneViewState('revision-b', tabId)).toBeUndefined()
})
it('rejects restored source and visual carets inside a UTF-16 surrogate pair', () => {
  expect(normalizePaneViewState('line\nx😀y', {
    cursor: { anchor: { line: 1, ch: 2 }, focus: { line: 1, ch: 2 } },
    sourceSelection: { ranges: [{ anchor: 7, head: 7 }], main: 0 },
  })).toEqual({ cursor: null, sourceSelection: null })
  expect(normalizePaneViewState('line\nx😀y', {
    cursor: { anchor: { line: 1, ch: 3 }, focus: { line: 1, ch: 3 } },
  }).cursor).not.toBeNull()
})
it('diff reconstructs old and new contents including empty lines', () => {
  const before = 'one\nold\n\nend'; const after = 'one\n新内容\n\nend'; const diff = historyDiff(before, after)
  expect(diff.filter(l => l.kind !== 'added').map(l => l.text).join('\n')).toBe(before)
  expect(diff.filter(l => l.kind !== 'removed').map(l => l.text).join('\n')).toBe(after)
})
