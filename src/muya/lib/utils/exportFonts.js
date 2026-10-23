// Resolve KaTeX's own font faces by family/style, independent of Vite URL hashes.
export function embedKatexFonts (css, fontsByName) {
  return css.replace(/@font-face\s*\{[^}]*\}/g, block => {
    const family = block.match(/font-family\s*:\s*["']?([^;"'}]+)/)?.[1]?.trim()
    if (!family?.startsWith('KaTeX_')) return block
    const weight = block.match(/font-weight\s*:\s*([^;}]+)/)?.[1]?.trim() || '400'
    const style = block.match(/font-style\s*:\s*([^;}]+)/)?.[1]?.trim() || 'normal'
    const bold = weight === 'bold' || Number(weight) >= 600
    const italic = style === 'italic'
    const variant = bold ? (italic ? 'BoldItalic' : 'Bold') : (italic ? 'Italic' : 'Regular')
    const name = family + '-' + variant + '.woff2'
    const dataUrl = fontsByName.get(name)
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
      throw new Error('Bundled export font is unavailable: ' + name)
    }
    return '@font-face{font-family:' + family + ';font-style:' + style + ';font-weight:' + weight +
      ';font-display:swap;src:url("' + dataUrl + '") format("woff2")}'
  })
}
