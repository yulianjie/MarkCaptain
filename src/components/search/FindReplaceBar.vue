<script setup lang="ts">
/**
 * Find / Replace bar — floats above the editor when `editor.findReplaceOpen`
 * is true. Drives the search through the bus (Muya picks up `find` /
 * `replace` events and highlights / replaces matches in WYSIWYG mode).
 *
 * Keyboard: Esc closes; Enter finds next; Shift+Enter finds previous.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Close, Search, ArrowDown, ArrowUp, Refresh } from '@element-plus/icons-vue'
import { useEditorStore } from '@/stores/editor'
import { bus, type SearchOpt } from '@/bus'
import { t } from '@/i18n'

const editor = useEditorStore()
const visible = computed(() => editor.findReplaceOpen)

const findInput = ref<HTMLInputElement | null>(null)
const replaceInput = ref<HTMLInputElement | null>(null)
const findText = ref('')
const replaceText = ref('')
const showReplace = ref(false)
const opts = ref<SearchOpt>({ caseSensitive: false, wholeWord: false, regex: false })

const matchInfo = computed(() => {
  const sm = editor.currentFile?.searchMatches
  if (!sm || sm.matches.length === 0) return findText.value ? '0/0' : ''
  return `${sm.index + 1}/${sm.matches.length}`
})

function close() {
  editor.findReplaceOpen = false
}

/**
 * The editor menu and renderer shortcut layer both send this transient bus
 * request. It deliberately does not rely only on `findReplaceOpen`: a second
 * Ctrl/Cmd+F must restore focus even if the bar was already visible.
 */
async function requestOpen(mode: 'find' | 'replace') {
  if (mode === 'replace') showReplace.value = true
  editor.findReplaceOpen = true
  await nextTick()
  const input = mode === 'replace' ? replaceInput.value : findInput.value
  input?.focus()
  input?.select()
  performFind()
}

function performFind() {
  bus.emit('find', { value: findText.value, opt: opts.value })
  bus.emit('searchValue', findText.value)
}

function next() {
  bus.emit('findNext', undefined)
}

function prev() {
  bus.emit('findPrev', undefined)
}

function performReplace() {
  bus.emit('replace', { value: replaceText.value, opt: opts.value })
}

function performReplaceAll() {
  bus.emit('find-action', 'replaceAll')
  bus.emit('replace', { value: replaceText.value, opt: opts.value })
}

function onKey(ev: KeyboardEvent) {
  if (ev.key === 'Escape') { ev.preventDefault(); close() }
  else if (ev.key === 'Enter') {
    ev.preventDefault()
    if (ev.shiftKey) prev()
    else next()
  }
}

watch(visible, async (open) => {
  if (open) {
    await requestOpen(showReplace.value ? 'replace' : 'find')
  }
})

watch(findText, () => { if (visible.value) performFind() })

let unsubRequest: (() => void) | null = null
onMounted(() => {
  unsubRequest = bus.on('request-find-replace', request => { void requestOpen(request.mode) })
})

onBeforeUnmount(() => { unsubRequest?.() })
</script>

<template>
  <div v-show="visible" class="find-bar" @keydown="onKey">
    <div class="row">
      <el-icon class="row-icon"><Search /></el-icon>
      <input
        ref="findInput"
        v-model="findText"
        class="input"
        data-find-input
        :placeholder="t('find.findPlaceholder')"
        spellcheck="false"
      />
      <span class="match-info">{{ matchInfo }}</span>
      <button class="btn" :title="t('find.previous')" @click="prev"><el-icon :size="14"><ArrowUp /></el-icon></button>
      <button class="btn" :title="t('find.next')" @click="next"><el-icon :size="14"><ArrowDown /></el-icon></button>
      <button class="btn toggle" :class="{ on: opts.caseSensitive }" :aria-pressed="opts.caseSensitive" :title="t('find.caseSensitive')" @click="opts.caseSensitive = !opts.caseSensitive">Aa</button>
      <button class="btn toggle" :class="{ on: opts.wholeWord }" :aria-pressed="opts.wholeWord" :title="t('find.wholeWord')" @click="opts.wholeWord = !opts.wholeWord">ab</button>
      <button class="btn toggle" :class="{ on: opts.regex }" :aria-pressed="opts.regex" :title="t('find.regex')" @click="opts.regex = !opts.regex">.*</button>
      <button class="btn toggle" :class="{ on: showReplace }" :aria-expanded="showReplace" :title="t('find.toggleReplace')" @click="showReplace = !showReplace">↳</button>
      <button class="btn close" :title="t('find.closeEsc')" @click="close"><el-icon :size="14"><Close /></el-icon></button>
    </div>
    <div v-if="showReplace" class="row">
      <el-icon class="row-icon"><Refresh /></el-icon>
      <input
        ref="replaceInput"
        v-model="replaceText"
        class="input"
        data-replace-input
        :placeholder="t('find.replacePlaceholder')"
        spellcheck="false"
      />
      <button class="btn" :title="t('find.replace')" @click="performReplace">{{ t('find.replace') }}</button>
      <button class="btn" :title="t('find.replaceAll')" @click="performReplaceAll">{{ t('find.replaceAll') }}</button>
    </div>
  </div>
</template>

<style scoped>
.find-bar {
  position: absolute;
  top: 10px;
  right: 16px;
  z-index: 10;
  background: var(--mt-surface-raised, var(--mt-bg));
  border: 1px solid var(--mt-border, #d1d5da);
  border-radius: 9px;
  box-shadow: var(--mt-shadow-panel, 0 6px 20px #0002);
  padding: 9px;
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 12px;
  width: 440px;
  max-width: calc(100% - 32px);
  box-sizing: border-box;
  container-type: inline-size;
}
.row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.row-icon { color: var(--mt-fg-muted, #6a737d); padding: 0 4px; }
.input {
  flex: 1;
  min-width: 80px;
  border: 1px solid var(--mt-border, #d1d5da);
  border-radius: 4px;
  padding: 6px 8px;
  font-size: 12px;
  outline: none;
  color: var(--mt-fg, #24292e);
  background: var(--mt-bg);
}
.input:focus { border-color: var(--mt-accent, #0366d6); }
.match-info {
  color: var(--mt-fg-muted, #6a737d);
  font-size: 11px;
  font-family: ui-monospace, monospace;
  min-width: 36px;
  text-align: center;
}
.btn {
  border: 1px solid transparent;
  background: transparent;
  color: var(--mt-fg-muted, #586069);
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 5px;
  font-size: 11px;
  font-family: ui-monospace, monospace;
  min-width: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.btn:hover { background: var(--mt-row-hover, #eaecef); color: var(--mt-fg, #24292e); }
.btn:focus-visible { outline: 2px solid var(--mt-accent, #0366d6); outline-offset: 1px; }
.btn.toggle.on {
  background: var(--mt-accent-soft, var(--mt-icon-active-bg));
  color: var(--mt-accent);
  border-color: transparent;
}
.btn.close:hover { background: var(--mt-row-hover, #f1f3f5); }

@container (max-width: 400px) {
  .row .input { flex-basis: calc(100% - 48px); min-width: 0; }
  .match-info { margin-inline-start: auto; }
}
</style>
