import { expect, test, type Page } from '@playwright/test'

async function setup(page: Page, href = 'M2_REVIEW_FIXES.md') {
  // Match tauri-plugin-shell's injected body listener, including its lack of a
  // defaultPrevented check. A normal browser alone cannot catch this regression.
  await page.addInitScript(() => {
    const state = globalThis as typeof globalThis & { __nativeShellOpens: string[] }
    state.__nativeShellOpens = []
    document.addEventListener('DOMContentLoaded', () => document.body.addEventListener('click', event => {
      const anchor = event.target instanceof Element ? event.target.closest('a') : null
      if (anchor instanceof HTMLAnchorElement && anchor.target === '_blank' && /^(https?:|mailto:|tel:)/.test(anchor.href)) {
        state.__nativeShellOpens.push(anchor.href)
        event.preventDefault()
      }
    }))
  })
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
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { __nativeShellOpens: string[] }).__nativeShellOpens)).toEqual([])
})

test('plain click on a missing file never reaches the native shell listener', async ({ page, context }) => {
  await setup(page, 'missing.md')
  const pages = context.pages().length
  await page.locator('.muya-host a[href]').first().click()
  expect(await page.evaluate(() => (globalThis as typeof globalThis & { __nativeShellOpens: string[] }).__nativeShellOpens)).toEqual([])
  expect(await currentPath(page)).toBe('C:/project/docs/README.md')
  expect(context.pages()).toHaveLength(pages)
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

for (const activation of ['Ctrl-click', 'popup jump'] as const) {
  test(`a same-document Chinese heading anchor scrolls into view via ${activation}`, async ({ page }) => {
    await setup(page, '#19-术语表遇到缩写时回来查')
    await page.evaluate(async () => {
      const path = '/src/stores/editor.ts'
      const editor = (await import(path)).useEditorStore()
      const markdown = '# Start\n\n[术语表：遇到缩写时回来查](#19-术语表遇到缩写时回来查)\n\n'
        + Array.from({ length: 55 }, (_, i) => `Paragraph ${i + 1}: keep the target below the viewport.\n\n`).join('')
        + '## 19. 术语表：遇到缩写时回来查\n\nANCHOR_OK\n'
      editor.applyAgentEdit(editor.currentFileId, editor.currentFile.markdown, markdown)
    })
    const destination = page.locator('.muya-host h2').filter({ hasText: '19. 术语表' })
    await expect(destination).not.toBeInViewport()
    const before = await page.evaluate(async () => { const path = '/src/stores/editor.ts'; return (await import(path)).useEditorStore().currentFile.markdown })
    const link = page.getByRole('link', { name: '术语表：遇到缩写时回来查', exact: true })
    if (activation === 'Ctrl-click') await link.click({ modifiers: ['Control'] })
    else { await link.hover(); await page.locator('.ag-link-tools .jump').click() }
    await expect(destination).toBeInViewport()
    await expect(page.locator('.ag-link-tools').locator('..')).not.toHaveAttribute('x-placement', /.+/)
    expect(await currentPath(page)).toBe('C:/project/docs/README.md')
    expect(await page.evaluate(async () => { const path = '/src/stores/editor.ts'; return (await import(path)).useEditorStore().currentFile.markdown })).toBe(before)
  })
}
