import { describe, expect, it } from 'vitest'
import { expandTemplate, frontmatter, fuzzyScore, newNotePath, noteAliases } from '../../src/services/notebook'
import { updateProperty } from '../../src/services/note-properties'
describe('notebook paths, aliases and templates', () => {
  it('rejects traversal, absolute paths and Windows filename hazards', () => {
    for (const value of ['../a', '/a', 'C:/a', 'a/../b', 'a//b', 'a?', 'a.']) expect(() => newNotePath(value)).toThrow()
    expect(newNotePath('项目/会议')).toBe('项目/会议.md')
  })
  it('ranks an exact alias above a fuzzy path and handles Chinese', () => {
    expect(fuzzyScore('会议', '会议')).toBeGreaterThan(fuzzyScore('会议', '项目/会议笔记.md'))
    expect(fuzzyScore('abc', 'a/b/c.md')).toBeGreaterThan(0)
    expect(fuzzyScore('abc', 'notes')).toBe(-1)
    expect(noteAliases('---\naliases: [会议, "Weekly sync"]\n---\nbody')).toEqual(['会议', 'Weekly sync'])
  })
  it('expands local calendar variables without interpreting unknown variables', () => {
    const date = new Date(2026, 9, 14, 9, 5)
    expect(expandTemplate('{{title}} {{date}} {{time}} {{date:YYYY/MM}} {{unknown}}', '测试', date)).toBe('测试 2026-10-14 09:05 2026/10 {{unknown}}')
  })
  it('keeps alias expansion limits local to the note and treats an unclosed opener as body text', () => {
    const aliases = Array.from({ length: 101 }, () => '  - *value').join('\n')
    const source = `---\nvalue: &value safe\nexpanded:\n${aliases}\n---\nBody`
    expect(() => frontmatter(source)).not.toThrow()
    expect(frontmatter(source).properties).toEqual({})
    const markdown = '---\ntitle: [unfinished\nBody'
    expect(updateProperty(markdown, 'tag', 'work')).toBe(`---\ntag: work\n---\n${markdown}`)
  })
})
