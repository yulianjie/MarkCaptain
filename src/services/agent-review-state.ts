import { reviewedMarkdown, type ReviewedEdit } from './agent'

const accepted = (edit: ReviewedEdit) => edit.changes.flatMap((change, i) => change.status === 'applied' ? [i] : [])

/** Store only change IDs/indices, not another full document for every transaction. */
export function createReviewStateTracker() {
  const checkpoints = new WeakMap<ReviewedEdit, number[][]>()
  function remember(edit: ReviewedEdit) {
    const states = checkpoints.get(edit) ?? [[]]
    const indices = accepted(edit)
    if (!states.some(state => state.join(',') === indices.join(','))) states.push(indices)
    checkpoints.set(edit, states)
  }
  function reconcile(edit: ReviewedEdit, markdown: string | undefined) {
    const current = accepted(edit)
    if (markdown === reviewedMarkdown(edit, current)) {
      edit.documentChanged = false
      if (edit.appliedMarkdown !== undefined) edit.appliedMarkdown = markdown
      return
    }
    const known = !edit.locked && !edit.rebasedTo && checkpoints.get(edit)?.find(indices => reviewedMarkdown(edit, indices) === markdown)
    if (known && markdown !== undefined) {
      for (const [i, change] of edit.changes.entries()) {
        // Rejection is a review decision, not part of the editor undo stack.
        if (change.status === 'applied' || change.status === 'reverted') change.status = known.includes(i) ? 'applied' : 'reverted'
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
