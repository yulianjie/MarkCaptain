/** Apply persisted preferences to window-level DOM side effects. */
import { effectScope, shallowRef, watch, type EffectScope } from 'vue'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { usePreferencesStore } from '@/stores/preferences'
import { setLocale, type LocaleId } from '@/i18n'
import { listThemes, readThemeCss, setWindowTheme, type UserTheme } from './tauri-invoke'
import { applyWindowIcon } from './app-icon'

const BUILTIN_THEMES = new Set([
  'light',
  'dark',
  'github-blue',
  'graphite-light',
  'material-dark',
  'one-dark',
  'ulysses-light',
])
const USER_THEME_STYLE_ID = 'mt-user-theme-css'
const SPELL_STYLE_ID = 'mt-spell-underline-style'

let applierScope: EffectScope | null = null
let userThemesIndex: Map<string, UserTheme> | null = null
let themeRequest = 0
let nativeThemeWrites: Promise<void> = Promise.resolve()

/** The theme actually displayed (selected theme, or the current OS theme). */
export const effectiveThemeId = shallowRef('light')
export const effectiveThemeIsDark = shallowRef(false)

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function resolveEffectiveTheme(
  selectedTheme: string,
  autoSwitchMode: number,
  prefersDark = systemPrefersDark(),
): string {
  if (autoSwitchMode === 1) return prefersDark ? 'dark' : 'light'
  return selectedTheme || 'light'
}

async function ensureUserThemes(): Promise<Map<string, UserTheme>> {
  if (userThemesIndex) return userThemesIndex
  try {
    const list = await listThemes()
    userThemesIndex = new Map(list.map(theme => [theme.id, theme]))
  } catch {
    userThemesIndex = new Map()
  }
  return userThemesIndex
}

/** Re-fetch the user theme list from disk after files are added or removed. */
export function invalidateUserThemes(): void {
  userThemesIndex = null
}

function userThemeTag(): HTMLStyleElement | null {
  if (typeof document === 'undefined') return null
  return document.getElementById(USER_THEME_STYLE_ID) as HTMLStyleElement | null
}

async function applyUserTheme(themeId: string, request: number): Promise<boolean> {
  if (typeof document === 'undefined') return true
  const existing = userThemeTag()
  if (BUILTIN_THEMES.has(themeId)) {
    if (request === themeRequest && existing) existing.textContent = ''
    return true
  }

  const meta = (await ensureUserThemes()).get(themeId)
  if (!meta) {
    if (request === themeRequest && existing) existing.textContent = ''
    return false
  }

  try {
    const css = await readThemeCss(meta.path)
    if (request !== themeRequest) return true
    let tag = existing
    if (!tag) {
      tag = document.createElement('style')
      tag.id = USER_THEME_STYLE_ID
      document.head.appendChild(tag)
    }
    tag.textContent = css
    return true
  } catch {
    if (request === themeRequest && existing) existing.textContent = ''
    return false
  }
}

function setRootProp(name: string, value: string): void {
  if (typeof document !== 'undefined') document.documentElement.style.setProperty(name, value)
}

function setDocumentClass(name: string, on: boolean): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle(name, on)
  document.body?.classList.toggle(name, on)
}

function applyWindowZoom(zoom: number): void {
  setRootProp('--mt-zoom', String(zoom))
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    void getCurrentWebview().setZoom(zoom).catch(error => {
      console.warn('[preferences] failed to apply webview zoom', error)
    })
  } else if (typeof document !== 'undefined') {
    // Chromium's CSS zoom gives Vite/browser development the same whole-app
    // behaviour as Tauri's native webview scale factor.
    document.documentElement.style.zoom = String(zoom)
  }
}

function setDarkThemeClass(dark: boolean): void {
  effectiveThemeIsDark.value = dark
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark', dark)
  document.body?.classList.toggle('dark', dark)
}

function computedThemeIsDark(fallback: boolean): boolean {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return fallback
  // html/body can be transparent (notably with native Acrylic). Measure the
  // theme's actual surface instead, after its user CSS has been installed.
  const probe = document.createElement('span')
  probe.style.backgroundColor = 'var(--mt-bg)'
  probe.style.display = 'none'
  document.documentElement.appendChild(probe)
  const color = getComputedStyle(probe).backgroundColor
  probe.remove()
  const match = color.match(/rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/i)
  let channels: number[]
  if (match) {
    if ((color.startsWith('rgba(') && /,\s*0(?:\.0*)?\s*\)$/.test(color)) || /\/\s*0(?:\.0*)?\s*\)$/.test(color)) return fallback
    channels = match.slice(1).map(Number)
  } else {
    // Chromium can retain Color 4 forms such as color(srgb), oklch or
    // color-mix in computed styles. Canvas normalizes those to sRGB bytes.
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')
    if (!context) return fallback
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    const pixel = context.getImageData(0, 0, 1, 1).data
    if (!pixel[3]) return fallback
    channels = Array.from(pixel).slice(0, 3)
  }
  const [r, g, b] = channels
  // Relative luminance is unnecessary for a binary UI palette decision;
  // weighted sRGB brightness handles theme background colours reliably.
  return (r * 0.299 + g * 0.587 + b * 0.114) < 128
}

async function syncNativeTheme(dark: boolean, mode: number, request: number): Promise<void> {
  const nativeTheme = mode === 1 ? null : dark ? 'dark' : 'light'
  const write = nativeThemeWrites.then(async () => {
    if (request !== themeRequest) return
    try {
      await setWindowTheme(nativeTheme)
    } catch (error) {
      console.warn('[preferences] failed to apply native window theme', error)
    }
  })
  // Keep rapid theme changes ordered even if an earlier native IPC completes
  // later. A stale user-theme read is discarded before it reaches this queue.
  nativeThemeWrites = write
  await write
}

async function applyResolvedTheme(theme: string, mode: number): Promise<boolean> {
  effectiveThemeId.value = theme
  const builtInDark = /dark/i.test(theme)
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme
  }
  setDarkThemeClass(builtInDark)
  const request = ++themeRequest
  const applied = await applyUserTheme(theme, request)
  if (request === themeRequest) {
    const dark = BUILTIN_THEMES.has(theme) ? builtInDark : computedThemeIsDark(false)
    setDarkThemeClass(dark)
    // Bootstrap awaits this before showing a native window. Every later
    // local/cross-window preference event follows the same path.
    await syncNativeTheme(dark, mode, request)
  }
  return applied
}

/** Force the current user-theme CSS to be re-indexed and re-read. */
export async function refreshUserTheme(themeId?: string): Promise<boolean> {
  const prefs = usePreferencesStore()
  invalidateUserThemes()
  const theme = themeId ?? resolveEffectiveTheme(prefs.theme, prefs.autoSwitchTheme)
  return applyResolvedTheme(theme, prefs.autoSwitchTheme)
}

function ensureSpellStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(SPELL_STYLE_ID)) return
  const tag = document.createElement('style')
  tag.id = SPELL_STYLE_ID
  tag.textContent = 'html.mt-spell-no-underline *::spelling-error { text-decoration: none; }'
  document.head.appendChild(tag)
}

/**
 * Install preference side effects once per window. Repeated calls are safe;
 * `disposePreferencesApplier` is provided for tests and HMR teardown.
 */
export async function applyPreferencesToDom(): Promise<void> {
  if (applierScope?.active) return
  const prefs = usePreferencesStore()
  ensureSpellStyle()
  // User theme CSS is read from disk. Await it before the first Vue mount so
  // secondary/settings windows do not flash the default light palette.
  await applyResolvedTheme(resolveEffectiveTheme(prefs.theme, prefs.autoSwitchTheme), prefs.autoSwitchTheme)
  applierScope = effectScope()
  applierScope.run(() => {
    watch(
      () => [prefs.theme, prefs.autoSwitchTheme] as const,
      ([theme, mode]) => { void applyResolvedTheme(resolveEffectiveTheme(theme, mode), mode) },
      { immediate: true },
    )

    watch(
      () => prefs.autoSwitchTheme,
      (mode, _oldMode, onCleanup) => {
        if (mode !== 1 || typeof window === 'undefined' || !window.matchMedia) return
        const media = window.matchMedia('(prefers-color-scheme: dark)')
        const listener = () => {
          if (prefs.autoSwitchTheme === 1) void applyResolvedTheme(media.matches ? 'dark' : 'light', 1)
        }
        media.addEventListener('change', listener)
        onCleanup(() => media.removeEventListener('change', listener))
      },
      { immediate: true },
    )

    watch(
      () => prefs.language,
      language => {
        if (language === 'zh-CN' || language === 'en' || language === 'ja') {
          setLocale(language as LocaleId)
        }
      },
      { immediate: true },
    )
    watch(() => prefs.appIcon, icon => { void applyWindowIcon(icon) }, { immediate: true })
    watch(() => prefs.zoom, applyWindowZoom, { immediate: true })

    watch(
      () => [
        prefs.fontSize,
        prefs.lineHeight,
        prefs.editorFontFamily,
        prefs.codeFontFamily,
        prefs.codeFontSize,
        prefs.editorLineWidth,
        prefs.textDirection,
      ] as const,
      ([fontSize, lineHeight, editorFont, codeFont, codeFontSize, lineWidth, direction]) => {
        setRootProp('--mt-font-size', `${fontSize}px`)
        setRootProp('--mt-line-height', String(lineHeight))
        setRootProp('--mt-editor-font', editorFont)
        setRootProp('--mt-code-font', codeFont)
        setRootProp('--mt-code-font-size', `${codeFontSize}px`)
        setRootProp('--mt-editor-line-width', lineWidth || 'none')
        setRootProp('--mt-text-direction', direction)
        setRootProp('--mt-base-font-size', '14px')
      },
      { immediate: true },
    )

    watch(
      () => [
        prefs.hideScrollbar,
        prefs.typewriter,
        prefs.focus,
        prefs.sourceCode,
        prefs.textDirection,
        prefs.spellcheckerNoUnderline,
      ] as const,
      ([hideScrollbar, typewriter, focus, sourceCode, direction, noSpellUnderline]) => {
        setDocumentClass('mt-no-scrollbar', hideScrollbar)
        setDocumentClass('mt-typewriter', typewriter)
        setDocumentClass('mt-focus', focus)
        setDocumentClass('mt-source-mode', sourceCode)
        setDocumentClass('mt-rtl', direction === 'rtl')
        setDocumentClass('mt-spell-no-underline', noSpellUnderline)
      },
      { immediate: true },
    )
  })
}

export function disposePreferencesApplier(): void {
  themeRequest += 1
  applierScope?.stop()
  applierScope = null
}
