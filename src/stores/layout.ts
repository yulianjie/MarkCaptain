/**
 * Layout — editor chrome visibility and sidebar width.
 *
 * Persists `sideBarWidth` to localStorage (cheap and synchronous, same as the
 * legacy module). Visibility flags round-trip through the preferences store
 * so they survive across windows.
 */

import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { usePreferencesStore } from './preferences'

const SIDEBAR_DEFAULT = 220
export const SIDEBAR_MIN = 184
export const SIDEBAR_MAX = 800
const SIDEBAR_RAIL_WIDTH = 44
const INSPECTOR_RAIL_WIDTH = 44
const STORAGE_KEY = 'mt:sideBarWidth'
const NAVIGATION_PANEL_KEY = 'mt:navigationPanel'
const INSPECTOR_PANEL_KEY = 'mt:documentInspectorPanel'
const INSPECTOR_VISIBLE_KEY = 'mt:documentInspectorVisible'
const INSPECTOR_PINNED_KEY = 'mt:documentInspectorLinksPinned'
const INSPECTOR_WIDTH_KEY = 'mt:documentInspectorWidth'
const INSPECTOR_DEFAULT = 340
export const INSPECTOR_MIN = 260
export const INSPECTOR_MAX = 620

export type NavigationPanel = '' | 'files' | 'search'
export type InspectorPanel = 'outline' | 'links' | 'agent'

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return SIDEBAR_DEFAULT
    const n = Number(raw)
    if (!Number.isFinite(n)) return SIDEBAR_DEFAULT
    return Math.min(Math.max(n, SIDEBAR_MIN), SIDEBAR_MAX)
  } catch {
    return SIDEBAR_DEFAULT
  }
}

export type RightColumn = '' | 'files' | 'search' | 'toc' | 'notes'

function readStoredBoolean(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    if (raw === 'true') return true
    if (raw === 'false') return false
    return fallback
  } catch { return fallback }
}

function readStoredString<T extends string>(key: string, fallback: T, valid: (value: string) => value is T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw !== null && valid(raw) ? raw : fallback
  } catch { return fallback }
}

function readInspectorWidth(): number {
  try {
    const stored = localStorage.getItem(INSPECTOR_WIDTH_KEY)
    if (!stored) return INSPECTOR_DEFAULT
    const raw = Number(stored)
    return Number.isFinite(raw) ? Math.min(Math.max(raw, INSPECTOR_MIN), INSPECTOR_MAX) : INSPECTOR_DEFAULT
  } catch { return INSPECTOR_DEFAULT }
}

export const useLayoutStore = defineStore('layout', () => {
  const prefs = usePreferencesStore()

  const rightColumn = ref<RightColumn>('toc')
  const navigationPanel = ref<NavigationPanel>(readStoredString(
    NAVIGATION_PANEL_KEY,
    'files',
    (value): value is NavigationPanel => value === '' || value === 'files' || value === 'search',
  ))
  const inspectorPanel = ref<InspectorPanel>(readStoredString(
    INSPECTOR_PANEL_KEY,
    'outline',
    (value): value is InspectorPanel => value === 'outline' || value === 'links' || value === 'agent',
  ))
  const showInspector = ref(readStoredBoolean(INSPECTOR_VISIBLE_KEY, true))
  const linksPinned = ref(readStoredBoolean(INSPECTOR_PINNED_KEY, false))
  const inspectorWidth = ref(readInspectorWidth())
  // Keep visibility as a direct view of the preferences store.  A local copy
  // goes stale when another window changes the same preference.
  const showSideBar = computed({
    get: () => prefs.sideBarVisibility,
    set: value => { void prefs.set('sideBarVisibility', value) },
  })
  const showTabBar = computed({
    get: () => prefs.tabBarVisibility,
    set: value => { void prefs.set('tabBarVisibility', value) },
  })
  const showToolBar = computed({
    get: () => prefs.toolBarVisibility,
    set: value => { void prefs.set('toolBarVisibility', value) },
  })
  const showStatusBar = computed({
    get: () => prefs.statusBarVisibility,
    set: value => { void prefs.set('statusBarVisibility', value) },
  })
  const sideBarWidth = ref(readStoredWidth())

  watch(navigationPanel, value => { try { localStorage.setItem(NAVIGATION_PANEL_KEY, value) } catch { /* local preference unavailable */ } })
  watch(inspectorPanel, value => { try { localStorage.setItem(INSPECTOR_PANEL_KEY, value) } catch { /* local preference unavailable */ } })
  watch(showInspector, value => { try { localStorage.setItem(INSPECTOR_VISIBLE_KEY, String(value)) } catch { /* local preference unavailable */ } })
  watch(linksPinned, value => { try { localStorage.setItem(INSPECTOR_PINNED_KEY, String(value)) } catch { /* local preference unavailable */ } })
  // Old menu actions still set this field while EditorPage is being migrated
  // to the separate navigation and inspector surfaces.
  watch(rightColumn, value => {
    if (value === 'notes') { showInspector.value = true; inspectorPanel.value = 'links' }
    else if (value === 'toc') { showInspector.value = true; inspectorPanel.value = 'outline' }
    else if (value === 'files' || value === 'search') navigationPanel.value = value
  })

  /** Effective width includes the 44px activity rail. */
  const effectiveSideBarWidth = computed(() => {
    if (!showSideBar.value) return 0
    if (!navigationPanel.value) return SIDEBAR_RAIL_WIDTH
    return sideBarWidth.value + SIDEBAR_RAIL_WIDTH
  })
  const effectiveInspectorWidth = computed(() => showInspector.value ? inspectorWidth.value : INSPECTOR_RAIL_WIDTH)

  function setLayout(patch: Partial<{
    rightColumn: RightColumn
    showSideBar: boolean
    showTabBar: boolean
    showToolBar: boolean
    showStatusBar: boolean
  }>) {
    if (patch.rightColumn !== undefined) rightColumn.value = patch.rightColumn
    if (patch.showSideBar !== undefined) showSideBar.value = patch.showSideBar
    if (patch.showTabBar !== undefined) showTabBar.value = patch.showTabBar
    if (patch.showToolBar !== undefined) showToolBar.value = patch.showToolBar
    if (patch.showStatusBar !== undefined) showStatusBar.value = patch.showStatusBar
  }

  function toggleSideBar() { setLayout({ showSideBar: !showSideBar.value }) }
  function toggleTabBar() { setLayout({ showTabBar: !showTabBar.value }) }
  function toggleToolBar() { setLayout({ showToolBar: !showToolBar.value }) }
  function toggleStatusBar() { setLayout({ showStatusBar: !showStatusBar.value }) }

  function setSideBarWidth(width: number) {
    const clamped = Math.min(Math.max(width, SIDEBAR_MIN), SIDEBAR_MAX)
    sideBarWidth.value = clamped
    try { localStorage.setItem(STORAGE_KEY, String(clamped)) } catch { /* ignore */ }
  }

  function setNavigationPanel(panel: NavigationPanel) { navigationPanel.value = panel }
  function setInspectorPanel(panel: InspectorPanel) { inspectorPanel.value = panel }
  function setInspectorWidth(width: number) {
    const clamped = Math.min(Math.max(width, INSPECTOR_MIN), INSPECTOR_MAX)
    inspectorWidth.value = clamped
    try { localStorage.setItem(INSPECTOR_WIDTH_KEY, String(clamped)) } catch { /* local preference unavailable */ }
  }
  function toggleInspector() { showInspector.value = !showInspector.value }
  function setLinksPinned(value: boolean) { linksPinned.value = value }

  /** Retained for existing bootstrap call sites; computed refs stay in sync. */
  function syncFromPreferences() {}

  return {
    rightColumn,
    navigationPanel,
    inspectorPanel,
    showInspector,
    linksPinned,
    showSideBar,
    showTabBar,
    showToolBar,
    showStatusBar,
    sideBarWidth,
    inspectorWidth,
    effectiveSideBarWidth,
    effectiveInspectorWidth,
    setLayout,
    toggleSideBar,
    toggleTabBar,
    toggleToolBar,
    toggleStatusBar,
    setSideBarWidth,
    setNavigationPanel,
    setInspectorPanel,
    setInspectorWidth,
    toggleInspector,
    setLinksPinned,
    syncFromPreferences,
  }
})
