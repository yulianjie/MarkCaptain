import { describe, expect, it } from 'vitest'
// @ts-expect-error Muya utility is intentionally JavaScript.
import { embedKatexFonts } from '@/muya/lib/utils/exportFonts'

describe('portable export font faces', () => {
  const fonts = new Map([
    ['KaTeX_Main-Regular.woff2', 'data:font/woff2;base64,cmVndWxhcg=='],
    ['KaTeX_Main-BoldItalic.woff2', 'data:font/woff2;base64,Ym9sZA=='],
  ])
  it('embeds production hashed URLs and removes all fallback external fonts', () => {
    const css = '@font-face{font-family:KaTeX_Main;src:url(/assets/KaTeX_Main-Regular-hash.woff2) format("woff2"),url(/assets/KaTeX_Main-Regular-hash.ttf) format("truetype");font-weight:400;font-style:normal}'
    const result = embedKatexFonts(css, fonts)
    expect(result).toContain('data:font/woff2;base64,cmVndWxhcg==')
    expect(result).not.toContain('/assets/')
    expect(result).not.toContain('.ttf')
  })
  it('handles development URLs, inline fallback data and bold italic faces', () => {
    const css = '@font-face{font-family:"KaTeX_Main";font-style:italic;font-weight:700;src:url(data:font/woff;base64,ZW1wdHk=),url(/node_modules/katex/dist/fonts/KaTeX_Main-BoldItalic.ttf)}'
    const result = embedKatexFonts(css, fonts)
    expect(result).toContain('data:font/woff2;base64,Ym9sZA==')
    expect(result).toContain('font-style:italic')
    expect(result).not.toContain('node_modules')
  })
  it('reports a missing bundled font instead of leaving an external dependency', () => {
    expect(() => embedKatexFonts('@font-face{font-family:KaTeX_AMS;src:url(fonts/a.woff2);font-style:normal;font-weight:400}', fonts)).toThrow('KaTeX_AMS-Regular.woff2')
  })
})
