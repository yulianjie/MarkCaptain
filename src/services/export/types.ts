/** Shared frontend contract for the M0/M1 single-document export flow. */

export type ExportFormat = 'html' | 'pdf' | 'docx' | 'odt' | 'epub'
export type ExportPdfBackend = 'system-print' | 'pandoc'
export type ExportThemeId = 'simple-reading' | 'technical' | 'formal-report'
export type ExportConfigSource = 'builtin' | 'personal' | 'project' | 'this-export'
export type ExportHtmlMode = 'embed' | 'folder'

export interface ExportProfile {
  id: string
  name: string
  theme: ExportThemeId
  content: { mode: 'current'; source: 'buffer' }
  formats: ExportFormat[]
  output: { directory: string; fileName: string }
  typography: {
    bodyFont: string
    codeFont: string
    bodySizePt: number
    lineHeight: number
  }
  page: {
    size: 'A4' | 'A5' | 'Letter' | 'Legal'
    orientation: 'portrait' | 'landscape'
    marginMm: { top: number; right: number; bottom: number; left: number }
  }
  toc: { enabled: boolean; depth: number }
  numberHeadings: boolean
  resources: { htmlMode: ExportHtmlMode; downloadRemote: boolean }
  html: { showTitle: boolean }
  pdf: { backend: ExportPdfBackend }
  docx: { stylePreset: string }
  epub: { stylePreset: string }
}

export interface ExportProjectConfig {
  schemaVersion: 1
  defaultProfile: string
  profiles: ExportProfile[]
  projectExport?: import('./project-types').ProjectExportPlan
}

export interface ExportConfigSnapshot {
  config: ExportProjectConfig | null
  fingerprint: string | null
}

export interface ExportDocumentSnapshot {
  /** Frozen editor buffer. Export never saves or mutates this source. */
  markdown: string
  sourcePath?: string
  fileName: string
  capturedAt: string
  revision: string
}

export interface ExportRequest {
  taskId: string
  projectRoot?: string
  snapshot: ExportDocumentSnapshot
  profileId?: string
  configSource: ExportConfigSource
  format: ExportFormat
  pdfBackend?: ExportPdfBackend
  options: ExportProfile
  outputPath?: string
  /** Static renderer output; included for HTML and isolated system-print jobs. */
  renderedHtml?: string
  /** False for project jobs: preserve an existing output unless explicitly approved. */
  overwrite?: boolean
}

export interface ExportDiagnostic {
  code: string
  message: string
  resource?: string
  line?: number
  blocking?: boolean
}

export interface ExportCapabilities {
  html: boolean
  systemPrint: boolean
  pandoc: boolean
  pdfEngine?: string | null
  formats?: Partial<Record<ExportFormat, boolean>>
}

export interface ExportPreflightResult {
  blocking: ExportDiagnostic[]
  warnings: ExportDiagnostic[]
  capabilities: ExportCapabilities
  dependencies: {
    pandocAvailable: boolean
    pdfEngine?: string | null
  }
}

export interface ExportStartResult {
  status: 'completed'
  outputPath: string
}

export type ExportTaskStage =
  | 'created'
  | 'preflighting'
  | 'rendering'
  | 'writing'
  | 'waitingForPrintDialog'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface ExportProgressEvent {
  taskId: string
  sequence: number
  stage: ExportTaskStage
  completed?: number
  total?: number
  message?: string
}

export interface ExportResourceReadResult {
  dataUrl: string
  mime: string
  sourcePath: string
}

export interface ExportResolvedProfile {
  profile: ExportProfile
  /** Per-setting winning source, using dotted paths such as `page.size`. */
  sources: Record<string, ExportConfigSource>
  profileId?: string
}
