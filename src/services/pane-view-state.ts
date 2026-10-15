import { ref } from 'vue'

export interface PaneViewState {
  cursor?: unknown | null
  sourceSelection?: unknown | null
}

type PaneViewField = keyof PaneViewState
const generations = new Map<string, number>()
const savedViews = new Map<string, Map<string, PaneViewState>>()
let nextGeneration = 0
export const paneViewStateRevision = ref(0)

export function paneViewStateGeneration(tabId: string): number {
  return generations.get(tabId) ?? 0
}

export function getPaneViewState(paneId: string, tabId: string): PaneViewState | undefined {
  const view = savedViews.get(paneId)?.get(tabId)
  return view ? { ...view } : undefined
}

function sameState(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(left) === JSON.stringify(right) } catch { return left === right }
}

export function setPaneViewField(paneId: string, tabId: string, field: PaneViewField, value: unknown | null): void {
  const views = savedViews.get(paneId) ?? new Map<string, PaneViewState>()
  const view = views.get(tabId) ?? {}
  if (Object.prototype.hasOwnProperty.call(view, field) && sameState(view[field], value)) return
  view[field] = value
  views.set(tabId, view)
  savedViews.set(paneId, views)
  paneViewStateRevision.value++
}

/** Seed a view restored from a validated pane layout. */
export function restorePaneViewState(paneId: string, tabId: string, view: PaneViewState): void {
  const views = savedViews.get(paneId) ?? new Map<string, PaneViewState>()
  const previous = views.get(tabId)
  if (previous && sameState(previous, view)) return
  views.set(tabId, { ...view })
  savedViews.set(paneId, views)
  paneViewStateRevision.value++
}

export function forgetPaneViewState(paneId: string): void {
  if (savedViews.delete(paneId)) paneViewStateRevision.value++
}

/** Invalidate cursor and editor-history snapshots cached by every pane for a document. */
export function invalidatePaneViewState(tabId: string): void {
  generations.set(tabId, ++nextGeneration)
  for (const [paneId, views] of savedViews) {
    if (views.delete(tabId) && !views.size) savedViews.delete(paneId)
  }
  paneViewStateRevision.value++
}
