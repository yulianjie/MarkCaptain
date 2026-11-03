import { startWithNewDocument } from './helpers/editor'
import { test, expect, type Page } from '@playwright/test'

const sample = [
  '# 把想法写下来',
  '一些零散的念头，和一个慢慢成形的计划。',
  '## 开始之前',
  '不必等到思路完整才开始。先记下一个句子、一段对话，或者今天观察到的小事。文字会带着我们找到下一步。',
  '> 好的记录，是给未来的自己留一条线索。',
  '## 让记录更轻一点',
  '用标题整理思路，用列表收集行动。留下一点空白，让新的想法随时有地方落下。',
  '## 下一步',
  '- [x] 整理这一周的灵感\n- [ ] 选一个值得继续展开的主题\n- [ ] 写下第一段，不急着修改',
].join('\n\n')

async function openDocument(page: Page) {
  await startWithNewDocument(page)
  await page.locator('.muya-host [contenteditable="true"]').waitFor()
  await page.evaluate(async markdown => {
    const editorPath = '/src/stores/editor.ts'
    const prefsPath = '/src/stores/preferences.ts'
    const { useEditorStore } = await import(editorPath)
    const { usePreferencesStore } = await import(prefsPath)
    const prefs = usePreferencesStore()
    Object.assign(prefs, {
      language: 'zh-CN', theme: 'light', editorLineWidth: '', autoSave: false,
      sideBarVisibility: true, tabBarVisibility: true, toolBarVisibility: true,
      statusBarVisibility: true, focus: false, typewriter: false,
    })
    const editor = useEditorStore()
    const tab = editor.newUntitledTab(markdown)
    tab.filename = '写作笔记.md'
    tab.pathname = 'C:\\Notes\\写作笔记.md'
    tab.isSaved = true
    tab.pendingBaselineUpdate = true
    editor.tabs = [tab]
  }, sample)
  if (page.viewportSize()!.width > 1180) await expect(page.locator('.toc-row')).toHaveCount(4)
  else await expect(page.locator('.document-inspector-rail')).toBeVisible()
}

test('writing layout retains usable document space and reachable controls at desktop and compact widths', async ({ page }) => {
  await openDocument(page)
  for (const width of [1440, 1280, 1024, 768]) {
    await page.setViewportSize({ width, height: 900 })
    for (const sidebar of [true, false]) {
      if (await page.locator('.sidebar-toggle').getAttribute('aria-expanded') !== String(sidebar)) {
        await page.locator('.sidebar-toggle').click()
      }
      const geometry = await page.evaluate(() => {
        const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect()
        const title = rect('.title-bar'), tabs = rect('.tabs-bar'), toolbar = rect('.editor-toolbar')
        const location = rect('.document-location'), stage = rect('.editor-stage'), status = rect('.status-bar'), editor = rect('.editor-column')
        const host = getComputedStyle(document.querySelector('.muya-host')!)
        const content = getComputedStyle(document.querySelector('.muya-container')!)
        const lastTab = document.querySelector('.tab-shell:last-child')!.getBoundingClientRect()
        return {
          titleHeight: title.height, tabsHeight: tabs.height, toolbarHeight: toolbar.height,
          locationHeight: location.height, stageTop: stage.top, stageHeight: stage.height,
          statusHeight: status.height, statusLeft: status.left, statusWidth: status.width,
          editorLeft: editor.left, editorWidth: editor.width, padding: [parseFloat(host.paddingTop), parseFloat(content.paddingLeft), parseFloat(content.paddingRight)],
          firstHeadingTop: rect('.muya-host h1').top - stage.top,
          sidebarWidth: document.querySelector('.side-bar')?.getBoundingClientRect().width ?? 0,
          newTabGap: rect('.new-tab').left - lastTab.right,
          pageOverflow: document.documentElement.scrollWidth > window.innerWidth,
          toolbarOverflow: document.querySelector('.toolbar-scroll')!.scrollWidth - toolbar.width,
        }
      })
      expect(geometry.titleHeight).toBeGreaterThanOrEqual(38)
      expect(geometry.titleHeight).toBeLessThanOrEqual(42)
      expect(geometry.tabsHeight).toBeGreaterThanOrEqual(40)
      expect(geometry.tabsHeight).toBeLessThanOrEqual(48)
      expect(geometry.toolbarHeight).toBeGreaterThanOrEqual(34)
      expect(geometry.toolbarHeight).toBeLessThanOrEqual(42)
      expect(geometry.stageTop).toBeCloseTo(geometry.titleHeight + geometry.tabsHeight + geometry.locationHeight + geometry.toolbarHeight, 0)
      expect(geometry.statusHeight).toBeGreaterThanOrEqual(26)
      expect(geometry.statusHeight).toBeLessThanOrEqual(30)
      expect(geometry.statusLeft).toBe(0)
      expect(geometry.statusWidth).toBe(width)
      if (!sidebar) expect(geometry.sidebarWidth).toBe(0)
      else if (width <= 900) {
        expect(geometry.sidebarWidth).toBeGreaterThanOrEqual(40)
        expect(geometry.sidebarWidth).toBeLessThanOrEqual(48)
      } else {
        expect(geometry.sidebarWidth).toBeGreaterThanOrEqual(220)
        expect(geometry.sidebarWidth).toBeLessThanOrEqual(380)
      }
      expect(geometry.editorLeft).toBe(geometry.sidebarWidth)
      expect(geometry.editorWidth).toBeGreaterThanOrEqual(480)
      expect(geometry.stageHeight).toBeGreaterThanOrEqual(650)
      for (const padding of geometry.padding) expect(padding).toBeGreaterThanOrEqual(28)
      expect(geometry.firstHeadingTop).toBeCloseTo(geometry.padding[0], 0)
      expect(geometry.newTabGap).toBeGreaterThanOrEqual(0)
      expect(geometry.newTabGap).toBeLessThanOrEqual(8)
      expect(geometry.pageOverflow).toBe(false)
      expect(geometry.toolbarOverflow).toBeLessThanOrEqual(1)
      await expect(page.locator('.editor-toolbar [data-action="find"]')).toBeInViewport()
      await expect(page.locator('.tabs-bar .agent-action')).toBeInViewport()
      await expect(page.locator('.find-bar')).toBeHidden()
      if (width === 1440) await page.screenshot({ path: `output/design/compact-${sidebar ? 'sidebar' : 'writing'}.png` })
    }
  }
})

test('compact navigation opens as a dismissible drawer without narrowing the document', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 600 })
  await openDocument(page)
  const column = await page.locator('.editor-column').boundingBox()
  await page.locator('.rail').getByRole('button', { name: '文件', exact: true }).click()
  await expect(page.locator('.tree-pane')).toBeVisible()
  await expect(page.locator('.workspace-picker')).toBeFocused()
  await page.locator('.navigation-footer button').last().focus()
  await page.keyboard.press('Tab')
  await expect(page.locator('.workspace-picker')).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(page.locator('.navigation-footer button').last()).toBeFocused()
  const after = await page.locator('.editor-column').boundingBox()
  expect(after!.width).toBeGreaterThanOrEqual(column!.width)
  const sidebar = await page.locator('.side-bar').boundingBox()
  const body = await page.locator('.page-body').boundingBox()
  expect(sidebar!.y).toBeCloseTo(body!.y, 0)
  expect(sidebar!.y + sidebar!.height).toBeLessThanOrEqual(body!.y + body!.height + 1)
  await page.keyboard.press('Escape')
  await expect(page.locator('.side-bar')).toHaveClass(/collapsed/)
  await expect(page.locator('.sidebar-toggle')).toBeFocused()
  await expect(page.locator('.muya-host [contenteditable="true"]')).toBeInViewport()
})

test('same-document keyboard activation from tabs, tree and search returns from Start', async ({ page }) => {
  await page.route('**/src/services/tauri-invoke.ts*', route => route.request().url().includes('home-keyboard-original')
    ? route.continue()
    : route.fulfill({ contentType: 'text/javascript', body: `
      export * from '/src/services/tauri-invoke.ts?home-keyboard-original';
      export const searchInFolder = async () => [{ path: 'C:\\\\Notes\\\\写作笔记.md', line: 1, column: 1, endColumn: 3, length: 2, preview: '把想法写下来' }];
    ` }))
  await page.setViewportSize({ width: 1280, height: 800 })
  await openDocument(page)
  await page.evaluate(async () => {
    const projectPath = '/src/stores/project.ts'
    const treePath = '/src/stores/treeCtrl.ts'
    const { useProjectStore } = await import(projectPath)
    const { makeFolder, makeFile } = await import(treePath)
    const root = makeFolder('C:\\Notes', false)
    root.loaded = true
    root.files = [makeFile({ name: '写作笔记.md', pathname: 'C:\\Notes\\写作笔记.md', isFile: true, isDirectory: false, isMarkdown: true })]
    useProjectStore().projectTree = root
  })
  const start = page.locator('.navigation-tabs').getByRole('button', { name: '开始', exact: true })
  await expect(page.locator('#opened-files-heading, #opened-files-content')).toHaveCount(0)
  for (const row of [page.getByRole('tab', { name: '写作笔记.md', exact: true }), page.locator('.tree-pane .row.file')]) {
    for (const key of ['Enter', 'Space']) {
      await start.click()
      await expect(page.locator('.welcome-panel')).toBeVisible()
      await row.press(key)
      await expect(page.locator('.welcome-panel')).toHaveCount(0)
      await expect(page.locator('.tab[aria-selected="true"]')).toContainText('写作笔记.md')
    }
  }
  await page.locator('.navigation-tabs').getByRole('button', { name: '搜索', exact: true }).click()
  await page.locator('.search-input').fill('把想法')
  await expect(page.locator('.search-pane .hit')).toHaveCount(1)
  for (const key of ['Enter', 'Space']) {
    await start.click()
    await expect(page.locator('.welcome-panel')).toBeVisible()
    await page.locator('.search-pane .hit').press(key)
    await expect(page.locator('.welcome-panel')).toHaveCount(0)
    await expect(page.locator('.tab[aria-selected="true"]')).toContainText('写作笔记.md')
  }
})

test('Find stays scoped to the selected document and does not leave the Start tab', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openDocument(page)
  const start = page.locator('.navigation-tabs').getByRole('button', { name: '开始', exact: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    await start.click()
    await expect(page.locator('.welcome-panel')).toBeVisible()
    await page.keyboard.press('Control+f')
    await expect(page.locator('.welcome-panel')).toBeVisible()
    await expect(page.locator('.find-bar')).toBeHidden()
    await page.getByRole('tab', { name: '写作笔记.md', exact: true }).click()
    await page.keyboard.press('Control+f')
    await expect(page.locator('.welcome-panel')).toHaveCount(0)
    await expect(page.locator('.find-bar')).toBeVisible()
    await expect(page.locator('[data-find-input]')).toBeFocused()
  }
  await page.locator('.find-bar .close').click()
  await expect(page.locator('.find-bar')).toBeHidden()
})

test('start page and document tabs preserve unsaved text and the existing Muya instance', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await openDocument(page)
  const editable = page.locator('.muya-host [contenteditable="true"]')
  await editable.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' preserved draft')
  await editable.evaluate(element => element.setAttribute('data-instance-check', 'preserved'))
  await page.locator('.navigation-tabs').getByRole('button', { name: '开始', exact: true }).click()
  await expect(page.locator('.welcome-panel')).toBeVisible()
  await expect(page.locator('.welcome-panel')).toContainText('今天，想写点什么？')
  await expect(page.getByRole('tab', { name: '开始', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.screenshot({ path: 'output/home-tab-after.png' })
  await page.getByRole('tab', { name: /写作笔记.md/ }).click()
  await expect(page.locator('.welcome-panel')).toHaveCount(0)
  await expect(editable).toHaveAttribute('data-instance-check', 'preserved')
  await expect(editable).toContainText('preserved draft')
  await expect(page.locator('[data-status="save-state"]')).toHaveText('未保存')
})

test('save and mode labels stay read-only and reflect real state changes', async ({ page }) => {
  await openDocument(page)
  const save = page.locator('[data-status="save-state"]')
  const mode = page.locator('[data-status="editor-mode"]')
  await expect(save).toHaveText('已保存')
  await expect(mode).toHaveText('所见即所得')
  await expect(page.locator('.status-bar button, .status-bar [tabindex]')).toHaveCount(0)
  for (const label of [save, mode]) {
    await expect(label).toHaveCSS('border-width', '0px')
    await expect(label).toHaveCSS('border-radius', '0px')
    await expect(label).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(label).toHaveCSS('cursor', 'default')
    const color = await label.evaluate(element => getComputedStyle(element).color)
    await label.hover()
    await expect(label).toHaveCSS('color', color)
    await expect(label).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  }
  const editable = page.locator('.muya-host [contenteditable="true"]')
  await editable.click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(' updated')
  await expect(save).toHaveText('未保存')
  await page.locator('[data-action="more-menu"]').click()
  await page.locator('.toolbar-menu [data-action="toggle-source"]').click()
  await expect(mode).toHaveText('源码')
  await expect(page.locator('.source-pane')).toBeVisible()
  await page.locator('[data-action="more-menu"]').click()
  await page.locator('.toolbar-menu [data-action="toggle-source"]').click()
  await expect(editable).toContainText('updated')
})

test('explicit line width and resized sidebar survive layout toggles', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 })
  await openDocument(page)
  await page.evaluate(async () => {
    const prefsPath = '/src/stores/preferences.ts'
    const layoutPath = '/src/stores/layout.ts'
    const { usePreferencesStore } = await import(prefsPath)
    const { useLayoutStore } = await import(layoutPath)
    usePreferencesStore().editorLineWidth = '640px'
    useLayoutStore().setSideBarWidth(300)
  })
  await expect(page.locator('.muya-container')).toHaveCSS('max-width', '640px')
  await expect(page.locator('.panel')).toHaveCSS('width', '344px')
  await page.locator('.sidebar-toggle').click()
  await expect(page.locator('.muya-container')).toHaveCSS('max-width', '640px')
  await page.locator('.sidebar-toggle').click()
  await expect(page.locator('.panel')).toHaveCSS('width', '344px')
  await page.locator('.resizer').press('ArrowRight')
  await expect(page.locator('.panel')).toHaveCSS('width', '360px')
  await page.evaluate(async () => {
    const prefsPath = '/src/stores/preferences.ts'
    const { usePreferencesStore } = await import(prefsPath)
    usePreferencesStore().editorLineWidth = ''
    usePreferencesStore().theme = 'dark'
  })
  await expect(page.locator('.muya-container')).toHaveCSS('max-width', 'none')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.screenshot({ path: 'output/design/compact-dark.png' })
  await page.locator('.new-tab').click()
  await expect(page.locator('.muya-host [contenteditable="true"]')).toHaveText('')
  await page.screenshot({ path: 'output/design/compact-empty-dark.png' })
})

test('panel resizing reports visible widths and immediately responds after a responsive cap', async ({ page }) => {
  await page.setViewportSize({ width: 1300, height: 800 })
  await openDocument(page)
  await page.evaluate(async () => {
    const path = '/src/stores/layout.ts'
    const { useLayoutStore } = await import(path)
    const layout = useLayoutStore()
    layout.setSideBarWidth(800)
    layout.setInspectorWidth(620)
    layout.showInspector = true
  })
  const stored = await page.evaluate(async () => {
    const path = '/src/stores/layout.ts'
    const layout = (await import(path)).useLayoutStore()
    return [layout.sideBarWidth, layout.inspectorWidth]
  })
  expect(stored).toEqual([800, 620])
  for (const [separator, panel, maximumKey, shrinkKey] of [
    ['.resizer', '.panel', 'End', 'ArrowLeft'],
    ['.inspector-resizer', '.document-inspector', 'Home', 'ArrowRight'],
  ]) {
    await page.locator(separator).press(maximumKey)
    const maximum = await page.locator(panel).boundingBox()
    expect(Number(await page.locator(separator).getAttribute('aria-valuenow'))).toBeCloseTo(maximum!.width, 0)
    expect(Number(await page.locator(separator).getAttribute('aria-valuemax'))).toBeCloseTo(maximum!.width, 0)
    await page.locator(separator).press(shrinkKey)
    const smaller = await page.locator(panel).boundingBox()
    expect(smaller!.width).toBeCloseTo(maximum!.width - 16, 0)
    expect(Number(await page.locator(separator).getAttribute('aria-valuenow'))).toBeCloseTo(smaller!.width, 0)
  }
  expect((await page.locator('.editor-column').boundingBox())!.width).toBeGreaterThanOrEqual(480)
})
