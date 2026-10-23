#!/usr/bin/env node
// Real bundled WebView2/Rust regression acceptance. Run only against the isolated
// review-validation identifier. IPC responses may be delayed, never replaced.
// Native file/save dialogs are completed separately using Computer Use.
import { chromium, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir, realpath, lstat, stat } from 'node:fs/promises'
import path from 'node:path'

const base = path.resolve('output/review-fixes-native')
const run = path.join(base, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const root = path.join(run, 'project')
const identifier = 'io.github.yulianjie.markcaptain.review-validation'
const cdp = process.env.REVIEW_CDP_URL || 'http://127.0.0.1:9341'
const exportOnly = process.argv.includes('--export-only')
const receipt = { schemaVersion: 1, phase: exportOnly ? 'export' : 'all', native: true, productionProtocol: true, backendMocked: false, modelFixture: !exportOnly, ipcDelayInstrumentation: true, success: false, checks: [], pageErrors: [], run }
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const normal = value => path.resolve(String(value).replace(/^\\\\\?\\/, '')).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
const inside = (parent, child) => normal(child) === normal(parent) || normal(child).startsWith(`${normal(parent)}/`)
const record = (id, name, details) => { receipt.checks.push({ id, name, details }); process.stdout.write(`${id}: ${name}\n`) }
let browser, page, model
const requests = [], tools = []

async function setup() {
  const existing = await lstat(base).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
  assert(!existing?.isSymbolicLink(), 'Refusing aliased output root')
  await mkdir(base, { recursive: true })
  assert(normal(await realpath(base)) === normal(base), 'Output root escaped workspace')
  await mkdir(root, { recursive: true })
  await mkdir(path.join(root, 'exports'))
  for (let i = 0; i < 50; i++) await writeFile(path.join(root, `n${i}.md`), `# Reference ${i}\nCOMMON_REVIEW_NEEDLE disk ${i}\n`)
  await writeFile(path.join(root, 'Review.md'), '# Native review\n\nOriginal target\n\n| Stable | Value |\n| --- | --- |\n| Keep | Old |\n')
  await writeFile(path.join(root, 'Export.md'), '# Native export\n\n## Detail\n\nNative frozen body.\n')
  const deadline = Date.now() + 15000
  while (!browser) {
    try { browser = await chromium.connectOverCDP(cdp, { timeout: 3000 }) }
    catch (error) { if (Date.now() > deadline) throw error; await new Promise(resolve => setTimeout(resolve, 250)) }
  }
  const candidates = browser.contexts().flatMap(context => context.pages()).filter(candidate => /^(http:\/\/tauri\.localhost|tauri:)/.test(candidate.url()))
  assert(candidates.length === 1, 'Expected exactly one production WebView')
  page = candidates[0]
  page.on('pageerror', error => receipt.pageErrors.push(error.message))
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.has('agent'))
  receipt.app = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke
    return { identifier: await invoke('plugin:app|identifier'), configDir: await invoke('plugin:path|resolve_directory', { directory: 13 }), url: location.href }
  })
  assert(receipt.app.identifier === identifier, `Refusing app ${receipt.app.identifier}`)
  assert(path.basename(await realpath(receipt.app.configDir)) === identifier, 'Unexpected app data directory')
  const recovery = page.getByRole('dialog', { name: 'Recover unsaved drafts?', exact: true })
  await expect.poll(async () => await recovery.isVisible() || await page.evaluate(() => !document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('editor').startupHydrationPending)).toBe(true)
  if (await recovery.isVisible()) await recovery.getByRole('button', { name: 'Recover Drafts', exact: true }).click()
  await expect.poll(() => page.evaluate(() => !document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('editor').startupHydrationPending)).toBe(true)
  const expected = (await readdir('dist/assets')).find(file => /^EditorPage-.*\.js$/.test(file))
  const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(item => item.name))
  assert(expected && resources.some(url => url.endsWith(`/${expected}`)), 'Native executable has a stale frontend bundle')
  const oldDialog = page.locator('.export-dialog:visible')
  if (await oldDialog.count()) {
    await oldDialog.locator('.el-dialog__headerbtn').click()
    await expect(oldDialog).toHaveCount(0)
  }
  const startup = await page.evaluate(() => {
    const stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
    return { paths: stores.get('editor').tabs.map(tab => tab.pathname).filter(Boolean), root: stores.get('project').projectTree?.pathname }
  })
  for (const pathname of [...startup.paths, ...(startup.root ? [startup.root] : [])]) assert(inside(base, pathname), 'Refusing restored user data')
  await page.evaluate(async root => {
    const stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
    window.__reviewStores = stores
    window.__reviewOpenHeld = false
    window.__reviewRelinkDone = false
    const editor = stores.get('editor')
    stores.get('preferences').autoSave = false
    stores.get('preferences').language = 'en'
    editor.sourceCodeMode = true
    await stores.get('project').openRoot(root)
    await editor.openFile(`${root}/Review.md`)
    stores.get('layout').showInspector = true
    stores.get('layout').setInspectorPanel('agent')
    stores.get('agent').visible = true
    // Delay received real preflight payloads, never fabricate IPC results.
    const callbacks = window.__TAURI_INTERNALS__.callbacks
    window.__reviewOriginalCallbackSet = Object.getOwnPropertyDescriptor(callbacks, 'set')
    window.__reviewHoldPreflight = false
    window.__reviewPreflightHeld = false
    window.__reviewReleasePreflight = null
    window.__reviewExportCompletions = 0
    const originalSet = callbacks.set
    callbacks.set = function(id, callback) {
      return originalSet.call(this, id, function(data) {
        if (data && Array.isArray(data.blocking) && Array.isArray(data.warnings) && data.capabilities && data.dependencies && window.__reviewHoldPreflight) {
          window.__reviewHoldPreflight = false
          window.__reviewPreflightHeld = true
          window.__reviewReleasePreflight = () => { window.__reviewReleasePreflight = null; return callback(data) }
          return
        }
        if (data?.status === 'completed' && typeof data.outputPath === 'string') window.__reviewExportCompletions++
        return callback(data)
      })
    }
  }, root.replaceAll('\\', '/'))
  record('environment', 'isolated Windows WebView2, current bundled frontend and actual Rust IPC', { ...receipt.app, expected })
}

async function setupModel() {
  model = createServer(async (req, res) => {
    try {
      let body = ''
      for await (const chunk of req) { body += chunk; assert(body.length < 4000000, 'Oversized fixture request') }
      const input = JSON.parse(body); requests.push(input)
      const messages = input.messages || []
      const prompt = messages.filter(item => item.role === 'user').map(item => item.content).join('\n')
      const result = id => { const item = messages.find(item => item.tool_call_id === id); return item ? JSON.parse(item.content) : undefined }
      const call = (id, name, args) => [id, name, args]
      let calls = [], answer = 'Native review regression fixture complete.'
      if (prompt.includes('NATIVE_PROJECT_REVIEW_FIXES')) {
        const candidates = result('search')?.results
        if (!candidates) calls = [call('search', 'search_project', { query: 'COMMON_REVIEW_NEEDLE', filters: { limit: 50 } })]
        else {
          const ids = [...candidates].sort((a, b) => Number(a.path.match(/n(\d+)/)[1]) - Number(b.path.match(/n(\d+)/)[1])).map(item => item.documentId)
          if (!result('narrow')) calls = [call('narrow', 'search_project', { query: 'COMMON_REVIEW_NEEDLE', filters: { pathPrefix: 'n0.md', limit: 1 } }), call('bad-read', 'read_project_document', { documentId: ids[0], startLine: 1, endLine: 200 }), call('bad-cite', 'cite_document', { documentId: ids[0], startLine: 1, endLine: 1, label: 'must be rejected' })]
          else {
            const firstUnread = ids.slice(0, 40).findIndex((_, i) => !result(`read-${i}`))
            if (firstUnread >= 0) calls = ids.slice(firstUnread, Math.min(firstUnread + 8, 40)).map((id, offset) => call(`read-${firstUnread + offset}`, 'read_project_document', { documentId: id, startLine: 1, endLine: 2 }))
            else if (!result('over-read')) calls = [call('over-read', 'read_project_document', { documentId: ids[40], startLine: 1, endLine: 2 }), call('over-cite', 'cite_document', { documentId: ids[40], startLine: 1, endLine: 1, label: 'over budget' }), call('good-cite', 'cite_document', { documentId: ids[0], startLine: 2, endLine: 2, label: 'Dirty buffer evidence' })]
            else {
              assert(candidates.length === 50 && result('narrow').results.length === 1, 'Cache-full narrow search failed')
              assert(result('bad-read').error && result('bad-cite').error, 'Failed read authorized a citation')
              assert(result('over-read').error && result('over-cite').error, '41st project source was accepted')
              assert(result('good-cite').quote.includes('UNSAVED_REVIEW_证据😀'), 'Dirty buffer citation missing')
            }
          }
        }
      } else if (prompt.includes('NATIVE_REVIEW_FIXES')) {
        if (!result('proposal')) calls = [call('proposal', 'propose_edit', { title: 'Native regression review', changes: [{ oldText: 'Original target', newText: 'Revised target' }, { oldText: '| Stable | Value |\n| --- | --- |\n| Keep | Old |', newText: '| Stable | Value |\n| --- | --- |\n| Keep | New |' }, { oldText: '', newText: '\nNATIVE_INSERTED_TEXT\n' }] })]
      }
      if (calls.length) tools.push(...calls)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const delta = calls.length ? { tool_calls: calls.map(([id, name, args], index) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } : { content: answer }
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
    } catch (error) { res.writeHead(500); res.end(String(error.stack || error)) }
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  await page.evaluate(async url => { await window.__reviewStores.get('agent').saveConfig({ baseUrl: url, model: 'native-review-fixture', authMode: 'none' }) }, `http://127.0.0.1:${model.address().port}/v1`)
}

async function send(prompt) {
  await page.evaluate(async prompt => { await window.__reviewStores.get('agent').send(prompt) }, prompt)
  await expect.poll(() => page.evaluate(() => window.__reviewStores.get('agent').busy), { timeout: 60000 }).toBe(false)
  const error = await page.evaluate(() => { const agent = window.__reviewStores.get('agent'); return agent.error || agent.conversation.messages.at(-1)?.error })
  assert(!error, `Agent task failed: ${error}`)
}

async function projectChecks() {
  const configPath = path.join(root, '.markcaptain', 'agent.json')
  await page.evaluate(async root => {
    const invoke = window.__TAURI_INTERNALS__.invoke
    const saved = await invoke('cmd_agent_project_save_config', { root, config: { schemaVersion: 1, extension: { retained: true } }, expectedFingerprint: null })
    window.__reviewConfigFingerprint = saved.fingerprint
  }, root)
  const before = await readFile(configPath)
  const rejected = await page.evaluate(async root => {
    try { await window.__TAURI_INTERNALS__.invoke('cmd_agent_project_save_config', { root, config: { schemaVersion: 1, extension: Array(20000).fill(0) }, expectedFingerprint: window.__reviewConfigFingerprint }); return false }
    catch (error) { return String(error).includes('projectConfigTooLarge') }
  }, root)
  assert(rejected && hash(before) === hash(await readFile(configPath)), 'Oversize config replaced original bytes')
  record('R08', 'oversized final JSON is rejected before replacement; previous config reloads', { sha256: hash(before) })
  const reference = path.join(root, 'n0.md')
  const referenceBefore = hash(await readFile(reference))
  await page.evaluate(async ({ root, reference }) => {
    const editor = window.__reviewStores.get('editor'), agent = window.__reviewStores.get('agent')
    await agent.loadProjectConfig(root)
    const tab = await editor.openFile(reference)
    tab.pendingBaselineUpdate = false
    editor.applyContentChange(tab.id, '# Reference 0\nCOMMON_REVIEW_NEEDLE UNSAVED_REVIEW_证据😀\n')
    await editor.openFile(`${root}/Review.md`)
    agent.conversation.projectAccess.include = ['**/*.{md,markdown}']
    await agent.setProjectSearchEnabled(true)
    if (!agent.conversation.projectAccess.grantId) throw new Error(agent.conversation.projectAccess.error)
  }, { root: root.replaceAll('\\', '/'), reference })
  await send('NATIVE_PROJECT_REVIEW_FIXES')
  const state = await page.evaluate(() => {
    const agent = window.__reviewStores.get('agent'), message = agent.conversation.messages.at(-1)
    return { references: message.references?.length, quote: message.sources?.at(-1)?.quote, errors: agent.error }
  })
  assert(state.references === 40 && state.quote?.includes('UNSAVED_REVIEW_证据😀'), 'Project receipts/citation did not reach renderer')
  assert(referenceBefore === hash(await readFile(reference)), 'Reference buffer was saved')
  record('R06/R09/R10/R11', 'brace glob uses dirty buffer, failed read cannot cite, full cache can narrow, source 41 rejected', state)
  await page.evaluate(async () => {
    const agent = window.__reviewStores.get('agent'), editor = window.__reviewStores.get('editor')
    await agent.setProjectSearchEnabled(false)
    await agent.checkCurrentDocument()
    if (!agent.documentCheck?.result.complete) throw new Error('Baseline check incomplete')
    editor.applyContentChange(editor.currentFileId, `${editor.currentFile.markdown}\nChanged after check.`)
  })
  assert(await page.evaluate(() => !window.__reviewStores.get('agent').documentCheck), 'Edited check remained valid')
  await page.evaluate(async () => { const agent = window.__reviewStores.get('agent'); await agent.checkCurrentDocument(); window.__reviewStores.get('editor').newUntitledTab('# Other') })
  assert(await page.evaluate(() => !window.__reviewStores.get('agent').documentCheck), 'Other document displays previous clean check')
  record('R07', 'completed checks invalidate after text edits and tab switches')
}

async function historyChecks() {
  await page.evaluate(async root => {
    const editor = window.__reviewStores.get('editor'), agent = window.__reviewStores.get('agent')
    await editor.openFile(`${root}/Review.md`)
    editor.setMarkdownExternal(editor.currentFileId, '# Native review\n\nOriginal target\n\n| Stable | Value |\n| --- | --- |\n| Keep | Old |\n')
    await agent.clear()
    agent.includeDocument = true
  }, root.replaceAll('\\', '/'))
  await send('NATIVE_REVIEW_FIXES')
  const changes = page.locator('.agent-edit').last().locator('.agent-edit-change')
  await changes.nth(1).getByRole('button', { name: 'Structured view', exact: true }).click()
  const cell = changes.nth(1).locator('.agent-structured-diff td').first()
  await expect(cell).toHaveText('Stable')
  record('R14', 'real Vue structured table shows unchanged cell once')
  await changes.nth(2).getByRole('button', { name: 'Apply change', exact: true }).click()
  await changes.nth(2).getByRole('button', { name: 'Preview in document area', exact: true }).click()
  await page.locator('.agent-review-preview footer button').click()
  await expect.poll(() => page.evaluate(() => {
    const tab = window.__reviewStores.get('editor').currentFile, range = tab.sourceSelection?.ranges?.[0]
    return range ? tab.markdown.slice(Math.min(range.anchor, range.head), Math.max(range.anchor, range.head)) : null
  })).toBe('\nNATIVE_INSERTED_TEXT\n')
  const selection = await page.evaluate(() => {
    const tab = window.__reviewStores.get('editor').currentFile, range = tab.sourceSelection?.ranges?.[0]
    return range ? tab.markdown.slice(Math.min(range.anchor, range.head), Math.max(range.anchor, range.head)) : null
  })
  assert(selection === '\nNATIVE_INSERTED_TEXT\n', `Insertion selected wrong text: ${selection}`)
  record('R13', 'applied insertion preview locates exactly inserted text', { selection })
  await page.locator('.agent-review-preview header button').click()
  await page.evaluate(async () => {
    const editor = window.__reviewStores.get('editor'), agent = window.__reviewStores.get('agent')
    const message = agent.conversation.messages.at(-1)
    agent.revert(message.edit, 2)
    await editor.saveCurrent()
    await agent.setHistoryEnabled(true)
    await agent.flushHistory()
    window.__reviewHistory = { id: agent.conversation.id, messageId: message.id, target: editor.currentFile.pathname }
    await editor.closeTab(editor.currentFileId, true)
    await agent.restoreHistory(window.__reviewHistory.id)
    window.__reviewOpenFile = editor.openFile
    editor.openFile = async (...args) => {
      const target = await window.__reviewOpenFile(...args)
      window.__reviewOpenHeld = true
      await new Promise(resolve => { window.__reviewReleaseOpen = resolve })
      return target
    }
    window.__reviewRelinkDone = false
    void agent.revalidateHistoryReview(window.__reviewHistory.messageId).then(result => { window.__reviewRelinkResult = result; window.__reviewRelinkDone = true })
  })
  process.stdout.write(`NATIVE_OPEN_PICKER_READY ${path.join(root, 'Review.md')}\n`)
  await expect.poll(() => page.evaluate(() => Boolean(window.__reviewOpenHeld)), { timeout: 180000 }).toBe(true)
  await page.evaluate(async () => { await window.__reviewStores.get('agent').send('NATIVE_BLOCKED_DURING_RELINK') })
  assert(!requests.some(input => JSON.stringify(input).includes('NATIVE_BLOCKED_DURING_RELINK')), 'Request started during relink')
  await expect(page.locator('#agent-panel .agent-send-row .agent-primary')).toBeDisabled()
  await page.evaluate(() => { window.__reviewReleaseOpen(); window.__reviewStores.get('editor').openFile = window.__reviewOpenFile })
  await expect.poll(() => page.evaluate(() => window.__reviewRelinkDone)).toBe(true)
  assert(await page.evaluate(() => window.__reviewRelinkResult), `Native relink failed: ${await page.evaluate(() => window.__reviewStores.get('agent').historyReviewError)}`)
  const canRegenerate = await page.evaluate(() => {
    const agent = window.__reviewStores.get('agent'), editor = window.__reviewStores.get('editor')
    agent.includeDocument = true
    const edit = agent.conversation.messages.at(-1).edit
    editor.applyContentChange(editor.currentFileId, `${editor.currentFile.markdown}\nLocal change outside proposal.`)
    return agent.canRegenerateReview(edit)
  })
  assert(canRegenerate, 'Recovered card cannot regenerate with fresh document consent')
  await page.evaluate(async () => { const agent = window.__reviewStores.get('agent'); await agent.regenerateReview(agent.conversation.messages.at(-1).edit) })
  await expect.poll(() => page.evaluate(() => window.__reviewStores.get('agent').busy)).toBe(false)
  assert(await page.evaluate(() => Boolean(window.__reviewStores.get('agent').conversation.messages.at(-1).edit)), 'Regeneration did not yield a new review')
  record('R01/R12', 'native file relink blocks sends, preserves routing, and recovered card regenerates with fresh consent')
}

async function exportChecks() {
  const remoteRequests = []
  await page.route('https://review.invalid/**', route => { remoteRequests.push(route.request().url()); return route.abort() })
  await page.evaluate(async root => {
    const editor = window.__reviewStores.get('editor')
    const tab = await editor.openFile(`${root}/Export.md`)
    tab.pendingBaselineUpdate = false
    editor.applyContentChange(tab.id, '# Native export\n\n## Detail\n\nNative frozen body.\n\n![Remote](https://review.invalid/native-pixel.png)\n\n```mermaid\ngraph TD\nA[Local] --> B[Diagram]\n```\n\n```vega-lite\n{"data":{"url":"https://review.invalid/data.json"},"mark":"point","encoding":{"x":{"field":"x"}}}\n```\n')
    window.__reviewStores.get('commandCenter').execute('file.exportHtml')
  }, root.replaceAll('\\', '/'))
  const dialog = page.locator('.export-dialog')
  await expect(dialog).toBeVisible()
  const preset = dialog.locator('.el-form-item').filter({ hasText: /^Preset\s/ }).locator('.el-select').first()
  const presetControl = await preset.count() ? preset : dialog.locator('.el-select').first()
  await presetControl.click()
  await page.getByRole('option', { name: 'Technical Document', exact: true }).click()
  await expect(presetControl).toContainText('Technical Document')
  record('R05', 'built-in Technical Document preset remains selected in native dialog')
  await page.evaluate(() => { window.__reviewHoldPreflight = true; window.__reviewPreflightHeld = false })
  await dialog.getByRole('button', { name: /^(Preview|Refresh preview)$/ }).click()
  await expect.poll(() => page.evaluate(() => window.__reviewPreflightHeld)).toBe(true)
  await dialog.locator('.el-checkbox').filter({ hasText: 'Table of contents' }).click()
  await page.evaluate(() => { window.__reviewHoldPreflight = false; window.__reviewReleasePreflight() })
  await expect(dialog.getByRole('button', { name: 'Export HTML', exact: true })).toBeDisabled()
  record('R04', 'changing settings while first native preflight is held invalidates the pending preview')
  await dialog.getByRole('button', { name: /^(Preview|Refresh preview)$/ }).click()
  const frame = page.frameLocator('.preview-frame')
  await expect(frame.locator('article')).toContainText('Native frozen body.')
  await expect(frame.locator('nav.export-toc')).toHaveCount(0)
  await expect(frame.locator('svg')).not.toHaveCount(0)
  assert(remoteRequests.length === 0, `Export issued remote requests: ${remoteRequests}`)
  record('R02', 'native preview requests no remote images or Vega resources and still renders local Mermaid', { remoteRequests })
  const acknowledge = dialog.getByRole('checkbox', { name: /I reviewed the warnings/ })
  if (await acknowledge.count()) await dialog.locator('.el-checkbox').filter({ hasText: 'I reviewed the warnings' }).click()
  await expect(dialog.getByRole('button', { name: 'Export HTML', exact: true })).toBeEnabled()
  await page.evaluate(() => { window.__reviewHoldPreflight = true; window.__reviewPreflightHeld = false })
  await dialog.getByRole('button', { name: 'Export HTML', exact: true }).click()
  const cancelledPath = path.join(root, 'exports', 'cancelled.html')
  process.stdout.write(`NATIVE_SAVE_PICKER_READY ${cancelledPath}\n`)
  await expect.poll(() => page.evaluate(() => window.__reviewPreflightHeld), { timeout: 180000 }).toBe(true)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).last().click()
  await page.evaluate(() => { window.__reviewHoldPreflight = false; window.__reviewReleasePreflight() })
  await page.waitForTimeout(300)
  const completed = await page.evaluate(() => window.__reviewExportCompletions)
  assert(completed === 0 && !await stat(cancelledPath).then(() => true, () => false), 'Cancelled export wrote a file')
  record('R03', 'cancel after native save selection prevents file output after real Rust preflight')
  const htmlPath = path.join(root, 'exports', 'verified.html')
  await dialog.getByRole('button', { name: /^(Preview|Refresh preview)$/ }).click()
  await expect(frame.locator('article')).toContainText('Native frozen body.')
  if (await acknowledge.count()) await dialog.locator('.el-checkbox').filter({ hasText: 'I reviewed the warnings' }).click()
  await expect(dialog.getByRole('button', { name: 'Export HTML', exact: true })).toBeEnabled()
  await dialog.getByRole('button', { name: 'Export HTML', exact: true }).click()
  process.stdout.write(`NATIVE_SAVE_PICKER_READY ${htmlPath}\n`)
  await expect.poll(() => stat(htmlPath).then(info => info.size, () => 0), { timeout: 180000 }).toBeGreaterThan(0)
  const html = await readFile(htmlPath, 'utf8')
  assert(html.includes('Native frozen body.') && html.includes('--export-accent: #075a9c') && !html.includes('nav class="export-toc"'), 'Actual HTML export differs from approved preview')
  record('export-write', 'actual Rust HTML output preserves refreshed preview, theme and diagram', { path: htmlPath, bytes: Buffer.byteLength(html) })
  await page.screenshot({ path: path.join(run, 'native-export.png') })
}

try {
  await setup()
  if (!exportOnly) {
    await setupModel()
    await projectChecks()
    await historyChecks()
  }
  await exportChecks()
  assert(receipt.pageErrors.length === 0, `Renderer errors: ${receipt.pageErrors.join('; ')}`)
  receipt.success = true
} catch (error) {
  receipt.error = String(error.stack || error)
  process.stderr.write(`${receipt.error}\n`)
  process.exitCode = 1
} finally {
  if (page) await page.evaluate(() => {
    window.__reviewReleasePreflight?.()
    const callbacks = window.__TAURI_INTERNALS__.callbacks
    if (window.__reviewOriginalCallbackSet) Object.defineProperty(callbacks, 'set', window.__reviewOriginalCallbackSet)
    else delete callbacks.set
  }).catch(() => {})
  if (page) await page.screenshot({ path: path.join(run, 'native-final.png') }).catch(() => {})
  receipt.modelRequests = requests.length
  receipt.modelTools = tools.map(([, name]) => name)
  receipt.finishedAt = new Date().toISOString()
  await writeFile(path.join(run, 'model-requests.json'), JSON.stringify(requests, null, 2)).catch(() => {})
  await writeFile(path.join(run, 'receipt.json'), JSON.stringify(receipt, null, 2)).catch(() => {})
  if (model) await new Promise(resolve => model.close(resolve))
  await browser?.close()
  process.stdout.write(`${JSON.stringify({ success: receipt.success, run, checks: receipt.checks.length })}\n`)
}
