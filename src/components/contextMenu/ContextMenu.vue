<script setup lang="ts">
/**
 * Context menu — single global popover routed via the `bus.openContextMenu`
 * event. Components call it with a screen position + a list of items.
 *
 * Each item has a label (or `divider: true`) and an `action()` callback that
 * fires when clicked. We also handle Esc / outside-click / scroll to close.
 *
 * Why one global menu instead of per-component menus: keeps z-index logic
 * and focus management in one place, and lets us reuse the same menu for
 * tab/tree/editor right-clicks without dragging Element Plus's popover
 * around.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { bus } from '@/bus'

export interface ContextMenuItem {
  label?: string
  divider?: boolean
  disabled?: boolean
  shortcut?: string
  action?: () => void | Promise<void>
}

const visible = ref(false)
const x = ref(0)
const y = ref(0)
const items = ref<ContextMenuItem[]>([])
let closeCallback: (() => void) | undefined

function open(payload: {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose?: () => void
}) {
  // Programmatic replacement does not pass through the window-level outside
  // handler. Tell the superseded owner so pending async work cannot reopen it.
  if (visible.value && closeCallback && closeCallback !== payload.onClose) {
    closeCallback()
  }
  closeCallback = payload.onClose
  items.value = payload.items
  x.value = payload.x
  y.value = payload.y
  visible.value = true
  // Adjust after render so we don't overflow the viewport.
  void nextTick(() => clampToViewport())
}

function close() {
  if (!visible.value) return
  const callback = closeCallback
  closeCallback = undefined
  visible.value = false
  items.value = []
  callback?.()
}

function clampToViewport() {
  const el = menuRef.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const padding = 4
  if (r.right > window.innerWidth) {
    x.value = Math.max(padding, window.innerWidth - r.width - padding)
  }
  if (r.bottom > window.innerHeight) {
    y.value = Math.max(padding, window.innerHeight - r.height - padding)
  }
}

const menuRef = ref<HTMLDivElement | null>(null)

const style = computed(() => ({
  top: `${y.value}px`,
  left: `${x.value}px`,
}))

async function pick(item: ContextMenuItem) {
  if (item.disabled || !item.action) return
  close()
  try { await item.action() } catch (err) { console.warn('[context-menu] action failed', err) }
}

function onOutside(ev: MouseEvent) {
  if (!visible.value) return
  const el = menuRef.value
  if (el && ev.target instanceof Node && el.contains(ev.target)) return
  close()
}

function onKey(ev: KeyboardEvent) {
  if (visible.value && ev.key === 'Escape') {
    ev.preventDefault()
    close()
  }
}

let unsub: (() => void) | null = null
onMounted(() => {
  unsub = bus.on('openContextMenu', open)
  window.addEventListener('mousedown', onOutside, true)
  window.addEventListener('contextmenu', onOutside, true)
  window.addEventListener('scroll', close, true)
  window.addEventListener('keydown', onKey)
  window.addEventListener('blur', close)
})

onBeforeUnmount(() => {
  close()
  unsub?.()
  window.removeEventListener('mousedown', onOutside, true)
  window.removeEventListener('contextmenu', onOutside, true)
  window.removeEventListener('scroll', close, true)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('blur', close)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="menuRef"
      class="mt-context-menu"
      :style="style"
      role="menu"
    >
      <template v-for="(item, idx) in items" :key="idx">
        <div v-if="item.divider" class="divider" />
        <button
          v-else
          class="item"
          :class="{ disabled: item.disabled }"
          type="button"
          role="menuitem"
          :disabled="item.disabled"
          @click="pick(item)"
        >
          <span class="label">{{ item.label }}</span>
          <span v-if="item.shortcut" class="shortcut">{{ item.shortcut }}</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.mt-context-menu {
  position: fixed;
  z-index: 5000;
  min-width: min(220px, calc(100vw - 12px));
  max-width: min(340px, calc(100vw - 12px));
  max-height: calc(100vh - 12px);
  overflow-y: auto;
  box-sizing: border-box;
  padding: 5px;
  background: var(--mt-surface-raised, #fdfcf9);
  color: var(--mt-fg, #252923);
  border: 1px solid var(--mt-border, #deded5);
  border-radius: 10px;
  box-shadow: var(--mt-shadow-panel, 0 8px 30px rgba(30, 40, 30, .12));
  font-family: var(--mt-ui-font, inherit);
  font-size: 12px;
  user-select: none;
}
.item {
  display: flex;
  align-items: center;
  width: 100%;
  background: transparent;
  border: 0;
  min-height: 33px;
  padding: 7px 10px;
  border-radius: 5px;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.item:hover:not(.disabled), .item:focus-visible {
  background: var(--mt-accent-soft, #e5ece3);
  color: var(--mt-accent, #3e6250);
}
.item:focus-visible { outline: 2px solid var(--mt-accent); outline-offset: -2px; }
.item.disabled {
  color: var(--mt-fg-muted, #74796e);
  opacity: .5;
  cursor: not-allowed;
}
.label { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.shortcut {
  margin-left: 16px;
  color: var(--mt-fg-muted, #74796e);
  font-size: 10px;
  font-family: ui-monospace, monospace;
}
.divider {
  height: 1px;
  background: var(--mt-border, #deded5);
  margin: 5px 5px;
}
</style>
