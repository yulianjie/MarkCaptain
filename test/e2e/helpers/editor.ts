import type { Page } from '@playwright/test'

/** Editing scenarios explicitly create their document from the startup Home. */
export async function startWithNewDocument(page: Page) {
  await page.goto('/')
  await page.locator('.home-tab [aria-selected="true"]').waitFor()
  await page.locator('.welcome-actions .primary').click()
  // These scenarios exercise document tabs without a background Home tab.
  await page.locator('.home-tab .close').click()
  await page.locator('.muya-host [contenteditable="true"]').first().waitFor()
}
