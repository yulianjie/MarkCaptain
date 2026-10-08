import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PROJECT_ISSUES_URL,
  PROJECT_REPOSITORY_URL,
  PROJECT_WIKI_URL,
} from '../../src/services/project-links'

const editorPage = readFileSync(
  fileURLToPath(new URL('../../src/pages/EditorPage.vue', import.meta.url)),
  'utf8',
)

describe('project help links', () => {
  it('targets this repository and its Wiki', () => {
    expect(PROJECT_REPOSITORY_URL).toBe('https://github.com/yulianjie/MarkCaptain')
    expect(PROJECT_WIKI_URL).toBe('https://github.com/yulianjie/MarkCaptain/wiki')
    expect(PROJECT_ISSUES_URL).toBe('https://github.com/yulianjie/MarkCaptain/issues')
  })

  it('routes Help actions through the canonical project links', () => {
    expect(editorPage).toContain('sh.open(PROJECT_WIKI_URL)')
    expect(editorPage).toContain('sh.open(PROJECT_ISSUES_URL)')
  })
})
