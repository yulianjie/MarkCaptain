import { startWithNewDocument } from './helpers/editor'
import { test, expect } from '@playwright/test'

// Real DOM/editor/store routing with mocked IPC; this does not drive WebView2.
test('Save and Save As reach IPC once from Muya and CodeMirror', async ({ page }) => {
  await startWithNewDocument(page)
  const editor = page.locator('.muya-host [contenteditable="true"]')
  await editor.waitFor()
  await page.evaluate(() => {
    const state = window as unknown as {
      __TAURI_INTERNALS__: unknown
      shortcutCalls: { cmd: string; args: Record<string, unknown> }[]
    }
    state.shortcutCalls = []
    state.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        state.shortcutCalls.push({ cmd, args })
        if (cmd === 'cmd_save_as_dialog') return 'C:\\shortcut-test\\document.md'
        return null
      },
    }
  })
  await editor.click()
  await page.keyboard.type('shortcut save regression')
  await page.keyboard.press('Control+s')
  const calls = () => page.evaluate(() => (window as unknown as {
    shortcutCalls: { cmd: string; args: Record<string, unknown> }[]
  }).shortcutCalls)
  await expect.poll(async () => (await calls()).filter(c => c.cmd === 'cmd_save_markdown').length).toBe(1)
  expect((await calls()).find(c => c.cmd === 'cmd_save_markdown')?.args.markdown).toContain('shortcut save regression')
  expect((await calls()).filter(c => c.cmd === 'cmd_save_as_dialog')).toHaveLength(1)

  await page.keyboard.press('Control+Shift+s')
  await expect.poll(async () => (await calls()).filter(c => c.cmd === 'cmd_save_markdown').length).toBe(2)
  expect((await calls()).filter(c => c.cmd === 'cmd_save_as_dialog')).toHaveLength(2)

  await page.keyboard.press('Control+Shift+p')
  await page.locator('.cp-input').fill('source')
  await page.keyboard.press('Enter')
  const source = page.locator('.source-pane .cm-content')
  await source.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' source edit')
  await page.keyboard.press('Control+s')
  await expect.poll(async () => (await calls()).filter(c => c.cmd === 'cmd_save_markdown').length).toBe(3)
  expect((await calls()).filter(c => c.cmd === 'cmd_save_markdown')[2].args.markdown).toContain('source edit')
  expect((await calls()).filter(c => c.cmd === 'cmd_save_as_dialog')).toHaveLength(2)
})

test('find and replace requests refocus, and source mode does not swallow WYSIWYG formatting', async ({ page }) => {
  await startWithNewDocument(page)
  const editor = page.locator('.muya-host [contenteditable="true"]')
  await editor.waitFor()
  await editor.click()

  await page.keyboard.press('Control+h')
  const findBar = page.locator('.find-bar')
  const replaceInput = findBar.locator('[data-replace-input]')
  await expect(findBar).toBeVisible()
  await expect(replaceInput).toBeVisible()
  await expect(replaceInput).toBeFocused()

  await page.keyboard.press('Control+f')
  const findInput = findBar.locator('[data-find-input]')
  await expect(findInput).toBeFocused()
  await page.locator('.sidebar-toggle').focus()
  await page.keyboard.press('Control+f')
  await expect(findInput).toBeFocused()

  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+Shift+p')
  await page.locator('.cp-input').fill('bold')
  const boldCommand = page.locator('.cp-row').filter({ hasText: 'Bold' }).first()
  await expect(boldCommand.locator('.cp-shortcut')).toHaveText('Ctrl+B')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+Shift+p')
  await page.locator('.cp-input').fill('source')
  await page.keyboard.press('Enter')
  const source = page.locator('.source-pane .cm-content')
  await source.click()
  await page.evaluate(() => {
    const state = window as unknown as { sourceShortcutEvents: boolean[] }
    state.sourceShortcutEvents = []
    window.addEventListener('keydown', event => {
      if (event.ctrlKey && event.code === 'KeyB') state.sourceShortcutEvents.push(event.defaultPrevented)
    })
  })
  await page.keyboard.press('Control+b')
  await expect.poll(() => page.evaluate(() => (window as unknown as {
    sourceShortcutEvents: boolean[]
  }).sourceShortcutEvents)).toEqual([false])
})

test('the keybinding recorder keeps command-modified Tab and Escape only', async ({ page }) => {
  await page.goto('/#/preferences')
  await page.locator('#prefs-tab-keybindings').click()
  const saveRow = page.locator('tr', { has: page.locator('.kb-action-id', { hasText: /^file\.save$/ }) })
  await saveRow.locator('.kb-button').click()
  const recorder = page.locator('#keybinding-input-file-save')
  await expect(recorder).toBeFocused()

  await recorder.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Tab', code: 'Tab', ctrlKey: true, bubbles: true, cancelable: true,
  })))
  await expect(recorder).toHaveValue('Ctrl+Tab')

  await recorder.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Tab', code: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
  })))
  await expect(recorder).toHaveValue('Ctrl+Tab')

  // Cut/Copy/Paste are fixed native items. The recorder must still observe
  // them long enough to show its reserved-binding feedback.
  await recorder.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true,
  })))
  await expect(recorder).toHaveValue('Ctrl+C')
  await expect(saveRow.locator('.kb-error')).toBeVisible()

  await recorder.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', code: 'Escape', ctrlKey: true, bubbles: true, cancelable: true,
  })))
  await expect(recorder).toHaveValue('Ctrl+Esc')

  await recorder.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape', code: 'Escape', shiftKey: true, bubbles: true, cancelable: true,
  })))
  await expect(recorder).toHaveCount(0)
})
