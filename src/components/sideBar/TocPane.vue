<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Search, DArrowLeft, ArrowRight } from '@element-plus/icons-vue'
import { useEditorStore, type TocItem } from '@/stores/editor'
import { usePreferencesStore } from '@/stores/preferences'
import { useLayoutStore } from '@/stores/layout'
import { t } from '@/i18n'

const editor = useEditorStore()
const prefs = usePreferencesStore()
const layout = useLayoutStore()
const query = ref('')
const collapsed = ref(new Set<string>())
const activeSlug = ref<string | null>(null)
const progress = ref(0)
const rowRefs = new Map<string, HTMLButtonElement>()
let scrollHost: HTMLElement | null = null
let scrollFrame = 0
let observer: ResizeObserver | undefined

interface OutlineRow {
  key: string
  level: number
  depth: number
  content: string
  slug?: string
  ancestors: string[]
  hasChildren: boolean
}
function flatten(items: TocItem[], ancestors: string[] = [], depth = 0): OutlineRow[] {
  return items.flatMap((item, index) => {
    const key = item.slug || ancestors.join('/') + ':' + index + ':' + item.content
    return [{
      key, level: item.level, depth, content: item.content, slug: item.slug,
      ancestors, hasChildren: Boolean(item.children?.length),
    }, ...flatten(item.children || [], [...ancestors, key], depth + 1)]
  })
}
const flat = computed(() => flatten(editor.toc))
const visible = computed(() => {
  const term = query.value.trim().toLocaleLowerCase()
  if (term) {
    const matches = new Set<string>()
    flat.value.forEach(item => {
      if (item.content.toLocaleLowerCase().includes(term)) {
        matches.add(item.key)
        item.ancestors.forEach(key => matches.add(key))
      }
    })
    return flat.value.filter(item => matches.has(item.key))
  }
  return flat.value.filter(item => !item.ancestors.some(key => collapsed.value.has(key)))
})
const currentKey = computed(() => {
  const active = flat.value.find(item => item.slug === activeSlug.value)
  if (!active) return visible.value[0]?.key
  return visible.value.find(item => item.key === active.key)?.key
    || [...active.ancestors].reverse().find(key => visible.value.some(item => item.key === key))
    || visible.value[0]?.key
})
function toggle(item: OutlineRow) {
  const next = new Set(collapsed.value)
  if (next.has(item.key)) next.delete(item.key)
  else next.add(item.key)
  collapsed.value = next
}
function setRowRef(key: string, element: unknown) {
  if (element instanceof HTMLButtonElement) rowRefs.set(key, element)
  else rowRefs.delete(key)
}
function scrollTo(item: OutlineRow) {
  if (!item.slug) return
  activeSlug.value = item.slug
  document.getElementById(item.slug)?.scrollIntoView({
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    block: 'start',
  })
}
function updateActiveHeading() {
  scrollFrame = 0
  if (scrollHost) {
    const range = scrollHost.scrollHeight - scrollHost.clientHeight
    progress.value = range > 0 ? Math.round(Math.min(1, Math.max(0, scrollHost.scrollTop / range)) * 100) : 100
  }
  const headings = flat.value.filter(item => item.slug)
  const threshold = (scrollHost?.getBoundingClientRect().top ?? 0) + 56
  let current = headings[0]?.slug ?? null
  for (const item of headings) {
    const element = document.getElementById(item.slug!)
    if (!element) continue
    if (element.getBoundingClientRect().top <= threshold) current = item.slug!
    else break
  }
  activeSlug.value = current
}
function scheduleUpdate() {
  if (!scrollFrame) scrollFrame = requestAnimationFrame(updateActiveHeading)
}
function connectScrollHost() {
  scrollHost?.removeEventListener('scroll', scheduleUpdate)
  observer?.disconnect()
  scrollHost = document.querySelector<HTMLElement>('.muya-host')
  scrollHost?.addEventListener('scroll', scheduleUpdate, { passive: true })
  if (scrollHost) observer?.observe(scrollHost)
  const content = scrollHost?.querySelector('.muya-container')
  if (content) observer?.observe(content)
  scheduleUpdate()
}
function onRowKeydown(index: number, event: KeyboardEvent) {
  const item = visible.value[index]
  let target = index
  switch (event.key) {
    case 'ArrowDown': target = Math.min(index + 1, visible.value.length - 1); break
    case 'ArrowUp': target = Math.max(index - 1, 0); break
    case 'Home': target = 0; break
    case 'End': target = visible.value.length - 1; break
    case 'ArrowRight':
      if (!query.value && item.hasChildren && collapsed.value.has(item.key)) toggle(item)
      else target = Math.min(index + 1, visible.value.length - 1)
      break
    case 'ArrowLeft':
      if (!query.value && item.hasChildren && !collapsed.value.has(item.key)) toggle(item)
      else {
        const parent = visible.value.findIndex(row => row.key === item.ancestors.at(-1))
        if (parent >= 0) target = parent
      }
      break
    default: return
  }
  event.preventDefault()
  nextTick(() => rowRefs.get(visible.value[target]?.key)?.focus())
}
watch(() => editor.currentFileId, () => {
  query.value = ''
  collapsed.value = new Set()
  activeSlug.value = null
})
watch([flat, () => editor.sourceCodeMode], async () => {
  await nextTick()
  connectScrollHost()
}, { flush: 'post' })
watch(currentKey, async key => {
  await nextTick()
  const row = key ? rowRefs.get(key) : undefined
  const list = row?.closest('.toc-list')
  if (row && list) {
    const box = row.getBoundingClientRect()
    const viewport = list.getBoundingClientRect()
    if (box.top < viewport.top || box.bottom > viewport.bottom) row.scrollIntoView({ block: 'nearest' })
  }
})
onMounted(async () => {
  observer = new ResizeObserver(scheduleUpdate)
  await nextTick()
  connectScrollHost()
})
onBeforeUnmount(() => {
  scrollHost?.removeEventListener('scroll', scheduleUpdate)
  observer?.disconnect()
  if (scrollFrame) cancelAnimationFrame(scrollFrame)
})
</script>

<template>
  <section class="toc-pane" :aria-label="t('chrome.outline')">
    <header class="toc-header">
      <div class="toc-heading"><h2>{{ t('chrome.outline') }}</h2><span :aria-label="t('chrome.headings', { count: flat.length })">{{ flat.length }}</span></div>
      <button type="button" class="collapse-outline" :title="t('common.close')"
        :aria-label="t('common.close')" @click="layout.toggleInspector()">
<DArrowLeft />
</button>
    </header>
    <label class="toc-search">
      <Search aria-hidden="true" />
      <input v-model="query" type="search" :placeholder="t('chrome.searchHeadings')"
        :aria-label="t('chrome.searchHeadings')" @keydown.esc="query = ''">
    </label>
    <nav class="toc-list" :aria-label="t('chrome.outline')">
      <div v-for="(item, index) in visible" :key="item.key" class="toc-entry"
        :class="{ current: item.key === currentKey, root: item.depth === 0 }"
        :style="{ '--outline-depth': Math.min(item.depth, 5) }">
        <span v-if="item.depth" class="toc-guide" aria-hidden="true" />
        <button v-if="item.hasChildren && !query.trim()" type="button" class="toc-toggle"
          :aria-expanded="!collapsed.has(item.key)"
          :aria-label="t(collapsed.has(item.key) ? 'chrome.expandHeading' : 'chrome.collapseHeading', { heading: item.content })"
          @click="toggle(item)">
<ArrowRight :class="{ expanded: !collapsed.has(item.key) }" />
</button>
        <span v-else class="toc-toggle-placeholder" />
        <button :ref="element => setRowRef(item.key, element)" type="button" class="toc-row"
          :class="{ wrap: prefs.wordWrapInToc }" :title="item.content"
          :aria-label="'H' + item.level + ': ' + item.content"
          :aria-current="item.key === currentKey ? 'location' : undefined"
          :tabindex="item.key === currentKey ? 0 : -1" :disabled="editor.sourceCodeMode"
          @click="scrollTo(item)" @keydown="onRowKeydown(index, $event)">
          <span class="toc-level" aria-hidden="true">H{{ item.level }}</span>
          <span class="toc-label">{{ item.content }}</span>
        </button>
      </div>
      <p v-if="!visible.length" class="empty">{{ t(flat.length ? 'chrome.noMatches' : 'sideBar.noHeadings') }}</p>
    </nav>
    <footer v-if="flat.length && !editor.sourceCodeMode" class="toc-progress">
      <span>{{ t('chrome.progress') }}</span><strong>{{ progress }}%</strong>
      <progress :value="progress" max="100" :aria-label="t('chrome.progress')" />
    </footer>
  </section>
</template>

<style scoped>
.toc-pane { height: 100%; min-height: 0; display: flex; flex-direction: column; }
.toc-header { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px 0; gap: 8px; min-height: 30px; }
.toc-heading { display: flex; align-items: center; gap: 8px; padding-left: 4px; min-width: 0; }
.toc-header h2 { margin: 0; font-size: 13px; line-height: 1.4; font-weight: 600; color: var(--mt-fg); }
.toc-header span { font-size: 11px; color: var(--mt-fg-muted); }
.collapse-outline { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--mt-radius-control); background: transparent; color: var(--mt-fg-muted); cursor: pointer; flex-shrink: 0; }
.collapse-outline:hover { background: var(--mt-icon-hover-bg); color: var(--mt-fg); }
.collapse-outline svg { width: 16px; height: 16px; }
.toc-search { box-sizing: border-box; margin: 9px 10px 15px; min-height: 28px; display: flex; align-items: center; gap: 7px; padding: 0 8px; border: 1px solid var(--mt-border); border-radius: var(--mt-radius-tab); background: var(--mt-bg); color: var(--mt-fg-muted); }
.toc-search:focus-within { outline: 2px solid var(--mt-accent); outline-offset: 1px; }
.toc-search svg { width: 14px; height: 14px; flex-shrink: 0; }
.toc-search input { width: 100%; min-width: 0; padding: 0; background: none; border: none; outline: none; color: var(--mt-fg); font: inherit; font-size: 12px; }
.toc-search input::placeholder { color: var(--mt-fg-muted); opacity: .8; }
.toc-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 10px 16px; scrollbar-width: thin; scrollbar-color: var(--mt-border) transparent; }
.toc-entry { position: relative; display: flex; align-items: center; min-height: 31px; padding-inline: calc(4px + var(--outline-depth) * 12px) 7px; border-radius: var(--mt-radius-control); color: var(--mt-fg-muted); }
.toc-entry:hover { background: var(--mt-row-hover); }
.toc-entry.current { background: var(--mt-icon-active-bg); color: color-mix(in srgb, var(--mt-accent) 65%, var(--mt-fg)); }
.toc-entry.current::before { content: ''; position: absolute; inset: 8px auto 8px 0; width: 2px; border-radius: 1px; background: var(--mt-accent); }
.toc-guide { position: absolute; left: calc(4px + var(--outline-depth) * 12px); top: 0; bottom: 0; border-left: 1px solid var(--mt-border); pointer-events: none; }
.toc-guide::after { content: ''; position: absolute; left: 0; top: 15px; width: 5px; border-top: 1px solid var(--mt-border); }
.toc-toggle, .toc-toggle-placeholder { display: grid; place-items: center; width: 16px; height: 26px; padding: 0; flex: 0 0 16px; z-index: 1; }
.toc-toggle { border: 0; background: transparent; border-radius: 5px; color: inherit; cursor: pointer; }
.toc-toggle:hover { background: var(--mt-row-hover); }
.toc-toggle svg { width: 11px; height: 11px; transition: transform 120ms; }
.toc-toggle svg.expanded { transform: rotate(90deg); }
.toc-row { display: flex; align-items: center; gap: 6px; min-height: 31px; flex: 1; min-width: 0; border: 0; background: transparent; color: inherit; padding: 3px 0; text-align: start; font: inherit; font-size: 12px; line-height: 20px; cursor: pointer; }
.toc-row:disabled { cursor: default; opacity: .65; }
.toc-level { flex-shrink: 0; font: 10px/18px 'Cascadia Code', Consolas, monospace; color: var(--mt-fg-muted); }
.toc-label { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.root { margin: 0; color: var(--mt-fg); }
.root .toc-row { font-weight: 500; }
.toc-row.wrap { align-items: flex-start; }
.toc-row.wrap .toc-label { white-space: normal; overflow-wrap: anywhere; }
button:focus-visible { outline: 2px solid var(--mt-accent); outline-offset: -2px; border-radius: 5px; }
.empty { padding: 20px 10px; text-align: center; color: var(--mt-fg-muted); font-size: 12px; }
.toc-progress { display: flex; align-items: center; gap: 8px; padding: 10px 14px; color: var(--mt-fg-muted); font-size: 11px; }
.toc-progress strong { color: var(--mt-fg-muted); font-size: 11px; font-weight: 400; font-variant-numeric: tabular-nums; }
.toc-progress progress { flex: 1; min-width: 24px; width: 0; height: 5px; border: 0; border-radius: 8px; overflow: hidden; appearance: none; }
progress::-webkit-progress-bar { background: var(--mt-border); }
progress::-webkit-progress-value { background: var(--mt-accent); border-radius: 8px; }
progress::-moz-progress-bar { background: var(--mt-accent); border-radius: 8px; }
@media (prefers-reduced-motion: reduce) { .toc-toggle svg { transition: none; } }
</style>
