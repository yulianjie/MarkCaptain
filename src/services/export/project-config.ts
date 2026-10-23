import { exportSaveConfig } from '@/services/tauri-invoke'
import { loadProjectExportConfig } from './config'
import { mergePreservingUnknown, validateExportProjectConfig } from './profiles'
import type { ExportConfigSnapshot, ExportProfile, ExportProjectConfig } from './types'
import type { ProjectExportChapter, ProjectExportPlan } from './project-types'

type ExtendedConfig = ExportProjectConfig & { projectExport?: ProjectExportPlan }
const formats = ['html', 'pdf', 'docx', 'odt', 'epub']
const byteLength = (value: string) => new TextEncoder().encode(value).length
const hasControl = (value: string) => Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)

export function validateProjectExportPlan(value: unknown): value is ProjectExportPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const plan = value as Record<string, unknown>
  if (plan.schemaVersion !== 1 || !['batch', 'book'].includes(String(plan.mode))) return false
  if (typeof plan.title !== 'string' || byteLength(plan.title) > 200 || hasControl(plan.title)) return false
  if (typeof plan.profileId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(plan.profileId)) return false
  if (typeof plan.bookFileName !== 'string' || !plan.bookFileName.trim() || byteLength(plan.bookFileName) > 120
    || /[<>:"/\\|?*{}]/.test(plan.bookFileName) || /[. ]$/.test(plan.bookFileName)
    || hasControl(plan.bookFileName) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(plan.bookFileName)) return false
  if (typeof plan.overwrite !== 'boolean' || !Array.isArray(plan.formats) || !plan.formats.length
    || plan.formats.some(format => !formats.includes(String(format))) || new Set(plan.formats).size !== plan.formats.length) return false
  if (!Array.isArray(plan.chapters) || plan.chapters.length > 64) return false
  const seen = new Set<string>()
  for (const chapter of plan.chapters) {
    if (!chapter || typeof chapter !== 'object' || Array.isArray(chapter)) return false
    const row = chapter as Record<string, unknown>
    if (typeof row.path !== 'string' || !row.path || byteLength(row.path) > 1000 || /[\\:*?<>"|]/.test(row.path)
      || row.path.startsWith('/') || row.path.split('/').some(part => !part || part === '.' || part === '..')
      || hasControl(row.path) || !/\.(md|markdown|mkd|mdown|mkdn|mdtxt|mdtext)$/i.test(row.path) || seen.has(row.path.toLowerCase())) return false
    if (typeof row.title !== 'string' || byteLength(row.title) > 200 || hasControl(row.title) || !Number.isInteger(row.level)
      || Number(row.level) < 1 || Number(row.level) > 5) return false
    if ('tabId' in row || 'markdown' in row) return false
    seen.add(row.path.toLowerCase())
  }
  return true
}

export function projectPlanFromConfig(snapshot: ExportConfigSnapshot): ProjectExportPlan | null {
  const plan = (snapshot.config as ExtendedConfig | null)?.projectExport
  if (plan === undefined) return null
  if (!validateProjectExportPlan(plan)) throw new Error('project-export-plan-invalid')
  return JSON.parse(JSON.stringify(plan)) as ProjectExportPlan
}

export async function loadProjectExportPlan(root: string): Promise<{ snapshot: ExportConfigSnapshot; plan: ProjectExportPlan | null }> {
  const snapshot = await loadProjectExportConfig(root)
  return { snapshot, plan: projectPlanFromConfig(snapshot) }
}

/** Only rebuildable relative paths are persisted; buffer identities and text never enter export.json. */
export function persistentProjectChapters(chapters: readonly ProjectExportChapter[]): ProjectExportPlan['chapters'] {
  return chapters.filter(chapter => Boolean(chapter.relativePath)).map(chapter => ({
    path: chapter.relativePath!, title: chapter.title, level: chapter.level,
  }))
}

export async function saveProjectExportPlan(
  root: string, plan: ProjectExportPlan, profile: ExportProfile, current: ExportConfigSnapshot,
): Promise<ExportConfigSnapshot> {
  if (!validateProjectExportPlan(plan)) throw new Error('project-export-plan-invalid')
  const existing = current.config
  const profiles = existing?.profiles ?? []
  const config: ExtendedConfig = {
    ...(existing ?? { schemaVersion: 1, defaultProfile: profile.id }),
    profiles: profiles.some(item => item.id === profile.id)
      ? profiles.map(item => item.id === profile.id ? mergePreservingUnknown(item, profile) : item)
      : [...profiles, JSON.parse(JSON.stringify(profile)) as ExportProfile],
    projectExport: mergePreservingUnknown((existing as ExtendedConfig | null)?.projectExport ?? plan, plan),
  }
  if (!validateExportProjectConfig(config)) throw new Error('project-export-plan-invalid')
  return exportSaveConfig(root, config, current.fingerprint)
}
