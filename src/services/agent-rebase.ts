import { reviewedMarkdown, type DocumentSnapshot, type ReviewedEdit } from './agent'

interface Block { text: string; key: string; from: number; to: number }
const MAX_DOCUMENT_LENGTH = 2_000_000

/** Keep a whole paragraph (including lists/tables) as the conflict boundary. */
function blocks(markdown: string): Block[] {
  const result: Block[] = []
  const separators = /\n[\t ]*\n(?:[\t ]*\n)*/g
  let from = 0
  for (const match of markdown.matchAll(separators)) {
    const to = match.index! + match[0].length
    const text = markdown.slice(from, match.index!)
    result.push({ text, key: text.trimEnd(), from, to })
    from = to
  }
  if (from < markdown.length) { const text = markdown.slice(from); result.push({ text, key: text.trimEnd(), from, to: markdown.length }) }
  return result
}

function increasingLengths(values: number[]): number[] {
  const tails: number[] = []
  return values.map(value => {
    let lo = 0, hi = tails.length
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (tails[mid]! < value) lo = mid + 1; else hi = mid }
    tails[lo] = value
    return lo + 1
  })
}

/** Only unique paragraphs present in every optimal ordered alignment may move.
 * Never search for a replacement substring elsewhere in the document. */
function rangeMapper(original: string, current: string) {
  if (original.length > MAX_DOCUMENT_LENGTH || current.length > MAX_DOCUMENT_LENGTH) return () => null
  if (original === current) return (from: number, to: number) => ({ from, to })
  const before = blocks(original), after = blocks(current)
  if (before.length > 10_000 || after.length > 10_000) return () => null
  const occurrences = (items: Block[]) => {
    const map = new Map<string, number[]>()
    for (const [i, block] of items.entries()) { const found = map.get(block.key) ?? []; found.push(i); map.set(block.key, found) }
    return map
  }
  const oldCounts = occurrences(before), newCounts = occurrences(after)
  const candidates = before.flatMap((block, i) => {
    const positions = newCounts.get(block.key)
    return oldCounts.get(block.key)?.length === 1 && positions?.length === 1 && after[positions[0]!]!.text === block.text ? [{ i, j: positions[0]! }] : []
  })
  const left = increasingLengths(candidates.map(item => item.j))
  const right = increasingLengths(candidates.map(item => -item.j).reverse()).reverse()
  const longest = left.reduce((maximum, value) => Math.max(maximum, value), 0)
  const layerCounts = new Map<number, number>()
  for (let i = 0; i < candidates.length; i++) if (left[i]! + right[i]! - 1 === longest) layerCounts.set(left[i]!, (layerCounts.get(left[i]!) ?? 0) + 1)
  const mapped = new Map<number, number>()
  for (const [k, item] of candidates.entries()) if (left[k]! + right[k]! - 1 === longest && layerCounts.get(left[k]!) === 1) mapped.set(item.i, item.j)
  return (from: number, to: number): { from: number; to: number } | null => {
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > original.length) return null
    const first = before.findIndex(block => from >= block.from && (from < block.to || from === original.length && block.to === from))
    const last = from === to ? first : before.findIndex(block => to > block.from && to <= block.to)
    if (first < 0 || last < first) return null
    const target = mapped.get(first)
    if (target === undefined) return null
    for (let i = first; i <= last; i++) if (mapped.get(i) !== target + i - first) return null
    const start = after[target]!.from + from - before[first]!.from
    const end = after[target + last - first]!.from + to - before[last]!.from
    return current.slice(start, end) === original.slice(from, to) ? { from: start, to: end } : null
  }
}

function reviewBase(edit: ReviewedEdit) {
  const accepted = edit.changes.filter(change => change.status === 'applied')
  const markdown = reviewedMarkdown(edit, edit.changes.flatMap((change, i) => change.status === 'applied' ? [i] : []))
  const offset = (position: number, endBoundary = false) => position + accepted.reduce((delta, change) => delta +
    (change.to < position || change.to === position && !(endBoundary && change.from === change.to) ? change.newText.length - change.oldText.length : 0), 0)
  return { markdown, offset }
}

/** Refreshing a selected scope never upgrades it to the whole document. */
export function refreshedReviewSnapshot(edit: ReviewedEdit, current: string): DocumentSnapshot | null {
  const base = reviewBase(edit)
  const fullDocument = edit.snapshot.from === 0 && edit.snapshot.to === edit.snapshot.markdown.length
  const range = fullDocument ? { from: 0, to: current.length } : rangeMapper(base.markdown, current)(edit.snapshot.from, base.offset(edit.snapshot.to))
  return range ? { ...edit.snapshot, ...range, markdown: current, snapshotId: crypto.randomUUID() } : null
}

/** Returns a new review card; accepted, dismissed and reverted changes stay on the original. */
export function rebasePendingReview(edit: ReviewedEdit, current: string): { edit: ReviewedEdit | null; conflicts: string[] } {
  const base = reviewBase(edit)
  const mapRange = rangeMapper(base.markdown, current)
  const snapshot = refreshedReviewSnapshot(edit, current)
  const pending = edit.changes.filter(change => change.status === 'pending')
  const conflicts: string[] = []
  const id = crypto.randomUUID()
  const changes = pending.flatMap((change, index) => {
    const range = mapRange(base.offset(change.from), base.offset(change.to, true))
    if (!snapshot || !range || range.from < snapshot.from || range.to > snapshot.to || current.slice(range.from, range.to) !== change.oldText || (change.sourceChangeIds?.length ?? 0) >= 64) { conflicts.push(change.id); return [] }
    return [{ ...change, ...range, id: `${id}:${index + 1}`, sourceChangeIds: [...(change.sourceChangeIds ?? []), change.id], anchor: { snapshotId: snapshot.snapshotId!, ...range },
      startLine: current.slice(0, range.from).split('\n').length,
      endLine: current.slice(0, Math.max(range.from, range.to - 1)).split('\n').length, status: 'pending' as const }]
  })
  return { edit: snapshot && changes.length ? { title: edit.title, snapshot, changes, status: 'pending', rebasedFrom: pending[0]?.id, rebaseConflicts: conflicts } : null, conflicts }
}
