import { setImmediate } from 'node:timers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'

const mocks = vi.hoisted(() => ({
  prefs: {} as Record<string, unknown>,
  native: vi.fn(),
  list: vi.fn(),
  css: vi.fn(),
}))
vi.mock('@/stores/preferences', () => ({ usePreferencesStore: () => mocks.prefs }))
vi.mock('@/services/tauri-invoke', () => ({
  setWindowTheme: mocks.native,
  listThemes: mocks.list,
  readThemeCss: mocks.css,
}))
vi.mock('@/services/app-icon', () => ({ applyWindowIcon: vi.fn() }))

import {
  applyPreferencesToDom,
  disposePreferencesApplier,
  effectiveThemeIsDark,
  refreshUserTheme,
} from '../../src/services/preferences-applier'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
async function settle() {
  await nextTick()
  await new Promise<void>(resolve => setImmediate(resolve))
}

describe('native window appearance follows resolved preferences', () => {
  let root: { dataset: Record<string, string>; style: { setProperty: ReturnType<typeof vi.fn> }; classList: { toggle: ReturnType<typeof vi.fn> }; appendChild: ReturnType<typeof vi.fn> }
  let media: { matches: boolean; addEventListener: ReturnType<typeof vi.fn>; removeEventListener: ReturnType<typeof vi.fn> }
  let background: string
  let pixel: Uint8ClampedArray

  beforeEach(() => {
    mocks.native.mockReset().mockResolvedValue(undefined)
    mocks.list.mockReset().mockResolvedValue([
      { id: 'sunrise', name: 'Sunrise', path: '/themes/sunrise.css' },
      { id: 'dark-in-name', name: 'Light custom theme', path: '/themes/dark-in-name.css' },
    ])
    mocks.css.mockReset().mockResolvedValue(':root { --mt-bg: #202421; }')
    mocks.prefs = reactive({ theme: 'light', autoSwitchTheme: 2, language: 'en', zoom: 1 })
    root = { dataset: {}, style: { setProperty: vi.fn() }, classList: { toggle: vi.fn() }, appendChild: vi.fn() }
    media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }
    background = 'rgb(32, 36, 33)'
    pixel = new Uint8ClampedArray([32, 36, 33, 255])
    vi.stubGlobal('window', { matchMedia: () => media })
    vi.stubGlobal('document', {
      documentElement: root,
      body: { classList: { toggle: vi.fn() } },
      head: { appendChild: vi.fn() },
      getElementById: () => null,
      createElement: (tag: string) => tag === 'canvas'
        ? { width: 0, height: 0, getContext: () => ({ fillStyle: '', fillRect: vi.fn(), getImageData: () => ({ data: pixel }) }) }
        : { style: {}, remove: vi.fn() },
    })
    vi.stubGlobal('getComputedStyle', () => ({ backgroundColor: background }))
  })
  afterEach(async () => {
    disposePreferencesApplier()
    await settle()
    vi.unstubAllGlobals()
  })

  it('waits for the initial title bar update before bootstrap can show the window', async () => {
    mocks.prefs.theme = 'dark'
    const pending = deferred<void>()
    mocks.native.mockReturnValueOnce(pending.promise)
    let finished = false
    const boot = applyPreferencesToDom().then(() => { finished = true })
    await settle()
    expect(root.dataset.theme).toBe('dark')
    expect(mocks.native).toHaveBeenCalledWith('dark')
    expect(finished).toBe(false)
    pending.resolve()
    await boot
    expect(finished).toBe(true)
  })

  it('clears the native override in system mode and continues responding to OS changes', async () => {
    mocks.prefs.theme = 'dark'
    mocks.prefs.autoSwitchTheme = 1
    await applyPreferencesToDom()
    await settle()
    expect(root.dataset.theme).toBe('light')
    expect(mocks.native).toHaveBeenLastCalledWith(null)
    const listener = media.addEventListener.mock.calls[0][1] as () => void
    media.matches = true
    listener()
    await settle()
    expect(root.dataset.theme).toBe('dark')
    expect(mocks.native).toHaveBeenLastCalledWith(null)
    Object.assign(mocks.prefs, { theme: 'light', autoSwitchTheme: 2 })
    await settle()
    expect(root.dataset.theme).toBe('light')
    expect(mocks.native).toHaveBeenLastCalledWith('light')
    listener()
    await settle()
    expect(root.dataset.theme).toBe('light')
    expect(media.removeEventListener).toHaveBeenCalledWith('change', listener)
  })

  it('applies incoming cross-window preferences and restores the theme when settings reopens', async () => {
    await applyPreferencesToDom()
    await settle()
    // The bridge applies a remote preference patch to this same reactive state.
    mocks.prefs.theme = 'one-dark'
    await settle()
    expect(root.dataset.theme).toBe('one-dark')
    expect(mocks.native).toHaveBeenLastCalledWith('dark')
    disposePreferencesApplier()
    mocks.native.mockClear()
    await applyPreferencesToDom()
    await settle()
    expect(mocks.native).toHaveBeenLastCalledWith('dark')
  })

  it('uses the user theme surface brightness rather than its name or transparent html', async () => {
    background = 'rgb(242, 240, 235)'
    await refreshUserTheme('dark-in-name')
    expect(effectiveThemeIsDark.value).toBe(false)
    expect(mocks.native).toHaveBeenLastCalledWith('light')
    expect(root.appendChild).toHaveBeenCalledWith(expect.objectContaining({ style: { backgroundColor: 'var(--mt-bg)', display: 'none' } }))
    background = 'rgb(32, 36, 33)'
    await refreshUserTheme('sunrise')
    expect(effectiveThemeIsDark.value).toBe(true)
    expect(mocks.native).toHaveBeenLastCalledWith('dark')
    background = 'color(srgb 0.12 0.14 0.13)'
    await refreshUserTheme('sunrise')
    expect(mocks.native).toHaveBeenLastCalledWith('dark')
  })

  it('does not apply an older user theme after a newer choice has finished', async () => {
    const css = deferred<string>()
    mocks.css.mockReturnValueOnce(css.promise)
    const old = refreshUserTheme('sunrise')
    await settle()
    await refreshUserTheme('light')
    css.resolve(':root { --mt-bg: #202421; }')
    await old
    expect(root.dataset.theme).toBe('light')
    expect(mocks.native.mock.calls.map(call => call[0])).toEqual(['light'])
  })

  it('serializes native updates so the newest request also finishes last', async () => {
    const first = deferred<void>()
    mocks.native.mockReturnValueOnce(first.promise)
    const dark = refreshUserTheme('dark')
    await settle()
    const light = refreshUserTheme('light')
    await settle()
    expect(mocks.native.mock.calls.map(call => call[0])).toEqual(['dark'])
    first.resolve()
    await Promise.all([dark, light])
    expect(mocks.native.mock.calls.map(call => call[0])).toEqual(['dark', 'light'])
  })
})
