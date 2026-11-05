import { expect, test, type Page } from '@playwright/test'
import { startWithNewDocument } from './helpers/editor'

async function openDocument(page: Page, markdown: string) {
  await startWithNewDocument(page)
  await page.evaluate(async markdown => {
    const editorPath = '/src/stores/editor.ts'
    const { useEditorStore } = await import(editorPath)
    useEditorStore().newUntitledTab(markdown)
  }, markdown)
  return page.locator('.editing-region.active .muya-host')
}

test('Enter after a heading below a tall Mermaid diagram keeps the caret in view', async ({ page }) => {
  const edges = Array.from({ length: 36 }, (_, index) => `N${index} --> N${index + 1}`).join('\n')
  const host = await openDocument(page, `# Before the diagram\n\n\`\`\`mermaid\nflowchart TD\n${edges}\n\`\`\`\n\n## After the diagram\n`)
  const diagram = host.locator('.ag-container-preview > svg')
  await expect(diagram).toBeAttached()
  expect((await diagram.boundingBox())!.height).toBeGreaterThan(await host.evaluate(el => el.clientHeight))

  const heading = host.locator('h2.ag-paragraph').getByText('After the diagram')
  await heading.click()
  await page.keyboard.press('End')
  await expect(heading).toBeInViewport()

  await page.keyboard.press('Enter')
  await expect(diagram).toBeAttached()
  const paragraph = host.locator('h2.ag-paragraph + p.ag-paragraph')
  await expect(paragraph).toBeInViewport()
  await page.keyboard.type('Continue here')
  await expect(paragraph).toHaveText('Continue here')
  await expect(paragraph).toBeInViewport()
})

test('editing Mermaid source updates the diagram preview', async ({ page }) => {
  const host = await openDocument(page, '```mermaid\nflowchart TD; A --> B\n```\n')
  const diagram = host.locator('.ag-container-preview > svg')
  await diagram.click()
  await page.keyboard.press('End')
  await page.keyboard.insertText('[Updated label]')
  await expect(diagram).toContainText('Updated label')
})
