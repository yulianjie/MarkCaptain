// Validate compiled assets under the actual Tauri custom protocol and CSP.
import { chromium, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
const output = path.resolve('output/notebook-native')
const root = path.join(output, `production-项目-${Date.now()}`)
await mkdir(root, { recursive: true })
await writeFile(path.join(root, '笔记.md'), '---\naliases: [别名]\ntags: [work/team]\n---\n# 标题\n\n- [ ] production task\n')
await writeFile(path.join(root, '引用.md'), '[[笔记#标题|显示]]\n\n别名\n')
const browser = await chromium.connectOverCDP('http://127.0.0.1:9337')
const page = browser.contexts().flatMap(c => c.pages()).find(p => /tauri[:.]/.test(p.url()))
if (!page) throw new Error('No production custom-protocol webview found')
const receipt = { native: true, productionAssets: true, backendMocked: false, url: page.url(), checks: [], pageErrors: [], success: false }
page.on('pageerror', error => receipt.pageErrors.push(error.message))
const check = name => { receipt.checks.push(name); process.stdout.write(`${name}\n`) }
try {
  for (let attempt = 0; attempt < 50; attempt++) {
    const recover = page.getByRole('button', { name: 'Recover Drafts', exact: true })
    if (await recover.isVisible()) {
      try { await recover.click({ timeout: 3000 }) }
      catch (error) {
        // Startup may finish and remove this prompt between discovery and click.
        // A prompt that remains present is a real failure, not a retry success.
        if (await recover.isVisible()) throw error
      }
    }
    const ready = await page.evaluate(() => { const pinia = document.querySelector('#app').__vue_app__?.config.globalProperties.$pinia; return pinia && !pinia._s.get('editor')?.startupHydrationPending })
    if (ready) break
    await page.waitForTimeout(100)
  }
  await page.evaluate(async ({ root, output }) => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
    const editor = pinia._s.get('editor')
    if (editor.tabs.some(t => t.pathname && !t.pathname.replaceAll('\\','/').toLowerCase().startsWith(output.replaceAll('\\','/').toLowerCase() + '/'))) throw new Error('Production preview contains unrelated files')
    for (const tab of [...editor.tabs]) await editor.closeTab(tab.id, true)
    editor.panes = [{ id: 'main', documentId: null, sourceMode: true }]; editor.activePaneId = ''; editor.activatePane('main')
    await pinia._s.get('project').openRoot(root)
    await pinia._s.get('notebook').rebuild(true)
    await editor.openFile(root + '/笔记.md'); editor.sourceCodeMode = true
  }, { root, output })
  await expect.poll(() => page.evaluate(() => { const n = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('notebook'); return [n.analyses.length, n.backlinks.length, n.mentions.length] })).toEqual([2, 1, 1])
  check('compiled index and relation workers load under production CSP')
  await page.keyboard.press('Control+k'); await page.locator('.note-picker input').fill('别名')
  await expect(page.locator('#note-results')).toContainText('笔记.md'); await page.keyboard.press('Enter')
  check('production alias quick-open and typed IPC')
  await page.evaluate(async () => { const p = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia; await p._s.get('notebook').daily(); p._s.get('notebook').dialog = 'history' })
  await expect(page.locator('.versions button').first()).toBeVisible(); await page.keyboard.press('Escape')
  check('production daily creation and independent history metadata')
  const reference = '[target](笔记.md)\n'
  await writeFile(path.join(root, 'ref.md'), reference)
  await page.evaluate(async root => {
    const p = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
    await p._s.get('notebook').rebuild(true)
    await p._s.get('editor').openFile((root.replaceAll('\\', '/') + '/REF.MD').toUpperCase())
    window.__productionMove = p._s.get('notebook').moveWithReferences(root + '/笔记.md', root + '/改名.md')
  }, root)
  await page.locator('.el-message-box .el-button--primary').click()
  await page.evaluate(async () => { await window.__productionMove })
  const rewritten = await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('editor').currentFile.markdown)
  if (!rewritten.includes('%E6%94%B9%E5%90%8D.md')) throw new Error('Windows path alias did not synchronize the reference buffer')
  await page.evaluate(async () => { await document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('notebook').restoreReferences() })
  if (await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('editor').currentFile.markdown) !== reference) throw new Error('Windows path alias did not restore its reference buffer')
  check('production reference transaction synchronizes Windows path aliases and recovery')
  await page.evaluate(() => { const p = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia; const e = p._s.get('editor'); const tab = e.newUntitledTab('restored version'); if (tab.isSaved) throw new Error('restored content is not dirty'); e.splitPane('horizontal') })
  const second = page.locator('.editing-region').nth(1).locator('.cm-content')
  await second.click(); await page.keyboard.press('Control+End'); await page.keyboard.type(' production edit')
  await expect(page.locator('.editing-region').first().locator('.cm-content')).toContainText('production edit')
  await page.keyboard.press('Control+z'); await expect(second).toHaveText('restored version')
  check('production shared editing, undo and restored-document dirty state')
  await page.screenshot({ path: path.join(output, 'production-splits.png') })
  if (receipt.pageErrors.length) throw new Error(receipt.pageErrors.join('\n'))
  receipt.success = true
} catch (error) { receipt.error = String(error); throw error }
finally { await writeFile(path.join(output, 'production-receipt.json'), JSON.stringify(receipt, null, 2)); await browser.close() }
