import { expect, test, type Page } from '@playwright/test'

async function setup(page: Page, href = 'M2_REVIEW_FIXES.md') {
  await page.route('**/src/services/tauri-invoke.ts*', route => route.request().url().includes('link-original') ? route.continue() : route.fulfill({
    contentType: 'text/javascript', body: `
      export * from '/src/services/tauri-invoke.ts?link-original';
      export const readMarkdown = async path => {
        (globalThis.__linkReads ??= []).push(path);
        if (path.endsWith('missing.md')) throw new Error('Linked document not found');
        return { path, markdown:'# Fixes\\n\\n整改记录正文\\n', encoding:'utf8', lineEnding:'lf', bom:false, hadDecodeErrors:false };
      };
    `,
  }))
  await page.route('**/node_modules/.vite/deps/@tauri-apps_plugin-shell.js*', route => route.fulfill({
    contentType: 'text/javascript', body: 'export const open = async href => { (globalThis.__externalLinks ??= []).push(href) }',
  }))
  await page.goto('/')
  await page.locator('.muya-host [contenteditable="true"]').waitFor()
  await page.evaluate(async href => {
    const path = '/src/stores/editor.ts'
    const editor = (await import(path)).useEditorStore()
    const tab = editor.newUntitledTab(`[审查整改记录](${href})\n\nSource paragraph\n`)
    tab.pathname = 'C:/project/docs/README.md'
    tab.filename = 'README.md'
    tab.pendingBaselineUpdate = false
  }, href)
  await expect(page.locator('.muya-host a[href]').first()).toHaveAttribute('href', href)
}

async function currentPath(page: Page) {
  return page.evaluate(async () => { const path = '/src/stores/editor.ts'; return (await import(path)).useEditorStore().currentFile?.pathname })
}

test('plain click edits the link without opening a tauri.localhost/browser page', async ({ page, context }) => {
  await setup(page)
  const pages = context.pages().length
  await page.locator('.muya-host a[href]').first().click()
  await expect.poll(() => currentPath(page)).toBe('C:/project/docs/README.md')
  expect(context.pages()).toHaveLength(pages)
  expect(page.url()).toBe('http://localhost:1420/#/')
})

for (const [href, expectedPath] of [
  ['M2_REVIEW_FIXES.md', 'C:/project/docs/M2_REVIEW_FIXES.md'],
  ['../审查%20记录.md#Fixes', 'C:/project/审查 记录.md'],
] as const) {
  test(`Ctrl-click opens ${href} in the editor without a project`, async ({ page, context }) => {
    await setup(page, href)
    const pages = context.pages().length
    await page.locator('.muya-host a[href]').first().hover()
    await expect(page.locator('.ag-link-tools').locator('..')).toHaveAttribute('x-placement', /.+/)
    await page.locator('.muya-host a[href]').first().click({ modifiers: ['Control'] })
    await expect.poll(() => currentPath(page)).toBe(expectedPath)
    await expect(page.locator('.muya-host')).toContainText('整改记录正文')
    await expect(page.locator('.ag-link-tools').locator('..')).not.toHaveAttribute('x-placement', /.+/)
    expect(context.pages()).toHaveLength(pages)
    expect(page.url()).toBe('http://localhost:1420/#/')
    expect(await page.evaluate(() => (globalThis as typeof globalThis & { __linkReads: string[] }).__linkReads)).toEqual([expectedPath])
  })
}

test('the link popup opens the same relative document', async ({ page }) => {
  await setup(page)
  await page.locator('.muya-host a[href]').first().hover()
  await page.locator('.ag-link-tools .jump').click()
  await expect.poll(() => currentPath(page)).toBe('C:/project/docs/M2_REVIEW_FIXES.md')
})

test('source mode opens a relative document without a project', async ({ page }) => {
  await setup(page)
  await page.evaluate(async () => { const path = '/src/stores/editor.ts'; (await import(path)).useEditorStore().sourceCodeMode = true })
  await page.locator('.cm-line').filter({ hasText: '审查整改记录' }).click({ modifiers: ['Control'], position: { x: 30, y: 8 } })
  await expect.poll(() => currentPath(page)).toBe('C:/project/docs/M2_REVIEW_FIXES.md')
  await expect(page.locator('.cm-content')).toContainText('整改记录正文')
})

test('missing documents leave the editor open and report the failure', async ({ page, context }) => {
  await setup(page, 'missing.md')
  const pages = context.pages().length
  await page.locator('.muya-host a[href]').first().click({ modifiers: ['Control'] })
  await expect(page.getByText('Error: Linked document not found', { exact: true })).toBeVisible()
  expect(await currentPath(page)).toBe('C:/project/docs/README.md')
  expect(context.pages()).toHaveLength(pages)
})

test('web links still open through the system shell exactly once', async ({ page, context }) => {
  await setup(page, 'https://example.com/review')
  const pages = context.pages().length
  await page.locator('.muya-host a[href]').first().click({ modifiers: ['Control'] })
  await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & { __externalLinks?: string[] }).__externalLinks)).toEqual(['https://example.com/review'])
  expect(await currentPath(page)).toBe('C:/project/docs/README.md')
  expect(context.pages()).toHaveLength(pages)
})
