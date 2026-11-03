import { expect, test, type Page } from '@playwright/test'

async function documents(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/stores/editor.ts'
    const editor = (await import(path)).useEditorStore()
    return {
      paths: editor.tabs.map((tab: { pathname: string }) => tab.pathname),
      current: editor.currentFile?.pathname ?? null,
      home: editor.homeActive,
    }
  })
}

test('direct startup selects Home and only creates a document on request', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.home-tab [role="tab"]')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.welcome-panel')).toBeVisible()
  expect(await documents(page)).toEqual({ paths: [], current: null, home: true })
  await expect(page.locator('.tabs-bar [role="tab"]')).toHaveCount(1)

  await page.locator('.welcome-actions .primary').click()
  await expect(page.getByRole('tab', { name: 'Untitled-1', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.muya-host [contenteditable="true"]')).toBeVisible()
  expect(await documents(page)).toEqual({ paths: [''], current: '', home: false })
})

test('saved split layout keeps Home selected when no documents are restored', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('mt:panes', JSON.stringify({
    version: 1, direction: 'horizontal', ratio: 0.5, activeIndex: 1,
    panes: [{ path: 'C:/notes/old.md', sourceMode: false }, { path: '', sourceMode: true }],
  })))
  await page.goto('/')
  await expect(page.locator('.home-tab [role="tab"]')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.welcome-panel')).toBeVisible()
  expect(await documents(page)).toEqual({ paths: [], current: null, home: true })
  await page.locator('.welcome-actions .primary').click()
  await expect(page.locator('.editing-region.active .source-pane')).toBeVisible()
})

// Exercise the real renderer startup sequence with the OS queue and disk IPC
// stubbed. Native argv/second-instance delivery is covered by the native script.
for (const restore of [false, true]) {
  test(`queued launch files select the requested document without an Untitled tab (restore=${restore})`, async ({ page }) => {
    const paths = ['C:/notes/首次 中文 file.md', 'C:/notes/second.md']
    await page.route('**/src/services/tauri-invoke.ts*', route => route.request().url().includes('startup-original')
      ? route.continue()
      : route.fulfill({ contentType: 'text/javascript', body: `
        export * from '/src/services/tauri-invoke.ts?startup-original';
        export const getPreferences = async () => ({ startUpAction: ${JSON.stringify(restore ? 'lastState' : 'blank')} });
        export const getEditorSession = async () => (${restore ? JSON.stringify({
          version: 1, cleanShutdown: true, timestamp: 1, activeTabIndex: 0,
          tabs: [{ dirty: false, path: 'C:/notes/restored.md', sourceMode: false }],
        }) : 'null'});
        let queue = ${JSON.stringify(paths)};
        export const takePendingOpenFiles = async () => { const paths = queue; queue = []; return paths; };
        export const readMarkdown = async path => {
          if (path === ${JSON.stringify(paths[0])}) await new Promise(resolve => { globalThis.releaseLaunchRead = resolve; });
          return { path, markdown: '# Launch document', encoding: 'UTF-8', lineEnding: 'lf', bom: false, hadDecodeErrors: false };
        };
      ` }))
    await page.goto('/')
    await page.waitForFunction(() => typeof (window as unknown as { releaseLaunchRead?: unknown }).releaseLaunchRead === 'function')
    expect((await documents(page)).paths).toEqual(restore ? ['C:/notes/restored.md'] : [])
    await page.evaluate(() => (window as unknown as { releaseLaunchRead: () => void }).releaseLaunchRead())
    await expect.poll(() => documents(page)).toEqual({
      paths: [...(restore ? ['C:/notes/restored.md'] : []), ...paths], current: paths[1], home: false,
    })
    await expect(page.locator('.welcome-panel')).toHaveCount(0)
    await expect(page.locator('.tabs-bar')).not.toContainText('Untitled')
    await expect(page.locator('.editing-region.active')).toContainText('Launch document')
  })
}

test('a failed launch file leaves Home available without creating a blank document', async ({ page }) => {
  await page.route('**/src/services/tauri-invoke.ts*', route => route.request().url().includes('startup-original')
    ? route.continue()
    : route.fulfill({ contentType: 'text/javascript', body: `
      export * from '/src/services/tauri-invoke.ts?startup-original';
      export const takePendingOpenFiles = async () => ['C:/notes/missing.md'];
      export const readMarkdown = async () => { throw new Error('Launch file is missing'); };
    ` }))
  await page.goto('/')
  await expect(page.locator('.el-notification')).toContainText('Launch file is missing')
  await expect(page.locator('.home-tab [role="tab"]')).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.welcome-panel')).toBeVisible()
  expect(await documents(page)).toEqual({ paths: [], current: null, home: true })
})
