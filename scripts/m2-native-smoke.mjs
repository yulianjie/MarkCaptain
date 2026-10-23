#!/usr/bin/env node
// Real WebView2 + Rust integration. A loopback model fixture produces tool calls;
// project I/O and public web requests use the actual backend. Never targets an installed profile.
import { chromium, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdir, lstat, realpath, readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const output = path.resolve('output/m2-native')
const cdp = process.env.M2_CDP_URL || 'http://127.0.0.1:9339'
const identifier = 'io.github.yulianjie.markcaptain.m2-validation'
const phase = process.argv.includes('--finish-restore') ? 'finish-restore' : process.argv.includes('--restore') ? 'restore' : 'exercise'
const run = path.join(output, `${phase}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const receipt = { schemaVersion: 1, native: true, productionProtocol: true, backendMocked: false, modelFixture: true, phase, success: false, checks: [], pageErrors: [], output: run }
let browser, page, model
const fail = (message) => { throw new Error(message) }
const assert = (condition, message) => { if (!condition) fail(message) }
const norm = value => path.resolve(String(value).replace(/^\\\\\?\\/, '')).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
const inside = (root, candidate) => norm(candidate) === norm(root) || norm(candidate).startsWith(`${norm(root)}/`)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function record(name, details) { receipt.checks.push({ name, ...(details === undefined ? {} : { details }) }); process.stdout.write(`${name}\n`) }

async function connect() {
  const metadata = await lstat(output).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
  assert(!metadata?.isSymbolicLink(), 'Refusing an aliased output root')
  await mkdir(output, { recursive: true })
  assert(norm(await realpath(output)) === norm(output), 'Output root escapes the workspace')
  await mkdir(run, { recursive: false })
  const connectionDeadline = Date.now() + 15_000
  while (!browser) {
    try { browser = await chromium.connectOverCDP(cdp, { timeout: 5_000 }) }
    catch (error) {
      if (Date.now() >= connectionDeadline) throw error
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  const candidates = browser.contexts().flatMap(context => context.pages()).filter(candidate => /^(http:\/\/tauri\.localhost|tauri:)/.test(candidate.url()))
  assert(candidates.length === 1, 'Expected exactly one production-protocol validation WebView')
  page = candidates[0]
  page.on('pageerror', error => receipt.pageErrors.push(error.message))
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia?._s.has('agent'))
  receipt.app = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke
    const [identifier, configDir, dataDir, localDataDir] = await Promise.all([
      invoke('plugin:app|identifier'), ...[13, 14, 15].map(directory => invoke('plugin:path|resolve_directory', { directory })),
    ])
    return { identifier, configDir, dataDir, localDataDir, url: location.href }
  })
  assert(receipt.app.identifier === identifier, `Refusing non-isolated app ${receipt.app.identifier}`)
  for (const key of ['configDir', 'dataDir', 'localDataDir']) {
    const canonical = await realpath(receipt.app[key])
    assert(path.basename(canonical).toLowerCase() === identifier, `Unexpected application directory ${canonical}`)
    receipt.app[`${key}Canonical`] = canonical
  }
  const startup = await page.evaluate(() => {
    const stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
    return { paths: stores.get('editor').tabs.map(tab => tab.pathname).filter(Boolean), root: stores.get('project').projectTree?.pathname }
  })
  for (const candidate of [...startup.paths, ...(startup.root ? [startup.root] : [])]) assert(inside(output, candidate), `Refusing restored user path ${candidate}`)
  await expect.poll(() => page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('editor').startupHydrationPending)).toBe(false)
  record('isolated Windows WebView2 with bundled production resources and real IPC', receipt.app)
  const expectedBundle = (await readdir(path.resolve('dist/assets'))).find(name => /^EditorPage-.*\.js$/.test(name))
  const loadedBundles = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name).filter(name => /\/EditorPage-.*\.js$/.test(name)))
  assert(expectedBundle && loadedBundles.some(url => url.endsWith(`/${expectedBundle}`)), `Packaged frontend is stale: ${loadedBundles.join(', ')}; expected ${expectedBundle}`)
  record('native executable embeds the latest built editor bundle', { expectedBundle, loadedBundles })
  await page.evaluate(async () => {
    window.__m2NativeEvents = []
    const bridge = window.__TAURI_INTERNALS__
    window.__m2NativeListener = await bridge.invoke('plugin:event|listen', {
      event: 'mt://agent/event', target: { kind: 'Any' },
      handler: bridge.transformCallback(event => { if (window.__m2NativeEvents.length < 256) window.__m2NativeEvents.push(event.payload) }),
    })
  })
}

async function makeModel() {
  const requests = [], tools = []
  const server = createServer(async (req, res) => {
    try {
      let body = ''
      for await (const chunk of req) { body += chunk; assert(body.length < 4_000_000, 'Model fixture request too large') }
      const input = JSON.parse(body); requests.push(input)
      const messages = input.messages || []
      const text = messages.filter(message => message.role === 'user').map(message => message.content).join('\n')
      const answered = id => messages.find(message => message.tool_call_id === id)
      const result = id => { const message = answered(id); return message ? JSON.parse(message.content) : null }
      let call, answer = 'M2 native fixture completed.'
      if (text.includes('M2_CONTINUE')) {
        answer = 'Received the reverted state after restored-review undo.'
      } else if (text.includes('M2_PROJECT')) {
        if (!answered('p-search')) call = ['p-search', 'search_project', { query: 'M2needle' }]
        else {
          const search = result('p-search'); const match = (search?.results || search?.matches || []).find(match => match.path.endsWith('Reference.md'))
          assert(match?.documentId, `Project search did not return Reference.md: ${JSON.stringify(search)}`)
          if (!answered('p-read')) call = ['p-read', 'read_project_document', { documentId: match.documentId, startLine: 1, endLine: 3 }]
          else if (!answered('p-cite')) call = ['p-cite', 'cite_document', { documentId: match.documentId, startLine: 3, endLine: 3, label: 'Unsaved project evidence' }]
          else if (!answered('p-denied')) call = ['p-denied', 'propose_edit', { documentId: match.documentId, title: 'Forbidden reference edit', changes: [{ oldText: 'M2needle', newText: 'WRONG' }] }]
          else if (!answered('p-propose')) call = ['p-propose', 'propose_edit', { title: 'M2 native history review', changes: [
            { oldText: 'Agent target original', newText: 'Agent target revised' },
            { oldText: 'Accepted earlier', newText: 'Accepted earlier revised' },
            { oldText: 'Rejected earlier', newText: 'Rejected earlier revised' },
            { oldText: 'Withdrawn earlier', newText: 'Withdrawn earlier revised' },
          ] }]
          assert(!answered('p-denied') || result('p-denied')?.error, 'Reference proposal was not rejected')
        }
      } else if (text.includes('M2_WEB')) {
        if (!answered('w-denied')) call = ['w-denied', 'search_web', { query: 'this query was never approved' }]
        else if (!answered('w-search')) call = ['w-search', 'search_web', { query: 'Markdown local documents' }]
        else {
          // Direct URL IDs are model-visible only in task-scoped metadata.
          const direct = messages.filter(message => typeof message.content === 'string')
            .map(message => message.content.match(/"sourceId"\s*:\s*"([0-9a-f-]{36})"[^}]*?"url"\s*:\s*"https:\/\/example\.com/i))
            .find(Boolean)
          const search = result('w-search')
          const cards = Array.isArray(search) ? search : search?.sources || search?.results || []
          const sourceId = direct?.[1] || cards.find(source => source.url?.startsWith('https://example.com'))?.sourceId || cards[0]?.sourceId
          assert(sourceId, 'No registered public source ID was exposed to the model')
          if (!answered('w-open')) call = ['w-open', 'open_web_source', { sourceId }]
          assert(result('w-denied')?.error, 'Unapproved web query was not rejected')
        }
      } else if (text.includes('M2_READ_ONLY') || messages.some(message => typeof message.content === 'string' && message.content.includes('This is a read-only task. Never propose edits.'))) {
        if (!answered('r-denied')) call = ['r-denied', 'propose_edit', { title: 'Forbidden read-only change', oldText: 'Agent target original', newText: 'WRONG' }]
        else assert(result('r-denied')?.error, 'Read-only task permitted a proposal')
      } else if (text.includes('M2_REVOKED')) {
        if (!answered('x-search')) call = ['x-search', 'search_project', { query: 'M2needle' }]
        else assert(result('x-search')?.error, 'Revoked project access still worked')
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      const delta = call ? { tool_calls: [{ index: 0, id: call[0], type: 'function', function: { name: call[1], arguments: JSON.stringify(call[2]) } }] } : { content: answer }
      if (call) tools.push(call)
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\n`)
      res.end('data: [DONE]\n\n')
    } catch (error) { res.writeHead(500); res.end(String(error.stack || error)) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, requests, tools, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }
}

async function setupModel() {
  model = await makeModel()
  await page.evaluate(async baseUrl => {
    const stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
    await stores.get('agent').saveConfig({ baseUrl, model: 'm2-native-fixture', authMode: 'none' })
    const layout = stores.get('layout'); layout.showInspector = true; layout.setInspectorPanel('agent')
    stores.get('agent').visible = true; stores.get('agent').settingsOpen = false
  }, model.baseUrl)
}

async function waitIdle() {
  await expect.poll(() => page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('agent').busy), { timeout: 90_000 }).toBe(false)
}
async function send(prompt) {
  const composer = page.locator('#agent-panel .agent-composer > textarea')
  await expect(composer).toBeVisible(); await composer.fill(prompt)
  await page.locator('#agent-panel .agent-send-row button.agent-primary').click()
  await waitIdle()
  const error = await page.evaluate(() => {
    const agent = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('agent')
    return agent.error || agent.conversation.messages.at(-1)?.error || null
  })
  assert(!error, `Native agent request failed: ${error}`)
}

async function exercise() {
  const root = path.join(run, 'project'), docs = path.join(root, 'docs')
  await mkdir(docs, { recursive: true }); await mkdir(path.join(root, 'excluded')); await mkdir(path.join(root, 'exports'))
  const target = path.join(docs, 'Target.md'), reference = path.join(docs, 'Reference.md')
  const targetMarkdown = '# Native M2\n\nAgent target original\n\nAccepted earlier\n\nRejected earlier\n\nWithdrawn earlier\n\nMark Captain\n\n[missing](missing.md)\n'
  const referenceMarkdown = '# Project source\n\nM2needle disk text\n'
  await writeFile(target, targetMarkdown); await writeFile(reference, referenceMarkdown)
  await writeFile(path.join(root, 'excluded', 'Private.md'), '# Excluded\nM2needle EXCLUDED_SECRET_NEVER_SEND\n')
  await writeFile(path.join(root, 'exports', 'Generated.md'), '# Export\nM2needle OUTPUT_SECRET_NEVER_SEND\n')
  const beforeReference = hash(await readFile(reference))
  await page.evaluate(async ({ root, target, reference }) => {
    const stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
    await stores.get('project').openRoot(root)
    const editor = stores.get('editor')
    const ref = await editor.openFile(reference)
    ref.pendingBaselineUpdate = false // A fixture edit is not Muya's initial parse roundtrip.
    editor.applyContentChange(ref.id, '# Project source\n\nM2needle 未保存的证据 😀\n')
    if (ref.isSaved) throw new Error('Native fixture did not create an unsaved reference buffer')
    await editor.openFile(target)
    editor.sourceCodeMode = true
  }, { root, target, reference })
  await setupModel()
  const config = { schemaVersion: 1, writing: { language: 'zh-CN', audience: 'Native validation readers', tone: 'Concise', glossary: [{ preferred: 'MarkCaptain', avoid: ['Mark Captain'] }] }, projectSearch: { enabledByDefault: true, include: ['docs/**/*.md'], exclude: ['excluded/**'] }, futureExtension: { retained: true } }
  const configResult = await page.evaluate(async ({ root, config }) => {
    const invoke = window.__TAURI_INTERNALS__.invoke
    const before = await invoke('cmd_agent_project_load_config', { root })
    const saved = await invoke('cmd_agent_project_save_config', { root, config, expectedFingerprint: before.fingerprint })
    let staleRejected = false
    try { await invoke('cmd_agent_project_save_config', { root, config, expectedFingerprint: before.fingerprint }) } catch (error) { staleRejected = String(error).includes('projectConfigConflict') }
    const agent = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('agent')
    await agent.loadProjectConfig(root)
    return { staleRejected, extension: saved.config.futureExtension, grantBeforeUserChoice: agent.conversation.projectAccess.grantId }
  }, { root, config })
  assert(configResult.staleRejected && !configResult.grantBeforeUserChoice && configResult.extension?.retained, 'Config conflict/default authorization boundary failed')
  record('project config roundtrip, unknown fields, stale-writer rejection, and no automatic grant', configResult)
  const check = await page.evaluate(async () => {
    const agent = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('agent')
    await agent.checkCurrentDocument(); return { result: agent.documentCheck?.result, error: agent.documentCheckError }
  })
  assert(!check.error && check.result?.issues.some(issue => issue.kind === 'glossary') && check.result.issues.some(issue => issue.kind === 'local-target'), `Deterministic check failed: ${JSON.stringify(check)}`)
  record('deterministic checks use current buffer and project terminology without a model request', check)
  await page.evaluate(async () => {
    const agent = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('agent')
    await agent.send('M2_READ_ONLY: check the current document without editing it.', undefined, undefined, undefined, { readOnly: true })
  })
  await waitIdle()
  const readOnly = await page.evaluate(() => {
    const agent = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('agent')
    return { edit: Boolean(agent.conversation.messages.at(-1).edit), error: agent.conversation.messages.at(-1).error }
  })
  assert(!readOnly.edit && !readOnly.error, `Read-only check failed: ${JSON.stringify(readOnly)}`)
  record('Rust rejects proposals during a read-only model check', readOnly)
  await page.evaluate(async () => {
    const agent = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('agent')
    agent.conversation.projectAccess.include = ['docs/**/*.md']; agent.conversation.projectAccess.exclude = ['excluded/**']
    agent.conversation.applyProjectWritingRules = true
    await agent.setProjectSearchEnabled(true)
    if (!agent.conversation.projectAccess.grantId) throw new Error(agent.conversation.projectAccess.error)
  })
  await send('M2_PROJECT: search the authorized project, read evidence, cite it, and propose current-document changes.')
  const projectState = await page.evaluate(() => {
    const agent = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('agent'); const message = agent.conversation.messages.at(-1)
    return { grant: agent.conversation.projectAccess.grantId, candidates: message.projectSearchResults, references: message.references, sources: message.sources, edit: message.edit, error: agent.error }
  })
  assert(projectState.edit?.changes.length === 4 && projectState.sources?.some(source => source.quote.includes('未保存的证据')), `Project snapshot/citation integration failed: ${JSON.stringify(projectState)}`)
  const serialized = JSON.stringify(model.requests)
  assert(!serialized.includes('EXCLUDED_SECRET_NEVER_SEND') && !serialized.includes('OUTPUT_SECRET_NEVER_SEND'), 'Excluded project content reached the model')
  assert(serialized.includes('未保存的证据') && !serialized.includes('M2needle disk text'), 'Dirty buffer did not override the disk snapshot')
  const initialMessages = model.requests.find(request => request.messages.some(message => typeof message.content === 'string' && message.content.includes('M2_PROJECT')))?.messages || []
  assert(!JSON.stringify(initialMessages).includes('未保存的证据'), 'Reference body was eagerly sent before a read tool')
  record('project search/read/cite uses unsaved CJK snapshots; reference edits are rejected; exclusions stay out of model context', { candidates: projectState.candidates?.length, references: projectState.references?.length, sources: projectState.sources?.length })
  await page.evaluate(async () => {
    const stores = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s; const agent = stores.get('agent')
    const edit = agent.conversation.messages.at(-1).edit
    agent.apply(edit, 1); agent.dismiss(edit, 2); agent.apply(edit, 3); agent.revert(edit, 3)
    await stores.get('editor').saveCurrent()
    await agent.setHistoryEnabled(true); await agent.flushHistory()
  })
  const history = await page.evaluate(() => {
    const agent = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('agent')
    const message = agent.conversation.messages.find(message => message.edit)
    return { id: agent.conversation.id, messageId: message.id, statuses: message.edit.changes.map(change => change.status) }
  })
  assert(history.statuses.join(',') === 'pending,applied,dismissed,reverted', 'Mixed review decisions did not persist')
  await writeFile(path.join(output, 'history-resume.json'), JSON.stringify({ ...history, root, target, reference, beforeReference }, null, 2))
  record('opt-in review history saves pending/applied/dismissed/reverted separately', history)
  await page.evaluate(async () => {
    const agent = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('agent')
    await agent.setProjectSearchEnabled(false); await agent.clear()
    Object.assign(agent.conversation.webResearch, { enabled: true, topic: 'Markdown local documents', allowDocumentQueries: false, publicDns: true, approvedQueries: ['Markdown local documents'], urls: ['https://example.com/'] })
    agent.includeDocument = false
  })
  await send('M2_WEB: use the approved query and read the user-provided example.com source.')
  const web = await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('agent').conversation.messages.at(-1).webSources)
  assert(web?.some(source => source.status === 'read'), `Public source was not read: ${JSON.stringify(web)}`)
  record('real public web search/source reads, approved-query rejection, source states and metadata', web)
  assert(beforeReference === hash(await readFile(reference)), 'Read-only project reference was saved or modified')
  record('project reference remains byte-for-byte unchanged on disk', { sha256: beforeReference })
  await page.evaluate(async reference => {
    const editor = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('editor')
    const tab = editor.tabs.find(tab => tab.pathname?.replaceAll('\\', '/').toLowerCase() === reference.replaceAll('\\', '/').toLowerCase())
    if (tab) await editor.closeTab(tab.id, true) // Discard only this harness-owned unsaved reference buffer.
  }, reference)
}

async function restore() {
  const saved = JSON.parse(await readFile(path.join(output, 'history-resume.json'), 'utf8'))
  assert(inside(output, saved.target) && inside(output, saved.root), 'Resume metadata points outside the test workspace')
  await setupModel()
  const restored = await page.evaluate(async ({ id, alreadySelected }) => {
    const agent = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('agent')
    if (!alreadySelected) await agent.restoreHistory(id)
    const message = agent.conversation.messages.find(message => message.edit)
    return { locked: message?.edit?.locked, statuses: message?.edit?.changes.map(change => change.status), grant: agent.conversation.projectAccess.grantId, web: agent.conversation.webResearch.enabled, publicDns: agent.conversation.webResearch.publicDns, attached: agent.includeDocument }
  }, { id: saved.id, alreadySelected: phase === 'finish-restore' })
  assert(restored.locked && restored.statuses.join(',') === 'pending,applied,dismissed,reverted' && !restored.grant && !restored.web && !restored.publicDns && !restored.attached, `Restart restore crossed a review or permission boundary: ${JSON.stringify(restored)}`)
  record('after native app restart, history is read-only and all source permissions remain off', restored)
  if (phase !== 'finish-restore') {
    await page.evaluate(messageId => {
      const agent = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('agent')
      window.__m2RevalidationDone = false
      void agent.revalidateHistoryReview(messageId).then(result => { window.__m2RevalidationResult = result; window.__m2RevalidationDone = true })
    }, saved.messageId)
    process.stdout.write(`M2_FILE_PICKER_READY ${saved.target}\n`)
    await expect.poll(() => page.evaluate(() => window.__m2RevalidationDone), { timeout: 120_000 }).toBe(true)
  } else {
    assert(await page.evaluate(() => window.__m2RevalidationDone === true), 'The native file selection has not completed')
  }
  const validation = await page.evaluate(() => {
    const agent = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('agent')
    return { result: window.__m2RevalidationResult, error: agent.historyReviewError || agent.historyError, edits: agent.conversation.messages.filter(message => message.edit).map(message => ({ id: message.id, locked: message.edit.locked, changes: message.edit.changes.map(change => change.status), changeIds: message.edit.changes.map(change => change.id), rebasedFrom: message.edit.rebasedFrom })) }
  })
  assert(validation.result && validation.edits.length === 2 && validation.edits[0].locked && validation.edits[1].changes.join(',') === 'pending', `Explicit revalidation failed: ${JSON.stringify(validation)}`)
  const revalidatedChangeId = validation.edits[1].changeIds[0]
  record('native file selection revalidates only pending edits against the live document', validation)
  const change = page.locator('.agent-edit-review').last().locator('.agent-change').first()
  const fallback = page.locator('.agent-change').last()
  const review = await change.count() ? change : fallback
  await review.getByRole('button', { name: /^Apply (?:edit|change)$/ }).click()
  const editor = page.locator('.editing-region.active .cm-content:visible, .editing-region.active .muya-host [contenteditable="true"]:visible').first()
  await expect.poll(() => page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('editor').currentFile.markdown)).toContain('Agent target revised')
  await editor.click(); await page.keyboard.press('Control+z')
  await expect.poll(() => page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('editor').currentFile.markdown)).toContain('Agent target original')
  await expect.poll(() => page.evaluate(changeId => {
    const agent = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('agent')
    return agent.conversation.messages.flatMap(message => message.edit?.changes ?? []).find(change => change.id === changeId)?.status
  }, revalidatedChangeId)).toBe('reverted')
  record('revalidated review applies through the UI and remains undoable')
  await send('M2_CONTINUE after restored review undo')
  const continued = model.requests.find(request => request.messages.some(message => typeof message.content === 'string' && message.content.includes('M2_CONTINUE')))
  const feedback = continued?.messages.map(message => message.content).filter(content => typeof content === 'string' && content.includes('[User review feedback]'))
  const feedbackChanges = feedback?.flatMap(content => content.split('[User review feedback]\n').slice(1).flatMap(part => JSON.parse(part.trim()).changes)) ?? []
  assert(feedbackChanges.some(change => change.id === revalidatedChangeId && change.status === 'reverted'), 'Continued conversation did not receive the exact restored-review undo state')
  record('continued conversation receives reverted review feedback after restart/revalidation/undo', { changeId: revalidatedChangeId, status: 'reverted' })
}

try {
  await connect()
  if (phase === 'exercise') await exercise(); else await restore()
  assert(!receipt.pageErrors.length, `Renderer errors: ${receipt.pageErrors.join('; ')}`)
  receipt.success = true
} catch (error) { receipt.error = String(error.stack || error); process.stderr.write(`${receipt.error}\n`); process.exitCode = 1 }
finally {
  if (page) {
    const events = await page.evaluate(async () => {
      if (window.__m2NativeListener !== undefined) await window.__TAURI_INTERNALS__.invoke('plugin:event|unlisten', { event: 'mt://agent/event', eventId: window.__m2NativeListener })
      return window.__m2NativeEvents || []
    }).catch(() => [])
    await writeFile(path.join(run, 'events.json'), JSON.stringify(events, null, 2)).catch(() => {})
  }
  if (page) await page.screenshot({ path: path.join(run, 'native-m2.png') }).catch(() => {})
  if (model) { receipt.modelRequests = model.requests.length; receipt.modelCalls = model.tools.map(call => call[1]); await writeFile(path.join(run, 'model-receipt.json'), JSON.stringify(model.requests, null, 2)); model.server.close() }
  receipt.finishedAt = new Date().toISOString()
  await writeFile(path.join(run, 'receipt.json'), JSON.stringify(receipt, null, 2)).catch(() => {})
  await browser?.close()
  process.stdout.write(`${JSON.stringify({ success: receipt.success, run, checks: receipt.checks.length })}\n`)
}
