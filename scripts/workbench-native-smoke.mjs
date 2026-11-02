#!/usr/bin/env node
// Run against an already-running, isolated workbench-validation WebView2.
// Never install, close, or modify the user's ordinary MarkCaptain profile.
// Launch instructions: docs/UI_WORKBENCH_REDESIGN.md.
import assert from 'node:assert/strict'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium, expect } from '@playwright/test'

const expectedIdentifier = 'io.github.yulianjie.markcaptain.workbench-validation'
const cdpUrl = process.env.WORKBENCH_CDP_URL || 'http://127.0.0.1:9348'
const root = await realpath('.')
const output = path.join(root, 'output', 'design', 'workbench')
await mkdir(output, { recursive: true })
assert((await realpath(output)).toLowerCase().startsWith(root.toLowerCase() + path.sep))
const run = new Date().toISOString().replace(/[:.]/g, '-')
const notes = path.join(output, `native-notes-${run}`)
await mkdir(notes)
const file = path.join(notes, '写作验证.md')
const markdown = '# 让知识自然生长\n\n原生 WebView2 界面验证。\n\n'
  + Array.from({ length: 36 }, (_, i) => `## 第 ${i + 1} 节：记录与连接\n\n好的笔记不必一次完成。保留一段观察，再慢慢补充自己的理解。\n\n`).join('')
await writeFile(file, markdown, 'utf8')

const browser = await chromium.connectOverCDP(cdpUrl)
const page = browser.contexts().flatMap(c => c.pages()).find(p => /localhost:1420\/#\/?$/.test(p.url()))
assert(page, 'Expected the isolated development editor')
const identifier = await page.evaluate(async () => {
  const app = await import('/node_modules/@tauri-apps/api/app.js')
  return app.getIdentifier()
})
assert.equal(identifier, expectedIdentifier, 'Refuse to exercise the ordinary application profile')
const report = { identifier, cdpUrl, success: false, native: true, backendMocked: false, viewportMethod: 'WebView2 CDP device metrics; native window permissions unchanged', file, checks: [], screenshots: [], pageErrors: [] }
const viewportSession = await page.context().newCDPSession(page)
page.on('pageerror', error => report.pageErrors.push(error.message))
const check = (name, detail) => { report.checks.push({ name, detail }); console.log(name) }
async function resize(width, height) {
  // Exercise responsive layout in the real WebView2 without granting the
  // application additional native window permissions just for this check.
  await viewportSession.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  })
  await page.waitForTimeout(250)
}
async function screenshot(name, target = page) {
  const destination = path.join(output, `${name}.png`)
  await target.screenshot({ path: destination, animations: 'disabled' })
  report.screenshots.push(destination)
}

try {
  await resize(1440, 900)
  await page.evaluate(async ({ file, notes }) => {
    const { usePreferencesStore } = await import('/src/stores/preferences.ts')
    const { useEditorStore } = await import('/src/stores/editor.ts')
    const { useProjectStore } = await import('/src/stores/project.ts')
    const prefs = usePreferencesStore()
    await prefs.patch({ language: 'zh-CN', theme: 'light', autoSwitchTheme: 2, autoSave: false,
      fontSize: 16, editorLineWidth: '720px', sideBarVisibility: true, tabBarVisibility: true,
      toolBarVisibility: false, statusBarVisibility: true })
    await useProjectStore().openRoot(notes)
    await useEditorStore().openFile(file)
  }, { file, notes })
  await expect(page.locator('.muya-host h1')).toContainText('让知识自然生长')
  check('native file opened with real filesystem IPC')

  for (const [width, height, theme] of [[1440, 900, 'light'], [1280, 800, 'dark'], [1024, 768, 'light'], [800, 600, 'dark']]) {
    await resize(width, height)
    await page.evaluate(async theme => {
      const { usePreferencesStore } = await import('/src/stores/preferences.ts')
      const { useLayoutStore } = await import('/src/stores/layout.ts')
      await usePreferencesStore().set('theme', theme)
      const layout = useLayoutStore()
      layout.setNavigationPanel(window.innerWidth <= 900 ? '' : 'files')
      layout.setInspectorPanel('outline')
      layout.showInspector = true
    }, theme)
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(page.locator('.toc-row')).toHaveCount(37)
    await expect(page.locator('.toc-progress')).toBeInViewport()
    const geometry = await page.evaluate(() => {
      const pane = document.querySelector('.toc-pane').getBoundingClientRect()
      const footer = document.querySelector('.toc-progress').getBoundingClientRect()
      const list = document.querySelector('.toc-list')
      return { viewport: [innerWidth, innerHeight], footerBottomInset: pane.bottom - footer.bottom,
        footerInside: footer.bottom <= innerHeight && footer.top >= pane.top,
        listScrollable: list.scrollHeight > list.clientHeight,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth }
    })
    assert(geometry.footerInside)
    assert(Math.abs(geometry.footerBottomInset) <= 1)
    assert(geometry.listScrollable)
    assert(!geometry.horizontalOverflow)
    const before = (await page.locator('.toc-progress').boundingBox()).y
    await page.locator('.toc-list').evaluate(el => { el.scrollTop = el.scrollHeight })
    assert.equal((await page.locator('.toc-progress').boundingBox()).y, before)
    check(`native ${width}x${height} ${theme} outline footer and scrolling`, geometry)
    await screenshot(`native-${theme}-${width}`)
  }

  await resize(1280, 900)
  await page.evaluate(async () => {
    const { useLayoutStore } = await import('/src/stores/layout.ts')
    useLayoutStore().showInspector = false
  })
  const editable = page.locator('.editing-region.active .muya-host [contenteditable=true]')
  await editable.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nNative workbench save check.')
  await page.keyboard.press('Control+s')
  await expect.poll(async () => (await readFile(file, 'utf8')).includes('Native workbench save check.')).toBe(true)
  check('real native edit and Ctrl+S persisted only the validation document')
  await page.evaluate(async () => (await import('/src/stores/editor.ts')).useEditorStore().sourceCodeMode = true)
  await expect(page.locator('.cm-content').first()).toContainText('Native workbench save check.')
  await page.evaluate(async () => (await import('/src/stores/editor.ts')).useEditorStore().sourceCodeMode = false)
  await expect(editable).toContainText('Native workbench save check.')
  check('native source and visual editors retain saved content')

  await page.evaluate(async () => {
    const { bus } = await import('/src/bus.ts')
    bus.emit('show-export-dialog', { format: 'html' })
  })
  await expect(page.locator('.export-dialog')).toBeVisible()
  await page.locator('.export-dialog').getByRole('button', { name: '预览', exact: true }).click()
  await expect(page.locator('.preview-frame').contentFrame().locator('body')).toContainText('让知识自然生长')
  await expect(page.locator('.export-footer-actions')).toBeInViewport()
  await screenshot('native-export-dark')
  check('native export preflight and isolated HTML preview; no file export or system print invoked')
  await page.locator('.export-dialog .el-dialog__headerbtn').click()
  await expect(page.locator('.export-dialog')).toBeHidden()

  await page.evaluate(async () => (await import('/src/services/tauri-invoke.ts')).openSettings())
  let settings
  await expect.poll(() => {
    settings = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('/preferences'))
    return !!settings
  }).toBe(true)
  await expect(settings.locator('.prefs-page')).toBeVisible()
  await settings.locator('#prefs-tab-theme').click()
  await screenshot('native-preferences-dark', settings)
  check('native preferences window loaded the shared dark theme')

  assert.deepEqual(report.pageErrors, [])
  report.success = true
} finally {
  await writeFile(path.join(output, 'native-receipt.json'), JSON.stringify(report, null, 2) + '\n')
  await viewportSession.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
  // Disconnect CDP, leaving the isolated preview open for the user.
  await browser.close()
}
