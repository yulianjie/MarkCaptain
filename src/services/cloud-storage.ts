export type StorageProviderKind = 'selfHosted' | 'git' | 'webdav' | 'plugin'

export type StorageCapability =
  | 'conditionalWrite'
  | 'incrementalChanges'
  | 'atomicMove'
  | 'versionHistory'
  | 'stableFileId'

export interface StorageConnection {
  id: string
  name: string
  kind: StorageProviderKind
  endpoint?: string
  username?: string
  workspaceId?: string
  localRoot: string
  repositoryPath?: string
  remote?: string
  branch?: string
  pluginId?: string
  pluginConfig?: string
  hasSecret: boolean
  capabilities: StorageCapability[]
}

export interface StorageConnectionInput {
  id?: string
  name: string
  kind: StorageProviderKind
  endpoint?: string
  username?: string
  workspaceId?: string
  localRoot: string
  repositoryPath?: string
  remote?: string
  branch?: string
  pluginId?: string
  pluginConfig?: string
}

export type ProjectStorageMode = 'local' | 'git' | 'cloud'

export interface ProjectStorageResolution {
  mode: ProjectStorageMode
  connection: StorageConnection | null
}

export interface RemoteDirectory {
  name: string
  path: string
}

export interface UploadedCloudFile {
  path: string
  version: string
}

export interface StoragePluginManifest {
  id: string
  name: string
  version: string
  protocolVersion: number
  capabilities: StorageCapability[]
}

export interface StorageProbeResult {
  ok: boolean
  message: string
  capabilities: StorageCapability[]
}

export type StorageSyncState =
  | 'synced'
  | 'pending'
  | 'syncing'
  | 'offline'
  | 'conflict'
  | 'error'

export interface StorageConflictSummary {
  path: string
  kind: 'content' | 'deleteEdit' | 'rename' | 'git'
}

export interface StorageSyncResult {
  state: StorageSyncState
  uploaded: number
  downloaded: number
  conflicts: StorageConflictSummary[]
  message?: string
}

export interface StorageStatusEvent extends StorageSyncResult {
  connectionId: string
  git?: GitSyncResult
}

export interface GitConflictFile {
  path: string
  stages: number[]
}

export interface GitSyncTarget {
  repositoryPath: string
  remote: string
  branch: string
}

export interface GitSyncResult {
  state: 'upToDate' | 'updated' | 'pushed' | 'diverged' | 'mergeReady' | 'conflicts' | 'localChanges'
  ahead: number
  behind: number
  conflicts: GitConflictFile[]
  changes?: { path: string; code: string }[]
  target?: GitSyncTarget
}
