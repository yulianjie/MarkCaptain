import { expect, test, type Locator, type Page } from '@playwright/test'

const root = 'C:/M3-project'

// Replace only the IPC boundary. The editor, export dialog, rendering and
// orchestration run as shipped, including the asynchronous invalidation paths.
const transport = `
export * from '/src/services/tauri-invoke.ts?m3-project-original';
const state = globalThis.__m3ProjectState ??= {
  notes: ['chapters/one.md', 'appendix/two.md'],
  markdown: { 'chapters/one.md': '# Chapter one\\n\\nDisk first chapter.', 'appendix/two.md': '# Chapter two\\n\\nDisk second chapter.' },
  reads: [], preflights: [], starts: [], cancellations: [], saves: [], dialogs: [],
  failNames: [], config: null, fingerprint: null,
};
export const notesList = async root => state.notes.map(relative => ({ path: root + '/' + relative, relative, size: 100, modified: 1 }));
export const exportProjectList = async root => state.notes.map(relative => ({ path: root + '/' + relative, relative, name: relative.split('/').at(-1), size: 100 }));
export const exportProjectSnapshot = async (root, paths, buffers) => {
  state.reads.push(...paths);
  if (state.readGate) await state.readGate;
  const sources = paths.map(relativePath => {
    const path = root + '/' + relativePath;
    const buffer = buffers.find(item => item.path.replaceAll('\\\\', '/').toLowerCase() === path.toLowerCase());
    const markdown = buffer?.markdown ?? state.markdown[relativePath];
    if (markdown === undefined) throw new Error('Source missing: ' + relativePath);
    const revision = 'revision:' + markdown;
    return { sourceId: 'source-' + relativePath.replace(/[^a-z0-9]/gi, '-'), relativePath, revision, origin: buffer ? 'buffer' : 'disk', snapshot: { markdown, sourcePath: path, fileName: relativePath.split('/').at(-1), capturedAt: '2026-10-23T00:00:00Z', revision } };
  });
  return { root, sources, errors: [], capturedAt: '2026-10-23T00:00:00Z', revision: JSON.stringify(sources.map(source => [source.relativePath, source.revision])) };
};
export const notesRead = async (root, relative) => {
  state.reads.push(relative);
  if (state.readGate) await state.readGate;
  const markdown = state.markdown[relative];
  if (markdown === undefined) throw new Error('Source missing: ' + relative);
  return { path: root + '/' + relative, markdown, fingerprint: markdown, encoding: 'utf8', lineEnding: 'lf', hadDecodeErrors: false, bom: false };
};
export const readMarkdown = async path => {
  const relative = path.replace(/^C:[/\\\\]M3-project[/\\\\]/i, '').replaceAll('\\\\', '/');
  return { path, markdown: state.markdown[relative] ?? '# Open document', encoding: 'utf8', lineEnding: 'lf', hadDecodeErrors: false, bom: false };
};
export const exportLoadConfig = async () => ({ config: state.config, fingerprint: state.fingerprint });
export const exportSaveConfig = async (root, config, expectedFingerprint) => {
  state.saves.push({ root, config, expectedFingerprint });
  state.config = config; state.fingerprint = 'saved-project';
  return { config, fingerprint: state.fingerprint };
};
export const exportPreflight = async request => {
  state.preflights.push(request);
  if (state.preflightGate) await state.preflightGate;
  return { blocking: [], warnings: [], capabilities: { html: true, systemPrint: true, pandoc: true, formats: { html: true, pdf: true, docx: true, odt: true, epub: true } }, dependencies: { pandocAvailable: true, pdfEngine: 'test' } };
};
export const exportStart = async request => {
  state.starts.push(request);
  if (state.writeGate) await state.writeGate;
  if (state.failNames.some(name => request.snapshot.fileName.includes(name))) throw new Error('Simulated export failure');
  return { status: 'completed', outputPath: request.outputPath };
};
export const exportCancel = async taskId => { state.cancellations.push(taskId); };
export const exportSaveDialog = async (...args) => { state.dialogs.push(args); return 'C:/M3-project/exports/book.html'; };
export const exportReadResource = async () => ({ dataUrl: 'data:image/png;base64,YQ==', mime: 'image/png', sourcePath: 'C:/M3-project/photo.png' });
export const onExportProgress = async () => () => undefined;
`

const bridgeTransport = `
export * from '/src/services/tauri-bridge.ts?m3-project-bridge-original';
const listeners = new Map();
export async function listenTyped(name, handler) {
  const handlers = listeners.get(name) ?? [];
  handlers.push(handler); listeners.set(name, handlers);
  return () => listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== handler));
}
globalThis.__m3ProjectBridge = {
  dispatch: (name, payload) => { for (const handler of listeners.get(name) ?? []) handler(payload); },
  count: name => (listeners.get(name) ?? []).length,
};
`

interface ExportState {
  notes: string[]
  markdown: Record<string, string>
  reads: string[]
  preflights: unknown[]
  starts: Array<{ snapshot: { fileName: string; markdown: string }; outputPath: string; renderedHtml: string }>
  cancellations: string[]
  saves: Array<{ root: string; config: Record<string, unknown>; expectedFingerprint: string | null }>
  failNames: string[]
  config: unknown
  fingerprint: string | null
  preflightGate?: Promise<void>
  readGate?: Promise<void>
  writeGate?: Promise<void>
  release?: () => void
}

async function setup(page: Page) {
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/src/services/tauri-invoke.ts*', route => route.request().url().includes('m3-project-original')
    ? route.continue()
    : route.fulfill({ contentType: 'text/javascript', body: transport }))
  await page.route('**/src/services/tauri-bridge.ts*', route => route.request().url().includes('m3-project-bridge-original')
    ? route.continue()
    : route.fulfill({ contentType: 'text/javascript', body: bridgeTransport }))
  await page.goto('/')
  await expect(page.locator('.title-bar')).toBeVisible()
  await page.evaluate(async root => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    if (editor.startupHydrationPending) editor.finishStartupHydration()
    editor.sourceCodeMode = true
    editor.tabs = []
    const tab = editor.newUntitledTab('# Session only\n\nUntitled buffer.\n')
    tab.pendingBaselineUpdate = false
    const project = (await import('/src/stores/project.ts')).useProjectStore()
    project.projectTree = {
      id: 'm3-root', name: 'M3 project', pathname: root, isDirectory: true, isFile: false,
      isRoot: true, folders: [], files: [], isCollapsed: false, childrenLoaded: true,
    }
  }, root)
  await expect(page.locator('.cm-content').first()).toContainText('Untitled buffer.')
  await expect.poll(() => page.evaluate(() => (
    globalThis as unknown as { __m3ProjectBridge: { count: (name: string) => number } }
  ).__m3ProjectBridge.count('mt://menu/action'))).toBeGreaterThan(0)
}

async function hold(page: Page, gate: 'preflightGate' | 'readGate' | 'writeGate') {
  await page.evaluate(gate => {
    const state = (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState
    state[gate] = new Promise<void>(resolve => { state.release = resolve })
  }, gate)
}

async function release(page: Page) {
  await page.evaluate(() => {
    const state = (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState
    state.release?.()
    delete state.preflightGate
    delete state.readGate
    delete state.writeGate
  })
}

async function openProjectExport(page: Page, candidateCount = 2) {
  await page.evaluate(() => (
    globalThis as unknown as { __m3ProjectBridge: { dispatch: (name: string, payload: string) => void } }
  ).__m3ProjectBridge.dispatch('mt://menu/action', 'file.exportHtml'))
  await page.getByTestId('project-export-open').click()
  await expect(page.getByTestId('project-export-dialog')).toBeVisible()
  await expect(page.getByTestId('project-export-candidate')).toHaveCount(candidateCount)
  await expect(page.getByTestId('project-export-untitled')).toHaveCount(1)
}

async function selectSavedChapters(page: Page) {
  for (const path of ['chapters/one.md', 'appendix/two.md']) {
    await page.getByTestId('project-export-candidate').filter({ hasText: path }).getByRole('checkbox').check()
  }
}

async function review(page: Page) {
  await page.getByTestId('project-export-review').click()
  const acknowledge = page.getByTestId('project-export-acknowledge')
  await expect(page.getByTestId('project-export-review')).toBeEnabled()
  if (await acknowledge.isVisible()) await acknowledge.check()
  await expect(page.getByTestId('project-export-run'), await page.getByTestId('project-export-dialog').innerText()).toBeEnabled()
}

test('reviews explicit source order and exports dirty buffers alongside disk and untitled snapshots', async ({ page }) => {
  await setup(page)
  await page.evaluate(async () => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    await editor.openFile('C:/M3-project/chapters/one.md')
  })
  await expect(page.locator('.cm-content').first()).toContainText('Disk first chapter.')
  await page.locator('.cm-content').first().fill('# Dirty first chapter\n\nEdited buffer wins.')
  await expect.poll(() => page.evaluate(async () => (await import('/src/stores/editor.ts')).useEditorStore().currentFile!.isSaved)).toBe(false)
  await openProjectExport(page)
  await selectSavedChapters(page)
  await page.getByTestId('project-export-untitled').getByRole('checkbox').check()
  await review(page)
  await page.getByTestId('project-export-run').click()
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState.starts.length)).toBe(3)
  const starts = await page.evaluate(() => (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState.starts)
  expect(starts.map(request => request.snapshot.markdown)).toEqual([
    '# Dirty first chapter\n\nEdited buffer wins.', '# Chapter two\n\nDisk second chapter.', '# Session only\n\nUntitled buffer.\n',
  ])
  expect(starts.every(request => request.renderedHtml.includes('<article'))).toBe(true)
  expect(new Set(starts.map(request => request.outputPath.toLowerCase())).size).toBe(3)
})

test('cancel while reading the snapshot prevents rendering and file writes', async ({ page }) => {
  await setup(page)
  await openProjectExport(page)
  await selectSavedChapters(page)
  await hold(page, 'readGate')
  await page.getByTestId('project-export-review').click()
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState.reads.length)).toBeGreaterThan(0)
  await page.getByTestId('project-export-cancel').click()
  await release(page)
  await expect(page.getByTestId('project-export-run')).toBeDisabled()
  expect(await page.evaluate(() => (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState.starts)).toHaveLength(0)
})

test('selection changes invalidate the reviewed preview and require a fresh review', async ({ page }) => {
  await setup(page)
  await openProjectExport(page)
  await selectSavedChapters(page)
  await review(page)
  await page.getByTestId('project-export-candidate').filter({ hasText: 'appendix/two.md' }).getByRole('checkbox').uncheck()
  await expect(page.getByTestId('project-export-run')).toBeDisabled()
  expect(await page.evaluate(() => (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState.starts)).toHaveLength(0)
  await review(page)
  await page.getByTestId('project-export-run').click()
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState.starts.length)).toBe(1)
})

test('partial failure keeps successes and retries only a failed unchanged source', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => { (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState.failNames = ['one.md'] })
  await openProjectExport(page)
  await selectSavedChapters(page)
  await review(page)
  await page.getByTestId('project-export-run').click()
  await expect(page.getByTestId('project-export-dialog')).toContainText('Simulated export failure')
  await expect(page.getByTestId('project-export-retry')).toBeEnabled()
  await page.evaluate(() => { (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState.failNames = [] })
  await page.getByTestId('project-export-retry').click()
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState.starts.length)).toBe(3)
  const names = await page.evaluate(() => (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState.starts.map(request => request.snapshot.fileName))
  expect(names).toEqual(['one.md', 'two.md', 'one.md'])
})

test('changed source versions stop retry without rewriting successful outputs', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => { (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState.failNames = ['one.md'] })
  await openProjectExport(page)
  await selectSavedChapters(page)
  await review(page)
  await page.getByTestId('project-export-run').click()
  await expect(page.getByTestId('project-export-retry')).toBeEnabled()
  await page.evaluate(() => {
    const state = (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState
    state.markdown['chapters/one.md'] += '\nExternal edit after first attempt.'
    state.failNames = []
  })
  await page.getByTestId('project-export-retry').click()
  await expect(page.getByTestId('project-export-run')).toBeDisabled()
  await expect(page.getByTestId('project-export-dialog')).toContainText(/chang|stale|review/i)
  expect(await page.evaluate(() => (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState.starts)).toHaveLength(2)
})

test('saves explicit reordered chapters and extensions while leaving untitled buffers session-only', async ({ page }) => {
  await setup(page)
  await page.evaluate(async () => {
    const { BUILTIN_PROFILES } = await import('/src/services/export/profiles.ts')
    const state = (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState
    state.config = { schemaVersion: 1, defaultProfile: 'technical', profiles: [{ ...structuredClone(BUILTIN_PROFILES.technical), vendorProfile: { retained: true } }], vendorConfig: { retained: true } }
    state.fingerprint = 'config-original'
  })
  await openProjectExport(page)
  await selectSavedChapters(page)
  await page.getByTestId('project-export-untitled').getByRole('checkbox').check()
  await page.getByTestId('project-export-mode').selectOption('book')
  await page.getByTestId('project-export-book-title').fill('Project handbook')
  await page.getByRole('button', { name: 'Move up: two', exact: true }).click()
  await page.getByTestId('project-export-save').click()
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState.saves.length)).toBe(1)
  const saved = await page.evaluate(() => (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState.saves[0])
  expect(saved.root).toBe(root)
  expect(saved.expectedFingerprint).toBe('config-original')
  expect(saved.config).toMatchObject({
    vendorConfig: { retained: true }, profiles: [expect.objectContaining({ vendorProfile: { retained: true } })],
    projectExport: { mode: 'book', title: 'Project handbook', chapters: [
      { path: 'appendix/two.md', title: 'two', level: 1 }, { path: 'chapters/one.md', title: 'one', level: 1 },
    ] },
  })
  expect(JSON.stringify(saved.config)).not.toContain('Untitled-')
  expect(JSON.stringify(saved.config)).not.toContain('Session only')
  expect(await page.evaluate(() => (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState.starts)).toHaveLength(0)
})

test('changing output options disables reviewed output until the new plan is rendered', async ({ page }) => {
  await setup(page)
  await openProjectExport(page)
  await selectSavedChapters(page)
  await review(page)
  await page.getByTestId('project-export-filename').fill('{name}-final')
  await expect(page.getByTestId('project-export-run')).toBeDisabled()
  await review(page)
  await page.getByTestId('project-export-run').click()
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState.starts.length)).toBe(2)
  const starts = await page.evaluate(() => (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState.starts)
  expect(starts.every(request => request.outputPath.includes('-final'))).toBe(true)
})

test('book preview follows the explicit chapter order and exports that reviewed HTML', async ({ page }) => {
  await setup(page)
  await openProjectExport(page)
  await selectSavedChapters(page)
  await page.getByTestId('project-export-mode').selectOption('book')
  await page.getByTestId('project-export-profile').selectOption('technical')
  await page.getByTestId('project-export-book-title').fill('Ordered handbook')
  await page.getByRole('button', { name: 'Move up: two', exact: true }).click()
  await review(page)
  const frame = page.getByTestId('project-export-dialog').locator('.preview-frame').contentFrame()
  await expect(frame.locator('.export-chapter')).toHaveCount(2)
  await expect(frame.locator('.export-chapter').first()).toContainText('Disk second chapter.')
  await expect(frame.locator('.export-chapter').last()).toContainText('Disk first chapter.')
  await expect(frame.locator('.export-toc')).toBeVisible()
  await page.getByTestId('project-export-run').click()
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState.starts.length)).toBe(1)
  const request = await page.evaluate(() => (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState.starts[0])
  expect(request.renderedHtml.indexOf('Disk second chapter.')).toBeLessThan(request.renderedHtml.indexOf('Disk first chapter.'))
  expect(request.renderedHtml).toContain('Ordered handbook')
})

test('real preview link clicks scroll within srcdoc and never replace the reviewed book', async ({ page }) => {
  await setup(page)
  const externalRequests: string[] = []
  await page.route('https://preview.invalid/**', route => {
    externalRequests.push(route.request().url())
    return route.abort()
  })
  await page.evaluate(() => {
    const state = (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState
    const spacing = Array.from({ length: 24 }, (_, index) => `Paragraph ${index + 1} provides enough real document content to test scrolling.`).join('\n\n')
    state.markdown['chapters/one.md'] = [
      '# First chapter', '',
      '[Cross chapter](../appendix/two.md#Destination)', '',
      '[[Beta#Destination|Alias destination]]', '',
      '[Local destination](#local-target)', '',
      '[External reference](https://preview.invalid/reference)', '',
      'A footnote reference[^1].', '', spacing, '',
      '## Local target', '', 'Local target body remains in the reviewed book.', '',
      '[^1]: Footnote destination remains in the reviewed book.',
    ].join('\n')
    state.markdown['appendix/two.md'] = [
      '---', 'aliases: [Beta]', '---', '', '# Second chapter', '', spacing, '',
      '## Destination', '', 'Cross chapter destination body remains in the reviewed book.', '', spacing,
    ].join('\n')
  })
  await openProjectExport(page)
  await selectSavedChapters(page)
  await page.getByTestId('project-export-mode').selectOption('book')
  await page.getByTestId('project-export-book-title').fill('Navigable reviewed book')
  await review(page)
  const iframe = page.getByTestId('project-export-dialog').locator('.preview-frame')
  const frame = iframe.contentFrame()
  const body = frame.locator('body')
  const initialContent = await body.textContent()
  const parentUrl = page.url()

  async function clickInternalLink(link: Locator, targetText: string) {
    const id = await link.evaluate(anchor => {
      const href = anchor.getAttribute('href') ?? ''
      return href.startsWith('#') ? decodeURIComponent(href.slice(1)) : ''
    })
    expect(id).toBeTruthy()
    await link.scrollIntoViewIfNeeded()
    const before = await body.evaluate((element, id) => {
      const document = element.ownerDocument
      const target = document.getElementById(id)!
      return { y: document.defaultView!.scrollY, top: target.getBoundingClientRect().top, height: document.defaultView!.innerHeight, text: target.textContent }
    }, id)
    expect(before.text).toContain(targetText)
    expect(before.top).toBeGreaterThan(before.height)
    await link.click()
    await expect.poll(() => body.evaluate((element, id) => {
      const document = element.ownerDocument
      const rect = document.getElementById(id)!.getBoundingClientRect()
      return rect.top >= -1 && rect.top < document.defaultView!.innerHeight
    }, id)).toBe(true)
    expect(await body.evaluate(element => element.ownerDocument.defaultView!.scrollY)).toBeGreaterThan(before.y)
    expect(await body.evaluate(element => element.ownerDocument.URL)).toBe('about:srcdoc')
    expect(await body.textContent()).toBe(initialContent)
    expect(page.url()).toBe(parentUrl)
  }

  await clickInternalLink(frame.getByRole('link', { name: 'Cross chapter', exact: true }), 'Destination')
  await clickInternalLink(frame.getByRole('link', { name: 'Alias destination', exact: true }), 'Destination')
  await clickInternalLink(frame.getByRole('link', { name: 'Local destination', exact: true }), 'Local target')
  await clickInternalLink(frame.locator('a.footnote-ref').first(), 'Footnote destination')

  await frame.getByRole('link', { name: 'External reference', exact: true }).click()
  // The preview intentionally disables scripts, including iframe rAF callbacks.
  // Wait for the parent to paint before checking that no navigation was started.
  await page.evaluate(() => new Promise<void>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
  expect(await body.evaluate(element => element.ownerDocument.URL)).toBe('about:srcdoc')
  expect(await body.textContent()).toBe(initialContent)
  expect(externalRequests).toEqual([])
  expect(page.context().pages()).toHaveLength(1)
  expect(page.url()).toBe(parentUrl)
})

test('cancelling after the first write starts prevents the next output from starting', async ({ page }) => {
  await setup(page)
  await openProjectExport(page)
  await selectSavedChapters(page)
  await review(page)
  await hold(page, 'writeGate')
  await page.getByTestId('project-export-run').click()
  await expect.poll(() => page.evaluate(() => (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState.starts.length)).toBe(1)
  await page.getByTestId('project-export-cancel').click()
  await release(page)
  await expect(page.getByTestId('project-export-run')).toBeDisabled()
  await expect(page.getByTestId('project-export-output-preview')).toContainText(/cancel/i)
  const state = await page.evaluate(() => (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState)
  expect(state.starts).toHaveLength(1)
  expect(state.cancellations).toHaveLength(1)
})

test('bulk candidate selection respects the 64 chapter limit and explains the remaining exclusion', async ({ page }) => {
  await setup(page)
  await page.evaluate(() => {
    const state = (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState
    state.notes = Array.from({ length: 65 }, (_, index) => `chapter-${String(index).padStart(2, '0')}.md`)
  })
  await openProjectExport(page, 65)
  await page.getByRole('button', { name: 'Include filtered documents', exact: true }).click()
  await expect(page.getByTestId('project-export-chapter')).toHaveCount(64)
  await expect(page.getByTestId('project-export-candidate').last().getByRole('checkbox')).not.toBeChecked()
  await expect(page.getByTestId('project-export-dialog').getByRole('alert')).toContainText('64')
  await page.getByTestId('project-export-candidate').last().getByRole('checkbox').click()
  await expect(page.getByTestId('project-export-chapter')).toHaveCount(64)
  await expect(page.getByTestId('project-export-candidate').last().getByRole('checkbox')).not.toBeChecked()
})

test('editing a selected Windows verbatim-path buffer invalidates its reviewed output', async ({ page }) => {
  await setup(page)
  await page.evaluate(async () => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    await editor.openFile('C:/M3-project/chapters/one.md')
  })
  await expect(page.locator('.cm-content').first()).toContainText('Disk first chapter.')
  await page.evaluate(async () => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    editor.currentFile!.pathname = '\\\\?\\C:\\M3-project\\chapters\\one.md'
  })
  await openProjectExport(page)
  await selectSavedChapters(page)
  await review(page)
  await page.evaluate(async () => {
    const editor = (await import('/src/stores/editor.ts')).useEditorStore()
    editor.currentFile!.pendingBaselineUpdate = false
    editor.applyContentChange(editor.currentFile!.id, '# Changed after review')
  })
  await expect(page.getByTestId('project-export-run')).toBeDisabled()
  expect(await page.evaluate(() => (globalThis as unknown as { __m3ProjectState: ExportState }).__m3ProjectState.starts)).toHaveLength(0)
})
