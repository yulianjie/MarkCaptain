import { describe, expect, it } from 'vitest'
import { captureExportSnapshot, projectForExport, projectOutputDirectory, suggestedExportFileName } from '../../src/services/export/snapshot'
import { createExportRequest } from '../../src/services/export/request'
import { BUILTIN_PROFILES } from '../../src/services/export/profiles'

describe('export snapshots and requests', () => {
  it('freezes the active buffer without saving or following later edits', () => {
    const document = { markdown: '# Before', pathname: 'C:\\project\\notes.md', filename: 'notes.md' }
    const snapshot = captureExportSnapshot(document)
    document.markdown = '# After'

    expect(snapshot.markdown).toBe('# Before')
    expect(snapshot.sourcePath).toBe('C:\\project\\notes.md')
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(snapshot.revision).toBeTruthy()
  })

  it('expands a safe output name and keeps the configured directory inside the project', () => {
    const snapshot = captureExportSnapshot({ markdown: '# Note', pathname: '', filename: 'notes.md' })
    const filename = suggestedExportFileName('{name}-{profile}-{date}', snapshot, 'Formal / Report', 'docx')
    expect(filename).toMatch(/^notes-Formal _ Report-\d{4}-\d{2}-\d{2}\.docx$/)
    expect(projectOutputDirectory('C:\\work\\book', 'exports')).toBe('C:\\work\\book\\exports')
    expect(projectOutputDirectory('/work/book', 'exports')).toBe('/work/book/exports')
  })

  it('copies a resolved profile into a unique output request tied to the frozen revision', () => {
    const snapshot = captureExportSnapshot({ markdown: '# Note', pathname: '', filename: 'note.md' })
    const profile = structuredClone(BUILTIN_PROFILES.technical)
    const request = createExportRequest({
      snapshot,
      profileId: profile.id,
      configSource: 'project',
      format: 'pdf',
      pdfBackend: 'pandoc',
      options: profile,
      outputPath: '/tmp/note.pdf',
      renderedHtml: '<!doctype html><h1>Note</h1>',
    })
    profile.theme = 'formal-report'

    expect(request.taskId).toBeTruthy()
    expect(request.snapshot.revision).toBe(snapshot.revision)
    expect(request.options.theme).toBe('technical')
    expect(request.pdfBackend).toBe('pandoc')
    expect(request.renderedHtml).toContain('<h1>Note</h1>')
    expect(Object.isFrozen(request)).toBe(true)
  })

  it('scopes project settings by normalized path components, including Windows verbatim paths', () => {
    const root = 'C:\\Work\\Notes'
    expect(projectForExport(undefined, root)).toBe(root)
    expect(projectForExport('c:/work/notes/sub/../draft.md', root)).toBe(root)
    expect(projectForExport('\\\\?\\C:\\Work\\Notes\\draft.md', root)).toBe(root)
    expect(projectForExport('C:\\Work\\Notes-old\\draft.md', root)).toBeUndefined()
    expect(projectForExport('C:\\Work\\Notes\\..\\Notes-old\\draft.md', root)).toBeUndefined()
    expect(projectForExport('\\\\?\\UNC\\server\\share\\notes\\draft.md', '\\\\server\\share\\notes')).toBe('\\\\server\\share\\notes')
    expect(projectForExport('/work/Notes/draft.md', '/work/Notes')).toBe('/work/Notes')
    expect(projectForExport('/work/notes/draft.md', '/work/Notes')).toBeUndefined()
  })
})
