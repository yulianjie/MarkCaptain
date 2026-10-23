import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  buildEditorContextMenuItems,
  extractContextWord,
  LatestContextMenuRequest,
  normalizeSpellingSuggestions,
  type EditorContextMenuActions,
  type EditorContextMenuLabels,
} from '../../src/services/editor-context-menu'

const labels: EditorContextMenuLabels = {
  undo: 'Undo',
  redo: 'Redo',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select all',
  checkingSpelling: 'Checking spelling…',
  noSuggestions: 'No spelling suggestions',
  addToDictionary: 'Add “teh” to dictionary',
}

function actions(): EditorContextMenuActions & Record<string, ReturnType<typeof vi.fn>> {
  return {
    undo: vi.fn(),
    redo: vi.fn(),
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    replaceWord: vi.fn(),
    addToDictionary: vi.fn(),
  }
}

describe('editor context-menu word selection', () => {
  it('extracts the single word at a collapsed WebView context cursor', () => {
    expect(extractContextWord({
      start: { key: 'p1', offset: 5, block: { text: 'one teh two' } },
      end: { key: 'p1', offset: 5 },
      affiliation: [{ type: 'p' }],
    })).toEqual({ word: 'teh', left: 4, right: 7 })
  })

  it('accepts exactly one selected word and rejects partial or code selections', () => {
    const block = { text: 'one teh two' }
    expect(extractContextWord({
      start: { key: 'p1', offset: 4, block },
      end: { key: 'p1', offset: 7 },
    })?.word).toBe('teh')
    expect(extractContextWord({
      start: { key: 'p1', offset: 5, block },
      end: { key: 'p1', offset: 7 },
    })).toBeNull()
    expect(extractContextWord({
      start: { key: 'code', offset: 1, block: { text: 'teh', functionType: 'codeContent', lang: '' } },
      end: { key: 'code', offset: 1 },
    })).toBeNull()
  })
})

describe('editor context-menu construction', () => {
  it('binds suggestions and add-to-dictionary to the captured word actions', async () => {
    const callbacks = actions()
    const items = buildEditorContextMenuItems({
      labels,
      capabilities: { undo: true, redo: false, cut: true, copy: true, paste: true, selectAll: true },
      actions: callbacks,
      spelling: { word: 'teh', misspelled: true, suggestions: ['the', 'tech'] },
    })

    await items.find(item => item.label === 'the')?.action?.()
    await items.find(item => item.label === labels.addToDictionary)?.action?.()

    expect(callbacks.replaceWord).toHaveBeenCalledTimes(1)
    expect(callbacks.replaceWord).toHaveBeenCalledWith('the')
    expect(callbacks.addToDictionary).toHaveBeenCalledTimes(1)
    expect(items.find(item => item.label === 'Redo')?.disabled).toBe(true)
  })

  it('deduplicates and caps backend suggestions', () => {
    expect(normalizeSpellingSuggestions(
      'teh',
      ['the', 'the', ' teh ', '', 'ten', 'tech'],
      2,
    )).toEqual(['the', 'ten'])
  })

  it('shows a non-actionable progress row while spellcheck is pending', () => {
    const items = buildEditorContextMenuItems({
      labels,
      capabilities: { undo: false, redo: false, cut: false, copy: false, paste: true, selectAll: true },
      actions: actions(),
      spelling: { word: 'teh', checking: true },
    })
    expect(items[0]).toMatchObject({ label: labels.checkingSpelling, disabled: true })
  })

  it('adds unified Agent actions without bypassing the existing context-menu actions', async () => {
    const callbacks = actions(), polish = vi.fn(), translate = vi.fn()
    const items = buildEditorContextMenuItems({
      labels,
      capabilities: { undo: true, redo: true, cut: true, copy: true, paste: true, selectAll: true },
      actions: callbacks,
      agentActions: [
        { label: 'AI · Polish', action: polish },
        { label: 'AI · Translate', action: translate },
      ],
    })
    await items.find(item => item.label === 'AI · Polish')?.action?.()
    await items.find(item => item.label === 'AI · Translate')?.action?.()
    expect(polish).toHaveBeenCalledOnce()
    expect(translate).toHaveBeenCalledOnce()
    expect(items.find(item => item.label === 'Undo')?.action).toBe(callbacks.undo)
    expect(items.find(item => item.label === 'Copy')?.action).toBe(callbacks.copy)
  })
})

describe('editor context-menu async request gate', () => {
  it('rejects old spelling responses after a newer menu or close', () => {
    const gate = new LatestContextMenuRequest()
    const first = gate.begin()
    const second = gate.begin()
    expect(gate.isCurrent(first)).toBe(false)
    expect(gate.isCurrent(second)).toBe(true)
    gate.invalidate(second)
    expect(gate.isCurrent(second)).toBe(false)
  })
})

describe('Muya spellcheck context-menu integration contract', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/components/editorWithTabs/MuyaEditor.vue', import.meta.url)),
    'utf8',
  )

  it('uses Muya contextmenu and performs replacement/add-word directly without recursive bus channels', () => {
    expect(source).toContain("muya.on('contextmenu'")
    expect(source).toContain('muya._replaceCurrentWordInlineUnsafe?.(wordInfo.word, replacement)')
    expect(source).toContain('spellchecker.addWord(wordInfo.word)')
    expect(source).not.toContain("bus.on('switch-spellchecker-language'")
    expect(source).not.toContain("bus.on('replace-misspelling'")
  })

  it('routes selected text Agent actions through the shared no-auto-send command queue', () => {
    expect(source).toContain('agentActions: AGENT_WRITING_COMMANDS.map')
    expect(source).toContain('agent.queueWritingCommand(command)')
    expect(source).not.toContain('agent.send(')
  })

  it('offers the same Agent actions in the source editor context menu', () => {
    const sourcePane = readFileSync(
      fileURLToPath(new URL('../../src/components/editorWithTabs/SourceCodePane.vue', import.meta.url)),
      'utf8',
    )
    expect(sourcePane).toContain('contextmenu(event, view)')
    expect(sourcePane).toContain('AGENT_WRITING_COMMANDS.map')
    expect(sourcePane).toContain('agent.queueWritingCommand(command)')
    expect(sourcePane).not.toContain('agent.send(')
  })
})
