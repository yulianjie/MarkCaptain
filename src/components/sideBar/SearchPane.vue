<script setup lang="ts">
/**
 * Folder-wide search panel — runs ripgrep on the Rust side and lists hits
 * grouped by file. Click a hit to open the file at the matching line.
 */
import { computed, ref } from 'vue'
import { Search } from '@element-plus/icons-vue'
import { useProjectStore } from '@/stores/project'
import { useEditorStore } from '@/stores/editor'
import { usePreferencesStore } from '@/stores/preferences'
import { useNotificationStore } from '@/stores/notification'
import { bus } from '@/bus'
import { searchInFolder, type SearchHit } from '@/services/tauri-invoke'
import { parseSearchMaxFileSize } from '@/services/search-preferences'
import { createSearchRevealRequest } from '@/services/search-reveal'
import { t } from '@/i18n'

interface Group { path: string; hits: SearchHit[] }

const project = useProjectStore()
const editor = useEditorStore()
const prefs = usePreferencesStore()
const notify = useNotificationStore()

const query = ref('')
const caseSensitive = ref(false)
const wholeWord = ref(false)
const regex = ref(false)
const includeHidden = ref(false)
const busy = ref(false)
const groups = ref<Group[]>([])
const activeHitKey = ref<string | null>(null)
const focusedHitKey = ref<string | null>(null)

const hasResults = computed(() => groups.value.length > 0)
const totalHits = computed(() => groups.value.reduce((n, g) => n + g.hits.length, 0))

let runToken = 0
async function runSearch() {
  if (!project.projectTree) {
    notify.pushToast({ type: 'warning', message: t('sideBar.openFolderFirst') })
    return
  }
  const text = query.value.trim()
  if (!text) { groups.value = []; return }
  busy.value = true
  const token = ++runToken
  try {
    const hits = await searchInFolder({
      root: project.projectTree.pathname,
      query: text,
      caseSensitive: caseSensitive.value,
      wholeWord: wholeWord.value,
      regex: regex.value,
      includeHidden: includeHidden.value || prefs.searchIncludeHidden,
      followSymlinks: prefs.searchFollowSymlinks,
      exclusions: prefs.searchExclusions,
      maxFileSize: parseSearchMaxFileSize(prefs.searchMaxFileSize),
      noIgnore: prefs.searchNoIgnore,
    })
    if (token !== runToken) return // a newer search supersedes us
    groups.value = group(hits)
  } catch (err) {
    if (token !== runToken) return
    notify.pushToast({ type: 'error', title: t('sideBar.searchFailed'), message: err instanceof Error ? err.message : String(err) })
    groups.value = []
  } finally {
    if (token === runToken) busy.value = false
  }
}

function group(hits: SearchHit[]): Group[] {
  const map = new Map<string, SearchHit[]>()
  for (const hit of hits) {
    const arr = map.get(hit.path)
    if (arr) arr.push(hit)
    else map.set(hit.path, [hit])
  }
  return [...map.entries()].map(([path, hits]) => ({ path, hits }))
}

let openToken = 0
let latestOpenedTabId: string | null = null
async function openHit(hit: SearchHit, key: string) {
  const token = ++openToken
  try {
    const tab = await editor.openFile(hit.path)
    // A slower, older file read must not steal focus or reveal inside the tab
    // opened by a newer click.
    if (token !== openToken) {
      if (latestOpenedTabId) editor.setCurrent(latestOpenedTabId)
      return
    }
    latestOpenedTabId = tab.id
    activeHitKey.value = key
    bus.emit('reveal-search-hit', createSearchRevealRequest({
      tabId: tab.id,
      path: tab.pathname || hit.path,
      line: hit.line,
      column: hit.column,
      length: hit.length,
      mode: editor.sourceCodeMode ? 'source' : 'wysiwyg',
    }))
  } catch (err) {
    if (token !== openToken) return
    notify.pushToast({ type: 'error', title: t('toast.openFailed'), message: err instanceof Error ? err.message : String(err) })
  }
}

// Debounced auto-search on typing.
let debounce: ReturnType<typeof setTimeout> | null = null
function onQueryInput() {
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => { void runSearch() }, 300)
}

function shortPath(full: string): string {
  if (!project.projectTree) return full
  const root = project.projectTree.pathname
  return full.startsWith(root) ? full.slice(root.length + 1) : full
}

function hitKey(path: string, hit: SearchHit, index: number): string {
  return `${path}:${hit.line}:${hit.column}:${hit.endColumn}:${index}`
}

function hitAriaLabel(path: string, hit: SearchHit): string {
  return `${shortPath(path)} ${hit.line}:${hit.column} ${hit.preview}`
}
</script>

<template>
  <div class="search-pane">
    <div class="search-header">
      <div class="input-row">
        <el-icon class="leading"><Search /></el-icon>
        <input
          v-model="query"
          class="search-input"
          :placeholder="t('sideBar.searchInFolder')"
          spellcheck="false"
          @input="onQueryInput"
          @keyup.enter="runSearch"
        />
      </div>
      <div class="toggle-row">
        <button type="button" class="toggle" :class="{ on: caseSensitive }" :title="t('sideBar.caseSensitive')" :aria-pressed="caseSensitive" @click="caseSensitive = !caseSensitive; runSearch()">Aa</button>
        <button type="button" class="toggle" :class="{ on: wholeWord }" :title="t('sideBar.wholeWord')" :aria-pressed="wholeWord" @click="wholeWord = !wholeWord; runSearch()">ab</button>
        <button type="button" class="toggle" :class="{ on: regex }" :title="t('sideBar.regex')" :aria-pressed="regex" @click="regex = !regex; runSearch()">.*</button>
        <span class="status">
          <template v-if="busy">{{ t('sideBar.searching') }}</template>
          <template v-else-if="hasResults">{{ t('sideBar.searchResults', { matches: totalHits, files: groups.length }) }}</template>
        </span>
      </div>
    </div>
    <div class="results" role="listbox" :aria-label="t('sideBar.searchInFolder')">
      <div v-for="g in groups" :key="g.path" class="group" role="group" :aria-label="shortPath(g.path)">
        <div class="group-header" :title="g.path">{{ shortPath(g.path) }}</div>
        <div
          v-for="(hit, idx) in g.hits"
          :key="hitKey(g.path, hit, idx)"
          class="hit"
          :class="{
            current: activeHitKey === hitKey(g.path, hit, idx),
            focused: focusedHitKey === hitKey(g.path, hit, idx),
          }"
          role="option"
          tabindex="0"
          :aria-label="hitAriaLabel(g.path, hit)"
          :aria-selected="activeHitKey === hitKey(g.path, hit, idx)"
          :aria-current="activeHitKey === hitKey(g.path, hit, idx) ? 'location' : undefined"
          @focus="focusedHitKey = hitKey(g.path, hit, idx)"
          @blur="focusedHitKey = null"
          @click="openHit(hit, hitKey(g.path, hit, idx))"
          @keydown.enter.prevent="openHit(hit, hitKey(g.path, hit, idx))"
          @keydown.space.prevent="openHit(hit, hitKey(g.path, hit, idx))"
        >
          <span class="line">{{ hit.line }}:{{ hit.column }}</span>
          <span class="preview">{{ hit.preview }}</span>
        </div>
      </div>
      <div v-if="!busy && query && !hasResults" class="empty">{{ t('sideBar.noMatches') }}</div>
      <div v-if="!busy && !query" class="empty">{{ t('sideBar.typeQuery') }}</div>
    </div>
  </div>
</template>

<style scoped>
.search-pane { height: 100%; min-height: 0; display: flex; flex-direction: column; }
.search-header {
  border-bottom: 1px solid var(--mt-border, #eaecef);
  padding: 16px 15px 12px;
  flex-shrink: 0;
}
.input-row {
  display: flex;
  align-items: center;
  border: 1px solid var(--mt-border, #d1d5da);
  border-radius: var(--mt-radius-tab);
  padding: 8px 9px;
  background: var(--mt-bg, #fff);
}
.input-row:focus-within { border-color: var(--mt-accent); box-shadow: 0 0 0 2px var(--mt-accent-soft); }
.leading { color: var(--mt-fg-muted, #6a737d); margin-right: 6px; font-size: 14px; }
.search-input {
  min-width: 0;
  flex: 1;
  border: none;
  outline: none;
  font-size: 12px;
  background: transparent;
  color: var(--mt-fg, #24292e);
}
.toggle-row {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
}
.toggle {
  border: 1px solid transparent;
  background: transparent;
  color: var(--mt-fg-muted, #586069);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 5px;
  font-size: 11px;
  font-family: ui-monospace, monospace;
}
.toggle:hover { background: var(--mt-row-hover, #eaecef); color: var(--mt-fg, #24292e); }
.toggle:focus-visible { outline: 2px solid var(--mt-accent, #0366d6); outline-offset: 1px; }
.toggle.on { background: var(--mt-accent-soft, var(--mt-icon-active-bg)); color: var(--mt-accent); border-color: transparent; }
.status {
  margin-left: auto;
  color: var(--mt-fg-muted, #6a737d);
  font-size: 11px;
}
.results { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: 16px; }
.group { margin-top: 8px; }
.group-header {
  padding: 9px 17px;
  font-size: 11px;
  font-weight: 600;
  color: var(--mt-fg, #24292e);
  background: transparent;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.hit {
  display: flex;
  gap: 8px;
  padding: 6px 9px;
  margin: 1px 8px;
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
  align-items: baseline;
}
.hit:hover { background: var(--mt-row-hover, #f1f8ff); }
.hit.current { background: var(--mt-accent-soft, var(--mt-icon-active-bg)); }
.hit:focus-visible {
  outline: 2px solid var(--mt-accent, #0366d6);
  outline-offset: -2px;
}
.hit .line {
  color: var(--mt-fg-muted, #6a737d);
  font-family: ui-monospace, monospace;
  font-size: 11px;
  min-width: 42px;
  text-align: right;
  flex-shrink: 0;
}
.hit .preview {
  color: var(--mt-fg, #24292e);
  font-family: ui-monospace, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.empty {
  padding: 28px 22px;
  line-height: 1.8;
  text-align: center;
  color: var(--mt-fg-muted, #959da5);
  font-size: 12px;
}
</style>
