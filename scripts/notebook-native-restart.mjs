import { chromium, expect } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
const browser = await chromium.connectOverCDP('http://127.0.0.1:9335')
const page = browser.contexts().flatMap(c => c.pages()).find(p => /localhost:1420/.test(p.url()))
if (!page) throw new Error('No isolated debug webview found')
const output = path.resolve('output/notebook-native')
try {
  if (process.argv[2] === 'prepare') {
    await page.evaluate(async () => { const e = '/src/stores/editor.ts'; const editor = (await import(e)).useEditorStore(); editor.newUntitledTab(); editor.sourceCodeMode = true })
    await page.locator('.editing-region.active .cm-content').waitFor()
    await page.evaluate(async () => { const e = '/src/stores/editor.ts'; const editor = (await import(e)).useEditorStore(); editor.applyAgentEdit(editor.currentFileId, editor.currentFile.markdown, '# restart 草稿\n\nPreserve unsaved content\n') })
    await expect.poll(() => page.evaluate(async () => { const i = '/src/services/tauri-invoke.ts'; const session = await (await import(i)).getEditorSession(); return session?.tabs.some(t => t.dirty && t.markdown.includes('restart 草稿')) })).toBe(true)
    await writeFile(path.join(output, 'restart-prepared.json'), JSON.stringify({ native: true, draftPersisted: true }))
  } else {
    await page.locator('.el-message-box .el-button--primary').click({ timeout: 20000 })
    await expect.poll(() => page.evaluate(async () => { const e = '/src/stores/editor.ts'; const editor = (await import(e)).useEditorStore(); return editor.tabs.some(t => !t.isSaved && t.markdown.includes('restart 草稿')) }), { timeout: 15000 }).toBe(true)
    await expect(page.locator('.editing-region')).toHaveCount(2)
    await expect.poll(() => page.evaluate(async () => {
      const e = '/src/stores/editor.ts'; const editor = (await import(e)).useEditorStore()
      return Boolean(editor.currentFile?.markdown.includes('restart 草稿'))
        && editor.panes.every(pane => pane.documentId === null || editor.tabs.some(tab => tab.id === pane.documentId))
    })).toBe(true)
    await page.screenshot({ path: path.join(output, 'native-recovered-draft.png') })
    await writeFile(path.join(output, 'restart-receipt.json'), JSON.stringify({ native: true, backendMocked: false, crashDraftRecovered: true, splitLayoutRecovered: true, activeDraftRestored: true, success: true }, null, 2))
  }
} finally { await browser.close() }
