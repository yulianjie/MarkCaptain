import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUpdater, scheduleUpdateChecks, updaterReadiness, UPDATE_CHECK_INTERVAL, UPDATE_STARTUP_DELAY, type UpdatePackage } from '../../src/services/updater'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function setup() {
  const item: UpdatePackage = {
    version: '9.0.0', body: 'Release notes', close: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockImplementation(async progress => {
      progress({ event: 'Started', data: { contentLength: 100 } })
      progress({ event: 'Progress', data: { chunkLength: 100 } })
      progress({ event: 'Finished' })
    }),
    install: vi.fn().mockResolvedValue(undefined),
  }
  const deps = {
    check: vi.fn().mockResolvedValue(item), prepareInstall: vi.fn().mockResolvedValue(true),
    relaunch: vi.fn().mockResolvedValue(undefined),
  }
  const updater = createUpdater(deps, () => 'ready')
  return { updater, item, deps }
}

afterEach(() => vi.useRealTimers())

describe('signed updater workflow', () => {
  it('rejects disabled, missing-key and non-HTTPS configuration without a request', async () => {
    const good = { active: true, pubkey: 'key', endpoints: ['https://example.com/latest.json'] }
    expect(updaterReadiness(good)).toBe('ready')
    for (const config of [{ ...good, active: false }, { ...good, pubkey: '' }, { ...good, endpoints: [] },
      { ...good, endpoints: ['http://example.com'] }, { ...good, endpoints: ['https://'] }]) {
      const { deps } = setup()
      const updater = createUpdater(deps, () => updaterReadiness(config))
      await updater.check()
      expect(deps.check).not.toHaveBeenCalled()
      expect(updater.state.phase).not.toBe('uptodate')
    }
  })

  it('keeps background failures quiet, distinguishes them from up-to-date, and permits manual retry', async () => {
    const { updater, deps } = setup()
    deps.check.mockRejectedValueOnce(new Error('offline'))
    await updater.check(false)
    expect(updater.state).toMatchObject({ visible: false, phase: 'error', error: 'offline' })
    deps.check.mockResolvedValueOnce(null)
    await updater.check()
    expect(updater.state).toMatchObject({ visible: true, phase: 'uptodate', error: '' })
  })

  it('shows a background update with its version and notes', async () => {
    const { updater } = setup()
    await updater.check(false)
    expect(updater.state).toMatchObject({ visible: true, phase: 'available', version: '9.0.0', notes: 'Release notes' })
  })

  it('coalesces automatic and manual checks', async () => {
    const { updater, deps } = setup()
    const pending = deferred()
    deps.check.mockReturnValueOnce(pending.promise)
    const first = updater.check(false)
    await updater.check()
    expect(updater.state.visible).toBe(true)
    pending.resolve()
    await first
    expect(deps.check).toHaveBeenCalledTimes(1)
  })

  it('does not report ready when download Finished fires; waits for install to resolve', async () => {
    const { updater, item, deps } = setup()
    const pending = deferred()
    vi.mocked(item.install).mockReturnValue(pending.promise)
    await updater.check()
    const installing = updater.install()
    await vi.waitFor(() => expect(item.install).toHaveBeenCalled())
    expect(updater.state).toMatchObject({ phase: 'installing', total: 100, downloaded: 100 })
    expect(deps.prepareInstall).toHaveBeenCalledOnce()
    await updater.check()
    await updater.install()
    expect(item.install).toHaveBeenCalledOnce()
    pending.resolve()
    await installing
    expect(updater.state.phase).toBe('ready')
  })

  it('saves after the download and pauses installation when saving is cancelled', async () => {
    const { updater, item, deps } = setup()
    const pending = deferred()
    vi.mocked(item.download).mockReturnValue(pending.promise)
    deps.prepareInstall.mockResolvedValue(false)
    await updater.check()
    const installing = updater.install()
    expect(deps.prepareInstall).not.toHaveBeenCalled()
    pending.resolve()
    await installing
    expect(updater.state.phase).toBe('available')
    expect(item.install).not.toHaveBeenCalled()
  })

  it.each(['download', 'install'] as const)('reports a %s failure and never offers a premature restart', async operation => {
    const { updater, item } = setup()
    vi.mocked(item[operation]).mockRejectedValue(new Error('signature or install failure'))
    await updater.check()
    await updater.install()
    expect(updater.state).toMatchObject({ phase: 'error', error: 'signature or install failure' })
  })

  it('guards relaunch against new edits and allows retry after a restart failure', async () => {
    const { updater, deps } = setup()
    await updater.check()
    await updater.install()
    deps.prepareInstall.mockResolvedValueOnce(false)
    await updater.relaunch()
    expect(deps.relaunch).not.toHaveBeenCalled()
    deps.relaunch.mockRejectedValueOnce(new Error('restart failed'))
    await updater.relaunch()
    expect(updater.state).toMatchObject({ phase: 'ready', error: 'restart failed' })
    await updater.relaunch()
    expect(deps.relaunch).toHaveBeenCalledTimes(2)
  })

  it('releases replaced and unmounted native resources', async () => {
    const { updater, item } = setup()
    await updater.check()
    await updater.check()
    expect(item.close).toHaveBeenCalledOnce()
    await updater.dispose()
    expect(item.close).toHaveBeenCalledTimes(2)
  })

  it('does not install after unmount during a download', async () => {
    const { updater, item } = setup()
    const pending = deferred()
    vi.mocked(item.download).mockReturnValue(pending.promise)
    await updater.check()
    const installing = updater.install()
    await updater.dispose()
    pending.resolve()
    await installing
    expect(item.install).not.toHaveBeenCalled()
    expect(item.close).toHaveBeenCalledOnce()
  })

  it('closes a check result that arrives after unmount', async () => {
    const { updater, item } = setup()
    const checking = updater.check()
    await updater.dispose()
    await checking
    expect(item.close).toHaveBeenCalledOnce()
  })

  it('checks after startup and every four hours, and stops when disabled', async () => {
    vi.useFakeTimers()
    const check = vi.fn().mockResolvedValue(undefined)
    const stop = scheduleUpdateChecks(check)
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_DELAY - 1)
    expect(check).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(check).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL - UPDATE_STARTUP_DELAY)
    expect(check).toHaveBeenCalledTimes(2)
    stop()
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL * 2)
    expect(check).toHaveBeenCalledTimes(2)
  })
})
