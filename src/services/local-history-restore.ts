export interface HistoryRestoreTarget {
  id: string
  path: string
  markdown: string
}

export interface ActiveHistoryRestoreTarget {
  id: string
  pathname: string
  markdown: string
  externalChange?: unknown
}

/** Ensure a history read/confirmation did not outlive its original document state. */
export function isHistoryRestoreTargetCurrent(
  current: ActiveHistoryRestoreTarget | null | undefined,
  original: HistoryRestoreTarget,
): boolean {
  return Boolean(
    current
    && !current.externalChange
    && current.id === original.id
    && current.pathname === original.path
    && current.markdown === original.markdown,
  )
}
