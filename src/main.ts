import { createApp, nextTick } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { enableWindowBackdrop, showWindow } from './services/tauri-invoke'

import App from './App.vue'
import router from './router'
import { initTauriBridge, listenTyped } from './services/tauri-bridge'
import { installDebugBridge } from './services/debug-bridge'
import { applyPreferencesToDom } from './services/preferences-applier'
import { useListenForMainStore } from './stores/listenForMain'
import { usePreferencesStore } from './stores/preferences'
import { t } from './i18n'

import './assets/styles/global.css'
import './assets/styles/editor-glass.css'

// Install the debug bridge BEFORE creating the Vue app so we catch even
// errors thrown during component initialisation.
installDebugBridge()

const app = createApp(App)
const pinia = createPinia()

app.config.errorHandler = (err, _instance, info) => {
  const error = err instanceof Error ? err : new Error(String(err))
  console.error(`[vue:${info}]`, error)
}

// Expose `$t` so templates can call it without an extra import per SFC.
app.config.globalProperties.$t = t

app.use(pinia)
app.use(router)
app.use(ElementPlus)

// Wire up Tauri event listeners before mount so the initial render can react
// to file-association launches and second-instance forwards.
initTauriBridge(app)

async function bootstrap() {
  const appWindow = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
    ? getCurrentWindow()
    : null
  try {
    // Keep native windows hidden while their persisted appearance is loading.
    if (appWindow) await appWindow.hide().catch(() => undefined)
    if (appWindow) {
      const stopBackdrop = await listenTyped('mt://window/backdrop', active => {
        document.documentElement.classList.toggle('native-glass', active)
      })
      window.addEventListener('beforeunload', stopBackdrop, { once: true })
    }
    if (appWindow && await enableWindowBackdrop().catch(() => false)) {
      document.documentElement.classList.add('native-glass')
    }

    // Load and apply preferences before the first render. This keeps every
    // window — including Preferences — from flashing the default English/light
    // appearance while its page-level mounted hook waits for IPC.
    const prefs = usePreferencesStore(pinia)
    const listener = useListenForMainStore(pinia)
    // Subscribe first, then load the snapshot. A sibling window can write while
    // this window boots without its patch falling into a listener gap.
    await listener.install().catch(() => undefined)
    await prefs.load()
    await applyPreferencesToDom()
  } catch (error) {
    // Still attempt to mount with the available/default preferences, so a
    // failed startup IPC or theme application cannot leave an invisible app.
    console.error('[bootstrap] failed to initialize application', error)
  }

  try {
    app.mount('#app')
    // Flush Vue's DOM updates without waiting for a painted frame. WKWebView
    // may suspend animation frames while its native window is hidden.
    await nextTick()
  } catch (error) {
    console.error('[bootstrap] failed to mount application', error)
  }

  // Reveal even after an initialization/mount failure. The Rust command still
  // repairs saved geometry before showing and focusing the native window.
  // Browser-only Vite development skips this.
  if (appWindow) {
    await showWindow().catch(error => console.error('[window] failed to show window', error))
  }
}

void bootstrap().catch(error => console.error('[bootstrap] failed to start application', error))
