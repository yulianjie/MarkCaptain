// Native renderer + Rust HTTP/tool loop. Only the local model is a fixture.
import http from 'node:http'
import { chromium, expect } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
const output = path.resolve('output/notebook-native')
const { root } = JSON.parse(await readFile(path.join(output, 'receipt.json'), 'utf8'))
const requests = []
const server = http.createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk
  const input = JSON.parse(body); requests.push(input)
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const emit = (delta, finishReason) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
  const continuing = input.messages.some(m => typeof m.content === 'string' && m.content.includes('native continue after undo'))
  const proposed = input.messages.some(m => m.tool_call_id === 'native-proposal')
  const read = input.messages.some(m => m.tool_call_id === 'native-read')
  if (continuing || proposed) emit({ content: continuing ? 'Acknowledged the undo.' : 'Review the proposed change.' }, 'stop')
  else {
    const name = read ? 'propose_edit' : 'read_document'
    const args = read ? { title: 'Native Agent review', oldText: 'Native agent original', newText: 'Native agent revised' } : { full: true }
    emit({ tool_calls: [{ index: 0, id: read ? 'native-proposal' : 'native-read', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls')
  }
  response.end('data: [DONE]\n\n')
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
const browser = await chromium.connectOverCDP('http://127.0.0.1:9335')
const page = browser.contexts().flatMap(c => c.pages()).find(p => /localhost:1420/.test(p.url()))
if (!page) throw new Error('No isolated native webview found')
const receipt = { native: true, backendMocked: false, modelFixture: true, success: false }
const markdown = () => page.evaluate(async () => { const m = '/src/stores/editor.ts'; return (await import(m)).useEditorStore().currentFile.markdown })
try {
  for (let attempt = 0; attempt < 50; attempt++) {
    const recovery = page.getByRole('button', { name: 'Recover Drafts', exact: true })
    if (await recovery.isVisible()) await recovery.click()
    const ready = await page.evaluate(async () => { const e = '/src/stores/editor.ts'; return !(await import(e)).useEditorStore().startupHydrationPending })
    if (ready) break
    await page.waitForTimeout(100)
  }
  const fixtureConflict = page.getByRole('dialog', { name: 'File changed outside MarkCaptain', exact: true })
  if (await fixtureConflict.isVisible()) { await page.keyboard.press('Escape'); await expect(fixtureConflict).toBeHidden() }
  await page.evaluate(async ({ root, baseUrl }) => {
    const e = '/src/stores/editor.ts'; const a = '/src/stores/agent.ts'; const l = '/src/i18n/index.ts'
    ;(await import(l)).setLocale('en')
    const editor = (await import(e)).useEditorStore()
    const tab = await editor.openFile(root + '/a/同名.md')
    for (const pane of editor.panes) { pane.documentId = tab.id; pane.sourceMode = false }
    editor.sourceCodeMode = false
    const agent = (await import(a)).useAgentStore()
    await agent.saveConfig({ baseUrl, model: 'native-fixture', authMode: 'none' }); await agent.clear(); agent.visible = true
    if (agent.conversation.messages.length) throw new Error('Native fixture conversation did not reset')
  }, { root, baseUrl })
  const editor = page.locator('.editing-region').nth(1).locator('.muya-host [contenteditable="true"]')
  await editor.waitFor()
  await page.evaluate(async () => { const e = '/src/stores/editor.ts'; const editor = (await import(e)).useEditorStore(); editor.applyAgentEdit(editor.currentFileId, editor.currentFile.markdown, '# Native agent original\n'); await editor.saveCurrent() })
  await editor.click(); await page.keyboard.press('Control+End')
  const input = page.locator('.agent-panel textarea').last()
  await input.fill('native review proposal')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.agent-change').first()).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.agent-working')).toHaveCount(0)
  await page.locator('.agent-change').first().getByRole('button', { name: /^Apply/ }).click()
  await expect.poll(markdown).toContain('Native agent revised')
  await editor.click(); await page.keyboard.press('Control+z')
  await expect.poll(markdown).toContain('Native agent original')
  await page.keyboard.press('Control+y')
  await expect.poll(markdown).toContain('Native agent revised')
  await page.keyboard.press('Control+z')
  await expect.poll(markdown).toContain('Native agent original')
  await input.fill('native continue after undo')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.locator('.agent-working')).toHaveCount(0)
  const followup = requests.find(r => r.messages.some(m => typeof m.content === 'string' && m.content.includes('native continue after undo')))
  const feedback = followup?.messages.map(m => m.content).find(c => typeof c === 'string' && c.includes('[User review feedback]\n'))
  const state = feedback && JSON.parse(feedback.split('[User review feedback]\n')[1])
  if (!state?.changes.some(change => change.status === 'reverted')) throw new Error('native continuation did not receive reverted review state')
  receipt.toolRead = requests.some(r => r.messages.some(m => m.tool_call_id === 'native-read'))
  receipt.reviewApplied = true; receipt.undoPreserved = true; receipt.redoPreserved = true; receipt.continuationFeedback = 'reverted'; receipt.success = true
  await page.screenshot({ path: path.join(output, 'native-agent-undo.png') })
  await page.evaluate(async () => { const e = '/src/stores/editor.ts'; await (await import(e)).useEditorStore().saveCurrent() })
} catch (error) { receipt.success = false; receipt.error = String(error); throw error }
finally { await writeFile(path.join(output, 'agent-receipt.json'), JSON.stringify(receipt, null, 2)); await browser.close(); await new Promise(resolve => server.close(resolve)) }
