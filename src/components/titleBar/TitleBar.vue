<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { platform } from '@tauri-apps/plugin-os'
import { Minus, FullScreen, CopyDocument, Close } from '@element-plus/icons-vue'
import { PanelLeftClose, PanelLeftOpen, Sparkles } from '@lucide/vue'
import { useAgentStore } from '@/stores/agent'
import { useLayoutStore } from '@/stores/layout'
import { getAppIconOption } from '@/services/app-icon'
import { popupEditorMenu } from '@/services/tauri-invoke'
import { usePreferencesStore } from '@/stores/preferences'
import { useNotificationStore } from '@/stores/notification'
import { useI18n } from '@/i18n'
import {
  displayAccelerator,
  eventAccel,
  getShortcutDefault,
  isShortcutAvailable,
  normaliseAccelerator,
  resolveShortcutAction,
  shortcutPlatformFromNavigator,
} from '@/common/shortcut-registry'

const { t } = useI18n()
const prefs = usePreferencesStore()
const layout = useLayoutStore()
const agent = useAgentStore()
const logo = computed(() => getAppIconOption(prefs.appIcon).src)
const notify = useNotificationStore()
const native = '__TAURI_INTERNALS__' in window
const nativeMac = native && platform() === 'macos'
const customChrome = !native || ['windows', 'linux'].includes(platform())
const appWindow = native ? getCurrentWindow() : null
const maximized = ref(false)
const menuButtons = ref<HTMLButtonElement[]>([])
const menuIndex = ref(0)
let unlisten: (() => void) | undefined
let disposed = false
const shortcutPlatform = shortcutPlatformFromNavigator(navigator.platform)
const titlebarMenuActions = [
  ['file', 'titlebar.fileMenu'],
  ['edit', 'titlebar.editMenu'],
  ['paragraph', 'titlebar.paragraphMenu'],
  ['format', 'titlebar.formatMenu'],
  ['view', 'titlebar.viewMenu'],
  ['theme', 'titlebar.themeMenu'],
  ['window', 'titlebar.windowMenu'],
  ['help', 'titlebar.helpMenu'],
] as const

function shortcutMnemonic(actionId: string): string {
  const key = normaliseAccelerator(getShortcutDefault(actionId) ?? '').split('+').at(-1) ?? ''
  return /^[a-z]$/.test(key) ? key : ''
}

const menus = computed(() => titlebarMenuActions.map(([key, actionId]) => {
  const accelerator = getShortcutDefault(actionId) ?? ''
  return {
    actionId,
    label: t('chrome.' + key),
    mnemonic: shortcutMnemonic(actionId),
    shortcut: accelerator ? displayAccelerator(accelerator, shortcutPlatform) : '',
  }
}))
const agentShortcut = computed(() => {
  const accelerator = getShortcutDefault('view.toggleAgent')
  return accelerator ? displayAccelerator(accelerator, shortcutPlatform) : ''
})
const agentToggleLabel = computed(() => agentShortcut.value
  ? `${t('agent.toggle')} (${agentShortcut.value})`
  : t('agent.toggle'))
async function run(action: () => Promise<unknown>) {
  try { await action() } catch (error) {
    notify.pushToast({ type: 'error', message: String(error) })
  }
}
async function openMenu(index: number) {
  if (!appWindow) {
    notify.pushToast({ type: 'info', message: t('chrome.nativeMenu') })
    return
  }
  const rect = menuButtons.value[index]?.getBoundingClientRect()
  if (rect) await run(() => popupEditorMenu(index, rect.left * prefs.zoom, rect.bottom * prefs.zoom))
}
function onMenuKey(event: KeyboardEvent, index: number) {
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault()
    const count = menus.value.length
    menuIndex.value = (index + (event.key === 'ArrowRight' ? 1 : count - 1)) % count
    menuButtons.value[menuIndex.value]?.focus()
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    void openMenu(index)
  }
}
function onAccessKey(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || !customChrome) return
  const action = resolveShortcutAction(eventAccel(event, shortcutPlatform), {
    scope: 'titlebar',
    dispatch: 'titlebar',
    platform: shortcutPlatform,
  })
  if (!action || !isShortcutAvailable(action, { customChrome })) return
  const index = menus.value.findIndex(menu => menu.actionId === action.id)
  if (index < 0) return
  event.preventDefault()
  if (event.repeat) return
  menuIndex.value = index
  menuButtons.value[index]?.focus()
  void openMenu(index)
}
onMounted(async () => {
  window.addEventListener('keydown', onAccessKey)
  if (!appWindow || !customChrome) return
  await run(async () => {
    maximized.value = await appWindow.isMaximized()
    const off = await appWindow.onResized(() => {
      void run(async () => { maximized.value = await appWindow.isMaximized() })
    })
    if (disposed) off()
    else unlisten = off
  })
})
onBeforeUnmount(() => {
  disposed = true
  unlisten?.()
  window.removeEventListener('keydown', onAccessKey)
})
</script>

<template>
  <header v-if="customChrome || nativeMac" class="title-bar" :class="{ 'mac-title-bar': nativeMac, 'is-maximized': maximized }" data-tauri-drag-region>
    <div class="brand" data-tauri-drag-region>
      <img :src="logo" alt="" draggable="false" data-tauri-drag-region>
      <strong data-tauri-drag-region>MarkCaptain</strong>
    </div>
    <nav v-if="customChrome" class="app-menu" role="menubar" :aria-label="t('chrome.menu')">
      <button v-for="(menu, index) in menus" :key="menu.actionId" ref="menuButtons"
        type="button" role="menuitem" aria-haspopup="menu" :tabindex="menuIndex === index ? 0 : -1"
        :aria-keyshortcuts="menu.shortcut"
        :data-shortcut-action="menu.actionId"
        @mousedown.prevent @click="openMenu(index)" @keydown="onMenuKey($event, index)">
        {{ menu.label }}<span class="mnemonic">({{ menu.mnemonic.toUpperCase() }})</span>
      </button>
    </nav>
    <button type="button" class="sidebar-toggle"
      :aria-label="t(layout.showSideBar ? 'chrome.hideSidebar' : 'chrome.showSidebar')"
      :title="t(layout.showSideBar ? 'chrome.hideSidebar' : 'chrome.showSidebar')"
      :aria-expanded="layout.showSideBar" aria-controls="editor-sidebar"
      @click="layout.toggleSideBar()">
      <component :is="layout.showSideBar ? PanelLeftClose : PanelLeftOpen" :size="16" :stroke-width="1.6" aria-hidden="true" />
    </button>
    <div class="drag-space" data-tauri-drag-region />
    <button type="button" class="agent-toggle" :aria-label="agentToggleLabel" :title="agentToggleLabel" :aria-keyshortcuts="agentShortcut" :aria-expanded="agent.visible" aria-controls="agent-panel" @mousedown.prevent @click="agent.toggle()"><Sparkles :size="15" /><span>{{ t('agent.toggle') }}</span><i v-if="agent.busy" /></button>
    <div v-if="customChrome" class="window-controls">
      <button type="button" :aria-label="t('chrome.minimize')" :title="t('chrome.minimize')"
        :disabled="!appWindow" @click="run(() => appWindow!.minimize())">
<Minus />
</button>
      <button type="button" :aria-label="t(maximized ? 'chrome.restore' : 'chrome.maximize')"
        :title="t(maximized ? 'chrome.restore' : 'chrome.maximize')" :disabled="!appWindow"
        @click="run(() => appWindow!.toggleMaximize())">
<component :is="maximized ? CopyDocument : FullScreen" />
</button>
      <button type="button" class="window-close" :aria-label="t('common.close')" :title="t('common.close')"
        :disabled="!appWindow" @click="run(() => appWindow!.close())">
<Close />
</button>
    </div>
  </header>
</template>

<style scoped>
.title-bar { box-sizing: border-box; display: flex; align-items: center; height: 36px; flex: 0 0 36px; user-select: none; background: var(--mt-tab-bg); backdrop-filter: var(--mt-glass-filter); border-bottom: 1px solid var(--mt-glass-border); }
.mac-title-bar { padding-left: 80px; }
.brand { display: flex; align-items: center; gap: 7px; padding: 0 12px; color: var(--mt-fg); font-size: 13px; white-space: nowrap; }
.brand strong { font-weight: 600; }
.brand img { width: 21px; height: 21px; object-fit: contain; }
.app-menu { display: flex; align-items: center; }
.app-menu button { color: var(--mt-fg-muted); background: transparent; border: 0; border-radius: var(--mt-radius-control); padding: 4px 8px; font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer; }
.mnemonic { display: none; }
.app-menu button:hover, .app-menu button:focus-visible { background: var(--mt-row-hover); color: var(--mt-fg); }
button:focus-visible { outline: 2px solid var(--mt-accent); outline-offset: -2px; }
.drag-space { flex: 1; align-self: stretch; min-width: 24px; }
.sidebar-toggle { display: grid; place-items: center; flex: 0 0 28px; height: 28px; margin-inline: 6px; padding: 0; border: 1px solid transparent; border-radius: var(--mt-radius-control); background: transparent; color: var(--mt-icon-fg); cursor: pointer; }
.sidebar-toggle:hover { background: var(--mt-icon-hover-bg); color: var(--mt-fg); }
.sidebar-toggle[aria-expanded="true"] { color: var(--mt-accent); background: var(--mt-icon-active-bg); }
.window-controls { display: flex; height: 100%; }
.agent-toggle { display: flex; align-items: center; gap: 5px; height: 26px; margin-right: 10px; padding: 0 8px; font: inherit; font-size: 11px; white-space: nowrap; color: var(--mt-fg-muted); background: transparent; border: 1px solid var(--mt-border); border-radius: 6px; cursor: pointer; }
.agent-toggle:hover, .agent-toggle[aria-expanded="true"] { color: var(--mt-accent); background: var(--mt-icon-active-bg); }
.agent-toggle i { height: 5px; width: 5px; border-radius: 50%; background: var(--mt-accent); }
@media (max-width: 740px) { .agent-toggle span { display: none; } }
.window-controls button { display: grid; place-items: center; width: 42px; padding: 0; border: 0; background: transparent; color: var(--mt-fg); }
.window-controls svg { width: 13px; height: 13px; }
.window-controls button:hover:enabled { background: var(--mt-row-hover); }
.window-controls .window-close:hover:enabled { background: #c42b1c; color: white; }
@media (max-width: 860px) { .app-menu button { padding-inline: 6px; } .window-controls button { width: 32px; } }
@media (max-width: 740px) { .brand strong { display: none; } .brand { padding-inline: 8px; } .drag-space { min-width: 8px; } }
</style>
