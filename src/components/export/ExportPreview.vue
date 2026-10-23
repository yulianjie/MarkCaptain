<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{
  html: string
  stale?: boolean
  title: string
  loadingMessage: string
  emptyMessage: string
  staleMessage: string
  failedMessage: string
  timeoutMessage: string
}>()
const emit = defineEmits<{ ready: []; failed: [message: string]; printClosed: [] }>()
const frame = ref<HTMLIFrameElement | null>(null)
const loading = ref(false)
let generation = 0
let removeNavigation: (() => void) | undefined

watch(() => props.html, () => {
  generation += 1
  removeNavigation?.()
  removeNavigation = undefined
  loading.value = Boolean(props.html)
}, { immediate: true })

function keepPreviewNavigation(document: Document) {
  removeNavigation?.()
  const navigate = (event: MouseEvent) => {
    // Nodes belong to the iframe's realm, so instanceof Element in the parent
    // would miss them. Only follow fragments inside this frozen document.
    const node = event.target as Node | null
    const element = node?.nodeType === 1 ? node as Element : node?.parentElement
    const anchor = element?.closest('a')
    if (!anchor) return
    const href = anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href')
    if (href === null) return
    event.preventDefault()
    if (!href.startsWith('#')) return
    let fragment = href.slice(1)
    try { fragment = decodeURIComponent(fragment) } catch { /* retain a literal fragment */ }
    if (!fragment) { document.defaultView?.scrollTo(0, 0); return }
    const target = document.getElementById(fragment)
    target?.scrollIntoView({ block: 'start' })
  }
  document.addEventListener('click', navigate, true)
  document.addEventListener('auxclick', navigate, true)
  removeNavigation = () => {
    document.removeEventListener('click', navigate, true)
    document.removeEventListener('auxclick', navigate, true)
  }
}

onBeforeUnmount(() => removeNavigation?.())

async function onLoad() {
  const requestGeneration = generation
  const document = frame.value?.contentDocument
  if (!document) {
    loading.value = false
    emit('failed', props.failedMessage)
    return
  }
  keepPreviewNavigation(document)
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all([
        document.fonts?.ready,
        Promise.all(Array.from(document.images, image => image.decode().catch(() => undefined))),
      ]),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(props.timeoutMessage)), 15_000)
      }),
    ])
    if (requestGeneration !== generation) return
    frame.value?.contentWindow?.addEventListener('afterprint', () => emit('printClosed'), { once: true })
    loading.value = false
    emit('ready')
  } catch (error) {
    if (requestGeneration !== generation) return
    loading.value = false
    emit('failed', error instanceof Error ? error.message : String(error))
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function print(): boolean {
  const contentWindow = frame.value?.contentWindow
  if (!contentWindow) return false
  contentWindow.focus()
  contentWindow.print()
  return true
}

defineExpose({ print })
</script>

<template>
  <div class="preview-shell" :class="{ 'is-stale': stale }">
    <div v-if="loading" class="preview-state" role="status">{{ loadingMessage }}</div>
    <div v-if="!html" class="preview-state">{{ emptyMessage }}</div>
    <iframe
      v-if="html"
      ref="frame"
      class="preview-frame"
      :title="title"
      :srcdoc="html"
      sandbox="allow-same-origin allow-modals"
      referrerpolicy="no-referrer"
      @load="onLoad"
    />
    <div v-if="stale" class="preview-stale" role="status">{{ staleMessage }}</div>
  </div>
</template>

<style scoped>
.preview-shell {
  position: relative;
  height: min(70vh, 760px);
  min-height: 360px;
  overflow: hidden;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: #eef0f2;
}

.preview-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #fff;
}

.preview-state {
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

.preview-stale {
  position: absolute;
  right: 12px;
  bottom: 12px;
  left: 12px;
  padding: 9px 12px;
  border: 1px solid var(--el-color-warning-light-5);
  border-radius: 4px;
  background: var(--el-color-warning-light-9);
  color: var(--el-color-warning-dark-2);
  font-size: 12px;
}
</style>
