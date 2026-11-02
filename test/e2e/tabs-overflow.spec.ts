import { expect, test, type Page } from '@playwright/test'

async function seedTabs(page: Page, count: number, theme: 'light' | 'dark') {
  await page.evaluate(async ({ count, theme }) => {
    const editorPath = '/src/stores/editor.ts'
    const preferencesPath = '/src/stores/preferences.ts'
    const layoutPath = '/src/stores/layout.ts'
    const { useEditorStore } = await import(editorPath)
    const { usePreferencesStore } = await import(preferencesPath)
    const { useLayoutStore } = await import(layoutPath)
    Object.assign(usePreferencesStore(), {
      theme, language: 'en', autoSave: false, focus: false, typewriter: false,
      tabBarVisibility: true, sideBarVisibility: true, toolBarVisibility: true, statusBarVisibility: true,
    })
    const editor = useEditorStore()
    editor.sourceCodeMode = false
    editor.tabs = []
    for (let index = 0; index < count; index++) {
      const tab = editor.newUntitledTab(`# Note ${index + 1}\n\nA saved document.`)
      tab.filename = `Long document name ${index + 1} — 写作与知识整理的长期研究笔记.md`
      tab.pathname = `C:/tabs-overflow/${tab.filename}`
      tab.isSaved = true
      tab.pendingBaselineUpdate = true
    }
    const layout = useLayoutStore()
    layout.showInspector = window.innerWidth > 1180
    layout.inspectorPanel = 'outline'
    layout.navigationPanel = window.innerWidth > 900 ? 'files' : ''
  }, { count, theme })
  await expect(page.locator('.tab-shell')).toHaveCount(count)
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
}

async function activeTabIsFullyVisible(page: Page) {
  await expect.poll(() => page.locator('.tab-shell.active').evaluate(element => {
    const tab = element.getBoundingClientRect()
    const viewport = element.parentElement!.getBoundingClientRect()
    const close = element.querySelector('.close')!.getBoundingClientRect()
    return tab.left >= viewport.left - 1 && tab.right <= viewport.right + 1
      && close.left >= viewport.left - 1 && close.right <= viewport.right + 1
  })).toBe(true)
  await expect(page.locator('.tab-shell.active .close')).toBeInViewport()
}

async function visibleCloseGeometry(page: Page) {
  return page.locator('.tabs-scroll').evaluate(element => {
    const viewport = element.getBoundingClientRect()
    return Array.from(element.querySelectorAll<HTMLElement>('.tab-shell')).map(shell => {
      const tab = shell.getBoundingClientRect()
      const closeButton = shell.querySelector<HTMLButtonElement>('.close')!
      const close = closeButton.getBoundingClientRect()
      const label = shell.querySelector('.label')!.getBoundingClientRect()
      const visibleWidth = Math.max(0, Math.min(viewport.right, tab.right) - Math.max(viewport.left, tab.left))
      const hit = document.elementFromPoint(close.left + close.width / 2, close.top + close.height / 2)
      return {
        visibleWidth, width: tab.width, closeWidth: close.width, labelWidth: label.width,
        // A tiny clipped sliver does not expose a usable tab. Every readable
        // edge tab must still expose its complete reserved close control.
        readable: visibleWidth >= 48,
        closeInsideShell: close.left >= tab.left - 1 && close.right <= tab.right + 1,
        closeInsideViewport: close.left >= viewport.left - 1 && close.right <= viewport.right + 1,
        closeHitTarget: hit === closeButton || closeButton.contains(hit),
        opacity: getComputedStyle(closeButton).opacity,
      }
    })
  })
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of [800, 1024, 1440]) {
    test(`${theme} ${width}px keeps close controls usable with 4, 8 and 12 long document tabs`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 800 })
      await page.goto('/')
      await page.locator('.muya-host [contenteditable="true"]').waitFor()
      for (const count of [4, 8, 12]) {
        await seedTabs(page, count, theme)
        await activeTabIsFullyVisible(page)
        await expect(page.locator('.scroll-tabs-previous')).toBeEnabled()
        const endPosition = await page.locator('.tabs-scroll').evaluate(element => element.scrollLeft)
        expect(endPosition).toBeGreaterThan(0)
        await page.locator('.scroll-tabs-previous').click()
        await expect.poll(() => page.locator('.tabs-scroll').evaluate(element => element.scrollLeft)).toBeLessThan(endPosition)
        await page.locator('.tabs-scroll').evaluate(element => { element.scrollLeft = 0 })
        await expect(page.locator('.scroll-tabs-next')).toBeEnabled()

        const geometry = await visibleCloseGeometry(page)
        for (const tab of geometry.filter(tab => tab.readable)) {
          expect(tab.closeWidth).toBeGreaterThanOrEqual(24)
          expect(tab.labelWidth).toBeGreaterThan(40)
          expect(tab.closeInsideShell).toBe(true)
          expect(tab.closeInsideViewport).toBe(true)
          expect(tab.closeHitTarget).toBe(true)
          expect(tab.opacity).toBe('1')
        }
        await testInfo.attach(`${theme}-${width}-${count}-geometry`, { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' })

        await page.locator('.scroll-tabs-next').click()
        await expect.poll(() => page.locator('.tabs-scroll').evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
        // An external file-open selection also reveals the selected tab.
        await page.evaluate(async () => {
          const path = '/src/stores/editor.ts'
          const editor = (await import(path)).useEditorStore()
          editor.setCurrent(editor.tabs[0].id)
        })
        await activeTabIsFullyVisible(page)
        await page.locator('.tab[aria-selected="true"]').press('End')
        await activeTabIsFullyVisible(page)
        await expect(page.locator('.tab[aria-selected="true"]')).toContainText(`name ${count} —`)
        await page.locator('.tab-shell.active .close').click()
        await expect(page.locator('.tab-shell')).toHaveCount(count - 1)
        await activeTabIsFullyVisible(page)
        expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false)
        await expect(page.locator('.new-tab')).toBeInViewport()
        await expect(page.locator('.document-actions .agent-action')).toBeInViewport()
      }
      await page.screenshot({ path: `output/design/review-fixes/tabs-tests/after-${theme}-${width}-12.png` })
    })
  }
}

test('overflow tabs preserve keyboard selection, drag order and dirty-close decisions', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 800 })
  await page.goto('/')
  await page.locator('.muya-host [contenteditable="true"]').waitFor()
  await seedTabs(page, 8, 'light')
  await activeTabIsFullyVisible(page)
  await page.locator('.tab[aria-selected="true"]').press('Home')
  await activeTabIsFullyVisible(page)
  await expect(page.locator('.tab[aria-selected="true"]')).toContainText('name 1 —')
  const firstTwo = await page.locator('.tab .label').allTextContents()
  await page.locator('.tab-shell').nth(0).dragTo(page.locator('.tab-shell').nth(1))
  await expect.poll(() => page.locator('.tab .label').allTextContents()).toEqual([firstTwo[1], firstTwo[0], ...firstTwo.slice(2)])
  await activeTabIsFullyVisible(page)
  await page.locator('.tab[aria-selected="true"]').press('End')
  await page.locator('.tab[aria-selected="true"]').press('ArrowLeft')
  await expect(page.locator('.tab[aria-selected="true"]')).toContainText('name 7 —')
  await activeTabIsFullyVisible(page)

  const editable = page.locator('.muya-host [contenteditable="true"]')
  await editable.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' unsaved overflow draft')
  await page.locator('.tab-shell.active .close').click()
  await expect(page.locator('.el-message-box')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.el-message-box')).toBeHidden()
  await expect(page.locator('.tab-shell')).toHaveCount(8)
  await expect(editable).toContainText('unsaved overflow draft')
  await activeTabIsFullyVisible(page)
  await page.locator('.tab-shell.active .close').click()
  await page.locator('.el-message-box').getByRole('button', { name: "Don't Save", exact: true }).click()
  await expect(page.locator('.tab-shell')).toHaveCount(7)
  await activeTabIsFullyVisible(page)
  await page.locator('.tab-shell.active').click({ button: 'middle' })
  await expect(page.locator('.tab-shell')).toHaveCount(6)
  await activeTabIsFullyVisible(page)
  await page.locator('.tab[aria-selected="true"]').press('Delete')
  await expect(page.locator('.tab-shell')).toHaveCount(5)
  await activeTabIsFullyVisible(page)
})

test('resizing the editor continues to reveal the active tab and its close control', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 })
  await page.goto('/')
  await page.locator('.muya-host [contenteditable="true"]').waitFor()
  await seedTabs(page, 12, 'dark')
  for (const width of [1440, 800, 1024, 1440]) {
    await page.setViewportSize({ width, height: 800 })
    await activeTabIsFullyVisible(page)
    await expect(page.locator('.tab[aria-selected="true"]')).toContainText('name 12 —')
  }
})
