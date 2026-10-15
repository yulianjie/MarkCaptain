import { resolveNoteLink, type NoteAnalysis, type NoteLink } from './note-index'
import { noteStem } from './notebook'
export interface NoteRelations {
  backlinks: { note: { relative: string }; link: NoteLink; context: string }[]
  mentions: { note: { relative: string }; from: number; to: number; line: number; context: string }[]
}
export function relationsFromSource(source: NoteAnalysis, target: NoteAnalysis, notes: readonly NoteAnalysis[]): NoteRelations {
  const note = { relative: source.relative }
  const backlinks = source.links.filter(link => {
    if (link.referenceDefinition) return false
    const resolved = resolveNoteLink(source.relative, link, notes)
    return resolved.length === 1 && resolved[0].relative === target.relative
  }).map(link => ({ note, link, context: link.context ?? '' }))
  const mentions: NoteRelations['mentions'] = []
  if (source.relative === target.relative) return { backlinks, mentions }
  const names = [...new Set([noteStem(target.relative.split('/').pop()!), ...target.aliases])].filter(n => n.trim())
  for (const name of names) {
    const resolved = resolveNoteLink(source.relative, { kind: 'wiki', target: name }, notes)
    if (resolved.length !== 1 || resolved[0].relative !== target.relative) continue
    const expression = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
    let count = 0
    for (const match of source.prose.matchAll(expression)) {
      const from = match.index!; const end = from + match[0].length
      if ((/[a-z0-9_]/i.test(name[0]) && /[\p{L}\p{N}_]/u.test(source.prose[from - 1] ?? '')) || (/[a-z0-9_]/i.test(name.at(-1)!) && /[\p{L}\p{N}_]/u.test(source.prose[end] ?? ''))) continue
      const line = source.prose.slice(0, from).split('\n').length
      const lineStart = source.prose.lastIndexOf('\n', from - 1) + 1
      const lineEnd = source.prose.indexOf('\n', end)
      mentions.push({ note, from, to: end, line, context: source.prose.slice(Math.max(lineStart, from - 80), Math.min(lineEnd < 0 ? source.prose.length : lineEnd, end + 160)) })
      if (++count >= 100) break
    }
  }
  return { backlinks, mentions }
}
