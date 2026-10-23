import { describe, expect, it } from 'vitest'
import { buildReviewDiff, inlineMarkdownDiff } from '../../src/services/agent-review-diff'

describe('Agent review diff', () => {
  it('highlights a small CJK wording change at word or character granularity', () => {
    const diff = inlineMarkdownDiff('这是一段旧的说明', '这是一段新的说明', 'zh-CN')
    expect(diff.before.filter(part => part.kind === 'removed').map(part => part.text).join('')).toContain('旧')
    expect(diff.after.filter(part => part.kind === 'added').map(part => part.text).join('')).toContain('新')
    expect(diff.before.filter(part => part.kind === 'same').map(part => part.text).join('')).toContain('这是一段')
  })

  it('exposes a Markdown link destination change even when the visible label stays the same', () => {
    const diff = buildReviewDiff({ oldText: 'Read [the guide](old/guide.md).', newText: 'Read [the guide](new/guide.md).' }, 'en')
    expect(diff.links).toEqual([{ syntax: 'markdown', labelBefore: 'the guide', labelAfter: 'the guide', targetBefore: 'old/guide.md', targetAfter: 'new/guide.md' }])
  })

  it('shows table cells, fenced code, and frontmatter fields in structured view', () => {
    const table = buildReviewDiff({ oldText: '| Name | State |\n| --- | --- |\n| Intro | Draft |', newText: '| Name | State |\n| --- | --- |\n| Intro | Ready |' })
    expect(table.table?.rows[1]?.[1]).toEqual({ before: 'Draft', after: 'Ready', changed: true })
    const code = buildReviewDiff({ oldText: '```ts\nconst count = 1\n```', newText: '```ts\nconst count = 2\n```' })
    expect(code.code).toMatchObject({ languageBefore: 'ts', languageAfter: 'ts', before: ['const count = 1'], after: ['const count = 2'] })
    const frontmatter = buildReviewDiff({ oldText: '---\ntitle: Draft\ntags: [a]\n---\nBody', newText: '---\ntitle: Final\ntags: [a]\n---\nBody' })
    expect(frontmatter.frontmatter).toContainEqual({ key: 'title', before: 'Draft', after: 'Final', changed: true })
  })

  it('keeps a raw Markdown diff available and bounds pathological fine diffs', () => {
    const value = 'a '.repeat(800)
    const before = inlineMarkdownDiff(value, `${'b '.repeat(800)}`, 'en')
    expect(before.before.some(part => part.kind === 'removed')).toBe(true)
    const review = buildReviewDiff({ oldText: 'same\nold\ntail', newText: 'same\nnew\ntail' })
    expect(review.raw.map(line => line.kind)).toEqual(['same', 'removed', 'added', 'same'])
  })
})
