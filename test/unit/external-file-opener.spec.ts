import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installExternalFileOpener } from '../../src/services/external-file-opener'

const ipc = vi.hoisted(() => ({ listen: vi.fn(), take: vi.fn(), unlisten: vi.fn() }))
vi.mock('../../src/services/tauri-bridge', () => ({ listenTyped: ipc.listen }))
vi.mock('../../src/services/tauri-invoke', () => ({ takePendingOpenFiles: ipc.take }))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('external file opens', () => {
  let notify: () => void
  let queue: string[]
  let controller: AbortController
  let openFile: ReturnType<typeof vi.fn>
  let onError: ReturnType<typeof vi.fn>
  const install = () => installExternalFileOpener({ openFile, onError, signal: controller.signal })

  beforeEach(() => {
    queue = []
    controller = new AbortController()
    openFile = vi.fn().mockResolvedValue(undefined)
    onError = vi.fn()
    ipc.take.mockReset().mockImplementation(async () => queue.splice(0))
    ipc.listen.mockReset().mockImplementation(async (_event, handler) => {
      notify = handler
      return ipc.unlisten
    })
    ipc.unlisten.mockReset()
  })

  it('opens cold-start requests even though their notification preceded subscription', async () => {
    queue.push('中文 file.md', 'second.md')
    await install()
    expect(openFile.mock.calls).toEqual([['中文 file.md'], ['second.md']])
    expect(ipc.listen.mock.invocationCallOrder[0]).toBeLessThan(ipc.take.mock.invocationCallOrder[0])
    expect(queue).toEqual([])
  })

  it('does not drain before the native listener has finished installing', async () => {
    const listening = deferred()
    ipc.listen.mockImplementationOnce(async (_event, handler) => {
      notify = handler
      await listening.promise
      return ipc.unlisten
    })
    const installed = install()
    queue.push('during-startup.md')
    expect(ipc.take).not.toHaveBeenCalled()
    listening.resolve()
    await installed
    expect(openFile).toHaveBeenCalledWith('during-startup.md')
  })

  it('serializes notifications during a slow open without duplicate reads or tabs', async () => {
    const reading = deferred()
    queue.push('first.md')
    openFile.mockReturnValueOnce(reading.promise)
    const installed = install()
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith('first.md'))
    queue.push('second.md')
    notify()
    notify()
    expect(openFile).toHaveBeenCalledTimes(1)
    reading.resolve()
    await installed
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledTimes(2))
    expect(openFile.mock.calls).toEqual([['first.md'], ['second.md']])
  })

  it('continues opening other files after an individual read fails', async () => {
    const error = new Error('file removed')
    queue.push('removed.md', 'good.md')
    openFile.mockRejectedValueOnce(error)
    await install()
    expect(onError).toHaveBeenCalledWith(error)
    expect(openFile).toHaveBeenLastCalledWith('good.md')
  })

  it('can retry a failed drain on a later notification', async () => {
    const error = new Error('IPC failed')
    ipc.take.mockRejectedValueOnce(error)
    queue.push('retained.md')
    await install()
    expect(onError).toHaveBeenCalledWith(error)
    notify()
    await vi.waitFor(() => expect(openFile).toHaveBeenCalledWith('retained.md'))
  })

  it('leaves requests queued after disposal', async () => {
    const dispose = await install()
    dispose()
    queue.push('next-window.md')
    notify()
    await Promise.resolve()
    expect(queue).toEqual(['next-window.md'])
    expect(openFile).not.toHaveBeenCalled()
    expect(ipc.unlisten).toHaveBeenCalledOnce()
  })

  it('unsubscribes and leaves requests queued if aborted during listener setup', async () => {
    const listening = deferred()
    ipc.listen.mockReturnValueOnce(listening.promise.then(() => ipc.unlisten))
    queue.push('cancelled-startup.md')
    const installed = install()
    controller.abort()
    listening.resolve()
    await installed
    expect(ipc.unlisten).toHaveBeenCalledOnce()
    expect(ipc.take).not.toHaveBeenCalled()
    expect(openFile).not.toHaveBeenCalled()
  })
})
