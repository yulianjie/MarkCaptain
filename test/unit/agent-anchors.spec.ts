import { describe, expect, it } from 'vitest'
import { isDocumentBoundary, reviewProposal, reviewedMarkdown, type AgentChange, type DocumentSnapshot } from '../../src/services/agent'

const snapshot: DocumentSnapshot = {
  tabId: 'doc', name: 'note.md', markdown: '😀same same\nend', from: 0, to: 15, snapshotId: 'version-a',
}
const change: AgentChange = { oldText: 'same', newText: 'second', anchor: { snapshotId: 'version-a', from: 7, to: 11 } }

describe('snapshot-bound edit anchors', () => {
  it('changes only the second identical phrase using UTF-16 document positions', () => {
    const edit = reviewProposal(snapshot, { title: 'Second occurrence', changes: [change] }, 'proposal')
    expect(edit.changes[0]).toMatchObject({ from: 7, to: 11, anchor: change.anchor })
    expect(reviewedMarkdown(edit, [0])).toBe('😀same second\nend')
    expect(() => reviewProposal(snapshot, { title: 'Ambiguous', changes: [{ oldText: 'same', newText: 'other' }] })).toThrow('agent:invalidEdit')
  })

  it('keeps selection anchors in absolute document coordinates', () => {
    const selected = { ...snapshot, from: 7, to: 11 }
    const edit = reviewProposal(selected, { title: 'Selected occurrence', changes: [change] })
    expect(reviewedMarkdown(edit, [0])).toBe('😀same second\nend')
    expect(() => reviewProposal(selected, { title: 'Outside selection', changes: [{ ...change, anchor: { snapshotId: 'version-a', from: 2, to: 6 } }] })).toThrow('agent:invalidEdit')
  })

  it('rejects stale or missing snapshot versions, mismatched original text and invalid boundaries', () => {
    for (const anchor of [
      { snapshotId: 'version-old', from: 7, to: 11 },
      { snapshotId: 'version-a', from: 7, to: 12 },
      { snapshotId: 'version-a', from: -1, to: 3 },
      { snapshotId: 'version-a', from: 7, to: 100 },
      { snapshotId: 'version-a', from: 7.5, to: 11 },
      { snapshotId: 'version-a', from: 11, to: 7 },
      { snapshotId: 'reference:version-a', from: 7, to: 11 },
    ]) expect(() => reviewProposal(snapshot, { title: 'Invalid', changes: [{ ...change, anchor }] })).toThrow('agent:invalidEdit')
    expect(() => reviewProposal({ ...snapshot, snapshotId: undefined }, { title: 'Unbound', changes: [change] })).toThrow('agent:invalidEdit')
    const halfEmoji = { oldText: snapshot.markdown.slice(1, 2), newText: 'x', anchor: { snapshotId: 'version-a', from: 1, to: 2 } }
    expect(() => reviewProposal(snapshot, { title: 'Split surrogate', changes: [halfEmoji] })).toThrow('agent:invalidEdit')
    expect(() => reviewProposal({ ...snapshot, from: 1 }, { title: 'Split scope', changes: [change] })).toThrow('agent:invalidEdit')
    expect(isDocumentBoundary(snapshot.markdown, 1)).toBe(false)
    expect(isDocumentBoundary(snapshot.markdown, 2)).toBe(true)
  })

  it('rejects overlapping targets and duplicate insertions while allowing disjoint repeated text', () => {
    const first = { ...change, anchor: { snapshotId: 'version-a', from: 2, to: 6 } }
    expect(reviewProposal(snapshot, { title: 'Both', changes: [first, change] }).changes).toHaveLength(2)
    const overlap = { oldText: 'same same', newText: 'both', anchor: { snapshotId: 'version-a', from: 2, to: 11 } }
    expect(() => reviewProposal(snapshot, { title: 'Overlap', changes: [overlap, change] })).toThrow('agent:invalidEdit')
    const insert = { oldText: '', newText: '!', anchor: { snapshotId: 'version-a', from: 7, to: 7 } }
    expect(() => reviewProposal(snapshot, { title: 'Duplicate', changes: [insert, { ...insert, newText: '?' }] })).toThrow('agent:invalidEdit')
  })
})
