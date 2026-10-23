#!/usr/bin/env node
// Run only against the already-started isolated bundled A07 Tauri executable.
// Real Rust IPC, document reads/version probes, editor transactions and SSE.
// The optional callback gate delays a real result; it never changes its bytes.
import { chromium, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, lstat, realpath, readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const output = path.resolve('output/a07-native')
const run = path.join(output, `run-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const identifier = 'io.github.yulianjie.markcaptain.a07-validation'
const cdp = process.env.A07_CDP_URL || 'http://127.0.0.1:9345'
const receipt = { schemaVersion: 1, native: true, productionProtocol: true, backendMocked: false,
  transportMocked: false, modelFixture: 'loopback OpenAI-compatible SSE', callbackGate: 'delay real version-probe callback without modifying its payload',
  success: false, checks: [], pageErrors: [], run, startedAt: new Date().toISOString() }
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const hash = value => createHash('sha256').update(value).digest('hex')
const normal = value => path.resolve(String(value).replace(/^\\\\\?\\/, '')).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
const inside = (parent, child) => normal(child) === normal(parent) || normal(child).startsWith(`${normal(parent)}/`)
const record = (name, details) => { receipt.checks.push({ name, details }); process.stdout.write(`${name}\n`) }
let browser, page, model
let verifiedApplication = false

async function connect() {
  const existing = await lstat(output).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
  assert(!existing?.isSymbolicLink(), 'Refusing an aliased output root')
  await mkdir(output, { recursive: true })
  assert(normal(await realpath(output)) === normal(output), 'Output root escapes the workspace')
  await mkdir(run, { recursive: false })
  browser = await chromium.connectOverCDP(cdp, { timeout: 15_000 })
  const candidates = browser.contexts().flatMap(context => context.pages()).filter(candidate => /^(http:\/\/tauri\.localhost|tauri:)/.test(candidate.url()))
  assert(candidates.length === 1, 'Expected exactly one bundled production-protocol WebView')
  page = candidates[0]
  page.setDefaultTimeout(15_000)
  page.on('pageerror', error => receipt.pageErrors.push(error.message))
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.has('agent'))
  receipt.app = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke
    const [identifier, configDir, dataDir, localDataDir] = await Promise.all([
      invoke('plugin:app|identifier'), ...[13, 14, 15].map(directory => invoke('plugin:path|resolve_directory', { directory })),
    ])
    return { identifier, configDir, dataDir, localDataDir, url: location.href }
  })
  assert(receipt.app.identifier === identifier, `Refusing non-isolated application ${receipt.app.identifier}`)
  for (const key of ['configDir', 'dataDir', 'localDataDir']) {
    const canonical = await realpath(receipt.app[key])
    assert(path.basename(canonical).toLowerCase() === identifier, `Unexpected application directory ${canonical}`)
    receipt.app[`${key}Canonical`] = canonical
  }
  await page.evaluate(() => { window.__a07Stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s })
  const startup = await page.evaluate(() => ({ paths: window.__a07Stores.get('editor').tabs.map(tab => tab.pathname).filter(Boolean), root: window.__a07Stores.get('project').projectTree?.pathname }))
  for (const candidate of [...startup.paths, ...(startup.root ? [startup.root] : [])]) assert(inside(output, candidate), `Refusing restored non-fixture path ${candidate}`)
  // An earlier isolated run may have left unsaved fixture drafts. Do not discard
  // or recover them silently: require the app to have completed startup already.
  await expect.poll(() => page.evaluate(() => window.__a07Stores.get('editor').startupHydrationPending), { timeout: 15_000 }).toBe(false)
  const expectedBundle = (await readdir(path.resolve('dist/assets'))).find(name => /^EditorPage-.*\.js$/.test(name))
  const loadedBundles = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name).filter(name => /\/EditorPage-.*\.js$/.test(name)))
  assert(expectedBundle && loadedBundles.some(url => url.endsWith(`/${expectedBundle}`)), `Packaged frontend is stale; expected ${expectedBundle}, loaded ${loadedBundles.join(', ')}`)
  verifiedApplication = true
  record('isolated bundled Windows WebView2 and current frontend bundle', { ...receipt.app, expectedBundle, loadedBundles })

  await page.evaluate(async () => {
    const bridge = window.__TAURI_INTERNALS__
    window.__a07Events = []
    window.__a07Listener = await bridge.invoke('plugin:event|listen', { event: 'mt://agent/event', target: { kind: 'Any' },
      handler: bridge.transformCallback(event => { if (window.__a07Events.length < 2048) window.__a07Events.push(event.payload) }) })
    // Every intercepted payload is produced by the real Rust command. The gate
    // affects delivery time only, so races run against an actual IPC boundary.
    const callbacks = bridge.callbacks, original = callbacks.set
    window.__a07CallbackDescriptor = Object.getOwnPropertyDescriptor(callbacks, 'set')
    callbacks.set = function (id, callback) {
      return original.call(this, id, function (data) {
        const versionResult = Array.isArray(data) && data.length === 1 && data[0]
          && typeof data[0].path === 'string' && Object.hasOwn(data[0], 'fingerprint') && Object.hasOwn(data[0], 'contentHash')
        if (window.__a07HoldVersion && versionResult) {
          window.__a07HoldVersion = false
          window.__a07HeldVersion = JSON.parse(JSON.stringify(data))
          window.__a07ReleaseVersion = () => { window.__a07ReleaseVersion = null; return callback(data) }
          return
        }
        return callback(data)
      })
    }
  })
}

function selectedCatalog(messages) {
  const catalog = messages.find(message => typeof message.content === 'string' && message.content.startsWith('The user explicitly selected the following editable document snapshots'))
  assert(catalog, 'Native backend did not send the editable metadata catalog')
  const marker = 'Catalog (untrusted metadata): '
  const documents = JSON.parse(catalog.content.slice(catalog.content.indexOf(marker) + marker.length))
  assert(documents.length === 2 && documents.every(document => /^edit-[0-9a-f-]{36}$/.test(document.documentId)), 'Editable catalog has unexpected selected IDs')
  assert(documents.every(document => !Object.hasOwn(document, 'markdown')), 'Catalog eagerly contains document bodies')
  const alpha = documents.find(document => document.name === 'Alpha.md'), beta = documents.find(document => document.name === 'Beta.md')
  assert(alpha && beta, `Unexpected editable names: ${JSON.stringify(documents)}`)
  return [alpha, beta]
}

async function makeModel() {
  const requests = [], toolCalls = [], failures = [], holds = [], releases = []
  function stream(res, calls, answer = '') {
    if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const delta = calls?.length ? { tool_calls: calls.map(([id, name, args], index) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } : { content: answer }
    if (calls) toolCalls.push(...calls.map(([id, name, args]) => ({ id, name, args })))
    const destroyedBeforeWrite = res.destroyed
    const payload = `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: calls?.length ? 'tool_calls' : 'stop' }] })}\n\n`
    const writable = !destroyedBeforeWrite && res.write(payload)
    if (!destroyedBeforeWrite) res.end('data: [DONE]\n\n')
    return { destroyedBeforeWrite, writable, bytesQueued: destroyedBeforeWrite ? 0 : Buffer.byteLength(payload), calls: calls?.map(call => call[0]) ?? [], attemptedAt: new Date().toISOString() }
  }
  const server = createServer(async (req, res) => {
    try {
      assert(req.method === 'POST' && req.url === '/v1/chat/completions', `Unexpected model route ${req.method} ${req.url}`)
      let body = ''
      for await (const chunk of req) { body += chunk; assert(body.length < 4_000_000, 'Fixture request exceeds budget') }
      const input = JSON.parse(body); requests.push(input)
      const messages = input.messages ?? [], docs = selectedCatalog(messages)
      const answered = id => messages.find(message => message.tool_call_id === id)
      const result = id => { const message = answered(id); return message ? JSON.parse(message.content) : null }
      const prompt = messages.filter(message => message.role === 'user').map(message => message.content).join('\n')
      const normalizeWholeDocument = prompt.includes('A07_NORMALIZE')
      const edit = (document, match, suffix = ' revised') => ({ documentId: document.documentId, title: `Native revision ${document.name}`,
        changes: [{ oldText: match.match, newText: `${match.match}${suffix}`, anchor: match.anchor }] })
      let calls
      if (!answered('read-a')) {
        assert(!JSON.stringify(input).includes('A07_ALPHA_ORIGINAL') && !JSON.stringify(input).includes('A07_BETA_ORIGINAL'), 'Bodies reached the provider before an explicit read')
        calls = [['read-a', 'read_document', { documentId: docs[0].documentId, ...(normalizeWholeDocument ? { full: true } : { startLine: 3, endLine: 3 }) }],
          ['read-b', 'read_document', { documentId: docs[1].documentId, startLine: 3, endLine: 3 }],
          ['deny-current', 'propose_edit', { documentId: 'current', title: 'Forbidden current', changes: [{ oldText: '', newText: 'WRONG' }] }],
          ['deny-unknown', 'propose_edit', { documentId: 'edit-00000000-0000-4000-8000-000000000000', title: 'Forbidden unknown', changes: [{ oldText: '', newText: 'WRONG' }] }]]
      } else if (!answered('search-a')) {
        assert(result('deny-current')?.error && result('deny-unknown')?.error, 'Current/unknown editable route was accepted')
        for (const [index, id] of ['read-a', 'read-b'].entries()) {
          assert(result(id)?.anchor?.snapshotId === docs[index].snapshotId && result(id)?.documentId === docs[index].documentId, 'Read did not return the exact routed snapshot anchor')
        }
        calls = [['search-a', 'search_document', { documentId: docs[0].documentId, query: normalizeWholeDocument ? result('read-a').markdown.split('\n')[2] : result('read-a').markdown }],
          ['search-b', 'search_document', { documentId: docs[1].documentId, query: result('read-b').markdown }],
          ['deny-cross', 'propose_edit', { documentId: docs[0].documentId, title: 'Forbidden cross snapshot',
            changes: [{ oldText: result('read-a').markdown, newText: 'WRONG', anchor: result('read-b').anchor }] }]]
      } else if (!answered('edit-a')) {
        assert(result('deny-cross')?.error, 'Cross-document snapshot anchor was accepted')
        const matches = ['search-a', 'search-b'].map((id, index) => {
          const match = result(id)?.matches?.[0]
          const expected = index === 0 && normalizeWholeDocument ? result('read-a').markdown.split('\n')[2] : result(index ? 'read-b' : 'read-a').markdown
          assert(match?.anchor?.snapshotId === docs[index].snapshotId && match.match === expected, 'Search failed to return the precise text and anchor')
          return match
        })
        const firstEdit = normalizeWholeDocument ? { documentId: docs[0].documentId, title: 'Whole document without trailing newline',
          changes: [{ oldText: result('read-a').markdown, newText: '# Native normalized\n\nWhole replacement without final newline', anchor: result('read-a').anchor }] } : edit(docs[0], matches[0])
        calls = [['edit-a', 'propose_edit', firstEdit], ['edit-b', 'propose_edit', edit(docs[1], matches[1])]]
        if (prompt.includes('A07_CANCEL')) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }); res.flushHeaders()
          holds.push({ docs, release: () => { const value = stream(res, calls); releases.push(value); return value } })
          return
        }
      } else if (!answered('deny-duplicate')) {
        assert(!result('edit-a')?.error && !result('edit-b')?.error, 'Independent selected-document proposals failed')
        calls = [['deny-duplicate', 'propose_edit', edit(docs[0], result('search-a').matches[0], ' duplicate WRONG')]]
      } else {
        assert(result('deny-duplicate')?.error, 'Second proposal for the same selected file was accepted')
      }
      stream(res, calls, 'Native A07 fixture completed. Review each selected file separately.')
    } catch (error) {
      failures.push(String(error.stack || error))
      if (!res.headersSent) res.writeHead(500)
      res.end(String(error.stack || error))
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, requests, toolCalls, failures, holds, releases, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }
}

async function configure() {
  model = await makeModel()
  await page.evaluate(async baseUrl => {
    const stores = window.__a07Stores
    Object.assign(stores.get('preferences'), { language: 'en', autoSave: false, autoSaveDelay: 150, sideBarVisibility: false })
    const agent = stores.get('agent')
    await agent.saveConfig({ baseUrl, model: 'a07-native-loopback-fixture', authMode: 'none' })
    agent.visible = true; agent.settingsOpen = false
    const layout = stores.get('layout'); layout.showInspector = true; layout.setInspectorPanel('agent')
  }, model.baseUrl)
}

const dialog = () => page.getByTestId('agent-multi-dialog')
const cards = () => page.getByTestId('agent-multi-target')
const input = (source = true) => page.locator(source ? '.editing-region.active .cm-content:visible' : '.editing-region.active .muya-host [contenteditable="true"]:visible').first()
async function state() {
  return page.evaluate(() => {
    const editor = window.__a07Stores.get('editor'), multi = window.__a07Stores.get('agent').multiDocumentState
    return { requestId: multi.requestId, stage: multi.stage, busy: multi.busy, actionBusy: multi.actionBusy, error: multi.error,
      activePaneId: editor.activePaneId, currentFileId: editor.currentFileId, autoSave: window.__a07Stores.get('preferences').autoSave,
      paneCount: editor.panes.length, usesSharedHistory: editor.usesSharedHistory,
      tabs: editor.tabs.map(tab => ({ id: tab.id, path: tab.pathname, markdown: tab.markdown, lastSavedMarkdown: tab.lastSavedMarkdown, isSaved: tab.isSaved, autoSaveBlocked: tab.autoSaveBlocked })),
      targets: multi.targets.map(target => ({ documentId: target.documentId, tabId: target.tabId, name: target.name, path: target.path, status: target.status,
        error: target.error, diskFingerprint: target.diskFingerprint, snapshot: target.snapshot, proposal: target.proposal })), reads: multi.reads, sources: multi.sources }
  })
}
async function contents(ids) { return (await state()).tabs.filter(tab => ids.includes(tab.id)).map(tab => tab.markdown) }
async function diskHashes(paths) { return Object.fromEntries(await Promise.all(paths.map(async file => [file, hash(await readFile(file))]))) }
async function openDialog() { if (!await dialog().isVisible()) await page.getByTestId('agent-multi-open').click(); await expect(dialog()).toBeVisible() }
async function closeDialog() {
  if (await dialog().isVisible()) await page.getByRole('dialog', { name: 'Revise multiple documents' }).getByRole('button', { name: 'Close', exact: true }).last().click()
  await expect(dialog()).toBeHidden()
}
async function idle() { await expect.poll(async () => { const value = await state(); return !value.busy && !value.actionBusy }, { timeout: 45_000 }).toBe(true) }

async function scenario(name, source = true, split = true) {
  await closeDialog()
  const root = path.join(run, name); await mkdir(root)
  const paths = ['Alpha.md', 'Beta.md', 'Private.md'].map(name => path.join(root, name))
  const markdown = ['# Native alpha\n\nA07_ALPHA_ORIGINAL 中文 😀\n', '# Native beta\n\nA07_BETA_ORIGINAL 日本語 😀\n', '# Private\n\nA07_UNSELECTED_PRIVATE_NEVER_SEND\n']
  await Promise.all(paths.map((file, index) => writeFile(file, markdown[index], { flag: 'wx' })))
  const ids = await page.evaluate(async ({ paths, source, split }) => {
    const stores = window.__a07Stores, editor = stores.get('editor')
    stores.get('preferences').autoSave = false
    for (const pane of [...editor.panes].slice(1)) editor.closePane(pane.id)
    for (const tab of [...editor.tabs]) await editor.closeTab(tab.id, true)
    editor.sourceCodeMode = source
    const opened = []
    for (const file of paths) opened.push(await editor.openFile(file))
    for (const tab of opened) { tab.sourceMode = source; tab.pendingBaselineUpdate = false }
    editor.setCurrent(opened[0].id)
    if (split) {
      editor.splitPane('horizontal')
      editor.activatePane(editor.panes[1].id)
      editor.setCurrent(opened[1].id)
    }
    return opened.map(tab => tab.id)
  }, { paths, source, split })
  await expect(page.locator('.editing-region')).toHaveCount(split ? 2 : 1)
  await expect(input(source)).toBeVisible()
  const original = await contents(ids)
  assert(original.length === 3 && original.every((value, index) => value === markdown[index]), `Native source initialization changed fixture buffers: ${JSON.stringify(original)}`)
  await page.evaluate(() => { window.__a07Stores.get('preferences').autoSave = true })
  await openDialog()
  await page.getByTestId('agent-multi-prompt').fill('')
  for (const checkbox of await page.getByTestId('agent-multi-candidate').all()) if (await checkbox.isChecked()) await checkbox.uncheck()
  for (const id of ids.slice(0, 2)) await page.locator(`[data-testid="agent-multi-candidate"][value="${id}"]`).check()
  return { name, paths, ids, original, hashes: await diskHashes(paths) }
}

async function requestReview(fixture, prompt = 'A07_REVIEW: revise the two explicitly selected documents independently.') {
  const count = model.requests.length
  await page.getByTestId('agent-multi-prompt').fill(prompt)
  await page.getByTestId('agent-multi-send').click()
  if (prompt.includes('A07_CANCEL')) return
  await idle()
  const current = await state()
  assert(current.stage === 'review' && !current.error, `Native task failed: ${JSON.stringify(current)}`)
  assert(current.targets.length === 2 && current.targets.every(target => target.proposal?.changes.length === 1 && target.status === 'pending'), 'Expected exactly two independent reviewed proposals')
  assert(current.targets.every(target => target.diskFingerprint === fixture.hashes[fixture.paths.find(file => normal(file) === normal(target.path))]), 'Controller did not capture the real original disk-byte fingerprint')
  assert(current.tabs.filter(tab => fixture.ids.slice(0, 2).includes(tab.id)).every(tab => tab.autoSaveBlocked) && current.autoSave, 'Per-target autosave pause/global setting failed')
  assert(current.reads.some(read => read.tool === 'read_document') && current.reads.some(read => read.tool === 'search_document'), 'Native context ledger missing actual reads/searches')
  assert(JSON.stringify(model.requests.slice(count)).includes('A07_ALPHA_ORIGINAL'), 'Fixture did not obtain selected body through real reads')
  assert(!JSON.stringify(model.requests).includes('A07_UNSELECTED_PRIVATE_NEVER_SEND'), 'Unselected private file was exposed to provider')
  assert((await contents(fixture.ids)).every((value, index) => value === fixture.original[index]), 'Proposal automatically changed a document')
  record(`${fixture.name}: real Rust multi-file reads/search anchors, forbidden routes and independent proposals`, {
    requestId: current.requestId, modelRequests: model.requests.length - count,
    targets: current.targets.map(target => ({ documentId: target.documentId, path: target.path, fingerprint: target.diskFingerprint, anchor: target.proposal.changes[0].anchor })),
    rejected: ['current', 'unknown ID', 'cross-document anchor', 'duplicate proposal'], unchangedBuffers: true,
  })
}

async function perFileReview() {
  const before = model.requests.length
  const fixture = await scenario('review')
  assert(await page.getByTestId('agent-multi-send').isEnabled() === false, 'Empty prompt unexpectedly enabled Send')
  assert(model.requests.length === before, 'Selection sent a model request')
  await requestReview(fixture)
  await cards().nth(0).getByTestId('agent-multi-apply').click(); await idle()
  const revisedA = fixture.original[0].replace('A07_ALPHA_ORIGINAL 中文 😀', 'A07_ALPHA_ORIGINAL 中文 😀 revised')
  const revisedB = fixture.original[1].replace('A07_BETA_ORIGINAL 日本語 😀', 'A07_BETA_ORIGINAL 日本語 😀 revised')
  await expect.poll(() => contents(fixture.ids)).toEqual([revisedA, fixture.original[1], fixture.original[2]])
  await cards().nth(1).getByTestId('agent-multi-apply').click(); await idle()
  await expect.poll(() => contents(fixture.ids)).toEqual([revisedA, revisedB, fixture.original[2]])
  await cards().nth(0).getByTestId('agent-multi-locate').click()
  await expect(dialog()).toBeHidden()
  await input().click(); await page.keyboard.press('Control+z')
  await expect.poll(() => contents(fixture.ids)).toEqual([fixture.original[0], revisedB, fixture.original[2]])
  assert((await state()).targets[0].proposal.changes[0].status === 'reverted', 'Ctrl+Z did not reconcile file A review status')
  await page.keyboard.press('Control+Shift+z')
  await expect.poll(() => contents(fixture.ids)).toEqual([revisedA, revisedB, fixture.original[2]])
  assert((await state()).targets[0].proposal.changes[0].status === 'applied', 'Redo did not reconcile file A review status')
  await openDialog()
  await cards().nth(1).getByTestId('agent-multi-revert').click(); await idle()
  await expect.poll(() => contents(fixture.ids)).toEqual([revisedA, fixture.original[1], fixture.original[2]])
  await cards().nth(0).getByText('View original copy', { exact: true }).click()
  await expect(cards().nth(0).getByTestId('agent-multi-snapshot')).toHaveValue(fixture.original[0])
  await expect(cards().nth(0).getByTestId('agent-multi-snapshot')).toHaveAttribute('readonly', '')
  // Wait longer than the configured real autosave delay, then prove disk bytes.
  await new Promise(resolve => setTimeout(resolve, 500))
  assert(JSON.stringify(await diskHashes(fixture.paths)) === JSON.stringify(fixture.hashes), 'Native review/undo/revert saved source files')
  record('native per-file UI Apply, CodeMirror Ctrl+Z/Redo, per-file Revert, immutable original viewer and no autosave writes', {
    editorMode: 'CodeMirror source', splitPanes: 2, originalHashes: fixture.hashes, finalHashes: await diskHashes(fixture.paths), state: await state(),
  })
  await page.screenshot({ path: path.join(run, 'native-a07-review.png') })
}

async function externalConflict() {
  const fixture = await scenario('disk-conflict')
  await requestReview(fixture)
  const changed = `${fixture.original[0]}\nA07_EXTERNAL_DISK_CHANGE\n`
  await writeFile(fixture.paths[0], changed)
  // A normal watcher may notice the changed clean file before the click and
  // invalidate its review. Both that path and the Apply-time disk probe are safe.
  if (await cards().nth(0).getByTestId('agent-multi-apply').isEnabled()) await cards().nth(0).getByTestId('agent-multi-apply').click()
  await idle()
  const conflicted = await state()
  assert(conflicted.targets[0].status === 'conflict' && conflicted.targets[1].status === 'pending', 'External disk conflict was not isolated to file A')
  await cards().nth(1).getByTestId('agent-multi-apply').click(); await idle()
  const current = await state()
  const firstBuffer = (await contents(fixture.ids))[0]
  assert(current.targets[1].status === 'applied' && [fixture.original[0], changed].includes(firstBuffer), 'Unaffected file did not apply independently, or the stale first-file proposal changed its buffer')
  assert(hash(await readFile(fixture.paths[0])) === hash(changed) && hash(await readFile(fixture.paths[1])) === fixture.hashes[fixture.paths[1]], 'Acceptance overwrote external or unchanged disk bytes')
  record('real external disk edit blocks only the affected target', { originalHashes: fixture.hashes, finalHashes: await diskHashes(fixture.paths), targets: current.targets,
    firstBuffer: firstBuffer === changed ? 'The real watcher reloaded the externally edited clean buffer.' : 'The original open buffer was preserved; its stale proposal was blocked.' })
  await page.screenshot({ path: path.join(run, 'native-a07-disk-conflict.png') })
}

async function wysiwygNormalization() {
  const fixture = await scenario('wysiwyg-normalization', false)
  await requestReview(fixture, 'A07_NORMALIZE: revise the first selected document as a whole and the second independently.')
  const proposed = (await state()).targets[0].proposal.changes[0].newText
  assert(!proposed.endsWith('\n'), 'Normalization fixture accidentally includes a final newline')
  await cards().nth(0).getByTestId('agent-multi-apply').click(); await idle()
  const accepted = await contents(fixture.ids)
  assert(accepted[0] === `${proposed}\n` && accepted[1] === fixture.original[1], `Actual Muya serialization was not the expected newline normalization: ${JSON.stringify(accepted)}`)
  await cards().nth(0).getByTestId('agent-multi-locate').click()
  await expect(dialog()).toBeHidden()
  await input(false).click(); await page.keyboard.press('Control+z')
  await expect.poll(() => contents(fixture.ids)).toEqual(fixture.original)
  assert((await state()).targets[0].proposal.changes[0].status === 'reverted', 'Muya normalized transaction undo did not reconcile review')
  await page.keyboard.press('Control+Shift+z')
  await expect.poll(() => contents(fixture.ids)).toEqual(accepted)
  await openDialog()
  await expect(cards().nth(0).getByTestId('agent-multi-revert')).toBeEnabled()
  await cards().nth(0).getByTestId('agent-multi-revert').click(); await idle()
  await expect.poll(() => contents(fixture.ids)).toEqual(fixture.original)
  const final = await state()
  assert(final.targets[0].status === 'reverted' && !final.targets[0].error, `Muya normalized Revert falsely conflicted: ${JSON.stringify(final.targets[0])}`)
  assert(JSON.stringify(await diskHashes(fixture.paths)) === JSON.stringify(fixture.hashes), 'WYSIWYG normalization review saved source files')
  record('actual Muya whole-document replacement without final newline remains undoable and revertible after normalization', {
    proposedNewText: proposed, actualAcceptedMarkdown: accepted[0], revertedMarkdown: (await contents(fixture.ids))[0],
    otherDocumentUnchanged: true, unchangedDiskHashes: fixture.hashes,
  })
  await page.screenshot({ path: path.join(run, 'native-a07-wysiwyg-normalization.png') })
}

async function unsplitInitialWithoutNewline() {
  const fixture = await scenario('wysiwyg-initial-without-newline', false, false)
  await closeDialog()
  const withoutNewline = fixture.original[0].replace(/\n$/, '')
  await page.evaluate(id => {
    const editor = window.__a07Stores.get('editor')
    window.__a07Stores.get('preferences').autoSave = false
    editor.setCurrent(id)
    editor.currentFile.trimTrailingNewline = 0
  }, fixture.ids[0])
  await expect(input(false)).toBeVisible()
  await input(false).click(); await page.keyboard.press('Control+s')
  await expect.poll(() => readFile(fixture.paths[0], 'utf8')).toBe(withoutNewline)
  await expect.poll(async () => (await state()).tabs.find(tab => tab.id === fixture.ids[0]).lastSavedMarkdown).toBe(withoutNewline)
  await expect.poll(async () => (await contents(fixture.ids))[0]).toBe(withoutNewline)
  const initial = await state()
  assert(initial.paneCount === 1 && !initial.usesSharedHistory, 'The unsplit Muya case accidentally uses shared editor history')
  fixture.original[0] = withoutNewline
  fixture.hashes = await diskHashes(fixture.paths)
  record('native manual Ctrl+S establishes a no-final-LF snapshot for an unsplit Muya document', {
    trimTrailingNewline: 0, paneCount: initial.paneCount, usesSharedHistory: initial.usesSharedHistory,
    savedMarkdown: withoutNewline, diskHashAfterExplicitManualSave: fixture.hashes[fixture.paths[0]],
  })
  await page.evaluate(() => { window.__a07Stores.get('preferences').autoSave = true })
  await openDialog()
  await requestReview(fixture, 'A07_NORMALIZE: revise the first selected document as a whole and the second independently.')
  let current = await state()
  assert(current.targets[0].snapshot.markdown === withoutNewline && !current.targets[0].snapshot.markdown.endsWith('\n'), 'Protected starting snapshot acquired an unintended final LF')
  const proposed = current.targets[0].proposal.changes[0].newText
  await cards().nth(0).getByTestId('agent-multi-apply').click(); await idle()
  const accepted = (await contents(fixture.ids))[0]
  assert(accepted === `${proposed}\n`, 'Muya did not normalize the accepted whole-document replacement')
  await cards().nth(0).getByTestId('agent-multi-locate').click()
  await expect(dialog()).toBeHidden()
  await input(false).click(); await page.keyboard.press('Control+z')
  await expect.poll(async () => (await state()).targets[0].proposal.changes[0].status).toBe('reverted')
  const undone = (await contents(fixture.ids))[0]
  current = await state()
  assert([withoutNewline, `${withoutNewline}\n`].includes(undone) && current.targets[0].status === 'reverted' && !current.targets[0].error,
    `Native unsplit Muya undo became a conflict: ${JSON.stringify(current.targets[0])}`)
  assert(!current.usesSharedHistory && current.paneCount === 1, 'Undo was routed through shared history rather than native Muya')
  await page.keyboard.press('Control+Shift+z')
  await expect.poll(async () => (await contents(fixture.ids))[0]).toBe(accepted)
  assert((await state()).targets[0].proposal.changes[0].status === 'applied', 'Unsplit Muya redo did not restore accepted review state')
  await openDialog()
  await expect(cards().nth(0).getByTestId('agent-multi-revert')).toBeEnabled()
  await cards().nth(0).getByTestId('agent-multi-revert').click(); await idle()
  const reverted = (await contents(fixture.ids))[0]
  current = await state()
  assert([withoutNewline, `${withoutNewline}\n`].includes(reverted) && current.targets[0].status === 'reverted' && !current.targets[0].error,
    `Native unsplit Muya Revert became a conflict: ${JSON.stringify(current.targets[0])}`)
  assert(current.targets[0].snapshot.markdown === withoutNewline, 'Original no-LF snapshot was mutated by undo/revert normalization')
  assert((await contents(fixture.ids))[1] === fixture.original[1], 'Unsplit Muya undo changed the other selected document')
  await new Promise(resolve => setTimeout(resolve, 500))
  assert(JSON.stringify(await diskHashes(fixture.paths)) === JSON.stringify(fixture.hashes), 'Agent acceptance or undo rewrote the explicitly saved no-LF disk file')
  record('unsplit native Muya Apply/Undo/Redo/Revert preserves review decisions with a no-final-LF initial snapshot', {
    usesSharedHistory: current.usesSharedHistory, paneCount: current.paneCount, snapshotMarkdown: withoutNewline,
    proposedNewText: proposed, actualAcceptedMarkdown: accepted, actualUndoMarkdown: undone, actualRevertMarkdown: reverted,
    nativeUndoRestoredTerminalLf: undone === `${withoutNewline}\n`, protectedSnapshotHasTerminalLf: current.targets[0].snapshot.markdown.endsWith('\n'), unchangedHashes: fixture.hashes,
  })
  await page.screenshot({ path: path.join(run, 'native-a07-unsplit-initial-no-lf.png') })
}

async function probeRace(kind) {
  const fixture = await scenario(`probe-${kind}`)
  await requestReview(fixture)
  await page.evaluate(() => { window.__a07HoldVersion = true; window.__a07HeldVersion = null })
  await cards().nth(0).getByTestId('agent-multi-apply').click()
  await expect.poll(() => page.evaluate(() => Boolean(window.__a07ReleaseVersion))).toBe(true)
  const during = await page.evaluate(({ kind, targetId }) => {
    const editor = window.__a07Stores.get('editor')
    const before = { pane: editor.activePaneId, markdown: editor.tabs.find(tab => tab.id === targetId).markdown }
    if (kind === 'buffer') editor.setMarkdownExternal(targetId, `${before.markdown}\nA07_USER_EDIT_DURING_PROBE\n`)
    else editor.activatePane(editor.panes.find(pane => pane.id !== editor.activePaneId).id)
    return { before, after: { pane: editor.activePaneId, markdown: editor.tabs.find(tab => tab.id === targetId).markdown }, realVersionResult: window.__a07HeldVersion }
  }, { kind, targetId: fixture.ids[0] })
  await page.evaluate(() => window.__a07ReleaseVersion())
  await idle()
  const after = await state()
  assert(after.targets[0].status === 'conflict' && after.targets[0].proposal.changes[0].status === 'pending', `${kind} race applied a stale proposal`)
  assert((await contents(fixture.ids))[0] === during.after.markdown, `${kind} race replaced the current buffer`)
  if (kind === 'pane') assert(after.activePaneId === during.after.pane, 'Delayed operation switched the pane back')
  assert(JSON.stringify(await diskHashes(fixture.paths)) === JSON.stringify(fixture.hashes), `${kind} race modified source files`)
  record(`actual Rust version callback delayed: ${kind} change rejects stale Apply`, {
    mutationMethod: kind === 'buffer' ? 'real editor.setMarkdownExternal while native callback awaits delivery' : 'real editor.activatePane while native callback awaits delivery',
    ...during, target: after.targets[0], unchangedDiskHashes: fixture.hashes,
  })
  await page.screenshot({ path: path.join(run, `native-a07-probe-${kind}.png`) })
}

async function cancelLateSse() {
  const fixture = await scenario('cancel')
  await requestReview(fixture, 'A07_CANCEL: read both selected documents, then wait before proposing.')
  await expect.poll(() => model.holds.length, { timeout: 30_000 }).toBe(1)
  const before = await state(), held = model.holds.shift()
  assert(before.stage === 'running' && before.targets.every(target => !target.proposal), 'Cancellation fixture was not held before proposals')
  await page.getByTestId('agent-multi-cancel').click()
  await idle()
  const transmission = held.release()
  await expect.poll(() => page.evaluate(id => window.__a07Events.some(event => event.requestId === id && ['cancelled', 'done', 'error'].includes(event.kind)), before.requestId), { timeout: 30_000 }).toBe(true)
  const after = await state()
  assert(after.stage === 'cancelled' && after.targets.every(target => !target.proposal), 'Late provider proposals survived cancellation')
  assert((await contents(fixture.ids)).every((value, index) => value === fixture.original[index]), 'Cancellation altered a selected buffer')
  const events = await page.evaluate(id => window.__a07Events.filter(event => event.requestId === id), before.requestId)
  assert(!events.some(event => event.kind === 'proposal'), 'Rust published a proposal after cancellation')
  assert(JSON.stringify(await diskHashes(fixture.paths)) === JSON.stringify(fixture.hashes), 'Cancellation wrote source files')
  record('native cancellation prevents delayed SSE proposals from reaching review or buffers', { requestId: before.requestId,
    lateSseAttempt: transmission, terminalEvents: events.filter(event => ['cancelled', 'done', 'error'].includes(event.kind)), unchangedHashes: fixture.hashes,
    deliveryMeaning: transmission.destroyedBeforeWrite ? 'The HTTP stream had already closed before the attempted late response.' : 'The fixture wrote the valid proposal SSE after Stop; Rust emitted no proposal.' })
  await page.screenshot({ path: path.join(run, 'native-a07-cancel.png') })
}

try {
  await connect(); await configure()
  await perFileReview(); await wysiwygNormalization(); await externalConflict(); await probeRace('buffer'); await probeRace('pane'); await cancelLateSse()
  await unsplitInitialWithoutNewline()
  assert(model.failures.length === 0, `Model fixture errors: ${model.failures.join('; ')}`)
  assert(receipt.pageErrors.length === 0, `Renderer errors: ${receipt.pageErrors.join('; ')}`)
  assert(!JSON.stringify(model.requests).includes('A07_UNSELECTED_PRIVATE_NEVER_SEND'), 'Unselected document leaked into a model request')
  receipt.success = true
} catch (error) { receipt.error = String(error.stack || error); process.stderr.write(`${receipt.error}\n`); process.exitCode = 1 }
finally {
  if (page && verifiedApplication) {
    await page.screenshot({ path: path.join(run, 'native-a07-final.png') }).catch(() => {})
    const events = await page.evaluate(async () => {
      const agent = window.__a07Stores?.get('agent')
      if (agent?.multiDocumentState.busy || agent?.multiDocumentState.actionBusy) await agent.multiDocument.cancel()
      window.__a07ReleaseVersion?.()
      const bridge = window.__TAURI_INTERNALS__, callbacks = bridge.callbacks
      if (window.__a07CallbackDescriptor) Object.defineProperty(callbacks, 'set', window.__a07CallbackDescriptor)
      else delete callbacks.set
      if (window.__a07Listener !== undefined) await bridge.invoke('plugin:event|unlisten', { event: 'mt://agent/event', eventId: window.__a07Listener })
      return window.__a07Events ?? []
    }).catch(() => [])
    await writeFile(path.join(run, 'events.json'), JSON.stringify(events, null, 2)).catch(() => {})
    await writeFile(path.join(run, 'final-state.json'), JSON.stringify(await state().catch(() => null), null, 2)).catch(() => {})
  }
  if (model) {
    receipt.modelRequests = model.requests.length; receipt.modelCalls = model.toolCalls.length; receipt.modelFixtureFailures = model.failures
    await writeFile(path.join(run, 'model-requests.json'), JSON.stringify(model.requests, null, 2)).catch(() => {})
    await writeFile(path.join(run, 'model-calls.json'), JSON.stringify(model.toolCalls, null, 2)).catch(() => {})
    for (const held of model.holds) held.release()
    model.server.closeAllConnections(); model.server.close()
  }
  receipt.finishedAt = new Date().toISOString()
  await writeFile(path.join(run, 'receipt.json'), JSON.stringify(receipt, null, 2)).catch(() => {})
  await browser?.close()
  process.stdout.write(`${JSON.stringify({ success: receipt.success, run, checks: receipt.checks.length })}\n`)
}
