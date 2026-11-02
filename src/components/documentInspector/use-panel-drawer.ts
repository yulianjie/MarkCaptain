import { nextTick, onBeforeUnmount, watch, type Ref } from 'vue'

const openDrawers: symbol[] = []

/** Keyboard containment applies only while a navigation panel overlays the document. */
export function usePanelDrawer(options: {
  active: Readonly<Ref<boolean>>
  element: Ref<HTMLElement | null>
  close: () => void
  fallback: (previousFocus: HTMLElement | null) => HTMLElement | null
}) {
  const id = Symbol('panel drawer')
  let previousFocus: HTMLElement | null = null
  let openedPanel: HTMLElement | null = null
  let listening = false
  let explicitClose = false

  function requestClose() {
    explicitClose = listening
    options.close()
  }

  function focusable() {
    return Array.from(options.element.value?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []).filter(element => element.tabIndex >= 0 && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && !element.closest('[inert]'))
  }
  function onKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || openDrawers.at(-1) !== id) return
    // Element Plus prompts and menus own their keyboard loop while opened
    // from a drawer (for example New File or a document context menu).
    const target = event.target
    if (target instanceof Element && !options.element.value?.contains(target)
      && target.closest('[role="dialog"], [role="alertdialog"], [role="menu"], .el-popper')) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      requestClose()
      return
    }
    if (event.key !== 'Tab') return
    const elements = focusable()
    const first = elements[0]
    const last = elements.at(-1)
    if (!first || !last) {
      event.preventDefault()
      options.element.value?.focus()
      return
    }
    const active = document.activeElement
    if (!options.element.value?.contains(active) || (event.shiftKey ? active === first : active === last)) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    }
  }
  function onCaptureKeydown(event: KeyboardEvent) {
    if (event.key === 'Tab') onKeydown(event)
  }
  function onBubbleKeydown(event: KeyboardEvent) {
    // Child trays, searches and menus consume Escape before the outer panel.
    if (event.key === 'Escape') onKeydown(event)
  }
  function release(restoreFocus: boolean) {
    if (!listening) return
    document.removeEventListener('keydown', onCaptureKeydown, true)
    document.removeEventListener('keydown', onBubbleKeydown)
    listening = false
    const index = openDrawers.indexOf(id)
    if (index >= 0) openDrawers.splice(index, 1)
    const mustRestoreFocus = explicitClose
    explicitClose = false
    if (restoreFocus) void nextTick(() => {
      // A command such as Find may already have focused its own input.
      const active = document.activeElement
      // Leaving the narrow breakpoint keeps the same panel visible; retain
      // its focused control while dropping only the drawer keyboard loop.
      if (!mustRestoreFocus && openedPanel?.isConnected && options.element.value === openedPanel && openedPanel.getClientRects().length) return
      if (openDrawers.length || (!mustRestoreFocus && active instanceof HTMLElement && active !== document.body && active.isConnected && !openedPanel?.contains(active))) return
      const target = previousFocus?.isConnected && previousFocus !== document.body ? previousFocus : options.fallback(previousFocus)
      target?.focus()
    })
  }
  watch(options.active, async active => {
    if (!active) { release(true); return }
    release(false)
    // Capture before Vue destroys a v-if rail trigger. A post-render watch
    // observes body instead, which is connected but cannot restore focus.
    previousFocus = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement : null
    openDrawers.push(id)
    listening = true
    document.addEventListener('keydown', onCaptureKeydown, true)
    document.addEventListener('keydown', onBubbleKeydown)
    await nextTick()
    if (!options.active.value) return
    openedPanel = options.element.value
    ;(focusable()[0] ?? openedPanel)?.focus()
  }, { immediate: true, flush: 'sync' })
  onBeforeUnmount(() => release(true))
  return requestClose
}
