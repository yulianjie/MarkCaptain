import {
  EditorSelection,
  EditorState,
  Transaction,
  type Extension,
  type StateField,
} from '@codemirror/state'

export interface RestorableSourceEditorState {
  markdown: string
  sourceEditorState?: unknown | null
  sourceSelection?: unknown | null
}

export type SourceEditorStateFields = Record<string, StateField<unknown>>

export interface SourceDocumentUpdate {
  docChanged: boolean
  state: { doc: { toString: () => string } }
}

/** Publish only real CodeMirror document transactions to the editor store. */
export function publishSourceDocumentChange(
  update: SourceDocumentUpdate,
  tabId: string | null,
  publish: (tabId: string, markdown: string) => void,
): void {
  if (tabId && update.docChanged) publish(tabId, update.state.doc.toString())
}

function isDocumentBoundary(markdown: string, offset: number): boolean {
  return offset >= 0 && offset <= markdown.length
    && !(offset > 0 && offset < markdown.length
      && markdown.charCodeAt(offset - 1) >= 0xd800 && markdown.charCodeAt(offset - 1) <= 0xdbff
      && markdown.charCodeAt(offset) >= 0xdc00 && markdown.charCodeAt(offset) <= 0xdfff)
}

function paneSelection(markdown: string, value: unknown): EditorSelection {
  if (value !== null) {
    try {
      const selection = EditorSelection.fromJSON(value)
      if (selection.ranges.every(range => isDocumentBoundary(markdown, range.anchor) && isDocumentBoundary(markdown, range.head))) {
        return selection
      }
    } catch { /* malformed or stale per-pane selection */ }
  }
  return EditorSelection.single(0)
}

/**
 * Restore a tab's CodeMirror state without letting stale persisted selection
 * offsets prevent the source editor from mounting. Valid serialized fields
 * (including history) still take the normal `fromJSON` path.
 */
export function restoreSourceEditorState(
  tab: RestorableSourceEditorState,
  extensions: Extension,
  fields: SourceEditorStateFields = {},
): EditorState {
  let state: EditorState
  try {
    state = tab.sourceEditorState
      ? EditorState.fromJSON(tab.sourceEditorState, { extensions }, fields)
      : EditorState.create({ doc: tab.markdown, extensions })
  } catch {
    state = EditorState.create({ doc: tab.markdown, extensions })
  }
  if (state.doc.toString() !== tab.markdown) {
    state = state.update({
      changes: { from: 0, to: state.doc.length, insert: tab.markdown },
      annotations: Transaction.addToHistory.of(false),
    }).state
  }
  // The lightweight pane selection is authoritative over the selection
  // embedded in a shared/older CodeMirror state. Keep the serialized history
  // field while replacing only this pane's caret or selection.
  if (tab.sourceSelection !== undefined) {
    state = state.update({ selection: paneSelection(tab.markdown, tab.sourceSelection) }).state
  }
  return state
}
