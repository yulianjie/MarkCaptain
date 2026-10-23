import { describe, expect, it } from 'vitest'
import { normalizeWikiLinks } from '../../src/services/export/links'

describe('single-document export Wiki links', () => {
  it('converts Wiki links outside code into Markdown links and warns for unbundled notes', () => {
    const markdown = [
      '# 标题',
      '',
      'See [[#标题|此页]] and [[指南/下一步#概览|下一步]].',
      '`[[inline]]`',
      '',
      '```md',
      '[[code-block]]',
      '```',
    ].join('\n')

    const result = normalizeWikiLinks(markdown, 'C:\\project\\docs\\current.md', 'C:\\project')

    expect(result.markdown).toContain('See [此页](#%E6%A0%87%E9%A2%98) and [下一步](%E6%8C%87%E5%8D%97/%E4%B8%8B%E4%B8%80%E6%AD%A5.md#%E6%A6%82%E8%A7%88).')
    expect(result.markdown).toContain('`[[inline]]`')
    expect(result.markdown).toContain('[[code-block]]')
    expect(result.markdown).not.toContain('[[#标题|此页]]')
    expect(result.warnings).toEqual([expect.objectContaining({
      code: 'unbundled-note-link',
      resource: '指南/下一步.md',
      line: 3,
    })])
  })

  it('keeps an explicit self-note path local and reports a missing self heading', () => {
    const markdown = '# Current\n\n[[current#Current|here]] [[#Missing|missing]]\n'
    const result = normalizeWikiLinks(markdown, 'docs/current.md', 'C:/project')

    expect(result.markdown).toContain('[here](#current)')
    expect(result.markdown).toContain('[missing](#missing)')
    expect(result.warnings).toEqual([expect.objectContaining({ code: 'missing-export-heading', resource: 'Missing', line: 3 })])
  })

  it('preserves Markdown files that already have an extension', () => {
    const result = normalizeWikiLinks('[[notes/target.markdown|target]]', 'source.md')
    expect(result.markdown).toBe('[target](notes/target.markdown)')
    expect(result.warnings[0]).toMatchObject({ resource: 'notes/target.markdown' })
  })
})
