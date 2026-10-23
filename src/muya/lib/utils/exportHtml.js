import marked from '../parser/marked'
import Prism from 'prismjs'
import katex from 'katex'
import 'katex/dist/contrib/mhchem.min.js'
import loadRenderer from '../renderers'
import githubMarkdownCss from 'github-markdown-css/github-markdown.css?inline'
import exportStyle from '../assets/styles/exportStyle.css?inline'
import highlightCss from 'prismjs/themes/prism.css?inline'
import katexCss from 'katex/dist/katex.css?inline'
import footerHeaderCss from '../assets/styles/headerFooterStyle.css?inline'
import { EXPORT_DOMPURIFY_CONFIG } from '../config'
import { sanitize, unescapeHTML } from '../utils'
import { validEmoji } from '../ui/emojis'
import { embedKatexFonts } from './exportFonts'

// `?inline` on the stylesheet keeps CSS in the exported document, but its
// relative `fonts/*.woff2` URLs would still point at a nonexistent directory
// beside the saved HTML. Embed only KaTeX's own packaged fonts; never fetch a
// project supplied URL or arbitrary CSS resource during export.
const katexFontAssets = import.meta.glob('/node_modules/katex/dist/fonts/*.woff2', {
  query: '?inline',
  import: 'default',
  eager: true
})
const katexFontsByName = new Map(
  Object.entries(katexFontAssets).map(([path, dataUrl]) => [
    path.split('/').pop(),
    dataUrl
  ])
)
const inlineKatexCss = embedKatexFonts(katexCss, katexFontsByName)

export const getSanitizeHtml = (markdown, options) => {
  const html = marked(markdown, options)
  return sanitize(html, EXPORT_DOMPURIFY_CONFIG, false)
}

const DIAGRAM_TYPE = [
  'mermaid',
  'flowchart',
  'sequence',
  'plantuml',
  'vega-lite'
]

class ExportHtml {
  constructor (markdown, muya) {
    this.markdown = markdown
    this.muya = muya
    this.exportContainer = null
    this.mathRendererCalled = false
  }

  async renderMermaid () {
    const codes = Array.from(this.exportContainer.querySelectorAll('code.language-mermaid')).filter(code => {
      // Mermaid can create live images and CSS before returning its SVG. Do not
      // pass resource-bearing syntax or configuration overrides to that renderer.
      const source = code.textContent
      if (/<|\bimg\s*:|@\s*\{|&(?:#|[a-z]+;)|url\s*\(|@import|\\|%%\s*\{|^\s*---/im.test(source)) {
        code.dataset.exportRenderWarning = 'Mermaid resources or configuration require manual rendering; source was preserved.'
        return false
      }
      return true
    })
    if (!codes.length) {
      return
    }

    let mermaid
    try {
      mermaid = await loadRenderer('mermaid')
    } catch (err) {
      console.warn('Unable to load the Mermaid renderer for HTML export.', err)
      return
    }

    const replacements = []
    for (const code of codes) {
      const preEle = code.parentNode
      const mermaidContainer = document.createElement('div')
      mermaidContainer.textContent = code.textContent
      mermaidContainer.classList.add('mermaid')
      preEle.replaceWith(mermaidContainer)
      replacements.push({ preEle, mermaidContainer })
    }

    let editorMermaidConfig = null
    try {
      const currentConfig = mermaid.mermaidAPI?.getConfig?.()
      if (currentConfig) editorMermaidConfig = JSON.parse(JSON.stringify(currentConfig))
    } catch (err) {
      console.warn('Unable to snapshot the editor Mermaid configuration for HTML export.', err)
    }

    try {
      // We only export the light theme. Restore the editor theme afterwards.
      mermaid.initialize({
        securityLevel: 'strict',
        theme: 'default',
        themeCSS: '',
        startOnLoad: false,
        flowchart: { htmlLabels: false }
      })
      await mermaid.init(undefined, this.exportContainer.querySelectorAll('div.mermaid'))
    } catch (err) {
      console.warn('Unable to render Mermaid content for HTML export.', err)
      for (const { preEle, mermaidContainer } of replacements) {
        mermaidContainer.replaceWith(preEle)
      }
    } finally {
      const restoreConfig = editorMermaidConfig || {
        securityLevel: 'loose',
        theme: this.muya?.options?.mermaidTheme || 'default'
      }
      mermaid.initialize(restoreConfig)
    }
  }

  async renderDiagram () {
    const selector = 'code.language-vega-lite, code.language-flowchart, code.language-sequence, code.language-plantuml'
    const codes = Array.from(this.exportContainer.querySelectorAll(selector))
    if (!codes.length) {
      return
    }

    const renderers = new Map()
    for (const code of codes) {
      const rawCode = unescapeHTML(code.innerHTML)
      const functionType = (() => {
        if (/sequence/.test(code.className)) {
          return 'sequence'
        } else if (/plantuml/.test(code.className)) {
          return 'plantuml'
        } else if (/flowchart/.test(code.className)) {
          return 'flowchart'
        } else {
          return 'vega-lite'
        }
      })()

      // This renderer uploads the source to a public PlantUML server. Export
      // must never invoke it implicitly, even if compression is available.
      if (functionType === 'plantuml') {
        code.dataset.exportRenderWarning = 'PlantUML needs a remote renderer; source was preserved without contacting it.'
        continue
      }

      if (!renderers.has(functionType)) {
        try {
          renderers.set(functionType, await loadRenderer(functionType))
        } catch (err) {
          console.warn(`Unable to load the ${functionType} renderer for HTML export.`, err)
          renderers.set(functionType, null)
        }
      }
      const render = renderers.get(functionType)
      if (!render) {
        // Keep the original fenced code block when a renderer is unavailable.
        continue
      }

      const preParent = code.parentNode
      const diagramContainer = document.createElement('div')
      diagramContainer.classList.add(functionType)
      preParent.replaceWith(diagramContainer)
      const options = {}
      let resourceDenied = false
      const denyResource = async () => {
        resourceDenied = true
        throw new Error('External diagram resources are disabled during export')
      }
      if (functionType === 'sequence') {
        Object.assign(options, { theme: this.muya.options.sequenceTheme })
      } else if (functionType === 'vega-lite') {
        Object.assign(options, {
          actions: false,
          tooltip: false,
          renderer: 'svg',
          ast: true,
          loader: {
            load: denyResource,
            sanitize: denyResource
          },
          theme: 'latimes' // only render light theme
        })
      }
      try {
        if (functionType === 'flowchart' || functionType === 'sequence') {
          const diagram = render.parse(rawCode)
          diagramContainer.innerHTML = ''
          diagram.drawSVG(diagramContainer, options)
        }
        if (functionType === 'plantuml') {
          const diagram = render.parse(rawCode)
          diagramContainer.innerHTML = ''
          diagram.insertImgElement(diagramContainer)
        }
        if (functionType === 'vega-lite') {
          const result = await render(diagramContainer, JSON.parse(rawCode), options)
          result.view.finalize()
          if (resourceDenied) throw new Error('Diagram requires external resources')
        }
      } catch (err) {
        console.warn(`Unable to render ${functionType} content for HTML export.`, err)
        diagramContainer.replaceWith(preParent)
        code.dataset.exportRenderWarning = 'Diagram could not be rendered without external resources; source was preserved.'
      }
    }
  }

  mathRenderer = (math, displayMode) => {
    this.mathRendererCalled = true

    try {
      return katex.renderToString(math, {
        displayMode
      })
    } catch (err) {
      return displayMode
        ? `<pre class="multiple-math invalid">\n${math}</pre>\n`
        : `<span class="inline-math invalid" title="invalid math">${math}</span>`
    }
  }

  // render pure html by marked
  async renderHtml (toc) {
    this.mathRendererCalled = false
    let html = marked(this.markdown, {
      superSubScript: this.muya ? this.muya.options.superSubScript : false,
      footnote: this.muya ? this.muya.options.footnote : false,
      isGitlabCompatibilityEnabled: this.muya ? this.muya.options.isGitlabCompatibilityEnabled : false,
      highlight (code, lang) {
        // Language may be undefined (GH#591)
        if (!lang) {
          return code
        }

        if (DIAGRAM_TYPE.includes(lang)) {
          return code
        }

        const grammar = Prism.languages[lang]
        if (!grammar) {
          console.warn(`Unable to find grammar for "${lang}".`)
          return code
        }
        return Prism.highlight(code, grammar, lang)
      },
      emojiRenderer (emoji) {
        const validate = validEmoji(emoji)
        if (validate) {
          return validate.emoji
        } else {
          return `:${emoji}:`
        }
      },
      mathRenderer: this.mathRenderer,
      tocRenderer () {
        if (!toc) {
          return ''
        }
        return toc
      }
    })

    html = sanitize(html, EXPORT_DOMPURIFY_CONFIG, false)

    // A detached live-document <img> can fetch too: parse in template content
    // (an inert document), strip loading attributes, and only then attach.
    const template = document.createElement('template')
    template.innerHTML = html
    const imageSources = new Map()
    for (const element of template.content.querySelectorAll('*')) {
      if (element.tagName === 'STYLE' || element.tagName === 'LINK') {
        element.remove()
        continue
      }
      if (element.tagName === 'IMG' && element.hasAttribute('src')) {
        const key = String(imageSources.size)
        imageSources.set(key, element.getAttribute('src'))
        element.setAttribute('data-export-source-key', key)
      }
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase()
        if (['src', 'srcset', 'poster', 'background'].includes(name) ||
          (['href', 'xlink:href'].includes(name) && element.tagName.toLowerCase() !== 'a' && !attribute.value.startsWith('#')) ||
          // Layout styles emitted by KaTeX are numeric. User CSS functions,
          // escapes and at-rules can hide loading URLs (e.g. image-set).
          (name === 'style' && /[()@\\]/.test(attribute.value))) {
          element.removeAttribute(attribute.name)
        }
      }
    }
    const exportContainer = this.exportContainer = document.createElement('div')
    exportContainer.classList.add('ag-render-container')
    exportContainer.appendChild(template.content)
    document.body.appendChild(exportContainer)

    let result = ''
    try {
      // Render only the light theme of Mermaid and other diagrams.
      await this.renderMermaid()
      await this.renderDiagram()
      // Restore source URLs only in inert markup for the resource preflight.
      // Never set src on a live-document image, even after removing its parent.
      template.innerHTML = exportContainer.innerHTML
      for (const image of template.content.querySelectorAll('img[data-export-source-key]')) {
        image.setAttribute('src', imageSources.get(image.getAttribute('data-export-source-key')))
        image.removeAttribute('data-export-source-key')
      }
      result = template.innerHTML
    } finally {
      exportContainer.remove()
      this.exportContainer = null
    }

    // hack to add arrow marker to output html
    const pathes = document.querySelectorAll('path[id^=raphael-marker-]')
    const def = '<defs style="-webkit-tap-highlight-color: rgba(0, 0, 0, 0);">'
    result = result.replace(def, () => {
      let str = ''
      for (const path of pathes) {
        str += path.outerHTML
      }
      return `${def}${str}`
    })

    return result
  }

  /**
   * Get HTML with style
   *
   * @param {*} options Document options
   */
  async generate (options) {
    const { printOptimization = false, language = 'en', themeCss = '', includeTitleBlock = false } = options

    // WORKAROUND: Hide Prism.js style when exporting or printing. Otherwise the background color is white in the dark theme.
    const highlightCssStyle = printOptimization ? `@media print { ${highlightCss} }` : highlightCss
    const html = this._prepareHtml(await this.renderHtml(options.toc), options)
    const katexCssStyle = this.mathRendererCalled ? inlineKatexCss : ''
    this.mathRendererCalled = false

    // `extraCss` may changed in the mean time.
    const { title = '', extraCss = '' } = options
    const safeLanguage = /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language) ? language : 'en'
    const safeTitle = sanitize(title, EXPORT_DOMPURIFY_CONFIG, true)
    const titleBlock = includeTitleBlock && safeTitle
      ? `<header class="export-document-title"><h1>${safeTitle}</h1></header>`
      : ''
    return `<!DOCTYPE html>
<html lang="${safeLanguage}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${sanitize(title, EXPORT_DOMPURIFY_CONFIG, true)}</title>
  <style>
  ${githubMarkdownCss}
  </style>
  <style>
  ${highlightCssStyle}
  </style>
  <style>
  ${katexCssStyle}
  </style>
  <style>
    .markdown-body {
      font-family: -apple-system,Segoe UI,Helvetica,Arial,sans-serif,Apple Color Emoji,Segoe UI Emoji;
      box-sizing: border-box;
      min-width: 200px;
      max-width: 980px;
      margin: 0 auto;
      padding: 45px;
    }

    @media not print {
      .markdown-body {
        padding: 45px;
      }

      @media (max-width: 767px) {
        .markdown-body {
          padding: 15px;
        }
      }

    .export-document-title {
      max-width: 980px;
      margin: 0 auto;
      padding: 45px 45px 0;
    }

    .export-document-title h1 {
      margin: 0;
      color: #24292e;
      font-size: 2.2em;
      line-height: 1.2;
    }

    @media print {
      .export-document-title {
        max-width: none;
        padding: 0 0 12mm;
      }
    }
    }

    .hf-container {
      color: #24292e;
      line-height: 1.3;
    }

    .markdown-body .highlight pre,
    .markdown-body pre {
      white-space: pre-wrap;
    }
    .markdown-body table {
      display: table;
    }
    .markdown-body img[data-align="center"] {
      display: block;
      margin: 0 auto;
    }
    .markdown-body img[data-align="right"] {
      display: block;
      margin: 0 0 0 auto;
    }
    .markdown-body li.task-list-item {
      list-style-type: none;
    }
    .markdown-body li > [type=checkbox] {
      margin: 0 0 0 -1.3em;
    }
    .markdown-body input[type="checkbox"] ~ p {
      margin-top: 0;
      display: inline-block;
    }
    .markdown-body ol ol,
    .markdown-body ul ol {
      list-style-type: decimal;
    }
    .markdown-body ol ol ol,
    .markdown-body ol ul ol,
    .markdown-body ul ol ol,
    .markdown-body ul ul ol {
      list-style-type: decimal;
    }
  </style>
  <style>${exportStyle}</style>
  <style>${themeCss}</style>
  <style>${extraCss}</style>
</head>
<body>
  ${titleBlock}
  ${html}
</body>
</html>`
  }

  /**
   * @private
   *
   * @param {string} html The converted HTML text.
   * @param {*} options The export options.
   */
  _prepareHtml (html, options) {
    const { header, footer } = options
    const appendHeaderFooter = !!header || !!footer
    if (!appendHeaderFooter) {
      return createMarkdownArticle(html)
    }

    if (!options.extraCss) {
      options.extraCss = footerHeaderCss
    } else {
      options.extraCss = footerHeaderCss + options.extraCss
    }

    let output = HF_TABLE_START
    if (header) {
      output += createTableHeader(options)
    }

    if (footer) {
      output += HF_TABLE_FOOTER
      output = createRealFooter(options) + output
    }

    output = output + createTableBody(html) + HF_TABLE_END
    return sanitize(output, EXPORT_DOMPURIFY_CONFIG, false)
  }
}

// Variables and function to generate the header and footer.
const HF_TABLE_START = '<table class="page-container">'
const createTableBody = html => {
  return `<tbody><tr><td>
  <div class="main-container">
    ${createMarkdownArticle(html)}
  </div>
</td></tr></tbody>`
}
const HF_TABLE_END = '</table>'

/// The header at is shown at the top.
const createTableHeader = options => {
  const { header, headerFooterStyled } = options
  const { type, left, center, right } = header
  let headerClass = type === 1 ? 'single' : ''
  headerClass += getHeaderFooterStyledClass(headerFooterStyled)
  return `<thead class="page-header ${headerClass}"><tr><th>
  <div class="hf-container">
    <div class="header-content-left">${left}</div>
    <div class="header-content">${center}</div>
    <div class="header-content-right">${right}</div>
  </div>
</th></tr></thead>`
}

/// Fake footer to reserve space.
const HF_TABLE_FOOTER = `<tfoot class="page-footer-fake"><tr><td>
  <div class="hf-container">
    &nbsp;
  </div>
</td></tr></tfoot>`

/// The real footer at is shown at the bottom.
const createRealFooter = options => {
  const { footer, headerFooterStyled } = options
  const { type, left, center, right } = footer
  let footerClass = type === 1 ? 'single' : ''
  footerClass += getHeaderFooterStyledClass(headerFooterStyled)
  return `<div class="page-footer ${footerClass}">
  <div class="hf-container">
    <div class="footer-content-left">${left}</div>
    <div class="footer-content">${center}</div>
    <div class="footer-content-right">${right}</div>
  </div>
</div>`
}

/// Generate the mardown article HTML.
const createMarkdownArticle = html => {
  return `<article class="markdown-body">${html}</article>`
}

/// Return the class whether a header/footer should be styled.
const getHeaderFooterStyledClass = value => {
  if (value === undefined) {
    // Prefer theme settings.
    return ''
  }
  return !value ? ' simple' : ' styled'
}

export default ExportHtml
