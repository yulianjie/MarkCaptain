#!/usr/bin/env node
// M3 acceptance against an already-running isolated, bundled Tauri WebView2.
// No mocked filesystem or writer; a callback gate only delays one real result.
import { chromium, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile, readdir, stat, realpath, lstat, rename } from 'node:fs/promises'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'

const base = path.resolve('output/m3-native')
const run = path.join(base, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const root = path.join(run, 'project')
const cdp = process.env.M3_CDP_URL || 'http://127.0.0.1:9343'
const identifier = 'io.github.yulianjie.markcaptain.m3-validation'
const receipt = { schemaVersion: 1, native: true, productionProtocol: true, backendMocked: false, success: false, checks: [], pageErrors: [], run }
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const hash = value => createHash('sha256').update(value).digest('hex')
const normal = value => path.resolve(String(value).replace(/^\\\\\?\\/, '')).replaceAll('\\', '/').toLowerCase()
const inside = (parent, child) => normal(child) === normal(parent) || normal(child).startsWith(`${normal(parent)}/`)
const record = (name, details) => { receipt.checks.push({ name, details }); process.stdout.write(`${name}\n`) }
const output = path.join(root, 'exports')
const alpha = path.join(root, 'a', 'Guide.md'), beta = path.join(root, 'b', 'Guide.md')
let browser, page
const profile = {
  id: 'm3-native', name: 'M3 Native', theme: 'technical', content: { mode: 'current', source: 'buffer' }, formats: ['html', 'pdf', 'docx', 'odt', 'epub'],
  output: { directory: 'exports', fileName: '{name}' }, typography: { bodyFont: 'system-cjk', codeFont: 'system-monospace', bodySizePt: 11, lineHeight: 1.65 },
  page: { size: 'A4', orientation: 'portrait', marginMm: { top: 20, right: 20, bottom: 20, left: 20 } }, toc: { enabled: true, depth: 3 }, numberHeadings: false,
  resources: { htmlMode: 'embed', downloadRemote: false }, html: { showTitle: true }, pdf: { backend: 'pandoc' }, docx: { stylePreset: 'technical' }, epub: { stylePreset: 'technical' },
}

async function setup() {
  const existing = await lstat(base).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
  assert(!existing?.isSymbolicLink(), 'Refusing aliased output root')
  await mkdir(base, { recursive: true })
  assert(normal(await realpath(base)) === normal(base), 'Output root escapes workspace')
  for (const folder of ['a', 'b', 'exports', 'published', 'build']) await mkdir(path.join(root, folder), { recursive: true })
  await writeFile(alpha, '---\naliases: [Alpha]\n---\n\n# Same\n\nA_DISK 文档\n\n![A image](image.svg)\n\n[[Beta#Same|to beta]]\n\nA note[^same].\n\n[^same]: A footnote\n')
  await writeFile(beta, '---\naliases: [Beta]\n---\n\n<h2 id="manual">Manual heading</h2>\n\n# Same\n\nB_DISK 文档\n\n![B image](image.svg)\n\n[Back](../a/Guide.md#Same)\n\nB note[^same].\n\n[^same]: B footnote\n\n$E=mc^2$\n\n```mermaid\ngraph TD\nA[Local] --> B[Book]\n```\n')
  for (const [folder, label, color] of [['a', 'A_ASSET', '#075a9c'], ['b', 'B_ASSET', '#963b38']]) await writeFile(path.join(root, folder, 'image.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><rect width="200" height="60" fill="${color}"/><text x="10" y="35" fill="white">${label}</text></svg>`)
  for (const folder of ['exports', 'published', 'build']) await writeFile(path.join(root, folder, 'Never.md'), `NEVER_INCLUDE_${folder}`)
  const deadline = Date.now() + 15000
  while (!browser) {
    try { browser = await chromium.connectOverCDP(cdp, { timeout: 3000 }) }
    catch (error) { if (Date.now() > deadline) throw error; await new Promise(resolve => setTimeout(resolve, 250)) }
  }
  const candidates = browser.contexts().flatMap(context => context.pages()).filter(candidate => /^(http:\/\/tauri\.localhost|tauri:)/.test(candidate.url()))
  assert(candidates.length === 1, 'Expected one native production-protocol WebView')
  page = candidates[0]
  page.on('pageerror', error => receipt.pageErrors.push(error.message))
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.has('editor'))
  receipt.app = await page.evaluate(async () => ({ identifier: await window.__TAURI_INTERNALS__.invoke('plugin:app|identifier'), version: await window.__TAURI_INTERNALS__.invoke('plugin:app|version'), url: location.href }))
  assert(receipt.app.identifier === identifier, `Refusing app ${receipt.app.identifier}`)
  const expectedBundle = (await readdir('dist/assets')).find(name => /^EditorPage-.*\.js$/.test(name))
  assert(await page.evaluate(name => performance.getEntriesByType('resource').some(resource => resource.name.endsWith(`/${name}`)), expectedBundle), 'Native frontend bundle is stale')
  await page.evaluate(() => { window.__m3Stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s })
  const recovery = page.getByRole('dialog', { name: 'Recover unsaved drafts?', exact: true })
  await expect.poll(async () => await recovery.isVisible() || await page.evaluate(() => !window.__m3Stores.get('editor').startupHydrationPending)).toBe(true)
  if (await recovery.isVisible()) await recovery.getByRole('button', { name: 'Recover Drafts', exact: true }).click()
  await expect.poll(() => page.evaluate(() => !window.__m3Stores.get('editor').startupHydrationPending)).toBe(true)
  const startup = await page.evaluate(() => ({ paths: window.__m3Stores.get('editor').tabs.map(tab => tab.pathname).filter(Boolean), root: window.__m3Stores.get('project').projectTree?.pathname }))
  for (const pathname of [...startup.paths, ...(startup.root ? [startup.root] : [])]) assert(inside(base, pathname), 'Refusing restored user project')
  await page.evaluate(async ({ root, alpha, profile }) => {
    const stores = window.__m3Stores
    stores.get('preferences').autoSave = false
    stores.get('editor').sourceCodeMode = true
    await stores.get('project').openRoot(root)
    await stores.get('editor').openFile(alpha)
    const additional = { ...profile, id: 'published', name: 'Published', output: { ...profile.output, directory: 'published' } }
    await window.__TAURI_INTERNALS__.invoke('cmd_export_save_config', { root, config: { schemaVersion: 1, defaultProfile: profile.id, profiles: [profile, additional], futureExtension: { retained: true } }, expectedFingerprint: null })
    const callbacks = window.__TAURI_INTERNALS__.callbacks
    const original = callbacks.set
    window.__m3CallbackDescriptor = Object.getOwnPropertyDescriptor(callbacks, 'set')
    callbacks.set = function(id, callback) {
      return original.call(this, id, function(data) {
        if (window.__m3HoldWrite && data?.status === 'completed' && data.outputPath) {
          window.__m3HoldWrite = false; window.__m3Held = true
          window.__m3Release = () => { window.__m3Release = null; return callback(data) }
          return
        }
        return callback(data)
      })
    }
  }, { root, alpha, profile })
  const editor = page.locator('.editing-region.active .cm-content:visible').first()
  await editor.click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('\nNATIVE_DIRTY_未保存😀\n')
  await expect.poll(() => page.evaluate(() => window.__m3Stores.get('editor').currentFile.markdown)).toContain('NATIVE_DIRTY_未保存😀')
  await page.evaluate(() => {
    const editor = window.__m3Stores.get('editor')
    const tab = editor.newUntitledTab('# Loose note\n\nUNTITLED_M3_ONLY\n')
    tab.pendingBaselineUpdate = false
    window.__m3UntitledName = tab.filename
    window.__m3Stores.get('commandCenter').execute('file.exportHtml')
  })
  await page.getByTestId('project-export-open').click()
  await expect(page.getByTestId('project-export-dialog')).toBeVisible()
  await expect(page.getByTestId('project-export-candidate')).toHaveCount(2)
  await page.getByTestId('project-export-candidate').filter({ hasText: 'a/Guide.md' }).locator('input').check()
  await page.getByTestId('project-export-candidate').filter({ hasText: 'b/Guide.md' }).locator('input').check()
  const untitled = await page.evaluate(() => window.__m3UntitledName)
  await page.getByTestId('project-export-untitled').filter({ hasText: untitled }).locator('input').check()
  record('native identity, current production bundle and real candidate exclusions', { ...receipt.app, expectedBundle, root })
}

const rows = () => page.getByTestId('project-export-result')
async function outputs() { return rows().evaluateAll(elements => elements.map(row => ({ path: row.querySelector('td')?.textContent?.trim(), status: row.querySelectorAll('td')[1]?.textContent?.trim(), error: row.querySelectorAll('td')[2]?.textContent?.trim() }))) }
async function review() {
  await page.getByTestId('project-export-review').click()
  await expect.poll(() => rows().count(), { timeout: 60000 }).toBeGreaterThan(0)
  await expect(page.getByTestId('project-export-review')).toBeEnabled({ timeout: 60000 })
  const acknowledge = page.getByTestId('project-export-acknowledge')
  if (await acknowledge.count()) await acknowledge.check()
  await expect(page.getByTestId('project-export-run')).toBeEnabled({ timeout: 60000 })
}
async function waitResults() {
  await expect.poll(async () => await page.getByTestId('project-export-review').isEnabled()
    && await rows().evaluateAll(elements => elements.every(row => /^(Completed|Failed|Cancelled)$/.test(row.querySelectorAll('td')[1]?.textContent?.trim() ?? ''))), { timeout: 120000 }).toBe(true)
}
async function safeFile(file) { assert(inside(output, file), `Output escaped fixture: ${file}`); return readFile(file) }

function zipMembers(data) {
  let end = -1
  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 65557); offset--) if (data.readUInt32LE(offset) === 0x06054b50) { end = offset; break }
  assert(end >= 0, 'Missing ZIP directory')
  let offset = data.readUInt32LE(end + 16), total = 0
  const entries = []
  for (let index = 0; index < data.readUInt16LE(end + 10); index++) {
    assert(offset + 46 <= data.length && data.readUInt32LE(offset) === 0x02014b50, 'Invalid ZIP directory')
    const method = data.readUInt16LE(offset + 10), size = data.readUInt32LE(offset + 20), uncompressed = data.readUInt32LE(offset + 24)
    const nameLength = data.readUInt16LE(offset + 28), extra = data.readUInt16LE(offset + 30), comment = data.readUInt16LE(offset + 32)
    const local = data.readUInt32LE(offset + 42), name = data.toString('utf8', offset + 46, offset + 46 + nameLength)
    total += uncompressed
    assert(uncompressed < 64 * 1024 * 1024 && total < 128 * 1024 * 1024 && local + 30 <= data.length && data.readUInt32LE(local) === 0x04034b50, 'Invalid or oversized ZIP entry')
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28)
    const compressed = data.subarray(start, start + size)
    const content = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed, { maxOutputLength: 64 * 1024 * 1024 }) : null
    assert(content && content.length === uncompressed, 'Unsupported ZIP entry')
    entries.push({ name, content }); offset += 46 + nameLength + extra + comment
  }
  return entries
}

async function batch() {
  await page.getByTestId('project-export-formats').locator('input[value="docx"]').check()
  await review()
  const planned = await outputs()
  assert(planned.length === 6 && new Set(planned.map(item => item.path.toLowerCase())).size === 6, 'Batch names collide')
  for (const item of planned) assert(inside(output, item.path), 'Planned output escaped configured directory')
  const blocked = planned[0].path
  await writeFile(blocked, 'KEEP_OLD_OUTPUT')
  await page.getByTestId('project-export-run').click(); await waitResults()
  const partial = await outputs()
  assert(partial.filter(item => item.status === 'Completed').length === 5 && partial.filter(item => item.status === 'Failed').length === 1, `Partial results wrong: ${JSON.stringify(partial)}`)
  assert((await readFile(blocked, 'utf8')) === 'KEEP_OLD_OUTPUT', 'Existing file overwritten without permission')
  const completed = new Map(await Promise.all(partial.filter(item => item.status === 'Completed').map(async item => [item.path, (await stat(item.path)).mtimeMs])))
  const preserved = `${blocked}.preserved`
  assert(inside(output, preserved), 'Preserved path escaped fixture')
  await rename(blocked, preserved)
  await page.getByTestId('project-export-retry').click(); await waitResults()
  assert((await outputs()).every(item => item.status === 'Completed'), 'Retry did not complete failed item')
  for (const [file, modified] of completed) assert((await stat(file)).mtimeMs === modified, 'Retry rewrote successful output')
  const htmls = await Promise.all(planned.filter(item => item.path.endsWith('.html')).map(async item => (await safeFile(item.path)).toString('utf8')))
  assert(htmls.some(html => html.includes('NATIVE_DIRTY_未保存😀')) && htmls.some(html => html.includes('UNTITLED_M3_ONLY')), 'Batch lost dirty or untitled text')
  assert((await readFile(alpha, 'utf8')).includes('A_DISK') && !(await readFile(alpha, 'utf8')).includes('NATIVE_DIRTY'), 'Batch saved the source buffer')
  record('six actual HTML/DOCX outputs: collision-safe names, preserved old file, partial failure and version-checked retry', { planned, preserved })
}

async function cancellationAndChangedRetry() {
  await page.getByTestId('project-export-formats').locator('input[value="docx"]').uncheck()
  await page.getByTestId('project-export-filename').fill('cancel-{name}')
  await review()
  const planned = await outputs()
  await page.evaluate(() => { window.__m3HoldWrite = true; window.__m3Held = false })
  await page.getByTestId('project-export-run').click()
  await expect.poll(() => page.evaluate(() => window.__m3Held)).toBe(true)
  await page.getByTestId('project-export-cancel').click()
  await page.evaluate(() => window.__m3Release())
  await waitResults()
  const after = await outputs()
  assert(after.filter(item => item.status === 'Completed').length === 1 && after.filter(item => item.status === 'Cancelled').length === 2, 'Cancel lost saved result or ran later items')
  assert((await readdir(output)).filter(name => name.startsWith('cancel-')).length === 1, 'Cancel wrote subsequent outputs')
  await writeFile(beta, `${await readFile(beta, 'utf8')}\nCHANGED_BETWEEN_ATTEMPTS\n`)
  await page.getByTestId('project-export-retry').click()
  await expect(page.getByTestId('project-export-dialog')).toContainText('Source versions changed')
  assert((await readdir(output)).filter(name => name.startsWith('cancel-')).length === 1, 'Changed-source retry wrote another file')
  record('cancel preserves first committed file; later items stop and changed-source retry is refused', { planned, after })
}

async function book() {
  const sourceHashes = { alpha: hash(await readFile(alpha)), beta: hash(await readFile(beta)) }
  await page.getByTestId('project-export-mode').selectOption('book')
  await page.getByTestId('project-export-book-title').fill('M3 Native Handbook')
  await page.getByTestId('project-export-book-filename').fill('native-handbook')
  const chapters = page.getByTestId('project-export-chapter')
  await chapters.nth(0).locator('.chapter-controls input').first().fill('Alpha chapter')
  await chapters.nth(1).locator('.chapter-controls input').first().fill('Beta chapter')
  await chapters.nth(1).getByRole('button', { name: 'Move up: Beta chapter', exact: true }).click()
  for (const format of ['pdf', 'docx', 'odt', 'epub']) await page.getByTestId('project-export-formats').locator(`input[value="${format}"]`).check()
  await page.getByTestId('project-export-save').click()
  await expect(page.getByTestId('project-export-dialog')).toContainText('Project plan saved.')
  const config = JSON.parse(await readFile(path.join(root, '.markcaptain', 'export.json'), 'utf8'))
  assert(config.futureExtension?.retained && config.projectExport.chapters.length === 2 && config.projectExport.chapters[0].path === 'b/Guide.md' && !JSON.stringify(config.projectExport).includes('UNTITLED_M3_ONLY'), 'Persisted plan lost order/extension or included an untitled body')
  await review()
  const frame = page.frameLocator('.project-export-dialog iframe.preview-frame')
  const content = await frame.locator('article').evaluate(article => {
    const ids = [...article.querySelectorAll('[id]')].map(node => node.id)
    const toBeta = [...article.querySelectorAll('a')].find(node => node.textContent === 'to beta')
    const target = toBeta?.getAttribute('href')?.slice(1)
    return { text: article.textContent, duplicateIds: ids.length - new Set(ids).size, target: target ? article.ownerDocument.getElementById(decodeURIComponent(target))?.textContent : null,
      imageSources: [...article.querySelectorAll('img[src^="data:image/svg+xml"]')].map(image => image.getAttribute('src')),
      footnotes: [...article.querySelectorAll('a.footnote-ref[href], a[role="doc-noteref"][href]')].map(anchor => ({ href: anchor.getAttribute('href'), text: article.ownerDocument.getElementById(anchor.getAttribute('href').slice(1))?.textContent })) }
  })
  assert(content.text.indexOf('Beta chapter') < content.text.indexOf('Alpha chapter'), 'Book order incorrect')
  assert(content.duplicateIds === 0 && content.target === 'Same', `Book anchor/ID mapping wrong: ${JSON.stringify(content)}`)
  assert(content.footnotes.length >= 2 && new Set(content.footnotes.map(note => note.href)).size === content.footnotes.length
    && content.footnotes.some(note => note.text?.includes('A footnote')) && content.footnotes.some(note => note.text?.includes('B footnote')), 'Repeated footnote labels did not remain distinct')
  const images = content.imageSources.map(source => Buffer.from(source.slice(source.indexOf(',') + 1), 'base64').toString('utf8')).join('\n')
  assert(images.includes('A_ASSET') && images.includes('B_ASSET'), 'Per-source image baselines mixed')
  await frame.getByRole('link', { name: 'to beta', exact: true }).click()
  const navigation = await frame.locator('article').evaluate(article => ({ url: article.ownerDocument.URL, text: article.textContent, scrollTop: article.ownerDocument.scrollingElement?.scrollTop }))
  assert(navigation.url === 'about:srcdoc' && navigation.text.includes('Beta chapter') && navigation.scrollTop > 0, 'Preview fragment click left the frozen document')
  await page.getByTestId('project-export-run').click(); await waitResults()
  const results = await outputs()
  assert(results.length === 5 && results.every(item => item.status === 'Completed'), `Book output failure: ${JSON.stringify(results)}`)
  for (const result of results) {
    const data = await safeFile(result.path)
    if (result.path.endsWith('.pdf')) assert(data.subarray(0, 5).toString() === '%PDF-', 'Invalid PDF')
    else if (!result.path.endsWith('.html')) {
      assert(data[0] === 0x50 && data[1] === 0x4b, 'Invalid Pandoc container')
      const entries = zipMembers(data)
      const xml = entries.filter(entry => /\.(?:xml|xhtml)$/.test(entry.name)).map(entry => entry.content.toString('utf8')).join('\n')
      assert(xml.includes('Alpha chapter') && xml.includes('Beta chapter') && xml.includes('UNTITLED_M3_ONLY') && xml.includes('A footnote') && xml.includes('B footnote'), 'Book container lost chapters or footnotes')
      assert(entries.some(entry => /(?:media|Pictures)\/.*\.(?:svg|png|jpe?g)$/i.test(entry.name)), 'Book container lost embedded media')
      if (result.path.endsWith('.docx')) assert((xml.match(/<w:footnoteReference\b/g) ?? []).length === 2 && entries.some(entry => entry.name === 'word/footnotes.xml'), 'DOCX footnotes lost their semantics')
      if (result.path.endsWith('.odt')) assert((xml.match(/<text:note\s/g) ?? []).length === 2, 'ODT footnotes lost their semantics')
      if (result.path.endsWith('.epub')) assert((xml.match(/epub:type="noteref"/g) ?? []).length === 2, 'EPUB footnote references lost their semantics')
    }
  }
  assert(hash(await readFile(alpha)) === sourceHashes.alpha && hash(await readFile(beta)) === sourceHashes.beta, 'Book export modified source Markdown')
  record('ordered book with distinct anchors/footnotes/resources, persisted relative plan and five real formats', { results, config: config.projectExport, linkTarget: content.target, duplicateIds: content.duplicateIds,
    previewNavigation: { url: navigation.url, scrollTop: navigation.scrollTop }, footnotes: content.footnotes, resourceBases: ['A_ASSET', 'B_ASSET'], unchangedSourceHashes: sourceHashes })
  await page.screenshot({ path: path.join(run, 'native-project-book.png') })
}

try {
  await setup(); await batch(); await cancellationAndChangedRetry(); await book()
  assert(receipt.pageErrors.length === 0, `Renderer errors: ${receipt.pageErrors.join('; ')}`)
  receipt.success = true
} catch (error) { receipt.error = String(error.stack || error); process.stderr.write(`${receipt.error}\n`); process.exitCode = 1 }
finally {
  if (page) {
    await page.screenshot({ path: path.join(run, 'native-final.png') }).catch(() => {})
    await page.evaluate(() => { window.__m3Release?.(); const callbacks = window.__TAURI_INTERNALS__.callbacks; if (window.__m3CallbackDescriptor) Object.defineProperty(callbacks, 'set', window.__m3CallbackDescriptor); else delete callbacks.set }).catch(() => {})
  }
  receipt.finishedAt = new Date().toISOString()
  await writeFile(path.join(run, 'receipt.json'), JSON.stringify(receipt, null, 2)).catch(() => {})
  await browser?.close()
  process.stdout.write(`${JSON.stringify({ success: receipt.success, run, checks: receipt.checks.length })}\n`)
}
