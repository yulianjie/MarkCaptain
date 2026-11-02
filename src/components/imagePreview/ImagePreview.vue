<script setup lang="ts">
/**
 * Full-screen image preview modal.
 *
 * Opened by MuyaEditor's `format-click` handler when the user Ctrl/Cmd-clicks
 * an image inside the editor (mirrors the upstream "image viewer" behaviour).
 * Mounted once at the EditorPage level and listens on the `image-preview/open`
 * bus channel — so any future caller (e.g. a sidebar thumbnail) can reuse it.
 *
 * ESC or click on the backdrop closes the modal.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { X } from '@lucide/vue'
import { bus } from '@/bus'
import { useI18n } from '@/i18n'

const { t } = useI18n()

const visible = ref(false)
const src = ref('')
const alt = ref('')

let off: (() => void) | null = null

function open(payload: { src: string; alt?: string }) {
  src.value = payload.src
  alt.value = payload.alt ?? ''
  visible.value = true
}

function close() {
  visible.value = false
  src.value = ''
  alt.value = ''
}

function onKey(ev: KeyboardEvent) {
  if (!visible.value) return
  if (ev.key === 'Escape') {
    ev.preventDefault()
    close()
  }
}

onMounted(() => {
  off = bus.on('image-preview/open', open)
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  off?.()
  off = null
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="mt-image-preview-backdrop"
      role="dialog"
      aria-modal="true"
      @click.self="close"
    >
      <img class="mt-image-preview-img" :src="src" :alt="alt" @click.stop />
      <button class="mt-image-preview-close" type="button" :aria-label="t('common.close')" @click="close">
        <X :size="20" aria-hidden="true" />
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.mt-image-preview-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(13, 19, 15, 0.88);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9000;
  cursor: zoom-out;
}
.mt-image-preview-img {
  max-width: 92vw;
  max-height: 92vh;
  object-fit: contain;
  border-radius: 7px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  cursor: default;
}
.mt-image-preview-close {
  position: absolute;
  top: 16px;
  right: 24px;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border-radius: 9px;
  border: 1px solid var(--mt-border);
  background: var(--mt-surface-raised);
  color: var(--mt-fg);
  cursor: pointer;
}
.mt-image-preview-close:hover {
  background: var(--mt-accent-soft);
  color: var(--mt-accent);
}
.mt-image-preview-close:focus-visible { outline: 2px solid var(--mt-accent); outline-offset: 3px; }
@media (max-width: 600px) { .mt-image-preview-close { top: 12px; right: 12px; } }
</style>
