import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  FORMAT_MENU_COMMANDS,
  PARAGRAPH_MENU_COMMANDS,
  resolveEditorMenuCommand,
} from '../../src/services/editor-menu-actions'

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

const editorPage = readSource('../../src/pages/EditorPage.vue')
const nativeMenu = readSource('../../src-tauri/src/menu/mod.rs')
const muyaEditor = readSource('../../src/components/editorWithTabs/MuyaEditor.vue')
const sourceEditor = readSource('../../src/components/editorWithTabs/SourceCodePane.vue')

describe('editor page chrome integration', () => {
  it('mounts preference-controlled toolbar/status chrome around the editor stage', () => {
    expect(editorPage).toMatch(
      /<TabsBar[^>]*\/>[\s\S]*?<EditorToolbar v-if="layout\.showToolBar && editor\.currentFile && !welcomeVisible" \/>\s*<div class="editor-stage">[\s\S]*?<StatusBar v-if="layout\.showStatusBar" \/>/,
    )
  })

  it('lets the editor stage shrink without allowing chrome to cover it', () => {
    expect(editorPage).toMatch(/\.page-body\s*\{[\s\S]*?min-height:\s*0;/)
    expect(editorPage).toMatch(/\.editor-column\s*\{[\s\S]*?min-height:\s*0;/)
    expect(editorPage).toMatch(/\.editor-stage\s*\{[\s\S]*?flex:\s*1;[\s\S]*?min-height:\s*0;/)
  })
})

describe('native menu to Muya command mapping', () => {
  it('leaves focus-sensitive editor shortcuts to the renderer', () => {
    expect(nativeMenu).toContain('&mi(app, "edit.undo", s.undo, None)?')
    expect(nativeMenu).toContain('&mi(app, "edit.redo", s.redo, None)?')
    expect(nativeMenu).toContain('&mi(app, "edit.selectAll", s.select_all, None)?')
    expect(nativeMenu).toContain('&mi(app, "paragraph.h1", s.heading_1, None)?')
    expect(nativeMenu).toContain('&mi(app, "format.link", s.hyperlink, None)?')
    expect(editorPage).toContain('isEditorShortcutTarget(ev.target)')
    expect(editorPage).toContain("executeMenuAction(fixedAction, 'shortcut')")
    expect(editorPage).toContain("routeMenuAction(spec.id, 'palette')")
    expect(muyaEditor).toContain('data-editor-shortcut-scope="true"')
    expect(sourceEditor).toContain('data-editor-shortcut-scope="true"')
  })

  it('keeps native Edit menu clicks scoped to a focused non-editor input', () => {
    expect(editorPage).toContain("source === 'menu'")
    expect(editorPage).toContain('isTextEditingTarget(active)')
    expect(editorPage).toContain('!isEditorShortcutTarget(active)')
    expect(editorPage).toContain('executeFocusedNativeEdit(action)')
  })

  it('covers the complete paragraph and format action set emitted by the native menu', () => {
    const nativeEditorActions = [...nativeMenu.matchAll(/"((?:paragraph|format)\.[A-Za-z0-9]+)"/g)]
      .map(match => match[1])
    const mappedEditorActions = [
      ...Object.keys(PARAGRAPH_MENU_COMMANDS),
      'paragraph.table',
      ...Object.keys(FORMAT_MENU_COMMANDS),
    ]

    expect([...new Set(nativeEditorActions)].sort()).toEqual(mappedEditorActions.sort())
  })

  it('maps every native paragraph action to its Muya block type', () => {
    expect(PARAGRAPH_MENU_COMMANDS).toEqual({
      'paragraph.h1': 'heading 1',
      'paragraph.h2': 'heading 2',
      'paragraph.h3': 'heading 3',
      'paragraph.h4': 'heading 4',
      'paragraph.h5': 'heading 5',
      'paragraph.h6': 'heading 6',
      'paragraph.paragraph': 'paragraph',
      'paragraph.blockquote': 'blockquote',
      'paragraph.unorderedList': 'ul-bullet',
      'paragraph.orderedList': 'ol-order',
      'paragraph.taskList': 'ul-task',
      'paragraph.codeBlock': 'pre',
      'paragraph.horizontalRule': 'hr',
    })

    for (const [id, value] of Object.entries(PARAGRAPH_MENU_COMMANDS)) {
      expect(resolveEditorMenuCommand(id)).toEqual({ kind: 'paragraph', value })
    }
    expect(resolveEditorMenuCommand('paragraph.table')).toEqual({ kind: 'table' })
  })

  it('maps every native format action to its Muya mark type', () => {
    expect(FORMAT_MENU_COMMANDS).toEqual({
      'format.bold': 'strong',
      'format.italic': 'em',
      'format.strikethrough': 'del',
      'format.inlineCode': 'inline_code',
      'format.link': 'link',
      'format.image': 'image',
      'format.clear': 'clear',
    })

    for (const [id, value] of Object.entries(FORMAT_MENU_COMMANDS)) {
      expect(resolveEditorMenuCommand(id)).toEqual({ kind: 'format', value })
    }
  })

  it('does not forward unknown paragraph or format ids into Muya', () => {
    expect(resolveEditorMenuCommand('paragraph.not-real')).toBeNull()
    expect(resolveEditorMenuCommand('format.not-real')).toBeNull()
    expect(editorPage).not.toContain("id.slice('paragraph.'.length)")
    expect(editorPage).not.toContain("id.slice('format.'.length)")
  })
})

describe('editor lifecycle transactions', () => {
  it('routes Save As through the store without committing identity in the page', () => {
    const saveAsAction = editorPage.match(/'file\.saveAs':[\s\S]*?\n  },/)?.[0] ?? ''
    expect(saveAsAction).toContain('editor.saveCurrentAs(picked)')
    expect(saveAsAction).not.toMatch(/tab\.(?:pathname|filename)\s*=/)
  })

  it('installs session persistence before awaiting the filesystem listener', () => {
    const startupComplete = editorPage.indexOf('await ready')
    const installPersistence = editorPage.indexOf('installSessionPersistence()', startupComplete)
    const awaitFsListener = editorPage.indexOf("await listenTyped('mt://fs/change'", startupComplete)
    expect(startupComplete).toBeGreaterThan(-1)
    expect(installPersistence).toBeGreaterThan(startupComplete)
    expect(awaitFsListener).toBeGreaterThan(installPersistence)
    expect(editorPage).toContain('persistCleanEditorSession({')
  })

  it('waits for bounded startup recovery before asking to close and never aborts it', () => {
    const closeFlow = editorPage.match(/function requestWindowClose\(\): Promise<void> \{[\s\S]*?\n\}/)?.[0] ?? ''
    const awaitStartup = closeFlow.indexOf('await pendingStartup')
    const askToClose = closeFlow.indexOf('prepareWindowCloseWithDecision()')
    expect(awaitStartup).toBeGreaterThan(-1)
    expect(askToClose).toBeGreaterThan(awaitStartup)
    expect(closeFlow).not.toContain('.abort()')
    expect(closeFlow.indexOf("if (decision === 'cancel') return")).toBeLessThan(
      closeFlow.indexOf('persistCleanEditorSession({'),
    )
  })
})
