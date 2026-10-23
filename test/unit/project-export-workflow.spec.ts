import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BUILTIN_PROFILES } from '../../src/services/export/profiles'
import { createProjectExportController } from '../../src/services/export/project-workflow'
import { persistentProjectChapters, saveProjectExportPlan, validateProjectExportPlan } from '../../src/services/export/project-config'
import type { ProjectExportOptions, ProjectExportSnapshot } from '../../src/services/export/project-types'
import type { ExportRequest } from '../../src/services/export/types'

const ipc = vi.hoisted(() => ({ snapshot: vi.fn(), preflight: vi.fn(), start: vi.fn(), cancel: vi.fn(), save: vi.fn(), load: vi.fn() }))
const render = vi.hoisted(() => vi.fn())
vi.mock('../../src/services/tauri-invoke', () => ({
  exportProjectSnapshot: ipc.snapshot,
  exportPreflight: ipc.preflight,
  exportStart: ipc.start,
  exportCancel: ipc.cancel,
  exportSaveConfig: ipc.save,
  exportLoadConfig: ipc.load,
}))
vi.mock('../../src/services/export/workflow', () => ({
  renderExportPreview: render,
  runExport: (request: ExportRequest) => ipc.start(request),
  cancelExport: (id: string) => ipc.cancel(id),
}))
vi.mock('../../src/services/export/book', () => ({
  prepareProjectLinkMarkdown: (snapshot: { markdown: string }) => ({ markdown: snapshot.markdown, warnings: [] }),
  composeExportBook: ({ chapters }: { chapters: { html: string }[] }) => ({ html: chapters.map(chapter => chapter.html).join(''), warnings: [], blocking: [] }),
  rewriteExportBatchLinks: (chapters: unknown[]) => ({ chapters, warnings: [], blocking: [] }),
}))
vi.mock('../../src/services/export/resources', () => ({ restoreExternalImageLinks: (html: string) => html }))

const root = 'C:/project'
const preflight = { blocking: [], warnings: [], capabilities: { html: true, systemPrint: true, pandoc: true }, dependencies: { pandocAvailable: true } }
let disk: Record<string, string>
type Tab = { id: string; pathname: string; filename: string; markdown: string; isSaved: boolean }
let tabs: Tab[]

function options(overrides: Partial<ProjectExportOptions> = {}): ProjectExportOptions {
  return {
    root, chapters: [
      { key: 'a', relativePath: 'a/one.md', title: 'One', level: 1 },
      { key: 'b', relativePath: 'b/two.md', title: 'Two', level: 1 },
    ], mode: 'batch', title: 'Handbook', bookFileName: 'handbook', formats: ['html'],
    profile: structuredClone(BUILTIN_PROFILES.technical), overwrite: false, language: 'en', ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  vi.resetAllMocks()
  disk = { 'a/one.md': '# Disk one', 'b/two.md': '# Disk two' }
  tabs = []
  ipc.snapshot.mockImplementation(async (projectRoot: string, paths: string[], buffers: { path: string; markdown: string }[]): Promise<ProjectExportSnapshot> => {
    const sources = paths.filter(path => disk[path] !== undefined).map(relativePath => {
      const buffer = buffers.find(buffer => buffer.path.replaceAll('\\', '/').toLowerCase() === `${projectRoot}/${relativePath}`.toLowerCase())
      const markdown = buffer?.markdown ?? disk[relativePath]
      const revision = `revision:${markdown}`
      return {
        sourceId: `source-${relativePath.replace(/[^a-z0-9]/gi, '-')}`,
        relativePath, revision, origin: buffer ? 'buffer' as const : 'disk' as const,
        snapshot: { markdown, sourcePath: `${projectRoot}/${relativePath}`, fileName: relativePath.split('/').at(-1)!, capturedAt: '2026-10-23T00:00:00Z', revision },
      }
    })
    return { root: projectRoot, sources, errors: paths.filter(path => disk[path] === undefined).map(relativePath => ({ relativePath, code: 'source-unreadable' })), capturedAt: '2026-10-23T00:00:00Z', revision: JSON.stringify(sources.map(source => [source.relativePath, source.revision])) }
  })
  ipc.preflight.mockResolvedValue(structuredClone(preflight))
  ipc.start.mockImplementation(async (request: ExportRequest) => ({ status: 'completed', outputPath: request.outputPath }))
  ipc.cancel.mockResolvedValue(undefined)
  render.mockImplementation(async input => ({
    html: `<article>${input.snapshot.markdown}</article>`, preflight: structuredClone(preflight),
    request: { taskId: 'render-task', snapshot: input.snapshot, options: input.profile, format: input.format, configSource: 'project' },
  }))
})

describe('portable project export configuration', () => {
  it('persists chapter order and unknown configuration fields without storing untitled identities or Markdown', async () => {
    const input = options()
    input.chapters.unshift({ key: 'session', tabId: 'untitled-session-id', title: 'Session chapter', level: 2 })
    const chapters = persistentProjectChapters(input.chapters)
    expect(chapters.map(chapter => chapter.path)).toEqual(['a/one.md', 'b/two.md'])
    const plan = { schemaVersion: 1 as const, mode: 'book' as const, title: 'Book', chapters, formats: ['html' as const], profileId: input.profile.id, bookFileName: 'book', overwrite: false }
    const existing = {
      schemaVersion: 1 as const, defaultProfile: input.profile.id,
      profiles: [{ ...input.profile, vendorProfile: { keep: true } }],
      vendorConfig: { keep: true }, projectExport: { ...plan, vendorPlan: { keep: true } },
    }
    ipc.save.mockImplementation(async (_root, config) => ({ config, fingerprint: 'next' }))
    await saveProjectExportPlan(root, plan, input.profile, { config: existing, fingerprint: 'before' })
    expect(ipc.save).toHaveBeenCalledWith(root, expect.objectContaining({
      vendorConfig: { keep: true },
      projectExport: expect.objectContaining({ chapters, vendorPlan: { keep: true } }),
      profiles: [expect.objectContaining({ vendorProfile: { keep: true } })],
    }), 'before')
    const persisted = JSON.stringify(ipc.save.mock.calls[0][1])
    expect(persisted).not.toContain('untitled-session-id')
    expect(persisted).not.toContain('Session chapter')
    expect(persisted).not.toContain('markdown')
  })

  it('rejects nonportable chapter paths and duplicate entries before persistence', () => {
    const base = { schemaVersion: 1, mode: 'book', title: 'Book', formats: ['html'], profileId: 'technical', bookFileName: 'book', overwrite: false }
    for (const path of ['../escape.md', 'C:/absolute.md', '/absolute.md', 'a\\b.md', './one.md']) {
      expect(validateProjectExportPlan({ ...base, chapters: [{ path, title: 'One', level: 1 }] })).toBe(false)
    }
    expect(validateProjectExportPlan({ ...base, chapters: [
      { path: 'one.md', title: 'One', level: 1 }, { path: 'one.md', title: 'Again', level: 1 },
    ] })).toBe(false)
  })
})

describe('project export snapshots and output plans', () => {
  it('freezes dirty buffers, reads clean files from disk, and captures selected untitled documents only for this run', async () => {
    tabs = [
      { id: 'dirty', pathname: 'C:/project/a/one.md', filename: 'one.md', markdown: '# Dirty one', isSaved: false },
      { id: 'clean', pathname: 'C:/project/b/two.md', filename: 'two.md', markdown: '# Stale clean buffer', isSaved: true },
      { id: 'untitled', pathname: '', filename: 'Untitled-1', markdown: '# Unsaved session', isSaved: false },
      { id: 'excluded', pathname: '', filename: 'Untitled-2', markdown: '# Excluded', isSaved: false },
    ]
    const controller = createProjectExportController({ getTabs: () => tabs })
    const input = options()
    input.chapters.push({ key: 'untitled', tabId: 'untitled', title: 'Session', level: 1 })
    await controller.prepare(input)
    expect(controller.state.snapshot?.sources.map(source => source.snapshot.markdown)).toEqual(['# Dirty one', '# Disk two', '# Unsaved session'])
    expect(controller.state.snapshot?.sources.map(source => source.origin)).toEqual(['buffer', 'disk', 'untitled'])
    expect(ipc.snapshot.mock.calls[0][2]).toEqual([{ path: 'C:/project/a/one.md', markdown: '# Dirty one' }])
    tabs[0].markdown = '# Edited during export'
    tabs[2].markdown = '# Changed session'
    input.profile.theme = 'formal-report'
    input.chapters.reverse()
    await controller.run()
    expect(ipc.start.mock.calls.map(([request]) => request.snapshot.markdown)).toEqual(['# Dirty one', '# Disk two', '# Unsaved session'])
    expect(ipc.start.mock.calls.every(([request]) => request.options.theme === 'technical')).toBe(true)
  })

  it('plans unique safe names for duplicate basenames, Windows case aliases and reserved names', async () => {
    disk = { 'a/Note.md': 'one', 'b/note.md': 'two', 'c/CON.md': 'three', 'd/NUL.md': 'four' }
    const controller = createProjectExportController({ getTabs: () => tabs })
    await controller.prepare(options({ chapters: Object.keys(disk).map(path => ({ key: path, relativePath: path, title: path, level: 1 })), formats: ['html', 'docx'] }))
    const names = controller.state.items.map(item => item.outputPath.split(/[\\/]/).at(-1)!)
    expect(names).toHaveLength(8)
    expect(new Set(names.map(name => name.toLowerCase())).size).toBe(8)
    expect(names.every(name => !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))).toBe(true)
    expect(names.every(name => !/[<>:"/\\|?*]/.test(name))).toBe(true)
    expect(controller.state.items.every(item => item.outputPath.replaceAll('\\', '/').startsWith('C:/project/exports/'))).toBe(true)
  })

  it.each(['batch', 'book'] as const)('forces unattended PDF through Pandoc for %s and leaves the source preset intact', async mode => {
    const input = options({ mode, formats: ['pdf'] })
    input.profile.pdf.backend = 'system-print'
    const controller = createProjectExportController({ getTabs: () => tabs })
    await controller.prepare(input)
    await controller.run()
    expect(ipc.start).toHaveBeenCalled()
    expect(ipc.start.mock.calls.every(([request]) => request.pdfBackend === 'pandoc' && request.options.pdf.backend === 'pandoc')).toBe(true)
    expect(input.profile.pdf.backend).toBe('system-print')
  })

  it('keeps overwrite disabled by default and carries explicit replacement consent in each request', async () => {
    const controller = createProjectExportController({ getTabs: () => tabs })
    await controller.prepare(options())
    await controller.run()
    expect(ipc.start.mock.calls.every(([request]) => request.overwrite === false)).toBe(true)
    ipc.start.mockClear()
    await controller.prepare(options({ overwrite: true }))
    await controller.run()
    expect(ipc.start.mock.calls.every(([request]) => request.overwrite === true)).toBe(true)
  })

  it('rejects an oversized untitled source before any render or write', async () => {
    tabs = [{ id: 'large', pathname: '', filename: 'large.md', markdown: '字'.repeat(700_000), isSaved: false }]
    const controller = createProjectExportController({ getTabs: () => tabs })
    await controller.prepare(options({ chapters: [{ key: 'large', tabId: 'large', title: 'Large', level: 1 }] }))
    expect(controller.state.stage).toBe('failed')
    expect(controller.state.error).toContain('projectSnapshotTooLarge')
    expect(render).not.toHaveBeenCalled()
    await controller.run()
    expect(ipc.start).not.toHaveBeenCalled()
  })
})

describe('project export partial failure and retry', () => {
  it('records an individual rendering failure while preparing the remaining batch sources', async () => {
    render.mockRejectedValueOnce(new Error('bad diagram in first document'))
    const controller = createProjectExportController({ getTabs: () => tabs })
    await controller.prepare(options())
    await controller.run()
    expect(controller.state.items.filter(item => item.status === 'failed')).toHaveLength(1)
    expect(controller.state.items.filter(item => item.status === 'completed')).toHaveLength(1)
    expect(ipc.start).toHaveBeenCalledTimes(1)
    expect(ipc.start.mock.calls[0][0].snapshot.markdown).toBe('# Disk two')
  })

  it('recovers a failed render from the frozen snapshot but requires review before writing newly rendered output', async () => {
    render.mockRejectedValueOnce(new Error('temporary rendering failure'))
    const controller = createProjectExportController({ getTabs: () => tabs })
    await controller.prepare(options())
    await controller.run()
    const completed = controller.state.items.find(item => item.status === 'completed')!
    expect(completed).toBeDefined()
    await controller.retryFailed()
    expect(controller.state.stage).toBe('ready')
    expect(ipc.start).toHaveBeenCalledTimes(1)
    expect(controller.state.items.find(item => item.id === completed.id)?.status).toBe('completed')
    expect(render).toHaveBeenCalledTimes(3)
    expect(render.mock.calls[2][0].snapshot.markdown).toBe('# Disk one')
    await controller.run()
    expect(ipc.start).toHaveBeenCalledTimes(2)
    expect(ipc.start.mock.calls[1][0].snapshot.markdown).toBe('# Disk one')
    expect(controller.state.items.every(item => item.status === 'completed')).toBe(true)
  })

  it('requires explicit review if retry preflight adds a new warning', async () => {
    ipc.start.mockRejectedValueOnce(new Error('temporary output failure'))
    const controller = createProjectExportController({ getTabs: () => tabs })
    await controller.prepare(options())
    await controller.run()
    ipc.preflight.mockResolvedValueOnce({ ...preflight, warnings: [{ code: 'new-warning', message: 'Review new resource warning' }] })
    await controller.retryFailed()
    expect(controller.state.stage).toBe('ready')
    expect(controller.state.warnings.some(warning => warning.code === 'new-warning')).toBe(true)
    expect(ipc.start).toHaveBeenCalledTimes(2)
    await controller.run()
    expect(ipc.start).toHaveBeenCalledTimes(3)
  })

  it('keeps successful outputs and retries only failed entries from the reviewed snapshot', async () => {
    ipc.start.mockRejectedValueOnce(new Error('disk full'))
    const controller = createProjectExportController({ getTabs: () => tabs })
    await controller.prepare(options())
    await controller.run()
    expect(controller.state.items.map(item => item.status)).toEqual(['failed', 'completed'])
    expect(controller.state.items[0].error).toContain('disk full')
    const completed = { ...controller.state.items[1] }
    await controller.retryFailed()
    expect(ipc.start).toHaveBeenCalledTimes(3)
    expect(ipc.start.mock.calls[2][0].snapshot.markdown).toBe('# Disk one')
    expect(controller.state.items.every(item => item.status === 'completed')).toBe(true)
    expect(controller.state.items[1]).toEqual(completed)
  })

  it('refuses retry when any source version changed and preserves successful outputs', async () => {
    ipc.start.mockRejectedValueOnce(new Error('temporary failure'))
    const controller = createProjectExportController({ getTabs: () => tabs })
    await controller.prepare(options())
    await controller.run()
    disk['b/two.md'] = '# Changed after successful export'
    await controller.retryFailed()
    expect(ipc.start).toHaveBeenCalledTimes(2)
    expect(controller.state.items[1].status).toBe('completed')
    expect(controller.state.stage).toBe('stale')
  })

  it.each(['dirty', 'untitled'] as const)('refuses retry when a selected %s buffer changed', async kind => {
    tabs = [{ id: 'session', pathname: kind === 'dirty' ? 'C:/project/a/one.md' : '', filename: 'session.md', markdown: '# Original buffer', isSaved: false }]
    const input = options()
    if (kind === 'untitled') input.chapters.push({ key: 'session', tabId: 'session', title: 'Session', level: 1 })
    ipc.start.mockRejectedValueOnce(new Error('temporary failure'))
    const controller = createProjectExportController({ getTabs: () => tabs })
    await controller.prepare(input)
    await controller.run()
    const writes = ipc.start.mock.calls.length
    tabs[0].markdown = '# Buffer edited after export'
    await controller.retryFailed()
    expect(ipc.start).toHaveBeenCalledTimes(writes)
    expect(controller.state.stage).toBe('stale')
    expect(controller.state.items[1].status).toBe('completed')
  })

  it('reports an unreadable batch source separately while exporting readable entries', async () => {
    delete disk['a/one.md']
    const controller = createProjectExportController({ getTabs: () => tabs })
    await controller.prepare(options())
    await controller.run()
    expect(controller.state.items).toHaveLength(2)
    expect(controller.state.items.filter(item => item.status === 'failed')).toHaveLength(1)
    expect(controller.state.items.filter(item => item.status === 'completed')).toHaveLength(1)
    expect(ipc.start).toHaveBeenCalledTimes(1)
  })

  it('requires a fresh snapshot when retry cannot recover an unreadable source', async () => {
    delete disk['a/one.md']
    const controller = createProjectExportController({ getTabs: () => tabs })
    await controller.prepare(options())
    await controller.run()
    await controller.retryFailed()
    expect(controller.state.stage).toBe('stale')
    expect(controller.state.error).toContain('projectPrepareAgain')
    expect(ipc.start).toHaveBeenCalledTimes(1)
    expect(controller.state.items.some(item => item.status === 'completed')).toBe(true)
  })
})

describe('project export cancellation and stale requests', () => {
  it('does not restart a failed output when retry is cancelled during version recapture', async () => {
    ipc.start.mockRejectedValueOnce(new Error('temporary failure'))
    const controller = createProjectExportController({ getTabs: () => tabs })
    await controller.prepare(options())
    await controller.run()
    const captured = await ipc.snapshot(root, ['a/one.md', 'b/two.md'], [])
    const gate = deferred<ProjectExportSnapshot>()
    ipc.snapshot.mockReturnValueOnce(gate.promise)
    const retrying = controller.retryFailed()
    await controller.cancel()
    gate.resolve(captured)
    await retrying
    expect(ipc.start).toHaveBeenCalledTimes(2)
    expect(controller.state.items[1].status).toBe('completed')
  })

  it.each(['cancel', 'invalidate'] as const)('prevents all writes after %s during snapshot capture', async action => {
    const gate = deferred<ProjectExportSnapshot>()
    const captured = await ipc.snapshot(root, ['a/one.md', 'b/two.md'], [])
    ipc.snapshot.mockReturnValueOnce(gate.promise)
    const controller = createProjectExportController({ getTabs: () => tabs })
    const preparing = controller.prepare(options())
    await vi.waitFor(() => expect(controller.state.stage).toBe('preparing'))
    await controller[action]()
    gate.resolve(captured)
    await preparing
    await controller.run()
    expect(ipc.start).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'invalidate'] as const)('prevents writes after %s while an item render is awaited', async action => {
    const gate = deferred<Awaited<ReturnType<typeof render>>>()
    render.mockReturnValueOnce(gate.promise)
    const controller = createProjectExportController({ getTabs: () => tabs })
    const preparing = controller.prepare(options())
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1))
    await controller[action]()
    gate.resolve({ html: '<p>obsolete</p>', preflight, request: {} })
    await preparing
    await controller.run()
    expect(ipc.start).not.toHaveBeenCalled()
    expect(controller.state.previewHtml).not.toContain('obsolete')
  })

  it.each(['cancel', 'invalidate'] as const)('blocks requests after %s while final output preflight is awaited', async action => {
    const gate = deferred<typeof preflight>()
    ipc.preflight.mockReturnValueOnce(gate.promise)
    const controller = createProjectExportController({ getTabs: () => tabs })
    const preparing = controller.prepare(options())
    await vi.waitFor(() => expect(ipc.preflight).toHaveBeenCalledTimes(1))
    await controller[action]()
    gate.resolve(preflight)
    await preparing
    await controller.run()
    expect(ipc.start).not.toHaveBeenCalled()
  })

  it('cancels an active write and never starts a later output', async () => {
    const gate = deferred<{ status: string; outputPath: string }>()
    ipc.start.mockReturnValueOnce(gate.promise)
    const controller = createProjectExportController({ getTabs: () => tabs })
    await controller.prepare(options())
    const running = controller.run()
    await vi.waitFor(() => expect(ipc.start).toHaveBeenCalledTimes(1))
    await controller.cancel()
    expect(ipc.cancel).toHaveBeenCalledWith(ipc.start.mock.calls[0][0].taskId)
    gate.resolve({ status: 'completed', outputPath: ipc.start.mock.calls[0][0].outputPath })
    await running
    expect(ipc.start).toHaveBeenCalledTimes(1)
    expect(controller.state.items[1].status).toBe('cancelled')
  })

  it('invalidates a reviewed plan before output and disallows restarting completed items', async () => {
    const controller = createProjectExportController({ getTabs: () => tabs })
    await controller.prepare(options())
    controller.invalidate()
    await controller.run()
    expect(ipc.start).not.toHaveBeenCalled()
    await controller.prepare(options())
    await controller.run()
    await controller.run()
    expect(ipc.start).toHaveBeenCalledTimes(2)
  })
})
