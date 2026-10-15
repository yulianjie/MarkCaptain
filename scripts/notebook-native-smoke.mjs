// Run against an isolated debug WebView2 instance, never the user's installed app.
// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9335
import { chromium, expect } from '@playwright/test'
import { mkdir, writeFile, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
const output = path.resolve('output/notebook-native')
const root = path.join(output, `中文项目-${Date.now()}`)
await mkdir(path.join(root, 'a'), { recursive: true })
await mkdir(path.join(root, 'b'), { recursive: true })
await writeFile(path.join(root, 'a', '同名.md'), '# A\n')
await writeFile(path.join(root, 'b', '同名.md'), '# B\n')
await writeFile(path.join(root, '目标.md'), '---\naliases: [别名]\ntags: [work/team]\npriority: 3\nunknown: {x: y}\n---\n# 标题\n\n- [ ] native task\n')
const originalReference = Buffer.from('\uFEFF[[目标#标题|显示文字]]\r\n[显示](目标.md#标题)\r\n')
await writeFile(path.join(root, '引用.md'), originalReference)
const browser = await chromium.connectOverCDP(process.env.NOTEBOOK_CDP_URL ?? 'http://127.0.0.1:9335')
const page = browser.contexts().flatMap(c => c.pages()).find(p => /localhost:1420/.test(p.url()))
if (!page) throw new Error('No debug MarkCaptain webview found')
await page.waitForFunction(() => Boolean(document.getElementById('app')?.__vue_app__?.config.globalProperties.$pinia))
const receipt = { native: true, backendMocked: false, root, checks: [], pageErrors: [] }
page.on('pageerror', error => receipt.pageErrors.push(error.message))
const check = name => { receipt.checks.push(name); process.stdout.write(`${name}\n`) }
try {
  for (let attempt = 0; attempt < 50; attempt++) {
    const recovery = page.getByRole('button', { name: 'Recover Drafts', exact: true })
    if (await recovery.isVisible()) await recovery.click()
    const ready = await page.evaluate(async () => { const e = '/src/stores/editor.ts'; return !(await import(e)).useEditorStore().startupHydrationPending })
    if (ready) break
    await page.waitForTimeout(100)
  }
  await page.locator('.muya-host [contenteditable="true"]').first().waitFor({ state: 'attached' })
  await page.evaluate(async output => {
    const e = '/src/stores/editor.ts'; const editor = (await import(e)).useEditorStore()
    if (editor.tabs.some(t => t.pathname && !t.pathname.replaceAll('\\', '/').toLowerCase().startsWith(output.replaceAll('\\', '/').toLowerCase() + '/'))) throw new Error('Preview contains files outside the validation directory')
    for (const tab of [...editor.tabs]) await editor.closeTab(tab.id, true)
    editor.panes = [{ id: 'main', documentId: null, sourceMode: true }]; editor.activePaneId = ''; editor.activatePane('main')
  }, output)
  await page.evaluate(async root => {
    const projectModule = '/src/stores/project.ts'; const notesModule = '/src/stores/notebook.ts'; const editorModule = '/src/stores/editor.ts'
    const project = (await import(projectModule)).useProjectStore(); await project.openRoot(root)
    const notebook = (await import(notesModule)).useNotebookStore(); await notebook.rebuild(true)
    const editor = (await import(editorModule)).useEditorStore(); await editor.openFile(root + '/目标.md'); editor.sourceCodeMode = true
  }, root)
  await expect.poll(() => page.evaluate(async () => { const m = '/src/stores/notebook.ts'; const n = (await import(m)).useNotebookStore(); return [n.analyses.length, n.quickResults('同名').length, n.quickResults('别名')[0]?.relative] })).toEqual([4, 2, '目标.md'])
  check('real workspace scan, Chinese paths, aliases and same-name files')
  await page.evaluate(async () => { const n = '/src/stores/notebook.ts'; await (await import(n)).useNotebookStore().daily() })
  await page.locator('.editing-region.active .cm-content').waitFor()
  await page.evaluate(async () => { const e = '/src/stores/editor.ts'; const n = '/src/stores/notebook.ts'; const editor = (await import(e)).useEditorStore(); editor.applyAgentEdit(editor.currentFileId, editor.currentFile.markdown, '# native daily kept\n'); await (await import(n)).useNotebookStore().daily(); if (editor.currentFile.markdown !== '# native daily kept\n') throw new Error('daily overwrote unsaved content'); await editor.saveCurrent() })
  check('daily exclusive create and reopen without overwriting unsaved content')
  await page.evaluate(async () => { const e = '/src/stores/editor.ts'; const editor = (await import(e)).useEditorStore(); editor.applyAgentEdit(editor.currentFileId, editor.currentFile.markdown, '# unsaved before history restore\n') })
  await page.evaluate(async () => { const n = '/src/stores/notebook.ts'; (await import(n)).useNotebookStore().dialog = 'history' })
  await expect(page.locator('.versions button').first()).toBeVisible()
  await page.locator('.versions button').last().click()
  await expect(page.getByRole('button', { name: 'Restore current document', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Restore current document', exact: true }).click()
  await page.locator('.el-message-box .el-button--primary').click()
  await expect.poll(() => page.evaluate(async () => { const e = '/src/stores/editor.ts'; return (await import(e)).useEditorStore().currentFile.markdown })).not.toBe('# unsaved before history restore\n')
  await page.locator('.editing-region.active .cm-content').click(); await page.keyboard.press('Control+z')
  await expect(page.locator('.editing-region.active .cm-content')).toContainText('unsaved before history restore')
  check('native history list, body read, restore through editor and undo')
  await page.evaluate(async () => { const e = '/src/stores/editor.ts'; await (await import(e)).useEditorStore().saveAllTabs() })
  await page.evaluate(async root => { const p = '/src/stores/project.ts'; window.__nativeMove = (await import(p)).useProjectStore().renameEntry(root + '/目标.md', '改名.md') }, root)
  await page.locator('.el-message-box .el-button--primary').click()
  await page.evaluate(async () => { await window.__nativeMove })
  const rewritten = await readFile(path.join(root, '引用.md'))
  if (!rewritten.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) || !rewritten.toString().includes('[[改名#标题|显示文字]]\r\n') || !rewritten.toString().includes('%E6%94%B9%E5%90%8D.md#标题')) throw new Error('encoding/newline/display/anchor not preserved')
  check('native rename transaction preserves BOM, CRLF, labels and anchors')
  await page.evaluate(async () => { const n = '/src/stores/notebook.ts'; await (await import(n)).useNotebookStore().restoreReferences() })
  if (!(await readFile(path.join(root, '引用.md'))).equals(originalReference)) throw new Error('reference rollback differs from original bytes')
  check('native reference transaction recovery restores original bytes')
  await writeFile(path.join(root, '外部新增.md'), '# external\n')
  await expect.poll(() => page.evaluate(async () => { const n = '/src/stores/notebook.ts'; return (await import(n)).useNotebookStore().analyses.some(n => n.relative === '外部新增.md') })).toBe(true)
  await unlink(path.join(root, '外部新增.md'))
  await expect.poll(() => page.evaluate(async () => { const n = '/src/stores/notebook.ts'; return (await import(n)).useNotebookStore().analyses.some(n => n.relative === '外部新增.md') })).toBe(false)
  check('native filesystem watcher incrementally indexes external create and delete')
  await page.evaluate(async root => { const e = '/src/stores/editor.ts'; const editor = (await import(e)).useEditorStore(); await editor.openFile(root + '/目标.md'); editor.splitPane('horizontal') }, root)
  const second = page.locator('.editing-region').nth(1).locator('.cm-content')
  await second.click()
  const before = await page.evaluate(async () => { const e = '/src/stores/editor.ts'; const editor = (await import(e)).useEditorStore(); const before = editor.currentFile.markdown; editor.applyAgentEdit(editor.currentFileId, before, before + '\nNative reviewed edit\n'); return before })
  await expect(page.locator('.editing-region').first().locator('.cm-content')).toContainText('Native reviewed edit')
  await second.click(); await page.keyboard.press('Control+z')
  await expect.poll(() => page.evaluate(async () => { const e = '/src/stores/editor.ts'; return (await import(e)).useEditorStore().currentFile.markdown })).toBe(before)
  await page.keyboard.press('Control+y'); await expect(second).toContainText('Native reviewed edit')
  check('native shared regions, active edit target, undo and redo')
  await page.screenshot({ path: path.join(output, 'native-splits.png') })
  const dirtyPath = await page.evaluate(async () => { const e = '/src/stores/editor.ts'; const editor = (await import(e)).useEditorStore(); const tab = editor.currentFile; editor.applyAgentEdit(tab.id, tab.markdown, tab.markdown + '\nlocal unsaved conflict\n'); return tab.pathname })
  await writeFile(dirtyPath, '# external change must survive\n')
  await expect.poll(() => page.evaluate(async () => { const e = '/src/stores/editor.ts'; return Boolean((await import(e)).useEditorStore().currentFile?.externalChange) })).toBe(true)
  const blocked = await page.evaluate(async root => { const n = '/src/stores/notebook.ts'; try { await (await import(n)).useNotebookStore().moveWithReferences(root + '/目标.md', root + '/不能覆盖.md'); return false } catch { return true } }, root)
  if (!blocked || (await readFile(dirtyPath, 'utf8')) !== '# external change must survive\n') throw new Error('external conflict was overwritten')
  await expect(second).toContainText('local unsaved conflict')
  check('native unsaved/external conflict blocks reference updates and preserves both versions')
  // Resolve the fixture conflict prompt before force-closing its tab, so it
  // cannot intercept the next native verification script's interactions.
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'File changed outside MarkCaptain', exact: true })).toBeHidden()
  await page.evaluate(async () => { const e = '/src/stores/editor.ts'; const editor = (await import(e)).useEditorStore(); await editor.closeTab(editor.currentFileId, true) })
  await page.evaluate(async () => { const e = '/src/stores/editor.ts'; await (await import(e)).useEditorStore().saveAllTabs() })
  if (receipt.pageErrors.length) throw new Error(receipt.pageErrors.join('\n'))
  receipt.success = true
} catch (error) { receipt.success = false; receipt.error = String(error); throw error }
finally { await writeFile(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2)); await browser.close() }
