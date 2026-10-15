import { expect, test } from '@playwright/test'

test.describe('preferences window', () => {
  test.use({ viewport: { width: 900, height: 700 } })

  test('is keyboard navigable at the native window size', async ({ page }) => {
    await page.goto('/#/preferences')

    const generalTab = page.locator('#prefs-tab-general')
    const editorTab = page.locator('#prefs-tab-editor')
    await expect(generalTab).toBeVisible()
    await expect(page.locator('#prefs-panel-general')).toBeVisible()

    await generalTab.focus()
    await page.keyboard.press('ArrowDown')
    await expect(editorTab).toBeFocused()
    await expect(editorTab).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('#prefs-panel-editor')).toBeVisible()

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )
    expect(hasHorizontalOverflow).toBe(false)
  })

  test('resets the content scroll position when changing sections', async ({ page }) => {
    await page.goto('/#/preferences')
    const body = page.locator('.prefs-body')
    await expect(body).toBeVisible()

    await body.evaluate(element => { element.scrollTop = element.scrollHeight })
    expect(await body.evaluate(element => element.scrollTop)).toBeGreaterThan(0)

    await page.locator('#prefs-tab-editor').click()
    await expect.poll(() => body.evaluate(element => element.scrollTop)).toBe(0)
  })
  test('localizes every new notebook shortcut label in all three languages', async ({ page }) => {
    await page.goto('/#/preferences'); await page.locator('#prefs-tab-keybindings').click()
    for (const [locale, labels] of [['en', ['Quick open note', "Open today's note", 'Insert document template']], ['zh-CN', ['快速打开笔记', '打开今日笔记', '插入文档模板']], ['ja', ['ノートを素早く開く', '今日のノートを開く', '文書テンプレートを挿入']]] as const) {
      await page.evaluate(async locale => { const path = '/src/i18n/index.ts'; const prefs = '/src/stores/preferences.ts'; (await import(prefs)).usePreferencesStore().language = locale; (await import(path)).setLocale(locale) }, locale)
      for (const label of labels) await expect(page.locator('#prefs-panel-keybindings')).toContainText(label)
    }
  })
})
