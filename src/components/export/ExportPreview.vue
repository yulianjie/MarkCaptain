<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { FileText, LoaderCircle, RefreshCw } from '@lucide/vue'

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
let removePreviewInteractions: (() => void) | undefined

watch(() => props.html, () => {
  generation += 1
  removePreviewInteractions?.()
  removePreviewInteractions = undefined
  loading.value = Boolean(props.html)
}, { immediate: true })

function installPreviewInteractions(document: Document) {
  removePreviewInteractions?.()
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
  const suppressContextMenu = (event: MouseEvent) => event.preventDefault()
  document.addEventListener('click', navigate, true)
  document.addEventListener('auxclick', navigate, true)
  document.addEventListener('contextmenu', suppressContextMenu)
  removePreviewInteractions = () => {
    document.removeEventListener('click', navigate, true)
    document.removeEventListener('auxclick', navigate, true)
    document.removeEventListener('contextmenu', suppressContextMenu)
  }
}

onBeforeUnmount(() => removePreviewInteractions?.())

async function onLoad() {
  const requestGeneration = generation
  const document = frame.value?.contentDocument
  if (!document) {
    loading.value = false
    emit('failed', props.failedMessage)
    return
  }
  installPreviewInteractions(document)
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
    <div v-if="loading" class="preview-state" role="status"><LoaderCircle :size="24" class="loading-icon" aria-hidden="true" /><span>{{ loadingMessage }}</span></div>
    <div v-if="!html" class="preview-state"><FileText :size="34" aria-hidden="true" /><span>{{ emptyMessage }}</span></div>
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
    <div v-if="stale" class="preview-stale" role="status"><RefreshCw :size="14" aria-hidden="true" /><span>{{ staleMessage }}</span></div>
  </div>
</template>

<style scoped>
.preview-shell {
  position: relative;
  height: min(70vh, 760px);
  min-height: 300px;
  overflow: hidden;
  border: 1px solid var(--mt-border);
  border-radius: 8px;
  background: var(--mt-bg);
  box-shadow: 0 3px 18px color-mix(in srgb, var(--mt-fg) 4%, transparent);
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
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 15px;
  width: 100%;
  height: 100%;
  color: var(--mt-fg-muted);
  font-size: 13px;
  text-align: center;
  background: var(--mt-bg);
}
.preview-state span { max-width: 280px; padding: 0 20px; line-height: 1.7; }
.preview-state > svg { color: var(--mt-accent); opacity: .6; stroke-width: 1.3; }
.loading-icon { animation: preview-spin 1.2s linear infinite; }

.preview-stale {
  position: absolute;
  right: 12px;
  bottom: 12px;
  left: 12px;
  padding: 9px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid color-mix(in srgb, var(--mt-warning) 35%, var(--mt-border));
  border-radius: 4px;
  background: var(--mt-warning-soft);
  color: var(--mt-warning);
  font-size: 12px;
  line-height: 1.6;
}
.preview-stale > svg { flex-shrink: 0; }
@keyframes preview-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .loading-icon { animation: none; } }
</style>
