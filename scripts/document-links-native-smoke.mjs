// Run against a freshly built, isolated production-protocol validation binary.
// Backend filesystem and project indexing are real; user documents are untouched.
import { chromium, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const base = path.resolve('output/document-link-native')
const executable = path.resolve(process.argv[2] || path.join(base, 'MarkCaptain-Document-Link-Validation.exe'))
if (!executable.startsWith(base + path.sep)) throw new Error('Expected an isolated validation executable')
const identifier = 'io.github.yulianjie.markcaptain.document-link-validation'
const root = path.join(base, `run-${Date.now()}`)
const port = 9359
const source = path.join(root, 'docs', 'README.md')
const target = path.join(root, 'docs', 'M2_REVIEW_FIXES.md')
const chinese = path.join(root, '审查 记录.md')
const markdown = '# Source\n\n[审查整改记录](M2_REVIEW_FIXES.md)\n\n[当前章节](#19-术语表遇到缩写时回来查)\n\n[中文锚点](../审查%20记录.md#整改)\n\n[引用链接][review]\n\n[缺失文档](missing.md)\n\n[review]: M2_REVIEW_FIXES.md\n\n'
  + Array.from({ length: 55 }, (_, i) => `Scroll verification paragraph ${i + 1}.\n\n`).join('')
  + '## 19. 术语表：遇到缩写时回来查\n\nNATIVE_SAME_DOCUMENT_ANCHOR\n'
const originals = new Map([[source, markdown], [target, '# Fixes\n\nNATIVE_REVIEW_FIXES_BODY\n'], [chinese, '# 审查记录\n\nIntro\n\n## 整改\n\nNATIVE_CHINESE_HEADING_BODY\n']])
const receipt = { native: true, backendMocked: false, productionProtocol: true, success: false, root, checks: [], pageErrors: [] }
const ipcCommands = new Set()
const shellOpens = []
let ipcFallback = false
const normalize = value => String(value || '').replace(/^\\\\\?\\/, '').replaceAll('\\', '/').toLowerCase()
const record = (name, detail) => { receipt.checks.push({ name, detail }); process.stdout.write(name + '\n') }
let child, browser, log = ''
const snapshot = page => page.evaluate(() => {
  const stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
  const editor = stores.get('editor')
  return { current: editor.currentFile?.pathname, markdown: editor.currentFile?.markdown, cursor: editor.currentFile?.cursor, paths: editor.tabs.map(tab => tab.pathname), notebookError: stores.get('notebook').error }
})
async function openSource(page) {
  await page.evaluate(async source => {
    const editor = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('editor')
    await editor.openFile(source)
    editor.sourceCodeMode = false
  }, source)
  await expect(page.locator('.muya-host a[href]').filter({ hasText: '审查整改记录' })).toBeVisible()
}
async function active(page, pathname) {
  await expect.poll(async () => normalize((await snapshot(page)).current)).toBe(normalize(pathname))
}

try {
  await mkdir(path.dirname(source), { recursive: true })
  for (const [file, text] of originals) await writeFile(file, text)
  const appData = path.join(process.env.APPDATA, identifier)
  await mkdir(appData, { recursive: true })
  await writeFile(path.join(appData, 'preferences.json'), JSON.stringify({ language: 'en', autoSave: false, autoCheckUpdates: false, startUpAction: 'blank', _userData: {} }))
  child = spawn(executable, [source], { cwd: root, windowsHide: true, env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => { log += data })
  child.stderr.on('data', data => { log += data })
  await expect.poll(async () => {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); return true } catch { return false }
  }, { timeout: 30000 }).toBe(true)
  const context = browser.contexts()[0]
  await expect.poll(() => context.pages().length).toBeGreaterThan(0)
  const page = context.pages()[0]
  page.on('pageerror', error => receipt.pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.hostname !== 'ipc.localhost' && url.protocol !== 'ipc:') return
    const command = decodeURIComponent(url.pathname.slice(1))
    ipcCommands.add(command)
    if (command === 'plugin:shell|open') shellOpens.push(request.postDataJSON()?.path)
  })
  page.on('console', message => {
    if (message.text().includes('IPC custom protocol failed')) ipcFallback = true
  })
  await page.waitForURL(/^http:\/\/tauri\.localhost\/#\//, { timeout: 30000 })
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.get('editor')?.startupHydrationPending === false)
  expect(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:app|identifier'))).toBe(identifier)
  await active(page, source)
  expect(await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('project').projectTree)).toBeNull()
  expect(page.url()).toMatch(/^http:\/\/tauri\.localhost\/#\//)
  const initialUrl = page.url()
  const initialPages = context.pages().length

  await page.getByRole('link', { name: '审查整改记录', exact: true }).click()
  await active(page, source)
  expect(page.url()).toBe(initialUrl)
  expect(context.pages()).toHaveLength(initialPages)
  expect(shellOpens).toEqual([])
  record('plain click keeps the source document and prevents WebView/browser navigation')

  await page.getByRole('link', { name: '审查整改记录', exact: true }).click({ modifiers: ['Control'] })
  await active(page, target)
  await expect(page.locator('.muya-host')).toContainText('NATIVE_REVIEW_FIXES_BODY')
  await expect(page.locator('.ag-link-tools').locator('..')).not.toHaveAttribute('x-placement', /.+/)
  record('Ctrl-click reads the actual relative Markdown file through Rust without a project', await snapshot(page))

  await openSource(page)
  const sameDocumentHeading = page.locator('.muya-host h2').filter({ hasText: '19. 术语表' })
  await expect(sameDocumentHeading).not.toBeInViewport()
  const beforeSameDocumentJump = (await snapshot(page)).markdown
  await page.getByRole('link', { name: '当前章节', exact: true }).hover()
  await page.locator('.ag-link-tools .jump').click()
  await expect(sameDocumentHeading).toBeInViewport()
  await active(page, source)
  expect((await snapshot(page)).markdown).toBe(beforeSameDocumentJump)
  record('the exact same-document Chinese anchor scrolls its preserved heading into view without changing Markdown')

  await openSource(page)
  await page.getByRole('link', { name: '中文锚点', exact: true }).click({ modifiers: ['Control'] })
  await active(page, chinese)
  await expect(page.locator('.muya-host')).toContainText('NATIVE_CHINESE_HEADING_BODY')
  await expect.poll(async () => (await snapshot(page)).cursor?.anchor?.line).toBe(4)
  record('parent directory, Chinese/space URL encoding and heading reveal work with real files', await snapshot(page))

  await openSource(page)
  await page.getByRole('link', { name: '引用链接', exact: true }).click({ modifiers: ['Control'] })
  await active(page, target)
  record('reference-style links open the target inside the native editor')

  await openSource(page)
  await page.getByRole('link', { name: '审查整改记录', exact: true }).hover()
  await page.locator('.ag-link-tools .jump').click()
  await active(page, target)
  record('the link popup jump uses the same native document navigation')

  await openSource(page)
  await page.evaluate(() => { document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('editor').sourceCodeMode = true })
  await page.locator('.cm-line').filter({ hasText: '[审查整改记录]' }).click({ modifiers: ['Control'], position: { x: 30, y: 8 } })
  await active(page, target)
  await expect(page.locator('.cm-content')).toContainText('NATIVE_REVIEW_FIXES_BODY')
  record('source mode follows the relative link through real Rust file reading')

  await openSource(page)
  await page.getByRole('link', { name: '缺失文档', exact: true }).click()
  await active(page, source)
  expect(shellOpens).toEqual([])
  record('plain click on a missing file does not invoke the real native shell')
  await page.getByRole('link', { name: '缺失文档', exact: true }).click({ modifiers: ['Control'] })
  await expect.poll(async () => (await snapshot(page)).notebookError).not.toBe('')
  await active(page, source)
  record('a missing file reports an error and preserves the source document', (await snapshot(page)).notebookError)

  await page.evaluate(async root => {
    const stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
    await stores.get('project').openRoot(root)
    await stores.get('notebook').rebuild(true)
  }, root)
  await expect.poll(() => page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('notebook').analyses.length)).toBe(3)
  await openSource(page)
  await page.getByRole('link', { name: '审查整改记录', exact: true }).click({ modifiers: ['Control'] })
  await active(page, target)
  expect((await snapshot(page)).paths.filter(file => normalize(file) === normalize(target))).toHaveLength(1)
  record('project-index navigation reuses the existing target tab without duplicates')

  expect(page.url()).toBe(initialUrl)
  expect(context.pages()).toHaveLength(initialPages)
  expect(shellOpens).toEqual([])
  expect(ipcFallback).toBe(false)
  expect(ipcCommands.has('cmd_read_markdown')).toBe(true)
  receipt.nativeShellObservation = { transport: 'real IPC requests', observedFileReads: true, shellOpens, ipcFallback }
  for (const [file, text] of originals) expect(await readFile(file, 'utf8')).toBe(text)
  expect(receipt.pageErrors).toEqual([])
  record('no WebView navigation, extra windows, JavaScript errors or source-file writes')
  await expect(page.locator('.ag-link-tools').locator('..')).toHaveCSS('opacity', '0')
  await page.screenshot({ path: path.join(root, 'native.png') })
  receipt.success = true
  if (process.env.DOCUMENT_LINK_INSPECT === '1') {
    await writeFile(path.join(base, 'inspection-ready.json'), JSON.stringify({ root, pid: child.pid }))
    await new Promise(resolve => setTimeout(resolve, 30000))
  }
} catch (error) {
  receipt.error = error.stack || String(error)
  process.exitCode = 1
} finally {
  await writeFile(path.join(root, 'native.log'), log)
  await writeFile(path.join(root, 'receipt.json'), JSON.stringify(receipt, null, 2))
  if (browser) {
    for (const page of browser.contexts().flatMap(context => context.pages())) {
      await page.evaluate(async identifier => {
        if (await window.__TAURI_INTERNALS__.invoke('plugin:app|identifier') === identifier) await window.__TAURI_INTERNALS__.invoke('cmd_destroy_editor_window')
      }, identifier).catch(() => undefined)
    }
    await browser.close().catch(() => undefined)
  }
  if (child && child.exitCode === null) child.kill()
  process.stdout.write(JSON.stringify(receipt, null, 2) + '\n')
}
