import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  LONG_DOCUMENT_CHARACTERS,
  ONE_MIB_BYTES,
  generateProject,
  renderLongDocument,
  renderOneMiBMarkdown,
} from '../../scripts/m0-generate-fixtures.mjs'

let temporaryRoot = ''

beforeAll(async () => {
  temporaryRoot = await mkdtemp(path.join(tmpdir(), 'markcaptain-m0-fixtures-'))
})

afterAll(async () => {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
})

describe('M0 workload fixtures', () => {
  it('keeps representative Markdown structures and its relative SVG resource in the checked-in fixture', async () => {
    const fixtureUrl = new URL('../fixtures/m0-representative.md', import.meta.url)
    const markdown = await readFile(fixtureUrl, 'utf8')
    const asset = await stat(new URL('../fixtures/m0-assets/diagram.svg', import.meta.url))
    expect(markdown).toContain('[[资料/边界条件|边界条件]]')
    expect(markdown).toContain('| 格式 | 现状 | 用途 |')
    expect(markdown).toContain('```mermaid')
    expect(markdown).toContain('[^baseline]')
    expect(markdown).toContain('./m0-assets/diagram.svg')
    expect(asset.isFile()).toBe(true)
  })

  it('renders an exact 200,000 Unicode-code-point long document', () => {
    const markdown = renderLongDocument()
    expect(Array.from(markdown)).toHaveLength(LONG_DOCUMENT_CHARACTERS)
    expect(markdown).toContain('中文长文')
    expect(markdown).toContain('[[相关资料|双链]]')
  })

  it('renders a valid UTF-8 Markdown file of exactly one MiB', () => {
    const markdown = renderOneMiBMarkdown()
    expect(Buffer.byteLength(markdown, 'utf8')).toBe(ONE_MIB_BYTES)
    expect(markdown).toContain('中文、English')
    expect(markdown).toContain('[[相关资料|双链]]')
  })

  it('generates a requested bounded project file count with nonempty note contents', async () => {
    const projectRoot = path.join(temporaryRoot, 'project-3')
    const result = await generateProject(projectRoot, 3)
    expect(result.fileCount).toBe(3)
    expect(result.totalBytes).toBeGreaterThan(0)
    expect(await readFile(path.join(projectRoot, 'group-000', 'note-00001.md'), 'utf8')).toContain('[[note-00002|下一份笔记]]')
    expect(await readFile(path.join(projectRoot, 'group-000', 'note-00003.md'), 'utf8')).toContain('[[note-00001|下一份笔记]]')
  })
})
