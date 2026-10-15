import type { PaneViewState } from '@/services/pane-view-state'

export interface PaneLayout {
  version: 1
  direction: 'horizontal' | 'vertical'
  ratio: number
  activeIndex?: number
  sizes?: number[]
  panes: { path: string; sourceMode: boolean; tabIndex?: number; empty?: boolean; cursor?: unknown | null; sourceSelection?: unknown | null }[]
}
export interface PaneLayoutView { id: string; documentId: string | null; sourceMode: boolean }

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function cursorShape(value: unknown): boolean {
  if (value === null) return true
  const cursor = record(value)
  if (!cursor) return false
  return ['anchor', 'focus'].every(key => {
    const position = record(cursor[key])
    return Boolean(position && Number.isInteger(position.line) && Number.isInteger(position.ch)
      && (position.line as number) >= 0 && (position.line as number) <= 10_000_000
      && (position.ch as number) >= 0 && (position.ch as number) <= 10_000_000)
  })
}

function sourceSelectionShape(value: unknown): boolean {
  if (value === null) return true
  const selection = record(value)
  if (!selection || !Array.isArray(selection.ranges) || selection.ranges.length < 1 || selection.ranges.length > 256
    || !Number.isInteger(selection.main) || (selection.main as number) < 0 || (selection.main as number) >= selection.ranges.length) return false
  return selection.ranges.every(value => {
    const range = record(value)
    return Boolean(range && Number.isInteger(range.anchor) && Number.isInteger(range.head)
      && (range.anchor as number) >= 0 && (range.anchor as number) <= 100_000_000
      && (range.head as number) >= 0 && (range.head as number) <= 100_000_000)
  })
}

function documentBoundary(markdown: string, offset: number): boolean {
  return offset >= 0 && offset <= markdown.length
    && !(offset > 0 && offset < markdown.length
      && markdown.charCodeAt(offset - 1) >= 0xd800 && markdown.charCodeAt(offset - 1) <= 0xdbff
      && markdown.charCodeAt(offset) >= 0xdc00 && markdown.charCodeAt(offset) <= 0xdfff)
}

function markdownLineBounds(markdown: string, wanted: number): { start: number; length: number } | null {
  let line = 0, start = 0
  for (let i = 0; i < markdown.length; i++) {
    if (markdown.charCodeAt(i) !== 10) continue
    if (line === wanted) return { start, length: i - start }
    line++; start = i + 1
  }
  return line === wanted ? { start, length: markdown.length - start } : null
}

/** Keep only lightweight, document-bounded cursor and selection fields. */
export function normalizePaneViewState(markdown: string, value: PaneViewState): PaneViewState {
  const result: PaneViewState = {}
  if (Object.prototype.hasOwnProperty.call(value, 'cursor')) {
    const cursor = value.cursor
    if (cursor === null) result.cursor = null
    else {
      const parsed = record(cursor)
      if (parsed && cursorShape(cursor)) {
        const anchor = record(parsed.anchor)!, focus = record(parsed.focus)!
        const valid = [anchor, focus].every(position => {
          const bounds = markdownLineBounds(markdown, position.line as number)
          return bounds && Number.isInteger(position.ch) && (position.ch as number) >= 0
            && (position.ch as number) <= bounds.length
            && documentBoundary(markdown, bounds.start + (position.ch as number))
        })
        if (valid) result.cursor = { anchor: { line: anchor.line, ch: anchor.ch }, focus: { line: focus.line, ch: focus.ch } }
        else result.cursor = null
      } else result.cursor = null
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, 'sourceSelection')) {
    const sourceSelection = value.sourceSelection
    if (sourceSelection === null) result.sourceSelection = null
    else if (sourceSelectionShape(sourceSelection)) {
      const parsed = record(sourceSelection)!
      const ranges = parsed.ranges as Array<Record<string, number>>
      const valid = ranges.every(range => Number.isInteger(range.anchor) && Number.isInteger(range.head)
        && documentBoundary(markdown, range.anchor) && documentBoundary(markdown, range.head))
      result.sourceSelection = valid
        ? { ranges: ranges.map(range => ({ anchor: range.anchor, head: range.head })), main: parsed.main }
        : null
    } else result.sourceSelection = null
  }
  return result
}

export function createPaneLayoutSnapshot(
  direction: PaneLayout['direction'],
  ratio: number,
  activeIndex: number,
  panes: PaneLayoutView[],
  paneSizes: Record<string, number>,
  tabs: Array<{ id: string; pathname: string; markdown: string }>,
  readViewState?: (paneId: string, tabId: string) => PaneViewState | undefined,
): PaneLayout {
  return {
    version: 1,
    direction,
    ratio,
    activeIndex,
    sizes: panes.map(pane => paneSizes[pane.id] ?? 1 / panes.length),
    panes: panes.map(pane => {
      const tab = pane.documentId ? tabs.find(candidate => candidate.id === pane.documentId) : undefined
      const tabIndex = tab ? tabs.indexOf(tab) : undefined
      const viewState = tab ? normalizePaneViewState(tab.markdown, readViewState?.(pane.id, tab.id) ?? {}) : {}
      return {
        path: tab?.pathname ?? '',
        ...(tabIndex === undefined ? {} : { tabIndex }),
        empty: pane.documentId === null,
        sourceMode: pane.sourceMode,
        ...viewState,
      }
    }),
  }
}

export function resolvePaneDocumentId(
  pane: PaneLayout['panes'][number],
  activeTabId: string | null,
  restoredTabIdsByIndex: Record<number, string>,
  findTabByPath: (path: string) => string | null,
): string | null {
  if (pane.empty) return null
  const restored = pane.tabIndex === undefined ? undefined : restoredTabIdsByIndex[pane.tabIndex]
  if (restored) return restored
  if (pane.path) return findTabByPath(pane.path)
  return activeTabId
}

export function parsePaneLayout(raw: unknown): PaneLayout | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as PaneLayout
  if (value.version !== 1 || !['horizontal', 'vertical'].includes(value.direction) || !Number.isFinite(value.ratio) || value.ratio < .15 || value.ratio > .85 || !Array.isArray(value.panes) || value.panes.length < 1 || value.panes.length > 4) return null
  if (value.panes.some(p => !p || typeof p.path !== 'string' || p.path.length > 32768 || typeof p.sourceMode !== 'boolean')) return null
  if (value.panes.some(p => p.empty !== undefined && typeof p.empty !== 'boolean')) return null
  if (value.panes.some(p => p.tabIndex !== undefined && (!Number.isInteger(p.tabIndex) || p.tabIndex < 0 && !(p.empty === true && p.tabIndex === -1)))) return null
  if (value.panes.some(p => p.cursor !== undefined && !cursorShape(p.cursor))) return null
  if (value.panes.some(p => p.sourceSelection !== undefined && !sourceSelectionShape(p.sourceSelection))) return null
  if (value.activeIndex !== undefined && (!Number.isInteger(value.activeIndex) || value.activeIndex < 0 || value.activeIndex >= value.panes.length)) return null
  if (value.sizes && (value.sizes.length !== value.panes.length || value.sizes.some(s => !Number.isFinite(s) || s <= 0 || s > 1))) return null
  return value
}
