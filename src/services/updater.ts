import { reactive } from 'vue'
import type { DownloadEvent } from '@tauri-apps/plugin-updater'

export interface UpdatePackage {
  version: string
  body?: string
  download: (progress: (event: DownloadEvent) => void) => Promise<void>
  install: () => Promise<void>
  close: () => Promise<void>
}

export interface UpdaterDependencies {
  check: () => Promise<UpdatePackage | null>
  prepareInstall: () => Promise<boolean>
  relaunch: () => Promise<void>
}

export function updaterReadiness(config: { active: boolean; pubkey: string; endpoints: string[] }) {
  if (!config.active) return 'disabled'
  return config.pubkey.trim() && config.endpoints.length
    && config.endpoints.every(endpoint => {
      try { return new URL(endpoint).protocol === 'https:' } catch { return false }
    }) ? 'ready' : 'unconfigured'
}

export type UpdatePhase = 'idle' | 'disabled' | 'unconfigured' | 'checking' | 'available'
  | 'downloading' | 'preparing' | 'installing' | 'ready' | 'uptodate' | 'error'

/** One in-flight operation per window; finishing a download does not mean installation succeeded. */
export function createUpdater(deps: UpdaterDependencies, readiness: () => string) {
  const state = reactive({
    visible: false, phase: 'idle' as UpdatePhase, version: '', notes: '', error: '',
    downloaded: 0, total: 0,
  })
  let update: UpdatePackage | null = null
  let running = false
  let disposed = false
  const release = async (item: UpdatePackage | null) => { await item?.close().catch(() => undefined) }
  const fail = (error: unknown) => {
    state.phase = 'error'
    state.error = error instanceof Error ? error.message : String(error)
  }

  async function check(manual = true) {
    if (disposed) return
    if (manual) state.visible = true
    if (running || state.phase === 'ready') return
    const status = readiness()
    if (status !== 'ready') {
      state.phase = status === 'disabled' ? 'disabled' : 'unconfigured'
      return
    }
    running = true
    state.phase = 'checking'
    state.error = ''
    state.version = ''
    state.notes = ''
    state.downloaded = state.total = 0
    const previous = update
    update = null
    try {
      await release(previous)
      const found = await deps.check()
      if (disposed) { await release(found); return }
      update = found
      state.phase = found ? 'available' : 'uptodate'
      if (found) {
        state.version = found.version
        state.notes = found.body ?? ''
        state.visible = true
      }
    } catch (error) { if (!disposed) fail(error) }
    finally { running = false }
  }

  async function install() {
    if (running || disposed || !update || state.phase !== 'available') return
    running = true
    const item = update
    try {
      state.downloaded = state.total = 0
      state.phase = 'downloading'
      await item.download(event => {
        if (event.event === 'Started') state.total = event.data.contentLength ?? 0
        if (event.event === 'Progress') state.downloaded += event.data.chunkLength
      })
      if (disposed) return
      // Windows installers exit the process. Save after downloading because
      // the document may change while the network request is pending.
      state.phase = 'preparing'
      if (!await deps.prepareInstall()) { state.phase = 'available'; return }
      if (disposed) return
      state.phase = 'installing'
      await item.install()
      if (!disposed) state.phase = 'ready'
    } catch (error) { if (!disposed) fail(error) }
    finally {
      running = false
      if (disposed) { update = null; await release(item) }
    }
  }

  async function relaunch() {
    if (running || disposed || state.phase !== 'ready') return
    running = true
    try {
      state.error = ''
      if (await deps.prepareInstall() && !disposed) await deps.relaunch()
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
    } finally {
      running = false
      if (disposed) { const item = update; update = null; await release(item) }
    }
  }

  async function dispose() {
    disposed = true
    if (!running) { const item = update; update = null; await release(item) }
  }
  return { state, check, install, relaunch, dispose }
}

export const UPDATE_CHECK_INTERVAL = 4 * 60 * 60 * 1000
export const UPDATE_STARTUP_DELAY = 10_000

export function scheduleUpdateChecks(check: () => Promise<void>) {
  const first = setTimeout(() => { void check() }, UPDATE_STARTUP_DELAY)
  const repeat = setInterval(() => { void check() }, UPDATE_CHECK_INTERVAL)
  return () => { clearTimeout(first); clearInterval(repeat) }
}
