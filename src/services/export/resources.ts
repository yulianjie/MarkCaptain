import type { ExportDocumentSnapshot, ExportDiagnostic, ExportResourceReadResult } from './types'

export type ExportResourceReader = (
  sourcePath: string,
  resource: string,
  projectRoot?: string,
) => Promise<ExportResourceReadResult>

export interface PreparedHtmlResources {
  /** Safe preview HTML; remote images are deliberately not fetched. */
  html: string
  warnings: ExportDiagnostic[]
  blocking: ExportDiagnostic[]
}

/** Resolve local Markdown images against the frozen source document. */
export async function prepareHtmlResources(
  html: string,
  snapshot: ExportDocumentSnapshot,
  projectRoot: string | undefined,
  downloadRemote: boolean,
  readResource: ExportResourceReader,
  signal?: AbortSignal,
): Promise<PreparedHtmlResources> {
  const document = new DOMParser().parseFromString(html, 'text/html')
  const images = Array.from(document.querySelectorAll<HTMLImageElement>('img[src]'))
  const warnings: ExportDiagnostic[] = []
  const blocking: ExportDiagnostic[] = []
  for (const element of document.querySelectorAll<HTMLElement>('[data-export-render-warning]')) {
    warnings.push({ code: 'diagram-resource-disabled', message: element.dataset.exportRenderWarning ?? 'External diagram resources are disabled.' })
    delete element.dataset.exportRenderWarning
  }
  let embeddedDataUrlBytes = 0

  for (const svg of document.querySelectorAll<SVGSVGElement>('svg')) {
    try {
      const exportSvg = svg.cloneNode(true) as SVGSVGElement
      makeSvgDimensionsExplicit(exportSvg)
      const xml = new XMLSerializer().serializeToString(exportSvg)
      const dataUrl = `data:image/svg+xml;base64,${encodeBase64Utf8(xml)}`
      embeddedDataUrlBytes += dataUrl.length
      if (embeddedDataUrlBytes > 48 * 1024 * 1024) {
        blocking.push({
          code: 'embedded-resource-budget-exceeded',
          message: 'Embedded diagrams exceed the 48 MiB export preview limit.',
          blocking: true,
        })
        continue
      }
      svg.setAttribute('data-export-svg', dataUrl)
    } catch {
      blocking.push({
        code: 'svg-serialization-failed',
        message: 'A diagram could not be serialized as standalone XML for Pandoc export.',
        blocking: true,
      })
    }
  }

  await runBounded(images, 4, async image => {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
    const source = image.getAttribute('src')?.trim()
    if (!source || /^(?:data|blob):/i.test(source) || source.startsWith('#')) return

    if (/^(?:https?:)?\/\//i.test(source)) {
      image.dataset.exportRemoteSrc = source
      image.dataset.exportRemotePlaceholder = 'true'
      image.removeAttribute('src')
      if (downloadRemote) {
        blocking.push({
          code: 'remote-resource-download-unavailable',
          message: 'Remote images are not downloaded by this export workflow yet.',
          resource: source,
          blocking: true,
        })
      } else {
        image.alt = image.alt || 'Remote image is not loaded in preview'
        warnings.push({
          code: 'remote-resource-not-embedded',
          message: 'This remote image remains linked and will need network access to display.',
          resource: source,
        })
      }
      return
    }

    if (!snapshot.sourcePath) {
      image.removeAttribute('src')
      image.dataset.exportMissingResource = 'true'
      blocking.push({
        code: 'resource-base-path-missing',
        message: 'A local image cannot be resolved because this document has no file path.',
        resource: source,
        blocking: true,
      })
      return
    }

    try {
      const resource = await readResource(snapshot.sourcePath, source, projectRoot)
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
      if (!resource.dataUrl.startsWith('data:')) throw new Error('Resource reader returned a non-data URL')
      embeddedDataUrlBytes += resource.dataUrl.length
      if (embeddedDataUrlBytes > 48 * 1024 * 1024) {
        image.removeAttribute('src')
        image.dataset.exportMissingResource = 'true'
        blocking.push({
          code: 'embedded-resource-budget-exceeded',
          message: 'Embedded local images exceed the 48 MiB export preview limit.',
          blocking: true,
        })
        return
      }
      image.src = resource.dataUrl
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error
      image.removeAttribute('src')
      image.dataset.exportMissingResource = 'true'
      warnings.push({
        code: 'local-resource-unavailable',
        message: 'A local image could not be read; the export will show its alternative text.',
        resource: source,
      })
    }
  }, signal)

  const serialized = `<!DOCTYPE html>\n${document.documentElement.outerHTML}`
  return { html: serialized, warnings, blocking }
}

/** Pandoc needs an intrinsic SVG size when Mermaid's SVG uses a responsive width. */
function makeSvgDimensionsExplicit(svg: SVGSVGElement): void {
  const width = svg.getAttribute('width')?.trim()
  const height = svg.getAttribute('height')?.trim()
  const styleWidth = svg.style.width.trim()
  const responsiveWidth = width === '100%' || styleWidth === '100%'
  if (!responsiveWidth || (height && height !== '')) return

  const viewBox = svg.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number)
  if (!viewBox || viewBox.length !== 4 || !Number.isFinite(viewBox[2]) || !Number.isFinite(viewBox[3])) return
  const [, , viewBoxWidth, viewBoxHeight] = viewBox
  if (viewBoxWidth <= 0 || viewBoxHeight <= 0) return

  svg.setAttribute('width', String(viewBoxWidth))
  svg.setAttribute('height', String(viewBoxHeight))
}

/** Restore remote image URLs for the saved HTML, never for the preview iframe. */
export function restoreExternalImageLinks(html: string): string {
  const document = new DOMParser().parseFromString(html, 'text/html')
  for (const image of document.querySelectorAll<HTMLImageElement>('img[data-export-remote-src]')) {
    const source = image.dataset.exportRemoteSrc
    if (source) image.setAttribute('src', source)
    delete image.dataset.exportRemoteSrc
    delete image.dataset.exportRemotePlaceholder
    if (image.alt === 'Remote image is not loaded in preview') image.alt = ''
  }
  return `<!DOCTYPE html>\n${document.documentElement.outerHTML}`
}

async function runBounded<T>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError')
      const index = next++
      await worker(values[index])
    }
  })
  await Promise.all(runners)
}

function encodeBase64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}
