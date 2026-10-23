#!/usr/bin/env node
// Production-protocol M1 smoke. Connects to an already-running isolated Tauri app;
// it never launches/closes the app and never opens the OS Save or Print dialog.
import { randomUUID, createHash } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { chromium, expect } from '@playwright/test'

const outputBase = path.resolve(process.env.M1_PRODUCTION_OUTPUT_ROOT || 'output/m1-native')
const cdpUrl = process.env.M1_PRODUCTION_CDP_URL || 'http://127.0.0.1:9337'
const expectedIdentifier = process.env.M1_APP_IDENTIFIER || 'io.github.yulianjie.markcaptain.m1-validation'
const runId = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', 'Z')
const projectRoot = path.join(outputBase, `production-${runId}`)
const assetRoot = path.join(projectRoot, 'assets')
const exportRoot = path.join(projectRoot, 'exports')
const receiptPath = path.join(projectRoot, 'receipt.json')
const screenshotPath = path.join(projectRoot, 'production-smoke.png')
let outputBaseVerified = false
let productionRootVerified = false

const profile = {
  id: 'm1-production-smoke',
  name: 'M1 Production Smoke',
  theme: 'technical',
  content: { mode: 'current', source: 'buffer' },
  formats: ['html', 'pdf', 'docx', 'odt', 'epub'],
  output: { directory: 'exports', fileName: '{name}' },
  typography: { bodyFont: 'system-cjk', codeFont: 'system-monospace', bodySizePt: 11, lineHeight: 1.65 },
  page: { size: 'A4', orientation: 'portrait', marginMm: { top: 20, right: 20, bottom: 20, left: 20 } },
  toc: { enabled: true, depth: 3 },
  numberHeadings: false,
  resources: { htmlMode: 'embed', downloadRemote: false },
  html: { showTitle: true },
  pdf: { backend: 'pandoc' },
  docx: { stylePreset: 'technical' },
  epub: { stylePreset: 'technical' },
}

const receipt = {
  schemaVersion: 1,
  productionProtocol: true,
  backendMocked: false,
  success: false,
  cdpUrl,
  expectedIdentifier,
  outputBase,
  projectRoot,
  exportRoot,
  receiptPath,
  screenshotPath,
  checks: [],
  pageErrors: [],
}

function failIf(condition, message) {
  if (condition) throw new Error(message)
}

function normalPath(value) {
  let portable = String(value).replaceAll('\\', '/')
  if (/^\/\/\?\/UNC\//i.test(portable)) portable = `//${portable.slice(8)}`
  else if (/^\/\/\?\//.test(portable)) portable = portable.slice(4)
  return path.resolve(portable).replaceAll('\\', '/').replace(/\/+$/, '').toLocaleLowerCase()
}

function isWithin(root, candidate) {
  const base = normalPath(root)
  const target = normalPath(candidate)
  return target === base || target.startsWith(`${base}/`)
}

function assertWithin(root, candidate, description) {
  failIf(!path.isAbsolute(candidate) || !isWithin(root, candidate), `${description} escaped its authorized directory: ${candidate}`)
}

async function canonicalProspectivePath(candidate) {
  let current = path.resolve(candidate)
  const suffix = []
  while (true) {
    try { return path.join(await realpath(current), ...suffix.reverse()) }
    catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      suffix.unshift(path.basename(current))
      current = parent
    }
  }
}

async function assertAppRoot(envName, actual) {
  const actualCanonical = await canonicalProspectivePath(actual)
  const expected = process.env[envName]
  if (expected) {
    const expectedCanonical = await canonicalProspectivePath(expected)
    failIf(normalPath(expected) !== normalPath(expectedCanonical), `${envName} must name a canonical directory without a symlink alias`)
    failIf(normalPath(expectedCanonical) !== normalPath(actualCanonical), `Tauri directory does not match ${envName}: ${actualCanonical}`)
    failIf(path.basename(actualCanonical).toLocaleLowerCase() !== expectedIdentifier.toLocaleLowerCase(), `${envName} does not end in ${expectedIdentifier}`)
  } else {
    failIf(normalPath(actual) !== normalPath(actualCanonical), `${envName} is unset and Tauri returned a path through an alias`)
    assertWithin(outputBase, actualCanonical, envName)
  }
  return actualCanonical
}

function record(name, details = undefined) {
  receipt.checks.push(details === undefined ? { name } : { name, details })
  process.stdout.write(`${name}\n`)
}

function requireSafeOutput(pathname, description) {
  const resolved = path.resolve(pathname)
  assertWithin(projectRoot, resolved, description)
  return resolved
}

function visibleTextContains(value, pattern) {
  return typeof value === 'string' && pattern.test(value)
}

function hasExternalFontReferences(html) {
  return [...html.matchAll(/url\(([^)]+)\)/gi)]
    .map(match => match[1].trim().replace(/^['"]|['"]$/g, ''))
    .some(source => /\.(?:woff2?|ttf|otf)(?:[?#]|$)/i.test(source) && !/^data:/i.test(source))
}

async function getPage(browser) {
  const pages = browser.contexts().flatMap(context => context.pages())
  const candidates = []
  for (const candidate of pages) {
    const isTauri = await candidate.evaluate(() => Boolean(window.__TAURI_INTERNALS__?.invoke)).catch(() => false)
    if (isTauri) candidates.push(candidate)
  }
  failIf(candidates.length !== 1, `Expected one Tauri production WebView at ${cdpUrl}; found ${candidates.length}`)
  const page = candidates[0]
  const url = page.url()
  const lowerUrl = url.toLocaleLowerCase()
  failIf(lowerUrl.includes('localhost:1420'), `Refusing the Vite dev server page: ${url}`)
  const parsedUrl = new URL(url)
  const customProtocol = parsedUrl.protocol === 'tauri:'
    || parsedUrl.protocol === 'http:' && parsedUrl.hostname.toLocaleLowerCase() === 'tauri.localhost'
  failIf(!customProtocol, `Expected tauri:// or http://tauri.localhost, received ${url}`)
  receipt.url = url
  page.on('pageerror', error => receipt.pageErrors.push(error.message))
  await page.waitForFunction(() => Boolean(document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia), undefined, { timeout: 30_000 })

  const app = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__?.invoke
    if (typeof invoke !== 'function') throw new Error('Tauri production invoke bridge is missing')
    const [identifier, name, version, configDir, dataDir, localDataDir] = await Promise.all([
      invoke('plugin:app|identifier'),
      invoke('plugin:app|name'),
      invoke('plugin:app|version'),
      invoke('plugin:path|resolve_directory', { directory: 13 }),
      invoke('plugin:path|resolve_directory', { directory: 14 }),
      invoke('plugin:path|resolve_directory', { directory: 15 }),
    ])
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
    const storeIds = ['project', 'notebook', 'layout', 'editor', 'agent', 'commandCenter']
    const stores = Object.fromEntries(storeIds.map(id => [id, Boolean(pinia._s.get(id))]))
    return { identifier, name, version, configDir, dataDir, localDataDir, storeIds: stores }
  })
  receipt.app = app
  failIf(app.identifier !== expectedIdentifier, `Refusing unexpected Tauri identifier: ${app.identifier}`)
  failIf(app.identifier === 'io.github.yulianjie.markcaptain', 'Refusing the installed production app profile')
  for (const [key, envName] of [['configDir', 'M1_APP_CONFIG_ROOT'], ['dataDir', 'M1_APP_DATA_ROOT'], ['localDataDir', 'M1_APP_LOCAL_DATA_ROOT']]) {
    app[`${key}Canonical`] = await assertAppRoot(envName, app[key])
  }
  for (const [store, exists] of Object.entries(app.storeIds)) failIf(!exists, `Production app is missing the ${store} Pinia store`)
  record('custom-protocol production app and isolated Pinia/Tauri identity', app)
  return page
}

async function createProjectFiles() {
  await mkdir(projectRoot, { recursive: false })
  failIf(normalPath(await realpath(projectRoot)) !== normalPath(projectRoot), `Production fixture root resolves through an alias: ${projectRoot}`)
  productionRootVerified = true
  await mkdir(assetRoot, { recursive: false })
  await mkdir(exportRoot, { recursive: false })
  const markdownPath = path.join(projectRoot, 'Report.md')
  const referencePath = path.join(projectRoot, 'Reference.md')
  const imagePath = path.join(assetRoot, 'chart.svg')
  for (const [candidate, label] of [[markdownPath, 'Markdown source'], [referencePath, 'Relation source'], [imagePath, 'SVG fixture']]) {
    requireSafeOutput(candidate, label)
  }

  const tableRows = Array.from({ length: 80 }, (_, index) => {
    const number = index + 1
    const endMarker = number === 80 ? 'TABLE-END-ROW-080 ' : ''
    return `| ${String(number).padStart(2, '0')} | ${number % 2 ? '已核对' : '待核对'} | ${endMarker}生产记录第 ${number} 行 |`
  })
  const codeLines = Array.from({ length: 200 }, (_, index) => {
    const number = index + 1
    return `const row${String(number).padStart(3, '0')} = { index: ${number}, label: "生产数据行 ${String(number).padStart(3, '0')}" }`
  })
  const wideTableHeaders = ['编号', '分类', '负责人', '类型', '来源', '状态', '优先级', '版本', '日期', '区域', '长标识', '备注']
  const wideTableRow = ['01', '工程记录', '写作组', '导出', '本地项目', '已核对', '高', 'v1', '2026-10-22', '新加坡', 'markcaptain-project-document-export-validation-long-reproducible-identifier-with-many-break-points-v2026-10-22', 'WIDE-END-12COL']
  const markdown = [
    '# 生产协议导出验收',
    '',
    '这份中文样例用于检查 production custom protocol 下的文档、资源和静态渲染。',
    '',
    '行内公式：$x^2 + y^2 = z^2$。',
    '',
    '## Overview',
    '',
    '![本地生产图表](assets/chart.svg)',
    '',
    '## 80 行生产数据表',
    '',
    '| 序号 | 状态 | 说明 |',
    '| ---: | --- | --- |',
    ...tableRows,
    '',
    '## 12 列宽表',
    '',
    `| ${wideTableHeaders.join(' | ')} |`,
    `| ${wideTableHeaders.map(() => '---').join(' | ')} |`,
    `| ${wideTableRow.join(' | ')} |`,
    '',
    '脚注样例[^production-note]。',
    '',
    '[^production-note]: FOOTNOTE-END 原生导出脚注内容。',
    '',
    '## 200 行 JavaScript 代码块',
    '',
    '```js',
    ...codeLines,
    '```',
    '',
    '```mermaid',
    'graph LR',
    '  A[编辑] --> B[审阅] --> C[导出]',
    '```',
    '',
  ].join('\n')
  await writeFile(markdownPath, markdown, { encoding: 'utf8', flag: 'wx' })
  await writeFile(referencePath, '# 关联资料\n\n[[Report#Overview|生产报告]]\n', { encoding: 'utf8', flag: 'wx' })
  await writeFile(imagePath, '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="32" viewBox="0 0 48 32"><rect width="48" height="32" rx="5" fill="#075a9c"/><circle cx="16" cy="16" r="7" fill="#fff"/><path d="M25 10h15v3H25zm0 7h12v3H25z" fill="#fff"/></svg>\n', { encoding: 'utf8', flag: 'wx' })
  failIf(tableRows.length !== 80 || codeLines.length !== 200 || wideTableHeaders.length !== 12 || wideTableRow.length !== 12, 'Production stress fixture shape differs from the requested rows/columns')
  const sourceHashes = {}
  for (const sourcePath of [markdownPath, referencePath]) {
    sourceHashes[sourcePath] = createHash('sha256').update(await readFile(sourcePath)).digest('hex')
  }
  receipt.fixture = { tableDataRows: tableRows.length, codeBlockLines: codeLines.length, wideTableColumns: wideTableHeaders.length, footnoteSyntaxPresent: true, sourceHashes }
  record('production fixture includes the requested long table and code block', receipt.fixture)
  return { markdownPath, referencePath, imagePath, markdown, tableRows: tableRows.length, codeLines: codeLines.length, wideTableColumns: wideTableHeaders.length, sourceHashes }
}

async function waitForEditor(page) {
  await page.waitForFunction(() => Boolean(document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia), undefined, { timeout: 30_000 })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await page.evaluate(() => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
      const editor = pinia._s.get('editor')
      const project = pinia._s.get('project')
      return {
        pending: editor.startupHydrationPending,
        tabs: editor.tabs.map(tab => tab.pathname).filter(Boolean),
        projectRoot: project.projectTree?.pathname ?? null,
      }
    })
    for (const pathname of [...state.tabs, ...(state.projectRoot ? [state.projectRoot] : [])]) {
      failIf(!isWithin(outputBase, pathname), `Refusing a restored production-test path outside output/m1-native: ${pathname}`)
    }
    const recovery = page.locator('.el-message-box')
    if (await recovery.isVisible()) {
      const dialogText = await recovery.innerText()
      failIf(!visibleTextContains(dialogText, /recover unsaved drafts|recover drafts|恢复未保存|恢复草稿|下書きを復元/i),
        `Unexpected modal while editor startup is pending: ${dialogText}`)
      await recovery.locator('.el-button--primary').click()
      await page.waitForTimeout(100)
      continue
    }
    if (!state.pending) return
    await page.waitForTimeout(100)
  }
  throw new Error('Production editor session did not finish hydration')
}

async function prepareProject(page, fixtures) {
  const state = await page.evaluate(async ({ outputBase, projectRoot, reportPath }) => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
    const stores = Object.fromEntries(['project', 'notebook', 'layout', 'editor', 'agent'].map(id => [id, pinia._s.get(id)]))
    const oldProject = stores.project.projectTree?.pathname
    const oldPaths = stores.editor.tabs.map(tab => tab.pathname).filter(Boolean)
    if (oldProject && !oldProject.replaceAll('\\', '/').toLowerCase().startsWith(outputBase.replaceAll('\\', '/').toLowerCase() + '/')) {
      throw new Error(`Refusing an existing project outside the native test output: ${oldProject}`)
    }
    const outsideTabs = oldPaths.filter(pathname => !pathname.replaceAll('\\', '/').toLowerCase().startsWith(outputBase.replaceAll('\\', '/').toLowerCase() + '/'))
    if (outsideTabs.length) throw new Error(`Refusing existing tabs outside the native test output: ${outsideTabs.join(', ')}`)
    stores.layout.showSideBar = true
    stores.layout.setNavigationPanel('files')
    stores.layout.showInspector = true
    stores.layout.setInspectorPanel('links')
    stores.layout.setLinksPinned(false)
    stores.notebook.panel = 'links'
    stores.agent.visible = false
    await stores.project.openRoot(projectRoot)
    await stores.notebook.rebuild(true)
    const tab = await stores.editor.openFile(reportPath)
    stores.editor.sourceCodeMode = false
    for (const pane of stores.editor.panes) pane.sourceMode = false
    return { oldProject, oldPaths, projectRoot: stores.project.projectTree?.pathname, file: tab.pathname }
  }, { outputBase, projectRoot, reportPath: fixtures.markdownPath })
  failIf(!state.projectRoot || !isWithin(projectRoot, state.projectRoot), `Project store did not open the production fixture root: ${state.projectRoot}`)
  failIf(!state.file || !isWithin(projectRoot, state.file), `Editor opened a source outside the production fixture: ${state.file}`)
  await expect(page.locator('#editor-sidebar .tree-pane')).toBeVisible()
  await expect(page.locator('.document-inspector')).toBeVisible()
  await expect(page.locator('.document-inspector .notebook-panel')).toBeVisible()
  await expect(page.locator('#editor-sidebar')).toContainText('Report.md')
  await expect.poll(() => page.evaluate(() => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
    const notebook = pinia._s.get('notebook')
    return { notes: notebook.notes.length, analyses: notebook.analyses.length, backlinks: notebook.backlinks.length, target: notebook.relationTargetRelative }
  }), { timeout: 30_000 }).toEqual({ notes: 2, analyses: 2, backlinks: 1, target: 'Report.md' })
  await expect(page.locator('.document-inspector .relation-row')).toHaveCount(1)
  record('production project scan, relation worker, file tree and right inspector', state)
  return state
}

async function verifyWritingCommandDoesNotSend(page) {
  const result = await page.evaluate(() => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
    const agent = pinia._s.get('agent')
    agent.conversation.draft = ''
    const beforeMessages = agent.conversation.messages.length
    const beforeBusy = agent.busy
    agent.queueWritingCommand('polish')
    const after = {
      draft: agent.conversation.draft,
      messages: agent.conversation.messages.length,
      busy: agent.busy,
      visible: agent.visible,
    }
    agent.visible = false
    agent.conversation.draft = ''
    return { beforeMessages, beforeBusy, ...after }
  })
  failIf(!result.draft.trim(), 'queueWritingCommand did not fill the Agent draft')
  failIf(result.messages !== result.beforeMessages || result.busy || result.beforeBusy, 'queueWritingCommand sent a request instead of only filling the draft')
  failIf(!result.visible, 'queueWritingCommand did not open the Agent panel')
  record('queueWritingCommand fills a draft without sending a message', { draftLength: result.draft.length, messageCount: result.messages })
}

async function saveAndReloadProjectConfig(page) {
  const result = await page.evaluate(async ({ root, profile }) => {
    const invoke = window.__TAURI_INTERNALS__.invoke
    const initial = await invoke('cmd_export_load_config', { root })
    if (initial.config !== null || initial.fingerprint !== null) throw new Error('Unique production fixture already has an export config')
    const config = { schemaVersion: 1, defaultProfile: profile.id, profiles: [profile] }
    const saved = await invoke('cmd_export_save_config', { root, config, expectedFingerprint: initial.fingerprint })
    if (!saved.fingerprint || saved.config?.defaultProfile !== profile.id) throw new Error('Rust export config save returned unexpected content')
    const loaded = await invoke('cmd_export_load_config', { root })
    if (loaded.fingerprint !== saved.fingerprint || loaded.config?.profiles?.[0]?.theme !== profile.theme) throw new Error('Rust export config reload differs from the saved config')
    return { initial, savedFingerprint: saved.fingerprint, loadedProfile: loaded.config.profiles[0] }
  }, { root: projectRoot, profile })
  record('production Rust IPC saves and reloads the versioned project export config', result)
}

async function openUnifiedExportDialog(page) {
  const opened = await page.evaluate(async () => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
    return pinia._s.get('commandCenter').execute('file.exportHtml')
  })
  failIf(!opened, 'CommandCenter could not execute file.exportHtml')
  const dialog = page.locator('.export-dialog')
  await expect(dialog).toBeVisible({ timeout: 15_000 })
  await dialog.locator('.el-dialog__footer .el-button').nth(1).click()
  await expect(dialog.locator('iframe.preview-frame')).toBeVisible({ timeout: 60_000 })
  const frame = page.frameLocator('.export-dialog iframe.preview-frame')
  await expect(frame.locator('.markdown-body')).toContainText('生产协议导出验收', { timeout: 30_000 })
  await expect(frame.locator('.katex')).toHaveCount(1)
  await expect(frame.locator('.katex-mathml math')).toHaveCount(1)
  await expect(frame.locator('a.footnote-ref[href^="#fn"]')).toHaveCount(1)
  await expect(frame.locator('nav.export-toc')).toHaveCount(1)
  await expect(dialog).toContainText('A wide table needs final layout review.')
  await expect(frame.locator('.mermaid svg')).toHaveCount(1, { timeout: 30_000 })
  await expect(frame.locator('img[src^="data:image/svg+xml;base64,"]')).toHaveCount(1)

  const iframe = page.locator('.export-dialog iframe.preview-frame')
  const html = await iframe.getAttribute('srcdoc')
  failIf(!html, 'Export preview iframe has no srcdoc HTML')
  await writeFile(path.join(projectRoot, 'portable-preview.html'), html, 'utf8')
  failIf(!html.includes('data-export-svg="data:image/svg+xml;base64,'), 'Production preview is missing its portable SVG snapshot')
  failIf(html.includes('/node_modules/'), 'Production preview contains a /node_modules reference')
  failIf(/url\(\s*["']?(?:\/?assets\/|\.?\/assets\/)[^)]*\.(?:woff2?|ttf|otf)/i.test(html), 'Production preview contains an external /assets font reference')
  failIf(!html.includes('data:image/svg+xml;base64,'), 'Production preview did not embed its authorized local image')
  failIf(!html.includes('class="katex"') || !html.includes('<svg'), 'Production preview did not retain static KaTeX and Mermaid markup')
  failIf(hasExternalFontReferences(html), 'Production preview contains a non-embedded font URL')
  failIf(/<script(?:\s|>)/i.test(html), 'Production preview contains executable script instead of static output')
  record('production export UI preview contains CJK, embedded image, KaTeX and static Mermaid without dev/font asset paths', {
    htmlBytes: Buffer.byteLength(html, 'utf8'),
    katex: true,
    mermaidSvg: true,
    embeddedImage: true,
    noNodeModules: true,
    noExternalFontAssets: true,
  })
  await page.screenshot({ path: path.join(projectRoot, 'production-export-preview.png') })
  await dialog.locator('.el-dialog__footer .el-button').first().click()
  await expect(dialog).toBeHidden()
  return html
}

async function writeHtmlWithRust(page, fixtures, renderedHtml) {
  const outputPath = requireSafeOutput(path.join(exportRoot, 'production-report.html'), 'Production HTML output')
  const result = await page.evaluate(async ({ root, outputPath, profile, renderedHtml, expectedMarkdownPath }) => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
    const editor = pinia._s.get('editor')
    const tab = editor.currentFile
    if (!tab || tab.pathname.replaceAll('\\', '/').toLowerCase() !== expectedMarkdownPath.replaceAll('\\', '/').toLowerCase()) {
      throw new Error(`Export target is not the opened production document: ${tab?.pathname}`)
    }
    const request = {
      taskId: crypto.randomUUID(),
      projectRoot: root,
      snapshot: {
        markdown: tab.markdown,
        sourcePath: tab.pathname,
        fileName: tab.filename,
        capturedAt: new Date().toISOString(),
        revision: crypto.randomUUID(),
      },
      profileId: profile.id,
      configSource: 'project',
      format: 'html',
      options: profile,
      outputPath,
      renderedHtml,
    }
    const invoke = window.__TAURI_INTERNALS__.invoke
    const preflight = await invoke('cmd_export_preflight', { request })
    if (preflight.blocking.length) throw new Error(`Production HTML preflight blocked: ${JSON.stringify(preflight.blocking)}`)
    const saved = await invoke('cmd_export_start', { request })
    return { saved, preflight, taskId: request.taskId, sourcePath: tab.pathname, sourceBytes: new TextEncoder().encode(tab.markdown).byteLength }
  }, { root: projectRoot, outputPath, profile, renderedHtml, expectedMarkdownPath: fixtures.markdownPath })

  failIf(result.saved.status !== 'completed', `cmd_export_start did not complete: ${JSON.stringify(result.saved)}`)
  failIf(normalPath(result.saved.outputPath) !== normalPath(outputPath), `cmd_export_start returned a different output path: ${result.saved.outputPath}`)
  const output = await readFile(outputPath, 'utf8')
  failIf(!output.includes('生产协议导出验收') || !output.includes('data:image/svg+xml;base64,'), 'Rust-written production HTML is missing CJK content or its embedded image')
  failIf(!output.includes('TABLE-END-ROW-080') || !output.includes('WIDE-END-12COL') || !output.includes('row200'), 'Rust-written production HTML is missing a long-table tail or the 200-line code block')
  failIf(!output.includes('class="katex"') || !output.includes('<svg') || output.includes('/node_modules/'), 'Rust-written HTML lost static rendering or contains a dev dependency path')
  failIf(/url\(\s*["']?(?:\/?assets\/|\.?\/assets\/)[^)]*\.(?:woff2?|ttf|otf)/i.test(output), 'Rust-written HTML contains an external font asset path')
  failIf(hasExternalFontReferences(output), 'Rust-written HTML contains a non-embedded font URL')
  failIf(/<script(?:\s|>)/i.test(output), 'Rust-written HTML contains executable script instead of static output')
  receipt.output = { ...result, outputPath, bytes: Buffer.byteLength(output, 'utf8'), sha256: createHash('sha256').update(output).digest('hex') }
  record('production cmd_export_start writes static HTML inside the configured project output directory', receipt.output)
}

function readZipMembers(bytes) {
  const minimumOffset = Math.max(0, bytes.length - 65_557)
  let endRecord = -1
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { endRecord = offset; break }
  }
  failIf(endRecord < 0, 'Pandoc output has no ZIP end record')
  const entryCount = bytes.readUInt16LE(endRecord + 10)
  let offset = bytes.readUInt32LE(endRecord + 16)
  const members = []
  for (let index = 0; index < entryCount; index += 1) {
    failIf(offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50, 'Pandoc output has a malformed ZIP central directory')
    const method = bytes.readUInt16LE(offset + 10)
    const compressedSize = bytes.readUInt32LE(offset + 20)
    const uncompressedSize = bytes.readUInt32LE(offset + 24)
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    const localOffset = bytes.readUInt32LE(offset + 42)
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength)
    failIf(localOffset + 30 > bytes.length || bytes.readUInt32LE(localOffset) !== 0x04034b50, `ZIP entry has an invalid local header: ${name}`)
    const localNameLength = bytes.readUInt16LE(localOffset + 26)
    const localExtraLength = bytes.readUInt16LE(localOffset + 28)
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize)
    let content
    if (method === 0) content = Buffer.from(compressed)
    else if (method === 8) content = inflateRawSync(compressed)
    else throw new Error(`Unsupported ZIP compression method ${method} in ${name}`)
    failIf(uncompressedSize !== 0xffffffff && content.length !== uncompressedSize, `ZIP entry size mismatch: ${name}`)
    members.push({ name, content })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return members
}

function inspectPandocArchive(format, bytes) {
  failIf(bytes.subarray(0, 4).toString('ascii') !== 'PK\u0003\u0004', `${format.toUpperCase()} output is not a ZIP container`)
  const members = readZipMembers(bytes)
  const names = members.map(member => member.name)
  const required = format === 'docx'
    ? ['word/document.xml', 'word/styles.xml']
    : format === 'odt'
      ? ['mimetype', 'content.xml', 'META-INF/manifest.xml']
      : ['mimetype', 'META-INF/container.xml']
  for (const entry of required) failIf(!names.includes(entry), `${format.toUpperCase()} archive lacks ${entry}`)
  if (format === 'epub') {
    failIf(!members.some(member => /^(?:OEBPS|EPUB)\/.*\.xhtml$/i.test(member.name)), 'EPUB archive lacks an XHTML content document')
  }

  const xmlMembers = members.filter(member => /\.(?:xml|xhtml|opf)$/i.test(member.name))
  const xml = xmlMembers.map(member => member.content.toString('utf8')).join('\n')
  const hasFinalTableRow = xml.includes('TABLE-END-ROW-080')
  const hasWideTableTail = xml.includes('WIDE-END-12COL')
  const hasFinalCodeLine = xml.includes('row200')
  const hasMathMl = /<(?:[\w.-]+:)?math(?:\s|:|>)/i.test(xml)
  const hasOmml = /<m:oMath(?:\s|>)/i.test(xml)
  failIf(!hasFinalTableRow || !hasWideTableTail || !hasFinalCodeLine, `${format.toUpperCase()} XML lost a long-table tail or row200`)
  failIf(!hasMathMl && !hasOmml, `${format.toUpperCase()} XML has neither MathML nor OMML`)
  return {
    entries: names,
    contentXml: xmlMembers.filter(member => /document\.xml|content\.xml|\.xhtml$/i.test(member.name)).map(member => member.name),
    tableEndRow: hasFinalTableRow,
    wideTableTail: hasWideTableTail,
    codeEndLine: hasFinalCodeLine,
    mathMl: hasMathMl,
    omml: hasOmml,
  }
}

async function writePandocFormats(page, fixtures, renderedHtml) {
  const results = []
  for (const format of ['docx', 'odt', 'epub']) {
    const outputPath = requireSafeOutput(path.join(exportRoot, `production-report.${format}`), `${format.toUpperCase()} output`)
    const result = await page.evaluate(async ({ root, outputPath, profile, renderedHtml, expectedMarkdownPath, format }) => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
      const tab = pinia._s.get('editor').currentFile
      if (!tab || tab.pathname.replaceAll('\\', '/').toLowerCase() !== expectedMarkdownPath.replaceAll('\\', '/').toLowerCase()) {
        throw new Error(`${format.toUpperCase()} target is not the opened production document: ${tab?.pathname}`)
      }
      const request = {
        taskId: crypto.randomUUID(),
        projectRoot: root,
        snapshot: { markdown: tab.markdown, sourcePath: tab.pathname, fileName: tab.filename, capturedAt: new Date().toISOString(), revision: crypto.randomUUID() },
        profileId: profile.id,
        configSource: 'project',
        format,
        options: profile,
        outputPath,
        renderedHtml,
      }
      const invoke = window.__TAURI_INTERNALS__.invoke
      const preflight = await invoke('cmd_export_preflight', { request })
      if (preflight.blocking.length) throw new Error(`${format.toUpperCase()} preflight blocked: ${JSON.stringify(preflight.blocking)}`)
      if (!preflight.dependencies?.pandocAvailable) throw new Error('Pandoc is unavailable in the production app process PATH')
      const saved = await invoke('cmd_export_start', { request })
      return {
        saved,
        taskId: request.taskId,
        format,
        sourcePath: tab.pathname,
        sourceBytes: new TextEncoder().encode(tab.markdown).byteLength,
        renderedHtmlBytes: new TextEncoder().encode(renderedHtml).byteLength,
        pandocAvailable: preflight.dependencies.pandocAvailable,
      }
    }, { root: projectRoot, outputPath, profile, renderedHtml, expectedMarkdownPath: fixtures.markdownPath, format })
    failIf(result.saved.status !== 'completed', `${format.toUpperCase()} cmd_export_start did not complete: ${JSON.stringify(result.saved)}`)
    failIf(normalPath(result.saved.outputPath) !== normalPath(outputPath), `${format.toUpperCase()} command returned a different output path`)
    const bytes = await readFile(outputPath)
    failIf(bytes.length < 512, `${format.toUpperCase()} output is unexpectedly small: ${bytes.length} bytes`)
    const archive = inspectPandocArchive(format, bytes)
    results.push({ ...result, outputPath, bytes: bytes.length, magic: bytes.subarray(0, 4).toString('latin1'), ...archive })
  }
  receipt.formats = results
  record('production DOCX/ODT/EPUB Rust/Pandoc outputs contain both table tails, row200 and MathML/OMML', results.map(result => ({
    format: result.format,
    outputPath: result.outputPath,
    bytes: result.bytes,
    contentXml: result.contentXml,
    tableEndRow: result.tableEndRow,
    wideTableTail: result.wideTableTail,
    codeEndLine: result.codeEndLine,
    mathMl: result.mathMl,
    omml: result.omml,
  })))
}

async function verifySourceFilesUnchanged(fixtures) {
  const finalHashes = {}
  for (const sourcePath of [fixtures.markdownPath, fixtures.referencePath]) {
    finalHashes[sourcePath] = createHash('sha256').update(await readFile(sourcePath)).digest('hex')
    failIf(finalHashes[sourcePath] !== fixtures.sourceHashes[sourcePath], `Export changed the project source file: ${sourcePath}`)
  }
  receipt.sourceIntegrity = { unchanged: true, before: fixtures.sourceHashes, after: finalHashes }
  record('HTML/Pandoc exports left the opened Markdown sources byte-for-byte unchanged', receipt.sourceIntegrity)
}

async function writePdfWithRust(page, fixtures, renderedHtml) {
  const outputPath = requireSafeOutput(path.join(exportRoot, 'production-report.pdf'), 'Production PDF output')
  const result = await page.evaluate(async ({ root, outputPath, profile, renderedHtml, expectedMarkdownPath }) => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
    const tab = pinia._s.get('editor').currentFile
    if (!tab || tab.pathname.replaceAll('\\', '/').toLowerCase() !== expectedMarkdownPath.replaceAll('\\', '/').toLowerCase()) {
      throw new Error(`PDF export target is not the opened production document: ${tab?.pathname}`)
    }
    const request = {
      taskId: crypto.randomUUID(),
      projectRoot: root,
      snapshot: {
        markdown: tab.markdown,
        sourcePath: tab.pathname,
        fileName: tab.filename,
        capturedAt: new Date().toISOString(),
        revision: crypto.randomUUID(),
      },
      profileId: profile.id,
      configSource: 'project',
      format: 'pdf',
      pdfBackend: 'pandoc',
      options: profile,
      outputPath,
      renderedHtml,
    }
    const invoke = window.__TAURI_INTERNALS__.invoke
    const preflight = await invoke('cmd_export_preflight', { request })
    if (preflight.blocking.length) throw new Error(`Production PDF preflight blocked: ${JSON.stringify(preflight.blocking)}`)
    if (!preflight.dependencies?.pandocAvailable) throw new Error('Pandoc is unavailable in the production app process PATH')
    if (!preflight.dependencies?.pdfEngine) throw new Error('No supported PDF engine is available in the production app process PATH')
    const saved = await invoke('cmd_export_start', { request })
    return {
      saved,
      taskId: request.taskId,
      sourcePath: tab.pathname,
      sourceBytes: new TextEncoder().encode(tab.markdown).byteLength,
      pandocAvailable: preflight.dependencies.pandocAvailable,
      pdfEngine: preflight.dependencies.pdfEngine,
    }
  }, { root: projectRoot, outputPath, profile, renderedHtml, expectedMarkdownPath: fixtures.markdownPath })

  failIf(result.saved.status !== 'completed', `PDF cmd_export_start did not complete: ${JSON.stringify(result.saved)}`)
  failIf(normalPath(result.saved.outputPath) !== normalPath(outputPath), `cmd_export_start returned a different PDF path: ${result.saved.outputPath}`)
  const bytes = await readFile(outputPath)
  failIf(bytes.subarray(0, 5).toString('ascii') !== '%PDF-', 'Pandoc output does not start with the PDF signature')
  failIf(bytes.length < 1024, `Pandoc PDF output is unexpectedly small: ${bytes.length} bytes`)
  receipt.pdf = {
    path: outputPath,
    bytes: bytes.length,
    magic: bytes.subarray(0, 8).toString('ascii'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    taskId: result.taskId,
    sourcePath: result.sourcePath,
    sourceBytes: result.sourceBytes,
    pandocAvailable: result.pandocAvailable,
    pdfEngine: result.pdfEngine,
    renderedHtmlBytes: Buffer.byteLength(renderedHtml, 'utf8'),
  }
  record('production cmd_export_start writes a Pandoc PDF from the same static preview HTML', receipt.pdf)
}

async function main() {
  const workspaceOutput = path.resolve('output')
  failIf(!isWithin(workspaceOutput, outputBase) || normalPath(workspaceOutput) === normalPath(outputBase),
    'Production output must be a dedicated folder within workspace output/')
  const lstatBase = await lstat(outputBase).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error))
  failIf(lstatBase?.isSymbolicLink(), `Refusing symbolic-link output root ${outputBase}`)
  if (!lstatBase) await mkdir(outputBase, { recursive: false })
  failIf(lstatBase && !lstatBase.isDirectory(), `Production output root is not a directory: ${outputBase}`)
  failIf(normalPath(await realpath(outputBase)) !== normalPath(outputBase), `Production output root resolves through an alias: ${outputBase}`)
  outputBaseVerified = true
  const fixtures = await createProjectFiles()

  browser = await chromium.connectOverCDP(cdpUrl, { timeout: 10_000 })
  page = await getPage(browser)
  await waitForEditor(page)
  const previousDialog = page.locator('.export-dialog')
  if (await previousDialog.isVisible()) await previousDialog.locator('.el-dialog__footer .el-button').first().click()
  originalFootnote = await page.evaluate(() => {
    const preferences = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('preferences')
    const previous = preferences.footnote
    // The app identity and profile roots were verified above. This is an in-memory
    // fixture option, restored in finally without calling preference persistence.
    preferences.footnote = true
    return previous
  })
  const stores = await prepareProject(page, fixtures)
  await saveAndReloadProjectConfig(page)
  await verifyWritingCommandDoesNotSend(page)
  // queueWritingCommand opens Agent. Restore the file-tree/links view for the export workflow.
  await page.evaluate(() => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
    const layout = pinia._s.get('layout')
    const agent = pinia._s.get('agent')
    agent.visible = false
    layout.showInspector = true
    layout.setInspectorPanel('links')
  })
  const renderedHtml = await openUnifiedExportDialog(page)
  await writeHtmlWithRust(page, fixtures, renderedHtml)
  await writePandocFormats(page, fixtures, renderedHtml)
  await writePdfWithRust(page, fixtures, renderedHtml)
  await verifySourceFilesUnchanged(fixtures)
  if (receipt.pageErrors.length) throw new Error(`Production renderer page errors: ${receipt.pageErrors.join('; ')}`)
  receipt.success = true
  receipt.stores = stores
}

let browser
let page
let originalFootnote

try {
  await main()
} catch (error) {
  receipt.success = false
  receipt.error = String(error?.stack ?? error)
  process.stderr.write(`${receipt.error}\n`)
  process.exitCode = 1
} finally {
  if (page && originalFootnote !== undefined) {
    try { await page.evaluate(value => { document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('preferences').footnote = value }, originalFootnote) }
    catch (error) { receipt.preferenceRestoreError = String(error?.message ?? error); receipt.success = false; process.exitCode = 1 }
  }
  if (page && outputBaseVerified && productionRootVerified) {
    try { await page.screenshot({ path: screenshotPath, fullPage: false }) }
    catch (error) { receipt.screenshotError = String(error?.message ?? error) }
  }
  receipt.finishedAt = new Date().toISOString()
  if (outputBaseVerified && productionRootVerified) {
    try { await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8') }
    catch (error) { process.stderr.write(`Failed to write production receipt: ${String(error?.message ?? error)}\n`); process.exitCode = 1 }
  } else {
    process.stderr.write(`Production receipt was not written because ${outputBase} failed its root check.\n`)
  }
  await browser?.close()
  process.stdout.write(`${JSON.stringify({ success: receipt.success, projectRoot, receiptPath, checks: receipt.checks.map(item => item.name) }, null, 2)}\n`)
}
