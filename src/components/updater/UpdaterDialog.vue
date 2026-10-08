<script setup lang="ts">
/**
 * Auto-update dialog — driven by `@tauri-apps/plugin-updater`. The Rust plugin
 * stays registered, but this renderer gate refuses to call it unless the
 * project-level `active` flag, an HTTPS endpoint, and a signing public key are
 * all present in tauri.conf.json. An unsigned build therefore fails closed.
 */
import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { bus } from '@/bus'
import { useI18n } from '@/i18n'
import tauriConfig from '../../../src-tauri/tauri.conf.json'

const { t, locale } = useI18n()

type Phase =
  | 'idle'
  | 'disabled'
  | 'unconfigured'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'uptodate'
  | 'error'

const localizedCopy = {
  en: {
    disabled: 'Automatic updates are disabled in this build. Release signing has not been enabled, so MarkCaptain did not contact the update server. Install updates manually from the project releases page.',
    unconfigured: 'Automatic updates are not configured safely. A signing public key and at least one HTTPS endpoint are required, so no update check was performed.',
    releases: 'Open project releases',
  },
  'zh-CN': {
    disabled: '此版本已关闭自动更新。发布签名尚未启用，因此 MarkCaptain 未连接更新服务器。请从项目发布页面手动安装更新。',
    unconfigured: '自动更新配置不安全：必须提供签名公钥和至少一个 HTTPS 地址。本次未执行更新检查。',
    releases: '打开项目发布页面',
  },
  ja: {
    disabled: 'このビルドでは自動更新が無効です。リリース署名が有効になっていないため、MarkCaptain は更新サーバーに接続していません。プロジェクトのリリースページから手動で更新してください。',
    unconfigured: '自動更新が安全に構成されていません。署名公開鍵と 1 つ以上の HTTPS エンドポイントが必要なため、更新確認は実行されませんでした。',
    releases: 'プロジェクトのリリースを開く',
  },
} as const

const copy = computed(() => localizedCopy[locale.value] ?? localizedCopy.en)
const updaterConfig = tauriConfig.plugins.updater
const releasesUrl = 'https://github.com/yulianjie/MarkCaptain/releases'

const visible = ref(false)
const phase = ref<Phase>('idle')
const version = ref('')
const notes = ref('')
const error = ref('')
const downloaded = ref(0)
const total = ref(0)
let activeUpdate: Update | null = null

function updaterReadiness(): 'ready' | 'disabled' | 'unconfigured' {
  // `active` is a MarkCaptain renderer gate. The Tauri updater Config ignores
  // unknown fields, so this check must happen before importing/calling check().
  if (!updaterConfig.active) return 'disabled'

  const hasPublicKey = updaterConfig.pubkey.trim().length > 0
  const hasSecureEndpoints = updaterConfig.endpoints.length > 0
    && updaterConfig.endpoints.every(endpoint => endpoint.startsWith('https://'))
  return hasPublicKey && hasSecureEndpoints ? 'ready' : 'unconfigured'
}

async function open() {
  visible.value = true
  phase.value = 'idle'
  error.value = ''
  version.value = ''
  notes.value = ''
  downloaded.value = 0
  total.value = 0
  activeUpdate = null

  const readiness = updaterReadiness()
  if (readiness !== 'ready') {
    phase.value = readiness
    return
  }

  phase.value = 'checking'

  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (!update) {
      phase.value = 'uptodate'
      return
    }
    version.value = update.version ?? ''
    notes.value = update.body ?? ''
    phase.value = 'available'
    activeUpdate = update
  } catch (err) {
    phase.value = 'error'
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function downloadAndInstall() {
  if (!activeUpdate) return
  phase.value = 'downloading'
  try {
    await activeUpdate.downloadAndInstall((ev: DownloadEvent) => {
      if (ev.event === 'Started') total.value = ev.data?.contentLength ?? 0
      else if (ev.event === 'Progress') downloaded.value += ev.data?.chunkLength ?? 0
      else if (ev.event === 'Finished') phase.value = 'ready'
    })
  } catch (err) {
    phase.value = 'error'
    error.value = err instanceof Error ? err.message : String(err)
  }
}

async function relaunchApp() {
  try {
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  } catch (err) {
    phase.value = 'error'
    error.value = err instanceof Error ? err.message : String(err)
  }
}

let unsub: (() => void) | null = null
onMounted(() => { unsub = bus.on('show-updater-dialog', () => { void open() }) })
onBeforeUnmount(() => { unsub?.() })
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="t('updater.title')"
    width="420px"
    :close-on-click-modal="false"
    append-to-body
  >
    <div v-if="phase === 'disabled'" class="notice">
      <p>{{ copy.disabled }}</p>
      <a :href="releasesUrl" target="_blank" rel="noopener noreferrer">{{ copy.releases }}</a>
    </div>
    <div v-else-if="phase === 'unconfigured'" class="notice warning">
      {{ copy.unconfigured }}
    </div>
    <div v-if="phase === 'checking'">{{ t('updater.checking') }}</div>
    <div v-else-if="phase === 'uptodate'">{{ t('updater.uptodate') }}</div>
    <div v-else-if="phase === 'available'">
      <p>{{ t('updater.available', { version }) }}</p>
      <pre v-if="notes" class="notes">{{ notes }}</pre>
    </div>
    <div v-else-if="phase === 'downloading'">
      <p>{{ t('updater.downloading') }}</p>
      <el-progress
        :percentage="total ? Math.min(100, Math.round((downloaded / total) * 100)) : 0"
      />
    </div>
    <div v-else-if="phase === 'ready'">{{ t('updater.ready') }}</div>
    <div v-else-if="phase === 'error'" class="error">{{ t('updater.error') }}: {{ error }}</div>

    <template #footer>
      <el-button v-if="phase === 'available'" type="primary" @click="downloadAndInstall">
        {{ t('updater.install') }}
      </el-button>
      <el-button v-if="phase === 'ready'" type="primary" @click="relaunchApp">
        {{ t('updater.relaunch') }}
      </el-button>
      <el-button @click="visible = false">{{ t('common.close') }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.notes {
  max-height: 200px;
  overflow: auto;
  background: var(--el-fill-color-light);
  padding: 8px;
  border-radius: 4px;
  font-size: 12px;
  white-space: pre-wrap;
}
.error {
  color: var(--el-color-danger);
}
.notice {
  line-height: 1.55;
  color: var(--el-text-color-regular);
}
.notice p {
  margin: 0 0 10px;
}
.notice a {
  color: var(--el-color-primary);
}
.notice.warning {
  color: var(--el-color-warning-dark-2);
}
</style>
