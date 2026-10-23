import {
  exportCancel,
  exportPreflight,
  exportReadResource,
  exportStart,
} from '@/services/tauri-invoke'
import { buildExportThemeCss } from '@/export-themes'
import { prepareHtmlResources } from './resources'
import { createExportRequest } from './request'
import { adaptExportHeadingAnchors, normalizeWikiLinks } from './links'
import type {
  ExportDocumentSnapshot,
  ExportFormat,
  ExportPreflightResult,
  ExportProfile,
  ExportProjectConfig,
  ExportRequest,
} from './types'

interface MuyaExportOptions {
  superSubScript?: boolean
  footnote?: boolean
  isGitlabCompatibilityEnabled?: boolean
  mermaidTheme?: string
  sequenceTheme?: string
  vegaTheme?: string
}

export interface ExportPreviewResult {
  request: ExportRequest
  html: string
  preflight: ExportPreflightResult
}

export async function renderExportPreview(input: {
  snapshot: ExportDocumentSnapshot
  profile: ExportProfile
  format: ExportFormat
  projectRoot?: string
  profileId?: string
  configSource: ExportRequest['configSource']
  muya: unknown
  language: string
  signal?: AbortSignal
}): Promise<ExportPreviewResult> {
  const request = createExportRequest({
    snapshot: input.snapshot,
    projectRoot: input.projectRoot,
    profileId: input.profileId,
    configSource: input.configSource,
    format: input.format,
    options: input.profile,
  })
  const preflight = await exportPreflight(request)
  if (input.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
  const normalizedLinks = normalizeWikiLinks(input.snapshot.markdown, input.snapshot.sourcePath, input.projectRoot)

  const { default: ExportHtml } = await import('muya/lib/utils/exportHtml')
  if (input.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
  const muya = input.muya && typeof input.muya === 'object' && 'options' in input.muya
    ? input.muya as { options: MuyaExportOptions }
    : {
        options: {
          superSubScript: false,
          footnote: false,
          isGitlabCompatibilityEnabled: false,
          mermaidTheme: 'default',
          sequenceTheme: 'hand',
          vegaTheme: 'latimes',
        },
    }
  const exporter = new ExportHtml(normalizedLinks.markdown, muya)
  const html = await waitForRender(exporter.generate({
    title: input.profile.html.showTitle ? input.snapshot.fileName.replace(/\.(?:md|markdown|mkd|mdown|mkdn|mdtxt|mdtext)$/i, '') : '',
    includeTitleBlock: input.profile.html.showTitle,
    // Muya's legacy tocRenderer expects a ready-made HTML string and only
    // emits it when the source contains a [toc] token. Build our TOC from the
    // actual exported headings below instead.
    toc: '',
    printOptimization: true,
    language: input.language,
    themeCss: buildExportThemeCss(input.profile),
    extraCss: '',
  }), input.signal)
  if (input.signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
  const anchoredHtml = adaptExportHeadingAnchors(html, normalizedLinks.markdown)
  const htmlWithToc = insertExportToc(
    anchoredHtml,
    input.profile.toc.enabled,
    input.profile.toc.depth,
    input.language,
  )
  const prepared = await prepareHtmlResources(
    htmlWithToc,
    input.snapshot,
    input.projectRoot,
    input.profile.resources.downloadRemote,
    exportReadResource,
    input.signal,
  )
  const renderedDocument = new DOMParser().parseFromString(prepared.html, 'text/html')
  const hasWideTable = Array.from(renderedDocument.querySelectorAll('.markdown-body table tr'))
    .some(row => Array.from(row.children).reduce((columns, cell) => columns + (Number(cell.getAttribute('colspan')) || 1), 0) > 8)
  if (hasWideTable) prepared.warnings.push({
    code: 'wide-table-layout',
    message: 'A wide table needs final layout review. For print and paged formats, consider landscape paper, smaller text, or splitting columns.',
  })
  return {
    request,
    html: prepared.html,
    preflight: {
      ...preflight,
      warnings: [...preflight.warnings, ...normalizedLinks.warnings, ...prepared.warnings],
      blocking: [...preflight.blocking, ...prepared.blocking],
    },
  }
}

/** Add a static, format-neutral TOC that targets the renderer's actual heading IDs. */
function insertExportToc(html: string, enabled: boolean, depth: number, language: string): string {
  if (!enabled) return html

  const document = new DOMParser().parseFromString(html, 'text/html')
  const article = document.querySelector<HTMLElement>('article.markdown-body')
  if (!article) return html

  const maxDepth = Math.max(1, Math.min(6, Math.trunc(depth)))
  const headings = Array.from(article.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]'))
    .map(heading => ({ heading, level: Number(heading.tagName.slice(1)) }))
    .filter(item => item.level <= maxDepth && item.heading.textContent?.trim())
  if (!headings.length) return html

  const title = tocTitle(language)
  const nav = document.createElement('nav')
  nav.className = 'export-toc'
  nav.setAttribute('aria-label', title)
  // Keep the TOC label out of document heading numbering and downstream
  // heading extraction while retaining an accessible level-2 label.
  const heading = document.createElement('p')
  heading.className = 'export-toc-title'
  heading.setAttribute('role', 'heading')
  heading.setAttribute('aria-level', '2')
  heading.textContent = title
  nav.appendChild(heading)

  const rootList = document.createElement('ol')
  nav.appendChild(rootList)
  const stack: Array<{ level: number; item: HTMLLIElement }> = []
  for (const entry of headings) {
    while (stack.length && stack[stack.length - 1].level >= entry.level) stack.pop()
    let list = rootList
    if (stack.length) {
      const parent = stack[stack.length - 1].item
      let nested = parent.querySelector<HTMLOListElement>(':scope > ol')
      if (!nested) {
        nested = document.createElement('ol')
        parent.appendChild(nested)
      }
      list = nested
    }

    const item = document.createElement('li')
    item.className = `export-toc-level-${entry.level}`
    const link = document.createElement('a')
    link.setAttribute('href', `#${encodeURIComponent(entry.heading.id)}`)
    link.textContent = entry.heading.textContent?.trim() ?? ''
    item.appendChild(link)
    list.appendChild(item)
    stack.push({ level: entry.level, item })
  }

  article.insertBefore(nav, article.firstChild)
  const style = document.createElement('style')
  style.textContent = `
    .export-toc { margin: 0 0 2em; page-break-inside: avoid; break-inside: avoid; }
    .export-toc-title { margin: 0 0 .5em; font-size: 1.25em; }
    .export-toc ol { padding-left: 1.5em; }
    .export-toc li { margin: .2em 0; }
    .export-toc a { color: inherit; text-decoration: none; }
    @media print { .export-toc { margin-bottom: 12mm; } }
  `
  document.head.appendChild(style)
  return `<!DOCTYPE html>\n${document.documentElement.outerHTML}`
}

function tocTitle(language: string): string {
  if (/^zh(?:-|$)/i.test(language)) return '目录'
  if (/^ja(?:-|$)/i.test(language)) return '目次'
  return 'Contents'
}

export async function runExport(request: ExportRequest): Promise<{ outputPath: string }> {
  const result = await exportStart(request)
  return { outputPath: result.outputPath }
}

export function cancelExport(taskId: string): Promise<void> {
  return exportCancel(taskId)
}

export function profileSupportsFormat(profile: ExportProfile, format: ExportFormat): boolean {
  return profile.formats.includes(format)
}

export function projectConfigProfile(config: ExportProjectConfig | null, profileId?: string): ExportProfile | null {
  if (!config) return null
  return config.profiles.find(profile => profile.id === (profileId ?? config.defaultProfile)) ?? null
}

async function waitForRender(promise: Promise<string>, signal?: AbortSignal): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  let abortHandler: (() => void) | undefined
  const interrupted = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Export rendering timed out after 30 seconds.')), 30_000)
    if (signal) {
      abortHandler = () => reject(new DOMException('Export cancelled', 'AbortError'))
      signal.addEventListener('abort', abortHandler, { once: true })
    }
  })
  try {
    return await Promise.race([promise, interrupted])
  } finally {
    if (timeout) clearTimeout(timeout)
    if (signal && abortHandler) signal.removeEventListener('abort', abortHandler)
  }
}
