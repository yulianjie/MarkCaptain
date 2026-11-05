import { expect, test, type Locator, type Page } from '@playwright/test'
import { startWithNewDocument } from './helpers/editor'

async function rightClick(page: Page, target: Locator, position?: { x: number; y: number }) {
  await page.evaluate(() => {
    delete document.body.dataset.contextMenuResult
    window.addEventListener('contextmenu', event => {
      const element = event.target instanceof Element ? event.target : null
      const area = element?.closest('[contenteditable="true"]') ? 'content' : element?.matches('.muya-host') ? 'canvas' : 'other'
      // Read cancellation after the renderer's handlers, even if a child stops propagation.
      setTimeout(() => { document.body.dataset.contextMenuResult = `${area}:${event.defaultPrevented}` }, 0)
    }, { capture: true, once: true })
  })
  await target.click({ button: 'right', position })
}

test('blank visual canvas suppresses the browser menu and both editors retain their edit menus', async ({ page }) => {
  await startWithNewDocument(page)
  const host = page.locator('.muya-host')
  const editor = host.locator('[contenteditable="true"]')
  const menu = page.locator('.mt-context-menu')
  const body = page.locator('body')
  const blankPosition = await host.evaluate(el => ({ x: el.clientWidth / 2, y: el.clientHeight - 12 }))

  await rightClick(page, host, blankPosition)
  await expect(body).toHaveAttribute('data-context-menu-result', 'canvas:true')
  await expect(menu).toBeHidden()

  await editor.click()
  await page.keyboard.type('Draft body')
  const paragraph = editor.locator('p.ag-paragraph').filter({ hasText: 'Draft body' })
  await rightClick(page, paragraph, { x: 16, y: 8 })
  await expect(body).toHaveAttribute('data-context-menu-result', 'content:true')
  await menu.getByRole('menuitem', { name: /^Select all\b/ }).click()
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe('Draft body')

  await page.evaluate(async () => {
    const path = '/src/stores/editor.ts'
    const { useEditorStore } = await import(path)
    useEditorStore().toggleSourceCode()
  })
  const source = page.locator('.source-pane .cm-content .cm-line').filter({ hasText: 'Draft body' })
  await rightClick(page, source, { x: 16, y: 8 })
  await expect(body).toHaveAttribute('data-context-menu-result', 'content:true')
  await expect(menu.getByRole('menuitem', { name: 'Paste', exact: true })).toBeEnabled()
  await expect(source).toHaveText('Draft body')
  await expect(page.locator('[data-status="save-state"]')).toHaveText('Unsaved')
})
