import { describe, expect, it } from 'vitest'
import { analyzeNote, planReferenceMove, resolveNoteHeading, resolveNoteLink } from '../../src/services/note-index'
import { relationsFromSource } from '../../src/services/note-relations'
import { wikiCompletionOptions } from '../../src/services/note-completion'
describe('shared notebook parser and resolution', () => {
  it('finds genuine unlinked aliases without counting linked labels, code or substrings', () => {
    const target = analyzeNote('Plan.md', '---\naliases: [计划, " "]\n---\n')
    const source = analyzeNote('source.md', 'Plan planet 计划\n[[Plan|计划]]\n[Plan](Plan.md)\n`Plan`\n')
    const result = relationsFromSource(source, target, [target, source])
    expect(result.backlinks).toHaveLength(2)
    expect(result.mentions.map(m => source.prose.slice(m.from, m.to))).toEqual(['Plan', '计划'])
  })
  it('prefers an explicit filename over a conflicting alias but keeps a bare name ambiguous', () => {
    const notes = [analyzeNote('foo.md', ''), analyzeNote('other.md', '---\naliases: [foo]\n---\n')]
    expect(resolveNoteLink('source.md', { kind: 'wiki', target: 'foo.md' }, notes).map(note => note.relative)).toEqual(['foo.md'])
    expect(resolveNoteLink('source.md', { kind: 'wiki', target: 'foo' }, notes)).toHaveLength(2)
  })
  it('uses an exact filename to distinguish notes with the same stem and different extensions', () => {
    const notes = [analyzeNote('a/Note.md', ''), analyzeNote('a/Note.markdown', '')]
    expect(resolveNoteLink('a/source.md', { kind: 'wiki', target: 'Note.md' }, notes).map(note => note.relative)).toEqual(['a/Note.md'])
    expect(resolveNoteLink('a/source.md', { kind: 'wiki', target: 'Note' }, notes)).toHaveLength(2)
    expect(wikiCompletionOptions('Note', 'a/source.md', notes).map(option => option.value)).toEqual(['a/Note.md', 'a/Note.markdown'])
  })
  it('uses exact case for explicit paths and keeps distinct case-sensitive directories separate', () => {
    const notes = [analyzeNote('A/Note.md', ''), analyzeNote('a/Note.md', '')]
    expect(resolveNoteLink('source.md', { kind: 'wiki', target: 'A/Note.md' }, notes).map(note => note.relative)).toEqual(['A/Note.md'])
    expect(resolveNoteLink('source.md', { kind: 'wiki', target: 'a/Note.md' }, notes).map(note => note.relative)).toEqual(['a/Note.md'])
  })
  it('excludes fenced and indented code, inline code, comments and frontmatter', () => {
    const note = analyzeNote('中文.md', '---\naliases: [中文]\ntags: [work/team]\n---\n# 标题\n[[目标|显示]] [目标](目标.md#标题)\n`[[fake]] #fake`\n\n```md\n[[fake]]\n- [ ] fake\n```\n\n    [[fake]]\n\n<!-- [[fake]] -->\n\n- [ ] 真实任务\n#work/team\n')
    expect(note.links.map(l => l.target)).toEqual(['目标', '目标.md#标题'])
    expect(note.tasks).toHaveLength(1); expect(note.tasks[0].checked).toBe(false)
    expect(note.aliases).toEqual(['中文']); expect(note.tags).toEqual(['work/team'])
    expect(note.headings[0].title).toBe('标题')
  })
  it('resolves same-name neighbors and refuses ambiguous aliases', () => {
    const notes = ['a/同名.md', 'b/同名.md', 'a/source.md'].map(path => analyzeNote(path, '---\naliases: [共享]\n---\n'))
    expect(resolveNoteLink('a/source.md', { kind: 'wiki', target: '同名' }, notes).map(n => n.relative)).toEqual(['a/同名.md'])
    expect(resolveNoteLink('root.md', { kind: 'wiki', target: '同名' }, notes)).toHaveLength(2)
    expect(resolveNoteLink('a/source.md', { kind: 'markdown', target: '../b/%E5%90%8C%E5%90%8D.md#标题' }, notes)[0].relative).toBe('b/同名.md')
  })
  it('does not report an ambiguous wiki link as a backlink to every same-name note', () => {
    const notes = [
      analyzeNote('a/Plan.md', ''),
      analyzeNote('b/Plan.md', ''),
      analyzeNote('source.md', '[[Plan]]\n'),
    ]
    expect(relationsFromSource(notes[2], notes[0], notes).backlinks).toHaveLength(0)
    expect(relationsFromSource(notes[2], notes[1], notes).backlinks).toHaveLength(0)
  })
  it('resolves case-insensitive heading slugs and disambiguates duplicate slugs', () => {
    const note = analyzeNote('note.md', '# My Heading\n# My Heading\n')
    expect(note.headings.map(heading => heading.slug)).toEqual(['my-heading', 'my-heading-1'])
    expect(resolveNoteHeading(note, 'My-Heading')?.from).toBe(note.headings[0].from)
    expect(resolveNoteHeading(note, 'MY-HEADING-1')?.from).toBe(note.headings[1].from)
  })
  it('disambiguates same-alias heading completions with canonical paths', () => {
    const notes = [
      analyzeNote('a/first.md', '---\naliases: [Shared]\n---\n# Start Here\n'),
      analyzeNote('b/second.md', '---\naliases: [Shared]\n---\n# Start Here\n'),
    ]
    const options = wikiCompletionOptions('Shared#', 'source.md', notes)
    expect(options.map(option => option.value)).toEqual(['a/first#start-here', 'b/second#start-here'])
    expect(new Set(options.map(option => option.value)).size).toBe(2)
    expect(options.every(option => option.label.startsWith('Shared#'))).toBe(true)
    expect(options.map(option => resolveNoteLink('source.md', { kind: 'wiki', target: option.value }, notes)[0].relative)).toEqual(['a/first.md', 'b/second.md'])
  })
  it('updates incoming and moved outgoing relative links while preserving display and heading', () => {
    const docs = [{ relative: 'old/target.md', markdown: '[s](../source.md#标题)\n' }, { relative: 'source.md', markdown: '[[old/target#标题|显示文字]]\n[显示](old/target.md#heading "title")\n`[[old/target]]`\n' }]
    const plan = planReferenceMove('old/target.md', 'new/deep/target.md', docs)
    expect(plan.warnings).toEqual([])
    expect(plan.changes.find(c => c.relative === 'source.md')?.after).toContain('[[new/deep/target#标题|显示文字]]')
    expect(plan.changes.find(c => c.relative === 'source.md')?.after).toContain('[显示](new/deep/target.md#heading "title")')
    expect(plan.changes.find(c => c.relative === 'old/target.md')?.after).toBe('[s](../../source.md#标题)\n')
  })
  it('indexes reference-style Markdown URLs and escaped wiki delimiters safely', () => {
    const note = analyzeNote('a.md', '\\[[escaped]]\n[x][ref]\n\n[ref]: b.md#h\n')
    expect(note.links.map(l => l.target)).toEqual(['b.md#h', 'b.md#h'])
    expect(note.links.filter(l => !l.referenceDefinition)).toHaveLength(1)
    expect(note.links.filter(l => l.referenceDefinition)).toHaveLength(1)
  })
  it('indexes reference-style full, collapsed and shortcut uses at the use site and rewrites each definition once', () => {
    const target = analyzeNote('Plan.md', '')
    const body = '[Plan][ref]\n[Plan][]\n[Shortcut]\n\n[ref]: Plan.md\n[Plan]: Plan.md\n[Shortcut]: Plan.md\n'
    const source = analyzeNote('source.md', body)
    const uses = source.links.filter(link => !link.referenceDefinition)
    expect(uses.map(link => body.slice(link.from, link.to))).toEqual(['[Plan][ref]', '[Plan][]', '[Shortcut]'])
    expect(source.links.filter(link => link.referenceDefinition)).toHaveLength(3)
    expect(relationsFromSource(source, target, [target, source]).backlinks.map(item => item.link.line)).toEqual([1, 2, 3])
    expect(source.prose.replace(/\s/g, '')).toBe('')

    const plan = planReferenceMove('Plan.md', 'NewPlan.md', [{ relative: 'Plan.md', markdown: '' }, { relative: 'source.md', markdown: body }])
    const after = plan.changes.find(change => change.relative === 'source.md')?.after ?? ''
    expect(after).toContain('[Plan][ref]\n[Plan][]\n[Shortcut]')
    expect(after.match(/\[(?:ref|Plan|Shortcut)\]: NewPlan\.md/g)).toHaveLength(3)
  })
  it('decodes Markdown destination escapes and entities before resolving paths', () => {
    const target = analyzeNote('a&(b).md', '# Heading\n')
    const source = analyzeNote('source.md', '[open](a&amp;\\(b\\).md#Heading)\n')
    expect(source.links[0].target).toBe('a&amp;\\(b\\).md#Heading')
    expect(resolveNoteLink('source.md', source.links[0], [target, source])).toEqual([target])
    const plan = planReferenceMove('source.md', 'nested/source.md', [
      { relative: 'a&(b).md', markdown: '# Heading\n' },
      { relative: 'source.md', markdown: '[open](a&amp;\\(b\\).md#Heading)\n' },
    ])
    expect(plan.changes.find(change => change.relative === 'source.md')?.after).toContain('../a%26%28b%29.md#Heading')
  })
  it('resolves extensionless Markdown links against note stems', () => {
    const target = analyzeNote('a/manual.md', '# Manual\n')
    const source = analyzeNote('a/source.md', '[manual](manual)\n')
    expect(resolveNoteLink('a/source.md', source.links[0], [target, source]).map(note => note.relative)).toEqual(['a/manual.md'])
  })
  it('rebases unresolved relative references and preserves a same-name target when the source moves', () => {
    const missing = planReferenceMove('old/source.md', 'new/source.md', [
      { relative: 'old/source.md', markdown: '[draft](draft.md)\n' },
    ])
    expect(missing.changes[0].after).toContain('[draft](../old/draft.md)')
    const nearby = planReferenceMove('a/source.md', 'b/source.md', [
      { relative: 'a/source.md', markdown: '[[Name]]\n' },
      { relative: 'a/Name.md', markdown: '' },
      { relative: 'b/Name.md', markdown: '' },
    ])
    expect(nearby.changes.find(change => change.relative === 'a/source.md')?.after).toContain('[[a/Name]]')
  })
  it('does not collapse distinct directory casing while rebasing Markdown links', () => {
    const plan = planReferenceMove('A/source.md', 'a/source.md', [
      { relative: 'A/source.md', markdown: '[target](Note.md)\n' },
      { relative: 'A/Note.md', markdown: '' },
      { relative: 'a/Note.md', markdown: '' },
    ])
    expect(plan.changes.find(change => change.relative === 'A/source.md')?.after).toContain('[target](../A/Note.md)')
  })
})
