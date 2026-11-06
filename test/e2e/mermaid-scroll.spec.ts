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

test('typing a Mermaid fence opens editable source and renders a diagram in place', async ({ page }) => {
  const host = await openDocument(page, '\n\n## Following text\n')
  const heading = host.locator('h2.ag-paragraph')
  await heading.click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Enter')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.type('```mermaid')
  await page.keyboard.press('Enter')

  const figure = host.locator('figure[data-role="MERMAID"]')
  const diagram = figure.locator('.ag-container-preview > svg')
  await expect(figure).toHaveClass(/ag-active/)
  await page.keyboard.type('flowchart LR')
  await page.keyboard.press('Enter')
  await page.keyboard.insertText('  A[Start] --> B[Finish]')
  await expect(diagram).toContainText('Finish')
  const box = (await diagram.boundingBox())!
  expect(box.y + box.height).toBeLessThan((await heading.boundingBox())!.y)

  await page.keyboard.press('Enter')
  await page.keyboard.type('```')
  await page.keyboard.press('Enter')
  await page.keyboard.type('After the diagram')
  await expect(figure).not.toHaveClass(/ag-active/)
  await expect(diagram).toContainText('Finish')
  await expect(figure.locator('+ p')).toHaveText('After the diagram')
})

test('changing the language of a populated code block to Mermaid keeps its source', async ({ page }) => {
  const host = await openDocument(page, '```text\nflowchart LR\n  A --> B[Kept source]\n```\n')
  const language = host.locator('pre.ag-fence-code .ag-language-input')
  await host.locator('pre.ag-fence-code .ag-code-content').click()
  await language.click()
  await page.keyboard.press('End')
  await page.keyboard.press('Shift+Home')
  await page.keyboard.insertText('mermaid')
  await page.keyboard.press('Enter')

  const figure = host.locator('figure[data-role="MERMAID"]')
  await expect(figure.locator('.ag-code-content')).toHaveText('flowchart LR\n  A --> B[Kept source]')
  await expect(figure.locator('.ag-container-preview > svg')).toContainText('Kept source')
})

test('pasting a Mermaid diagram in a quote preserves the quoted Markdown', async ({ page }) => {
  await startWithNewDocument(page)
  const host = page.locator('.editing-region.active .muya-host')
  const paragraph = host.locator('p.ag-paragraph')
  await paragraph.click()
  const source = '> ```mermaid\n> flowchart LR\n>   A --> B[Pasted]\n> ```\n'
  await paragraph.evaluate((el, source) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', source.replace('mermaid', 'Mermaid'))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
  }, source)

  await expect(host.locator('blockquote figure[data-role="MERMAID"] .ag-container-preview > svg')).toContainText('Pasted')
  await expect.poll(() => page.evaluate(async () => {
    const editorPath = '/src/stores/editor.ts'
    const { useEditorStore } = await import(editorPath)
    return useEditorStore().currentFile.markdown
  })).toBe(source)
})

test('a tall Mermaid diagram can be closed with the sticky button or Escape', async ({ page }) => {
  const edges = Array.from({ length: 36 }, (_, index) => `N${index} --> N${index + 1}`).join('\n')
  const host = await openDocument(page, `\`\`\`mermaid\nflowchart TD\n${edges}\n\`\`\`\n`)
  const figure = host.locator('figure[data-role="MERMAID"]')
  const diagram = figure.locator('.ag-container-preview > svg')
  const done = figure.locator('button.ag-mermaid-done')
  const height = await host.evaluate(el => el.clientHeight)
  await expect(diagram).toBeAttached()
  expect((await diagram.boundingBox())!.height).toBeGreaterThan(height)

  await diagram.click()
  await expect(figure).toHaveClass(/ag-active/)
  await host.evaluate((el, height) => { el.scrollTop += height * 2 }, height)
  await expect(done).toBeInViewport()
  await done.click()
  await expect(figure).not.toHaveClass(/ag-active/)

  await diagram.click()
  await expect(figure).toHaveClass(/ag-active/)
  await page.keyboard.press('Escape')
  await expect(figure).not.toHaveClass(/ag-active/)
  await expect(diagram).toBeAttached()
  await page.keyboard.type('Continue below')
  await expect(figure.locator('+ p')).toHaveText('Continue below')
})

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

  await page.keyboard.insertText(' -->')
  await expect(host.locator('.ag-container-preview')).toHaveClass(/ag-math-error/)
  await expect(page.locator('body > div svg[id^="mermaid-render-"]:not(.ag-container-preview svg)')).toHaveCount(0)
  await page.keyboard.insertText(' C[Repaired]')
  await expect(diagram).toContainText('Repaired')
})
