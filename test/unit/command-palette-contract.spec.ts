import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import en from '../../src/i18n/en'
import ja from '../../src/i18n/ja'
import zhCN from '../../src/i18n/zh-CN'
import {
  BUILTIN_COMMAND_IDS,
  BUILTIN_COMMAND_SPECS,
  COMMAND_CATEGORIES,
} from '../../src/services/command-palette-actions'
import { AGENT_WRITING_COMMANDS } from '../../src/services/agent-m1-copy'
import {
  FORMAT_MENU_COMMANDS,
  PARAGRAPH_MENU_COMMANDS,
} from '../../src/services/editor-menu-actions'

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

function lookup(messages: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => {
    if (!value || typeof value !== 'object') return undefined
    return (value as Record<string, unknown>)[key]
  }, messages)
}

const editorPage = readSource('../../src/pages/EditorPage.vue')
const nativeMenu = readSource('../../src-tauri/src/menu/mod.rs')
const palette = readSource('../../src/components/commandPalette/CommandPalette.vue')
// These IDs exist only while Preferences temporarily removes Muda's built-in
// Cut/Copy/Paste accelerators so the shortcut recorder can observe them.
// They are not normal commands and must never enter the command palette.
const recorderOnlyTransientNativeIds = ['edit.cut', 'edit.copy', 'edit.paste'] as const
const recorderOnlyTransientNativeIdSet = new Set<string>(recorderOnlyTransientNativeIds)

describe('command palette action contract', () => {
  it('registers every static renderer action and every supported Muya action exactly once', () => {
    const menuActionsBlock = editorPage.slice(
      editorPage.indexOf('const MENU_ACTIONS'),
      editorPage.indexOf('async function routeMenuAction'),
    )
    const rendererActionIds = [...menuActionsBlock.matchAll(/^\s*'([^']+)':/gm)]
      .map(match => match[1])
      .filter(id => !recorderOnlyTransientNativeIdSet.has(id))
    const editorActionIds = [
      ...Object.keys(PARAGRAPH_MENU_COMMANDS),
      'paragraph.table',
      ...Object.keys(FORMAT_MENU_COMMANDS),
    ]

    expect(new Set(BUILTIN_COMMAND_IDS).size).toBe(BUILTIN_COMMAND_IDS.length)
    expect([...BUILTIN_COMMAND_IDS].sort()).toEqual(
      [...rendererActionIds, ...editorActionIds].sort(),
    )
  })

  it('stays aligned with every custom static native menu action', () => {
    const buildMenu = nativeMenu.slice(
      nativeMenu.indexOf('fn build_menu('),
      nativeMenu.indexOf('/// Map a theme id'),
    )
    const nativeIds = [...buildMenu.matchAll(
      /"((?:file|edit|paragraph|format|view|window|help)\.[A-Za-z0-9.]+)"/g,
    )].map(match => match[1])

    // Dynamic recent/theme entries are data, not stable commands. Copy-as and
    // paste-plain are renderer-only actions. Quit and minimize remain regular
    // OS-owned items; Cut/Copy/Paste are separately recorder-only transient
    // native IDs while accelerator recording is active.
    const dynamicNativeIds = new Set(['file.openRecent.empty', 'file.clearRecent'])
    const routedWithoutCustomNativeId = new Set([
      'edit.copyAsMarkdown',
      'edit.copyAsHtml',
      'edit.pasteAsPlainText',
      'view.notes', 'edit.restoreReferences',
      'view.splitRight', 'view.splitDown', 'view.closePane', 'view.layouts', 'file.localHistory',
    ])
    const predefinedOsOwnedItems = [
      'app.quit',
      'window.minimize',
    ]

    const staticNativeIds = [...new Set(nativeIds)]
      .filter(id => !dynamicNativeIds.has(id) && !recorderOnlyTransientNativeIdSet.has(id))
      .sort()
    const registeredNativeIds = BUILTIN_COMMAND_IDS
      .filter(id => !routedWithoutCustomNativeId.has(id))
      .sort()

    expect(staticNativeIds).toEqual(registeredNativeIds)
    expect(predefinedOsOwnedItems).toHaveLength(2)
    expect(recorderOnlyTransientNativeIds).toHaveLength(3)
  })

  it('routes every registered command through the same menu action function', () => {
    expect(editorPage).toContain('for (const spec of BUILTIN_COMMAND_SPECS)')
    expect(editorPage).toContain("execute: () => routeMenuAction(spec.id, 'palette')")
    expect(editorPage).toContain('when: () => isBuiltinCommandAvailable(spec)')
  })

  it('registers and unregisters writing actions through the shared Agent draft queue', () => {
    expect(editorPage).toContain('for (const command of AGENT_WRITING_COMMANDS)')
    expect(editorPage).toContain('execute: () => agent.queueWritingCommand(command)')
    expect(editorPage).toContain('for (const id of agentWritingCommandIds) cc.unregister(id)')
    expect(AGENT_WRITING_COMMANDS).toEqual(['polish', 'shorten', 'continue', 'translate', 'explain', 'terms', 'structure'])
    expect(editorPage).not.toContain('execute: () => agent.send(')
  })

  it('has complete English, Simplified Chinese, and Japanese command labels', () => {
    const locales = [en, zhCN, ja] as Array<Record<string, unknown>>
    const keys = [
      ...COMMAND_CATEGORIES.map(category => `command.categories.${category}`),
      ...BUILTIN_COMMAND_SPECS.map(spec => spec.labelKey),
      'command.title',
      'command.results',
      'command.executionFailed',
    ]

    for (const messages of locales) {
      for (const key of keys) {
        expect(lookup(messages, key), `${key} should be localized`).toEqual(expect.any(String))
      }
    }
  })
})

describe('command palette accessibility and failure handling contract', () => {
  it('exposes combobox/listbox semantics and disabled state', () => {
    for (const marker of [
      'role="combobox"',
      'aria-controls="command-palette-list"',
      ':aria-activedescendant="activeOptionId"',
      'role="listbox"',
      'role="option"',
      ':aria-selected="idx === selectedIndex"',
      ':aria-disabled="cmd.disabled"',
    ]) {
      expect(palette).toContain(marker)
    }
  })

  it('does not execute disabled commands, scrolls selection, and reports failures', () => {
    expect(palette).toContain('if (!cmd || cmd.disabled) return')
    expect(palette).toContain("scrollIntoView({ block: 'nearest' })")
    expect(palette).toContain("title: t('command.executionFailed')")
    expect(palette).toContain('nextEnabledCommandIndex(matches.value, selectedIndex.value, delta)')
    expect(palette).toContain('safeCommandIndex(commands, selectedIndex.value)')
  })
})
