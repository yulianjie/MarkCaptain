import { expect, test, type Page } from '@playwright/test'

const exportTransport = `
export * from '/src/services/tauri-invoke.ts?m1-export-original';
const state = globalThis.__m1ExportState ??= { preflights: [], starts: [], dialogs: [], configs: {}, saves: [], configLoads: [], resources: [] };
export const exportLoadConfig = async root => { state.configLoads.push(root); return state.configs[root] ?? ({ config: null, fingerprint: null }); };
export const exportSaveConfig = async (root, config, expectedFingerprint) => {
  state.saves.push({ root, config, expectedFingerprint });
  return { config, fingerprint: 'saved' };
};
export const exportPreflight = async request => {
  state.preflights.push(request);
  if (state.preflightGate) await state.preflightGate;
  return {
    blocking: [], warnings: [],
    capabilities: { html: true, systemPrint: true, pandoc: true, pdfEngine: 'test', formats: { html: true, pdf: true, docx: true, odt: true, epub: true } },
    dependencies: { pandocAvailable: true, pdfEngine: 'test' },
  };
};
export const exportStart = async request => {
  state.starts.push(request);
  return { status: 'completed', outputPath: request.outputPath || 'C:/test/export.html' };
};
export const exportCancel = async () => undefined;
export const exportReadResource = async (sourcePath, resource, projectRoot) => {
  state.resources.push({ sourcePath, resource, projectRoot });
  const separator = Math.max(sourcePath.lastIndexOf('/'), sourcePath.lastIndexOf(String.fromCharCode(92)));
  return { dataUrl: 'data:image/png;base64,YQ==', mime: 'image/png', sourcePath: sourcePath.slice(0, separator + 1) + resource };
};
export const readMarkdown = async path => ({ path, markdown: ['# Outside document', '', '![photo](photo.png)', ''].join(String.fromCharCode(10)), encoding: 'utf8', lineEnding: 'lf', hadDecodeErrors: false, bom: false });
export const exportSaveDialog = async (format, defaultName, defaultDirectory) => {
  state.dialogs.push({ format, defaultName, defaultDirectory });
  if (state.dialogGate) await state.dialogGate;
  return state.saveTarget ?? null;
};
export const onExportProgress = async () => () => undefined;
`

const bridgeTransport = `
export * from '/src/services/tauri-bridge.ts?m1-export-bridge-original';
const listeners = globalThis.__m1ExportBridgeListeners ??= new Map();
export async function listenTyped(name, handler) {
  const handlers = listeners.get(name) ?? [];
  handlers.push(handler);
  listeners.set(name, handlers);
  return () => listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== handler));
}
export function dispatchM1ExportEvent(name, payload) {
  for (const handler of listeners.get(name) ?? []) handler(payload);
}
globalThis.__m1ExportBridge = {
  dispatch: dispatchM1ExportEvent,
  count: name => (listeners.get(name) ?? []).length,
};
`

async function mockIpc(page: Page) {
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/src/services/tauri-invoke.ts*', route => route.request().url().includes('m1-export-original')
    ? route.continue()
    : route.fulfill({ contentType: 'text/javascript', body: exportTransport }))
  await page.route('**/src/services/tauri-bridge.ts*', route => route.request().url().includes('m1-export-bridge-original')
    ? route.continue()
    : route.fulfill({ contentType: 'text/javascript', body: bridgeTransport }))
  await page.goto('/')
  await expect(page.locator('.title-bar')).toBeVisible()
  await page.evaluate(async () => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    if (editor.startupHydrationPending) editor.finishStartupHydration()
    editor.sourceCodeMode = true
    const tab = editor.newUntitledTab('# Export report\n\nSnapshot body.\n')
    tab.pendingBaselineUpdate = false
  })
  await expect(page.locator('.cm-content').first()).toContainText('Snapshot body.')
  await expect.poll(() => page.evaluate(() => (
    globalThis as unknown as { __m1ExportBridge?: { count: (name: string) => number } }
  ).__m1ExportBridge?.count('mt://menu/action') ?? 0)).toBeGreaterThan(0)
}

async function dispatchMenuAction(page: Page, action: string) {
  await page.evaluate(action => (
    globalThis as unknown as { __m1ExportBridge: { dispatch: (name: string, payload: string) => void } }
  ).__m1ExportBridge.dispatch('mt://menu/action', action), action)
}

async function preview(page: Page, expectedBody = 'Snapshot body.') {
  await page.getByRole('button', { name: /^(Preview|Refresh preview)$/ }).click()
  const frame = page.locator('.preview-frame')
  await expect(frame).toBeVisible()
  await expect(frame.contentFrame().locator('body')).toContainText(expectedBody)
  return frame
}

interface ControlledExportState {
  preflightGate?: Promise<void>
  dialogGate?: Promise<void>
  releaseGate?: () => void
  saveTarget?: string
  preflights: unknown[]
  dialogs: unknown[]
  starts: Array<{ options: { toc: { enabled: boolean } }; renderedHtml: string }>
}

async function holdExport(page: Page, gate: 'preflightGate' | 'dialogGate') {
  await page.evaluate(gate => {
    const state = (globalThis as unknown as { __m1ExportState: ControlledExportState }).__m1ExportState
    state.saveTarget = 'C:/test/frozen.html'
    state[gate] = new Promise<void>(resolve => { state.releaseGate = resolve })
  }, gate)
}

async function releaseExport(page: Page) {
  await page.evaluate(() => {
    const state = (globalThis as unknown as { __m1ExportState: ControlledExportState }).__m1ExportState
    state.releaseGate?.()
    delete state.preflightGate
    delete state.dialogGate
  })
}

test('built-in preset selections persist and drive preview options', async ({ page }) => {
  await mockIpc(page)
  await dispatchMenuAction(page, 'file.exportHtml')
  const dialog = page.locator('.export-dialog')
  const preset = dialog.locator('.el-form-item').filter({ has: page.locator('label', { hasText: /^Preset$/ }) }).locator('.el-select')
  for (const label of ['Technical Document', 'Formal Report']) {
    await preset.click()
    await page.getByRole('option', { name: label, exact: true }).click()
    await expect(preset).toContainText(label)
    await expect(dialog.getByRole('checkbox', { name: 'Table of contents' })).toBeChecked()
  }
  const frame = await preview(page)
  await expect(frame.contentFrame().locator('nav.export-toc')).toBeVisible()
})

for (const gate of ['preflightGate', 'dialogGate'] as const) {
  for (const closeDialog of [false, true]) {
  test(`cancels the whole export while waiting for ${gate} (${closeDialog ? 'close dialog' : 'cancel operation'})`, async ({ page }) => {
    await mockIpc(page)
    await dispatchMenuAction(page, 'file.exportHtml')
    await preview(page)
    const exportButton = page.getByRole('button', { name: 'Export HTML', exact: true })
    await expect(exportButton).toBeEnabled()
    await holdExport(page, gate)
    await exportButton.click()
    await expect.poll(() => page.evaluate(gate => {
      const state = (globalThis as unknown as { __m1ExportState: ControlledExportState }).__m1ExportState
      return gate === 'preflightGate' ? state.preflights.length : state.dialogs.length
    }, gate)).toBe(gate === 'preflightGate' ? 2 : 1)
    const buttons = page.locator('.export-dialog').getByRole('button', { name: 'Cancel', exact: true })
    await (closeDialog ? buttons.first() : buttons.last()).click()
    await releaseExport(page)
    await page.waitForTimeout(100)
    expect(await page.evaluate(() => (globalThis as unknown as { __m1ExportState: ControlledExportState }).__m1ExportState.starts.length)).toBe(0)
  })
  }
}

test('settings changed during first preview invalidate that generation and export uses the refreshed request', async ({ page }) => {
  await mockIpc(page)
  await dispatchMenuAction(page, 'file.exportHtml')
  await holdExport(page, 'preflightGate')
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __m1ExportState: ControlledExportState }).__m1ExportState.preflights.length)).toBe(1)
  const dialog = page.locator('.export-dialog')
  await dialog.locator('.el-form-item').filter({ hasText: 'Table of contents' }).locator('.el-checkbox').click()
  await releaseExport(page)
  await expect(page.getByRole('button', { name: 'Export HTML', exact: true })).toBeDisabled()
  const frame = await preview(page)
  await expect(frame.contentFrame().locator('nav.export-toc')).toBeVisible()
  const exportButton = page.getByRole('button', { name: 'Export HTML', exact: true })
  await expect(exportButton).toBeEnabled()
  await exportButton.click()
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __m1ExportState: ControlledExportState }).__m1ExportState.starts.length)).toBe(1)
  const request = await page.evaluate(() => (globalThis as unknown as { __m1ExportState: ControlledExportState }).__m1ExportState.starts[0])
  expect(request.options.toc.enabled).toBe(true)
  expect(request.renderedHtml.includes('class="export-toc"')).toBe(true)
})

test('changing settings in the save dialog prevents the obsolete request from writing', async ({ page }) => {
  await mockIpc(page)
  await dispatchMenuAction(page, 'file.exportHtml')
  await preview(page)
  const exportButton = page.getByRole('button', { name: 'Export HTML', exact: true })
  await expect(exportButton).toBeEnabled()
  await holdExport(page, 'dialogGate')
  await exportButton.click()
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __m1ExportState: ControlledExportState }).__m1ExportState.dialogs.length)).toBe(1)
  await page.locator('.export-dialog').locator('.el-form-item').filter({ hasText: 'Table of contents' }).locator('.el-checkbox').click()
  await releaseExport(page)
  await page.waitForTimeout(100)
  expect(await page.evaluate(() => (globalThis as unknown as { __m1ExportState: ControlledExportState }).__m1ExportState.starts.length)).toBe(0)
  await expect(exportButton).toBeDisabled()
})

test('native menu export opens the shared dialog, waits for an isolated preview, and disables stale output', async ({ page }) => {
  await mockIpc(page)
  await dispatchMenuAction(page, 'file.exportHtml')

  const dialog = page.locator('.export-dialog')
  await expect(dialog).toBeVisible()
  const frame = await preview(page)
  await expect(page.getByRole('button', { name: 'Export HTML', exact: true })).toBeEnabled()
  await expect(frame).toHaveAttribute('sandbox', 'allow-same-origin allow-modals')
  await expect(frame.contentFrame().locator('body')).toContainText('Snapshot body.')

  await page.evaluate(async () => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    const tab = editor.currentFile!
    editor.applyContentChange(tab.id, `${tab.markdown}\nEdited after preview.`)
  })
  await expect(dialog.locator('.preview-stale')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Export HTML', exact: true })).toBeDisabled()
})

test('TOC follows rendered heading IDs and depth, and can be disabled', async ({ page }) => {
  await mockIpc(page)
  const root = 'C:/M1-toc'
  await page.evaluate(async root => {
    const { BUILTIN_PROFILES } = await import('/src/services/export/profiles.ts')
    const project = (await import('/src/stores/project.ts')).useProjectStore()
    project.projectTree = {
      id: 'root', name: 'TOC test', pathname: root, isDirectory: true, isFile: false,
      isRoot: true, folders: [], files: [], isCollapsed: false, childrenLoaded: true,
    }
    const state = (globalThis as unknown as { __m1ExportState: { configs: Record<string, unknown> } }).__m1ExportState
    state.configs[root] = {
      config: { schemaVersion: 1, defaultProfile: 'technical', profiles: [structuredClone(BUILTIN_PROFILES.technical)] },
      fingerprint: 'toc-profile',
    }
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    editor.applyContentChange(editor.currentFile!.id, [
      '# Main chapter', '',
      '## Section one', '',
      '### Nested section', '',
      '#### Beyond configured depth', '',
      'Body text.',
      '',
      '| A | B | C | D | E | F | G | H | I |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      '| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |',
    ].join(String.fromCharCode(10)))
  }, root)

  await dispatchMenuAction(page, 'file.exportHtml')
  const dialog = page.locator('.export-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('checkbox', { name: 'Table of contents' })).toBeChecked()
  const frame = await preview(page, 'Body text.')
  await expect(dialog).toContainText('A wide table needs final layout review.')
  const toc = frame.contentFrame().locator('nav.export-toc')
  await expect(toc).toBeVisible()
  const tocData = await toc.evaluate(nav => {
    const document = nav.ownerDocument
    return Array.from(nav.querySelectorAll<HTMLAnchorElement>('a')).map(anchor => {
      const targetId = decodeURIComponent(anchor.getAttribute('href')?.slice(1) ?? '')
      return { label: anchor.textContent?.trim(), targetId, targetText: document.getElementById(targetId)?.textContent?.trim() }
    })
  })
  expect(tocData.map(item => item.label)).toEqual(['Main chapter', 'Section one', 'Nested section'])
  expect(tocData.every(item => item.targetId && item.targetText === item.label)).toBe(true)
  expect(await toc.locator(':scope > ol > li > ol > li > ol > li').count()).toBe(1)

  await dialog.locator('.el-form-item').filter({ hasText: 'Table of contents' }).locator('.el-checkbox').click()
  const refresh = page.getByRole('button', { name: 'Refresh preview', exact: true })
  await expect(refresh).toBeEnabled()
  await refresh.click()
  await expect(frame.contentFrame().locator('nav.export-toc')).toHaveCount(0)
  await expect(frame.contentFrame().locator('article.markdown-body')).toContainText('Beyond configured depth')
})

test('Print menu action prints only the isolated iframe and never claims a saved file', async ({ page }) => {
  await mockIpc(page)
  await dispatchMenuAction(page, 'file.print')

  const dialog = page.locator('.export-dialog')
  await expect(dialog).toBeVisible()
  const frame = await preview(page)
  await expect(page.getByRole('button', { name: 'Open print dialog', exact: true })).toBeEnabled()

  await page.evaluate(() => {
    const iframe = document.querySelector<HTMLIFrameElement>('.preview-frame')!
    ;(window as unknown as { __m1MainPrintCalls: number }).__m1MainPrintCalls = 0
    ;(window as unknown as { __m1FramePrintCalls: number }).__m1FramePrintCalls = 0
    window.print = () => { (window as unknown as { __m1MainPrintCalls: number }).__m1MainPrintCalls++ }
    iframe.contentWindow!.print = () => { (window as unknown as { __m1FramePrintCalls: number }).__m1FramePrintCalls++ }
  })

  await page.getByRole('button', { name: 'Open print dialog', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('Print dialog opened')
  await expect(frame).toBeVisible()
  const calls = await page.evaluate(() => ({
    main: (window as unknown as { __m1MainPrintCalls: number }).__m1MainPrintCalls,
    frame: (window as unknown as { __m1FramePrintCalls: number }).__m1FramePrintCalls,
    starts: (globalThis as unknown as { __m1ExportState: { starts: unknown[] } }).__m1ExportState.starts.length,
  }))
  expect(calls).toEqual({ main: 0, frame: 1, starts: 0 })
  await expect(dialog.locator('.print-status')).toContainText('Print dialog opened')
  await expect(dialog.locator('.print-status')).not.toContainText('saved')
})

test('advanced typography and output settings save into a project preset without dropping extensions', async ({ page }) => {
  await mockIpc(page)
  const root = 'C:/M1-export'
  await page.evaluate(async root => {
    const { BUILTIN_PROFILES } = await import('/src/services/export/profiles.ts')
    const project = (await import('/src/stores/project.ts')).useProjectStore()
    project.projectTree = {
      id: 'root', name: 'M1 export', pathname: root, isDirectory: true, isFile: false,
      isRoot: true, folders: [], files: [], isCollapsed: false, childrenLoaded: true,
    }
    const profile = {
      ...structuredClone(BUILTIN_PROFILES.technical),
      futureExtension: { vendorFlag: true },
    }
    const state = (globalThis as unknown as {
      __m1ExportState: { configs: Record<string, unknown> }
    }).__m1ExportState
    state.configs[root] = {
      config: { schemaVersion: 1, defaultProfile: profile.id, profiles: [profile], futureConfig: { retained: true } },
      fingerprint: 'fingerprint-before-edit',
    }
  }, root)
  await dispatchMenuAction(page, 'file.exportHtml')
  const dialog = page.locator('.export-dialog')
  await expect(dialog).toBeVisible()
  const advanced = dialog.locator('details.export-advanced')
  await expect.poll(() => advanced.evaluate(element => (element as HTMLDetailsElement).open)).toBe(false)
  await advanced.locator('summary').click()

  const bodyFont = advanced.locator('.el-form-item').filter({ hasText: 'Body font' }).locator('.el-select')
  await bodyFont.click()
  await page.getByRole('option', { name: 'System CJK serif', exact: true }).click()

  async function fillNumber(label: string, value: string) {
    const input = advanced.locator('.el-form-item').filter({ hasText: label }).locator('input').first()
    await input.fill(value)
    await input.press('Tab')
  }

  await fillNumber('Body size (pt)', '12')
  await fillNumber('Line height', '1.75')
  await fillNumber('Top (mm)', '25')
  await fillNumber('Right (mm)', '17')
  await fillNumber('Bottom (mm)', '23')
  await fillNumber('Left (mm)', '19')
  await advanced.locator('.el-form-item').filter({ hasText: 'Number headings' }).locator('.el-checkbox').click()
  await advanced.locator('.el-form-item').filter({ hasText: 'Project output directory' }).locator('input').first().fill('deliverables')
  await advanced.locator('.el-form-item').filter({ hasText: 'Output file name' }).locator('input').first().fill('{name}-{date}')

  const saveButton = dialog.getByRole('button', { name: 'Save as project preset' })
  await expect(saveButton).toBeEnabled()
  await saveButton.click()
  await expect.poll(() => page.evaluate(() => (
    globalThis as unknown as { __m1ExportState: { saves: unknown[] } }
  ).__m1ExportState.saves.length)).toBe(1)
  const saved = await page.evaluate(() => {
    const state = (globalThis as unknown as {
      __m1ExportState: {
        saves: {
          root: string
          expectedFingerprint: string
          config: { profiles: { id: string; [key: string]: unknown }[]; [key: string]: unknown }
        }[]
      }
    }).__m1ExportState
    return state.saves.at(-1)
  })
  expect(saved?.root).toBe(root)
  expect(saved?.expectedFingerprint).toBe('fingerprint-before-edit')
  const profile = saved?.config.profiles.find(item => item.id === 'technical')
  expect(profile).toMatchObject({
    theme: 'technical',
    typography: { bodyFont: 'system-serif', bodySizePt: 12, lineHeight: 1.75 },
    page: { marginMm: { top: 25, right: 17, bottom: 23, left: 19 } },
    numberHeadings: true,
    output: { directory: 'deliverables', fileName: '{name}-{date}' },
    futureExtension: { vendorFlag: true },
  })
  expect(saved?.config.futureConfig).toEqual({ retained: true })
})

test('an external document does not inherit the open project preset or resource boundary', async ({ page }) => {
  await mockIpc(page)
  const workspaceRoot = 'C:/M1-notes'
  const sourcePath = 'C:/M1-notes-old/outside.md'
  await page.evaluate(async ({ workspaceRoot, sourcePath }) => {
    const { BUILTIN_PROFILES } = await import('/src/services/export/profiles.ts')
    const project = (await import('/src/stores/project.ts')).useProjectStore()
    project.projectTree = {
      id: 'root', name: 'M1 notes', pathname: workspaceRoot, isDirectory: true, isFile: false,
      isRoot: true, folders: [], files: [], isCollapsed: false, childrenLoaded: true,
    }
    const state = (globalThis as unknown as {
      __m1ExportState: { configs: Record<string, unknown> }
    }).__m1ExportState
    state.configs[workspaceRoot] = {
      config: { schemaVersion: 1, defaultProfile: 'technical', profiles: [structuredClone(BUILTIN_PROFILES.technical)] },
      fingerprint: 'project-a-fingerprint',
    }
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    await editor.openFile(sourcePath)
  }, { workspaceRoot, sourcePath })
  await expect(page.locator('.cm-content').first()).toContainText('Outside document')
  await dispatchMenuAction(page, 'file.exportHtml')

  const dialog = page.locator('.export-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('This document is outside the open project; its preset and resources are not used.')
  await expect(dialog.locator('.document-summary')).toContainText(sourcePath)
  await expect(dialog.getByRole('button', { name: 'Save as project preset' })).toBeDisabled()
  await preview(page, 'Outside document')

  const exportState = await page.evaluate(() => {
    const state = (globalThis as unknown as {
      __m1ExportState: {
        configLoads: string[]
        resources: { sourcePath: string; resource: string; projectRoot?: string }[]
        preflights: { projectRoot?: string }[]
      }
    }).__m1ExportState
    return state
  })
  expect(exportState.configLoads).not.toContain(workspaceRoot)
  expect(exportState.resources).toEqual([{ sourcePath, resource: 'photo.png', projectRoot: undefined }])
  expect(exportState.preflights.at(-1)?.projectRoot).toBeUndefined()
})
