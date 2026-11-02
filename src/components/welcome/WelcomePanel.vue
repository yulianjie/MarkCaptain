<script setup lang="ts">
import { computed } from 'vue'
import { ArrowUpRight, FileText, FolderOpen, HardDrive, Plus, Search } from '@lucide/vue'
import { usePreferencesStore } from '@/stores/preferences'
import { useEditorStore } from '@/stores/editor'
import { useNotificationStore } from '@/stores/notification'
import { bus } from '@/bus'
import { useI18n } from '@/i18n'
import { useWorkspaceCopy } from './workspace-copy'

const emit = defineEmits<{ open: []; folder: []; opened: [] }>()
const prefs = usePreferencesStore()
const editor = useEditorStore()
const notify = useNotificationStore()
const { t } = useI18n()
const copy = useWorkspaceCopy()
const recent = computed(() => prefs.recentFiles.slice(0, 5))
function filename(path: string) { return path.split(/[\\/]/).pop() || path }
function directory(path: string) { return path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))) }
async function openRecent(path: string) {
  try { await editor.openFile(path); emit('opened') }
  catch (error) { notify.pushToast({ type: 'error', title: t('toast.openFailed'), message: String(error) }) }
}
</script>

<template>
  <section class="welcome-panel" :aria-label="copy.start">
    <div class="welcome-top"><span>{{ copy.start }}</span><button type="button" @click="bus.emit('show-command-palette', undefined)"><Search :size="14" />{{ copy.commands }}</button></div>
    <div class="welcome-content">
      <p class="eyebrow">{{ copy.welcome }}</p>
      <h1>{{ copy.title }}</h1>
      <p class="subtitle">{{ copy.subtitle }}</p>
      <div class="welcome-actions">
        <button type="button" class="primary" @click="editor.newUntitledTab()"><Plus :size="16" />{{ copy.newDocument }}</button>
        <button type="button" @click="$emit('folder')"><FolderOpen :size="16" />{{ t('sideBar.openFolder') }}</button>
        <button type="button" class="quiet" @click="$emit('open')">{{ copy.openDocument }}<ArrowUpRight :size="14" /></button>
      </div>
      <header class="recent-heading"><h2>{{ copy.recent }}</h2><button type="button" @click="bus.emit('show-recent', undefined)">{{ copy.allRecent }}<ArrowUpRight :size="13" /></button></header>
      <div v-if="recent.length" class="recent-list">
        <button v-for="path in recent" :key="path" type="button" :title="path" @click="openRecent(path)">
          <span class="note-icon"><FileText :size="18" :stroke-width="1.5" /></span>
          <span class="recent-label"><strong>{{ filename(path) }}</strong><small>{{ directory(path) }}</small></span>
          <ArrowUpRight class="recent-arrow" :size="15" />
        </button>
      </div>
      <p v-else class="recent-empty"><FileText :size="20" :stroke-width="1.4" />{{ copy.emptyRecent }}</p>
      <p class="welcome-foot"><HardDrive :size="14" />{{ copy.localNote }}</p>
    </div>
  </section>
</template>

<style scoped>
.welcome-panel { flex: 1; min-width: 0; min-height: 0; overflow: auto; color: var(--mt-fg); background: var(--mt-bg); }
.welcome-top { display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 49px; padding: 0 28px; border-bottom: 1px solid var(--mt-border); color: var(--mt-fg-muted); font-size: 12px; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; border: 1px solid var(--mt-border); border-radius: 7px; padding: 9px 13px; background: var(--mt-surface-raised, var(--mt-bg)); color: var(--mt-fg); font: inherit; font-size: 12px; cursor: pointer; }
button:hover { background: var(--mt-row-hover); }
button:focus-visible { outline: 2px solid var(--mt-accent); outline-offset: 2px; }
.welcome-top button, .recent-heading button { border: 0; padding: 6px 0; background: transparent; color: var(--mt-fg-muted); }
.welcome-content { max-width: 690px; margin: 0 auto; padding: clamp(36px, 7vh, 72px) clamp(24px, 5vw, 62px) 30px; }
.eyebrow { margin: 0 0 16px; color: var(--mt-accent); font-size: 10px; font-weight: 600; letter-spacing: .12em; }
h1 { margin: 0 0 12px; font-size: clamp(23px, 2.3vw, 29px); line-height: 1.4; letter-spacing: -.03em; font-weight: 600; }
.subtitle { margin: 0; font-size: 13px; line-height: 1.8; color: var(--mt-fg-muted); }
.welcome-actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 27px 0 44px; }
.welcome-actions .primary { border-color: var(--mt-accent); background: var(--mt-accent); color: var(--mt-text-on-accent, white); }
.welcome-actions .primary:hover { filter: brightness(.95); }
.welcome-actions .quiet { border-color: transparent; background: transparent; color: var(--mt-fg-muted); }
.recent-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 11px; }
h2 { margin: 0; font-size: 13px; font-weight: 600; }
.recent-heading button { font-size: 11px; }
.recent-list { border-top: 1px solid var(--mt-border); }
.recent-list > button { display: flex; width: 100%; justify-content: flex-start; padding: 15px 2px; gap: 13px; border: 0; border-bottom: 1px solid var(--mt-border); border-radius: 0; background: transparent; text-align: left; }
.recent-list > button:hover { background: var(--mt-row-hover); }
.note-icon { display: grid; place-items: center; flex: 0 0 36px; height: 40px; color: var(--mt-accent); background: var(--mt-accent-soft, var(--mt-icon-active-bg)); border-radius: 6px; }
.recent-label { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 5px; }
.recent-label strong { font-size: 13px; font-weight: 500; }
.recent-label small { font-size: 11px; color: var(--mt-fg-muted); }
.recent-label strong, .recent-label small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.recent-arrow { color: var(--mt-fg-muted); flex-shrink: 0; }
.recent-empty { display: flex; align-items: center; gap: 12px; padding: 25px 16px; border: 1px dashed var(--mt-border); border-radius: 8px; color: var(--mt-fg-muted); font-size: 12px; line-height: 1.7; }
.welcome-foot { display: flex; align-items: center; gap: 7px; margin: 35px 0 0; color: var(--mt-fg-muted); font-size: 11px; line-height: 1.7; }
@media (max-width: 600px) { .welcome-top { padding-inline: 22px; } .welcome-top button { font-size: 11px; } .welcome-actions { margin-bottom: 30px; } }
</style>
