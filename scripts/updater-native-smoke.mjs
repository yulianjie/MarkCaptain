// Use only with an isolated debug build configured for this local test endpoint.
// Never call install() on the fixture: it is signed test data, not an installer.
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { chromium, expect } from '@playwright/test'

const output = 'output/updater-validation'
await mkdir(output, { recursive: true })
const bytes = await readFile(`${output}/signed.bin`)
const signature = await readFile(`${output}/signed.bin.sig`, 'utf8')
let tamper = false
const server = createServer((request, response) => {
  if (request.url === '/latest.json') {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ version: '9.0.0', notes: 'Native signed updater test', platforms: {
      'windows-x86_64': { url: 'http://127.0.0.1:19336/update.exe', signature: signature.trim() },
    } }))
  } else if (request.url === '/update.exe') {
    response.end(tamper ? Buffer.from('tampered update') : bytes)
  } else { response.writeHead(404); response.end() }
})
await new Promise(resolve => server.listen(19336, '127.0.0.1', resolve))
console.log('Fixture server listening on 19336; waiting for isolated WebView2 on 19335')
let browser
const results = []
const errors = []
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:19335'); break }
    catch { await new Promise(resolve => setTimeout(resolve, 300)) }
  }
  if (!browser) throw new Error('Isolated native test app did not start')
  const context = browser.contexts()[0]
  const page = context.pages()[0] ?? await context.waitForEvent('page')
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => document.querySelector('.editor-page'))
  const metadata = await page.evaluate(async () => {
    const path = '/node_modules/@tauri-apps/plugin-updater/dist-js/index.js'
    const { check } = await import(path)
    const update = await check({ timeout: 5000 })
    if (!update || update.version !== '9.0.0') throw new Error('Native update metadata missing')
    try { await update.download() } finally { await update.close() }
    return { version: update.version, downloaded: true }
  })
  results.push({ nativeSignedDownload: metadata })
  tamper = true
  const rejected = await page.evaluate(async () => {
    const path = '/node_modules/@tauri-apps/plugin-updater/dist-js/index.js'
    const { check } = await import(path)
    const update = await check({ timeout: 5000 })
    try {
      await update.download()
      return false
    } catch { return true }
    finally { await update.close() }
  })
  if (!rejected) throw new Error('Native updater accepted a tampered artifact')
  results.push({ nativeTamperedDownloadRejected: true })
  tamper = false
  await page.evaluate(async () => {
    const preferences = '/src/stores/preferences.ts'
    const i18n = '/src/i18n/index.ts'
    const p = (await import(preferences)).usePreferencesStore()
    await p.set('language', 'zh-CN')
    ;(await import(i18n)).setLocale('zh-CN')
    const bus = '/src/bus.ts'
    ;(await import(bus)).bus.emit('show-updater-dialog')
  })
  const dialog = page.getByRole('dialog', { name: '检查更新', exact: true })
  await expect(dialog).toContainText('9.0.0')
  await expect(dialog).toContainText('Native signed updater test')
  await page.screenshot({ path: `${output}/native-updater.png` })
  await page.evaluate(async () => {
    const path = '/src/services/tauri-invoke.ts'
    await (await import(path)).newWindow()
  })
  await expect.poll(() => context.pages().length).toBeGreaterThan(1)
  await dialog.getByRole('button', { name: '下载并安装', exact: true }).click()
  await expect(page.locator('.el-message')).toContainText('请先关闭其他编辑器窗口')
  await expect(dialog.getByRole('button', { name: '下载并安装', exact: true })).toBeVisible()
  results.push({ nativeDialogLocalized: true, multipleWindowsBlockInstall: true })
  await writeFile(`${output}/native-result.json`, JSON.stringify({ results, pageErrors: errors }, null, 2))
  if (errors.length) throw new Error(`Native renderer errors: ${errors.join('; ')}`)
  console.log(JSON.stringify({ results, pageErrors: errors }, null, 2))
} finally {
  await browser?.close()
  await new Promise(resolve => server.close(resolve))
}
