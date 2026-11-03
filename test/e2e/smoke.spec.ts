import { startWithNewDocument } from './helpers/editor'
/**
 * Smoke tests — verify the renderer boots and the basic UI surfaces are
 * present. Doesn't drive Tauri-specific commands (those need the binary
 * + tauri-driver); checks renderer-only happy paths.
 *
 * The tests intentionally don't depend on file-system actions so they pass
 * in CI without preferences/store fixtures.
 */
import { test, expect } from '@playwright/test'

test('renderer boots and shows the editor page', async ({ page }) => {
  await page.goto('/')
  // The title bar is mounted only after the editor page and stores are ready.
  await expect(page.locator('.title-bar')).toBeVisible({ timeout: 10_000 })
  // The editor surface remains the stable renderer-ready signal even though
  // the tab bar can be hidden through the persisted view preference.
  await expect(page.locator('.editor-stage')).toBeVisible()
})

test('command palette opens with Ctrl+Shift+P', async ({ page }) => {
  await page.goto('/')
  await page.locator('.title-bar').waitFor()
  await page.keyboard.press('Control+Shift+P')
  await expect(page.locator('.cp-input')).toBeVisible()
})

test('source-code mode toggle wires to the editor', async ({ page }) => {
  await startWithNewDocument(page)
  await page.locator('.title-bar').waitFor()
  // Open the command palette and run "Toggle Source Code Mode"
  await page.keyboard.press('Control+Shift+P')
  const input = page.locator('.cp-input')
  await input.fill('source')
  await page.keyboard.press('Enter')
  await expect(page.locator('.source-pane')).toBeVisible()
})

test('WYSIWYG undo and both Windows redo shortcuts use Muya history', async ({ page }) => {
  await startWithNewDocument(page)
  const editor = page.locator('.muya-host [contenteditable="true"]')
  await editor.waitFor()
  await editor.click()
  await page.keyboard.type('abc')
  await expect(editor).toContainText('abc')

  await page.keyboard.press('Control+Z')
  await expect(editor).not.toContainText('abc')
  await page.keyboard.press('Control+Y')
  await expect(editor).toContainText('abc')

  await page.keyboard.press('Control+Z')
  await expect(editor).not.toContainText('abc')
  await page.keyboard.press('Control+Shift+Z')
  await expect(editor).toContainText('abc')
})

test('editing shortcuts stay inside a focused command-palette input', async ({ page }) => {
  await startWithNewDocument(page)
  const editor = page.locator('.muya-host [contenteditable="true"]')
  await editor.waitFor()
  await editor.click()
  await page.keyboard.type('document')

  await page.keyboard.press('Control+Shift+P')
  const input = page.locator('.cp-input')
  await input.fill('')
  await input.pressSequentially('query')
  await page.keyboard.press('Control+A')
  await page.keyboard.type('x')
  await expect(input).toHaveValue('x')
  await page.keyboard.press('Control+Z')
  await expect(input).toHaveValue('query')
  await expect(editor).toContainText('document')
})
