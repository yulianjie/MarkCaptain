#!/usr/bin/env node
// Native M1 smoke. Connects to an already-running isolated Tauri WebView2;
// it never launches, closes, or installs the app. All test files stay in output/m1-native.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium, expect } from '@playwright/test'

const repositoryRoot = path.resolve('.')
const outputParent = path.join(repositoryRoot, 'output')
let outputRoot = path.join(outputParent, 'm1-native')
let outputRootVerified = false
const cdpUrl = process.env.M1_CDP_URL || 'http://127.0.0.1:9335'
const expectedIdentifier = process.env.M1_APP_IDENTIFIER || 'io.github.yulianjie.markcaptain.m1-validation'
const runId = new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', 'Z')
const workspaceRoot = path.join(outputRoot, `workspace-${runId}`)
const exportRoot = path.join(workspaceRoot, 'exports')
const receiptPath = path.join(outputRoot, 'receipt.json')
const screenshotPath = path.join(outputRoot, 'm1-native-smoke.png')
const sourceFiles = [
  'src/stores/layout.ts',
  'src/stores/project.ts',
  'src/stores/notebook.ts',
  'src/stores/editor.ts',
  'src/stores/agent.ts',
  'src/services/tauri-invoke.ts',
  'src/services/export/types.ts',
  'src/services/export/request.ts',
  'src/services/export/config.ts',
  'src/services/export/resources.ts',
  'src/services/export/workflow.ts',
  'src/services/export/profiles.ts',
  'src/pages/EditorPage.vue',
  'src/components/documentInspector/DocumentInspector.vue',
  'src/components/notebook/NotebookPanel.vue',
  'src/components/exportSettings/ExportSettingsDialog.vue',
  'src-tauri/src/commands/export_project.rs',
  'src-tauri/src/commands/agent/protocol.rs',
]

const receipt = {
  schemaVersion: 1,
  native: true,
  backendMocked: false,
  modelFixture: true,
  success: false,
  cdpUrl,
  expectedIdentifier,
  outputRoot,
  screenshotPath,
  workspaceRoot,
  exportRoot,
  checks: [],
  pageErrors: [],
  sourceRecognition: { modules: [], files: {} },
  export: { resources: [], writes: [], cancellation: null },
  agent: { requests: 0, calls: [], continuedReviewState: null },
}

function check(name, details = undefined) {
  receipt.checks.push(details === undefined ? { name } : { name, details })
  process.stdout.write(`${name}\n`)
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

function assertPathNormalizationSelfChecks() {
  if (process.platform !== 'win32') return
  const cases = [
    ['C:\\M1\\workspace', '\\\\?\\C:\\M1\\workspace\\assets\\diagram.svg', true, 'local verbatim path'],
    ['\\\\server\\share\\M1', '\\\\?\\UNC\\server\\share\\M1\\assets\\diagram.svg', true, 'UNC verbatim path'],
    ['C:\\M1\\workspace', '\\\\?\\C:\\M1\\workspace\\..\\outside.svg', false, 'local parent traversal'],
    ['\\\\server\\share\\M1', '\\\\?\\UNC\\server\\share\\outside.svg', false, 'UNC sibling path'],
  ]
  for (const [root, candidate, expected, label] of cases) {
    failIf(isWithin(root, candidate) !== expected, `Windows path normalization self-check failed: ${label}`)
  }
}

assertPathNormalizationSelfChecks()
if (process.argv.includes('--check-paths-only')) {
  process.stdout.write('Windows path normalization and containment checks passed.\n')
  process.exit(0)
}

function assertWithin(root, candidate, description) {
  failIf(!path.isAbsolute(candidate) || !isWithin(root, candidate), `${description} escaped the M1 output root: ${candidate}`)
}

async function canonicalProspectivePath(candidate) {
  let current = path.resolve(candidate)
  const suffix = []
  while (true) {
    try {
      return path.join(await realpath(current), ...suffix.reverse())
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      suffix.unshift(path.basename(current))
      current = parent
    }
  }
}

async function assertExpectedRoot(envName, actual, description) {
  const expected = process.env[envName]
  const canonical = await canonicalProspectivePath(actual)
  if (expected) {
    const expectedCanonical = await canonicalProspectivePath(expected)
    failIf(normalPath(expected) !== normalPath(expectedCanonical), `${envName} must be a canonical path without symlink aliases: ${expected}`)
    failIf(normalPath(expectedCanonical) !== normalPath(canonical), `${description} does not match ${envName}: ${canonical}`)
    failIf(path.basename(canonical).toLocaleLowerCase() !== expectedIdentifier.toLocaleLowerCase(),
      `${description} must end in the isolated application identifier ${expectedIdentifier}: ${canonical}`)
  } else {
    failIf(normalPath(actual) !== normalPath(canonical), `${description} resolves through a symbolic link: ${actual} -> ${canonical}`)
    assertWithin(outputRoot, canonical, description)
  }
  return canonical
}

function assertOutput(pathname, description) {
  const absolute = path.resolve(pathname)
  assertWithin(outputRoot, absolute, description)
  return absolute
}

async function captureSourceFingerprint() {
  for (const relative of sourceFiles) {
    const absolute = path.join(repositoryRoot, relative)
    try {
      const source = await readFile(absolute)
      receipt.sourceRecognition.files[relative] = createHash('sha256').update(source).digest('hex')
    } catch (error) {
      receipt.sourceRecognition.files[relative] = { unavailable: String(error?.message ?? error) }
    }
  }
}

async function ensureNativePage(browser) {
  const pages = browser.contexts().flatMap(context => context.pages())
  const nativePages = []
  for (const candidate of pages) {
    const isNative = await candidate.evaluate(() => Boolean(window.__TAURI_INTERNALS__?.invoke)).catch(() => false)
    if (isNative) nativePages.push(candidate)
  }
  failIf(nativePages.length !== 1, `Expected one Tauri WebView page on ${cdpUrl}; found ${nativePages.length}`)
  const page = nativePages[0]
  receipt.url = page.url()
  receipt.userAgent = await page.evaluate(() => navigator.userAgent)
  page.on('pageerror', error => receipt.pageErrors.push(error.message))
  await page.waitForFunction(() => Boolean(document.getElementById('app')?.__vue_app__?.config.globalProperties.$pinia), undefined, { timeout: 30_000 })

  const identity = await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__?.invoke
    if (typeof invoke !== 'function') throw new Error('Tauri invoke bridge is unavailable')
    const [identifier, name, version, configDir, dataDir, localDataDir] = await Promise.all([
      invoke('plugin:app|identifier'),
      invoke('plugin:app|name'),
      invoke('plugin:app|version'),
      invoke('plugin:path|resolve_directory', { directory: 13 }), // BaseDirectory.AppConfig
      invoke('plugin:path|resolve_directory', { directory: 14 }), // BaseDirectory.AppData
      invoke('plugin:path|resolve_directory', { directory: 15 }), // BaseDirectory.AppLocalData
    ])
    return { identifier, name, version, configDir, dataDir, localDataDir }
  })
  receipt.app = identity
  failIf(identity.identifier !== expectedIdentifier, `Refusing non-validation app identifier: ${identity.identifier}`)
  failIf(identity.identifier === 'io.github.yulianjie.markcaptain', 'Refusing the installed MarkCaptain app identifier')
  identity.configDirCanonical = await assertExpectedRoot('M1_APP_CONFIG_ROOT', identity.configDir, 'Tauri app config directory')
  identity.dataDirCanonical = await assertExpectedRoot('M1_APP_DATA_ROOT', identity.dataDir, 'Tauri app data directory')
  identity.localDataDirCanonical = await assertExpectedRoot('M1_APP_LOCAL_DATA_ROOT', identity.localDataDir, 'Tauri app local data directory')
  check('isolated Tauri identity and config/data roots', identity)

  // These imports prove the inspected page is serving the actual M1 source modules.
  const modules = await page.evaluate(async () => {
    const entries = [
      ['/src/stores/layout.ts', 'useLayoutStore'],
      ['/src/stores/project.ts', 'useProjectStore'],
      ['/src/stores/notebook.ts', 'useNotebookStore'],
      ['/src/stores/editor.ts', 'useEditorStore'],
      ['/src/stores/agent.ts', 'useAgentStore'],
      ['/src/services/tauri-invoke.ts', 'exportLoadConfig'],
      ['/src/services/tauri-invoke.ts', 'exportSaveDialog'],
      ['/src/services/export/types.ts', null],
      ['/src/services/export/config.ts', 'loadProjectExportConfig'],
      ['/src/services/export/workflow.ts', 'renderExportPreview'],
      ['/src/services/export/profiles.ts', 'BUILTIN_PROFILES'],
    ]
    const loaded = []
    for (const [url, exportName] of entries) {
      const module = await import(url)
      if (exportName && !(exportName in module)) throw new Error(`${url} does not export ${exportName}`)
      loaded.push({ url, exports: Object.keys(module).sort() })
    }
    return loaded
  })
  receipt.sourceRecognition.modules = modules
  check('M1 store, IPC, export contract and workflow source imports', modules.map(item => item.url))
  return page
}

async function makeFixtures() {
  assertOutput(workspaceRoot, 'M1 workspace')
  assertOutput(exportRoot, 'M1 export directory')
  await mkdir(workspaceRoot, { recursive: false })
  await mkdir(path.join(workspaceRoot, 'assets'), { recursive: false })
  await mkdir(exportRoot, { recursive: false })
  const target = path.join(workspaceRoot, 'Target.md')
  const sourceA = path.join(workspaceRoot, 'source-a.md')
  const sourceB = path.join(workspaceRoot, 'source-b.md')
  const agentDoc = path.join(workspaceRoot, 'agent.md')
  const asset = path.join(workspaceRoot, 'assets', 'diagram.svg')
  const outsideResource = path.join(outputRoot, `outside-resource-${runId}.svg`)
  assertOutput(target, 'Target fixture')
  assertOutput(sourceA, 'Source fixture A')
  assertOutput(sourceB, 'Source fixture B')
  assertOutput(agentDoc, 'Agent fixture')
  assertOutput(asset, 'Image fixture')
  assertOutput(outsideResource, 'Outside-scope resource fixture')

  await writeFile(target, [
    '# M1 native export target',
    '',
    '## Overview',
    '',
    'Local export fixture with a relative image.',
    '',
    '![Local M1 diagram](assets/diagram.svg)',
    '',
  ].join('\n'), { encoding: 'utf8', flag: 'wx' })
  await writeFile(sourceA, '# Source A\n\n[[Target#Overview|First reference]]\n\n[[Target#Overview|Second reference]]\n', { encoding: 'utf8', flag: 'wx' })
  await writeFile(sourceB, '# Source B\n\n[Target overview](Target.md#Overview)\n', { encoding: 'utf8', flag: 'wx' })
  await writeFile(agentDoc, '# M1 agent review\n\nNative agent original\n', { encoding: 'utf8', flag: 'wx' })
  await writeFile(asset, '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="#075a9c"/></svg>\n', { encoding: 'utf8', flag: 'wx' })
  await writeFile(outsideResource, '<svg xmlns="http://www.w3.org/2000/svg"/>\n', { encoding: 'utf8', flag: 'wx' })
  return { target, sourceA, sourceB, agentDoc, asset, outsideResource }
}

async function prepareWorkspace(page, fixtures) {
  const ready = await page.evaluate(async ({ root, output }) => {
    const editorModule = await import('/src/stores/editor.ts')
    const projectModule = await import('/src/stores/project.ts')
    const notebookModule = await import('/src/stores/notebook.ts')
    const layoutModule = await import('/src/stores/layout.ts')
    const agentModule = await import('/src/stores/agent.ts')
    const localeModule = await import('/src/i18n/index.ts')
    const editor = editorModule.useEditorStore()
    const project = projectModule.useProjectStore()
    const notebook = notebookModule.useNotebookStore()
    const layout = layoutModule.useLayoutStore()
    const agent = agentModule.useAgentStore()

    if (editor.startupHydrationPending) throw new Error('Editor session hydration is still pending')
    const outsideTabs = editor.tabs.filter(tab => tab.pathname && !tab.pathname.replaceAll('\\', '/').toLowerCase().startsWith(output.replaceAll('\\', '/').toLowerCase() + '/'))
    if (outsideTabs.length) throw new Error(`Refusing to close tabs outside M1 output: ${outsideTabs.map(tab => tab.pathname).join(', ')}`)
    for (const tab of [...editor.tabs]) await editor.closeTab(tab.id, true)
    editor.panes = [{ id: 'main', documentId: null, sourceMode: false }]
    editor.activePaneId = ''
    editor.activatePane('main')

    localeModule.setLocale('en')
    layout.showSideBar = true
    layout.setNavigationPanel('files')
    layout.showInspector = true
    layout.setInspectorPanel('links')
    layout.setLinksPinned(false)
    agent.visible = false
    agent.settingsOpen = false
    notebook.panel = 'links'
    await project.openRoot(root)
    await notebook.rebuild(true)
    await editor.openFile(`${root}/Target.md`)
    editor.sourceCodeMode = false
    for (const pane of editor.panes) pane.sourceMode = false
    return {
      root: project.projectTree?.pathname,
      fileTreeOpen: layout.navigationPanel === 'files' && layout.showSideBar,
      inspectorOpen: layout.showInspector && layout.inspectorPanel === 'links',
      currentPath: editor.currentFile?.pathname,
      tabs: editor.tabs.map(tab => tab.pathname),
    }
  }, { root: workspaceRoot, output: outputRoot })

  failIf(!ready.root || !isWithin(outputRoot, ready.root), `Project store opened a root outside the M1 output: ${ready.root}`)
  failIf(ready.currentPath && !isWithin(workspaceRoot, ready.currentPath), `Editor opened a file outside the M1 workspace: ${ready.currentPath}`)
  await expect(page.locator('#editor-sidebar .tree-pane')).toBeVisible()
  await expect(page.locator('.document-inspector')).toBeVisible()
  await expect(page.locator('.document-inspector .notebook-panel')).toBeVisible()
  await expect(page.locator('#editor-sidebar')).toContainText('Target.md')
  await expect.poll(() => page.evaluate(async () => {
    const notebook = (await import('/src/stores/notebook.ts')).useNotebookStore()
    return { notes: notebook.notes.length, relations: notebook.backlinks.length, groups: notebook.backlinks.map(item => item.note.relative).sort() }
  }), { timeout: 30_000 }).toEqual({ notes: 4, relations: 3, groups: ['source-a.md', 'source-a.md', 'source-b.md'] })
  check('project tree and right inspector stay visible beside the editor', ready)
  return fixtures
}

async function verifyInspectorFlows(page, fixtures) {
  const inspector = page.locator('.document-inspector')
  const groups = inspector.locator('.notebook-panel .relation-section').first().locator('details.source-group')
  await expect(groups).toHaveCount(2)
  const groupText = await groups.allTextContents()
  failIf(!groupText.some(text => text.includes('source-a.md') && text.includes('2')) || !groupText.some(text => text.includes('source-b.md') && text.includes('1')),
    `Backlinks were not grouped by source file and count: ${JSON.stringify(groupText)}`)
  check('backlinks are grouped by source file with per-group counts', groupText.map(text => text.trim()))

  await inspector.getByRole('button', { name: 'Fix this document' }).click()
  await expect(inspector.locator('.target-name')).toContainText('Fixed document')
  await page.evaluate(async sourcePath => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    await editor.openFile(sourcePath)
  }, fixtures.sourceA)
  await expect(inspector.locator('.target-name')).toContainText('Target.md')
  await expect(inspector.locator('.target-name')).toContainText('Fixed document')
  check('link target remains pinned while the active editor document changes')
  await page.evaluate(async targetPath => { await (await import('/src/stores/editor.ts')).useEditorStore().openFile(targetPath) }, fixtures.target)

  await inspector.getByRole('button', { name: 'Pin links above the current panel' }).click()
  await expect(inspector.locator('.pinned-links')).toBeVisible()
  await expect(inspector.locator('.pinned-links .notebook-panel')).toBeVisible()
  await expect(page.locator('#editor-sidebar .tree-pane')).toBeVisible()
  check('links panel can be pinned while the file tree remains open')

  const origin = await page.evaluate(() => {
    const pinia = document.getElementById('app').__vue_app__.config.globalProperties.$pinia
    const editor = pinia._s.get('editor')
    return { paneId: editor.activePaneId, path: editor.currentFile?.pathname }
  })
  const sourceGroup = inspector.locator('.pinned-links .source-group').filter({ hasText: 'source-a.md' }).first()
  await sourceGroup.locator('summary').first().click()
  await sourceGroup.locator('.open-other').first().click()
  await expect(page.locator('.editing-region')).toHaveCount(2)
  await expect.poll(() => page.evaluate(async () => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    return editor.currentFile?.pathname
  })).toBe(fixtures.sourceA)
  await inspector.getByRole('button', { name: 'Back to previous location' }).click()
  await expect.poll(() => page.evaluate(async () => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    return { paneId: editor.activePaneId, path: editor.currentFile?.pathname }
  })).toEqual(origin)
  check('relation navigation opens in the other pane and returns to the original pane and document', origin)
}

async function verifyConfigAndResourceIPC(page, fixtures) {
  const result = await page.evaluate(async ({ root, sourcePath, outsideResource }) => {
    const api = await import('/src/services/tauri-invoke.ts')
    const { BUILTIN_PROFILES } = await import('/src/services/export/profiles.ts')
    const initial = await api.exportLoadConfig(root)
    if (initial.config !== null || initial.fingerprint !== null) throw new Error('Unique M1 fixture unexpectedly has an export config')
    const profile = JSON.parse(JSON.stringify(BUILTIN_PROFILES.technical))
    profile.id = 'm1-native-technical'
    profile.name = 'M1 Native Technical'
    profile.output.directory = 'exports'
    const config = { schemaVersion: 1, defaultProfile: profile.id, profiles: [profile] }
    const saved = await api.exportSaveConfig(root, config, initial.fingerprint)
    if (saved.config?.defaultProfile !== profile.id || !saved.fingerprint) throw new Error('Rust did not save the M1 project export config')
    let conflict = ''
    try { await api.exportSaveConfig(root, config, initial.fingerprint) }
    catch (error) { conflict = String(error) }
    if (!/export:configConflict/i.test(conflict)) throw new Error(`Stale config save was not rejected as a conflict: ${conflict || 'no error'}`)
    const loaded = await api.exportLoadConfig(root)
    if (loaded.fingerprint !== saved.fingerprint || loaded.config?.profiles[0]?.theme !== 'technical') throw new Error('Rust config reload differs from saved bytes')

    const valid = await api.exportReadResource(sourcePath, 'assets/diagram.svg', root)
    if (!valid.dataUrl.startsWith('data:image/svg+xml;base64,') || valid.mime !== 'image/svg+xml') throw new Error('Valid in-project SVG was not returned as a data URL')
    let boundaryError = ''
    try { await api.exportReadResource(sourcePath, '../' + outsideResource.split(/[\\/]/).pop(), root) }
    catch (error) { boundaryError = String(error) }
    if (!boundaryError) throw new Error('Rust accepted a resource outside the authorized project root')
    return {
      loadedFingerprint: loaded.fingerprint,
      staleSaveError: conflict,
      validResourceMime: valid.mime,
      validResourcePath: valid.sourcePath,
      outsideResourceError: boundaryError,
    }
  }, { root: workspaceRoot, sourcePath: fixtures.target, outsideResource: fixtures.outsideResource })

  assertWithin(workspaceRoot, result.validResourcePath, 'Resolved resource path')
  receipt.export.resources.push(result)
  check('real Rust export config load/save/conflict/reload and resource scope validation', result)
}

async function verifyExportUI(page) {
  await page.keyboard.press('Control+Shift+P')
  const commandInput = page.locator('.cp-input')
  await expect(commandInput).toBeVisible()
  await commandInput.fill('Export HTML')
  const command = page.locator('.cp-row').filter({ hasText: 'Export HTML' }).first()
  await expect(command).toBeVisible()
  await command.click()
  const dialog = page.locator('.export-dialog')
  await expect(dialog).toBeVisible()
  const themeField = dialog.locator('.el-form-item').filter({ hasText: 'Export theme' }).locator('.el-select').first()
  await themeField.click()
  await page.getByRole('option', { name: 'Formal report', exact: true }).click()
  const resourceField = dialog.locator('.el-form-item').filter({ hasText: 'HTML images' }).locator('.el-select').first()
  await resourceField.click()
  await page.getByRole('option', { name: 'Create assets folder', exact: true }).click()
  await dialog.getByRole('button', { name: 'Preview', exact: true }).click()
  const preview = page.frameLocator('.export-dialog iframe.preview-frame')
  await expect(preview.locator('body')).toContainText('M1 native export target')
  await expect.poll(async () => await preview.locator('img').first().getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/)
  const previewCss = (await preview.locator('style').allTextContents()).join('\n')
  failIf(!previewCss.includes('--export-accent: #253f5b'), 'UI-selected formal-report theme was not present in the rendered preview')
  const assetHint = await preview.locator('img').first().getAttribute('src')
  failIf(!assetHint?.startsWith('data:image/'), 'Preview must use authorized inline images without exposing source paths')
  check('command palette opens export UI; theme, folder mode, preview and local image are visible', { theme: 'formal-report', htmlMode: 'folder', assetHint })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toBeHidden()
}

async function exportHtml(page, fixtures, theme, mode, outputPath) {
  assertOutput(outputPath, `${theme} HTML output`)
  return page.evaluate(async ({ root, sourcePath, outputPath, theme, mode }) => {
    const { BUILTIN_PROFILES } = await import('/src/services/export/profiles.ts')
    const { renderExportPreview, runExport } = await import('/src/services/export/workflow.ts')
    const { createExportRequest } = await import('/src/services/export/request.ts')
    const profile = JSON.parse(JSON.stringify(BUILTIN_PROFILES[theme]))
    profile.id = `m1-${theme}-${mode}`
    profile.output.directory = 'exports'
    profile.resources.htmlMode = mode
    const snapshot = {
      markdown: '# M1 native export target\n\n## Overview\n\nLocal export fixture with a relative image.\n\n![Local M1 diagram](assets/diagram.svg)\n',
      sourcePath,
      fileName: 'Target.md',
      capturedAt: new Date().toISOString(),
      revision: `m1-${theme}-${mode}`,
    }
    const preview = await renderExportPreview({
      snapshot,
      profile,
      format: 'html',
      projectRoot: root,
      profileId: profile.id,
      configSource: 'this-export',
      muya: null,
      language: 'en',
    })
    if (preview.preflight.blocking.length) throw new Error(`Export preflight blocked: ${JSON.stringify(preview.preflight.blocking)}`)
    const markers = {
      'simple-reading': '--export-accent: #426b8a',
      technical: '--export-accent: #075a9c',
      'formal-report': '--export-accent: #253f5b',
    }
    if (!preview.html.includes(markers[theme])) throw new Error(`Rendered HTML is missing ${theme} CSS marker`)
    if (!preview.html.includes('data:image/svg+xml;base64,')) throw new Error(`${mode} preview failed to read the local image`)
    const request = createExportRequest({
      snapshot,
      projectRoot: root,
      profileId: profile.id,
      configSource: 'this-export',
      format: 'html',
      options: profile,
      outputPath,
      renderedHtml: preview.html,
    })
    const saved = await runExport(request)
    return {
      outputPath: saved.outputPath,
      taskId: request.taskId,
      theme,
      mode,
      warnings: preview.preflight.warnings.map(item => item.code),
      htmlBytes: new TextEncoder().encode(preview.html).byteLength,
    }
  }, { root: workspaceRoot, sourcePath: fixtures.target, outputPath, theme, mode })
}

async function verifyHtmlWrites(page, fixtures) {
  for (const theme of ['simple-reading', 'technical', 'formal-report']) {
    const output = path.join(exportRoot, `${theme}-embed.html`)
    const saved = await exportHtml(page, fixtures, theme, 'embed', output)
    assertWithin(outputRoot, saved.outputPath, 'Native HTML output')
    const html = await readFile(saved.outputPath, 'utf8')
    failIf(!html.includes('data:image/svg+xml;base64,'), `${theme} embedded HTML did not contain the local image data URL`)
    failIf(!html.includes({ 'simple-reading': '#426b8a', technical: '#075a9c', 'formal-report': '#253f5b' }[theme]), `${theme} HTML lost its selected theme CSS`)
    receipt.export.writes.push({ ...saved, outputBytes: Buffer.byteLength(html, 'utf8'), imageEmbedded: true })
  }

  const folderPath = path.join(exportRoot, 'technical-folder.html')
  const folderResult = await exportHtml(page, fixtures, 'technical', 'folder', folderPath)
  assertWithin(outputRoot, folderResult.outputPath, 'Folder-mode HTML output')
  const folderHtml = await readFile(folderResult.outputPath, 'utf8')
  const assetMatch = folderHtml.match(/src=["'](assets-[^"']+)["']/)
  failIf(!assetMatch, 'Folder-mode HTML did not reference its generated assets directory')
  const assetPath = assertOutput(path.resolve(path.dirname(folderResult.outputPath), assetMatch[1]), 'Exported HTML image asset')
  const savedAsset = await readFile(assetPath)
  const sourceAsset = await readFile(fixtures.asset)
  failIf(!savedAsset.equals(sourceAsset), 'Folder-mode exported image bytes differ from the in-project SVG')
  failIf(folderHtml.includes('data:image/svg+xml;base64,'), 'Folder-mode HTML still embeds the image instead of a relative asset')
  receipt.export.writes.push({ ...folderResult, outputBytes: Buffer.byteLength(folderHtml, 'utf8'), assetPath, assetBytes: savedAsset.byteLength })
  check('real Rust HTML files preserve all three themes and both embedded/folder image modes', receipt.export.writes)
}

function zipEntryNames(bytes) {
  const minOffset = Math.max(0, bytes.length - 65_557)
  let endRecord = -1
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) { endRecord = offset; break }
  }
  failIf(endRecord < 0, 'Pandoc output did not contain a ZIP end record')
  const count = bytes.readUInt16LE(endRecord + 10)
  let offset = bytes.readUInt32LE(endRecord + 16)
  const names = []
  for (let index = 0; index < count; index += 1) {
    failIf(offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50, 'Pandoc output has an invalid ZIP central directory')
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    names.push(bytes.toString('utf8', offset + 46, offset + 46 + nameLength))
    offset += 46 + nameLength + extraLength + commentLength
  }
  return names
}

async function exportPandocFormat(page, fixtures, format, outputPath) {
  assertOutput(outputPath, `${format.toUpperCase()} output`)
  return page.evaluate(async ({ root, sourcePath, outputPath, format }) => {
    const { BUILTIN_PROFILES } = await import('/src/services/export/profiles.ts')
    const { renderExportPreview, runExport } = await import('/src/services/export/workflow.ts')
    const { createExportRequest } = await import('/src/services/export/request.ts')
    const profile = JSON.parse(JSON.stringify(BUILTIN_PROFILES.technical))
    profile.id = `m1-native-${format}`
    profile.output.directory = 'exports'
    profile.pdf.backend = 'pandoc'
    const snapshot = {
      markdown: '# M1 跨格式原生导出\n\n中文字体、表格与代码需要在成品中保持可读。\n\n| 项目 | 结果 |\n| --- | --- |\n| 本地文档 | 已保留 |\n\n```ts\nconst greeting = "你好，MarkCaptain"\n```\n',
      sourcePath,
      fileName: 'M1 cross-format.md',
      capturedAt: new Date().toISOString(),
      revision: `m1-${format}`,
    }
    const preview = await renderExportPreview({
      snapshot,
      profile,
      format,
      projectRoot: root,
      profileId: profile.id,
      configSource: 'this-export',
      muya: null,
      language: 'en',
    })
    if (preview.preflight.blocking.length) throw new Error(`${format} preflight blocked: ${JSON.stringify(preview.preflight.blocking)}`)
    if (!preview.preflight.dependencies.pandocAvailable) throw new Error('M1 validation PATH did not expose Pandoc to the native Rust process')
    if (format === 'pdf' && !preview.preflight.dependencies.pdfEngine) throw new Error('M1 validation PATH did not expose a supported PDF engine')
    const request = createExportRequest({
      snapshot,
      projectRoot: root,
      profileId: profile.id,
      configSource: 'this-export',
      format,
      options: profile,
      outputPath,
      renderedHtml: preview.html,
    })
    const saved = await runExport(request)
    return {
      format,
      outputPath: saved.outputPath,
      taskId: request.taskId,
      htmlBytes: new TextEncoder().encode(preview.html).byteLength,
      pandocAvailable: preview.preflight.dependencies.pandocAvailable,
      pdfEngine: preview.preflight.dependencies.pdfEngine ?? null,
    }
  }, { root: workspaceRoot, sourcePath: fixtures.target, outputPath, format })
}

async function verifyPandocWrites(page, fixtures) {
  for (const format of ['docx', 'odt', 'epub', 'pdf']) {
    const outputPath = path.join(exportRoot, `technical.${format}`)
    const saved = await exportPandocFormat(page, fixtures, format, outputPath)
    assertWithin(outputRoot, saved.outputPath, `${format.toUpperCase()} output`)
    const bytes = await readFile(saved.outputPath)
    failIf(bytes.length < 256, `${format.toUpperCase()} output is unexpectedly small (${bytes.length} bytes)`)
    if (format === 'pdf') {
      failIf(bytes.subarray(0, 5).toString('ascii') !== '%PDF-', 'Pandoc PDF output does not start with the PDF signature')
      receipt.export.writes.push({ ...saved, bytes: bytes.length, magic: bytes.subarray(0, 8).toString('ascii') })
    } else {
      failIf(bytes.subarray(0, 4).toString('ascii') !== 'PK\u0003\u0004', `${format.toUpperCase()} output is not a ZIP container`)
      const entries = zipEntryNames(bytes)
      const required = format === 'docx'
        ? ['word/document.xml', 'word/styles.xml']
        : format === 'odt'
          ? ['mimetype', 'content.xml', 'META-INF/manifest.xml']
          : ['mimetype', 'META-INF/container.xml']
      for (const name of required) failIf(!entries.includes(name), `${format.toUpperCase()} ZIP lacks ${name}`)
      if (format === 'epub') failIf(!entries.some(name => /^(?:OEBPS|EPUB)\/.*\.xhtml$/i.test(name)), 'EPUB ZIP lacks its XHTML content document')
      receipt.export.writes.push({ ...saved, bytes: bytes.length, magic: 'PK\u0003\u0004', entries: entries.filter(name => required.includes(name) || /content\.xhtml$/i.test(name)) })
    }
  }
  check('real Rust and Pandoc DOCX/ODT/EPUB/PDF outputs pass container and file-signature checks', receipt.export.writes.filter(item => ['docx', 'odt', 'epub', 'pdf'].includes(item.format)))
}

async function verifyExportCancel(page, fixtures) {
  const outputPath = assertOutput(path.join(exportRoot, `cancel-${runId}.html`), 'Cancellation output')
  const largeSvgBytes = Buffer.alloc(6 * 1024 * 1024, 0x61)
  const cancelledHtml = `<html><body><img alt="cancel fixture" src="data:image/svg+xml;base64,${largeSvgBytes.toString('base64')}"></body></html>`
  const result = await page.evaluate(async ({ root, sourcePath, outputPath, html }) => {
    const api = await import('/src/services/tauri-invoke.ts')
    const { BUILTIN_PROFILES } = await import('/src/services/export/profiles.ts')
    const { createExportRequest } = await import('/src/services/export/request.ts')
    const profile = JSON.parse(JSON.stringify(BUILTIN_PROFILES.technical))
    profile.id = 'm1-native-cancel'
    profile.output.directory = 'exports'
    profile.resources.htmlMode = 'folder'
    const request = createExportRequest({
      snapshot: { markdown: '# M1 cancel fixture\n', sourcePath, fileName: 'Target.md', capturedAt: new Date().toISOString(), revision: 'cancel' },
      projectRoot: root,
      profileId: profile.id,
      configSource: 'this-export',
      format: 'html',
      options: profile,
      outputPath,
      renderedHtml: html,
    })
    const preflight = await api.exportPreflight(request)
    if (preflight.blocking.length) throw new Error(`Cancellation preflight blocked: ${JSON.stringify(preflight.blocking)}`)
    let resolveWriting
    const writing = new Promise(resolve => { resolveWriting = resolve })
    const unlisten = await api.onExportProgress(event => {
      if (event.taskId === request.taskId && event.stage === 'writing') resolveWriting(event)
    })
    const started = api.exportStart(request).then(
      value => ({ ok: true, value }),
      error => ({ ok: false, error: String(error) }),
    )
    try {
      const stage = await Promise.race([
        writing,
        new Promise(resolve => setTimeout(() => resolve(null), 15_000)),
      ])
      if (!stage) throw new Error('Native export never entered the writing stage')
      await api.exportCancel(request.taskId)
      const outcome = await started
      return { taskId: request.taskId, stage: stage.stage, outcome }
    } finally {
      await unlisten()
    }
  }, { root: workspaceRoot, sourcePath: fixtures.target, outputPath, html: cancelledHtml })

  const cancelled = !result.outcome.ok && /export:cancelled/i.test(result.outcome.error)
  const outputExists = await stat(outputPath).then(() => true, () => false)
  const siblings = await readdir(exportRoot)
  const taskAssets = siblings.filter(name => name.startsWith(`assets-${result.taskId}`))
  receipt.export.cancellation = { ...result, cancelled, outputExists, taskAssets }
  failIf(!cancelled, `Native Rust export did not return its cancellation error: ${JSON.stringify(result.outcome)}`)
  failIf(outputExists, 'Cancelled native export left a final HTML file')
  failIf(taskAssets.length, `Cancelled native export left partial asset directories: ${taskAssets.join(', ')}`)
  check('real Rust export task can be cancelled without leaving output', receipt.export.cancellation)
}

async function createLoopbackModel() {
  const requests = []
  const server = createServer(async (request, response) => {
    try {
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      requests.push(input)
      const messages = Array.isArray(input.messages) ? input.messages : []
      const continues = messages.some(message => typeof message.content === 'string' && message.content.includes('m1-native-continue-after-undo'))
      const readAnswered = messages.some(message => message.tool_call_id === 'm1-read')
      const proposalAnswered = messages.some(message => message.tool_call_id === 'm1-proposal')
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      const emit = (delta, finishReason) => response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`)
      if (continues || proposalAnswered) emit({ content: continues ? 'I received the review state after undo.' : 'The proposed change is ready for review.' }, 'stop')
      else if (readAnswered) emit({ tool_calls: [{ index: 0, id: 'm1-proposal', type: 'function', function: { name: 'propose_edit', arguments: JSON.stringify({ title: 'M1 native review', changes: [{ oldText: 'Native agent original', newText: 'Native agent revised' }] }) } }] }, 'tool_calls')
      else emit({ tool_calls: [{ index: 0, id: 'm1-read', type: 'function', function: { name: 'read_document', arguments: JSON.stringify({ full: true }) } }] }, 'tool_calls')
      response.end('data: [DONE]\n\n')
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'text/plain' })
      response.end(String(error?.message ?? error))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Loopback model server did not bind to TCP')
  return { server, requests, baseUrl: `http://127.0.0.1:${address.port}/v1` }
}

async function verifyAgentLoop(page, fixtures, model) {
  await page.evaluate(async ({ root, baseUrl, agentPath }) => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    const agent = (await import('/src/stores/agent.ts')).useAgentStore()
    const layout = (await import('/src/stores/layout.ts')).useLayoutStore()
    const tab = await editor.openFile(agentPath)
    editor.applyAgentEdit(tab.id, tab.markdown, '# M1 agent review\n\nNative agent original\n')
    await editor.saveCurrent()
    editor.sourceCodeMode = false
    for (const pane of editor.panes) pane.sourceMode = false
    layout.showInspector = true
    layout.setInspectorPanel('agent')
    await agent.saveConfig({ baseUrl, model: 'm1-native-fixture', authMode: 'none' })
    await agent.clear()
    agent.includeDocument = true
    agent.referenceDocument = false
    agent.visible = true
    agent.settingsOpen = false
  }, { root: workspaceRoot, baseUrl: model.baseUrl, agentPath: fixtures.agentDoc })

  const panel = page.locator('#agent-panel')
  await expect(panel).toBeVisible()
  const input = panel.locator('.agent-composer textarea')
  await input.fill('Read the attached document and propose a small edit.')
  await panel.locator('.agent-send-row button.agent-primary').click()
  const change = panel.locator('.agent-change').first()
  await expect(change).toBeVisible({ timeout: 30_000 })
  await expect(panel.locator('.agent-working')).toHaveCount(0)
  await change.getByRole('button', { name: /^Apply (?:edit|change)$/ }).click()

  const markdown = () => page.evaluate(async () => (await import('/src/stores/editor.ts')).useEditorStore().currentFile.markdown)
  await expect.poll(markdown).toContain('Native agent revised')
  const editor = page.locator('.editing-region.active .muya-host [contenteditable="true"]')
  await editor.click()
  await page.keyboard.press('Control+z')
  await expect.poll(markdown).toContain('Native agent original')
  await page.keyboard.press('Control+y')
  await expect.poll(markdown).toContain('Native agent revised')
  await page.keyboard.press('Control+z')
  await expect.poll(markdown).toContain('Native agent original')

  await input.fill('m1-native-continue-after-undo')
  await panel.locator('.agent-send-row button.agent-primary').click()
  await expect(panel.locator('.agent-working')).toHaveCount(0, { timeout: 30_000 })
  const followup = model.requests.find(request => request.messages?.some(message => typeof message.content === 'string' && message.content.includes('m1-native-continue-after-undo')))
  const feedback = followup?.messages?.map(message => message.content).find(content => typeof content === 'string' && content.includes('[User review feedback]\n'))
  let state = null
  if (feedback) {
    try { state = JSON.parse(feedback.split('[User review feedback]\n')[1]) }
    catch { throw new Error('Follow-up review feedback was not valid JSON') }
  }
  const calls = model.requests.flatMap(request => request.messages ?? []).flatMap(message => message.tool_calls ?? []).map(call => call.function?.name).filter(Boolean)
  failIf(!calls.includes('read_document') || !calls.includes('propose_edit'), `Loopback agent did not complete the expected read/propose tool cycle: ${calls.join(',')}`)
  failIf(!state?.changes?.some(change => change.status === 'reverted'), 'Continued chat did not receive the reverted review state after undo')
  receipt.agent = {
    requests: model.requests.length,
    calls,
    continuedReviewState: state.changes.find(change => change.status === 'reverted')?.status,
    modelBaseUrl: model.baseUrl,
    reviewApplied: true,
    undoPreserved: true,
    redoPreserved: true,
  }
  await page.screenshot({ path: path.join(outputRoot, 'm1-agent-native.png') })
  check('native Agent HTTP tool loop, UI apply, undo/redo and continued review feedback', receipt.agent)
}

let browser
let page
let model

try {
  await mkdir(outputParent, { recursive: true })
  failIf(normalPath(await realpath(outputParent)) !== normalPath(outputParent), `Refusing an output parent that resolves outside the repository: ${outputParent}`)
  const existingOutput = await lstat(outputRoot).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error))
  failIf(existingOutput?.isSymbolicLink(), `Refusing a symbolic-link M1 output root: ${outputRoot}`)
  if (!existingOutput) await mkdir(outputRoot, { recursive: false })
  failIf(existingOutput && !existingOutput.isDirectory(), `M1 output root is not a directory: ${outputRoot}`)
  failIf(normalPath(await realpath(outputRoot)) !== normalPath(outputRoot), `Refusing an output root that resolves outside its expected path: ${outputRoot}`)
  outputRootVerified = true
  await captureSourceFingerprint()
  browser = await chromium.connectOverCDP(cdpUrl, { timeout: 10_000 })
  page = await ensureNativePage(browser)
  const fixtures = await makeFixtures()
  await prepareWorkspace(page, fixtures)
  await verifyInspectorFlows(page, fixtures)
  await verifyConfigAndResourceIPC(page, fixtures)
  await verifyExportUI(page)
  await verifyHtmlWrites(page, fixtures)
  await verifyPandocWrites(page, fixtures)
  await verifyExportCancel(page, fixtures)
  model = await createLoopbackModel()
  await verifyAgentLoop(page, fixtures, model)
  if (receipt.pageErrors.length) throw new Error(`Native renderer page errors: ${receipt.pageErrors.join('; ')}`)
  receipt.success = true
} catch (error) {
  receipt.success = false
  receipt.error = String(error?.stack ?? error)
  process.stderr.write(`${receipt.error}\n`)
  process.exitCode = 1
} finally {
  if (page && outputRootVerified) {
    try { await page.screenshot({ path: screenshotPath, fullPage: false }) }
    catch (error) { receipt.screenshotError = String(error?.message ?? error) }
  }
  receipt.finishedAt = new Date().toISOString()
  if (outputRootVerified) {
    try { await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8') }
    catch (error) { process.stderr.write(`Failed to write M1 receipt ${receiptPath}: ${String(error?.message ?? error)}\n`); process.exitCode = 1 }
  } else {
    process.stderr.write(`M1 receipt was not written because ${outputRoot} failed its safe-root check.\n`)
  }
  if (model?.server) await new Promise(resolve => model.server.close(resolve))
  await browser?.close()
  process.stdout.write(`${JSON.stringify({ success: receipt.success, receiptPath, checks: receipt.checks.map(item => item.name) }, null, 2)}\n`)
}
