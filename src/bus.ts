/**
 * Tiny typed event bus — replaces the Vue 2 `$bus` (`new Vue()` instance) used
 * throughout markcaptain's renderer.
 *
 * Vue 3 dropped `$on`/`$off`/`$emit`. We keep the same call sites but route
 * everything through a single mitt-style emitter. Channel names follow the
 * legacy `area::action` convention so we don't have to rewrite every call
 * site at once.
 *
 * Use sparingly. Prefer Pinia state / actions when state belongs to a store.
 * The bus is for transient UI signals (show this dialog, focus that thing).
 */

export type Handler<T = unknown> = (payload: T) => void

/**
 * Add new channels here as components are migrated. Loose `unknown` payloads
 * are intentional — components will narrow at the call site for now.
 */
export interface BusEventMap {
  // Editor
  'file-loaded': { id: string; markdown: string; cursor?: unknown }
  'file-changed': { id: string; markdown?: string }
  'editor-blur': void
  'editor-focus': void
  'screenshot-captured': { url: string }
  'invalidate-image-cache': void
  'insert-image': { src: string; alt?: string; title?: string }

  // Paragraph manipulation (mirrors upstream markcaptain bus events)
  'duplicate': void
  'createParagraph': void
  'deleteParagraph': void
  'insertParagraph': { location: 'before' | 'after'; text?: string; outMost?: boolean }

  // Image preview modal (opened by Ctrl/Cmd-click on an image in Muya)
  'image-preview/open': { src: string; alt?: string }

  // Search / find
  'find': { value: string; opt: SearchOpt }
  'replace': { value: string; opt: SearchOpt }
  'findNext': void
  'findPrev': void
  'find-action': string
  'searchValue': string
  'replaceValue': string
  'findInFolder': void
  'reveal-search-hit': import('./services/search-reveal').SearchRevealRequest
  /**
   * A transient request owned by FindReplaceBar. Unlike `findReplaceOpen`, it
   * is delivered even when the bar is already visible so repeated shortcuts
   * can restore focus.
   */
  'request-find-replace': { mode: 'find' | 'replace' }

  // Tabs
  'TABS::close-this': string
  'TABS::close-others': string
  'TABS::close-saved': void
  'TABS::close-all': void
  'TABS::rename': string
  'TABS::copy-path': string
  'TABS::show-in-folder': string

  // Sidebar
  'SIDEBAR::show-rename-input': string
  'SIDEBAR::show-new-input': { dirname: string; type: 'file' | 'directory' }
  'SIDEBAR::new': void
  'SIDEBAR::remove': void
  'SIDEBAR::copy-cut': { type: 'copy' | 'cut' }
  'SIDEBAR::paste': void
  'SIDEBAR::rename': void
  'SIDEBAR::show-in-folder': void

  // Dialogs
  'show-command-palette': void
  'show-recent': void
  'aboutDialog': void
  'tweetDialog': void
  'rename': void
  'show-table-dialog': void
  'insert-table': { rows: number; columns: number }
  'show-export-dialog': void
  'show-updater-dialog': void

  // Format / paragraph (editor toolbar)
  'paragraph': string
  'format': string

  // Plain edit actions that route into Muya
  'undo': void
  'redo': void
  'selectAll': void
  'copyAsMarkdown': void
  'copyAsHtml': void
  'pasteAsPlainText': void

  // Commands
  'cmd::sort-commands': void
  'cmd::register-command': unknown
  'cmd::execute': string

  // TOC scroll
  'scroll-to-header': string

  // Context menu (one global handler in ContextMenu.vue subscribes here)
  'openContextMenu': {
    x: number
    y: number
    items: import('./components/contextMenu/ContextMenu.vue').ContextMenuItem[]
    /** Called once when this menu session is dismissed or superseded. */
    onClose?: () => void
  }
}

export interface SearchOpt {
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
}

class Bus {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private map = new Map<keyof BusEventMap, Set<Handler<any>>>()

  on<K extends keyof BusEventMap>(event: K, handler: Handler<BusEventMap[K]>): () => void {
    const set = this.map.get(event) ?? new Set()
    set.add(handler as Handler<unknown>)
    this.map.set(event, set)
    return () => this.off(event, handler)
  }

  off<K extends keyof BusEventMap>(event: K, handler: Handler<BusEventMap[K]>) {
    this.map.get(event)?.delete(handler as Handler<unknown>)
  }

  emit<K extends keyof BusEventMap>(event: K, payload: BusEventMap[K]): void {
    const handlers = this.map.get(event)
    if (!handlers) return
    for (const fn of handlers) {
      try { fn(payload) } catch (err) { console.error(`[bus:${String(event)}]`, err) }
    }
  }
}

export const bus = new Bus()
