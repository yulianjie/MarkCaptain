import { expect, test, type Page } from '@playwright/test'

// Production stores and components; only provider transport is replaced.
const transport = `export const agentTransport = {
  historySettings: async()=>({enabled:false}), historyList: async()=>[],
  getConfig: async()=>({baseUrl:'https://example.invalid',model:'review-test',hasKey:false,hasHeaders:false}),
  listSkills: async()=>[], listen: async()=>()=>{}, start: async()=>{}, cancel: async()=>{},
};`

async function setup(page: Page) {
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/src/services/agent-transport.ts*', route => route.fulfill({ contentType: 'text/javascript', body: transport }))
  await page.goto('/')
  await page.locator('.editing-region').first().waitFor()
  await page.evaluate(async () => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    if (editor.startupHydrationPending) editor.finishStartupHydration()
    const prefs = (await import('/src/stores/preferences.ts')).usePreferencesStore()
    prefs.autoSave = false
    editor.sourceCodeMode = true
    ;(await import('/src/i18n/index.ts')).setLocale('en')
  })
}

for (const offset of [2, 6]) {
  test(`applied insertion preview locates inserted text at offset ${offset}`, async ({ page }) => {
    await setup(page)
    await page.evaluate(async offset => {
      const editor = (await import('/src/stores/editor.ts')).useEditorStore()
      const agent = (await import('/src/stores/agent.ts')).useAgentStore()
      const { reviewProposal, reviewedMarkdown } = await import('/src/services/agent.ts')
      const tab = editor.newUntitledTab('abcdef')
      const edit = reviewProposal({ tabId: tab.id, name: 'insertion.md', markdown: tab.markdown, from: 0, to: tab.markdown.length, snapshotId: 'insert-snapshot' },
        { title: 'Insert text', changes: [{ oldText: '', newText: 'XYZ', anchor: { snapshotId: 'insert-snapshot', from: offset, to: offset } }] }, 'insert-card')
      edit.changes[0].status = 'applied'
      edit.status = 'applied'
      edit.appliedMarkdown = reviewedMarkdown(edit, [0])
      editor.setMarkdownExternal(tab.id, edit.appliedMarkdown)
      agent.conversation.messages.push({ id: 'insert-card', role: 'assistant', content: '', tools: [], edit })
      agent.locateSource = async snapshot => { (window as any).__locatedReview = snapshot; return true }
      ;(await import('/src/bus.ts')).bus.emit('agent-review-preview/open', { messageId: 'insert-card', changeId: edit.changes[0].id })
    }, offset)
    const preview = page.locator('.agent-review-preview')
    await expect(preview).toBeVisible()
    await preview.getByRole('button', { name: 'Locate original text' }).click()
    const located = await page.evaluate(() => (window as any).__locatedReview)
    expect(located.from).toBe(offset)
    expect(located.to).toBe(offset + 3)
    expect(located.markdown.slice(located.from, located.to)).toBe('XYZ')
    expect(located.to).toBeLessThanOrEqual(located.markdown.length)
  })
}

test('structured table renders unchanged cells once and changed cells as before/after', async ({ page }) => {
  await setup(page)
  await page.evaluate(async () => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    const agent = (await import('/src/stores/agent.ts')).useAgentStore()
    const { reviewProposal } = await import('/src/services/agent.ts')
    const markdown = '| Name | Value |\n| --- | --- |\n| Stable | Before |'
    const tab = editor.newUntitledTab(markdown)
    const edit = reviewProposal({ tabId: tab.id, name: 'table.md', markdown, from: 0, to: markdown.length },
      { title: 'Update value', oldText: markdown, newText: markdown.replace('Before', 'After') }, 'table-card')
    agent.conversation.messages.push({ id: 'table-card', role: 'assistant', content: '', tools: [], edit })
    ;(await import('/src/bus.ts')).bus.emit('agent-review-preview/open', { messageId: 'table-card', changeId: edit.changes[0].id })
  })
  const preview = page.locator('.agent-review-preview')
  await expect(preview).toBeVisible()
  await preview.getByRole('button', { name: 'Structured view' }).click()
  const cells = preview.locator('td')
  await expect(cells).toHaveText(['Name', 'Value', 'Stable', 'BeforeAfter'])
  await expect(cells.nth(2).locator('span')).toHaveCount(1)
  await expect(cells.nth(2).locator('del, ins')).toHaveCount(0)
  await expect(cells.nth(3).locator('del')).toHaveText('Before')
  await expect(cells.nth(3).locator('ins')).toHaveText('After')
})
