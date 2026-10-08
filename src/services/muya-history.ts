interface MuyaHistoryHost {
  getMarkdown(): string
  undo(): void
  redo(): void
  contentState: { history: { index: number; stack: unknown[]; pending?: unknown } }
}

interface HistoryEntry { blocks: unknown; cursor: unknown; renderRange: unknown }
interface ContentHistory {
  index: number
  stack: HistoryEntry[]
  pending: unknown
  push(state: HistoryEntry): void
}

/** Cursor-only pushes must not truncate a valid redo branch after returning from the panel. */
export function installMuyaContentHistory(history: ContentHistory) {
  const original = history.push
  function push(state: HistoryEntry) {
    const current = history.stack[history.index]
    if (current && JSON.stringify(current.blocks) === JSON.stringify(state.blocks)) {
      history.pending = null
      current.cursor = state.cursor === undefined ? undefined : JSON.parse(JSON.stringify(state.cursor))
      current.renderRange = state.renderRange === undefined ? undefined : JSON.parse(JSON.stringify(state.renderRange))
      return
    }
    original.call(history, state)
  }
  history.push = push
  return () => { if (history.push === push) history.push = original }
}

/** Muya also records cursor moves. One editor undo/redo should reach a content change. */
export function stepMuyaHistory(muya: MuyaHistoryHost, direction: 'undo' | 'redo') {
  const before = muya.getMarkdown()
  const history = muya.contentState.history
  const limit = history.stack.length + 1 // commitPending can add one entry
  for (let step = 0; step < limit; step++) {
    const index = history.index, pending = Boolean(history.pending)
    muya[direction]()
    if (muya.getMarkdown() !== before || history.index === index && !pending) break
    if (direction === 'undo' ? history.index <= 0 : history.index >= history.stack.length - 1) break
  }
}
