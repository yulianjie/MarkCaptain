/**
 * Strongly-typed wrappers around `invoke()` for every Tauri command.
 *
 * One file = one source of truth: the command names mirror the function
 * signatures registered in `src-tauri/src/commands/mod.rs::all()`. Renaming a
 * command here breaks compilation if the Rust side doesn't match.
 *
 * Add a wrapper here BEFORE calling any command from a component.
 */

import { invoke } from '@tauri-apps/api/core'
import type { ExternalConnection, ExternalRequest } from './agent-external'
import type { HistoryRecord, HistoryMetadata } from './agent-history'
import type { AgentConfig, AgentHeader, AgentRequest, AgentSettings, AgentSkill, AgentSkillDetail } from './agent'
import type {
  GitSyncResult,
  ProjectStorageResolution,
  RemoteDirectory,
  StorageConnection,
  StorageConnectionInput,
  StoragePluginManifest,
  StorageProbeResult,
  StorageSyncResult,
  UploadedCloudFile,
} from './cloud-storage'

export const agentGetConfig = () => invoke<AgentConfig>('cmd_agent_get_config')
export const agentExternalGrant = () => invoke<ExternalConnection>('cmd_agent_external_grant')
export const agentExternalRevoke = (documentId: string) => invoke<void>('cmd_agent_external_revoke', { documentId })
export const agentExternalTake = (documentId: string) => invoke<ExternalRequest[]>('cmd_agent_external_take', { documentId })
export const agentExternalReply = (documentId: string, requestId: string, result: unknown) => invoke<void>('cmd_agent_external_reply', { documentId, requestId, result })
export const agentHistorySettings = () => invoke<{ enabled: boolean }>('cmd_agent_history_settings')
export const agentHistorySetEnabled = (enabled: boolean) => invoke<{ enabled: boolean }>('cmd_agent_history_set_enabled', { enabled })
export const agentHistoryList = () => invoke<HistoryMetadata[]>('cmd_agent_history_list')
export const agentHistoryRead = (id: string) => invoke<HistoryRecord>('cmd_agent_history_read', { id })
export const agentHistoryWrite = (record: HistoryRecord) => invoke<HistoryRecord>('cmd_agent_history_write', { record })
export const agentHistoryDelete = (id: string, revision: number) => invoke<void>('cmd_agent_history_delete', { id, revision })
export const agentSaveConfig = (settings: AgentSettings, apiKey?: string, headers?: AgentHeader[]) =>
  invoke<AgentConfig>('cmd_agent_save_config', { settings, apiKey, headers })
export const agentTestConnection = () => invoke<void>('cmd_agent_test_connection')
export const agentStart = (request: AgentRequest) => invoke<void>('cmd_agent_start', { request })
export const agentCancel = (requestId: string) => invoke<void>('cmd_agent_cancel', { requestId })
export const agentListSkills = () => invoke<AgentSkill[]>('cmd_agent_list_skills')
export const agentImportSkill = () => invoke<AgentSkill[] | null>('cmd_agent_import_skill')
export const agentSetSkillEnabled = (id: string, enabled: boolean) =>
  invoke<AgentSkill[]>('cmd_agent_set_skill_enabled', { id, enabled })
export const agentRemoveSkill = (id: string) => invoke<AgentSkill[]>('cmd_agent_remove_skill', { id })
export const agentReadSkill = (id: string) => invoke<AgentSkillDetail>('cmd_agent_read_skill', { id })

/* ─── cloud storage ─────────────────────────────────────────── */

export const storageListConnections = () => isTauriRuntime()
  ? invoke<StorageConnection[]>('cmd_storage_list_connections')
  : Promise.resolve([])

export const storageSaveConnection = (connection: StorageConnectionInput, secret?: string) =>
  invoke<StorageConnection>('cmd_storage_save_connection', { connection, secret })

export const storageDeleteConnection = (id: string) =>
  invoke<void>('cmd_storage_delete_connection', { id })

export const storageProbeConnection = (connection: StorageConnectionInput, secret?: string) =>
  invoke<StorageProbeResult>('cmd_storage_probe_connection', { connection, secret })

export const storageListPlugins = () => isTauriRuntime()
  ? invoke<StoragePluginManifest[]>('cmd_storage_list_plugins')
  : Promise.resolve([])

export const storageResolveProject = (root: string) =>
  invoke<ProjectStorageResolution>('cmd_storage_resolve_project', { root })

export const storageListRemoteDirectories = (id: string, path = '') =>
  invoke<RemoteDirectory[]>('cmd_storage_list_remote_directories', { id, path })

export const storageUploadFile = (id: string, localPath: string, remoteDirectory = '') =>
  invoke<UploadedCloudFile>('cmd_storage_upload_file', { id, localPath, remoteDirectory })

export const storageSync = (id: string) =>
  invoke<StorageSyncResult>('cmd_storage_sync', { id })

export const storageGitSync = (id: string) =>
  invoke<GitSyncResult>('cmd_storage_git_sync', { id })

export const storageGitPrepareMerge = (id: string) =>
  invoke<GitSyncResult>('cmd_storage_git_prepare_merge', { id })

export const storageGitConflictStage = (id: string, path: string, stage: 1 | 2 | 3) =>
  invoke<string>('cmd_storage_git_conflict_stage', { id, path, stage })

export const storageGitAbort = (id: string) =>
  invoke<void>('cmd_storage_git_abort', { id })
import {
  assertValidEditorSession,
  type EditorSession,
} from '@/services/editor-session'

export function popupEditorMenu(index: number, x: number, y: number): Promise<void> {
  return invoke('cmd_popup_editor_menu', { index, x, y })
}

export function enableWindowBackdrop(): Promise<boolean> {
  return invoke('cmd_window_enable_backdrop')
}

/* ─── shared types ───────────────────────────────────────────── */

export interface LoadedDocument {
  path: string
  markdown: string
  encoding: string
  lineEnding: string
  hadDecodeErrors: boolean
  bom: boolean
}

export interface SaveOptions {
  encoding?: string
  lineEnding?: string
  bom?: boolean
}

export interface ReadOptions {
  autoGuessEncoding?: boolean
  defaultEncoding?: string
}

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
  isMarkdown: boolean
  size: number
  modifiedMs: number
  createdMs?: number
}

export interface SearchArgs {
  root: string
  query: string
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
  includeHidden?: boolean
  followSymlinks?: boolean
  maxFileSize?: number
  exclusions?: string[]
  noIgnore?: boolean
}

export interface SearchHit {
  path: string
  /** One-based Unicode-scalar line/column returned by the Rust searcher. */
  line: number
  column: number
  /** Unicode-scalar match length and one-based exclusive end column. */
  length: number
  endColumn: number
  preview: string
}

/* ─── file ───────────────────────────────────────────────────── */

export const openFiles = () => invoke<string[]>('cmd_open_files')

export const readMarkdown = (path: string, options?: ReadOptions) =>
  invoke<LoadedDocument>('cmd_read_markdown', { path, options })

export const saveMarkdown = (path: string, markdown: string, options?: SaveOptions) =>
  invoke<void>('cmd_save_markdown', { path, markdown, options })

export const saveAsDialog = (defaultName?: string, defaultDir?: string) =>
  invoke<string | null>('cmd_save_as_dialog', { defaultName, defaultDir })

export const renameFile = (from: string, to: string) =>
  invoke<void>('cmd_rename_file', { from, to })

export const trashFile = (path: string) => invoke<void>('cmd_trash_file', { path })

/* ─── workspace ──────────────────────────────────────────────── */

export const openFolder = () => invoke<string | null>('cmd_open_folder')

export const listDirectory = (path: string) =>
  invoke<DirEntry[]>('cmd_list_directory', { path })

export const listWorkspaceDirectory = (root: string, path: string) =>
  invoke<DirEntry[]>('cmd_workspace_list_directory', { root, path })

export const watchFolder = (path: string) => invoke<string>('cmd_watch_folder', { path })

export const unwatchFolder = (path: string) =>
  invoke<void>('cmd_unwatch_folder', { path })

export type WorkspaceEntryKind = 'file' | 'directory'

export const createWorkspaceEntry = (
  root: string,
  parent: string,
  name: string,
  kind: WorkspaceEntryKind,
) => invoke<string>('cmd_workspace_create', { root, parent, name, kind })

export const renameWorkspaceEntry = (root: string, source: string, newName: string) =>
  invoke<string>('cmd_workspace_rename', { root, source, newName })

export const copyWorkspaceEntry = (
  root: string,
  source: string,
  destinationDir: string,
) => invoke<string>('cmd_workspace_copy', { root, source, destinationDir })

export const moveWorkspaceEntry = (
  root: string,
  source: string,
  destinationDir: string,
) => invoke<string>('cmd_workspace_move', { root, source, destinationDir })

export const trashWorkspaceEntry = (root: string, path: string) =>
  invoke<void>('cmd_workspace_trash', { root, path })

/* ─── window ─────────────────────────────────────────────────── */

export const newWindow = (label?: string) => invoke<void>('cmd_new_window', { label })

export const showWindow = () => isTauriRuntime()
  ? invoke<void>('cmd_show_window')
  : Promise.resolve()

export const closeWindow = (label: string) =>
  invoke<void>('cmd_close_window', { label })

export const destroyEditorWindow = () => isTauriRuntime()
  ? invoke<void>('cmd_destroy_editor_window')
  : Promise.resolve()

export const destroySettingsWindow = () => isTauriRuntime()
  ? invoke<void>('cmd_destroy_settings_window')
  : Promise.resolve()

export const setAlwaysOnTop = (label: string, onTop: boolean) =>
  invoke<void>('cmd_set_always_on_top', { label, onTop })

export const setMenuAcceleratorsEnabled = (enabled: boolean) => isTauriRuntime()
  ? invoke<void>('cmd_set_menu_accelerators_enabled', { enabled })
  : Promise.resolve()

const isTauriRuntime = () =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const browserPreferences: Record<string, unknown> = {}
let browserUserData: Record<string, unknown> = {}
let browserEditorSession: EditorSession | null = null

function deepMergeRecord(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged = structuredClone(current)
  for (const [key, value] of Object.entries(patch)) {
    const existing = merged[key]
    merged[key] = value && typeof value === 'object' && !Array.isArray(value)
      && existing && typeof existing === 'object' && !Array.isArray(existing)
      ? deepMergeRecord(existing as Record<string, unknown>, value as Record<string, unknown>)
      : structuredClone(value)
  }
  return merged
}

export const openSettings = () => {
  if (!isTauriRuntime()) {
    if (typeof window !== 'undefined') window.location.hash = '/preferences'
    return Promise.resolve()
  }
  return invoke<void>('cmd_open_settings')
}

/* ─── preferences ────────────────────────────────────────────── */

export const getPreferences = () => isTauriRuntime()
  ? invoke<Record<string, unknown>>('cmd_get_preferences')
  : Promise.resolve({ ...browserPreferences })

export const getPreference = <T = unknown>(key: string) => isTauriRuntime()
  ? invoke<T | null>('cmd_get_preference', { key })
  : Promise.resolve((browserPreferences[key] as T | undefined) ?? null)

export const setPreference = (key: string, value: unknown) => {
  if (!isTauriRuntime()) {
    browserPreferences[key] = structuredClone(value)
    return Promise.resolve()
  }
  return invoke<void>('cmd_set_preference', { key, value })
}

export const setPreferences = (patch: Record<string, unknown>) => {
  if (!isTauriRuntime()) {
    Object.assign(browserPreferences, structuredClone(patch))
    return Promise.resolve()
  }
  return invoke<void>('cmd_set_preferences', { patch })
}

export const pushRecentPath = (key: 'recentFiles' | 'recentFolders', path: string) => {
  if (!isTauriRuntime()) {
    const current = Array.isArray(browserPreferences[key])
      ? (browserPreferences[key] as string[]).filter(value => value !== path)
      : []
    const recent = [path, ...current].slice(0, 20)
    browserPreferences[key] = recent
    return Promise.resolve(recent)
  }
  return invoke<string[]>('cmd_push_recent', { key, path })
}

export const getUserData = () => isTauriRuntime()
  ? invoke<Record<string, unknown>>('cmd_get_user_data')
  : Promise.resolve(structuredClone(browserUserData))

export const setUserData = (patch: Record<string, unknown>) => {
  if (!isTauriRuntime()) {
    browserUserData = deepMergeRecord(browserUserData, patch)
    return Promise.resolve()
  }
  return invoke<void>('cmd_set_user_data', { patch })
}

/** Dedicated editor-session IPC deliberately bypasses user-data broadcasts. */
export const getEditorSession = () => {
  if (!isTauriRuntime()) {
    return Promise.resolve(browserEditorSession ? structuredClone(browserEditorSession) : null)
  }
  return invoke<EditorSession | null>('cmd_get_editor_session')
}

export const setEditorSession = (session: EditorSession) => {
  assertValidEditorSession(session)
  if (!isTauriRuntime()) {
    browserEditorSession = structuredClone(session)
    return Promise.resolve()
  }
  return invoke<void>('cmd_set_editor_session', { session })
}

export const clearEditorSession = () => {
  if (!isTauriRuntime()) {
    browserEditorSession = null
    return Promise.resolve()
  }
  return invoke<void>('cmd_clear_editor_session')
}

/* ─── export ─────────────────────────────────────────────────── */

export const exportHtml = (path: string, html: string) =>
  invoke<void>('cmd_export_html', { path, html })

export const exportPdf = (windowLabel: string) =>
  invoke<void>('cmd_export_pdf', { windowLabel })

export const pandocConvert = (markdown: string, outputPath: string, outputFormat: string) =>
  invoke<void>('cmd_pandoc_convert', { markdown, outputPath, outputFormat })

export interface PandocPdfOptions {
  paperSize?: string
  orientation?: 'portrait' | 'landscape'
  title?: string
  toc?: boolean
}

export const pandocPdfExport = (markdown: string, outputPath: string, options?: PandocPdfOptions) =>
  invoke<void>('cmd_pandoc_pdf_export', { markdown, outputPath, options })

/* ─── image ──────────────────────────────────────────────────── */

export interface LocalSaveArgs {
  sourcePath?: string
  dataUrl?: string
  targetDir: string
  filename: string
}

export const saveImageLocal = (args: LocalSaveArgs) =>
  invoke<{ path: string }>('cmd_save_image_local', { args })

export interface GithubUploadArgs {
  token: string
  owner: string
  repo: string
  branch?: string
  path: string
  contentBase64: string
  message?: string
}

export const uploadImageGithub = (args: GithubUploadArgs) =>
  invoke<{ downloadUrl: string; sha: string }>('cmd_upload_image_github', { args })

export interface PicgoUploadArgs {
  binary?: string
  sourcePaths: string[]
}
export const uploadImagePicgo = (args: PicgoUploadArgs) =>
  invoke<{ urls: string[] }>('cmd_upload_image_picgo', { args })

export interface ScriptUploadArgs {
  script: string
  sourcePaths: string[]
}
export const uploadImageScript = (args: ScriptUploadArgs) =>
  invoke<{ urls: string[] }>('cmd_upload_image_script', { args })

export interface UnsplashSearchArgs {
  query: string
  page?: number
  perPage?: number
  accessKey: string
}

export const searchUnsplash = (args: UnsplashSearchArgs) =>
  invoke<unknown>('cmd_search_unsplash', { args })

/* ─── search ─────────────────────────────────────────────────── */

export const searchInFolder = (args: SearchArgs) =>
  invoke<SearchHit[]>('cmd_search_in_folder', { args })

/* ─── spellcheck ─────────────────────────────────────────────── */

export const spellcheckWords = (words: string[]) =>
  invoke<string[]>('cmd_spellcheck_words', { words })

export const spellcheckSuggest = (word: string) =>
  invoke<string[]>('cmd_spellcheck_suggest', { word })

export const spellcheckAddWord = (word: string) =>
  invoke<void>('cmd_spellcheck_add_word', { word })

export const spellcheckRemoveWord = (word: string) =>
  invoke<void>('cmd_spellcheck_remove_word', { word })

export const spellcheckAvailableDictionaries = () =>
  isTauriRuntime()
    ? invoke<string[]>('cmd_spellcheck_available_dictionaries')
    : Promise.resolve([])

/* ─── menu state ─────────────────────────────────────────────── */

/**
 * Update the ✓ marks on the native Format submenu's inline items.
 *
 * Pass the flat list of "active" token names Muya reports at the current
 * selection — e.g. `['strong', 'em']` when the cursor is on **bold *italic***
 * text. Unknown names are ignored; an empty array clears every check.
 */
export const setFormatMenuState = (formats: string[]) =>
  invoke<void>('cmd_set_format_menu_state', { formats })

/* ─── theme ──────────────────────────────────────────────────── */

export interface UserTheme {
  id: string
  name: string
  path: string
}

export const listThemes = () => isTauriRuntime()
  ? invoke<UserTheme[]>('cmd_list_themes')
  : Promise.resolve([])

export const readThemeCss = (path: string) =>
  invoke<string>('cmd_read_theme_css', { path })
