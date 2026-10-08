/**
 * Document-state factories — port of the original
 * `upstream/src/renderer/store/help.js`.
 *
 * One document = one editor tab. The fields here are read by the editor
 * store, the tab bar, the sidebar's "opened files" section, and the
 * autosave bookkeeping. Keep the shape stable; downstream code grew up
 * around it.
 */

import { v4 as uuid } from '@/util/uuid'
import type { TrailingNewlinePolicy } from '@/services/trailing-newline'

export interface Encoding {
  encoding: string
  isBom: boolean
}

export interface HistoryStack {
  stack: unknown[]
  index: number
}

export interface WordCount {
  paragraph: number
  word: number
  character: number
  all: number
}

export interface SearchMatches {
  index: number
  matches: unknown[]
  value: string
}

export interface ExternalDocumentChange {
  kind: 'modified' | 'renamed'
  path: string
  previousPath?: string
  markdown: string
  encoding: Encoding
  lineEnding: 'lf' | 'crlf'
}

export interface DocumentState {
  id: string
  isSaved: boolean
  pendingBaselineUpdate: boolean
  pathname: string
  filename: string
  markdown: string
  /** Last complete Markdown snapshot known to be on disk. */
  lastSavedMarkdown: string
  encoding: Encoding
  lineEnding: 'lf' | 'crlf'
  trimTrailingNewline: TrailingNewlinePolicy
  adjustLineEndingOnSave: boolean
  history: HistoryStack
  /** Markdown snapshot that the Muya history stack was built against. */
  historyMarkdown: string
  /** CodeMirror's JSON state, including its history field, for this tab. */
  sourceEditorState: unknown | null
  /** Compact CodeMirror selection JSON persisted independently of its history. */
  sourceSelection: unknown | null
  /** View mode belongs to the tab rather than to the window as a whole. */
  sourceMode: boolean
  cursor: unknown
  wordCount: WordCount
  searchMatches: SearchMatches
  notifications: Notification[]
  /** Pending external content that must be resolved before a manual save. */
  externalChange: ExternalDocumentChange | null
  /** Pauses autosave after an external conflict until the user saves manually. */
  autoSaveBlocked: boolean
}

export interface Notification {
  type: 'info' | 'warning' | 'error'
  message: string
  showConfirm?: boolean
  timeout?: number
}

export const defaultFileState = (): DocumentState => ({
  id: '',
  isSaved: true,
  pendingBaselineUpdate: false,
  pathname: '',
  filename: 'Untitled-1',
  markdown: '',
  lastSavedMarkdown: '',
  encoding: { encoding: 'utf8', isBom: false },
  lineEnding: 'lf',
  trimTrailingNewline: 3,
  adjustLineEndingOnSave: false,
  history: { stack: [], index: -1 },
  historyMarkdown: '',
  sourceEditorState: null,
  sourceSelection: null,
  sourceMode: false,
  cursor: null,
  wordCount: { paragraph: 0, word: 0, character: 0, all: 0 },
  searchMatches: { index: -1, matches: [], value: '' },
  notifications: [],
  externalChange: null,
  autoSaveBlocked: false,
})

export interface DocumentOptions {
  encoding: Encoding
  lineEnding: 'lf' | 'crlf'
  adjustLineEndingOnSave: boolean
  trimTrailingNewline: TrailingNewlinePolicy
}

export function getOptionsFromState(file: DocumentState): DocumentOptions {
  const { encoding, lineEnding, adjustLineEndingOnSave, trimTrailingNewline } = file
  return { encoding, lineEnding, adjustLineEndingOnSave, trimTrailingNewline }
}

/**
 * Untitled document state — used when the user opens a new tab without
 * picking a file. Numbering follows the existing tabs so we never reuse
 * `Untitled-3` while a `Untitled-3` is already open.
 */
export function getBlankFileState(
  tabs: DocumentState[],
  defaultEncoding = 'utf8',
  lineEnding: 'lf' | 'crlf' = 'lf',
  markdown = '',
): DocumentState {
  const fileState = defaultFileState()
  const highest = tabs.reduce((max, f) => {
    if (f.pathname) return max
    const n = Number(f.filename.split('-')[1])
    return Number.isFinite(n) && n > max ? n : max
  }, 0)
  fileState.id = uuid()
  fileState.filename = `Untitled-${highest + 1}`
  fileState.markdown = markdown ?? ''
  fileState.lastSavedMarkdown = fileState.markdown
  fileState.historyMarkdown = fileState.markdown
  fileState.encoding.encoding = defaultEncoding
  fileState.lineEnding = lineEnding
  fileState.adjustLineEndingOnSave = lineEnding.toLowerCase() === 'crlf'
  return fileState
}

export interface CreateFromDataArgs {
  markdown: string
  filename: string
  pathname: string
  encoding: Encoding
  lineEnding: 'lf' | 'crlf'
  adjustLineEndingOnSave?: boolean
  trimTrailingNewline?: TrailingNewlinePolicy
}

export function getFileStateFromData(data: CreateFromDataArgs): DocumentState {
  const fileState = defaultFileState()
  const {
    markdown,
    filename,
    pathname,
    encoding,
    lineEnding,
    adjustLineEndingOnSave = lineEnding === 'crlf',
    trimTrailingNewline = 3,
  } = data
  assertLineEnding(adjustLineEndingOnSave, lineEnding)
  return Object.assign(fileState, {
    id: uuid(),
    markdown,
    lastSavedMarkdown: markdown,
    historyMarkdown: markdown,
    filename,
    pathname,
    encoding,
    lineEnding,
    adjustLineEndingOnSave,
    trimTrailingNewline,
  })
}

function assertLineEnding(adjustLineEndingOnSave: boolean, lineEnding: 'lf' | 'crlf') {
  const le = lineEnding.toLowerCase()
  if ((adjustLineEndingOnSave && le !== 'crlf') || (!adjustLineEndingOnSave && le === 'crlf')) {
    console.warn('Line ending mismatch: lineEnding=%s adjustLineEndingOnSave=%s', le, adjustLineEndingOnSave)
  }
}
