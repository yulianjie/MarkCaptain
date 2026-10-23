import { reviewedMarkdown, type ReviewedEdit } from './agent'

const accepted = (edit: ReviewedEdit) => edit.changes.flatMap((change, i) => change.status === 'applied' ? [i] : [])

interface Checkpoint { indices: number[]; correction?: { from: number; to: number; text: string } }

/** Store indices and bounded editor-serialization corrections, not full documents. */
export function createReviewStateTracker() {
  const checkpoints = new WeakMap<ReviewedEdit, Checkpoint[]>()
  function remember(edit: ReviewedEdit, actualMarkdown?: string, originalGetsFinalNewline = false) {
    const states = checkpoints.get(edit) ?? [{ indices: [] }]
    // Muya serializes even a no-LF original with one final LF when undo restores
    // it. Record this exact engine form only for a confirmed WYSIWYG transaction.
    if (originalGetsFinalNewline && !edit.snapshot.markdown.endsWith('\n')) {
      const original: Checkpoint = { indices: [], correction: { from: edit.snapshot.markdown.length, to: edit.snapshot.markdown.length, text: '\n' } }
      if (!states.some(state => JSON.stringify(state) === JSON.stringify(original))) states.push(original)
    }
    const indices = accepted(edit)
    const state: Checkpoint = { indices }
    if (actualMarkdown !== undefined) {
      const expected = reviewedMarkdown(edit, indices)
      if (actualMarkdown !== expected) {
        let from = 0, tail = 0
        while (from < Math.min(expected.length, actualMarkdown.length) && expected[from] === actualMarkdown[from]) from++
        while (tail < Math.min(expected.length, actualMarkdown.length) - from && expected[expected.length - tail - 1] === actualMarkdown[actualMarkdown.length - tail - 1]) tail++
        const text = actualMarkdown.slice(from, actualMarkdown.length - tail)
        // Large, unrecognized serialization changes stay conflict-safe on replay.
        if (text.length > 4096) return
        state.correction = { from, to: expected.length - tail, text }
      }
    }
    const key = JSON.stringify(state)
    if (!states.some(candidate => JSON.stringify(candidate) === key)) states.push(state)
    if (states.length > 256) states.splice(1, states.length - 256)
    checkpoints.set(edit, states)
  }
  function checkpointMarkdown(edit: ReviewedEdit, state: Checkpoint) {
    const expected = reviewedMarkdown(edit, state.indices), correction = state.correction
    return correction ? expected.slice(0, correction.from) + correction.text + expected.slice(correction.to) : expected
  }
  function reconcile(edit: ReviewedEdit, markdown: string | undefined) {
    const current = accepted(edit)
    if (markdown === (edit.appliedMarkdown ?? reviewedMarkdown(edit, current))) {
      edit.documentChanged = false
      if (edit.appliedMarkdown !== undefined) edit.appliedMarkdown = markdown
      return
    }
    const known = !edit.locked && !edit.rebasedTo && checkpoints.get(edit)?.find(state => checkpointMarkdown(edit, state) === markdown)
    if (known && markdown !== undefined) {
      for (const [i, change] of edit.changes.entries()) {
        // Rejection is a review decision, not part of the editor undo stack.
        if (change.status === 'applied' || change.status === 'reverted') change.status = known.indices.includes(i) ? 'applied' : 'reverted'
      }
      const statuses = new Set(edit.changes.map(change => change.status))
      edit.status = statuses.size === 1 ? edit.changes[0]!.status : 'partial'
      edit.appliedMarkdown = markdown
      edit.documentChanged = false
    } else {
      // An unrelated edit or missing document cannot prove that an acceptance is still present.
      edit.documentChanged = true
    }
  }
  return { remember, reconcile }
}
