/**
 * Preferences store.
 *
 * Schema-backed preferences live at the top level of preferences.json. Image
 * uploader settings live in the `_userData` subtree. Writes are serialised so
 * rapid controls (sliders/text fields) cannot complete out of order.
 */

import { defineStore } from 'pinia'
import preferenceSchema from '@/common/preferences-schema.json'
import type { AppIconId } from '@/services/app-icon'
import type { TrailingNewlinePolicy } from '@/services/trailing-newline'
import {
  getPreferences,
  setPreference,
  setPreferences,
  pushRecentPath,
  getUserData,
  setUserData,
} from '@/services/tauri-invoke'

export type TabSize = 1 | 2 | 3 | 4
export type ListIndentation = 'dfm' | 1 | 2 | 3 | 4
export type AutoSwitchTheme = 1 | 2

interface PersistedPreferences {
  // General
  autoCheckUpdates: boolean
  autoSave: boolean
  autoSaveDelay: number
  titleBarStyle: 'custom' | 'native'
  rememberWindowSize: boolean
  appIcon: AppIconId
  openFilesInNewWindow: boolean
  openFolderInNewWindow: boolean
  zoom: number
  hideScrollbar: boolean
  wordWrapInToc: boolean
  fileSortBy: 'created' | 'modified' | 'title'
  startUpAction: 'folder' | 'lastState' | 'blank'
  defaultDirectoryToOpen: string
  language: string

  // Editor
  editorFontFamily: string
  fontSize: number
  lineHeight: number
  codeFontSize: number
  codeFontFamily: string
  codeBlockLineNumbers: boolean
  trimUnnecessaryCodeBlockEmptyLines: boolean
  editorLineWidth: string
  autoPairBracket: boolean
  autoPairMarkdownSyntax: boolean
  autoPairQuote: boolean
  endOfLine: 'default' | 'lf' | 'crlf'
  defaultEncoding: string
  autoGuessEncoding: boolean
  trimTrailingNewline: TrailingNewlinePolicy
  textDirection: 'ltr' | 'rtl'
  hideQuickInsertHint: boolean
  imageInsertAction: 'folder' | 'path' | 'upload'
  imagePreferRelativeDirectory: boolean
  imageRelativeDirectoryName: string
  hideLinkPopup: boolean
  autoCheck: boolean

  // Markdown
  preferLooseListItem: boolean
  bulletListMarker: '-' | '+' | '*'
  orderListDelimiter: '.' | ')'
  preferHeadingStyle: 'atx' | 'setext'
  tabSize: TabSize
  listIndentation: ListIndentation
  frontmatterType: '-' | '+' | ';' | '{'
  superSubScript: boolean
  footnote: boolean
  isHtmlEnabled: boolean
  isGitlabCompatibilityEnabled: boolean
  sequenceTheme: 'hand' | 'simple'

  // Theme
  theme: string
  autoSwitchTheme: AutoSwitchTheme

  // Spellcheck
  spellcheckerEnabled: boolean
  spellcheckerNoUnderline: boolean
  spellcheckerLanguage: string

  // View
  sideBarVisibility: boolean
  tabBarVisibility: boolean
  toolBarVisibility: boolean
  statusBarVisibility: boolean
  sourceCodeModeEnabled: boolean

  // Search / watcher
  searchExclusions: string[]
  searchMaxFileSize: string
  searchIncludeHidden: boolean
  searchNoIgnore: boolean
  searchFollowSymlinks: boolean
  watcherUsePolling: boolean
}

export interface PreferencesUserData {
  imageFolderPath: string
  webImages: unknown[]
  cloudImages: unknown[]
  currentUploader: 'none' | 'github' | 'picgo' | 'script'
  githubToken: string
  imageBed: { github: { owner: string; repo: string; branch: string } }
  cliScript: string
  picgoPath: string
}

type GithubImageBed = PreferencesUserData['imageBed']['github']
export type PreferencesUserDataPatch = Omit<Partial<PreferencesUserData>, 'imageBed'> & {
  imageBed?: { github?: Partial<GithubImageBed> }
}

interface State extends PersistedPreferences, PreferencesUserData {
  // Window-only modes (not persisted)
  typewriter: boolean
  focus: boolean
  sourceCode: boolean

  recentFiles: string[]
  recentFolders: string[]

  loaded: boolean
  loading: boolean
  saving: boolean
  lastError: string | null
  /** Monotonic counters used to reject snapshots overtaken by live events. */
  preferencesRevision: number
  userDataRevision: number
}

type SchemaRule = {
  type?: 'boolean' | 'number' | 'string' | 'array'
  default?: unknown
  enum?: unknown[]
  minimum?: number
  maximum?: number
  pattern?: string
  items?: { type?: string }
}

const schema = preferenceSchema as Record<string, SchemaRule>
const schemaKeys = new Set(Object.keys(schema))
const recentKeys = new Set(['recentFiles', 'recentFolders'])

/** Type-safe fallbacks for the one schema entry without a default and for
 * development while a schema migration is being applied. Schema defaults
 * always override these values below. */
const fallbackPreferences: PersistedPreferences = {
  autoCheckUpdates: true,
  autoSave: false,
  autoSaveDelay: 5000,
  titleBarStyle: 'custom',
  rememberWindowSize: false,
  appIcon: 'ios26',
  openFilesInNewWindow: false,
  openFolderInNewWindow: false,
  zoom: 1,
  hideScrollbar: false,
  wordWrapInToc: false,
  fileSortBy: 'modified',
  startUpAction: 'blank',
  defaultDirectoryToOpen: '',
  language: 'en',
  editorFontFamily: 'Open Sans',
  fontSize: 16,
  lineHeight: 1.6,
  codeFontSize: 14,
  codeFontFamily: 'DejaVu Sans Mono',
  codeBlockLineNumbers: true,
  trimUnnecessaryCodeBlockEmptyLines: true,
  editorLineWidth: '',
  autoPairBracket: true,
  autoPairMarkdownSyntax: true,
  autoPairQuote: true,
  endOfLine: 'default',
  defaultEncoding: 'utf8',
  autoGuessEncoding: true,
  trimTrailingNewline: 2,
  textDirection: 'ltr',
  hideQuickInsertHint: false,
  imageInsertAction: 'path',
  imagePreferRelativeDirectory: false,
  imageRelativeDirectoryName: 'assets',
  hideLinkPopup: false,
  autoCheck: false,
  preferLooseListItem: true,
  bulletListMarker: '-',
  orderListDelimiter: '.',
  preferHeadingStyle: 'atx',
  tabSize: 4,
  listIndentation: 1,
  frontmatterType: '-',
  superSubScript: false,
  footnote: false,
  isHtmlEnabled: true,
  isGitlabCompatibilityEnabled: false,
  sequenceTheme: 'hand',
  theme: 'light',
  autoSwitchTheme: 2,
  spellcheckerEnabled: false,
  spellcheckerNoUnderline: false,
  spellcheckerLanguage: 'en_US',
  sideBarVisibility: true,
  tabBarVisibility: true,
  toolBarVisibility: true,
  statusBarVisibility: true,
  sourceCodeModeEnabled: false,
  searchExclusions: [],
  searchMaxFileSize: '',
  searchIncludeHidden: false,
  searchNoIgnore: false,
  searchFollowSymlinks: true,
  watcherUsePolling: false,
}

const fallbackUserData: PreferencesUserData = {
  imageFolderPath: '',
  webImages: [],
  cloudImages: [],
  currentUploader: 'none',
  githubToken: '',
  imageBed: { github: { owner: '', repo: '', branch: '' } },
  cliScript: '',
  picgoPath: '',
}

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(item => cloneValue(item)) as T
  const copy: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) copy[key] = cloneValue(entry)
  return copy as T
}

function applyStatePatch(state: State, patch: object): void {
  Object.assign(state, patch)
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  try { return JSON.stringify(a) === JSON.stringify(b) } catch { return false }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isValidSchemaValue(key: string, value: unknown): boolean {
  // Muya's actual runtime contract is narrower than the legacy schema.
  if (key === 'tabSize') return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 4
  if (key === 'listIndentation') {
    return value === 'dfm' || (Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 4)
  }
  // Legacy mode 0 had the same behaviour as mode 2. It is migrated below.
  if (key === 'autoSwitchTheme' && value === 0) return true

  const rule = schema[key]
  if (!rule) return false
  if (rule.enum && !rule.enum.some(entry => Object.is(entry, value))) return false
  if (rule.type === 'boolean' && typeof value !== 'boolean') return false
  if (rule.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return false
  if (rule.type === 'string' && typeof value !== 'string') return false
  if (rule.type === 'array') {
    if (!Array.isArray(value)) return false
    if (rule.items?.type === 'string' && !value.every(item => typeof item === 'string')) return false
  }
  if (typeof value === 'number') {
    if (rule.minimum !== undefined && value < rule.minimum) return false
    if (rule.maximum !== undefined && value > rule.maximum) return false
  }
  if (typeof value === 'string' && rule.pattern && !new RegExp(rule.pattern).test(value)) return false
  return true
}

function normalisePreferenceValue(key: string, value: unknown): unknown {
  if (key === 'autoSwitchTheme' && value === 0) return 2
  return value
}

export function sanitizePreferences(patch: Record<string, unknown>): Partial<PersistedPreferences> & {
  recentFiles?: string[]
  recentFolders?: string[]
} {
  const safe: Record<string, unknown> = {}
  for (const [key, rawValue] of Object.entries(patch)) {
    if (recentKeys.has(key)) {
      if (Array.isArray(rawValue) && rawValue.every(item => typeof item === 'string')) {
        safe[key] = [...rawValue]
      }
      continue
    }
    if (!schemaKeys.has(key) || !isValidSchemaValue(key, rawValue)) continue
    safe[key] = cloneValue(normalisePreferenceValue(key, rawValue))
  }
  return safe as Partial<PersistedPreferences> & { recentFiles?: string[]; recentFolders?: string[] }
}

export function sanitizeUserData(patch: Record<string, unknown>): PreferencesUserDataPatch {
  const safe: PreferencesUserDataPatch = {}
  if (typeof patch.imageFolderPath === 'string') safe.imageFolderPath = patch.imageFolderPath
  if (Array.isArray(patch.webImages)) safe.webImages = cloneValue(patch.webImages)
  if (Array.isArray(patch.cloudImages)) safe.cloudImages = cloneValue(patch.cloudImages)
  if (typeof patch.githubToken === 'string') safe.githubToken = patch.githubToken
  if (typeof patch.cliScript === 'string') safe.cliScript = patch.cliScript
  if (typeof patch.picgoPath === 'string') safe.picgoPath = patch.picgoPath
  if (patch.currentUploader === 'github' || patch.currentUploader === 'picgo' || patch.currentUploader === 'script') {
    safe.currentUploader = patch.currentUploader
  } else if (patch.currentUploader === 'none' || patch.currentUploader === 's3') {
    // S3 has no execution backend. Old configurations must not leave the UI
    // selected on an uploader that silently falls back to a local path.
    safe.currentUploader = 'none'
  }
  if (patch.imageBed && typeof patch.imageBed === 'object') {
    const github = (patch.imageBed as { github?: unknown }).github
    if (github && typeof github === 'object') {
      const value = github as Record<string, unknown>
      const githubPatch: Partial<GithubImageBed> = {}
      if (typeof value.owner === 'string') githubPatch.owner = value.owner
      if (typeof value.repo === 'string') githubPatch.repo = value.repo
      if (typeof value.branch === 'string') githubPatch.branch = value.branch
      if (Object.keys(githubPatch).length) safe.imageBed = { github: githubPatch }
    }
  }
  return safe
}

function mergeImageBed(
  current: PreferencesUserData['imageBed'],
  patch: NonNullable<PreferencesUserDataPatch['imageBed']>,
): PreferencesUserData['imageBed'] {
  return {
    github: {
      ...current.github,
      ...(patch.github ?? {}),
    },
  }
}

function applyUserDataStatePatch(state: State, patch: PreferencesUserDataPatch): void {
  const scalarPatch = { ...patch }
  if (scalarPatch.imageBed) {
    state.imageBed = mergeImageBed(state.imageBed, scalarPatch.imageBed)
    delete scalarPatch.imageBed
  }
  applyStatePatch(state, scalarPatch)
}

function canonicalPreferences(): PersistedPreferences {
  const schemaDefaults: Record<string, unknown> = {}
  for (const [key, rule] of Object.entries(schema)) {
    if ('default' in rule && isValidSchemaValue(key, rule.default)) {
      schemaDefaults[key] = normalisePreferenceValue(key, rule.default)
    }
  }
  return {
    ...cloneValue(fallbackPreferences),
    ...sanitizePreferences(schemaDefaults),
  } as PersistedPreferences
}

/** Pure factory used by Pinia and unit tests. */
export function createDefaultPreferencesState(): State {
  return {
    ...canonicalPreferences(),
    ...cloneValue(fallbackUserData),
    typewriter: false,
    focus: false,
    sourceCode: false,
    recentFiles: [],
    recentFolders: [],
    loaded: false,
    loading: false,
    saving: false,
    lastError: null,
    preferencesRevision: 0,
    userDataRevision: 0,
  }
}

const writeQueues = new WeakMap<object, Promise<void>>()
const pendingWrites = new WeakMap<object, Map<string, number>>()
const confirmedValues = new WeakMap<object, Map<string, unknown>>()
const loadPromises = new WeakMap<object, Promise<boolean>>()

function pendingFor(owner: object): Map<string, number> {
  let pending = pendingWrites.get(owner)
  if (!pending) {
    pending = new Map()
    pendingWrites.set(owner, pending)
  }
  return pending
}

function confirmedFor(owner: object, state: State): Map<string, unknown> {
  let confirmed = confirmedValues.get(owner)
  if (!confirmed) {
    confirmed = new Map()
    for (const key of [...schemaKeys, ...recentKeys]) confirmed.set(key, cloneValue(state[key as keyof State]))
    for (const key of Object.keys(fallbackUserData)) confirmed.set(key, cloneValue(state[key as keyof State]))
    confirmedValues.set(owner, confirmed)
  }
  return confirmed
}

function markPending(owner: object, keys: string[], delta: 1 | -1): void {
  const pending = pendingFor(owner)
  for (const key of keys) {
    const next = (pending.get(key) ?? 0) + delta
    if (next > 0) pending.set(key, next)
    else pending.delete(key)
  }
}

function reconcileConfirmed(owner: object, state: State, keys: string[]): void {
  const pending = pendingFor(owner)
  const confirmed = confirmedFor(owner, state)
  for (const key of keys) {
    if (pending.has(key)) continue
    const value = confirmed.get(key)
    if (value !== undefined) applyStatePatch(state, { [key]: cloneValue(value) })
  }
}

function enqueueWrite(owner: object, operation: () => Promise<boolean>): Promise<boolean> {
  const previous = writeQueues.get(owner) ?? Promise.resolve()
  const result = previous.then(operation, operation)
  writeQueues.set(owner, result.then(() => undefined, () => undefined))
  return result
}

export const usePreferencesStore = defineStore('preferences', {
  state: (): State => createDefaultPreferencesState(),

  actions: {
    clearError() {
      this.lastError = null
    },

    applyRemotePreferences(patch: Record<string, unknown>) {
      this.preferencesRevision += 1
      const safe = sanitizePreferences(patch)
      const pending = pendingFor(this)
      const confirmed = confirmedFor(this, this.$state)
      for (const [key, value] of Object.entries(safe)) {
        confirmed.set(key, cloneValue(value))
        if (!pending.has(key)) applyStatePatch(this.$state, { [key]: cloneValue(value) })
      }
    },

    applyRemoteUserData(patch: Record<string, unknown>) {
      this.userDataRevision += 1
      const safe = sanitizeUserData(patch)
      const pending = pendingFor(this)
      const confirmed = confirmedFor(this, this.$state)
      for (const [key, value] of Object.entries(safe)) {
        if (key === 'imageBed') {
          const base = (confirmed.get(key) as PreferencesUserData['imageBed'] | undefined)
            ?? this.imageBed
          const merged = mergeImageBed(base, value as NonNullable<PreferencesUserDataPatch['imageBed']>)
          confirmed.set(key, cloneValue(merged))
          if (!pending.has(key)) this.imageBed = cloneValue(merged)
        } else {
          confirmed.set(key, cloneValue(value))
          if (!pending.has(key)) applyStatePatch(this.$state, { [key]: cloneValue(value) })
        }
      }
    },

    async load(): Promise<boolean> {
      const active = loadPromises.get(this)
      if (active) return active

      const run = (async () => {
        this.loading = true
        // A sibling window can write after the backend has read an old
        // snapshot but before its invoke response arrives. If an event bumps
        // the revision in that gap, read again instead of overwriting the
        // live patch with the stale snapshot.
        const stablePreferences = async () => {
          for (;;) {
            const revision = this.preferencesRevision
            const value = await getPreferences()
            if (revision !== this.preferencesRevision) continue
            // Apply immediately after the revision check. Waiting for the
            // independent user-data request here would reopen the stale gap.
            this.applyRemotePreferences(value)
            if (value.autoSwitchTheme === 0) void this.set('autoSwitchTheme', 2)
            return
          }
        }
        const stableUserData = async () => {
          for (;;) {
            const revision = this.userDataRevision
            const value = await getUserData()
            if (revision !== this.userDataRevision) continue
            this.applyRemoteUserData(value)
            if (value.currentUploader === 's3') {
              void this.patchUserData({ currentUploader: 'none' })
            }
            return
          }
        }
        const [prefsResult, userResult] = await Promise.allSettled([
          stablePreferences(),
          stableUserData(),
        ])
        let ok = true
        if (prefsResult.status === 'rejected') {
          ok = false
          this.lastError = `Unable to load preferences: ${errorMessage(prefsResult.reason)}`
        }
        if (userResult.status === 'rejected') {
          ok = false
          this.lastError = `Unable to load user data: ${errorMessage(userResult.reason)}`
        }
        this.loaded = true
        this.loading = false
        if (ok) this.lastError = null
        return ok
      })()

      loadPromises.set(this, run)
      try { return await run } finally { loadPromises.delete(this) }
    },

    async set<K extends keyof PersistedPreferences | 'recentFiles' | 'recentFolders'>(
      key: K,
      rawValue: State[K],
    ): Promise<boolean> {
      const safe = sanitizePreferences({ [key]: rawValue })
      if (!(key in safe)) {
        this.lastError = `Invalid value for preference “${String(key)}”.`
        return false
      }
      const value = safe[key as keyof typeof safe] as State[K]
      const keys = [String(key)]
      applyStatePatch(this.$state, { [key]: cloneValue(value) })
      markPending(this, keys, 1)
      this.saving = true

      return enqueueWrite(this, async () => {
        const revision = this.preferencesRevision
        try {
          await setPreference(String(key), value)
          // A newer cross-window event is authoritative. The event emitted by
          // this write will also populate confirmed state, so only use the
          // invoke result when no event arrived while it was in flight.
          if (revision === this.preferencesRevision) {
            confirmedFor(this, this.$state).set(String(key), cloneValue(value))
          }
          this.lastError = null
          return true
        } catch (error) {
          const confirmed = confirmedFor(this, this.$state).get(String(key))
          if (sameValue(this.$state[key], value) && confirmed !== undefined) {
            applyStatePatch(this.$state, { [key]: cloneValue(confirmed) })
          }
          this.lastError = `Unable to save “${String(key)}”: ${errorMessage(error)}`
          return false
        } finally {
          markPending(this, keys, -1)
          reconcileConfirmed(this, this.$state, keys)
          this.saving = pendingFor(this).size > 0
        }
      })
    },

    async patch(rawPatch: Partial<PersistedPreferences> & {
      recentFiles?: string[]
      recentFolders?: string[]
    }): Promise<boolean> {
      const safe = sanitizePreferences(rawPatch as Record<string, unknown>)
      const requestedKeys = Object.keys(rawPatch)
      if (Object.keys(safe).length !== requestedKeys.length) {
        this.lastError = 'One or more preference values are invalid.'
        return false
      }
      const keys = Object.keys(safe)
      applyStatePatch(this.$state, cloneValue(safe))
      markPending(this, keys, 1)
      this.saving = true

      return enqueueWrite(this, async () => {
        const revision = this.preferencesRevision
        try {
          await setPreferences(safe as Record<string, unknown>)
          if (revision === this.preferencesRevision) {
            const confirmed = confirmedFor(this, this.$state)
            for (const [key, value] of Object.entries(safe)) confirmed.set(key, cloneValue(value))
          }
          this.lastError = null
          return true
        } catch (error) {
          const confirmed = confirmedFor(this, this.$state)
          const rollback: Partial<State> = {}
          for (const [key, value] of Object.entries(safe)) {
            const oldValue = confirmed.get(key)
            if (sameValue(this.$state[key as keyof State], value) && oldValue !== undefined) {
              ;(rollback as Record<string, unknown>)[key] = cloneValue(oldValue)
            }
          }
          applyStatePatch(this.$state, rollback)
          this.lastError = `Unable to save preferences: ${errorMessage(error)}`
          return false
        } finally {
          markPending(this, keys, -1)
          reconcileConfirmed(this, this.$state, keys)
          this.saving = pendingFor(this).size > 0
        }
      })
    },

    async patchUserData(rawPatch: PreferencesUserDataPatch): Promise<boolean> {
      const safe = sanitizeUserData(rawPatch as Record<string, unknown>)
      const requestedKeys = Object.keys(rawPatch)
      if (Object.keys(safe).length !== requestedKeys.length) {
        this.lastError = 'One or more user-data values are invalid.'
        return false
      }
      const keys = Object.keys(safe)
      applyUserDataStatePatch(this.$state, cloneValue(safe))
      const optimistic = new Map(
        keys.map(key => [key, cloneValue(this.$state[key as keyof State])]),
      )
      markPending(this, keys, 1)
      this.saving = true

      return enqueueWrite(this, async () => {
        const revision = this.userDataRevision
        try {
          // The backend deep-merges user-data patches. Sending only the keys
          // changed by this operation avoids overwriting a sibling window's
          // newer uploader settings with a stale local snapshot.
          await setUserData(safe as Record<string, unknown>)
          if (revision === this.userDataRevision) {
            const confirmed = confirmedFor(this, this.$state)
            for (const key of keys) {
              if (key === 'imageBed') {
                const base = (confirmed.get(key) as PreferencesUserData['imageBed'] | undefined)
                  ?? fallbackUserData.imageBed
                confirmed.set(
                  key,
                  cloneValue(mergeImageBed(
                    base,
                    safe.imageBed as NonNullable<PreferencesUserDataPatch['imageBed']>,
                  )),
                )
              } else {
                confirmed.set(key, cloneValue(safe[key as keyof typeof safe]))
              }
            }
          }
          this.lastError = null
          return true
        } catch (error) {
          const confirmed = confirmedFor(this, this.$state)
          const rollback: Partial<State> = {}
          for (const key of keys) {
            const oldValue = confirmed.get(key)
            if (sameValue(this.$state[key as keyof State], optimistic.get(key)) && oldValue !== undefined) {
              ;(rollback as Record<string, unknown>)[key] = cloneValue(oldValue)
            }
          }
          applyStatePatch(this.$state, rollback)
          this.lastError = `Unable to save user data: ${errorMessage(error)}`
          return false
        } finally {
          markPending(this, keys, -1)
          reconcileConfirmed(this, this.$state, keys)
          this.saving = pendingFor(this).size > 0
        }
      })
    },

    toggleViewMode(entry: 'typewriter' | 'focus' | 'sourceCode') {
      this[entry] = !this[entry]
    },

    async pushRecentFile(path: string) {
      const revision = this.preferencesRevision
      try {
        const recent = await pushRecentPath('recentFiles', path)
        if (revision === this.preferencesRevision) {
          this.applyRemotePreferences({ recentFiles: recent })
        }
      } catch (error) {
        this.lastError = `Unable to update recent files: ${errorMessage(error)}`
      }
    },

    async pushRecentFolder(path: string) {
      const revision = this.preferencesRevision
      try {
        const recent = await pushRecentPath('recentFolders', path)
        if (revision === this.preferencesRevision) {
          this.applyRemotePreferences({ recentFolders: recent })
        }
      } catch (error) {
        this.lastError = `Unable to update recent folders: ${errorMessage(error)}`
      }
    },

    clearRecents() {
      void this.patch({ recentFiles: [], recentFolders: [] })
    },
  },
})

export type PreferencesState = State
