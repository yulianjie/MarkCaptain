import { test, expect, type Page } from '@playwright/test'

test('sidebar can be hidden completely and restored from the title bar', async ({ page }) => {
  await seed(page)
  const editorBefore = await page.locator('.editor-column').boundingBox()
  await page.locator('.collapse-outline').click()
  await expect(page.locator('.side-bar')).toHaveCount(0)
  await expect(page.locator('.sidebar-toggle')).toHaveAttribute('aria-expanded', 'false')
  const editorAfter = await page.locator('.editor-column').boundingBox()
  expect(editorAfter!.width).toBeGreaterThan(editorBefore!.width)
  await page.locator('.sidebar-toggle').click()
  await expect(page.locator('.toc-row')).toHaveCount(10)
  await expect(page.locator('.sidebar-toggle')).toHaveAttribute('aria-expanded', 'true')
  await page.locator('.sidebar-toggle').click()
  await expect(page.locator('.side-bar')).toHaveCount(0)
  await page.locator('.sidebar-toggle').click()
  await expect(page.locator('.side-bar')).toBeVisible()
})

test('all built-in themes tint native chrome and retain readable icon states', async ({ page }) => {
  await seed(page)
  await page.locator('.rail-icon.active').evaluate(element => { (element as HTMLElement).style.transition = 'none' })
  for (const theme of ['light', 'dark', 'one-dark', 'material-dark', 'graphite-light', 'ulysses-light', 'github-blue']) {
    await page.evaluate(value => {
      document.documentElement.dataset.theme = value
      document.documentElement.classList.toggle('dark', value.includes('dark'))
      document.documentElement.classList.add('native-glass')
    }, theme)
    const dark = theme.includes('dark')
    await expect(page.locator('html')).toHaveCSS('color-scheme', dark ? 'dark' : 'light')
    const alpha = await page.locator('.side-bar').evaluate(element => {
      const ctx = document.createElement('canvas').getContext('2d')!
      ctx.fillStyle = getComputedStyle(element).backgroundColor
      ctx.fillRect(0, 0, 1, 1)
      return ctx.getImageData(0, 0, 1, 1).data[3] / 255
    })
    expect(alpha).toBeGreaterThan(dark ? 0.93 : 0.84)
    expect(alpha).toBeLessThan(1)
    const active = page.locator('.rail-icon.active')
    const selectedColor = await active.evaluate(element => getComputedStyle(element).color)
    await active.hover()
    await expect(active).toHaveCSS('color', selectedColor)
  }
})

test('unsupported desktops stay opaque, including after native blur is withdrawn', async ({ page }) => {
  await seed(page)
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value }, theme)
    for (const active of [false, true, false]) {
      await page.evaluate(value => document.documentElement.classList.toggle('native-glass', value), active)
      if (active) continue
      for (const selector of ['.title-bar', '.side-bar']) {
        const alpha = await page.locator(selector).evaluate(element => {
          const context = document.createElement('canvas').getContext('2d')!
          context.fillStyle = getComputedStyle(element).backgroundColor
          context.fillRect(0, 0, 1, 1)
          return context.getImageData(0, 0, 1, 1).data[3]
        })
        expect(alpha).toBe(255)
        await expect(page.locator(selector)).toHaveCSS('backdrop-filter', 'none')
      }
    }
  }
})

test('native glass exposes the desktop through chrome but keeps the document opaque', async ({ page }) => {
  await seed(page)
  // Browser QA checks alpha only; desktop blur requires a native compositor.
  await page.evaluate(() => document.documentElement.classList.add('native-glass'))
  for (const selector of ['html', 'body', '#app', '#mt-app', '.editor-page']) {
    await expect(page.locator(selector)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(page.locator(selector)).toHaveCSS('background-image', 'none')
  }
  for (const selector of ['.title-bar', '.side-bar']) {
    const alpha = await page.locator(selector).evaluate(element => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const context = canvas.getContext('2d')!
      context.fillStyle = getComputedStyle(element).backgroundColor
      context.fillRect(0, 0, 1, 1)
      return context.getImageData(0, 0, 1, 1).data[3]
    })
    expect(alpha).toBeGreaterThan(0)
    expect(alpha).toBeLessThan(255)
  }
  await expect(page.locator('.editor-column')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await page.emulateMedia({ forcedColors: 'active' })
  await expect(page.locator('.editor-page')).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
})

test('toolbar keeps complete tightly spaced controls at normal editor widths', async ({ page }) => {
  await seed(page)
  const toolbar = page.locator('.editor-toolbar')
  const actions = ['redo', 'format:del', 'format:inline_code', 'paragraph:ul-task', 'paragraph:blockquote', 'paragraph:pre', 'format:image', 'insert-table']
  // Include the reported ~788px toolbar and both sides of the former 820px breakpoint.
  for (const width of [700, 740, 788, 820, 821, 1000]) {
    await page.setViewportSize({ width: width + 500, height: 900 })
    await toolbar.evaluate((element, value) => { element.style.width = value + 'px' }, width)
    for (const action of actions) await expect(toolbar.locator('[data-action="' + action + '"]')).toBeVisible()
    const geometry = await toolbar.evaluate(element => {
      const buttons = [...element.querySelectorAll<HTMLElement>('.tool-button')].filter(button => button.offsetParent)
      const bounds = element.getBoundingClientRect()
      return {
        overflow: element.querySelector('.toolbar-scroll')!.scrollWidth - element.clientWidth,
        buttonsInside: buttons.every(button => {
          const rect = button.getBoundingClientRect()
          return rect.left >= bounds.left && rect.right <= bounds.right
        }),
        groupGaps: [...element.querySelectorAll<HTMLElement>('.toolbar-group')].slice(0, -1).map(group => {
          const next = group.nextElementSibling
          return next ? next.getBoundingClientRect().left - group.getBoundingClientRect().right : 0
        }),
      }
    })
    expect(geometry.overflow, 'overflow at ' + width).toBeLessThanOrEqual(1)
    expect(geometry.buttonsInside, 'buttons outside at ' + width).toBe(true)
    expect(Math.max(...geometry.groupGaps), 'stretched group spacing at ' + width).toBeLessThanOrEqual(10)
    if (width === 788) await toolbar.screenshot({ path: 'output/design/toolbar-fixed-788.png' })
  }
  await toolbar.evaluate(element => { element.style.width = '500px' })
  await expect(toolbar.locator('[data-action="format:image"]')).toBeHidden()
  await toolbar.locator('[data-action="more-menu"]').click()
  await expect(page.locator('.toolbar-menu-more [data-action="format:image"]')).toBeVisible()
  await page.locator('.toolbar-menu-more [data-action="paragraph:blockquote"]').click()
  await expect(page.locator('.muya-host blockquote')).toBeVisible()
  await toolbar.locator('[data-action="find"]').click()
  await expect(page.locator('.find-bar')).toBeVisible()
})

const markdown = [
  '# 高德地图综合服务 Skill',
  '高德地图综合服务向开发者提供完整的地图数据服务，包括地点搜索、路径规划、旅游规划、周边搜索和热力图数据可视化等功能。',
  '## Skill App Name / 统计口径',
  '- SKILL_NAME = gaode-map-lbs\n- APP_NAME = gaode-map-lbs',
  '## 功能特性', '支持关键词搜索和周边搜索。',
  '## 场景一：明确关键词搜索', '用户通过关键词搜索地点，返回结构化的地图结果。',
  '### 执行步骤', '输入地点关键词，然后选择城市。',
  '### 示例', '```yaml\nname: gaode-map-lbs\nversion: 2.0.1\nmetadata:\n  requires:\n    - node\n    - python3\n```',
  '### 回复模板', '根据搜索结果整理地点、地址和交通信息。',
  '## 场景二：基于位置的周边搜索',
  ...Array.from({ length: 18 }, (_, index) => '段落 ' + index + '：提供清晰可读的地图检索说明。'),
  '### 完整示例', '搜索当前位置附近的公园。',
  '## 场景三：热力图展示', '展示区域热力图。'
].join('\n\n')

async function seed(page: Page) {
  await page.goto('/')
  await page.locator('.muya-host [contenteditable="true"]').waitFor()
  await page.evaluate(async (content) => {
    const editorPath = '/src/stores/editor.ts'
    const prefsPath = '/src/stores/preferences.ts'
    const layoutPath = '/src/stores/layout.ts'
    const { useEditorStore } = await import(editorPath)
    const { usePreferencesStore } = await import(prefsPath)
    const { useLayoutStore } = await import(layoutPath)
    const prefs = usePreferencesStore()
    prefs.language = 'zh-CN'
    prefs.sideBarVisibility = true
    prefs.tabBarVisibility = true
    prefs.toolBarVisibility = true
    prefs.statusBarVisibility = true
    prefs.autoSave = false
    const editor = useEditorStore()
    editor.sourceCodeMode = false
    const tab = editor.newUntitledTab(content)
    tab.filename = 'SKILL.md'
    useLayoutStore().rightColumn = 'toc'
  }, markdown)
  await expect(page.locator('.toc-row')).toHaveCount(10)
}

test('glass outline filters, expands, navigates and tracks real scroll', async ({ page }) => {
  await page.setViewportSize({ width: 1512, height: 1040 })
  await seed(page)
  await expect(page.locator('.title-bar [role="menuitem"]')).toHaveCount(8)
  await expect(page.locator('.breadcrumb')).toHaveCount(0)

  const branch = page.getByRole('button', { name: '折叠 场景一：明确关键词搜索', exact: true })
  await branch.click()
  await expect(page.locator('.toc-row')).toHaveCount(7)
  const search = page.locator('.toc-search input')
  await search.fill('回复模板')
  await expect(page.locator('.toc-row')).toHaveCount(3)
  await expect(page.locator('.toc-row').last()).toHaveText('H3回复模板')
  await search.fill('不存在的标题')
  await expect(page.locator('.toc-list')).toContainText('没有匹配的标题')
  await search.press('Escape')
  await expect(page.locator('.toc-row')).toHaveCount(7)
  await page.getByRole('button', { name: '展开 场景一：明确关键词搜索', exact: true }).click()
  await expect(page.locator('.toc-row')).toHaveCount(10)

  const chapter = page.getByRole('button', { name: 'H2: 场景一：明确关键词搜索', exact: true })
  await chapter.focus()
  await chapter.press('ArrowDown')
  await expect(page.getByRole('button', { name: 'H3: 执行步骤', exact: true })).toBeFocused()
  await chapter.click()
  await expect(chapter).toHaveAttribute('aria-current', 'location')
  await expect.poll(() => page.locator('.muya-host').evaluate(el => el.scrollTop)).toBeGreaterThan(0)
  await page.locator('.muya-host').evaluate(el => { el.scrollTop = el.scrollHeight })
  await expect(page.locator('.toc-progress progress')).toHaveAttribute('value', '100')

  await page.locator('.muya-host').evaluate(el => { el.scrollTop = 0 })
  await page.mouse.move(1500, 1030)
  await page.screenshot({ path: 'output/design/markcaptain-glass-implemented.png', animations: 'disabled' })
  await page.locator('.collapse-outline').click()
  await expect(page.locator('.toc-pane')).toHaveCount(0)
  await page.locator('.sidebar-toggle').click()
  await expect(page.locator('.toc-pane')).toBeVisible()
})

test('search remains reachable in a narrow window and dark theme', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 650 })
  await seed(page)
  const find = page.locator('.editor-toolbar > .toolbar-scroll [data-action="find"]')
  await expect(find).toBeVisible()
  const box = await find.boundingBox()
  expect(box!.x + box!.width).toBeLessThanOrEqual(800)
  await find.click()
  await expect(page.locator('.find-bar')).toBeVisible()
  const findBox = await page.locator('.find-bar').boundingBox()
  const stageBox = await page.locator('.editor-stage').boundingBox()
  expect(findBox!.x).toBeGreaterThanOrEqual(stageBox!.x)
  await page.evaluate(async () => {
    const path = '/src/stores/preferences.ts'
    const { usePreferencesStore } = await import(path)
    usePreferencesStore().theme = 'dark'
  })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.screenshot({ path: 'output/design/markcaptain-glass-dark-800.png', animations: 'disabled' })
})
