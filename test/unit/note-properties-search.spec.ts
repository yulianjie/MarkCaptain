import { describe, expect, it } from 'vitest'
import { editableProperties, parsePropertyInput, updateProperty } from '../../src/services/note-properties'
import { frontmatter } from '../../src/services/notebook'
import { analyzeNote } from '../../src/services/note-index'
import { compileNoteQuery } from '../../src/services/structured-search'
describe('lossless property editing', () => {
  it('adds a property to an empty frontmatter without duplicating delimiters', () => {
    expect(updateProperty('---\n---\nBody', 'title', 'New')).toBe('---\ntitle: New\n---\nBody')
  })
  it('keeps a document BOM before newly added frontmatter', () => {
    expect(updateProperty('\uFEFF# Body\n', 'title', 'New')).toBe('\uFEFF---\ntitle: New\n---\n# Body\n')
  })
  it('preserves unknown fields, comments, body and literal blocks while updating one value', () => {
    const source = '---\n# comment\ntitle: Old # keep\nunknown: !custom abc\nnested:\n  x: [1, 2]\nscript: |\n  do something\n---\nBody\n'
    const result = updateProperty(source, 'title', 'New')
    expect(result).toBe(source.replace('title: Old', 'title: New'))
    expect(frontmatter(updateProperty(result, 'tags', ['工作', 'team'])).properties.tags).toEqual(['工作', 'team'])
  })
  it('preserves original block-list indentation and unknown neighbors', () => {
    const source = '---\ntags:\n  - one\n  - two\nunknown: { complex: true }\n---\nbody'
    expect(frontmatter(updateProperty(source, 'tags', ['new'])).properties).toEqual({ tags: ['new'], unknown: { complex: true } })
  })
  it('keeps sequence anchors, aliases, custom tags and comments read-only', () => {
    const anchored = '---\ntitle: Old\ntags: [&short foo, bar]\nother: *short\n---\nbody'
    expect(frontmatter(anchored).properties.other).toBe('foo')
    expect(editableProperties(anchored).find(field => field.key === 'tags')?.type ?? null).toBeNull()
    expect(() => updateProperty(anchored, 'tags', ['new'])).toThrow('notes.unsupportedProperty')
    expect(frontmatter(updateProperty(anchored, 'title', 'New')).properties.other).toBe('foo')

    const customTag = '---\ntags: [!custom foo, bar]\n---\nbody'
    expect(editableProperties(customTag).find(field => field.key === 'tags')?.type ?? null).toBeNull()
    expect(() => updateProperty(customTag, 'tags', ['new'])).toThrow()

    const commented = '---\ntags:\n  - one # keep this note\n  - two\n---\nbody'
    expect(editableProperties(commented).find(field => field.key === 'tags')?.type ?? null).toBeNull()
    expect(() => updateProperty(commented, 'tags', ['new'])).toThrow('notes.unsupportedProperty')
  })
  it('keeps editor-unrepresentable values read-only and preserves exact formatting on no-op saves', () => {
    const source = '---\nmultiline: |+\n  ending\n\n\nemptyItem: ["", kept]\nwhitespaceItem: [" left", "right "]\nmultilineItem: ["two\\nlines"]\n---\nbody'
    const types = Object.fromEntries(editableProperties(source).map(field => [field.key, field.type]))
    expect(types.multiline).toBeNull()
    expect(types.emptyItem).toBeNull()
    expect(types.whitespaceItem).toBeNull()
    expect(types.multilineItem).toBeNull()
    expect(() => updateProperty(source, 'multiline', 'changed')).toThrow('notes.unsupportedProperty')
    expect(() => updateProperty(source, 'emptyItem', ['changed'])).toThrow('notes.unsupportedProperty')

    const formatted = '---\nscore: 1.00 # keep spelling\nitems:\n  - alpha\n  - beta\n---\nbody'
    expect(updateProperty(formatted, 'score', 1)).toBe(formatted)
    expect(updateProperty(formatted, 'items', ['alpha', 'beta'])).toBe(formatted)
    expect(updateProperty(formatted, 'score', 2)).toBe(formatted.replace('1.00', '2'))
  })
  it('refuses malformed YAML, anchored values and unsupported structures', () => {
    expect(() => updateProperty('---\nx: [\n---\nbody', 'x', 'new')).toThrow()
    expect(() => updateProperty('---\nx: &value abc\ny: *value\n---\n', 'x', 'new')).toThrow()
    expect(() => updateProperty('---\nx: { a: b }\n---\n', 'x', 'new')).toThrow()
    expect(() => parsePropertyInput('date', '2026-02-30')).toThrow()
    expect(parsePropertyInput('list', 'one\n中文')).toEqual(['one', '中文'])
  })
})
describe('structured queries use the notebook index', () => {
  const note = analyzeNote('中文/会议.md', '---\naliases: [Weekly sync]\ntags: [work/team]\npriority: 3\npublished: false\n---\nmeeting text\n\n- [ ] Follow up\n```md\n- [x] fake\n```')
  it('supports AND, OR, NOT, quoted aliases, nested tags and numeric properties', () => {
    expect(compileNoteQuery('tag:work prop.priority:>=2 NOT task:done')(note)).toBe(true)
    expect(compileNoteQuery('name:"Weekly sync" path:中文')(note)).toBe(true)
    expect(compileNoteQuery('tag:absent OR prop.published:false')(note)).toBe(true)
    expect(compileNoteQuery('tag:work -task:open')(note)).toBe(false)
    expect(compileNoteQuery('prop.absent:undefined')(note)).toBe(false)
  })
  it('matches negative numeric property values without treating the minus as exclusion', () => {
    const negative = analyzeNote('negative.md', '---\nscore: -2\n---\n')
    expect(compileNoteQuery('prop.score:-2')(negative)).toBe(true)
    expect(compileNoteQuery('-prop.score:-2')(negative)).toBe(false)
  })
  it('reports syntax errors instead of silently performing a different search', () => {
    for (const query of ['unknown:value', 'tag:', 'task:maybe', 'OR tag:work', 'tag:work AND', 'name:"unterminated']) expect(() => compileNoteQuery(query)).toThrow()
  })
})
