import { analyzeNote, hasFileExtension, hasNoteExtension, resolveNoteHeading, resolveNoteLink, splitTarget } from '@/services/note-index'
import type { NoteAnalysis, NoteLink } from '@/services/note-index'
import { frontmatter } from '@/services/notebook'
import type { ExportDiagnostic, ExportDocumentSnapshot, ExportFormat } from './types'

/** A frozen, independently rendered and resource-prepared source. */
export interface PreparedExportChapter {
  sourceId: string
  relativePath?: string
  snapshot: ExportDocumentSnapshot
  title: string
  level: number
  order: number
  html: string
}

export interface ComposedExportBook {
  html: string
  warnings: ExportDiagnostic[]
  blocking: ExportDiagnostic[]
}

const LINK_MARKER = '#mc-project-wiki-'
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6'

/** Carry source link/heading identities through rendering without exposing metadata. */
export function prepareProjectLinkMarkdown(snapshot: ExportDocumentSnapshot, relativePath?: string): { markdown: string; warnings: ExportDiagnostic[] } {
  const markdown = snapshot.markdown
  const analysis = analyzeNote(relativePath ?? snapshot.fileName, markdown)
  const links = analysis.links
  const markerPrefix = projectLinkPrefix(markdown)
  const edits = new Map<string, { from: number; to: number; text: string }>()
  for (let index = 0; index < links.length; index++) {
    const link = links[index]
    const { path, heading } = splitTarget(link.target, link.kind)
    if (link.kind === 'markdown' && path && hasFileExtension(path) && !hasNoteExtension(path)) continue
    let from: number, to: number, text: string
    if (link.kind === 'wiki') {
      from = link.sourceFrom ?? link.from - 2
      to = link.sourceTo ?? link.to + 2
      const inner = markdown.slice(from + 2, to - 2)
      const pipe = inner.search(/(?<!\\)\|/)
      const label = pipe >= 0 ? inner.slice(pipe + 1).trim() : (path.split('/').pop() || heading).replace(/\.(?:md|markdown|mkd|mdown|mkdn|mdtxt|mdtext)$/i, '')
      text = `[${label.replace(/([\\[\]])/g, '\\$1')}](${markerPrefix}${index})`
    } else {
      from = link.rewriteFrom ?? link.from
      to = link.rewriteTo ?? link.to
      text = `${markerPrefix}${index}`
    }
    // Several reference links can share one destination definition.
    const key = `${from}:${to}`
    if (!edits.has(key)) edits.set(key, { from, to, text })
  }
  const headingPrefix = projectHeadingPrefix(markdown)
  for (const [index, heading] of analysis.headings.entries()) {
    const markerLength = /^#{1,6}[ \t]+/.exec(markdown.slice(heading.from))?.[0].length ?? 0
    const from = heading.from + markerLength
    edits.set(`heading:${index}`, { from, to: from, text: `<span class="${headingPrefix}${index}"></span>` })
  }
  let result = markdown
  for (const edit of [...edits.values()].sort((left, right) => right.from - left.from || right.to - left.to)) {
    result = result.slice(0, edit.from) + edit.text + result.slice(edit.to)
  }
  // Metadata participates in link resolution, but is not chapter body content.
  // Keeping its line breaks also preserves source diagnostic line numbers.
  const metadata = frontmatter(markdown).match
  if (metadata) result = metadata[0].replace(/[^\n]/g, '') + result.slice(metadata[0].length)
  return { markdown: result, warnings: [] }
}

/** Injective, CSS-safe identity; independent of chapter order or renderer counters. */
export function exportSourceNamespace(sourceId: string): string {
  return `mc-${Array.from(new TextEncoder().encode(sourceId), byte => byte.toString(16).padStart(2, '0')).join('')}`
}

interface ChapterDom {
  input: PreparedExportChapter
  document: Document
  article: HTMLElement
  analysis: NoteAnalysis
  ids: Map<string, string>
  headings: Map<string, string>
  chapterId: string
}

function parseChapters(chapters: readonly PreparedExportChapter[], namespace: boolean, warnings: ExportDiagnostic[]): ChapterDom[] {
  const seen = new Set<string>()
  return [...chapters].sort((left, right) => left.order - right.order).map(input => {
    if (!input.sourceId || seen.has(input.sourceId)) throw new Error('Export chapters require unique, nonempty source identities.')
    seen.add(input.sourceId)
    const document = new DOMParser().parseFromString(input.html, 'text/html')
    const article = document.querySelector<HTMLElement>('article.markdown-body')
    if (!article) throw new Error(`Prepared export has no article: ${input.relativePath}`)
    // A project TOC is created after chapter composition, never copied per source.
    if (namespace) article.querySelectorAll('.export-toc').forEach(element => element.remove())
    const analysis = analyzeNote(input.relativePath ?? `__mc_untitled__/${exportSourceNamespace(input.sourceId)}.md`, input.snapshot.markdown)
    const renderedHeadings = [...article.querySelectorAll<HTMLElement>(HEADING_SELECTOR)]
    const sourceHeadings = new Map<string, HTMLElement>()
    const headingPrefix = projectHeadingPrefix(input.snapshot.markdown)
    for (const [index, heading] of analysis.headings.entries()) {
      const marker = article.querySelector(`span.${headingPrefix}${index}`)
      const markedHeading = marker?.closest<HTMLElement>(HEADING_SELECTOR)
      const exactId = renderedHeadings.find(element => element.id === heading.slug)
      const sameText = renderedHeadings.filter(element => element.textContent?.trim().toLocaleLowerCase() === heading.title.toLocaleLowerCase())
      // Prepared sources carry provenance markers. The fallback supports already
      // prepared HTML only when its ID or unique heading text identifies a match.
      const rendered = markedHeading ?? exactId ?? (sameText.length === 1 ? sameText[0] : undefined)
      if (rendered) sourceHeadings.set(heading.slug, rendered)
      marker?.remove()
    }
    const ids = new Map<string, string>()
    const prefix = exportSourceNamespace(input.sourceId)
    const counts = new Map<string, number>()
    for (const [index, element] of [...article.querySelectorAll<HTMLElement>('[id]')].entries()) {
      const original = element.id
      const count = counts.get(original) ?? 0
      counts.set(original, count + 1)
      // Include an index, so even adversarial original IDs cannot collide with suffixes.
      const id = namespace ? `${prefix}-id-${index}-${count}` : original
      if (!ids.has(original)) ids.set(original, id)
      else warnings.push({ code: 'duplicate-export-id', message: 'A source contains duplicate IDs; links target the first occurrence.', resource: `${input.relativePath}#${original}` })
      element.id = id
    }
    const headings = new Map<string, string>()
    for (const [index, noteHeading] of analysis.headings.entries()) {
      const heading = sourceHeadings.get(noteHeading.slug)
      if (!heading) continue
      if (!heading.id) heading.id = namespace ? `${prefix}-heading-${index}` : `mc-heading-${index}`
      headings.set(noteHeading.slug, heading.id)
    }
    return { input, document, article, analysis, ids, headings, chapterId: `${prefix}-chapter` }
  })
}

function rewriteReferences(chapter: ChapterDom): void {
  const markerPrefix = projectLinkPrefix(chapter.input.snapshot.markdown)
  const idRef = (id: string) => chapter.ids.get(decodeFragment(id)) ?? id
  const cssUrls = (value: string) => value.replace(/url\(\s*(['"]?)#([^\s)'"]+)\1\s*\)/g, (_match, _quote: string, id: string) => `url(#${idRef(id)})`)
  for (const element of chapter.article.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      let value = cssUrls(attribute.value)
      if (['href', 'xlink:href'].includes(attribute.name) && value.startsWith('#') && !value.startsWith(markerPrefix)) {
        value = `#${idRef(value.slice(1))}`
      } else if (['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'headers', 'for'].includes(attribute.name)) {
        value = value.split(/\s+/).map(idRef).join(' ')
      }
      if (value !== attribute.value) element.setAttribute(attribute.name, value)
    }
  }
  for (const style of chapter.document.querySelectorAll('style')) {
    const css = cssUrls(style.textContent ?? '')
    // Renderer styles (not user templates) may use ID selectors, including Mermaid SVG roots.
    // Restrict replacement to selector preludes: #abc can also be a CSS color.
    style.textContent = css.replace(/([^{}]+)\{/g, (_match, prelude: string) => {
      for (const [before, after] of [...chapter.ids].sort((a, b) => b[0].length - a[0].length)) {
        prelude = prelude.replace(new RegExp(`#${escapeRegex(before)}(?![\\w-])`, 'g'), `#${after}`)
      }
      return `${prelude}{`
    })
  }
}

function rewriteLinks(chapters: ChapterDom[], mode: 'book' | 'batch', outputNames: Readonly<Record<string, string>>, warnings: ExportDiagnostic[]): void {
  const notes = chapters.map(chapter => chapter.analysis)
  const byAnalysis = new Map(chapters.map(chapter => [chapter.analysis, chapter]))
  for (const chapter of chapters) {
    const markerPrefix = projectLinkPrefix(chapter.input.snapshot.markdown)
    for (const anchor of chapter.article.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      const href = anchor.getAttribute('href') ?? ''
      const marker = href.startsWith(markerPrefix) ? Number(href.slice(markerPrefix.length)) : undefined
      const sourceLink: Pick<NoteLink, 'target' | 'kind'> & { line?: number } = marker !== undefined && Number.isInteger(marker) && chapter.analysis.links[marker]
        ? chapter.analysis.links[marker]
        : { target: href, kind: 'markdown' }
      if (/^(?:[\w+.-]+:|\/\/)/.test(sourceLink.target)) continue
      const { path, heading } = splitTarget(sourceLink.target, sourceLink.kind)
      if (path && hasFileExtension(path) && !hasNoteExtension(path)) continue
      const matches = resolveNoteLink(chapter.analysis.relative, sourceLink, notes)
      if (matches.length !== 1) {
        warnings.push({ code: matches.length > 1 ? 'ambiguous-export-note-link' : 'unbundled-note-link', message: matches.length > 1 ? 'The linked note matches multiple included chapters.' : 'The linked note is not included in this export.', resource: `${chapter.input.relativePath}: ${sourceLink.target}`, line: sourceLink.line })
        if (marker !== undefined) anchor.setAttribute('href', linkFallback(sourceLink))
        anchor.setAttribute('data-export-link-warning', matches.length > 1 ? 'ambiguous' : 'not-included')
        continue
      }
      const target = byAnalysis.get(matches[0])!
      let id = mode === 'book' ? target.chapterId : ''
      if (heading) {
        const noteHeading = target.analysis.headings.find(item => item.slug === heading) ?? resolveNoteHeading(target.analysis, heading)
        const actualId = (noteHeading ? target.headings.get(noteHeading.slug) : undefined) ?? target.ids.get(heading)
        // Footnotes and SVG fragment links also use exact IDs and must remain local.
        if (!actualId) {
          warnings.push({ code: 'missing-export-heading', message: 'The included note does not contain the linked heading or anchor.', resource: `${chapter.input.relativePath}: ${sourceLink.target}`, line: sourceLink.line })
          anchor.setAttribute('data-export-link-warning', 'missing-heading')
          if (marker !== undefined) anchor.setAttribute('href', linkFallback(sourceLink))
          continue
        }
        id = actualId
      }
      const pathOut = mode === 'batch' && target !== chapter ? encodeURIComponent(outputNames[target.input.sourceId]) : ''
      anchor.setAttribute('href', `${pathOut}${id ? `#${encodeURIComponent(id)}` : pathOut ? '' : '#'}`)
    }
  }
}

export function composeExportBook(input: {
  chapters: readonly PreparedExportChapter[]
  title: string
  toc?: { enabled: boolean; depth: number }
  language?: string
}): ComposedExportBook {
  if (!input.chapters.length) throw new Error('Select at least one chapter to compose a book.')
  const warnings: ExportDiagnostic[] = []
  const chapters = parseChapters(input.chapters, true, warnings)
  rewriteLinks(chapters, 'book', {}, warnings)
  chapters.forEach(rewriteReferences)
  const document = chapters[0].document.cloneNode(true) as Document
  document.body.replaceChildren()
  document.title = input.title
  if (input.title) {
    const header = document.createElement('header')
    header.className = 'export-document-title'
    const title = document.createElement('h1')
    title.textContent = input.title
    header.appendChild(title)
    document.body.appendChild(header)
  }
  const article = document.createElement('article')
  article.className = 'markdown-body export-book'
  document.body.appendChild(article)
  const styles = new Set([...document.head.querySelectorAll('style')].map(style => style.textContent))
  for (const chapter of chapters) {
    for (const style of chapter.document.head.querySelectorAll('style')) {
      if (!styles.has(style.textContent)) { document.head.appendChild(document.importNode(style, true)); styles.add(style.textContent) }
    }
    const section = document.createElement('section')
    section.className = 'export-chapter'
    section.dataset.sourceId = chapter.input.sourceId
    const level = Math.max(1, Math.min(6, Math.trunc(chapter.input.level) || 1))
    const title = document.createElement(`h${level}`)
    title.id = chapter.chapterId
    title.textContent = chapter.input.title
    section.appendChild(title)
    const sourceHeadings = [...chapter.article.querySelectorAll<HTMLElement>(HEADING_SELECTOR)]
    const minimum = Math.min(...sourceHeadings.map(heading => Number(heading.tagName.slice(1))))
    for (const heading of sourceHeadings) {
      const desired = level + 1 + Number(heading.tagName.slice(1)) - minimum
      const replacement = chapter.document.createElement(`h${Math.min(6, desired)}`)
      for (const attribute of [...heading.attributes]) replacement.setAttribute(attribute.name, attribute.value)
      replacement.replaceChildren(...heading.childNodes)
      heading.replaceWith(replacement)
      if (desired > 6) warnings.push({ code: 'export-heading-depth-clamped', message: 'A chapter heading exceeds HTML heading level 6 and was flattened.', resource: chapter.input.relativePath })
    }
    for (const child of [...chapter.article.childNodes]) section.appendChild(document.importNode(child, true))
    article.appendChild(section)
  }
  if (input.toc?.enabled) insertBookToc(document, article, input.toc.depth, input.language)
  return { html: serialize(document), warnings, blocking: [] }
}

/** Names must be the exact, collision-checked output basenames reserved by the task. */
export function rewriteExportBatchLinks(chapters: readonly PreparedExportChapter[], format: ExportFormat, outputNames: Readonly<Record<string, string>>): {
  chapters: PreparedExportChapter[]
  warnings: ExportDiagnostic[]
  blocking: ExportDiagnostic[]
} {
  const names = new Set<string>()
  for (const chapter of chapters) {
    const name = outputNames[chapter.sourceId]
    if (!name || /[/\\]/.test(name) || !name.toLowerCase().endsWith(`.${format}`) || names.has(name.toLowerCase())) throw new Error('Batch output names must be unique basenames for the selected format.')
    names.add(name.toLowerCase())
  }
  const warnings: ExportDiagnostic[] = []
  const parsed = parseChapters(chapters, false, warnings)
  rewriteLinks(parsed, 'batch', outputNames, warnings)
  return { chapters: parsed.map(chapter => ({ ...chapter.input, html: serialize(chapter.document) })), warnings, blocking: [] }
}

function insertBookToc(document: Document, article: HTMLElement, depth: number, language = 'en'): void {
  const nav = document.createElement('nav')
  nav.className = 'export-toc'
  const title = /^zh/.test(language) ? '目录' : /^ja/.test(language) ? '目次' : 'Contents'
  nav.setAttribute('aria-label', title)
  const label = document.createElement('p')
  label.className = 'export-toc-title'
  label.textContent = title
  nav.appendChild(label)
  const list = document.createElement('ol')
  const stack: Array<{ level: number; item: HTMLLIElement }> = []
  for (const heading of article.querySelectorAll<HTMLElement>(HEADING_SELECTOR)) {
    const level = Number(heading.tagName.slice(1))
    if (!heading.id || level > Math.max(1, Math.min(6, depth))) continue
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop()
    let parentList = list
    if (stack.length) {
      const parent = stack[stack.length - 1].item
      let nested = parent.querySelector<HTMLOListElement>(':scope > ol')
      if (!nested) { nested = document.createElement('ol'); parent.appendChild(nested) }
      parentList = nested
    }
    const item = document.createElement('li')
    item.className = `export-toc-level-${level}`
    const anchor = document.createElement('a')
    anchor.setAttribute('href', `#${encodeURIComponent(heading.id)}`)
    anchor.textContent = heading.textContent
    item.appendChild(anchor)
    parentList.appendChild(item)
    stack.push({ level, item })
  }
  nav.appendChild(list)
  article.prepend(nav)
  const style = document.createElement('style')
  style.textContent = '.export-toc { margin-bottom: 2em; } .export-toc-title { font-size: 1.25em; } .export-toc ol { padding-left: 1.5em; } .export-toc a { color: inherit; text-decoration: none; }'
  document.head.appendChild(style)
}

function linkFallback(link: Pick<NoteLink, 'target' | 'kind'>): string {
  const { path, heading } = splitTarget(link.target, link.kind)
  const file = link.kind === 'wiki' && path && !hasFileExtension(path) ? `${path}.md` : path
  return `${file.split('/').map(encodeURIComponent).join('/')}${heading ? `#${encodeURIComponent(heading)}` : ''}`
}
function projectLinkPrefix(markdown: string): string {
  let prefix = LINK_MARKER
  while (markdown.includes(prefix)) prefix += 'x-'
  return prefix
}
function projectHeadingPrefix(markdown: string): string {
  let prefix = 'mc-project-heading-'
  while (markdown.includes(prefix)) prefix += 'x-'
  return prefix
}
function decodeFragment(value: string): string { try { return decodeURIComponent(value) } catch { return value } }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
function serialize(document: Document): string { return `<!DOCTYPE html>\n${document.documentElement.outerHTML}` }
