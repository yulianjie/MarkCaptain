import type { ContextMenuItem } from '@/components/contextMenu/ContextMenu.vue'

export interface ContextTextBlock {
  text?: string
  functionType?: string
  lang?: unknown
}

export interface ContextSelectionPoint {
  key?: string
  offset?: number
  block?: ContextTextBlock
}

export interface ContextSelection {
  start?: ContextSelectionPoint
  end?: ContextSelectionPoint
  affiliation?: Array<{ type?: string }>
}

export interface ContextWord {
  word: string
  left: number
  right: number
}

export interface EditorContextMenuLabels {
  undo: string
  redo: string
  cut: string
  copy: string
  paste: string
  selectAll: string
  checkingSpelling: string
  noSuggestions: string
  addToDictionary: string
}

export interface EditorContextMenuCapabilities {
  undo: boolean
  redo: boolean
  cut: boolean
  copy: boolean
  paste: boolean
  selectAll: boolean
}

export interface EditorContextMenuActions {
  undo: () => void | Promise<void>
  redo: () => void | Promise<void>
  cut: () => void | Promise<void>
  copy: () => void | Promise<void>
  paste: () => void | Promise<void>
  selectAll: () => void | Promise<void>
  replaceWord: (replacement: string) => void | Promise<void>
  addToDictionary: () => void | Promise<void>
}

export interface EditorContextSpellingState {
  word: string
  checking?: boolean
  misspelled?: boolean
  suggestions?: string[]
}

export interface EditorContextMenuOptions {
  labels: EditorContextMenuLabels
  capabilities: EditorContextMenuCapabilities
  actions: EditorContextMenuActions
  spelling?: EditorContextSpellingState
  shortcuts?: Partial<Record<keyof EditorContextMenuCapabilities, string>>
}

// Keep these separators aligned with Muya's markcaptain/spellchecker helper so
// the word offered by our menu is accepted by `_replaceCurrentWordInlineUnsafe`.
/* eslint-disable no-useless-escape */
const WORD_DEFINITION = /(?:-?\d*\.\d\w*)|(?:[^`~!@#$%^&*()\-=+[\{\]}\\|;:'",\.<>/?\s]+)/g
/* eslint-enable no-useless-escape */

function wordAtOffset(text: string, offset: number): ContextWord | null {
  if (!text) return null
  const normalizedOffset = Math.min(Math.max(offset, 0), text.length - 1)
  WORD_DEFINITION.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = WORD_DEFINITION.exec(text))) {
    const left = match.index
    const right = left + match[0].length
    if (left <= normalizedOffset && right > normalizedOffset) {
      WORD_DEFINITION.lastIndex = 0
      return { left, right, word: match[0] }
    }
    if (left > normalizedOffset) break
  }
  WORD_DEFINITION.lastIndex = 0
  return null
}

/**
 * Return exactly one selectable word at the right-click cursor. A collapsed
 * cursor is accepted because WebView engines differ on whether right-clicking
 * automatically selects a misspelling before `contextmenu` fires.
 */
export function extractContextWord(selection: ContextSelection): ContextWord | null {
  const { start, end } = selection
  if (!start || !end || !start.key || start.key !== end.key) return null
  if (typeof start.offset !== 'number' || typeof end.offset !== 'number') return null

  const block = start.block
  const text = block?.text
  if (typeof text !== 'string') return null
  if (block?.functionType === 'codeContent' && block.lang !== undefined) return null
  if (selection.affiliation?.length === 1 && selection.affiliation[0]?.type === 'pre') return null

  const found = wordAtOffset(text, start.offset)
  if (!found || !/\p{L}/u.test(found.word)) return null

  const collapsed = start.offset === end.offset
  if (!collapsed && (start.offset !== found.left || end.offset !== found.right)) return null
  return found
}

export function normalizeSpellingSuggestions(
  word: string,
  suggestions: string[],
  max = 8,
): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const suggestion of suggestions) {
    const candidate = suggestion.trim()
    if (!candidate || candidate === word || seen.has(candidate)) continue
    seen.add(candidate)
    normalized.push(candidate)
    if (normalized.length >= max) break
  }
  return normalized
}

export function buildEditorContextMenuItems(options: EditorContextMenuOptions): ContextMenuItem[] {
  const { labels, capabilities, actions, spelling, shortcuts = {} } = options
  const items: ContextMenuItem[] = []

  if (spelling?.checking) {
    items.push({ label: labels.checkingSpelling, disabled: true }, { divider: true })
  } else if (spelling?.misspelled) {
    const suggestions = spelling.suggestions ?? []
    if (suggestions.length) {
      items.push(...suggestions.map(replacement => ({
        label: replacement,
        action: () => actions.replaceWord(replacement),
      })))
    } else {
      items.push({ label: labels.noSuggestions, disabled: true })
    }
    items.push({ label: labels.addToDictionary, action: actions.addToDictionary })
    items.push({ divider: true })
  }

  items.push(
    { label: labels.undo, shortcut: shortcuts.undo, disabled: !capabilities.undo, action: actions.undo },
    { label: labels.redo, shortcut: shortcuts.redo, disabled: !capabilities.redo, action: actions.redo },
    { divider: true },
    { label: labels.cut, shortcut: shortcuts.cut, disabled: !capabilities.cut, action: actions.cut },
    { label: labels.copy, shortcut: shortcuts.copy, disabled: !capabilities.copy, action: actions.copy },
    { label: labels.paste, shortcut: shortcuts.paste, disabled: !capabilities.paste, action: actions.paste },
    { divider: true },
    {
      label: labels.selectAll,
      shortcut: shortcuts.selectAll,
      disabled: !capabilities.selectAll,
      action: actions.selectAll,
    },
  )
  return items
}

/** Monotonic token gate used to discard stale async spelling responses. */
export class LatestContextMenuRequest {
  private revision = 0

  begin(): number {
    this.revision += 1
    return this.revision
  }

  isCurrent(token: number): boolean {
    return token === this.revision
  }

  invalidate(token?: number): void {
    if (token === undefined || token === this.revision) this.revision += 1
  }
}
