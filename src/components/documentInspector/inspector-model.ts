export interface InspectorRelationItem {
  sourcePath: string
  line: number
  from: number
  to: number
  context: string
  target?: string
  kind: 'backlink' | 'mention'
}

export interface InspectorRelationGroup<T extends InspectorRelationItem = InspectorRelationItem> {
  sourcePath: string
  items: T[]
}

/** Filter and group relation rows by source note, keeping each source's line order. */
export function groupRelationItems<T extends InspectorRelationItem>(
  items: readonly T[],
  query = '',
): InspectorRelationGroup<T>[] {
  const needle = query.trim().toLocaleLowerCase()
  const grouped = new Map<string, T[]>()
  for (const item of items) {
    if (needle && !`${item.sourcePath} ${item.line} ${item.context} ${item.target ?? ''}`.toLocaleLowerCase().includes(needle)) continue
    const rows = grouped.get(item.sourcePath) ?? []
    rows.push(item)
    grouped.set(item.sourcePath, rows)
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }))
    .map(([sourcePath, rows]) => ({
      sourcePath,
      items: rows.sort((left, right) => left.line - right.line || left.from - right.from),
    }))
}

export function relationItemCount(groups: readonly InspectorRelationGroup[]): number {
  return groups.reduce((count, group) => count + group.items.length, 0)
}
