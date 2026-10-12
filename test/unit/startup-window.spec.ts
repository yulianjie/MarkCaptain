import { setImmediate } from 'node:timers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const startup = vi.hoisted(() => ({
  hide: vi.fn(),
  listen: vi.fn(),
  backdrop: vi.fn(),
  install: vi.fn(),
  load: vi.fn(),
  apply: vi.fn(),
  mount: vi.fn(),
  nextTick: vi.fn(),
  show: vi.fn(),
}))

vi.mock('vue', () => ({
  createApp: () => ({
    config: { globalProperties: {} },
    use: vi.fn(),
    mount: startup.mount,
  }),
  nextTick: startup.nextTick,
}))
vi.mock('pinia', () => ({ createPinia: () => ({}) }))
vi.mock('element-plus', () => ({ default: {} }))
vi.mock('../../src/App.vue', () => ({ default: {} }))
vi.mock('../../src/router', () => ({ default: {} }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ hide: startup.hide }),
}))
vi.mock('../../src/services/tauri-invoke', () => ({
  enableWindowBackdrop: startup.backdrop,
  showWindow: startup.show,
}))
vi.mock('../../src/services/tauri-bridge', () => ({
  initTauriBridge: vi.fn(),
  listenTyped: startup.listen,
}))
vi.mock('../../src/services/debug-bridge', () => ({ installDebugBridge: vi.fn() }))
vi.mock('../../src/services/preferences-applier', () => ({ applyPreferencesToDom: startup.apply }))
vi.mock('../../src/stores/listenForMain', () => ({
  useListenForMainStore: () => ({ install: startup.install }),
}))
vi.mock('../../src/stores/preferences', () => ({
  usePreferencesStore: () => ({ load: startup.load }),
}))
vi.mock('../../src/i18n', () => ({ t: vi.fn() }))

async function boot() {
  await import('../../src/main')
  // Drain startup promises without supplying any animation-frame callback.
  await new Promise<void>(resolve => setImmediate(resolve))
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('native window startup', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(startup).forEach(mock => mock.mockReset())
    startup.hide.mockResolvedValue(undefined)
    startup.listen.mockResolvedValue(vi.fn())
    startup.backdrop.mockResolvedValue(false)
    startup.install.mockResolvedValue(undefined)
    startup.load.mockResolvedValue(true)
    startup.apply.mockResolvedValue(undefined)
    startup.nextTick.mockResolvedValue(undefined)
    startup.show.mockResolvedValue(undefined)
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {}, addEventListener: vi.fn() })
    vi.stubGlobal('document', { documentElement: { classList: { toggle: vi.fn(), add: vi.fn() } } })
    // Model a hidden WKWebView: frame requests never execute their callbacks.
    vi.stubGlobal('requestAnimationFrame', vi.fn())
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reveals a hidden window even when the webview never delivers a frame', async () => {
    await boot()

    expect(startup.hide).toHaveBeenCalledOnce()
    expect(startup.mount).toHaveBeenCalledWith('#app')
    expect(startup.nextTick).toHaveBeenCalledOnce()
    expect(startup.show).toHaveBeenCalledOnce()
    expect(requestAnimationFrame).not.toHaveBeenCalled()
    expect(startup.apply.mock.invocationCallOrder[0]).toBeLessThan(startup.mount.mock.invocationCallOrder[0])
    expect(startup.mount.mock.invocationCallOrder[0]).toBeLessThan(startup.nextTick.mock.invocationCallOrder[0])
    expect(startup.nextTick.mock.invocationCallOrder[0]).toBeLessThan(startup.show.mock.invocationCallOrder[0])
  })

  it('keeps the window hidden until its persisted appearance has loaded', async () => {
    const loading = deferred()
    startup.apply.mockReturnValueOnce(loading.promise)
    await boot()

    expect(startup.mount).not.toHaveBeenCalled()
    expect(startup.show).not.toHaveBeenCalled()
    loading.resolve()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(startup.show).toHaveBeenCalledOnce()
  })

  it('waits for Vue DOM updates before revealing the window', async () => {
    const flushing = deferred()
    startup.nextTick.mockReturnValueOnce(flushing.promise)
    await boot()

    expect(startup.mount).toHaveBeenCalledOnce()
    expect(startup.show).not.toHaveBeenCalled()
    flushing.resolve()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(startup.show).toHaveBeenCalledOnce()
  })

  it.each(['listen', 'load', 'apply'] as const)('still mounts and reveals after %s fails', async stage => {
    const error = new Error(`${stage} failed`)
    startup[stage].mockRejectedValueOnce(error)
    await boot()

    expect(console.error).toHaveBeenCalledWith('[bootstrap] failed to initialize application', error)
    expect(startup.mount).toHaveBeenCalledOnce()
    expect(startup.show).toHaveBeenCalledOnce()
  })

  it('reveals the window and logs a mount failure', async () => {
    const error = new Error('mount failed')
    startup.mount.mockImplementationOnce(() => { throw error })
    await boot()

    expect(console.error).toHaveBeenCalledWith('[bootstrap] failed to mount application', error)
    expect(startup.show).toHaveBeenCalledOnce()
  })

  it('logs a native show failure without an unhandled rejection', async () => {
    const error = new Error('show failed')
    startup.show.mockRejectedValueOnce(error)
    await boot()

    expect(console.error).toHaveBeenCalledWith('[window] failed to show window', error)
  })

  it('mounts in browser development without native window operations', async () => {
    vi.stubGlobal('window', {})
    await boot()

    expect(startup.mount).toHaveBeenCalledOnce()
    expect(startup.hide).not.toHaveBeenCalled()
    expect(startup.show).not.toHaveBeenCalled()
  })
})
