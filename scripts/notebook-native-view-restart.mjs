import { chromium, expect } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
const output = path.resolve('output/notebook-native')
const browser = await chromium.connectOverCDP('http://127.0.0.1:9335')
let page
for (let attempt = 0; attempt < 50 && !page; attempt++) {
  page = browser.contexts().flatMap(context => context.pages()).find(page => /localhost:1420/.test(page.url()))
  if (!page) await new Promise(resolve => setTimeout(resolve, 100))
}
if (!page) throw new Error('No isolated debug webview')
// EditorView.findFromDOM uses this DOM-attached root in the installed CM6.
const selections = () => page.evaluate(() => [...document.querySelectorAll('.editing-region .cm-content')].map(content => content.cmTile?.root?.view?.state.selection.toJSON()))
const visualCursor = () => page.evaluate(async () => {
  const e = '/src/stores/editor.ts'; const cursor = (await import(e)).useEditorStore().getMuyaInstance()?.getCursor()
  return cursor ? { anchor: { line: cursor.anchor.line, ch: cursor.anchor.ch }, focus: { line: cursor.focus.line, ch: cursor.focus.ch } } : null
})
try {
  if (process.argv[2]?.startsWith('prepare')) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const recovery = page.getByRole('button', { name: 'Recover Drafts', exact: true })
      if (await recovery.isVisible()) await recovery.click()
      const ready = await page.evaluate(async () => { const e = '/src/stores/editor.ts'; return !(await import(e)).useEditorStore().startupHydrationPending })
      if (ready) break
      await page.waitForTimeout(100)
    }
    const source = process.argv[2] !== 'prepare-visual'
    const marker = `per-pane 草稿 ${Date.now()}`
    await page.evaluate(async ({ source, marker }) => {
      const e = '/src/stores/editor.ts'; const editor = (await import(e)).useEditorStore()
      const tab = editor.newUntitledTab(`# ${marker}\nfirst line\nsecond line\n`)
      if (editor.panes.length === 1) editor.splitPane('horizontal')
      for (const pane of editor.panes) { pane.documentId = tab.id; pane.sourceMode = source }
      editor.sourceCodeMode = source
    }, { source, marker })
    const regions = page.locator('.editing-region')
    await expect(regions).toHaveCount(2)
    const content = source ? '.cm-content' : '.muya-host [contenteditable=true]'
    await regions.first().locator(content).click(); await page.keyboard.press('Control+Home'); await page.keyboard.press('Shift+End')
    const firstVisual = source ? null : await visualCursor()
    if (source) await regions.nth(1).locator('.cm-line').nth(1).click()
    else { await regions.nth(1).locator(content).click(); await page.keyboard.press('Control+End') }
    await page.keyboard.press('Home'); await page.keyboard.press('Shift+End')
    const expected = source ? await selections() : [firstVisual, await visualCursor()]
    if (!expected[0] || !expected[1] || JSON.stringify(expected[0]) === JSON.stringify(expected[1])) throw new Error('Fixture did not create distinct source selections')
    await expect.poll(() => page.evaluate(source => JSON.parse(localStorage.getItem('mt:panes')).panes.map(pane => source ? pane.sourceSelection : pane.cursor), source)).toEqual(expected)
    await expect.poll(() => page.evaluate(async marker => {
      const i = '/src/services/tauri-invoke.ts'; const e = '/src/stores/editor.ts'
      const editor = (await import(e)).useEditorStore(); const current = editor.currentFile
      const session = await (await import(i)).getEditorSession()
      return session?.tabs.some(tab => tab.dirty && tab.filename === current.filename
        && tab.markdown.includes(marker) && tab.markdown === current.markdown)
    }, marker)).toBe(true)
    await writeFile(path.join(output, 'view-restart-prepared.json'), JSON.stringify({ expected, source }))
  } else {
    await page.getByRole('button', { name: 'Recover Drafts', exact: true }).click({ timeout: 20000 })
    const { expected, source } = JSON.parse(await readFile(path.join(output, 'view-restart-prepared.json'), 'utf8'))
    const actual = source ? selections : async () => {
      const cursors = []
      for (let i = 0; i < 2; i++) {
        await page.evaluate(async i => { const e = '/src/stores/editor.ts'; const editor = (await import(e)).useEditorStore(); editor.activatePane(editor.panes[i].id) }, i)
        cursors.push(await visualCursor())
      }
      return cursors
    }
    await expect.poll(actual, { timeout: 15000 }).toEqual(expected)
    await writeFile(path.join(output, source ? 'view-restart-receipt.json' : 'visual-view-restart-receipt.json'), JSON.stringify({ native: true, backendMocked: false, mode: source ? 'source' : 'wysiwyg', distinctSelectionsRecovered: true, success: true }, null, 2))
  }
} finally { await browser.close() }
