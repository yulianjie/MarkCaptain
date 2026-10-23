import type { ExportConfigSource, ExportFormat, ExportPdfBackend, ExportProfile, ExportRequest } from './types'
import type { ExportDocumentSnapshot } from './types'

export function createExportRequest(input: {
  snapshot: ExportDocumentSnapshot
  projectRoot?: string
  profileId?: string
  configSource: ExportConfigSource
  format: ExportFormat
  pdfBackend?: ExportPdfBackend
  options: ExportProfile
  outputPath?: string
  renderedHtml?: string
  overwrite?: boolean
}): ExportRequest {
  const options = JSON.parse(JSON.stringify(input.options)) as ExportProfile
  const request: ExportRequest = {
    taskId: crypto.randomUUID(),
    projectRoot: input.projectRoot || undefined,
    snapshot: input.snapshot,
    profileId: input.profileId,
    configSource: input.configSource,
    format: input.format,
    options,
    outputPath: input.outputPath,
    renderedHtml: input.renderedHtml,
    ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite }),
  }
  if (input.format === 'pdf') request.pdfBackend = input.pdfBackend ?? options.pdf.backend as ExportPdfBackend
  return Object.freeze(request)
}
