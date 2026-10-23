import { listenTyped } from './tauri-bridge'
import { takePendingOpenFiles } from './tauri-invoke'

/** Install after session hydration, so explicit opens retain the active tab. */
export async function installExternalFileOpener(options: {
  openFile: (path: string) => Promise<unknown>
  onError: (error: unknown) => void
  signal: AbortSignal
}): Promise<() => void> {
  let disposed = options.signal.aborted
  let pending = Promise.resolve()
  // Serialize drains and reads. A notification during a slow file read queues
  // another drain, instead of losing it or opening duplicate concurrent tabs.
  const drain = () => {
    pending = pending.then(async () => {
      if (disposed) return
      const paths = await takePendingOpenFiles()
      for (const path of paths) {
        if (disposed) return
        try { await options.openFile(path) }
        catch (error) { options.onError(error) }
      }
    }).catch(options.onError)
    return pending
  }
  const unlisten = await listenTyped('mt://window/open-file', () => { void drain() })
  const dispose = () => {
    disposed = true
    unlisten()
    options.signal.removeEventListener('abort', dispose)
  }
  options.signal.addEventListener('abort', dispose, { once: true })
  if (options.signal.aborted) dispose()
  // Requests predating the listener are still in Rust's per-window queue.
  await drain()
  return dispose
}
