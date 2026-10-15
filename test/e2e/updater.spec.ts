import { expect, test } from '@playwright/test'

test('update preference defaults on, persists through the store, and is localized', async ({ page }) => {
  await page.goto('/#/preferences')
  const control = page.locator('.el-form-item').filter({ hasText: 'Automatically check for updates' }).getByRole('switch')
  await expect(control).toHaveAttribute('aria-checked', 'true')
  await control.locator('..').click()
  await expect(control).toHaveAttribute('aria-checked', 'false')
  expect(await page.evaluate(async () => {
    const path = '/src/services/tauri-invoke.ts'
    return (await import(path)).getPreference('autoCheckUpdates')
  })).toBe(false)
  for (const [language, label] of [['zh-CN', '自动检查更新'], ['ja', '更新を自動確認'], ['en', 'Automatically check for updates']]) {
    await page.evaluate(async language => {
      const preferences = '/src/stores/preferences.ts'
      const i18n = '/src/i18n/index.ts'
      ;(await import(preferences)).usePreferencesStore().language = language
      ;(await import(i18n)).setLocale(language)
    }, language)
    await expect(page.locator('#prefs-panel-general')).toContainText(label)
  }
})
