import type { ExportDiagnostic, ExportDocumentSnapshot, ExportFormat, ExportProfile } from './types'

export type ProjectExportMode = 'batch' | 'book'
export interface ProjectExportChapter {
  key: string
  relativePath?: string
  tabId?: string
  title: string
  level: number
}
export interface ProjectExportPlan {
  schemaVersion: 1
  mode: ProjectExportMode
  title: string
  chapters: { path: string; title: string; level: number }[]
  formats: ExportFormat[]
  profileId: string
  bookFileName: string
  overwrite: boolean
}
export interface ProjectExportCandidate { path: string; relative: string; name: string; size: number }
export interface ProjectExportSource {
  sourceId: string
  relativePath?: string
  snapshot: ExportDocumentSnapshot
  revision: string
  origin: 'disk' | 'buffer' | 'untitled'
  tabId?: string
}
export interface ProjectExportSnapshot {
  root: string
  sources: ProjectExportSource[]
  errors: { relativePath: string; code: string }[]
  capturedAt: string
  revision: string
}
export interface ProjectExportTab { id: string; pathname?: string; filename: string; markdown: string; isSaved: boolean }
export interface ProjectExportOptions {
  root: string
  chapters: ProjectExportChapter[]
  mode: ProjectExportMode
  title: string
  bookFileName: string
  formats: ExportFormat[]
  profile: ExportProfile
  overwrite: boolean
  language: string
  muya?: unknown
}
export type ProjectExportItemStatus = 'pending' | 'rendering' | 'ready' | 'writing' | 'completed' | 'failed' | 'cancelled'
export interface ProjectExportItem {
  id: string
  sourceId?: string
  name: string
  format: ExportFormat
  outputPath: string
  status: ProjectExportItemStatus
  error?: string
  warnings: ExportDiagnostic[]
}
export interface ProjectExportState {
  stage: 'idle' | 'preparing' | 'ready' | 'running' | 'completed' | 'cancelled' | 'failed' | 'stale'
  snapshot: ProjectExportSnapshot | null
  items: ProjectExportItem[]
  warnings: ExportDiagnostic[]
  blocking: ExportDiagnostic[]
  previewHtml: string
  error: string
}
