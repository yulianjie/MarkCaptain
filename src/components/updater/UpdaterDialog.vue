<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { isTauri } from '@tauri-apps/api/core'
import { getAllWindows, getCurrentWindow } from '@tauri-apps/api/window'
import { ElMessage } from 'element-plus'
import { bus } from '@/bus'
import { useI18n } from '@/i18n'
import { usePreferencesStore } from '@/stores/preferences'
import { createUpdater, scheduleUpdateChecks, updaterReadiness } from '@/services/updater'
import tauriConfig from '../../../src-tauri/tauri.conf.json'

const { t } = useI18n()
const prefs = usePreferencesStore()
const props = defineProps<{ prepareInstall: () => Promise<boolean> }>()
const updater = createUpdater({
  check: async () => {
    const { check } = await import('@tauri-apps/plugin-updater')
    return check({ timeout: 30_000 })
  },
  prepareInstall: async () => {
    // The installer/relaunch affects the entire process, including other windows.
    const windows = await getAllWindows()
    if (windows.filter(w => w.label === 'main' || w.label.startsWith('editor-')).length > 1) {
      ElMessage.warning(t('updater.closeOtherWindows'))
      return false
    }
    if (!await props.prepareInstall()) {
      ElMessage.warning(t('updater.saveCancelled'))
      return false
    }
    return true
  },
  relaunch: async () => {
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  },
}, () => updaterReadiness(tauriConfig.plugins.updater))
const state = updater.state
const busy = computed(() => ['downloading', 'preparing', 'installing'].includes(state.phase))
let unsubscribe: (() => void) | undefined
let stopWatching: (() => void) | undefined
let stopSchedule: (() => void) | undefined

onMounted(() => {
  unsubscribe = bus.on('show-updater-dialog', () => { void updater.check() })
  if (!isTauri() || getCurrentWindow().label !== 'main') return
  stopWatching = watch(() => prefs.loaded && prefs.autoCheckUpdates, enabled => {
    stopSchedule?.()
    if (enabled) stopSchedule = scheduleUpdateChecks(() => updater.check(false))
  }, { immediate: true })
})
onBeforeUnmount(() => {
  unsubscribe?.()
  stopWatching?.()
  stopSchedule?.()
  void updater.dispose()
})
</script>

<template>
  <el-dialog
    v-model="state.visible"
    :title="t('updater.title')"
    width="440px"
    :close-on-click-modal="false"
    :close-on-press-escape="!busy"
    :show-close="!busy"
    append-to-body
  >
    <div v-if="state.phase === 'disabled'">{{ t('updater.disabled') }}</div>
    <div v-else-if="state.phase === 'unconfigured'">{{ t('updater.unconfigured') }}</div>
    <div v-else-if="state.phase === 'checking'">{{ t('updater.checking') }}</div>
    <div v-else-if="state.phase === 'uptodate'">{{ t('updater.uptodate') }}</div>
    <div v-else-if="state.phase === 'available'">
      <p>{{ t('updater.available', { version: state.version }) }}</p>
      <pre v-if="state.notes" class="notes">{{ state.notes }}</pre>
      <p>{{ t('updater.saveBeforeInstall') }}</p>
    </div>
    <div v-else-if="state.phase === 'downloading'">
      <p>{{ t('updater.downloading') }}</p>
      <el-progress :indeterminate="!state.total" :percentage="state.total ? Math.min(100, Math.round(state.downloaded / state.total * 100)) : 0" />
    </div>
    <div v-else-if="state.phase === 'preparing'">{{ t('updater.preparing') }}</div>
    <div v-else-if="state.phase === 'installing'">{{ t('updater.installing') }}</div>
    <div v-else-if="state.phase === 'ready'">{{ t('updater.ready') }}</div>
    <div v-if="state.error" class="error" role="alert">{{ t('updater.error') }}: {{ state.error }}</div>
    <template #footer>
      <el-button v-if="state.phase === 'available'" type="primary" @click="updater.install">{{ t('updater.install') }}</el-button>
      <el-button v-if="state.phase === 'ready'" type="primary" @click="updater.relaunch">{{ t('updater.relaunch') }}</el-button>
      <el-button v-if="state.phase === 'error'" @click="updater.check()">{{ t('updater.retry') }}</el-button>
      <el-button :disabled="busy" @click="state.visible = false">{{ t('common.close') }}</el-button>
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
.error { color: var(--el-color-danger); overflow-wrap: anywhere; }
</style>
