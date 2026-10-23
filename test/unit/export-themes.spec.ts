import { describe, expect, it } from 'vitest'
import { buildExportThemeCss } from '../../src/export-themes'
import { BUILTIN_PROFILES } from '../../src/services/export/profiles'

describe('export theme styles', () => {
  it('provides three distinct light output themes with page and typography settings', () => {
    const simple = buildExportThemeCss(BUILTIN_PROFILES['simple-reading'])
    const technical = buildExportThemeCss(BUILTIN_PROFILES.technical)
    const formal = buildExportThemeCss(BUILTIN_PROFILES['formal-report'])

    expect(new Set([simple, technical, formal]).size).toBe(3)
    expect(technical).toContain('@page { size: A4 portrait; margin: 20mm 18mm 20mm 18mm; }')
    expect(simple).toContain('PingFang SC')
    expect(formal).not.toContain('@media (prefers-color-scheme: dark)')
  })

  it('adds heading numbering only when the profile requests it', () => {
    expect(buildExportThemeCss(BUILTIN_PROFILES.technical)).not.toContain('counter(export-h1)')
    expect(buildExportThemeCss(BUILTIN_PROFILES['formal-report'])).toContain('counter(export-h1)')
  })
})
