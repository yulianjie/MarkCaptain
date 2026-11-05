import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { t } from '@/i18n'
import type {
  GitSyncResult,
  GitSyncTarget,
  StorageConnection,
  StorageConnectionInput,
  StoragePluginManifest,
  StorageProbeResult,
  StorageSyncResult,
} from '@/services/cloud-storage'
import {
  storageDeleteConnection,
  storageGitAbort,
  storageGitPrepareMerge,
  storageGitSync,
  storageListConnections,
  storageListPlugins,
  storageProbeConnection,
  storageSaveConnection,
  storageSync,
} from '@/services/tauri-invoke'
import { listenTyped } from '@/services/tauri-bridge'

function message(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  if (!detail.startsWith('git:')) return detail
  const key = `prefs.cloud.gitError.${detail.slice(4)}`
  const localized = t(key)
  return localized === key ? detail : localized
}

export const useCloudStorageStore = defineStore('cloudStorage', () => {
  const connections = ref<StorageConnection[]>([])
  const plugins = ref<StoragePluginManifest[]>([])
  const loading = ref(false)
  const busyId = ref<string | null>(null)
  const lastError = ref<string | null>(null)
  const lastProbe = ref<StorageProbeResult | null>(null)
  const syncResults = ref<Record<string, StorageSyncResult | GitSyncResult>>({})
  const hasConnections = computed(() => connections.value.length > 0)
  let listenerInstalled = false

  function installStatusListener(): void {
    if (listenerInstalled) return
    listenerInstalled = true
    void listenTyped('mt://storage/status', event => {
      syncResults.value[event.connectionId] = event.git ?? {
        state: event.state,
        uploaded: event.uploaded,
        downloaded: event.downloaded,
        conflicts: event.conflicts,
        message: event.message,
      }
    })
  }

  async function load(): Promise<void> {
    installStatusListener()
    loading.value = true
    lastError.value = null
    try {
      const [saved, discovered] = await Promise.all([
        storageListConnections(),
        storageListPlugins(),
      ])
      connections.value = saved
      plugins.value = discovered
    } catch (error) {
      lastError.value = message(error)
    } finally {
      loading.value = false
    }
  }

  async function probe(input: StorageConnectionInput, secret?: string): Promise<boolean> {
    lastProbe.value = null
    lastError.value = null
    try {
      lastProbe.value = await storageProbeConnection(input, secret)
      return lastProbe.value.ok
    } catch (error) {
      lastError.value = message(error)
      return false
    }
  }

  async function save(input: StorageConnectionInput, secret?: string): Promise<boolean> {
    lastError.value = null
    try {
      const saved = await storageSaveConnection(input, secret)
      const index = connections.value.findIndex(item => item.id === saved.id)
      if (index >= 0) connections.value[index] = saved
      else connections.value.push(saved)
      return true
    } catch (error) {
      lastError.value = message(error)
      return false
    }
  }

  function rememberConnection(connection: StorageConnection): void {
    const index = connections.value.findIndex(item => item.id === connection.id)
    if (index >= 0) connections.value[index] = connection
    else connections.value.push(connection)
  }

  async function remove(id: string): Promise<boolean> {
    lastError.value = null
    busyId.value = id
    try {
      await storageDeleteConnection(id)
      connections.value = connections.value.filter(item => item.id !== id)
      delete syncResults.value[id]
      return true
    } catch (error) {
      lastError.value = message(error)
      return false
    } finally {
      busyId.value = null
    }
  }

  async function sync(connection: StorageConnection, commitPaths?: string[], commitTarget?: GitSyncTarget): Promise<boolean> {
    lastError.value = null
    busyId.value = connection.id
    try {
      syncResults.value[connection.id] = connection.kind === 'git'
        ? await storageGitSync(connection.id, commitPaths, commitTarget)
        : await storageSync(connection.id)
      return true
    } catch (error) {
      lastError.value = message(error)
      return false
    } finally {
      busyId.value = null
    }
  }

  async function abortGit(id: string): Promise<boolean> {
    lastError.value = null
    busyId.value = id
    try {
      await storageGitAbort(id)
      delete syncResults.value[id]
      return true
    } catch (error) {
      lastError.value = message(error)
      return false
    } finally {
      busyId.value = null
    }
  }

  async function prepareGitMerge(id: string): Promise<boolean> {
    lastError.value = null
    busyId.value = id
    try {
      syncResults.value[id] = await storageGitPrepareMerge(id)
      return true
    } catch (error) {
      lastError.value = message(error)
      return false
    } finally {
      busyId.value = null
    }
  }

  function clearFeedback(): void {
    lastError.value = null
    lastProbe.value = null
  }

  return {
    connections,
    plugins,
    loading,
    busyId,
    lastError,
    lastProbe,
    syncResults,
    hasConnections,
    load,
    probe,
    save,
    rememberConnection,
    remove,
    sync,
    prepareGitMerge,
    abortGit,
    clearFeedback,
  }
})
