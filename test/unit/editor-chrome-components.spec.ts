import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

const toolbar = readSource('../../src/components/editorToolbar/EditorToolbar.vue')
const statusBar = readSource('../../src/components/statusBar/StatusBar.vue')
const tabsBar = readSource('../../src/components/editorWithTabs/TabsBar.vue')

describe('editor toolbar component contract', () => {
  it('routes every requested editor action through the existing bus/store APIs', () => {
    for (const action of [
      "bus.emit('undo', undefined)",
      "bus.emit('redo', undefined)",
      "bus.emit('paragraph', type)",
      "bus.emit('format', type)",
      "bus.emit('show-table-dialog', undefined)",
      "bus.emit('request-find-replace', { mode: 'find' })",
      'editor.toggleSourceCode()',
      'prefs.toggleViewMode(mode)',
    ]) {
      expect(toolbar).toContain(action)
    }

    for (const paragraphType of [
      'paragraph',
      'heading ${level}',
      'ul-bullet',
      'ol-order',
      'ul-task',
      'blockquote',
      'pre',
    ]) {
      expect(toolbar).toContain(paragraphType)
    }

    for (const formatType of ['strong', 'em', 'del', 'inline_code', 'link', 'image']) {
      expect(toolbar).toContain(formatType)
    }
  })

  it('exposes active inline/view state and accessible keyboard controls', () => {
    expect(toolbar).toContain('editor.currentSelectionFormats.includes(type)')
    expect(toolbar).toContain(':aria-pressed="formatActive(action.type)"')
    expect(toolbar).toContain('role="toolbar"')
    expect(toolbar).toContain('aria-orientation="horizontal"')
    expect(toolbar).toContain('@mousedown.prevent')
    expect(toolbar).toMatch(/\.tool-button:focus-visible\s*\{/)
  })

  it('keeps history available in source mode while WYSIWYG actions stay disabled', () => {
    expect(toolbar).toContain('const documentDisabled = computed(() => !hasDocument.value)')
    expect(toolbar).toContain('const wysiwygDisabled = computed(() => documentDisabled.value || editor.sourceCodeMode)')
    expect(toolbar).toContain('if (!documentDisabled.value) bus.emit(\'undo\', undefined)')
    expect(toolbar).toContain('if (!documentDisabled.value) bus.emit(\'redo\', undefined)')
    expect(toolbar).toContain('if (!wysiwygDisabled.value) bus.emit(\'paragraph\', type)')
    expect(toolbar).toContain('if (!wysiwygDisabled.value) bus.emit(\'format\', type)')
    expect(toolbar).not.toContain('Ctrl+Shift+Z')
  })

  it('keeps all controls reachable at narrow widths with horizontal overflow', () => {
    expect(toolbar).toMatch(/\.toolbar-scroll\s*\{[\s\S]*?overflow-x:\s*auto;/)
    expect(toolbar).toMatch(/\.toolbar-content\s*\{[\s\S]*?width:\s*max-content;/)
  })
})

describe('status bar component contract', () => {
  it('shows the current document format, statistics, save state, and modes', () => {
    for (const source of [
      'file.value?.encoding',
      'encoding.isBom',
      'file.value?.lineEnding',
      'file.value?.wordCount',
      'file.value.isSaved',
      'prefs.autoSave',
      'editor.sourceCodeMode',
      'prefs.focus',
      'prefs.typewriter',
    ]) {
      expect(statusBar).toContain(source)
    }

    for (const marker of [
      'data-status="encoding"',
      'data-status="line-ending"',
      'data-status="words"',
      'data-status="characters"',
      'data-status="paragraphs"',
      'data-status="save-state"',
      'data-status="auto-save"',
      'data-status="editor-mode"',
    ]) {
      expect(statusBar).toContain(marker)
    }
  })

  it('is a read-only, responsive status surface', () => {
    expect(statusBar).not.toMatch(/<(?:button|input|select)\b/)
    expect(statusBar).toContain(':aria-label="copy.statusBar"')
    expect(statusBar).toMatch(/\.status-bar\s*\{[\s\S]*?overflow-x:\s*auto;/)
  })
})

describe('tab bar component contract', () => {
  it('stops ordered bulk close at the first cancelled tab and preserves close-others target', () => {
    expect(tabsBar).toMatch(/async function closeTabsInOrder\(ids: string\[\]\): Promise<boolean> \{[\s\S]*?for \(const tabId of ids\)[\s\S]*?if \(!await editor\.closeTab\(tabId\)\) return false[\s\S]*?return true/)
    expect(tabsBar).toContain('tabIds.value.filter(tabId => tabId !== id)')
    expect(tabsBar).toContain('closeTabsInOrder(tabIds.value)')
  })
})
