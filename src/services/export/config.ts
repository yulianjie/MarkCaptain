import { exportLoadConfig, exportSaveConfig } from '@/services/tauri-invoke'
import { BUILTIN_PROFILES, mergePreservingUnknown, validateExportProjectConfig } from './profiles'
import type { ExportConfigSnapshot, ExportProfile, ExportProjectConfig } from './types'

export async function loadProjectExportConfig(root?: string): Promise<ExportConfigSnapshot> {
  if (!root) return { config: null, fingerprint: null }
  const result = await exportLoadConfig(root)
  if (result.config && !validateExportProjectConfig(result.config)) {
    throw new Error('This project export configuration is invalid or uses an unsupported schema version.')
  }
  return result
}

export async function saveProjectExportProfile(
  root: string,
  profile: ExportProfile,
  current: ExportConfigSnapshot,
  makeDefault = true,
): Promise<ExportConfigSnapshot> {
  const existing = current.config
  const config: ExportProjectConfig = existing
    ? {
        ...existing,
        profiles: existing.profiles.some(item => item.id === profile.id)
          ? existing.profiles.map(item => item.id === profile.id ? mergePreservingUnknown(item, profile) : item)
          : [...existing.profiles, clone(profile)],
        defaultProfile: makeDefault ? profile.id : existing.defaultProfile,
      }
    : {
        schemaVersion: 1,
        defaultProfile: profile.id,
        profiles: [clone(profile)],
      }

  if (!validateExportProjectConfig(config)) throw new Error('The export profile contains invalid values.')
  return exportSaveConfig(root, config, current.fingerprint)
}

export function createProfileFromTheme(theme: keyof typeof BUILTIN_PROFILES, id = theme): ExportProfile {
  const profile = clone(BUILTIN_PROFILES[theme])
  profile.id = id
  return profile
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
