import { test, expect, type Page } from '@playwright/test'

// Exercise the real editor instances and tab UI in the renderer; no disk writes.
async function openDocuments(page: Page, sourceMode = false) {
  await page.goto('/')
  await page.locator('.muya-host [contenteditable="true"]').waitFor()
  await page.evaluate(async source => {
    const editorPath = '/src/stores/editor.ts'
    const prefsPath = '/src/stores/preferences.ts'
    const editor = (await import(editorPath)).useEditorStore()
    Object.assign((await import(prefsPath)).usePreferencesStore(), {
      language: 'en', autoSave: false, tabBarVisibility: true,
    })
    const first = editor.newUntitledTab('First document')
    const last = editor.newUntitledTab('# Last document\n\nClosing regression')
    for (const [index, tab] of [first, last].entries()) {
      tab.filename = `close-${index}.md`
      tab.pathname = `C:\\close-tabs-test\\${tab.filename}`
      tab.isSaved = true
      tab.pendingBaselineUpdate = true
    }
    editor.tabs = [first, last]
    editor.sourceCodeMode = source
  }, sourceMode)
  await expect(page.locator('.tabs-bar [role="tab"]')).toHaveCount(2)
  await expect(page.locator(sourceMode ? '.source-pane' : '.muya-host')).toContainText('Closing regression')
}

async function expectEmptyEditors(page: Page) {
  await expect(page.locator('.tabs-bar [role="tab"]')).toHaveCount(0)
  await expect(page.locator('.muya-host')).toBeHidden()
  await expect(page.locator('.source-pane')).toBeHidden()
  await expect(page.locator('.muya-host [contenteditable="true"]')).toHaveText('')
  await expect(page.locator('.source-pane .cm-content')).toHaveText('')
  await expect(page.locator('.find-bar')).toBeHidden()
  await expect.poll(() => page.evaluate(async () => {
    const path = '/src/stores/editor.ts'
    const editor = (await import(path)).useEditorStore()
    const muya = editor.getMuyaInstance()
    return {
      currentFile: editor.currentFile,
      toc: editor.listToc,
      formats: editor.currentSelectionFormats,
      // Muya serializes its empty paragraph with a trailing newline.
      markdown: muya.getMarkdown().trim(),
      historyContainsClosedFile: JSON.stringify(muya.getHistory()).includes('Closing regression'),
      baseUrl: muya.options.baseUrl,
    }
  })).toEqual({
    currentFile: null, toc: [], formats: [], markdown: '',
    historyContainsClosedFile: false, baseUrl: '',
  })
}

for (const sourceMode of [false, true]) {
  test(`closing the last ${sourceMode ? 'source' : 'WYSIWYG'} tab clears both editors and allows a fresh document`, async ({ page }) => {
    await openDocuments(page, sourceMode)
    const editable = page.locator(sourceMode
      ? '.source-pane .cm-content'
      : '.muya-host [contenteditable="true"]')

    // Closing a background tab must leave the active document intact.
    await page.locator('.tab-shell .close').first().click()
    await expect(page.locator('.tabs-bar [role="tab"]')).toHaveCount(1)
    await expect(editable).toContainText('Closing regression')
    await editable.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' pending edit')
    await expect(editable).toContainText('pending edit')

    // Cancelling a dirty close preserves the document; discarding clears it.
    await page.locator('.tab-shell .close').click()
    await expect(page.locator('.el-message-box')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.el-message-box')).toBeHidden()
    await expect(page.locator('.tabs-bar [role="tab"]')).toHaveCount(1)
    await expect(editable).toContainText('pending edit')
    await page.keyboard.press('Control+f')
    await expect(page.locator('.find-bar')).toBeVisible()
    await page.locator('.tab-shell .close').click()
    await page.locator('.el-message-box').getByRole('button', { name: "Don't Save", exact: true }).click()
    await expectEmptyEditors(page)

    // Toggling the mode while empty cannot bring the old document back.
    await page.evaluate(async () => {
      const path = '/src/stores/editor.ts'
      const editor = (await import(path)).useEditorStore()
      editor.toggleSourceCode()
    })
    await expectEmptyEditors(page)
    await page.locator('.new-tab').click()
    await page.evaluate(async source => {
      const path = '/src/stores/editor.ts'
      const editor = (await import(path)).useEditorStore()
      editor.sourceCodeMode = source
    }, sourceMode)
    await expect(editable).toBeVisible()
    await expect(editable).toHaveText('')
    await editable.click()
    await page.keyboard.press('Control+z')
    await expect(editable).toHaveText('')
    await page.keyboard.type('fresh document')
    await expect(editable).toContainText('fresh document')
    await page.keyboard.press('Control+z')
    await expect(editable).toHaveText('')
    await page.keyboard.press('Control+y')
    await expect(editable).toContainText('fresh document')
    await expect(editable).not.toContainText('Closing regression')
  })
}

test('Close All clears the final document', async ({ page }) => {
  await openDocuments(page)
  await page.locator('.tabs-bar [role="tab"]').last().click({ button: 'right' })
  await page.locator('.mt-context-menu').getByRole('button', { name: 'Close all tabs', exact: true }).click()
  await expectEmptyEditors(page)
})
