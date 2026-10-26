import { describe, expect, it } from 'vitest'
import { isExternalDocumentLink, resolveDocumentLink } from '../../src/services/document-link'

describe('document link destinations', () => {
  it.each([
    ['M2_REVIEW_FIXES.md', 'C:/project/docs/M2_REVIEW_FIXES.md', ''],
    ['../M2_REVIEW_FIXES.md#整改记录', 'C:/project/M2_REVIEW_FIXES.md', '整改记录'],
    ['./%E5%AE%A1%E6%9F%A5%20%E8%AE%B0%E5%BD%95.md', 'C:/project/docs/审查 记录.md', ''],
    ['percent%2520.md', 'C:/project/docs/percent%20.md', ''],
    ['review\\(final\\).md', 'C:/project/docs/review(final).md', ''],
    ['hash%23name.md', 'C:/project/docs/hash#name.md', ''],
    ['file:///D:/notes/review.md#Fixes', 'D:/notes/review.md', 'Fixes'],
    ['D:/notes/review.md', 'D:/notes/review.md', ''],
    ['#Fixes', 'C:\\project\\docs\\README.md', 'Fixes'],
  ])('resolves %s relative to the actual source document', (href, path, heading) => {
    expect(resolveDocumentLink(href, 'C:\\project\\docs\\README.md')).toEqual({ path, heading })
  })

  it('refuses to invent a base directory for an untitled document', () => {
    expect(resolveDocumentLink('review.md', '').path).toBeNull()
  })

  it.each(['https://example.com/review.md', 'mailto:someone@example.com', '//example.com/review.md'])('keeps %s external', href => {
    expect(isExternalDocumentLink(href)).toBe(true)
  })
  it.each(['review.md', 'C:/notes/review.md', 'file:///C:/notes/review.md', '#Fixes'])('keeps %s in the editor', href => {
    expect(isExternalDocumentLink(href)).toBe(false)
  })
})
