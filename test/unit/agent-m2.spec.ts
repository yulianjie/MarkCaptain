import { describe, expect, it } from 'vitest'
import { pathIsInsideRoot } from '../../src/stores/project'
import {
  isSafeWebQuery,
  normalizeProjectConfig, parseProjectSource, snapshotDirtyProjectBuffers,
  suggestDocumentQueries, validateDocumentCheck, validateProjectPatterns,
  validateProjectReadReferences, validatePublicUrl, validateWebResearch,
} from '../../src/services/agent-m2'

describe('Agent M2 local-project and request preparation helpers', () => {
  it('preserves unknown config fields and leaves unknown schema versions intact', () => {
    const config = normalizeProjectConfig({ schemaVersion: 3, extensions: { keep: true }, writing: { tone: 'plain', futureRule: 4 } })
    expect(config.schemaVersion).toBe(3)
    expect(config.extensions).toEqual({ keep: true })
    expect(config.writing?.futureRule).toBe(4)
    expect(config.writing?.language).toBe('')
    expect(config.projectSearch?.include).toEqual(['**/*.md'])
  })

  it('freezes root-local dirty Markdown for authoritative backend glob filtering', () => {
    const buffers = snapshotDirtyProjectBuffers([
      { pathname: 'C:\\vault\\notes\\draft.md', markdown: 'dirty', isSaved: false },
      { pathname: 'C:\\vault\\private\\secret.md', markdown: 'excluded', isSaved: false },
      { pathname: 'C:\\vault\\notes\\saved.md', markdown: 'saved', isSaved: true },
      { pathname: 'C:\\outside\\other.md', markdown: 'elsewhere', isSaved: false },
      { pathname: 'C:\\vault\\image.png', markdown: 'binary', isSaved: false },
    ], 'C:\\vault', pathIsInsideRoot)
    expect(buffers).toEqual([{ path: 'C:\\vault\\notes\\draft.md', markdown: 'dirty' },
      { path: 'C:\\vault\\private\\secret.md', markdown: 'excluded' }])
  })

  it('rejects project pattern escape paths and enforces backend limits', () => {
    expect(() => validateProjectPatterns(['../outside.md'], [])).toThrow('agent:projectPatternInvalid')
    expect(() => validateProjectPatterns(Array.from({ length: 65 }, () => '**/*.md'), [])).toThrow('agent:projectPatternInvalid')
  })

  it('keeps document-derived search suggestions local until the caller approves them', () => {
    expect(suggestDocumentQueries('# Intro\n## Design\nBody', 'research topic')).toEqual(['research topic', 'Intro', 'Design'])
    expect(suggestDocumentQueries('# C:\\Users\\jack\\notes.md\n## Public summary')).toEqual(['Public summary'])
    expect(isSafeWebQuery('api_key=sk-example-secret')).toBe(false)
    const request = validateWebResearch({ enabled: true, topic: 'topic', allowDocumentQueries: true, approvedQueries: ['approved phrase'], urls: [], publicDns: true })
    expect(request.publicDns).toBe(true)
    expect(request.approvedQueries).toEqual(['approved phrase'])
    expect(() => validateWebResearch({ ...request, approvedQueries: Array.from({ length: 9 }, (_, i) => `q${i}`) })).toThrow('agent:webResearchLimit')
    expect(() => validateWebResearch({ ...request, approvedQueries: ['x'.repeat(321)] })).toThrow('agent:webResearchLimit')
    expect(() => validateWebResearch({ ...request, approvedQueries: ['C:\\Users\\jack\\notes.md'] })).toThrow('agent:webQueryRejected')
  })

  it('rejects credentialed and private URLs while allowing public HTTP URLs for warning cards', () => {
    expect(validatePublicUrl('https://user:pass@example.com/secret')).toBeNull()
    expect(validatePublicUrl('http://127.0.0.1:8080/')).toBeNull()
    expect(validatePublicUrl('https://example.com/article')).toBe('https://example.com/article')
    expect(validatePublicUrl('http://example.com/article')).toBe('http://example.com/article')
    expect(() => validateWebResearch({ enabled: true, topic: '', allowDocumentQueries: false, approvedQueries: [], urls: ['file:///secret'], publicDns: false })).toThrow('agent:webUrlInvalid')
  })

  it('accepts read-only project snapshots only when the opaque id, range, and root agree', () => {
    const markdown = '# 中文\nsource'
    const documentId = 'project-00000000-0000-4000-8000-000000000001-00000000-0000-4000-8000-000000000002'
    const source = parseProjectSource({ documentId, snapshot: {
      tabId: `project-${documentId}`, name: 'notes/a.md', markdown, from: 0, to: markdown.length,
      path: 'C:\\vault\\notes\\a.md', snapshotId: `request-id:${documentId}`,
    } }, 'C:\\vault', pathIsInsideRoot, 'request-id')
    expect(source?.snapshot.path).toBe('C:/vault/notes/a.md')
    expect(parseProjectSource({ documentId: 'doc', snapshot: { tabId: 'project-doc', name: 'x', markdown, from: 0, to: markdown.length,
      path: 'C:\\outside\\x.md', snapshotId: 'id' } }, 'C:\\vault', pathIsInsideRoot)).toBeNull()
  })

  it('normalizes native Windows verbatim/UNC paths before scope checks and dirty-buffer filtering', () => {
    const documentId = 'project-00000000-0000-4000-8000-000000000001-00000000-0000-4000-8000-000000000002'
    const markdown = '未保存 😀'
    const source = (path: string) => ({ documentId, snapshot: { tabId: `project-${documentId}`, name: 'notes/a.md', markdown,
      from: 0, to: markdown.length, path, snapshotId: `request:${documentId}` } })
    expect(parseProjectSource(source('\\\\?\\C:\\Vault\\notes\\a.md'), 'c:/vault', pathIsInsideRoot, 'request')?.snapshot.path).toBe('C:/Vault/notes/a.md')
    expect(parseProjectSource(source('\\\\?\\UNC\\Server\\Share\\notes\\a.md'), '\\\\server\\share', pathIsInsideRoot, 'request')?.snapshot.path).toBe('//Server/Share/notes/a.md')
    expect(parseProjectSource(source('\\\\?\\C:\\vault\\..\\outside\\a.md'), 'C:/vault', pathIsInsideRoot, 'request')).toBeNull()
    expect(snapshotDirtyProjectBuffers([{ pathname: '\\\\?\\C:\\Vault\\notes\\a.md', markdown, isSaved: false }],
      'c:/vault', pathIsInsideRoot)).toHaveLength(1)
  })

  it('bounds actual project read receipts separately from the 8 manual attachment limit', () => {
    const references = Array.from({ length: 40 }, (_, index) => {
      const documentId = `project-00000000-0000-4000-8000-000000000001-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
      const markdown = `source ${index}`
      return { documentId, snapshot: { tabId: `project-${documentId}`, name: `docs/${index}.md`, markdown,
        from: 0, to: markdown.length, path: `C:\\vault\\docs\\${index}.md` } }
    })
    expect(() => validateProjectReadReferences(references, 'C:\\vault', pathIsInsideRoot)).not.toThrow()
    expect(() => validateProjectReadReferences([...references, references[0]!], 'C:\\vault', pathIsInsideRoot)).toThrow('agent:projectReferenceLimit')
  })

  it('filters local issues whose UTF-16 ranges do not match their captured evidence', () => {
    const markdown = '# 中文\ntext'
    const goodFrom = markdown.indexOf('中文')
    const value = validateDocumentCheck({ issues: [
      { id: 'ok', kind: 'heading', severity: 'warning', message: 'heading', from: goodFrom, to: goodFrom + 2, line: 1, column: 3, evidence: '中文' },
      { id: 'bad', kind: 'link', severity: 'warning', message: 'bad', from: 0, to: 2, line: 1, column: 1, evidence: 'wrong' },
    ], complete: true, externalLinksUnchecked: 2, localTargetsChecked: 1, truncated: false, scope: 'local' }, markdown)
    expect(value.issues.map(issue => issue.id)).toEqual(['ok'])
    expect(value.complete).toBe(false)
    expect(value.truncated).toBe(true)
  })
})
