import { describe, expect, it } from 'vitest'
import { installMuyaContentHistory, stepMuyaHistory } from '../../src/services/muya-history'

describe('Muya content history stepping', () => {
  it('preserves redo when a cursor-only snapshot is pushed, but branches for a real text edit', () => {
    const original = { blocks: [{ text: 'original' }], cursor: { offset: 0 }, renderRange: {} }
    const history = {
      index: 0, pending: null as unknown,
      stack: [original, { ...original, blocks: [{ text: 'applied' }] }],
      push(state: typeof original) { this.stack.splice(this.index + 1); this.stack.push(state); this.index++ },
    }
    const dispose = installMuyaContentHistory(history)
    history.push({ ...original, cursor: { offset: 3 } })
    expect(history.stack).toHaveLength(2)
    expect(history.index).toBe(0)
    expect(history.stack[1]!.blocks[0]!.text).toBe('applied')
    history.push({ ...original, blocks: [{ text: 'typed' }] })
    expect(history.index).toBe(1)
    expect(history.stack[1]!.blocks[0]!.text).toBe('typed')
    dispose()
  })
  it('skips cursor-only snapshots but never skips a distinct text edit on undo or redo', () => {
    const docs = ['original', 'accepted A', 'accepted A', 'accepted A and B', 'accepted A and B']
    const history = { index: 4, stack: docs }
    const muya = {
      contentState: { history }, getMarkdown: () => docs[history.index]!,
      undo: () => { history.index = Math.max(0, history.index - 1) },
      redo: () => { history.index = Math.min(docs.length - 1, history.index + 1) },
    }
    stepMuyaHistory(muya, 'undo'); expect(muya.getMarkdown()).toBe('accepted A')
    stepMuyaHistory(muya, 'undo'); expect(muya.getMarkdown()).toBe('original')
    stepMuyaHistory(muya, 'redo'); expect(muya.getMarkdown()).toBe('accepted A')
    stepMuyaHistory(muya, 'redo'); expect(muya.getMarkdown()).toBe('accepted A and B')
    stepMuyaHistory(muya, 'redo'); expect(history.index).toBe(4)
    stepMuyaHistory(muya, 'redo'); expect(history.index).toBe(4)
  })
})
