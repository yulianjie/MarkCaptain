import { expect, test, type Page } from '@playwright/test'

async function openDocument(page: Page, sourceMode = false) {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await page.locator('.muya-host [contenteditable="true"]').waitFor()
  await page.evaluate(async source => {
    const editorPath = '/src/stores/editor.ts'
    const prefsPath = '/src/stores/preferences.ts'
    const layoutPath = '/src/stores/layout.ts'
    Object.assign((await import(prefsPath)).usePreferencesStore(), {
      language: 'en', autoSave: false, tabBarVisibility: true, sideBarVisibility: true,
      statusBarVisibility: true, focus: false, typewriter: false,
      recentFiles: ['C:/notes/draft.md'],
    })
    Object.assign((await import(layoutPath)).useLayoutStore(), { navigationPanel: 'files', showInspector: true, inspectorPanel: 'outline' })
    const editor = (await import(editorPath)).useEditorStore()
    const tab = editor.newUntitledTab('# Draft heading\n\nOriginal text')
    Object.assign(tab, { filename: 'draft.md', pathname: 'C:/notes/draft.md', isSaved: true, pendingBaselineUpdate: true })
    editor.tabs = [tab]
    editor.sourceCodeMode = source
  }, sourceMode)
  await expect(page.locator(sourceMode ? '.source-pane' : '.muya-host')).toContainText('Original text')
}

async function start(page: Page) {
  await page.locator('.navigation-tabs').getByRole('button', { name: 'Start', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Start', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.welcome-panel')).toBeVisible()
}

for (const sourceMode of [false, true]) {
  test(`Start has its own tab and preserves ${sourceMode ? 'source' : 'WYSIWYG'} edits and undo`, async ({ page }) => {
    await openDocument(page, sourceMode)
    const editable = page.locator(sourceMode ? '.source-pane .cm-content' : '.muya-host [contenteditable="true"]')
    await editable.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(' pending draft')
    await expect(editable).toContainText('pending draft')
    await start(page)
    await start(page)
    await expect(page.locator('.tabs-bar [role="tab"]')).toHaveCount(2)
    await expect(page.getByRole('tab', { name: /draft.md/ })).toHaveAttribute('aria-selected', 'false')
    await expect(page.locator('.document-inspector')).toHaveCount(0)
    await expect(page.locator('[data-status="save-state"]')).toHaveText('No document')
    await expect(page.locator('.document-actions').getByRole('button', { name: 'Export document', exact: true })).toBeDisabled()
    await page.keyboard.press('Control+f')
    await expect(page.locator('.find-bar')).toBeHidden()
    await expect(page.locator('.welcome-panel')).toBeVisible()
    await page.getByRole('tab', { name: /draft.md/ }).click()
    await expect(editable).toBeVisible()
    await expect(editable).toContainText('pending draft')
    await expect(page.locator('[data-status="save-state"]')).toHaveText('Unsaved')
    await editable.click()
    await page.keyboard.press('Control+z')
    await expect(editable).not.toContainText('pending draft')
    await page.keyboard.press('Control+y')
    await expect(editable).toContainText('pending draft')
    await start(page)
    await page.keyboard.press('Control+w')
    await expect(page.getByRole('tab', { name: 'Start', exact: true })).toHaveCount(0)
    await expect(editable).toContainText('pending draft')
    await expect(page.locator('.el-message-box')).toBeHidden()
  })
}

test('Start participates in tab keyboard navigation and recent/new document activation', async ({ page }) => {
  await openDocument(page)
  await start(page)
  await page.getByRole('tab', { name: 'Start', exact: true }).press('ArrowRight')
  await expect(page.getByRole('tab', { name: 'draft.md', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'draft.md', exact: true }).press('Home')
  await expect(page.locator('.welcome-panel')).toBeVisible()
  await page.locator('.recent-list button').click()
  await expect(page.locator('.welcome-panel')).toHaveCount(0)
  await expect(page.locator('.tabs-bar [role="tab"]')).toHaveCount(2)
  await start(page)
  await page.locator('.welcome-actions .primary').click()
  await expect(page.locator('.welcome-panel')).toHaveCount(0)
  await expect(page.locator('.tabs-bar [role="tab"]')).toHaveCount(3)
  await page.locator('.home-tab .close').click()
  await expect(page.locator('.tab[aria-selected="true"]')).toContainText('Untitled')
})

test('Start returns to the active split pane without losing the other pane', async ({ page }) => {
  await openDocument(page, true)
  await page.evaluate(async () => {
    const path = '/src/stores/editor.ts'
    const editor = (await import(path)).useEditorStore()
    editor.splitPane('horizontal')
    editor.activatePane(editor.panes[1].id)
    editor.newUntitledTab('Second pane text')
  })
  await expect(page.locator('.editing-region').nth(1)).toContainText('Second pane text')
  await start(page)
  await expect.poll(() => page.evaluate(() => {
    const layout = JSON.parse(localStorage.getItem('mt:panes') ?? 'null')
    return layout?.panes.map((pane: { empty: boolean; tabIndex: number }) => ({ empty: pane.empty, tabIndex: pane.tabIndex }))
  })).toEqual([{ empty: false, tabIndex: 0 }, { empty: false, tabIndex: 1 }])
  await page.locator('.home-tab .close').click()
  await expect(page.locator('.editing-region').first()).toContainText('Original text')
  await expect(page.locator('.editing-region').nth(1)).toContainText('Second pane text')
  await expect(page.locator('.editing-region').nth(1)).toHaveClass(/active/)
})

test('cancelling the open dialog or failing to open a recent file keeps Start selected', async ({ page }) => {
  await page.route('**/src/services/tauri-invoke.ts*', route => route.request().url().includes('home-open-original')
    ? route.continue()
    : route.fulfill({ contentType: 'text/javascript', body: `
      export * from '/src/services/tauri-invoke.ts?home-open-original';
      export const openFiles = async () => [];
      export const readMarkdown = async () => { throw new Error('Missing file'); };
    ` }))
  await openDocument(page)
  await page.evaluate(async () => {
    const path = '/src/stores/preferences.ts'
    ;(await import(path)).usePreferencesStore().recentFiles = ['C:/notes/missing.md']
  })
  await start(page)
  await page.locator('.welcome-actions').getByRole('button', { name: 'Open a document', exact: true }).click()
  await expect(page.locator('.welcome-panel')).toBeVisible()
  await page.locator('.recent-list button').click()
  await expect(page.locator('.welcome-panel')).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Start', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.tabs-bar [role="tab"]')).toHaveCount(2)
})
