import { describe, expect, it } from 'vitest'
import { isHistoryRestoreTargetCurrent, type HistoryRestoreTarget } from '../../src/services/local-history-restore'

const original: HistoryRestoreTarget = {
  id: 'tab-1',
  path: 'C:\\notes\\draft.md',
  markdown: 'current content',
}

describe('local history restore target guard', () => {
  it('allows only the same active document path and Markdown snapshot without an external conflict', () => {
    const active = { id: original.id, pathname: original.path, markdown: original.markdown, externalChange: null }
    expect(isHistoryRestoreTargetCurrent(active, original)).toBe(true)
    expect(isHistoryRestoreTargetCurrent({ ...active, id: 'tab-2' }, original)).toBe(false)
    expect(isHistoryRestoreTargetCurrent({ ...active, pathname: 'C:\\notes\\moved.md' }, original)).toBe(false)
    expect(isHistoryRestoreTargetCurrent({ ...active, markdown: 'new edit' }, original)).toBe(false)
    expect(isHistoryRestoreTargetCurrent({ ...active, externalChange: { kind: 'modified' } }, original)).toBe(false)
    expect(isHistoryRestoreTargetCurrent(null, original)).toBe(false)
  })
})
