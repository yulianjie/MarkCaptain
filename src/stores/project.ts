/**
 * Project store — a lazily loaded, watched workspace tree.
 *
 * Only a folder's direct children are read when it is opened. The root is
 * loaded once when the workspace opens; descendants are loaded on expansion
 * or, with bounded concurrency, while a filename filter is active.
 */

import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import {
  makeFile,
  makeFolder,
  makeRoot,
  sortFolder,
  sortTree,
  type TreeFolder,
  type TreeFile,
} from './treeCtrl'
import {
  listWorkspaceDirectory,
  watchFolder,
  unwatchFolder,
  createWorkspaceEntry,
  copyWorkspaceEntry,
  trashWorkspaceEntry,
  storageResolveProject,
  type WorkspaceEntryKind,
  type DirEntry,
} from '@/services/tauri-invoke'
import type { ProjectStorageMode, StorageConnection } from '@/services/cloud-storage'
import { listenTyped } from '@/services/tauri-bridge'
import { useNotificationStore } from './notification'
import { usePreferencesStore } from './preferences'
import { useEditorStore } from './editor'
import { useCloudStorageStore } from './cloudStorage'
import { t } from '@/i18n'

export interface ClipboardEntry {
  kind: 'copy' | 'cut'
  source: string
}

export interface ClosableProjectTab {
  id: string
  pathname: string
}

const MARKDOWN_EXT_RE = /\.(md|markdown|mkd|mdown|mkdn|mdtxt|mdtext)$/i
const FILTER_LOAD_CONCURRENCY = 4
const REFRESH_CONCURRENCY = 4

function normalizedPath(pathname: string, windowsStyle: boolean): string {
  const path = pathname.replace(/[\\/]+/g, '/').replace(/\/$/, '')
  return windowsStyle ? path.toLocaleLowerCase() : path
}

function parentDirOf(pathname: string): string {
  const normalized = pathname.replace(/[\\/]$/, '')
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return index >= 0 ? normalized.slice(0, index) : normalized
}

export function pathIsInsideRoot(rootPath: string, candidatePath: string): boolean {
  const windowsStyle = /^[a-z]:[\\/]/i.test(rootPath) || rootPath.startsWith('\\\\')
  const root = normalizedPath(rootPath, windowsStyle)
  const candidate = normalizedPath(candidatePath, windowsStyle)
  return candidate === root || candidate.startsWith(`${root}/`)
}

export function pathsReferToSameEntry(first: string, second: string): boolean {
  return pathIsInsideRoot(first, second) && pathIsInsideRoot(second, first)
}

/** Map an opened tab below a renamed/moved entry onto its new native path. */
export function remapPathWithinRoot(
  source: string,
  destination: string,
  candidate: string,
): string | null {
  if (!pathIsInsideRoot(source, candidate)) return null
  const normalize = (value: string) => value.replace(/[\\/]+/g, '/').replace(/\/$/, '')
  const sourceNormalized = normalize(source)
  const candidateNormalized = normalize(candidate)
  const suffix = candidateNormalized.slice(sourceNormalized.length).replace(/^\//, '')
  if (!suffix) return destination
  const separator = destination.includes('\\') ? '\\' : '/'
  return `${destination.replace(/[\\/]$/, '')}${separator}${suffix.replace(/\//g, separator)}`
}

export async function closeTabsBeforeDelete(
  tabs: readonly ClosableProjectTab[],
  target: string,
  isDirectory: boolean,
  closeTabs: (ids: readonly string[]) => Promise<boolean>,
): Promise<boolean> {
  const affected = tabs.filter(tab => tab.pathname && (
    isDirectory
      ? pathIsInsideRoot(target, tab.pathname)
      : pathsReferToSameEntry(target, tab.pathname)
  ))
  return affected.length === 0 || await closeTabs(affected.map(tab => tab.id))
}

/** Stack-safe compatibility helper used by tests and non-tree consumers. */
export function treeNodeMatchesFilter(
  node: TreeFolder | TreeFile,
  query: string,
): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return true
  const pending: Array<TreeFolder | TreeFile> = [node]
  while (pending.length) {
    const current = pending.pop()!
    if (current.name.toLocaleLowerCase().includes(needle)) return true
    if (current.isDirectory) pending.push(...current.folders, ...current.files)
  }
  return false
}

/**
 * Build the set of matching nodes and their ancestors in one stack-safe pass.
 * TreeRow can then avoid an O(nodes x depth) recursive search for every row.
 */
export function collectTreeFilterMatches(root: TreeFolder, query: string): Set<string> {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return new Set()

  const parents = new Map<string, string | null>()
  const pending: Array<{ node: TreeFolder | TreeFile; parent: string | null }> = [
    ...root.folders.map(node => ({ node, parent: null })),
    ...root.files.map(node => ({ node, parent: null })),
  ]
  const matches = new Set<string>()

  while (pending.length) {
    const { node, parent } = pending.pop()!
    parents.set(node.pathname, parent)
    if (node.name.toLocaleLowerCase().includes(needle)) {
      let pathname: string | null = node.pathname
      while (pathname && !matches.has(pathname)) {
        matches.add(pathname)
        pathname = parents.get(pathname) ?? null
      }
    }
    if (node.isDirectory) {
      for (const child of node.folders) pending.push({ node: child, parent: node.pathname })
      for (const file of node.files) pending.push({ node: file, parent: node.pathname })
    }
  }
  return matches
}

function basename(pathname: string): string {
  return pathname.split(/[\\/]/).filter(Boolean).pop() ?? pathname
}

function entryToTreeFile(entry: DirEntry): Omit<TreeFile, 'id'> {
  return {
    name: entry.name,
    pathname: entry.path,
    isFile: true,
    isDirectory: false,
    isMarkdown: entry.isMarkdown || MARKDOWN_EXT_RE.test(entry.name),
    birthTime: entry.createdMs ?? entry.modifiedMs,
    modifiedTime: entry.modifiedMs,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function collapseFolderTree(root: TreeFolder) {
  const pending = [...root.folders]
  while (pending.length) {
    const folder = pending.pop()!
    folder.isCollapsed = true
    pending.push(...folder.folders)
  }
}

function loadedFolderPaths(root: TreeFolder): string[] {
  const result: string[] = []
  const pending = [root]
  while (pending.length) {
    const folder = pending.pop()!
    if (folder.loaded) result.push(folder.pathname)
    pending.push(...folder.folders)
  }
  return result
}

function yieldToRenderer(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

export const useProjectStore = defineStore('project', () => {
  const notify = useNotificationStore()
  const prefs = usePreferencesStore()
  const editor = useEditorStore()
  const cloud = useCloudStorageStore()

  const projectTree = ref<TreeFolder | null>(null)
  const storageMode = ref<ProjectStorageMode>('local')
  const storageConnection = ref<StorageConnection | null>(null)
  const activeItem = ref<{ pathname: string; isDirectory: boolean } | null>(null)
  const createCache = ref<{ dirname: string; type: 'file' | 'directory' } | null>(null)
  const renameCache = ref<string | null>(null)
  const clipboard = ref<ClipboardEntry | null>(null)
  const filterLoading = ref(false)
  const filterError = ref<string | null>(null)
  const activeFilterQuery = ref('')

  const folderIndex = new Map<string, TreeFolder>()
  const pendingLoads = new Map<string, Promise<void>>()
  const queuedRefreshes = new Set<string>()
  let watcherInstalled = false
  let workspaceRevision = 0
  let filterRevision = 0

  function rootPathKey(pathname: string): string {
    const root = projectTree.value?.pathname ?? pathname
    const windowsStyle = /^[a-z]:[\\/]/i.test(root) || root.startsWith('\\\\')
    return normalizedPath(pathname, windowsStyle)
  }

  function requestKey(pathname: string, revision = workspaceRevision): string {
    return `${revision}:${rootPathKey(pathname)}`
  }

  function indexFolderTree(folder: TreeFolder) {
    const pending = [folder]
    while (pending.length) {
      const current = pending.pop()!
      folderIndex.set(rootPathKey(current.pathname), current)
      pending.push(...current.folders)
    }
  }

  function unindexFolderTree(folder: TreeFolder) {
    const pending = [folder]
    while (pending.length) {
      const current = pending.pop()!
      folderIndex.delete(rootPathKey(current.pathname))
      pending.push(...current.folders)
    }
  }

  function findFolder(pathname: string): TreeFolder | undefined {
    return folderIndex.get(rootPathKey(pathname))
  }

  function rebaseFolderTree(folder: TreeFolder, source: string, destination: string) {
    const pending = [folder]
    while (pending.length) {
      const current = pending.pop()!
      const mappedFolder = remapPathWithinRoot(source, destination, current.pathname)
      if (mappedFolder) current.pathname = mappedFolder
      current.name = basename(current.pathname)
      for (const file of current.files) {
        const mappedFile = remapPathWithinRoot(source, destination, file.pathname)
        if (mappedFile) file.pathname = mappedFile
        file.name = basename(file.pathname)
      }
      pending.push(...current.folders)
    }
  }

  /** Replace exactly one folder's children while reusing loaded descendants. */
  function syncDirectChildren(folder: TreeFolder, entries: DirEntry[]) {
    const existingFolders = new Map(folder.folders.map(child => [rootPathKey(child.pathname), child]))
    const existingFiles = new Map(folder.files.map(file => [rootPathKey(file.pathname), file]))
    const nextFolders: TreeFolder[] = []
    const nextFiles: TreeFile[] = []

    for (const entry of entries) {
      const key = rootPathKey(entry.path)
      if (entry.isDir) {
        const existing = existingFolders.get(key)
        const child = existing ?? makeFolder(entry.path)
        if (existing && existing.pathname !== entry.path) {
          unindexFolderTree(existing)
          rebaseFolderTree(existing, existing.pathname, entry.path)
        }
        child.pathname = entry.path
        child.name = entry.name
        nextFolders.push(child)
        indexFolderTree(child)
        existingFolders.delete(key)
      } else {
        const data = entryToTreeFile(entry)
        const existing = existingFiles.get(key)
        if (existing) {
          Object.assign(existing, data)
          nextFiles.push(existing)
          existingFiles.delete(key)
        } else {
          nextFiles.push(makeFile(data))
        }
      }
    }

    for (const removed of existingFolders.values()) unindexFolderTree(removed)
    folder.folders = nextFolders
    folder.files = nextFiles
    folder.loaded = true
    folder.loadError = null
    sortFolder(folder, prefs.fileSortBy)
  }

  /**
   * Read one folder. Simultaneous callers share the same request; watcher or
   * refresh requests received during it are coalesced into one later refresh.
   */
  function loadFolder(folder: TreeFolder, force = false): Promise<void> {
    const root = projectTree.value
    if (!root || !pathIsInsideRoot(root.pathname, folder.pathname)) return Promise.resolve()
    if (folder.loaded && !force) return Promise.resolve()

    const revision = workspaceRevision
    const key = requestKey(folder.pathname, revision)
    const pending = pendingLoads.get(key)
    if (pending) {
      if (force) queuedRefreshes.add(key)
      return pending
    }

    folder.loading = true
    folder.loadError = null
    const request = (async () => {
      try {
        const entries = await listWorkspaceDirectory(root.pathname, folder.pathname)
        if (workspaceRevision !== revision) return
        const target = pathsReferToSameEntry(root.pathname, folder.pathname)
          ? root
          : findFolder(folder.pathname)
        if (!target) return
        syncDirectChildren(target, entries)
      } catch (error) {
        if (workspaceRevision === revision) {
          folder.loadError = errorMessage(error)
        }
        throw error
      } finally {
        pendingLoads.delete(key)
        if (workspaceRevision === revision) {
          folder.loading = false
          if (queuedRefreshes.delete(key)
            && (pathsReferToSameEntry(root.pathname, folder.pathname) || findFolder(folder.pathname))) {
            void loadFolder(folder, true).catch(() => { /* surfaced on the row */ })
          }
        } else {
          queuedRefreshes.delete(key)
        }
      }
    })()
    pendingLoads.set(key, request)
    return request
  }

  function ensureFolderLoaded(folder: TreeFolder): Promise<void> {
    return loadFolder(folder, false)
  }

  async function toggleFolder(folder: TreeFolder) {
    setActiveItem({ pathname: folder.pathname, isDirectory: true })
    if (!folder.isCollapsed) {
      folder.isCollapsed = true
      return
    }
    folder.isCollapsed = false
    try {
      await ensureFolderLoaded(folder)
    } catch {
      // The row displays loadError and offers retry without collapsing again.
    }
  }

  async function retryFolder(folder: TreeFolder) {
    folder.isCollapsed = false
    try {
      await loadFolder(folder, folder.loaded)
    } catch {
      // Keep the error on the row; retry is intentionally non-destructive.
    }
  }

  function cancelFilterLoad() {
    filterRevision += 1
    activeFilterQuery.value = ''
    filterLoading.value = false
    filterError.value = null
  }

  /** Fully load the tree for a filename filter, with cancellation and bounded IPC. */
  async function loadTreeForFilter(query: string): Promise<boolean> {
    const needle = query.trim()
    const generation = ++filterRevision
    activeFilterQuery.value = needle
    filterError.value = null
    if (!needle) {
      filterLoading.value = false
      return true
    }

    const root = projectTree.value
    const revision = workspaceRevision
    if (!root) {
      filterLoading.value = false
      return false
    }
    filterLoading.value = true

    const queue: TreeFolder[] = [root]
    const visited = new Set<string>()
    const failures: string[] = []
    let cursor = 0
    let batches = 0

    while (cursor < queue.length) {
      if (generation !== filterRevision || revision !== workspaceRevision) {
        return false
      }
      const batch: TreeFolder[] = []
      while (batch.length < FILTER_LOAD_CONCURRENCY && cursor < queue.length) {
        const folder = queue[cursor++]
        const key = rootPathKey(folder.pathname)
        if (visited.has(key)) continue
        visited.add(key)
        batch.push(folder)
      }
      if (!batch.length) continue

      const results = await Promise.allSettled(batch.map(folder => ensureFolderLoaded(folder)))
      if (generation !== filterRevision || revision !== workspaceRevision) {
        return false
      }
      for (let index = 0; index < batch.length; index += 1) {
        const result = results[index]
        if (result.status === 'fulfilled') queue.push(...batch[index].folders)
        else failures.push(errorMessage(result.reason))
      }
      batches += 1
      if (batches % 8 === 0) await yieldToRenderer()
    }

    if (generation !== filterRevision || revision !== workspaceRevision) {
      return false
    }
    filterLoading.value = false
    filterError.value = failures.length
      ? `${failures.length} folder${failures.length === 1 ? '' : 's'} could not be loaded: ${failures[0]}`
      : null
    return failures.length === 0
  }

  async function openRoot(pathname: string) {
    if (projectTree.value?.pathname === pathname) return
    const previous = projectTree.value
    const revision = ++workspaceRevision
    cancelFilterLoad()
    folderIndex.clear()
    if (previous) {
      try { await unwatchFolder(previous.pathname) } catch { /* ignore */ }
    }
    if (revision !== workspaceRevision) return
    projectTree.value = null
    storageMode.value = 'local'
    storageConnection.value = null

    let watchedPath = pathname
    try {
      watchedPath = await watchFolder(pathname)
      if (revision !== workspaceRevision) {
        try { await unwatchFolder(watchedPath) } catch { /* ignore */ }
        return
      }
      const root = makeRoot(watchedPath)
      projectTree.value = root
      indexFolderTree(root)
      await loadFolder(root)
      if (revision !== workspaceRevision) return
      await refreshStorage(revision)
      if (revision !== workspaceRevision) return
      installWatcher()
      void prefs.pushRecentFolder(watchedPath)
    } catch (error) {
      try { await unwatchFolder(watchedPath) } catch { /* ignore */ }
      if (revision !== workspaceRevision) return
      notify.pushToast({
        type: 'error',
        title: t('tree.openFolderFailed'),
        message: errorMessage(error),
      })
      projectTree.value = null
      storageMode.value = 'local'
      storageConnection.value = null
      folderIndex.clear()
    }
  }

  async function refreshStorage(expectedRevision = workspaceRevision) {
    const root = projectTree.value
    if (!root) return
    try {
      const resolved = await storageResolveProject(root.pathname)
      if (expectedRevision !== workspaceRevision) return
      storageMode.value = resolved.mode
      storageConnection.value = resolved.connection
      if (resolved.connection) cloud.rememberConnection(resolved.connection)
    } catch {
      // Storage discovery must never prevent a local project from opening.
      if (expectedRevision !== workspaceRevision) return
      storageMode.value = 'local'
      storageConnection.value = null
    }
  }

  async function closeRoot() {
    const root = projectTree.value
    if (!root) return
    workspaceRevision += 1
    cancelFilterLoad()
    projectTree.value = null
    storageMode.value = 'local'
    storageConnection.value = null
    folderIndex.clear()
    try { await unwatchFolder(root.pathname) } catch { /* ignore */ }
    activeItem.value = null
    createCache.value = null
    renameCache.value = null
    clipboard.value = null
  }

  async function refreshLoadedDirectory(pathname: string, swallowFailure = false) {
    const folder = findFolder(pathname)
    if (!folder?.loaded) return
    try {
      await loadFolder(folder, true)
    } catch (error) {
      if (!swallowFailure) throw error
    }
  }

  async function refreshLoadedParents(paths: string[], swallowFailure = false) {
    const parents = [...new Set(paths.map(parentDirOf).map(rootPathKey))]
    const byKey = new Map<string, string>()
    for (const path of paths.map(parentDirOf)) byKey.set(rootPathKey(path), path)
    await Promise.all(parents.map(key => refreshLoadedDirectory(byKey.get(key)!, swallowFailure)))
  }

  function relocateCachedEntry(source: string, destination: string) {
    const sourceParent = findFolder(parentDirOf(source))
    const destinationParent = findFolder(parentDirOf(destination))
    if (!sourceParent?.loaded) return
    const key = rootPathKey(source)
    const folderIndexInParent = sourceParent.folders.findIndex(item => rootPathKey(item.pathname) === key)
    const fileIndexInParent = sourceParent.files.findIndex(item => rootPathKey(item.pathname) === key)

    if (folderIndexInParent >= 0) {
      const [folder] = sourceParent.folders.splice(folderIndexInParent, 1)
      unindexFolderTree(folder)
      rebaseFolderTree(folder, source, destination)
      if (destinationParent?.loaded) {
        destinationParent.folders.push(folder)
        indexFolderTree(folder)
        sortFolder(destinationParent, prefs.fileSortBy)
      }
    } else if (fileIndexInParent >= 0) {
      const [file] = sourceParent.files.splice(fileIndexInParent, 1)
      file.pathname = destination
      file.name = basename(destination)
      if (destinationParent?.loaded) {
        destinationParent.files.push(file)
        sortFolder(destinationParent, prefs.fileSortBy)
      }
    }
    sortFolder(sourceParent, prefs.fileSortBy)
  }

  function installWatcher() {
    if (watcherInstalled) return
    watcherInstalled = true
    void listenTyped('mt://fs/change', event => {
      const root = projectTree.value
      if (!root) return

      let refresh: Promise<void> | null = null
      if (event.kind === 'renamed') {
        const fromInside = pathIsInsideRoot(root.pathname, event.from)
        const toInside = pathIsInsideRoot(root.pathname, event.to)
        if (!fromInside && !toInside) return
        if (fromInside && toInside) relocateCachedEntry(event.from, event.to)
        const endpoints = [
          ...(fromInside ? [event.from] : []),
          ...(toInside ? [event.to] : []),
        ]
        refresh = refreshLoadedParents(endpoints, true)
      } else {
        if (!pathIsInsideRoot(root.pathname, event.path)) return
        // An unloaded parent intentionally receives no IPC. Its first expand
        // reads the latest state and therefore cannot become stale.
        refresh = refreshLoadedParents([event.path], true)
      }

      void refresh.finally(() => {
        if (activeFilterQuery.value) void loadTreeForFilter(activeFilterQuery.value)
      })
    })
  }

  function setActiveItem(item: { pathname: string; isDirectory: boolean } | null) {
    activeItem.value = item
  }

  function startCreate(dirname: string, type: 'file' | 'directory') {
    createCache.value = { dirname, type }
  }
  function cancelCreate() { createCache.value = null }

  function startRename(pathname: string) { renameCache.value = pathname }
  function cancelRename() { renameCache.value = null }

  function setClipboard(entry: ClipboardEntry | null) { clipboard.value = entry }

  /** Refresh the root and only descendants that were already loaded. */
  async function refreshTree() {
    const root = projectTree.value
    if (!root) return
    const revision = workspaceRevision
    const paths = loadedFolderPaths(root)
    const failures: unknown[] = []

    for (let offset = 0; offset < paths.length; offset += REFRESH_CONCURRENCY) {
      if (revision !== workspaceRevision) return
      const batch = paths.slice(offset, offset + REFRESH_CONCURRENCY)
      const results = await Promise.allSettled(batch.map(path => refreshLoadedDirectory(path)))
      for (const result of results) if (result.status === 'rejected') failures.push(result.reason)
      if (offset && offset % (REFRESH_CONCURRENCY * 8) === 0) await yieldToRenderer()
    }
    if (failures.length) throw failures[0]
  }

  async function refreshAfterMutation(paths: string[]) {
    try {
      await refreshLoadedParents(paths)
      if (activeFilterQuery.value) await loadTreeForFilter(activeFilterQuery.value)
    } catch (error) {
      notify.pushToast({
        type: 'error',
        title: t('tree.refreshFailed'),
        message: errorMessage(error),
      })
    }
  }

  function remapOpenTabs(source: string, destination: string) {
    for (const tab of editor.tabs) {
      const mapped = tab.pathname
        ? remapPathWithinRoot(source, destination, tab.pathname)
        : null
      if (!mapped) continue
      tab.pathname = mapped
      tab.filename = basename(mapped)
    }
    if (activeItem.value) {
      const mapped = remapPathWithinRoot(source, destination, activeItem.value.pathname)
      if (mapped) activeItem.value = { ...activeItem.value, pathname: mapped }
    }
    if (clipboard.value) {
      const mapped = remapPathWithinRoot(source, destination, clipboard.value.source)
      if (mapped) clipboard.value = { ...clipboard.value, source: mapped }
    }
  }

  function requireRoot(): TreeFolder {
    if (!projectTree.value) throw new Error(t('sideBar.openFolderFirst'))
    return projectTree.value
  }

  async function createEntry(parent: string, name: string, kind: WorkspaceEntryKind) {
    const root = requireRoot()
    const created = await createWorkspaceEntry(root.pathname, parent, name, kind)
    await refreshAfterMutation([created])
    return created
  }

  async function renameEntry(source: string, newName: string) {
    requireRoot()
    const destination = `${parentDirOf(source)}/${newName}`
    const { useNotebookStore } = await import('./notebook')
    await useNotebookStore().moveWithReferences(source, destination)
    remapOpenTabs(source, destination)
    relocateCachedEntry(source, destination)
    await refreshAfterMutation([source, destination])
    return destination
  }

  async function copyEntry(source: string, destinationDir: string) {
    const root = requireRoot()
    const destination = await copyWorkspaceEntry(root.pathname, source, destinationDir)
    await refreshAfterMutation([destination])
    return destination
  }

  async function moveEntry(source: string, destinationDir: string) {
    requireRoot()
    const destination = `${destinationDir}/${basename(source)}`
    const { useNotebookStore } = await import('./notebook')
    await useNotebookStore().moveWithReferences(source, destination)
    remapOpenTabs(source, destination)
    relocateCachedEntry(source, destination)
    await refreshAfterMutation([source, destination])
    return destination
  }

  async function pasteInto(destinationDir: string) {
    const entry = clipboard.value
    if (!entry) return null
    if (entry.kind === 'copy') return copyEntry(entry.source, destinationDir)
    const destination = await moveEntry(entry.source, destinationDir)
    clipboard.value = null
    return destination
  }

  async function trashEntry(path: string) {
    const root = requireRoot()
    await trashWorkspaceEntry(root.pathname, path)
    if (activeItem.value && pathIsInsideRoot(path, activeItem.value.pathname)) {
      activeItem.value = null
    }
    if (clipboard.value && pathIsInsideRoot(path, clipboard.value.source)) {
      clipboard.value = null
    }
    await refreshAfterMutation([path])
  }

  function collapseAll() {
    const root = projectTree.value
    if (root) collapseFolderTree(root)
  }

  watch(
    () => prefs.fileSortBy,
    mode => { if (projectTree.value) sortTree(projectTree.value, mode) },
  )

  return {
    projectTree,
    storageMode,
    storageConnection,
    activeItem,
    createCache,
    renameCache,
    clipboard,
    filterLoading,
    filterError,
    activeFilterQuery,
    openRoot,
    closeRoot,
    ensureFolderLoaded,
    toggleFolder,
    retryFolder,
    cancelFilterLoad,
    loadTreeForFilter,
    setActiveItem,
    startCreate,
    cancelCreate,
    startRename,
    cancelRename,
    setClipboard,
    refreshTree,
    refreshStorage,
    createEntry,
    renameEntry,
    copyEntry,
    moveEntry,
    pasteInto,
    trashEntry,
    collapseAll,
  }
})
