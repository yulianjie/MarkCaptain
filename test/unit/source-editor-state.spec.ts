import { describe, expect, it } from 'vitest'
import { EditorState } from '@codemirror/state'
import { history, historyField, undoDepth } from '@codemirror/commands'

import { restoreSourceEditorState } from '../../src/services/source-editor-state'

const stateFields = { history: historyField }

describe('source editor state restoration', () => {
  it('mounts a valid EditorState when both persisted selections are stale', () => {
    const staleSelection = { ranges: [{ anchor: 99, head: 99 }], main: 0 }

    const restored = restoreSourceEditorState({
      markdown: 'short',
      sourceEditorState: {
        doc: 'short',
        selection: staleSelection,
      },
      sourceSelection: staleSelection,
    }, [history()], stateFields)

    expect(restored).toBeInstanceOf(EditorState)
    expect(restored.doc.toString()).toBe('short')
    expect(restored.selection.main.anchor).toBe(0)
    expect(restored.selection.main.head).toBe(0)
  })

  it('restores a valid standalone selection', () => {
    const restored = restoreSourceEditorState({
      markdown: 'valid selection',
      sourceEditorState: null,
      sourceSelection: { ranges: [{ anchor: 3, head: 8 }], main: 0 },
    }, [])

    expect(restored.selection.main.anchor).toBe(3)
    expect(restored.selection.main.head).toBe(8)
  })

  it('preserves valid serialized selection and history', () => {
    let original = EditorState.create({ doc: 'alpha', extensions: [history()] })
    original = original.update({
      changes: { from: original.doc.length, insert: ' beta' },
      selection: { anchor: 7 },
    }).state

    const restored = restoreSourceEditorState({
      markdown: 'alpha beta',
      sourceEditorState: original.toJSON(stateFields),
      sourceSelection: undefined,
    }, [history()], stateFields)

    expect(restored.doc.toString()).toBe('alpha beta')
    expect(restored.selection.main.anchor).toBe(7)
    expect(undoDepth(restored)).toBe(1)
  })

  it('overrides a shared CodeMirror selection with the restored pane selection and keeps history', () => {
    let original = EditorState.create({ doc: 'alpha beta gamma delta', extensions: [history()] })
    original = original.update({ changes: { from: 0, to: 5, insert: 'ALPHA' }, selection: { anchor: 3 } }).state
    const paneSelection = { ranges: [{ anchor: 12, head: 21 }], main: 0 }

    const restored = restoreSourceEditorState({
      markdown: original.doc.toString(),
      sourceEditorState: original.toJSON(stateFields),
      sourceSelection: paneSelection,
    }, [history()], stateFields)

    expect(restored.selection.main.anchor).toBe(12)
    expect(restored.selection.main.head).toBe(21)
    expect(undoDepth(restored)).toBe(1)
  })
})
