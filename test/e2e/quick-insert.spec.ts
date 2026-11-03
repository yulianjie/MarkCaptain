import { startWithNewDocument } from './helpers/editor'
import { expect, test, type Page } from '@playwright/test'

async function setPreferences(page: Page, values: Record<string, unknown>) {
  await page.evaluate(async prefs => {
    const path = '/src/stores/preferences.ts'
    const { usePreferencesStore } = await import(path)
    usePreferencesStore().$patch(prefs)
  }, values)
}

async function seed(page: Page) {
  await startWithNewDocument(page)
  await page.locator('.muya-host [contenteditable="true"]').waitFor()
  await setPreferences(page, { language: 'zh-CN', hideQuickInsertHint: false, autoSave: false })
  await page.evaluate(async () => {
    const editorPath = '/src/stores/editor.ts'
    const layoutPath = '/src/stores/layout.ts'
    const { useEditorStore } = await import(editorPath)
    const { useLayoutStore } = await import(layoutPath)
    useEditorStore().newUntitledTab('')
    useLayoutStore().showSideBar = true
    useLayoutStore().setSideBarWidth(310)
    useLayoutStore().rightColumn = 'toc'
  })
  await page.locator('.ag-paragraph-content').click()
}

const hint = (page: Page) => page.locator('.ag-active > .ag-paragraph-content').first()

async function expectHint(page: Page, text: string) {
  await expect.poll(() => hint(page).evaluate(el => getComputedStyle(el, '::after').content)).toBe(JSON.stringify(text))
}

test('compact editor keeps the paragraph control and hint within the scroll area', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 930 })
  await seed(page)
  await page.screenshot({ path: 'output/design/quick-insert-compact.png' })
  for (const width of [1200, 800]) {
    await page.setViewportSize({ width, height: 930 })
    for (const fontSize of [16, 24]) {
      await setPreferences(page, { fontSize })
      const host = await page.locator('.muya-host').boundingBox()
      const control = page.locator('.ag-active .ag-front-icon').first()
      const bounds = await control.boundingBox()
      expect(bounds!.x, `paragraph control at ${width}px / ${fontSize}px font`).toBeGreaterThanOrEqual(host!.x + 8)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(host!.x + host!.width)
      expect(await control.evaluate(el => {
        const rect = el.getBoundingClientRect()
        return el.contains(document.elementFromPoint(rect.left + 1, rect.top + rect.height / 2))
      })).toBe(true)
      await expectHint(page, '输入 @ 插入内容')
      expect(await page.locator('.muya-host').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    }
  }
  await page.locator('.sidebar-toggle').click()
  await expect(page.locator('.side-bar')).toHaveCount(0)
  await page.locator('.ag-active .ag-front-icon').click()
  await expect(page.locator('.ag-front-menu')).toBeVisible()
})

test('quick insert switches every label live and accepts translated and English searches', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 930 })
  await seed(page)
  await page.keyboard.type('@')
  const menu = page.locator('.ag-quick-insert')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.title')).toHaveText(['基础块', '标题', '高级块', '列表', '图表'])
  await expect(menu.locator('[data-label="paragraph"] .big-title')).toHaveText('正文')
  await expect(menu.locator('[data-label="paragraph"] .sub-title')).toHaveText('普通文本段落')
  await expect(menu).not.toContainText('Lorem Ipsum')
  await expect(menu.locator('..')).toHaveCSS('opacity', '1')
  await page.screenshot({ path: 'output/design/quick-insert-zh-CN.png' })

  await setPreferences(page, { language: 'ja' })
  await expect(menu.locator('[data-label="paragraph"] .big-title')).toHaveText('段落')
  await expect(menu.locator('.title').first()).toHaveText('基本ブロック')
  await setPreferences(page, { language: 'en' })
  await expect(menu.locator('[data-label="paragraph"] .big-title')).toHaveText('Paragraph')
  await expect(menu.locator('.title').first()).toHaveText('BASIC BLOCKS')
  await expect(page.locator('.ag-paragraph-content')).toHaveText('@')
  await setPreferences(page, { language: 'zh-CN' })
  await page.keyboard.insertText('标题')
  await expect(menu.locator('.item')).toHaveCount(6)
  await expect(menu.locator('.big-title').first()).toHaveText('标题 1')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.locator('.muya-host h2.ag-paragraph')).toBeVisible()

  await page.keyboard.type('Keep this heading')
  await page.keyboard.press('Enter')
  await page.keyboard.type('@code')
  await expect(menu.locator('[data-label="pre"] .big-title')).toHaveText('代码块')
  await setPreferences(page, { language: 'ja' })
  await expect(menu.locator('[data-label="pre"] .big-title')).toHaveText('コードブロック')
  await expect(page.locator('.muya-host h2')).toContainText('Keep this heading')
  await expect(page.locator('.ag-active .ag-paragraph-content')).toHaveText('@code')
  await setPreferences(page, { language: 'zh-CN' })
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await page.keyboard.type('@zzzznomatch')
  await expect(menu.locator('.no-result')).toHaveText('没有匹配的内容')
  await page.keyboard.press('Enter')
  await expect(page.locator('.muya-host')).toContainText('@zzzznomatch')
})

test('translated descriptions fit beside shortcuts and the whole menu remains reachable', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 700 })
  await seed(page)
  await page.keyboard.type('@')
  const menu = page.locator('.ag-quick-insert')
  await expect(menu.locator('.short-cut')).toHaveCount(6)
  expect(await menu.locator('.short-cut').allTextContents()).toEqual([
    'Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+4', 'Ctrl+5', 'Ctrl+6',
  ])
  for (const language of ['zh-CN', 'ja', 'en']) {
    await setPreferences(page, { language })
    await expect(menu.locator('.item')).toHaveCount(22)
    await expect(menu.locator('..')).toHaveAttribute('x-placement', /.+/)
    const rowsFit = await menu.locator('.item').evaluateAll(items => items.every(item => {
      const description = item.querySelector<HTMLElement>('.description')!
      const shortcut = item.querySelector('.short-cut')?.getBoundingClientRect()
      const text = description.getBoundingClientRect()
      return description.scrollWidth <= description.clientWidth + 1
        && (!shortcut || text.right <= shortcut.left)
    }))
    expect(rowsFit).toBe(true)
    expect(await menu.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    await menu.locator('.item').last().scrollIntoViewIfNeeded()
    const bounds = await menu.boundingBox()
    const last = await menu.locator('.item').last().boundingBox()
    expect(last!.y + last!.height).toBeLessThanOrEqual(bounds!.y + bounds!.height)
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(800)
  }
  await setPreferences(page, { language: 'zh-CN', theme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  // Theme changes rerender Muya and dismiss its floats; reopen from the document.
  await page.locator('.ag-paragraph-content').click()
  await page.keyboard.press('End')
  await page.keyboard.press('Backspace')
  await page.keyboard.type('@')
  await expect(menu.locator('.title').first()).toHaveText('基础块')
  await menu.locator('[data-label="paragraph"]').scrollIntoViewIfNeeded()
  await expect(menu.locator('..')).toHaveCSS('opacity', '1')
  await page.screenshot({ path: 'output/design/quick-insert-dark-800.png' })
})

test('empty hint follows the locale and the hide-hint preference', async ({ page }) => {
  await seed(page)
  for (const [language, text] of [['zh-CN', '输入 @ 插入内容'], ['ja', '@ を入力して挿入'], ['en', 'Type @ to insert']]) {
    await setPreferences(page, { language })
    await expectHint(page, text)
  }
  await setPreferences(page, { hideQuickInsertHint: true })
  await expect(page.locator('.ag-show-quick-insert-hint')).toHaveCount(0)
  await setPreferences(page, { hideQuickInsertHint: false })
  await expectHint(page, 'Type @ to insert')
})
