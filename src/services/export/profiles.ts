import type {
  ExportConfigSource,
  ExportFormat,
  ExportProfile,
  ExportProjectConfig,
  ExportResolvedProfile,
  ExportThemeId,
} from './types'

const ALL_FORMATS: ExportFormat[] = ['html', 'pdf', 'docx', 'odt', 'epub']

export const BUILTIN_PROFILES: Record<ExportThemeId, ExportProfile> = {
  'simple-reading': {
    id: 'simple-reading',
    name: 'Simple Reading',
    theme: 'simple-reading',
    content: { mode: 'current', source: 'buffer' },
    formats: ALL_FORMATS,
    output: { directory: 'exports', fileName: '{name}' },
    typography: { bodyFont: 'system-cjk', codeFont: 'system-monospace', bodySizePt: 11, lineHeight: 1.65 },
    page: {
      size: 'A4',
      orientation: 'portrait',
      marginMm: { top: 22, right: 22, bottom: 22, left: 22 },
    },
    toc: { enabled: false, depth: 3 },
    numberHeadings: false,
    resources: { htmlMode: 'embed', downloadRemote: false },
    html: { showTitle: true },
    pdf: { backend: 'system-print' },
    docx: { stylePreset: 'simple-reading' },
    epub: { stylePreset: 'simple-reading' },
  },
  technical: {
    id: 'technical',
    name: 'Technical Document',
    theme: 'technical',
    content: { mode: 'current', source: 'buffer' },
    formats: ALL_FORMATS,
    output: { directory: 'exports', fileName: '{name}' },
    typography: { bodyFont: 'system-cjk', codeFont: 'system-monospace', bodySizePt: 10.5, lineHeight: 1.55 },
    page: {
      size: 'A4',
      orientation: 'portrait',
      marginMm: { top: 20, right: 18, bottom: 20, left: 18 },
    },
    toc: { enabled: true, depth: 3 },
    numberHeadings: false,
    resources: { htmlMode: 'embed', downloadRemote: false },
    html: { showTitle: true },
    pdf: { backend: 'system-print' },
    docx: { stylePreset: 'technical' },
    epub: { stylePreset: 'technical' },
  },
  'formal-report': {
    id: 'formal-report',
    name: 'Formal Report',
    theme: 'formal-report',
    content: { mode: 'current', source: 'buffer' },
    formats: ALL_FORMATS,
    output: { directory: 'exports', fileName: '{name}' },
    typography: { bodyFont: 'system-cjk', codeFont: 'system-monospace', bodySizePt: 11, lineHeight: 1.7 },
    page: {
      size: 'A4',
      orientation: 'portrait',
      marginMm: { top: 24, right: 24, bottom: 24, left: 24 },
    },
    toc: { enabled: true, depth: 3 },
    numberHeadings: true,
    resources: { htmlMode: 'embed', downloadRemote: false },
    html: { showTitle: true },
    pdf: { backend: 'system-print' },
    docx: { stylePreset: 'formal-report' },
    epub: { stylePreset: 'formal-report' },
  },
}

export type ExportProfileOverrides = Partial<Omit<ExportProfile, 'id' | 'name'>>

export interface PersonalExportDefaults {
  defaultTheme: ExportThemeId
  options: ExportProfileOverrides
  isSaved?: boolean
}

const PERSONAL_DEFAULTS_KEY = 'markcaptain.export.personal.v1'

export function loadPersonalExportDefaults(storage: Pick<Storage, 'getItem'> | null = safeStorage()): PersonalExportDefaults {
  const fallback: PersonalExportDefaults = { defaultTheme: 'simple-reading', options: {}, isSaved: false }
  if (!storage) return fallback
  try {
    const raw = storage.getItem(PERSONAL_DEFAULTS_KEY)
    if (!raw) return fallback
    const value = JSON.parse(raw) as Partial<PersonalExportDefaults>
    const theme = isExportThemeId(value.defaultTheme) ? value.defaultTheme : fallback.defaultTheme
    const options = isRecord(value.options) ? value.options as ExportProfileOverrides : {}
    const candidate = mergeProfile(cloneProfile(BUILTIN_PROFILES[theme]), options, 'personal', {})
    const valid = validateExportProjectConfig({ schemaVersion: 1, defaultProfile: candidate.id, profiles: [candidate] })
    return {
      defaultTheme: theme,
      options: valid ? options : {},
      isSaved: true,
    }
  } catch {
    return fallback
  }
}

export function savePersonalExportDefaults(
  defaults: PersonalExportDefaults,
  storage: Pick<Storage, 'setItem'> | null = safeStorage(),
): void {
  if (!storage) return
  try {
    storage.setItem(PERSONAL_DEFAULTS_KEY, JSON.stringify(defaults))
  } catch {
    // Private browsing or a disabled WebView store must not block exporting.
  }
}

export function resolveExportProfile(input: {
  projectConfig?: ExportProjectConfig | null
  personalDefaults?: PersonalExportDefaults
  selectedProfileId?: string
  temporaryOverrides?: ExportProfileOverrides
}): ExportResolvedProfile {
  const personal = input.personalDefaults ?? loadPersonalExportDefaults()
  const config = input.projectConfig
  const selectedId = input.selectedProfileId ?? config?.defaultProfile
  const selectedProjectProfile = config?.profiles.find(profile => profile.id === selectedId)
  const projectTheme = selectedProjectProfile?.theme
  const selectedBuiltinTheme = !selectedProjectProfile && isExportThemeId(input.selectedProfileId) ? input.selectedProfileId : undefined
  const personalTheme = projectTheme || selectedBuiltinTheme ? undefined : personal.defaultTheme
  const base = cloneProfile(BUILTIN_PROFILES[projectTheme ?? selectedBuiltinTheme ?? personalTheme ?? 'simple-reading'] ?? BUILTIN_PROFILES['simple-reading'])
  const sources: Record<string, ExportConfigSource> = {}
  markLeafSources(base, 'builtin', '', sources)
  if (personalTheme && personal.isSaved) sources.theme = 'personal'

  let profile = mergeProfile(base, personal.options, 'personal', sources)
  if (selectedBuiltinTheme) {
    profile.theme = selectedBuiltinTheme
    sources.theme = 'builtin'
  }
  if (selectedProjectProfile) profile = mergeProfile(profile, omitIdentity(selectedProjectProfile), 'project', sources)
  if (input.temporaryOverrides) profile = mergeProfile(profile, input.temporaryOverrides, 'this-export', sources)

  profile.id = selectedProjectProfile?.id ?? base.id
  profile.name = selectedProjectProfile?.name ?? base.name
  profile.theme = isExportThemeId(profile.theme) ? profile.theme : 'simple-reading'
  return { profile, sources, profileId: selectedProjectProfile?.id }
}

export function validateExportProjectConfig(value: unknown): value is ExportProjectConfig {
  if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.defaultProfile !== 'string' || !Array.isArray(value.profiles)) return false
  if (!value.profiles.length || value.profiles.length > 32) return false
  const seen = new Set<string>()
  for (const candidate of value.profiles) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(candidate.id)) return false
    if (seen.has(candidate.id) || typeof candidate.name !== 'string' || candidate.name.length > 80) return false
    if (!isExportThemeId(candidate.theme) || !Array.isArray(candidate.formats) || candidate.formats.some(format => !ALL_FORMATS.includes(format as ExportFormat))) return false
    if (!isRecord(candidate.content) || candidate.content.mode !== 'current' || candidate.content.source !== 'buffer') return false
    if (!isRecord(candidate.output) || typeof candidate.output.directory !== 'string' || !candidate.output.directory.trim() || !isSafeProjectRelativePath(candidate.output.directory)) return false
    if (typeof candidate.output.fileName !== 'string' || !isSafeFileNameTemplate(candidate.output.fileName)) return false
    if (!isRecord(candidate.typography) || !['system-cjk', 'system-serif'].includes(String(candidate.typography.bodyFont))
      || !['system-monospace'].includes(String(candidate.typography.codeFont))
      || !isFiniteRange(candidate.typography.bodySizePt, 6, 48) || !isFiniteRange(candidate.typography.lineHeight, 1, 3)) return false
    if (!isRecord(candidate.page)) return false
    const page = candidate.page
    if (!['A4', 'A5', 'Letter', 'Legal'].includes(String(page.size))) return false
    if (!['portrait', 'landscape'].includes(String(page.orientation))) return false
    const margins = page.marginMm
    if (!isRecord(margins) || ['top', 'right', 'bottom', 'left'].some(edge => !isFiniteRange(margins[edge], 0, 80))) return false
    if (!isRecord(candidate.toc) || typeof candidate.toc.enabled !== 'boolean' || !isFiniteRange(candidate.toc.depth, 1, 6)) return false
    if (typeof candidate.numberHeadings !== 'boolean' || !isRecord(candidate.resources)) return false
    if (!['embed', 'folder'].includes(String(candidate.resources.htmlMode)) || typeof candidate.resources.downloadRemote !== 'boolean') return false
    if (!isRecord(candidate.html) || typeof candidate.html.showTitle !== 'boolean') return false
    if (!isRecord(candidate.pdf) || !['system-print', 'pandoc'].includes(String(candidate.pdf.backend))) return false
    if (!isRecord(candidate.docx) || typeof candidate.docx.stylePreset !== 'string') return false
    if (!isRecord(candidate.epub) || typeof candidate.epub.stylePreset !== 'string') return false
    seen.add(candidate.id)
  }
  return seen.has(value.defaultProfile)
}

export function isExportThemeId(value: unknown): value is ExportThemeId {
  return value === 'simple-reading' || value === 'technical' || value === 'formal-report'
}

export function formatsForProfile(profile: ExportProfile): ExportFormat[] {
  return ALL_FORMATS.filter(format => profile.formats.includes(format))
}

export function createProfileSourceMap(profile: ExportProfile, source: ExportConfigSource): Record<string, ExportConfigSource> {
  const sources: Record<string, ExportConfigSource> = {}
  markLeafSources(profile, source, '', sources)
  return sources
}

/** Preserve extension fields from a newer or third-party config while arrays replace as a unit. */
export function mergePreservingUnknown<T>(existing: T, update: T): T {
  if (Array.isArray(update)) return cloneProfileValue(update) as T
  if (!isRecord(existing) || !isRecord(update)) return cloneProfileValue(update)
  const merged: Record<string, unknown> = { ...existing }
  for (const [key, value] of Object.entries(update)) {
    const oldValue = existing[key]
    merged[key] = isRecord(oldValue) && isRecord(value)
      ? mergePreservingUnknown(oldValue, value)
      : cloneProfileValue(value)
  }
  return merged as T
}

function mergeProfile<T extends object>(base: T, layer: unknown, source: ExportConfigSource, sources: Record<string, ExportConfigSource>, prefix = ''): T {
  if (!isRecord(layer)) return base
  const result = { ...base } as Record<string, unknown>
  for (const [key, value] of Object.entries(layer)) {
    if (key === 'id' || key === 'name' || value === undefined) continue
    const path = prefix ? `${prefix}.${key}` : key
    if (Array.isArray(value)) {
      result[key] = value
      sources[path] = source
    } else if (isRecord(value) && isRecord(result[key])) {
      result[key] = mergeProfile(result[key] as object, value, source, sources, path)
    } else {
      result[key] = value
      sources[path] = source
    }
  }
  return result as T
}

function markLeafSources(value: unknown, source: ExportConfigSource, prefix: string, sources: Record<string, ExportConfigSource>): void {
  if (!isRecord(value)) {
    if (prefix) sources[prefix] = source
    return
  }
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (isRecord(child)) markLeafSources(child, source, path, sources)
    else sources[path] = source
  }
}

function omitIdentity(profile: ExportProfile): ExportProfileOverrides {
  const { id: _id, name: _name, ...options } = profile
  return options
}

function cloneProfile(profile: ExportProfile): ExportProfile {
  return JSON.parse(JSON.stringify(profile)) as ExportProfile
}

function cloneProfileValue<T>(value: T): T {
  if (value === undefined) return value
  return JSON.parse(JSON.stringify(value)) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function isSafeProjectRelativePath(value: string): boolean {
  if (!value) return true
  return !/^(?:[a-z]:|[\\/]{1,2})/i.test(value)
    && !value.includes(':')
    && value.split(/[\\/]+/).every(part => part !== '..')
}

function isSafeFileNameTemplate(value: string): boolean {
  return Boolean(value.trim())
    && !/[<>:"/\\|?*]/.test(value.replace(/\{(?:name|profile|date)\}/g, ''))
    && !hasControlCharacters(value)
    && !/\{(?!name\}|profile\}|date\})[^}]*\}/.test(value)
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => {
    const code = character.codePointAt(0) ?? 0
    return code < 32 || code === 127
  })
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
