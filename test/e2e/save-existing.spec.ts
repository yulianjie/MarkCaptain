import { startWithNewDocument } from './helpers/editor'
import { expect, test } from '@playwright/test'

for (const ending of ['', '\n']) {
  test(`saving an existing file stays clean across repeated edits (${JSON.stringify(ending)})`, async ({ page }) => {
    await startWithNewDocument(page)
    await page.locator('.muya-host [contenteditable="true"]').waitFor()
    await page.evaluate(async ending => {
      const editorPath = '/src/stores/editor.ts'
      const prefsPath = '/src/stores/preferences.ts'
      const { useEditorStore } = await import(editorPath)
      const { usePreferencesStore } = await import(prefsPath)
      Object.assign(usePreferencesStore(), { autoSave: false, trimTrailingNewline: 2, language: 'en' })
      const state = window as unknown as {
        __TAURI_INTERNALS__: unknown
        savedMarkdown: string
        writes: number
      }
      state.savedMarkdown = `# Existing file\n\nOriginal paragraph.${ending}`
      state.writes = 0
      state.__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args: Record<string, unknown>) => {
          if (cmd === 'cmd_read_markdown') return {
            path: 'C:\\notes\\existing.md', markdown: state.savedMarkdown,
            encoding: 'UTF-8', lineEnding: 'lf', bom: false, hadDecodeErrors: false,
          }
          if (cmd === 'cmd_save_markdown') {
            state.savedMarkdown = args.markdown as string
            state.writes++
          }
          if (cmd === 'cmd_push_recent') return []
          return null
        },
      }
      await useEditorStore().openFile('C:\\notes\\existing.md')
    }, ending)
    const status = page.locator('[data-status="save-state"]')
    await expect(status).toHaveText('Saved')
    for (let i = 1; i <= 3; i++) {
      await page.locator('.muya-host p').filter({ hasText: 'Original paragraph.' }).click()
      await page.keyboard.press('End')
      await page.keyboard.type(` edit-${i}`)
      await expect(status).toHaveText('Unsaved')
      const cursor = () => page.evaluate(() => {
        const selection = window.getSelection()!
        return { text: selection.anchorNode?.textContent, offset: selection.anchorOffset }
      })
      const beforeSave = await cursor()
      await page.keyboard.press('Control+s')
      await expect.poll(() => page.evaluate(() => (window as unknown as { writes: number }).writes)).toBe(i)
      await expect(status).toHaveText('Saved')
      expect(await cursor()).toEqual(beforeSave)
      expect(await page.evaluate(() => (window as unknown as { savedMarkdown: string }).savedMarkdown))
        .toBe(`# Existing file\n\nOriginal paragraph.${Array.from({ length: i }, (_, n) => ` edit-${n + 1}`).join('')}${ending}`)
      // Muya dispatches another change when selection moves after saving.
      await page.locator('.muya-host p').filter({ hasText: 'Original paragraph.' }).click()
      await expect(status).toHaveText('Saved')
    }
    await page.keyboard.press('Control+z')
    await expect(page.locator('.muya-host p')).not.toContainText('edit-3')
    await expect(status).toHaveText('Unsaved')
  })
}
