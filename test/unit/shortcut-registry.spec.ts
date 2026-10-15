import { describe, expect, it } from 'vitest'

import {
  defaultKeybindings,
  displayAccelerator,
  eventAccel,
  findShortcutActions,
  getShortcutAccelerators,
  getShortcutAvailability,
  getShortcutDefault,
  getShortcutDisplay,
  getShortcutScope,
  isReservedAccelerator,
  isShortcutSupportedOnPlatform,
  isSupportedShortcutKey,
  isShortcutAvailable,
  isShortcutRemappable,
  normaliseAccelerator,
  resolveShortcutAction,
  shortcutActions,
  splitAccelerator,
} from '../../src/common/shortcut-registry'

function keyEvent(key: string, code: string, extra: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    code,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...extra,
  } as KeyboardEvent
}

describe('shortcut registry contract', () => {
  it('is the sole source for remappable application defaults including notebook commands', () => {
    const remappable = findShortcutActions({ remappable: true })
    expect(remappable).toHaveLength(14)
    expect(getShortcutDefault('file.quickOpen')).toBe('Ctrl+K')
    expect(getShortcutDefault('file.dailyNote')).toBe('Ctrl+Alt+D')
    expect(getShortcutDefault('edit.insertTemplate')).toBe('Ctrl+Alt+T')
    expect(Object.fromEntries(remappable.map(action => [action.id, action.default]))).toEqual(defaultKeybindings)
    expect(remappable.every(action => action.scope === 'application' && action.dispatch === 'application')).toBe(true)
    expect(getShortcutDefault('file.save')).toBe('Ctrl+S')
    expect(getShortcutDisplay('file.save')).toBe('Save')
    expect(getShortcutScope('file.save')).toBe('application')
    expect(isShortcutRemappable('file.save')).toBe(true)
    expect(isShortcutRemappable('view.toggleAgent')).toBe(false)
  })

  it('declares fixed application, agent, and title-bar keys as reserved', () => {
    expect(isReservedAccelerator('Ctrl+Shift+N')).toBe(true)
    expect(isReservedAccelerator('Ctrl+Alt+S')).toBe(true)
    expect(isReservedAccelerator('F11')).toBe(true)
    expect(isReservedAccelerator('Ctrl+Shift+A')).toBe(true)
    expect(isReservedAccelerator('Alt+F')).toBe(true)
    expect(isReservedAccelerator('Alt+H')).toBe(true)
    expect(shortcutActions.filter(action => action.scope === 'titlebar')).toHaveLength(8)
  })

  it('models Quit as a macOS system-owned shortcut only', () => {
    const quit = shortcutActions.find(action => action.id === 'app.quit')
    expect(quit).toMatchObject({ dispatch: 'system', systemOwned: true, platforms: ['macos'] })
    expect(isShortcutSupportedOnPlatform('app.quit', 'macos')).toBe(true)
    expect(isShortcutSupportedOnPlatform('app.quit', 'windows')).toBe(false)
    expect(getShortcutAccelerators('app.quit', 'macos')).toEqual(['Ctrl+Q'])
    expect(getShortcutAccelerators('app.quit', 'windows')).toEqual([])
    expect(isReservedAccelerator('Ctrl+Q', 'macos')).toBe(true)
    expect(isReservedAccelerator('Ctrl+Q', 'windows')).toBe(false)
  })

  it('exposes availability and platform alternatives without hard-coded editor maps', () => {
    expect(getShortcutAvailability('format.bold')).toBe('wysiwyg')
    expect(isShortcutAvailable('format.bold', { hasEditor: true, sourceCodeMode: false })).toBe(true)
    expect(isShortcutAvailable('format.bold', { hasEditor: true, sourceCodeMode: true })).toBe(false)
    expect(isShortcutAvailable('titlebar.fileMenu', { customChrome: false })).toBe(false)
    expect(isShortcutAvailable('titlebar.fileMenu', { customChrome: true })).toBe(true)

    expect(getShortcutAccelerators('edit.redo', 'windows')).toEqual(['Ctrl+Shift+Z', 'Ctrl+Y'])
    expect(getShortcutAccelerators('edit.redo', 'linux')).toEqual(['Ctrl+Shift+Z', 'Ctrl+Y'])
    expect(getShortcutAccelerators('edit.redo', 'macos')).toEqual(['Ctrl+Shift+Z'])
    expect(resolveShortcutAction('Ctrl+Y', { scope: 'editor', dispatch: 'editor', platform: 'windows' })?.id).toBe('edit.redo')
    expect(resolveShortcutAction('Ctrl+Y', { scope: 'editor', dispatch: 'editor', platform: 'macos' })).toBeUndefined()
  })

  it('preserves literal plus, numpad, and native-safe volume-key identities for recorders', () => {
    expect(splitAccelerator('Ctrl++')).toEqual(['Ctrl', '+'])
    expect(normaliseAccelerator('Ctrl++')).toBe('ctrl+=')
    expect(eventAccel(keyEvent('+', 'Equal', { ctrlKey: true, shiftKey: true }))).toBe('ctrl+=')
    expect(eventAccel(keyEvent('1', 'Numpad1', { ctrlKey: true }))).toBe('ctrl+numpad1')
    expect(eventAccel(keyEvent('+', 'NumpadAdd', { ctrlKey: true }))).toBe('ctrl+numpadadd')
    expect(eventAccel(keyEvent('AudioVolumeDown', 'AudioVolumeDown', { ctrlKey: true }))).toBe('ctrl+volumedown')
    expect(isSupportedShortcutKey('VolumeDown')).toBe(true)
    expect(isSupportedShortcutKey('MediaPlayPause')).toBe(false)
    expect(isSupportedShortcutKey('BrowserBack')).toBe(false)
    expect(isSupportedShortcutKey('LaunchMail')).toBe(false)
  })

  it('uses Meta, not physical Ctrl, as the primary modifier on macOS and ignores AltGr', () => {
    expect(eventAccel(keyEvent('a', 'KeyA', { ctrlKey: true }), 'macos')).toBe('a')
    expect(eventAccel(keyEvent('a', 'KeyA', { metaKey: true }), 'macos')).toBe('ctrl+a')
    expect(resolveShortcutAction(eventAccel(keyEvent('a', 'KeyA', { ctrlKey: true, shiftKey: true }), 'macos'), {
      scope: 'agent',
      dispatch: 'agent',
      platform: 'macos',
    })).toBeUndefined()
    expect(resolveShortcutAction(eventAccel(keyEvent('a', 'KeyA', { metaKey: true, shiftKey: true }), 'macos'), {
      scope: 'agent',
      dispatch: 'agent',
      platform: 'macos',
    })?.id).toBe('view.toggleAgent')
    expect(eventAccel(keyEvent('a', 'KeyA', {
      ctrlKey: true,
      altKey: true,
      getModifierState: (modifier: string) => modifier === 'AltGraph',
    }), 'windows')).toBe('')
  })

  it('renders recorder-safe named keys with readable casing', () => {
    expect(displayAccelerator('ctrl+tab')).toBe('Ctrl+Tab')
    expect(displayAccelerator('ctrl+esc')).toBe('Ctrl+Esc')
    expect(displayAccelerator('ctrl+f12')).toBe('Ctrl+F12')
    expect(displayAccelerator('ctrl+shift+a', 'macos')).toBe('Cmd+Shift+A')
  })
})
