<script setup lang="ts">
/**
 * Command palette — bus-driven modal listing every registered command.
 * Ctrl/Cmd+Shift+P or `mt://palette/show` event to open.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Search } from '@lucide/vue'
import {
  nextEnabledCommandIndex,
  safeCommandIndex,
  useCommandCenterStore,
} from '@/stores/commandCenter'
import { useNotificationStore } from '@/stores/notification'
import { bus } from '@/bus'
import { useI18n } from '@/i18n'

const cc = useCommandCenterStore()
const notify = useNotificationStore()
const { t, locale } = useI18n()
const footerCopy = computed(() => ({
  en: { navigate: 'Navigate', execute: 'Run' },
  'zh-CN': { navigate: '选择', execute: '执行' },
  ja: { navigate: '選択', execute: '実行' },
})[locale.value])
const visible = ref(false)
const query = ref('')
const selectedIndex = ref(0)
const inputRef = ref<HTMLInputElement | null>(null)
const rowRefs = new Map<string, HTMLElement>()

const matches = computed(() => cc.search(query.value))
const activeOptionId = computed(() => {
  const command = matches.value[selectedIndex.value]
  return command ? `command-option-${command.id.replace(/[^a-zA-Z0-9_-]/g, '-')}` : undefined
})

function open() {
  visible.value = true
  query.value = ''
  selectedIndex.value = 0
  nextTick(() => inputRef.value?.focus())
}

function close() {
  visible.value = false
}

async function exec(idx: number) {
  const cmd = matches.value[idx]
  if (!cmd || cmd.disabled) return
  try {
    if (await cc.execute(cmd.id)) close()
  } catch (error) {
    notify.pushToast({
      type: 'error',
      title: t('command.executionFailed'),
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

function moveSelection(delta: -1 | 1) {
  selectedIndex.value = nextEnabledCommandIndex(matches.value, selectedIndex.value, delta)
}

function onKey(ev: KeyboardEvent) {
  if (!visible.value) return
  if (ev.key === 'Escape') { ev.preventDefault(); close() }
  else if (ev.key === 'ArrowDown') {
    ev.preventDefault()
    moveSelection(1)
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault()
    moveSelection(-1)
  } else if (ev.key === 'Enter') {
    ev.preventDefault()
    void exec(selectedIndex.value)
  }
}

function setRowRef(id: string, element: unknown) {
  if (element instanceof HTMLElement) rowRefs.set(id, element)
  else rowRefs.delete(id)
}

watch(query, () => { selectedIndex.value = 0 }, { flush: 'sync' })

watch(matches, commands => {
  selectedIndex.value = safeCommandIndex(commands, selectedIndex.value)
}, { flush: 'sync' })

watch([matches, selectedIndex], async () => {
  await nextTick()
  const command = matches.value[selectedIndex.value]
  if (command) rowRefs.get(command.id)?.scrollIntoView({ block: 'nearest' })
}, { flush: 'post' })

let unsubBus: (() => void) | null = null

onMounted(() => {
  unsubBus = bus.on('show-command-palette', open)
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  unsubBus?.()
  window.removeEventListener('keydown', onKey)
})

defineExpose({ open })
</script>

<template>
  <el-dialog
    v-model="visible"
    width="min(600px, calc(100vw - 32px))"
    :show-close="false"
    :close-on-click-modal="true"
    class="command-palette-dialog"
    align-center
    :aria-label="t('command.title')"
  >
    <template #header>
      <div class="cp-search">
        <Search :size="18" aria-hidden="true" />
        <input
          ref="inputRef"
          v-model="query"
          class="cp-input"
          :placeholder="t('command.placeholder')"
          :aria-label="t('command.title')"
          spellcheck="false"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="command-palette-list"
          :aria-expanded="visible"
          :aria-activedescendant="activeOptionId"
        />
      </div>
    </template>
    <div id="command-palette-list" class="cp-list" role="listbox" :aria-label="t('command.results')">
      <div
        v-for="(cmd, idx) in matches"
        :key="cmd.id"
        :id="`command-option-${cmd.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`"
        :ref="element => setRowRef(cmd.id, element)"
        class="cp-row"
        :class="{ selected: idx === selectedIndex, disabled: cmd.disabled }"
        role="option"
        :aria-selected="idx === selectedIndex"
        :aria-disabled="cmd.disabled"
        @mouseenter="selectedIndex = idx"
        @click="exec(idx)"
      >
        <span class="cp-label">
          <span v-if="cmd.category" class="cp-category">{{ cmd.category }}</span>
          <span class="cp-desc">{{ cmd.description }}</span>
        </span>
        <span v-if="cmd.shortcut?.length" class="cp-shortcut">
          {{ cmd.shortcut.join(' ') }}
        </span>
      </div>
      <div v-if="!matches.length" class="cp-empty" role="status">{{ t('command.noMatches') }}</div>
    </div>
    <template #footer>
      <div class="cp-footer"><span><kbd>↑</kbd><kbd>↓</kbd>{{ footerCopy.navigate }}</span><span><kbd>↵</kbd>{{ footerCopy.execute }}</span><span><kbd>Esc</kbd>{{ t('common.close') }}</span></div>
    </template>
  </el-dialog>
</template>

<style scoped>
.cp-search { display: flex; align-items: center; gap: 11px; padding: 3px 1px 5px; color: var(--mt-fg-muted); }
.cp-search svg { flex-shrink: 0; }
.cp-input {
  width: 100%;
  min-width: 0;
  padding: 8px 2px;
  box-sizing: border-box;
  font-size: 15px;
  font-family: inherit;
  border: 0;
  border-radius: 3px;
  outline: none;
  color: var(--mt-fg);
  background: transparent;
}
.cp-search:focus-within { color: var(--mt-accent); }
.cp-input::placeholder { color: var(--mt-fg-muted); font-size: 13px; }
.cp-list { max-height: min(390px, 56vh); overflow-y: auto; padding: 8px 0 0; border-top: 1px solid var(--mt-border); }
.cp-footer { display: flex; align-items: center; gap: 17px; color: var(--mt-fg-muted); border-top: 1px solid var(--mt-border); padding-top: 13px; font-size: 10px; }
.cp-footer > span { display: flex; align-items: center; gap: 5px; }
.cp-footer > span:last-child { margin-left: auto; }
.cp-footer kbd, .cp-shortcut { border: 1px solid var(--mt-border); border-radius: 4px; background: var(--mt-surface); font-family: var(--mt-ui-font); font-size: 10px; padding: 2px 5px; line-height: 1.4; }
.cp-footer kbd { min-width: 11px; text-align: center; }
.cp-row {
  gap: 14px;
  min-height: 39px;
  box-sizing: border-box;
  margin: 2px 0;
}
.cp-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  cursor: pointer;
  font-size: 13px;
  border-radius: 7px;
}
.cp-row.selected {
  background: var(--mt-accent-soft);
}
.cp-row.disabled {
  cursor: not-allowed;
  opacity: 0.48;
}
.cp-label {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 3px 0;
  min-width: 0;
}
.cp-category {
  color: var(--mt-fg-muted);
  margin-right: 8px;
  flex: 0 0 auto;
}
.cp-desc { color: var(--mt-fg); overflow-wrap: anywhere; }
.cp-shortcut {
  color: var(--mt-fg-muted);
  flex-shrink: 0;
}
.cp-empty {
  padding: 34px 16px;
  text-align: center;
  color: var(--mt-fg-muted);
  font-size: 13px;
}
</style>
