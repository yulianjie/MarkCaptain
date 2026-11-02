<script setup lang="ts">
/**
 * About dialog. Triggered by the `aboutDialog` bus event.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { bus } from '@/bus'
import { getVersion } from '@tauri-apps/api/app'
import { t } from '@/i18n'
import { usePreferencesStore } from '@/stores/preferences'
import { getAppIconOption } from '@/services/app-icon'

const prefs = usePreferencesStore()
const currentIcon = computed(() => getAppIconOption(prefs.appIcon))

const visible = ref(false)
const appVersion = ref('0.1.0')

async function open() {
  visible.value = true
  try { appVersion.value = await getVersion() } catch { /* keep default */ }
}

let unsub: (() => void) | null = null
onMounted(() => { unsub = bus.on('aboutDialog', open) })
onBeforeUnmount(() => { unsub?.() })
</script>

<template>
  <el-dialog v-model="visible" width="min(420px, calc(100vw - 32px))" class="about-dialog" align-center :show-close="true" :aria-label="t('app.name')">
    <template #header>
      <h3 class="about-title">{{ t('app.name') }}</h3>
    </template>
    <div class="about-body">
      <img class="about-icon" :src="currentIcon.src" :alt="currentIcon.label" />
      <p class="tagline">{{ t('about.tagline') }}</p>
      <p class="version">{{ t('about.version', { version: appVersion }) }}</p>
      <p class="meta">{{ t('about.copyright') }}</p>
    </div>
  </el-dialog>
</template>

<style scoped>
.about-title {
  margin: 0;
  font-weight: 600;
  font-size: 15px;
  color: var(--mt-fg);
}
.about-body { text-align: center; padding: 22px 16px 12px; }
.about-icon {
  width: 96px;
  height: 96px;
  object-fit: contain;
  margin: 2px auto 24px;
  display: block;
}
.version {
  display: inline-block;
  border: 1px solid var(--mt-border);
  border-radius: 20px;
  background: var(--mt-surface);
  font-size: 11px;
  color: var(--mt-fg-muted);
  margin: 0 0 28px;
  padding: 5px 12px;
}
.tagline { color: var(--mt-fg); margin: 0 0 16px; font-size: 15px; line-height: 1.6; }
.meta { color: var(--mt-fg-muted); font-size: 11px; border-top: 1px solid var(--mt-border); padding-top: 18px; margin: 0; }
</style>
