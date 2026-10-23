import { analyzeNote, hasFileExtension, hasNoteExtension, headingSlug, normalizeNotePath, resolveNoteHeading, splitTarget } from '@/services/note-index'
import type { ExportDiagnostic } from './types'

export interface NormalizedExportLinks {
  markdown: string
  warnings: ExportDiagnostic[]
}

interface MarkdownEdit { from: number; to: number; replacement: string }

/** Convert Wiki links with the same syntax tree used by the notebook index. */
export function normalizeWikiLinks(markdown: string, sourcePath?: string, projectRoot?: string): NormalizedExportLinks {
  const relative = relativeDocumentPath(sourcePath, projectRoot)
  const analysis = analyzeNote(relative, markdown)
  const edits: MarkdownEdit[] = []
  const warnings: ExportDiagnostic[] = []

  for (const link of analysis.links) {
    if (link.kind !== 'wiki') continue
    const sourceFrom = link.sourceFrom ?? link.from - 2
    const sourceTo = link.sourceTo ?? link.to + 2
    const original = markdown.slice(sourceFrom, sourceTo)
    const inner = original.startsWith('[[') && original.endsWith(']]') ? original.slice(2, -2) : ''
    const separator = firstUnescapedPipe(inner)
    const explicitLabel = separator < 0 ? '' : inner.slice(separator + 1).trim()
    const { path: targetPath, heading } = splitTarget(link.target, 'wiki')
    const isSelf = !targetPath || isSameDocumentTarget(targetPath, relative, analysis.aliases)
    let destinationPath = targetPath
    let fragment = ''

    if (heading) {
      if (isSelf) {
        const targetHeading = resolveNoteHeading(analysis, heading)
        if (targetHeading) fragment = targetHeading.slug
        else {
          fragment = headingSlug(heading)
          warnings.push({
            code: 'missing-export-heading',
            message: 'This document does not contain the linked heading.',
            resource: heading,
            line: link.line,
          })
        }
      } else {
        fragment = headingSlug(heading)
      }
    }

    if (isSelf) destinationPath = ''
    else {
      if (!hasFileExtension(destinationPath)) destinationPath += '.md'
      warnings.push({
        code: 'unbundled-note-link',
        message: 'The linked Markdown note is not included in this single-file export; its .md link is preserved.',
        resource: destinationPath,
        line: link.line,
      })
    }

    const encodedPath = destinationPath ? encodeMarkdownPath(destinationPath) : ''
    const destination = `${encodedPath}${fragment ? `#${encodeURIComponent(fragment)}` : ''}`
    const display = explicitLabel || defaultWikiLabel(targetPath, heading)
    if (!display || !destination) continue
    edits.push({
      from: sourceFrom,
      to: sourceTo,
      replacement: `[${escapeMarkdownLabel(display)}](${destination})`,
    })
  }

  let output = markdown
  for (const edit of edits.sort((left, right) => right.from - left.from)) {
    output = output.slice(0, edit.from) + edit.replacement + output.slice(edit.to)
  }
  return { markdown: output, warnings }
}

/** Map note-index heading fragments onto the IDs produced by the export renderer. */
export function adaptExportHeadingAnchors(html: string, markdown: string): string {
  const document = new DOMParser().parseFromString(html, 'text/html')
  const analysis = analyzeNote('export.md', markdown)
  const headings = Array.from(document.querySelectorAll<HTMLElement>('.markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4, .markdown-body h5, .markdown-body h6'))
  const exportIdsByNoteSlug = new Map<string, string>()
  for (let index = 0; index < Math.min(analysis.headings.length, headings.length); index++) {
    const slug = analysis.headings[index].slug
    const id = headings[index].id
    if (slug && id && !exportIdsByNoteSlug.has(slug)) exportIdsByNoteSlug.set(slug, id)
  }

  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('.markdown-body a[href^="#"]')) {
    const href = anchor.getAttribute('href') ?? ''
    let fragment = href.slice(1)
    try { fragment = decodeURIComponent(fragment) } catch { /* retain literal fragment */ }
    const exportId = exportIdsByNoteSlug.get(fragment)
    if (exportId) anchor.setAttribute('href', `#${encodeURIComponent(exportId)}`)
  }

  return `<!DOCTYPE html>\n${document.documentElement.outerHTML}`
}

function relativeDocumentPath(sourcePath?: string, projectRoot?: string): string {
  if (!sourcePath) return 'untitled.md'
  const source = sourcePath.replace(/\\/g, '/')
  if (projectRoot) {
    const root = projectRoot.replace(/\\/g, '/').replace(/\/$/, '')
    const candidate = source.slice(0, root.length)
    if (candidate.toLocaleLowerCase() === root.toLocaleLowerCase() && source[root.length] === '/') {
      return source.slice(root.length + 1)
    }
  }
  return source.split('/').pop() || 'untitled.md'
}

function isSameDocumentTarget(target: string, source: string, aliases: readonly string[]): boolean {
  const sourceNormalized = normalizeNotePath(source)
  const path = target.replace(/\\/g, '/')
  let normalizedTarget: string | null
  if (path.startsWith('/')) normalizedTarget = normalizeNotePath(path.slice(1))
  else if (path.startsWith('./') || path.startsWith('../')) {
    const directory = source.includes('/') ? source.slice(0, source.lastIndexOf('/') + 1) : ''
    normalizedTarget = normalizeNotePath(directory + path)
  } else if (path.includes('/')) normalizedTarget = normalizeNotePath(path)
  else normalizedTarget = normalizeNotePath(`${source.includes('/') ? source.slice(0, source.lastIndexOf('/') + 1) : ''}${path}`)
  if (sourceNormalized && normalizedTarget
    && stripNoteExtension(sourceNormalized).toLocaleLowerCase() === stripNoteExtension(normalizedTarget).toLocaleLowerCase()) return true
  if (path.includes('/')) return false
  const basename = source.split('/').pop() ?? source
  const stem = stripNoteExtension(basename).toLocaleLowerCase()
  return stripNoteExtension(path).toLocaleLowerCase() === stem || aliases.some(alias => alias.toLocaleLowerCase() === path.toLocaleLowerCase())
}

function stripNoteExtension(path: string): string {
  return hasNoteExtension(path) ? path.replace(/\.(?:md|markdown|mkd|mdown|mkdn|mdtxt|mdtext)$/i, '') : path
}

function firstUnescapedPipe(value: string): number {
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '|' && !isEscaped(value, index)) return index
  }
  return -1
}

function isEscaped(value: string, offset: number): boolean {
  let backslashes = 0
  while (offset > 0 && value[--offset] === '\\') backslashes++
  return backslashes % 2 === 1
}

function defaultWikiLabel(path: string, heading: string): string {
  if (!path) return heading
  const name = path.split('/').pop() ?? path
  return stripNoteExtension(name)
}

function encodeMarkdownPath(value: string): string {
  return value.replace(/\\/g, '/').split('/').map(component => {
    if (component === '.' || component === '..') return component
    return encodeURIComponent(component).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
  }).join('/')
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/([\\[\]])/g, '\\$1').replace(/[\r\n]+/g, ' ')
}
