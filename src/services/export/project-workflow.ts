import { exportCancel, exportPreflight, exportProjectSnapshot, exportStart } from '@/services/tauri-invoke'
import { composeExportBook, prepareProjectLinkMarkdown, rewriteExportBatchLinks, type PreparedExportChapter } from './book'
import { validateExportProjectConfig } from './profiles'
import { createExportRequest } from './request'
import { restoreExternalImageLinks } from './resources'
import { projectForExport, projectOutputDirectory, suggestedExportFileName } from './snapshot'
import { renderExportPreview } from './workflow'
import type { ExportDiagnostic, ExportFormat, ExportRequest } from './types'
import type { ProjectExportChapter, ProjectExportItem, ProjectExportOptions, ProjectExportSnapshot, ProjectExportSource, ProjectExportState, ProjectExportTab } from './project-types'

const MAX_DOCUMENTS = 64
const MAX_DOCUMENT_BYTES = 2_000_000
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024
const MAX_RENDERED_BYTES = 48 * 1024 * 1024
const formats: ExportFormat[] = ['html', 'pdf', 'docx', 'odt', 'epub']
const bytes = (value: string) => new TextEncoder().encode(value).length
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)
const aborted = (cause: unknown) => /cancelled|canceled|AbortError/i.test(errorText(cause))
const portable = (value: string) => value.replace(/\\/g, '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '').replace(/\/+$/, '')
const pathKey = (value: string) => /^[a-z]:\//i.test(portable(value)) || portable(value).startsWith('//') ? portable(value).toLowerCase() : portable(value)
const diagnostic = (code: string, message = code): ExportDiagnostic => ({ code, message })

async function digest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('')
}
function safeStem(value: string): string {
  let result = Array.from(value, character => {
    const code = character.codePointAt(0) ?? 0
    return /[<>:"/\\|?*]/.test(character) || code < 32 || code === 127 ? '_' : character
  }).join('').replace(/[. ]+$/g, '').replace(/^\.+/, '')
  let bounded = ''
  for (const character of result) {
    if (bytes(bounded + character) > 140) break
    bounded += character
  }
  result = bounded
  if (!result) result = 'document'
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(result)) result = `_${result}`
  return result
}

export function createProjectExportController(dependencies: {
  getTabs: () => readonly ProjectExportTab[]
  onChange?: (state: ProjectExportState) => void
  muya?: unknown
}) {
  const state: ProjectExportState = { stage: 'idle', snapshot: null, items: [], warnings: [], blocking: [], previewHtml: '', error: '' }
  let version = 0, disposed = false, stopped = false
  let options: ProjectExportOptions | null = null
  let abortController: AbortController | null = null
  let activeTaskId: string | null = null
  let preparedComplete = false
  let rendererContext: { options: Record<string, unknown> } = { options: { footnote: true } }
  const renderedCache = new Map<string, PreparedExportChapter>()
  const failedRenders = new Set<string>()
  const requests = new Map<string, ExportRequest>()
  const changed = () => { dependencies.onChange?.(state) }
  const current = (expected: number) => expected === version && !disposed && !stopped
  const assertCurrent = (expected: number) => { if (!current(expected)) throw new DOMException('Export cancelled', 'AbortError') }
  const warningKey = (warning: ExportDiagnostic) => JSON.stringify([warning.code, warning.message, warning.resource])
  function deduplicateWarnings() { state.warnings = [...new Map(state.warnings.map(warning => [warningKey(warning), warning])).values()] }

  async function renderSource(source: ProjectExportSource, input: ProjectExportOptions, expected: number): Promise<PreparedExportChapter> {
    const chapter = chapterFor(source, input)
    const profile = clone(input.profile)
    if (input.mode === 'book') { profile.toc.enabled = false; profile.html.showTitle = false }
    const normalized = prepareProjectLinkMarkdown(source.snapshot, source.relativePath)
    const result = await renderExportPreview({ snapshot: { ...source.snapshot, markdown: normalized.markdown }, profile, format: 'html',
      projectRoot: input.root, profileId: profile.id, configSource: 'project', language: input.language, muya: rendererContext, signal: abortController?.signal })
    assertCurrent(expected)
    if (result.preflight.blocking.length) throw new Error(result.preflight.blocking.map(issue => issue.message).join('\n'))
    state.warnings.push(...normalized.warnings, ...result.preflight.warnings)
    return { sourceId: source.sourceId, relativePath: source.relativePath, snapshot: source.snapshot, title: chapter.title, level: chapter.level, order: input.chapters.indexOf(chapter), html: result.html }
  }

  function validate(input: ProjectExportOptions) {
    if (!input.root || !['batch', 'book'].includes(input.mode) || !input.chapters.length || input.chapters.length > MAX_DOCUMENTS) throw new Error('export:invalidProjectSelection')
    if (!input.formats.length || input.formats.length > 5 || new Set(input.formats).size !== input.formats.length || input.formats.some(format => !formats.includes(format) || !input.profile.formats.includes(format))) throw new Error('export:invalidFormats')
    if (!validateExportProjectConfig({ schemaVersion: 1, profiles: [input.profile], defaultProfile: input.profile.id })) throw new Error('export:invalidProfile')
    if (!input.title.trim() || bytes(input.title) > 200 || !input.bookFileName.trim() || bytes(input.bookFileName) > 120) throw new Error('export:invalidProjectTitle')
    const seen = new Set<string>()
    for (const chapter of input.chapters) {
      const relative = chapter.relativePath?.replace(/\\/g, '/')
      if (!chapter.key || !chapter.title.trim() || bytes(chapter.title) > 200 || !Number.isInteger(chapter.level) || chapter.level < 1 || chapter.level > 5
        || relative !== undefined && (!relative || relative.startsWith('/') || relative.includes(':') || relative.split('/').some(part => !part || part === '.' || part === '..'))
        || !relative && !chapter.tabId) throw new Error('export:invalidProjectChapter')
      const key = relative ? pathKey(`${input.root}/${relative}`) : `untitled:${chapter.tabId}`
      if (seen.has(key)) throw new Error('export:duplicateProjectChapter')
      seen.add(key)
    }
  }

  async function capture(input: ProjectExportOptions): Promise<ProjectExportSnapshot> {
    const tabs = dependencies.getTabs().map(tab => ({ ...tab }))
    const selectedPaths = input.chapters.flatMap(chapter => chapter.relativePath ? [chapter.relativePath] : [])
    const selected = new Set(selectedPaths.map(relative => pathKey(`${input.root}/${relative}`)))
    const buffers = tabs.filter(tab => !tab.isSaved && tab.pathname && projectForExport(tab.pathname, input.root)
      && selected.has(pathKey(tab.pathname))).map(tab => ({ path: tab.pathname!, markdown: tab.markdown }))
    const captured = selectedPaths.length ? await exportProjectSnapshot(input.root, selectedPaths, buffers)
      : { root: input.root, sources: [], errors: [], capturedAt: new Date().toISOString(), revision: '' }
    const result = clone(captured)
    const saved = new Map(result.sources.map(source => [pathKey(`${input.root}/${source.relativePath}`), source]))
    const ordered: ProjectExportSource[] = []
    for (const chapter of input.chapters) {
      if (chapter.relativePath) {
        const source = saved.get(pathKey(`${input.root}/${chapter.relativePath}`))
        if (source) ordered.push(source)
        else if (!result.errors.some(error => pathKey(`${input.root}/${error.relativePath}`) === pathKey(`${input.root}/${chapter.relativePath}`))) result.errors.push({ relativePath: chapter.relativePath, code: 'export:projectSourceUnavailable' })
      } else {
        const tab = tabs.find(tab => tab.id === chapter.tabId && !tab.pathname)
        if (!tab) throw new Error('export:untitledSourceChanged')
        const revision = await digest(tab.markdown)
        ordered.push({ sourceId: `untitled-${tab.id}`, tabId: tab.id, revision, origin: 'untitled', snapshot: { markdown: tab.markdown, fileName: tab.filename || 'untitled.md', capturedAt: result.capturedAt, revision } })
      }
    }
    if (ordered.length > MAX_DOCUMENTS || ordered.some(source => bytes(source.snapshot.markdown) > MAX_DOCUMENT_BYTES)
      || ordered.reduce((total, source) => total + bytes(source.snapshot.markdown), 0) > MAX_SNAPSHOT_BYTES) throw new Error('export:projectSnapshotTooLarge')
    if (new Set(ordered.map(source => source.sourceId)).size !== ordered.length) throw new Error('export:duplicateProjectChapter')
    result.sources = ordered
    result.revision = await digest(JSON.stringify({ sources: ordered.map(source => [source.sourceId, source.revision]), errors: result.errors }))
    return result
  }

  function chapterFor(source: ProjectExportSource, input: ProjectExportOptions): ProjectExportChapter {
    return input.chapters.find(chapter => source.relativePath ? chapter.relativePath && pathKey(`${input.root}/${chapter.relativePath}`) === pathKey(`${input.root}/${source.relativePath}`) : chapter.tabId === source.tabId)!
  }
  function outputNames(snapshot: ProjectExportSnapshot, input: ProjectExportOptions, format: ExportFormat): Record<string, string> {
    const names: Record<string, string> = {}
    const used = new Set<string>()
    for (const source of snapshot.sources) {
      const proposed = suggestedExportFileName(input.profile.output.fileName, source.snapshot, input.profile.name, format).replace(new RegExp(`\\.${format}$`, 'i'), '')
      // Source IDs are stable across snapshots. The encoded suffix remains
      // injective even for mock/legacy IDs, and never includes a local path.
      const suffix = Array.from(new TextEncoder().encode(source.sourceId), byte => byte.toString(16).padStart(2, '0')).join('').slice(-48)
      let name = `${safeStem(proposed)}--${suffix}.${format}`
      let count = 1
      while (used.has(name.toLowerCase())) name = `${safeStem(proposed)}--${suffix}-${count++}.${format}`
      used.add(name.toLowerCase()); names[source.sourceId] = name
    }
    return names
  }
  async function queueRequest(item: ProjectExportItem, request: ExportRequest, expected: number) {
    requests.set(item.id, request)
    try {
      const preflight = await exportPreflight(request)
      assertCurrent(expected)
      item.warnings.push(...preflight.warnings)
      state.warnings.push(...preflight.warnings)
      if (preflight.blocking.length) throw new Error(preflight.blocking.map(issue => issue.message).join('\n'))
      item.status = 'ready'
    } catch (cause) {
      if (!current(expected)) throw cause
      item.status = 'failed'; item.error = errorText(cause)
    }
    changed()
  }

  async function prepare(input: ProjectExportOptions) {
    await cancel()
    const expected = ++version
    stopped = false
    abortController = new AbortController()
    requests.clear()
    renderedCache.clear(); failedRenders.clear()
    preparedComplete = false
    Object.assign(state, { stage: 'preparing', snapshot: null, items: [], warnings: [], blocking: [], previewHtml: '', error: '' })
    changed()
    try {
      const { muya, ...serializable } = input
      options = clone(serializable)
      const renderer = muya ?? dependencies.muya
      const provided = renderer && typeof renderer === 'object' && 'options' in renderer ? (renderer as { options: Record<string, unknown> }).options : {}
      rendererContext = { options: { footnote: true, ...Object.fromEntries(['superSubScript', 'isGitlabCompatibilityEnabled', 'mermaidTheme', 'sequenceTheme', 'vegaTheme']
        .filter(key => typeof provided[key] === 'boolean' || typeof provided[key] === 'string').map(key => [key, provided[key]])) } }
      validate(options)
      // Automatic project PDF is always a file-producing Pandoc task.
      options.profile.pdf.backend = 'pandoc'
      const frozen = options
      const snapshot = await capture(frozen)
      assertCurrent(expected)
      state.snapshot = snapshot
      const directory = projectOutputDirectory(frozen.root, frozen.profile.output.directory)!
      const prepared: PreparedExportChapter[] = []
      let renderedBytes = 0
      for (const source of snapshot.sources) {
        assertCurrent(expected)
        try {
          const result = await renderSource(source, frozen, expected)
          renderedBytes += bytes(result.html)
          if (renderedBytes > MAX_RENDERED_BYTES) throw new Error('export:projectRenderedTooLarge')
          prepared.push(result)
          renderedCache.set(source.sourceId, result)
          changed()
        } catch (cause) {
          assertCurrent(expected)
          if (errorText(cause) === 'export:projectRenderedTooLarge') throw cause
          failedRenders.add(source.sourceId)
          snapshot.errors.push({ relativePath: source.relativePath ?? source.snapshot.fileName, code: errorText(cause) })
        }
      }
      if (frozen.mode === 'book' && snapshot.errors.length) {
        state.blocking.push({ ...diagnostic('export:bookSourceMissing', 'Every selected chapter must be readable before building a book.'), blocking: true })
      }
      for (const format of frozen.formats) {
        assertCurrent(expected)
        if (frozen.mode === 'book') {
          if (!prepared.length || state.blocking.length) continue
          const book = composeExportBook({ chapters: prepared, title: frozen.title, toc: frozen.profile.toc, language: frozen.language })
          state.warnings.push(...book.warnings); state.blocking.push(...book.blocking)
          if (bytes(book.html) > MAX_RENDERED_BYTES) throw new Error('export:projectRenderedTooLarge')
          const name = `${safeStem(frozen.bookFileName.replace(/\.(?:html|pdf|docx|odt|epub)$/i, ''))}.${format}`
          const item: ProjectExportItem = { id: `book:${format}`, name, format, outputPath: `${directory}/${name}`, status: 'pending', warnings: [...book.warnings] }
          state.items.push(item)
          const manifest = JSON.stringify(snapshot.sources.map(source => ({ id: source.sourceId, path: source.relativePath, revision: source.revision })))
          const bookSnapshot = { markdown: manifest, fileName: `${safeStem(frozen.bookFileName)}.md`, sourcePath: snapshot.sources.find(source => source.snapshot.sourcePath)?.snapshot.sourcePath, capturedAt: snapshot.capturedAt, revision: snapshot.revision }
          await queueRequest(item, createExportRequest({ snapshot: bookSnapshot, projectRoot: frozen.root, profileId: frozen.profile.id, configSource: 'project', format, options: frozen.profile,
            outputPath: item.outputPath, renderedHtml: format === 'html' ? restoreExternalImageLinks(book.html) : book.html, overwrite: frozen.overwrite }), expected)
          if (!state.previewHtml) state.previewHtml = book.html
        } else {
          const names = outputNames(snapshot, frozen, format)
          const linked = rewriteExportBatchLinks(prepared, format, names)
          state.warnings.push(...linked.warnings); state.blocking.push(...linked.blocking)
          for (const chapter of linked.chapters) {
            const source = snapshot.sources.find(source => source.sourceId === chapter.sourceId)!
            const item: ProjectExportItem = { id: `${source.sourceId}:${format}`, sourceId: source.sourceId, name: names[source.sourceId], format, outputPath: `${directory}/${names[source.sourceId]}`, status: 'pending', warnings: [] }
            state.items.push(item)
            await queueRequest(item, createExportRequest({ snapshot: source.snapshot, projectRoot: frozen.root, profileId: frozen.profile.id, configSource: 'project', format, options: frozen.profile,
              outputPath: item.outputPath, renderedHtml: format === 'html' ? restoreExternalImageLinks(chapter.html) : chapter.html, overwrite: frozen.overwrite }), expected)
            if (!state.previewHtml) state.previewHtml = chapter.html
          }
          for (const error of snapshot.errors) {
            const source = snapshot.sources.find(source => (source.relativePath ?? source.snapshot.fileName) === error.relativePath)
            state.items.push({ id: source ? `${source.sourceId}:${format}` : `unreadable:${error.relativePath}:${format}`, sourceId: source?.sourceId, name: error.relativePath, format, outputPath: '', status: 'failed', error: error.code, warnings: [] })
          }
        }
      }
      assertCurrent(expected)
      preparedComplete = true
      deduplicateWarnings()
      state.stage = state.blocking.length || !state.items.some(item => item.status === 'ready') ? 'failed' : 'ready'
      if (state.stage === 'failed' && !state.error) state.error = state.blocking[0]?.message ?? 'export:noReadyItems'
      changed()
    } catch (cause) {
      if (expected !== version || disposed) return
      state.stage = stopped || aborted(cause) ? 'cancelled' : 'failed'
      state.error = aborted(cause) ? '' : errorText(cause)
      changed()
    }
  }

  async function run() {
    if (disposed || state.stage !== 'ready' || state.blocking.length) return
    const expected = version
    stopped = false; state.stage = 'running'; state.error = ''; changed()
    for (const item of state.items) {
      if (!current(expected)) break
      if (item.status !== 'ready') continue
      const request = requests.get(item.id)
      if (!request) continue
      item.status = 'writing'; activeTaskId = request.taskId; changed()
      try {
        await exportStart(request)
        if (version === expected && !disposed) { item.status = 'completed'; item.error = undefined }
      } catch (cause) {
        if (version === expected && !disposed) { item.status = stopped || aborted(cause) ? 'cancelled' : 'failed'; item.error = errorText(cause) }
      } finally { if (activeTaskId === request.taskId) activeTaskId = null }
      if (expected === version) changed()
    }
    if (expected !== version || disposed) return
    state.stage = stopped ? 'cancelled' : state.items.some(item => item.status === 'completed') ? 'completed' : 'failed'
    changed()
  }
  async function cancel() {
    stopped = true
    abortController?.abort()
    const id = activeTaskId
    for (const item of state.items) if (['pending', 'ready', 'rendering'].includes(item.status)) item.status = 'cancelled'
    if (['preparing', 'running', 'ready'].includes(state.stage)) state.stage = 'cancelled'
    changed()
    if (id) try { await exportCancel(id) } catch { /* completed tasks need no cancellation */ }
  }
  async function retryFailed() {
    if (!options || !state.snapshot || disposed || ['preparing', 'running', 'stale'].includes(state.stage)) return
    if (!preparedComplete) { state.error = 'export:projectPrepareAgain'; state.stage = 'stale'; changed(); return }
    if (state.items.some(item => item.status === 'failed' && !item.sourceId && !requests.has(item.id))) {
      state.error = 'export:projectPrepareAgain'; state.stage = 'stale'; changed(); return
    }
    const expected = ++version
    stopped = false
    abortController = new AbortController()
    const reviewedWarnings = new Set(state.warnings.map(warningKey))
    let needsReview = false
    state.stage = 'preparing'; state.error = ''; changed()
    try {
      const recaptured = await capture(options)
      assertCurrent(expected)
      if (recaptured.revision !== state.snapshot.revision) throw new Error('export:projectSnapshotChanged')
      for (const sourceId of [...failedRenders]) {
        const source = state.snapshot.sources.find(source => source.sourceId === sourceId)!
        const recovered = await renderSource(source, options, expected)
        renderedCache.set(sourceId, recovered)
        if ([...renderedCache.values()].reduce((total, chapter) => total + bytes(chapter.html), 0) > MAX_RENDERED_BYTES) throw new Error('export:projectRenderedTooLarge')
        for (const format of options.formats) {
          const names = outputNames(state.snapshot, options, format)
          const linked = rewriteExportBatchLinks([...renderedCache.values()], format, names)
          const chapter = linked.chapters.find(chapter => chapter.sourceId === sourceId)!
          state.warnings.push(...linked.warnings)
          const item = state.items.find(item => item.id === `${sourceId}:${format}`)!
          item.name = names[sourceId]; item.outputPath = `${projectOutputDirectory(options.root, options.profile.output.directory)}/${item.name}`
          requests.set(item.id, createExportRequest({ snapshot: source.snapshot, projectRoot: options.root, profileId: options.profile.id, configSource: 'project', format, options: options.profile,
            outputPath: item.outputPath, renderedHtml: format === 'html' ? restoreExternalImageLinks(chapter.html) : chapter.html, overwrite: options.overwrite }))
          state.previewHtml = chapter.html
        }
        failedRenders.delete(sourceId)
        needsReview = true
      }
      for (const item of state.items) if (['failed', 'cancelled'].includes(item.status) && requests.has(item.id)) {
        const request = requests.get(item.id)!
        // New task identity keeps terminal events/cancellation independent.
        await queueRequest(item, createExportRequest({ ...request, snapshot: request.snapshot, options: request.options, configSource: request.configSource }), expected)
      }
      if (!state.items.some(item => item.status === 'ready')) { state.stage = state.items.some(item => item.status === 'completed') ? 'completed' : 'failed'; changed(); return }
      deduplicateWarnings()
      needsReview ||= state.warnings.some(warning => !reviewedWarnings.has(warningKey(warning)))
      state.stage = 'ready'; changed()
      if (!needsReview) await run()
    } catch (cause) {
      if (expected !== version || disposed) return
      state.error = stopped || aborted(cause) ? '' : errorText(cause)
      state.stage = stopped || aborted(cause) ? 'cancelled' : 'stale'; changed()
    }
  }
  function invalidate() {
    void cancel()
    version++
    state.stage = 'stale'; changed()
  }
  function dispose() { void cancel(); disposed = true; version++ }
  return { state, prepare, run, cancel, retryFailed, invalidate, dispose }
}
