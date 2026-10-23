// Windows production-protocol acceptance against an isolated validation binary.
// Build with output/file-open-native/tauri.validation.json, then pass the copied exe.
// No file associations or user preferences are changed.
import { chromium, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const executable = path.resolve(process.argv[2] || 'output/file-open-native/MarkCaptain-File-Open-Validation.exe')
const base = path.resolve('output/file-open-native')
if (!executable.startsWith(`${base}${path.sep}`)) throw new Error('Expected an isolated validation executable')
const identifier = 'io.github.yulianjie.markcaptain.file-open-validation'
const root = path.join(base, `run-${Date.now()}`)
const port = 9357
const receipt = { native: true, backendMocked: false, productionProtocol: true, success: false, checks: [], root }
let child, browser, log = ''
const children = []
const normalize = value => String(value || '').replace(/^\\\\\?\\/, '').replaceAll('\\', '/').toLowerCase()
const record = (name, detail) => { receipt.checks.push({ name, detail }); process.stdout.write(`${name}\n`) }
const launch = (files, cwd = root) => {
  const process = spawn(executable, files, {
    cwd, windowsHide: true,
    env: { ...globalThis.process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(process)
  process.stdout.on('data', data => { log += data })
  process.stderr.on('data', data => { log += data })
  return process
}
const snapshot = page => page.evaluate(() => {
  const editor = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('editor')
  return { current: editor.currentFile?.pathname, paths: editor.tabs.map(tab => tab.pathname), markdown: editor.currentFile?.markdown }
})
async function active(page, file) {
  await expect.poll(async () => normalize((await snapshot(page)).current), { timeout: 20000 }).toBe(normalize(file))
  await expect(page.locator('.editing-region.active')).toContainText(path.basename(file, '.md'))
}
async function ready(page) {
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.has('editor'))
  const actual = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:app|identifier'))
  if (actual !== identifier) throw new Error(`Refusing application ${actual}`)
}

try {
  await mkdir(root, { recursive: true })
  const files = Object.fromEntries(['restored', '首次 中文 file', 'during-startup', 'next', 'other-window'].map(name => [name, path.join(root, `${name}.md`)]))
  for (const [name, file] of Object.entries(files)) await writeFile(file, `# ${name}\n\nNATIVE_FILE_OPEN_${name}\n`)
  const appData = path.join(process.env.APPDATA, identifier)
  await mkdir(appData, { recursive: true })
  await writeFile(path.join(appData, 'preferences.json'), JSON.stringify({
    language: 'en', autoSave: false, autoCheckUpdates: false, startUpAction: 'lastState',
    _userData: { editorSession: { version: 1, cleanShutdown: true, timestamp: Date.now(), activeTabIndex: 0,
      tabs: [{ dirty: false, path: files.restored, sourceMode: false }] } },
  }))
  child = launch([files['首次 中文 file']])
  await expect.poll(async () => {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 1000 }); return true }
    catch { return false }
  }, { timeout: 20000 }).toBe(true)
  const context = browser.contexts()[0]
  await expect.poll(() => context.pages().length, { timeout: 20000 }).toBeGreaterThan(0)
  const page = context.pages()[0]
  await ready(page)
  await active(page, files['首次 中文 file'])
  expect((await snapshot(page)).paths.map(normalize)).toContain(normalize(files.restored))
  record('single cold launch opens Unicode/spaced argv and selects it after session restoration', await snapshot(page))

  // Hold an actual startup IPC until explicitly released. All filesystem/session
  // reads still use Rust; the delay deterministically exceeds the old 250ms timer.
  await page.addInitScript(() => {
    const install = () => {
      const callbacks = window.__TAURI_INTERNALS__?.callbacks
      if (!callbacks) { setTimeout(install, 0); return }
      const original = callbacks.set
      callbacks.set = function(id, callback) {
        return original.call(this, id, function(data) {
          if (data?.version === 1 && Array.isArray(data.tabs) && typeof data.cleanShutdown === 'boolean' && !window.__fileOpenRestoreHeld) {
            window.__fileOpenRestoreHeld = true
            window.__releaseFileOpenRestore = () => callback(data)
            return
          }
          return callback(data)
        })
      }
    }
    install()
  })
  await page.reload()
  await ready(page)
  await page.waitForFunction(() => window.__fileOpenRestoreHeld)
  const forwarded = launch([path.basename(files['during-startup'])])
  await expect.poll(() => forwarded.exitCode, { timeout: 10000 }).toBe(0)
  await new Promise(resolve => setTimeout(resolve, 1000))
  expect((await snapshot(page)).paths.map(normalize)).not.toContain(normalize(files['during-startup']))
  await page.evaluate(() => window.__releaseFileOpenRestore())
  await active(page, files['during-startup'])
  record('second instance during delayed session hydration remains queued, resolves relative argv and opens after hydration', await snapshot(page))

  launch([files.next, files['during-startup'], files.next])
  await active(page, files.next)
  await expect.poll(async () => (await snapshot(page)).paths.filter(file => normalize(file) === normalize(files.next)).length).toBe(1)
  record('live multi-file forwards stay ordered and repeated paths reuse one tab', await snapshot(page))

  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('cmd_new_window', { label: 'editor-file-open-test' }))
  await expect.poll(() => context.pages().length).toBe(2)
  const other = context.pages().find(candidate => candidate !== page)
  await ready(other)
  await other.waitForFunction(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('editor').startupHydrationPending === false)
  await other.bringToFront()
  await other.evaluate(() => window.__TAURI_INTERNALS__.invoke('cmd_show_window'))
  launch([files['other-window']])
  await active(other, files['other-window'])
  expect((await snapshot(page)).paths.map(normalize)).not.toContain(normalize(files['other-window']))
  record('forwarded opens reach only the focused editor window', { main: await snapshot(page), other: await snapshot(other) })

  await page.screenshot({ path: path.join(root, 'main.png') })
  await other.screenshot({ path: path.join(root, 'other.png') })
  for (const [name, file] of Object.entries(files)) expect(await readFile(file, 'utf8')).toBe(`# ${name}\n\nNATIVE_FILE_OPEN_${name}\n`)
  receipt.success = true
} catch (error) {
  receipt.error = error.stack || String(error)
  process.exitCode = 1
} finally {
  await writeFile(path.join(root, 'native.log'), log)
  await writeFile(path.join(root, 'receipt.json'), JSON.stringify(receipt, null, 2))
  if (browser) {
    for (const page of browser.contexts().flatMap(context => context.pages())) {
      await page.evaluate(async () => {
        if (await window.__TAURI_INTERNALS__.invoke('plugin:app|identifier') !== 'io.github.yulianjie.markcaptain.file-open-validation') return
        await window.__TAURI_INTERNALS__.invoke('cmd_destroy_editor_window')
      }).catch(() => undefined)
    }
    await browser.close().catch(() => undefined)
  }
  // Only processes spawned by this script can be terminated here.
  for (const process of children) if (process.exitCode === null) process.kill()
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`)
}
