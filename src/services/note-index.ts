import { markdownLanguage } from '@codemirror/lang-markdown'
import { decodeHTMLAttribute } from 'entities'
import { frontmatter, noteStem, stringList } from './notebook'
const NOTE_EXTENSION = /\.(md|markdown|mkd|mdown|mkdn|mdtxt|mdtext)$/i
export function hasNoteExtension(path: string) { return NOTE_EXTENSION.test(path) }
export function hasFileExtension(path: string) {
  const filename = path.split('/').pop() ?? ''
  const dot = filename.lastIndexOf('.')
  return dot > 0 && dot < filename.length - 1
}
export interface NoteLink {
  from: number; to: number; target: string; kind: 'wiki' | 'markdown'; line: number
  sourceFrom?: number; sourceTo?: number; rewriteFrom?: number; rewriteTo?: number
  referenceDefinition?: boolean; context?: string
}
export interface NoteTask { from: number; to: number; checked: boolean; text: string; line: number }
export interface NoteAnalysis { relative: string; aliases: string[]; properties: Record<string, unknown>; tags: string[]; links: NoteLink[]; tasks: NoteTask[]; headings: { title: string; slug: string; from: number }[]; prose: string }
export function headingSlug(title: string) { return title.toLocaleLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-') }
export function resolveNoteHeading(note: Pick<NoteAnalysis, 'headings'>, fragment: string) {
  const slug = headingSlug(fragment)
  return note.headings.find(heading => heading.title.toLocaleLowerCase() === fragment.toLocaleLowerCase() || heading.slug === slug)
}
export function normalizeNotePath(value: string): string | null {
  const parts: string[] = []
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') { if (!parts.length) return null; parts.pop() } else parts.push(part)
  }
  return parts.join('/')
}
function escaped(text: string, offset: number) { let count = 0; while (offset > 0 && text[--offset] === '\\') count++; return count % 2 === 1 }
export function analyzeNote(relative: string, markdown: string): NoteAnalysis {
  const metadata = frontmatter(markdown)
  const properties = metadata.properties
  const mask = (text: string) => text.replace(/[^\n]/g, ' ')
  let text = metadata.match ? mask(metadata.match[0]) + markdown.slice(metadata.match[0].length) : markdown
  const tree = markdownLanguage.parser.parse(text)
  const excluded: { from: number; to: number }[] = []
  const tasks: NoteTask[] = []; const headings: NoteAnalysis['headings'] = []
  const headingSlugCounts = new Map<string, number>()
  const line = (offset: number) => markdown.slice(0, offset).split('\n').length
  tree.iterate({ enter(node) {
    if (['FencedCode', 'CodeBlock', 'InlineCode', 'HTMLBlock', 'Comment', 'CommentBlock', 'HTMLTag', 'ProcessingInstruction'].includes(node.name)) { excluded.push({ from: node.from, to: node.to }); return false }
    if (node.name === 'TaskMarker') {
      const end = markdown.indexOf('\n', node.to)
      tasks.push({ from: node.from + 1, to: node.from + 2, checked: markdown[node.from + 1].toLowerCase() === 'x', text: markdown.slice(node.to, end < 0 ? markdown.length : end).trim(), line: line(node.from) })
    }
    if (/^(ATXHeading\d|SetextHeading\d)$/.test(node.name)) {
      const title = markdown.slice(node.from, node.to).split('\n')[0].replace(/^#+\s*|\s*#+$/g, '').replace(/[*_`]/g, '').trim()
      const base = headingSlug(title)
      const duplicate = headingSlugCounts.get(base) ?? 0
      headingSlugCounts.set(base, duplicate + 1)
      headings.push({ title, slug: duplicate ? `${base}-${duplicate}` : base, from: node.from })
    }
  } })
  for (const range of excluded.sort((a,b) => b.from - a.from)) text = text.slice(0, range.from) + mask(text.slice(range.from, range.to)) + text.slice(range.to)
  const links: NoteLink[] = []
  for (const match of text.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    if (escaped(text, match.index!)) continue
    const target = match[1].split('|')[0].trim()
    if (target) links.push({ from: match.index! + 2, to: match.index! + 2 + match[1].split('|')[0].length, sourceFrom: match.index!, sourceTo: match.index! + match[0].length, target, kind: 'wiki', line: line(match.index!) })
  }
  const referenceDefinitions = new Map<string, { target: string; from: number; to: number; sourceFrom: number; sourceTo: number; line: number }>()
  const referenceDefinitionRanges: { from: number; to: number }[] = []
  const linkedRanges: { from: number; to: number }[] = []
  tree.iterate({ enter(node) {
    if (excluded.some(range => node.from >= range.from && node.to <= range.to)) return false
    if (node.name !== 'LinkReference') return
    referenceDefinitionRanges.push({ from: node.from, to: node.to })
    const label = node.node.getChild('LinkLabel'); const url = node.node.getChild('URL')
    if (!label || !url) return false
    const rawLabel = markdown.slice(label.from + 1, label.to - 1)
    const normalized = normalizeReferenceLabel(rawLabel)
    if (!normalized) return false
    let from = url.from; let to = url.to
    if (text[from] === '<') { from++; to-- }
    if (!referenceDefinitions.has(normalized)) referenceDefinitions.set(normalized, {
      target: markdown.slice(from, to), from, to, sourceFrom: node.from, sourceTo: node.to, line: line(from),
    })
    return false
  } })
  tree.iterate({ enter(node) {
    if (excluded.some(r => node.from >= r.from && node.to <= r.to)) return false
    if (node.name === 'Link') {
      linkedRanges.push({ from: node.from, to: node.to })
      if (!node.node.getChild('URL')) {
        const marks = node.node.getChildren('LinkMark')
        const firstLabel = marks.length > 1 ? markdown.slice(node.from + 1, marks[1].from) : ''
        const label = node.node.getChild('LinkLabel')
        const explicitLabel = label ? markdown.slice(label.from + 1, label.to - 1) : ''
        const key = normalizeReferenceLabel(explicitLabel || firstLabel)
        const definition = referenceDefinitions.get(key)
        if (definition && !/^(?:[\w+.-]+:|\/\/)/.test(definition.target)) links.push({
          from: node.from, to: node.to, target: definition.target, kind: 'markdown', line: line(node.from),
          sourceFrom: node.from, sourceTo: node.to, rewriteFrom: definition.from, rewriteTo: definition.to,
        })
      }
    }
    if (node.name === 'URL' && !links.some(l => !l.rewriteFrom && node.from >= l.from - 2 && node.to <= l.to + 2)) {
      if (node.node.parent?.name === 'Image') return
      let from = node.from; let to = node.to
      if (text[from] === '<') { from++; to-- }
      const target = markdown.slice(from, to)
      if (!/^(?:[\w+.-]+:|\/\/)/.test(target) && !escaped(text, from)) {
        const parent = node.node.parent
        links.push({ from, to, sourceFrom: parent?.from ?? from, sourceTo: parent?.to ?? to, target, kind: 'markdown', line: line(from), ...(parent?.name === 'LinkReference' ? { referenceDefinition: true } : {}) })
      }
    }
  } })
  const sourceLines = markdown.split('\n')
  for (const link of links) { const column = link.from - (markdown.lastIndexOf('\n', link.from - 1) + 1); link.context = sourceLines[link.line - 1]?.slice(Math.max(0, column - 80), column + 160) ?? '' }
  // Links cannot be counted again as body tags or unlinked prose mentions.
  const proseRanges = new Map<string, { from: number; to: number }>()
  for (const link of links) { const from = link.sourceFrom ?? link.from; const to = link.sourceTo ?? link.to; proseRanges.set(`${from}:${to}`, { from, to }) }
  for (const range of [...linkedRanges, ...referenceDefinitionRanges]) proseRanges.set(`${range.from}:${range.to}`, range)
  for (const range of [...proseRanges.values()].sort((a,b) => b.from - a.from)) text = text.slice(0, range.from) + mask(text.slice(range.from, range.to)) + text.slice(range.to)
  const tags = new Set(stringList(properties.tags).map(t => t.replace(/^#/, '')))
  for (const match of text.matchAll(/(?:^|[\s(])#([\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*)/gu)) if (!escaped(text, match.index! + match[0].indexOf('#'))) tags.add(match[1])
  return { relative, aliases: stringList(properties.aliases), properties, tags: [...tags], links: links.sort((a,b) => a.from - b.from), tasks, headings, prose: text }
}
function markdownDestination(value: string) {
  return decodeHTMLAttribute(value.replace(/\\([\s\S])/g, (match, char: string) => {
    const code = char.charCodeAt(0)
    return code >= 33 && code <= 47 || code >= 58 && code <= 64 || code >= 91 && code <= 96 || code >= 123 && code <= 126 ? char : match
  }))
}
function normalizeReferenceLabel(value: string) { return markdownDestination(value).trim().replace(/\s+/g, ' ').toLocaleLowerCase() }
export function splitTarget(target: string, kind: NoteLink['kind'] = 'wiki') {
  const semantic = kind === 'markdown' ? markdownDestination(target) : target
  const index = semantic.indexOf('#'); const raw = index < 0 ? semantic : semantic.slice(0, index)
  let path = raw; let heading = index < 0 ? '' : semantic.slice(index + 1)
  try { path = decodeURIComponent(path); heading = decodeURIComponent(heading) } catch { /* malformed URL stays literal */ }
  return { path, heading, suffix: index < 0 ? '' : semantic.slice(index) }
}
interface ResolverIndex {
  paths: Map<string, NoteAnalysis[]>; exactPaths: Map<string, NoteAnalysis[]>
  stems: Map<string, NoteAnalysis[]>; exactStems: Map<string, NoteAnalysis[]>
  names: Map<string, NoteAnalysis[]>; exactNames: Map<string, NoteAnalysis[]>
  filenames: Map<string, NoteAnalysis[]>; exactFilenames: Map<string, NoteAnalysis[]>
}
const resolverIndexes = new WeakMap<readonly NoteAnalysis[], ResolverIndex>()
function resolverIndex(notes: readonly NoteAnalysis[]): ResolverIndex {
  const cached = resolverIndexes.get(notes); if (cached) return cached
  const result: ResolverIndex = { paths: new Map(), exactPaths: new Map(), stems: new Map(), exactStems: new Map(), names: new Map(), exactNames: new Map(), filenames: new Map(), exactFilenames: new Map() }
  const add = (map: Map<string, NoteAnalysis[]>, key: string, note: NoteAnalysis, fold = true) => { if (!key.trim()) return; if (fold) key = key.toLocaleLowerCase(); const entries = map.get(key) ?? []; if (!entries.includes(note)) entries.push(note); map.set(key, entries) }
  for (const note of notes) {
    const filename = note.relative.split('/').pop()!
    add(result.paths, note.relative, note); add(result.exactPaths, note.relative, note, false)
    add(result.stems, noteStem(note.relative), note); add(result.exactStems, noteStem(note.relative), note, false)
    add(result.filenames, filename, note); add(result.exactFilenames, filename, note, false)
    for (const name of [noteStem(filename), ...note.aliases]) { add(result.names, name, note); add(result.exactNames, name, note, false) }
  }
  resolverIndexes.set(notes, result); return result
}
export function resolveNoteLink(source: string, link: Pick<NoteLink, 'kind' | 'target'>, notes: readonly NoteAnalysis[]): NoteAnalysis[] {
  const { path } = splitTarget(link.target, link.kind)
  const key = (value: string) => value.toLocaleLowerCase()
  const index = resolverIndex(notes)
  if (!path) return index.exactPaths.get(source) ?? index.paths.get(key(source)) ?? []
  const directory = source.includes('/') ? source.slice(0, source.lastIndexOf('/') + 1) : ''
  if (link.kind === 'markdown') {
    const resolved = normalizeNotePath(path.startsWith('/') ? path.slice(1) : directory + path)
    if (!resolved) return []
    return hasNoteExtension(path)
      ? index.exactPaths.get(resolved) ?? index.paths.get(key(resolved)) ?? []
      : index.exactStems.get(resolved) ?? index.stems.get(key(resolved)) ?? []
  }
  if (path.includes('/')) {
    const resolved = normalizeNotePath(path.startsWith('./') || path.startsWith('../') ? directory + path : path)
    if (!resolved) return []
    if (hasNoteExtension(resolved)) return index.exactPaths.get(resolved) ?? index.paths.get(key(resolved)) ?? []
    return index.exactStems.get(noteStem(resolved)) ?? index.stems.get(key(noteStem(resolved))) ?? index.exactNames.get(path) ?? index.names.get(key(path)) ?? []
  }
  const hasExtension = hasNoteExtension(path)
  const exactFiles = hasExtension ? index.exactFilenames.get(path) ?? index.filenames.get(key(path)) ?? [] : []
  const exactNames = [...new Set([...(index.exactNames.get(noteStem(path)) ?? []), ...(index.exactNames.get(path) ?? [])])]
  const foldedNames = [...new Set([...(index.names.get(key(noteStem(path))) ?? []), ...(index.names.get(key(path)) ?? [])])]
  const candidates = hasExtension && exactFiles.length
    ? [...new Set(exactFiles)]
    : hasExtension
      ? [...new Set(index.exactNames.get(path) ?? index.names.get(key(path)) ?? [])]
      : exactNames.length ? exactNames : foldedNames
  const nearby = candidates.filter(n => n.relative.slice(0, n.relative.lastIndexOf('/') + 1) === directory)
  return nearby.length ? nearby : candidates
}
function relativeLink(source: string, destination: string) {
  const from = source.split('/').slice(0,-1); const to = destination.split('/')
  while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift() }
  return '../'.repeat(from.length) + to.join('/')
}
function wikiPathForNote(relative: string, notes: readonly NoteAnalysis[]) {
  const stem = noteStem(relative); const key = stem.toLocaleLowerCase()
  return notes.some(note => note.relative !== relative && noteStem(note.relative).toLocaleLowerCase() === key) ? relative : stem
}
function encodePathComponent(value: string) { return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`) }
export interface ReferenceChange { relative: string; before: string; after: string }
export function planReferenceMove(source: string, destination: string, documents: readonly { relative: string; markdown: string }[]) {
  const notes = documents.map(d => analyzeNote(d.relative, d.markdown))
  const moved = (path: string) => path === source || path.startsWith(source + '/') ? destination + path.slice(source.length) : path
  const movedNotes = notes.map(note => ({ ...note, relative: moved(note.relative) }))
  const warnings = new Set<string>(); const changes: ReferenceChange[] = []
  for (const doc of documents) {
    const analysis = notes.find(n => n.relative === doc.relative)!
    const nextSource = moved(doc.relative)
    const edits: { from: number; to: number; text: string }[] = []
    for (const link of analysis.links) {
      const targets = resolveNoteLink(doc.relative, link, notes)
      if (targets.length > 1) {
        if (doc.relative !== nextSource || targets.some(note => moved(note.relative) !== note.relative)) warnings.add(`${doc.relative}:${link.line}: ${link.target}`)
        continue
      }
      const { path: rawPath, suffix } = splitTarget(link.target, link.kind)
      const target = targets.length === 1
        ? targets[0].relative
        : normalizeNotePath(rawPath.startsWith('/')
          ? rawPath.slice(1)
          : link.kind === 'markdown' || rawPath.startsWith('./') || rawPath.startsWith('../') || !rawPath.includes('/')
            ? `${doc.relative.includes('/') ? doc.relative.slice(0, doc.relative.lastIndexOf('/') + 1) : ''}${rawPath}`
            : rawPath)
      if (!target) {
        if (doc.relative !== nextSource) warnings.add(`${doc.relative}:${link.line}: ${link.target}`)
        continue
      }
      const nextTarget = moved(target)
      if (target === nextTarget && doc.relative === nextSource) continue
      if (link.kind === 'markdown' && !rawPath) continue
      if (link.kind === 'markdown' && rawPath.startsWith('/') && target === nextTarget) continue
      if (link.kind === 'wiki' && target === nextTarget) {
        const rootRelative = rawPath.startsWith('/') || (!rawPath.startsWith('./') && !rawPath.startsWith('../') && rawPath.includes('/'))
        if (rootRelative) continue
        if (targets.length === 1) {
          const afterMove = resolveNoteLink(nextSource, link, movedNotes)
          if (afterMove.length === 1 && afterMove[0].relative === nextTarget) continue
        }
      }
      const path = link.kind === 'wiki' ? wikiPathForNote(nextTarget, movedNotes) : relativeLink(nextSource, nextTarget)
      const replacement = (link.kind === 'markdown' ? path.split('/').map(encodePathComponent).join('/') : path) + suffix
      const from = link.rewriteFrom ?? link.from; const to = link.rewriteTo ?? link.to
      if (!edits.some(edit => edit.from === from && edit.to === to)) edits.push({ from, to, text: replacement })
    }
    let after = doc.markdown
    for (const edit of edits.sort((a,b) => b.from - a.from)) after = after.slice(0, edit.from) + edit.text + after.slice(edit.to)
    if (after !== doc.markdown) changes.push({ relative: doc.relative, before: doc.markdown, after })
  }
  return { changes, warnings: [...warnings] }
}
