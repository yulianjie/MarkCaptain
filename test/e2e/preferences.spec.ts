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

  test('suppresses the browser menu on settings chrome and keeps native text editing', async ({ page }) => {
    await page.goto('/#/preferences')
    await page.locator('#prefs-tab-editor').click()

    const panel = page.locator('#prefs-panel-editor')
    const fontSize = panel.getByRole('spinbutton').first()
    await expect(fontSize).toBeVisible()

    const contextMenuAllowed = (element: Element) => element.dispatchEvent(new MouseEvent('contextmenu', {
      button: 2, bubbles: true, cancelable: true,
    }))
    expect(await panel.evaluate(contextMenuAllowed)).toBe(false)
    expect(await panel.locator('input[type="checkbox"]').first().evaluate(contextMenuAllowed)).toBe(false)
    expect(await fontSize.evaluate(contextMenuAllowed)).toBe(true)
  })

  test('localizes every new notebook shortcut label in all three languages', async ({ page }) => {
    await page.goto('/#/preferences'); await page.locator('#prefs-tab-keybindings').click()
    for (const [locale, labels] of [['en', ['Quick open note', "Open today's note", 'Insert document template']], ['zh-CN', ['快速打开笔记', '打开今日笔记', '插入文档模板']], ['ja', ['ノートを素早く開く', '今日のノートを開く', '文書テンプレートを挿入']]] as const) {
      await page.evaluate(async locale => { const path = '/src/i18n/index.ts'; const prefs = '/src/stores/preferences.ts'; (await import(prefs)).usePreferencesStore().language = locale; (await import(path)).setLocale(locale) }, locale)
      for (const label of labels) await expect(page.locator('#prefs-panel-keybindings')).toContainText(label)
    }
  })

  test('theme cards persist preferences and follow system appearance', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    // Vite may serve the application's module with an HMR timestamp. Importing
    // the queryless URL would create a second module-local browser preference
    // cache and read unrelated empty state instead of the application's writes.
    const invokeModule = page.waitForResponse(response =>
      new URL(response.url()).pathname === '/src/services/tauri-invoke.ts',
    )
    await page.goto('/#/preferences')
    const invokeModuleUrl = (await invokeModule).url()
    await page.locator('#prefs-tab-theme').click()

    const persistedTheme = () => page.evaluate(async path => {
      const values = await (await import(path)).getPreferences()
      return { theme: values.theme, autoSwitchTheme: values.autoSwitchTheme }
    }, invokeModuleUrl)
    const dark = page.locator('.theme-choice-dark')
    const light = page.locator('.theme-choice-light')
    const system = page.locator('.theme-choice-system')
    const themeSelector = page.locator('#prefs-panel-theme .el-select').first()

    await dark.click()
    await expect(dark).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect.poll(persistedTheme).toEqual({ theme: 'dark', autoSwitchTheme: 2 })

    await system.click()
    await expect(system).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(persistedTheme).toEqual({ theme: 'dark', autoSwitchTheme: 1 })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(themeSelector.locator('.el-select__wrapper')).toHaveClass(/is-disabled/)
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    await light.click()
    await expect(light).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(persistedTheme).toEqual({ theme: 'light', autoSwitchTheme: 2 })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(themeSelector.locator('.el-select__wrapper')).not.toHaveClass(/is-disabled/)
  })

  test('keeps every settings section usable in a narrow window', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 740 })
    await page.goto('/#/preferences')
    const sections = ['general', 'editor', 'markdown', 'theme', 'image', 'cloud', 'spellchecker', 'view', 'search', 'keybindings']
    await expect(page.getByRole('tablist')).toHaveAttribute('aria-orientation', 'horizontal')
    for (const id of sections) {
      await page.locator(`#prefs-tab-${id}`).click()
      const panel = page.locator(`#prefs-panel-${id}`)
      await expect(panel).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
      expect(await page.locator('.prefs-body').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    }
  })
})
