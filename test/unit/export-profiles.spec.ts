import { describe, expect, it } from 'vitest'
import { BUILTIN_PROFILES, mergePreservingUnknown, resolveExportProfile, validateExportProjectConfig } from '../../src/services/export/profiles'
import type { ExportProjectConfig } from '../../src/services/export/types'

const projectConfig: ExportProjectConfig = {
  schemaVersion: 1,
  defaultProfile: 'team-guide',
  profiles: [{
    ...structuredClone(BUILTIN_PROFILES.technical),
    id: 'team-guide',
    name: 'Team guide',
    theme: 'technical',
    page: { ...structuredClone(BUILTIN_PROFILES.technical.page), size: 'Letter' },
    formats: ['html', 'pdf'],
  }],
}

describe('export profile resolution', () => {
  it.each(['simple-reading', 'technical', 'formal-report'] as const)('selects the explicit built-in preset %s', id => {
    const result = resolveExportProfile({ selectedProfileId: id, personalDefaults: { defaultTheme: 'simple-reading', options: {} } })
    expect(result.profile).toEqual(BUILTIN_PROFILES[id])
    expect(result.profileId).toBeUndefined()
  })

  it('explicit built-ins override the personal theme and project default while retaining personal and temporary options', () => {
    const result = resolveExportProfile({
      projectConfig,
      selectedProfileId: 'formal-report',
      personalDefaults: { defaultTheme: 'technical', options: { theme: 'technical', page: { ...BUILTIN_PROFILES.technical.page, size: 'A5' } }, isSaved: true },
      temporaryOverrides: { toc: { enabled: false, depth: 2 } },
    })
    expect(result.profile.id).toBe('formal-report')
    expect(result.profile.theme).toBe('formal-report')
    expect(result.profile.page.size).toBe('A5')
    expect(result.profile.toc.enabled).toBe(false)
    expect(result.sources.theme).toBe('builtin')
  })

  it('applies built-in, personal, project and one-export values in priority order', () => {
    const result = resolveExportProfile({
      projectConfig,
      personalDefaults: {
        defaultTheme: 'formal-report',
        isSaved: true,
        options: { page: { size: 'A5', orientation: 'landscape' } },
      },
      temporaryOverrides: { page: { orientation: 'portrait' }, formats: ['html'] },
    })

    expect(result.profile.theme).toBe('technical')
    expect(result.profile.page.size).toBe('Letter')
    expect(result.profile.page.orientation).toBe('portrait')
    expect(result.profile.formats).toEqual(['html'])
    expect(result.sources.theme).toBe('project')
    expect(result.sources['page.size']).toBe('project')
    expect(result.sources['page.orientation']).toBe('this-export')
    expect(result.sources.formats).toBe('this-export')
  })

  it('uses the personal theme only when one was saved', () => {
    expect(resolveExportProfile({}).profile.theme).toBe('simple-reading')
    expect(resolveExportProfile({
      personalDefaults: { defaultTheme: 'formal-report', options: {}, isSaved: true },
    }).profile.theme).toBe('formal-report')
  })

  it('accepts built-in profiles and rejects unsafe or unknown project configuration', () => {
    expect(validateExportProjectConfig(projectConfig)).toBe(true)
    expect(validateExportProjectConfig({ ...projectConfig, schemaVersion: 2 })).toBe(false)
    expect(validateExportProjectConfig({
      ...projectConfig,
      profiles: [{ ...projectConfig.profiles[0], output: { directory: '../outside', fileName: '{name}' } }],
    })).toBe(false)
    expect(validateExportProjectConfig({
      ...projectConfig,
      profiles: [{ ...projectConfig.profiles[0], output: { directory: 'C:\\outside', fileName: '{name}' } }],
    })).toBe(false)
  })

  it('preserves future profile extensions while replacing arrays as a unit', () => {
    const existing = {
      ...structuredClone(BUILTIN_PROFILES.technical),
      extension: { vendor: { setting: true } },
      formats: ['html', 'docx'],
    }
    const update = {
      ...structuredClone(BUILTIN_PROFILES.technical),
      formats: ['pdf'],
    }
    const merged = mergePreservingUnknown(existing, update)

    expect(merged.extension).toEqual({ vendor: { setting: true } })
    expect(merged.formats).toEqual(['pdf'])
  })
})
