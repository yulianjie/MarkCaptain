import { expect, test, type Page } from '@playwright/test'

async function generateHtml(page: Page, markdown: string, options: { title?: string; language?: string; includeTitleBlock?: boolean; themeCss?: string } = {}) {
  await page.goto('/')
  return page.evaluate(async ({ source, options }) => {
    const { default: ExportHtml } = await import('/src/muya/lib/utils/exportHtml.js')
    const muya = {
      options: {
        superSubScript: false,
        footnote: false,
        isGitlabCompatibilityEnabled: false,
        mermaidTheme: 'default',
        sequenceTheme: 'hand',
      },
    }
    const exporter = new ExportHtml(source, muya)
    return exporter.generate({
      title: options.title ?? 'Export test',
      language: options.language,
      includeTitleBlock: options.includeTitleBlock,
      themeCss: options.themeCss,
      toc: false,
      printOptimization: false,
      extraCss: '',
    })
  }, { source: markdown, options })
}

test.describe('HTML export', () => {
  test('Vega export enforces its resource loader even without browser CSP, while inline charts still render', async ({ browser }) => {
    const context = await browser.newContext({ bypassCSP: true })
    const page = await context.newPage()
    const requests: string[] = []
    await page.route('https://review.invalid/**', route => {
      requests.push(route.request().url())
      return route.abort()
    })
    try {
      const specs = [
        { data: { values: [{ a: 'A', b: 3 }, { a: 'B', b: 7 }] }, mark: 'bar', encoding: { x: { field: 'a', type: 'nominal' }, y: { field: 'b', type: 'quantitative' } } },
        { data: { url: 'https://review.invalid/vega.json' }, mark: 'bar', encoding: { x: { field: 'a', type: 'nominal' } } },
        { data: { values: [{ image: 'https://review.invalid/vega.png' }] }, mark: 'image', encoding: { url: { field: 'image', type: 'nominal' } } },
      ]
      const source = specs.map(spec => '```vega-lite\n' + JSON.stringify({ $schema: 'https://vega.github.io/schema/vega-lite/v5.json', ...spec }) + '\n```').join('\n\n')
      await page.goto('http://localhost:1420/')
      const result = await page.evaluate(async source => {
        const { default: ExportHtml } = await import('/src/muya/lib/utils/exportHtml.js')
        const html = await new ExportHtml(source, { options: {} }).generate({})
        const document = new DOMParser().parseFromString(html, 'text/html')
        return {
          charts: document.querySelectorAll('.vega-lite svg').length,
          preserved: document.querySelectorAll('code.language-vega-lite[data-export-render-warning]').length,
        }
      }, source)
      await page.waitForTimeout(100)
      expect(requests).toEqual([])
      expect(result).toEqual({ charts: 1, preserved: 2 })
    } finally {
      await context.close()
    }
  })

  test('never requests document or diagram resources before export preflight and preserves saved HTML links', async ({ page }) => {
    const requests: string[] = []
    await page.route(/https?:\/\/(?:review\.invalid|www\.plantuml\.com)\//, route => {
      requests.push(route.request().url())
      return route.abort()
    })
    const html = await generateHtml(page, [
      '# Safe export', '', '$x^2$', '',
      '![remote](https://review.invalid/markdown.png)', '',
      '<img src="https://review.invalid/raw.png" srcset="https://review.invalid/retina.png 2x">',
      '<div style="background-image:url(https://review.invalid/background.png)">Styled</div>',
      '<div style="background-image:image-set(\'https://review.invalid/image-set.png\' 1x)">CSS image</div>',
      '<svg><image href="https://review.invalid/svg.png" /></svg>', '',
      '```mermaid', 'graph TD; A-->B;', '```', '',
      '```mermaid', 'graph TD; A["<img src=https://review.invalid/mermaid.png>"]', '```', '',
      '```mermaid', 'flowchart TD; A@{ "img": "https://review.invalid/mermaid-shape.png" }', '```', '',
      '```vega-lite', '{"data":{"url":"https://review.invalid/data.json"},"mark":"bar","encoding":{"x":{"field":"a"}}}', '```', '',
      '```vega-lite', '{"data":{"values":[{"url":"https://review.invalid/vega-image.png"}]},"mark":"image","encoding":{"url":{"field":"url","type":"nominal"}}}', '```', '',
      '```plantuml', 'Alice -> Bob: Hello', '```',
    ].join('\n'))
    const result = await page.evaluate(async html => {
      const { prepareHtmlResources, restoreExternalImageLinks } = await import('/src/services/export/resources.ts')
      const { captureExportSnapshot } = await import('/src/services/export/snapshot.ts')
      const snapshot = captureExportSnapshot({ filename: 'note.md', pathname: 'C:/project/note.md', markdown: '' })
      const prepared = await prepareHtmlResources(html, snapshot, undefined, false, async () => { throw new Error('Unexpected local read') })
      const document = new DOMParser().parseFromString(prepared.html, 'text/html')
      const blocked = await prepareHtmlResources(html, snapshot, undefined, true, async () => { throw new Error('Unexpected local read') })
      return {
        previewSources: Array.from(document.querySelectorAll('img[src]')).map(image => image.getAttribute('src')),
        saved: restoreExternalImageLinks(prepared.html),
        warnings: prepared.warnings.map(warning => warning.code),
        downloadSources: Array.from(new DOMParser().parseFromString(blocked.html, 'text/html').querySelectorAll('img[src]')).map(image => image.getAttribute('src')),
      }
    }, html)
    await page.waitForTimeout(150)
    expect(requests).toEqual([])
    expect(result.previewSources.some(source => source?.includes('review.invalid'))).toBe(false)
    expect(result.downloadSources.some(source => source?.includes('review.invalid'))).toBe(false)
    expect(result.saved).toContain('src="https://review.invalid/markdown.png"')
    expect(result.saved).toContain('src="https://review.invalid/raw.png"')
    expect(result.warnings).toContain('diagram-resource-disabled')
    expect(html).toContain('class="katex"')
    expect(html.includes('id="flowchart-A-')).toBe(true)
    expect(html).toContain('language-plantuml')
  })

  test('exports ordinary Markdown without loading unused diagram renderers', async ({ page }) => {
    const html = await generateHtml(page, '# Hello\n\nPlain paragraph.')

    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('<h1 id="hello" class="atx">Hello</h1>')
    expect(html).toContain('<p>Plain paragraph.</p>')
  })

  test('includes the selected output language, theme CSS, and visible title block', async ({ page }) => {
    const html = await generateHtml(page, '# Main heading', {
      title: 'Export title',
      language: 'zh-CN',
      includeTitleBlock: true,
      themeCss: ':root { --export-accent: #075a9c; }',
    })

    expect(html).toContain('<html lang="zh-CN">')
    expect(html).toContain('<header class="export-document-title"><h1>Export title</h1></header>')
    expect(html).toContain('--export-accent: #075a9c')
    expect(html).toContain('<h1 id="main-heading"')
  })

  test('embeds the packaged KaTeX fonts instead of retaining relative asset URLs', async ({ page }) => {
    const html = await generateHtml(page, 'Inline math: $x^2 + y^2$.')

    expect(html).toContain('class="katex"')
    expect(html).toContain('<math')
    expect(html).toContain('encoding="application/x-tex"')
    expect(html).toContain('<msup>')
    expect(html).toContain('data:font/woff2;base64,')
    expect(html).not.toMatch(/url\(["']?fonts\/KaTeX_/)
    expect(html).not.toMatch(/url\(["']?\/?assets\/.*KaTeX_/)
  })

  test('exports Mermaid as parseable standalone SVG data while keeping the visible preview SVG', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
      const { default: ExportHtml } = await import('/src/muya/lib/utils/exportHtml.js')
      const { default: loadRenderer } = await import('/src/muya/lib/renderers/index.js')
      const { prepareHtmlResources } = await import('/src/services/export/resources.ts')
      const mermaid = await loadRenderer('mermaid')
      const beforeHtmlLabels = mermaid.mermaidAPI.getConfig().flowchart?.htmlLabels
      const source = '```mermaid\ngraph TD\n  A["中文节点"] --> B["结果"]\n```'
      const exporter = new ExportHtml(source, {
        options: { superSubScript: false, footnote: false, isGitlabCompatibilityEnabled: false, mermaidTheme: 'default', sequenceTheme: 'hand' },
      })
      const html = await exporter.generate({ title: '', toc: false, printOptimization: true, extraCss: '' })
      const prepared = await prepareHtmlResources(
        html,
        { markdown: source, sourcePath: undefined, fileName: 'diagram.md', capturedAt: 'now', revision: 'svg-test' },
        undefined,
        false,
        async () => { throw new Error('Mermaid SVG must not be read as an external resource') },
      )
      const document = new DOMParser().parseFromString(prepared.html, 'text/html')
      const svg = document.querySelector('article svg')
      const encoded = svg?.getAttribute('data-export-svg') ?? ''
      const isSvgDataUrl = encoded.startsWith('data:image/svg+xml;base64,')
      const bytes = Uint8Array.from(atob(encoded.split(',')[1] ?? ''), character => character.charCodeAt(0))
      const xml = new TextDecoder().decode(bytes)
      const xmlDocument = new DOMParser().parseFromString(xml, 'application/xml')
      const exportSvg = xmlDocument.documentElement

      const frame = window.document.createElement('iframe')
      frame.style.width = '800px'
      frame.style.height = '600px'
      frame.sandbox.add('allow-same-origin')
      window.document.body.appendChild(frame)
      await new Promise<void>(resolve => { frame.onload = () => resolve(); frame.srcdoc = prepared.html })
      const previewSvg = frame.contentDocument?.querySelector('article svg')
      const visibleBox = previewSvg?.getBoundingClientRect()
      const afterHtmlLabels = mermaid.mermaidAPI.getConfig().flowchart?.htmlLabels
      return {
        svgStillInline: Boolean(svg),
        hasExportData: isSvgDataUrl,
        xmlParserError: Boolean(xmlDocument.querySelector('parsererror')),
        xmlHasChineseText: xml.includes('中文节点') && xml.includes('结果'),
        xmlForeignObjects: xmlDocument.getElementsByTagName('foreignObject').length,
        xmlScripts: xmlDocument.getElementsByTagName('script').length,
        exportWidth: exportSvg.getAttribute('width'),
        exportHeight: exportSvg.getAttribute('height'),
        inlineWidth: svg?.getAttribute('width'),
        inlineHeight: svg?.getAttribute('height'),
        previewVisible: Boolean(visibleBox && visibleBox.width > 0 && visibleBox.height > 0),
        editorHtmlLabelsRestored: beforeHtmlLabels === afterHtmlLabels,
        warnings: prepared.warnings.map(item => item.code),
        blocking: prepared.blocking.map(item => item.code),
      }
    })

    expect(result.svgStillInline).toBe(true)
    expect(result.hasExportData).toBe(true)
    expect(result.xmlParserError).toBe(false)
    expect(result.xmlHasChineseText).toBe(true)
    expect(result.xmlForeignObjects).toBe(0)
    expect(result.xmlScripts).toBe(0)
    expect(Number(result.exportWidth)).toBeGreaterThan(0)
    expect(Number(result.exportHeight)).toBeGreaterThan(0)
    expect(result.inlineWidth).toBe('100%')
    expect(result.previewVisible).toBe(true)
    expect(result.editorHtmlLabelsRestored).toBe(true)
    expect(result.warnings).toEqual([])
    expect(result.blocking).toEqual([])
  })

  test('embeds authorized local images and keeps remote images out of the preview DOM', async ({ page }) => {
    await page.goto('/')
    const prepared = await page.evaluate(async () => {
      const { prepareHtmlResources, restoreExternalImageLinks } = await import('/src/services/export/resources.ts')
      const calls: string[][] = []
      const sourcePath = 'C:\\project\\notes\\chapter.md'
      const html = '<!doctype html><html><body><img alt="local" src="../assets/plot.png"><img alt="remote" src="https://example.test/image.png"></body></html>'
      const result = await prepareHtmlResources(
        html,
        { markdown: '', sourcePath, fileName: 'chapter.md', capturedAt: 'now', revision: 'snapshot' },
        'C:\\project',
        false,
        async (path, resource, root) => {
          calls.push([path, resource, root ?? ''])
          return { dataUrl: 'data:image/png;base64,YQ==', mime: 'image/png', sourcePath: 'C:\\project\\assets\\plot.png' }
        },
      )
      const remoteRequested = await prepareHtmlResources(
        '<!doctype html><html><body><img src="https://example.test/image.png"></body></html>',
        { markdown: '', sourcePath, fileName: 'chapter.md', capturedAt: 'now', revision: 'snapshot' },
        'C:\\project',
        true,
        async () => { throw new Error('remote downloads must not call the local reader') },
      )
      return {
        preview: result.html,
        savedHtml: restoreExternalImageLinks(result.html),
        previewRemoteSrc: document.querySelector('img[alt="remote"]')?.getAttribute('src') ?? null,
        warnings: result.warnings.map(item => item.code),
        blocking: result.blocking.map(item => item.code),
        remoteBlocking: remoteRequested.blocking.map(item => item.code),
        calls,
      }
    })

    expect(prepared.calls).toEqual([['C:\\project\\notes\\chapter.md', '../assets/plot.png', 'C:\\project']])
    expect(prepared.preview).toContain('src="data:image/png;base64,YQ=="')
    expect(prepared.previewRemoteSrc).toBeNull()
    expect(prepared.preview).toContain('data-export-remote-src="https://example.test/image.png"')
    expect(prepared.savedHtml).toContain('src="https://example.test/image.png"')
    expect(prepared.savedHtml).not.toContain('C:\\project\\assets\\plot.png')
    expect(prepared.warnings).toContain('remote-resource-not-embedded')
    expect(prepared.blocking).toEqual([])
    expect(prepared.remoteBlocking).toContain('remote-resource-download-unavailable')
  })

  test('rewrites current-document Wiki heading links to the actual rendered heading id', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
      const { default: ExportHtml } = await import('/src/muya/lib/utils/exportHtml.js')
      const { adaptExportHeadingAnchors, normalizeWikiLinks } = await import('/src/services/export/links.ts')
      const source = '# 你好，世界！\n\n[[#你好，世界！|回到标题]]\n'
      const normalized = normalizeWikiLinks(source, 'note.md')
      const exporter = new ExportHtml(normalized.markdown, { options: { superSubScript: false, footnote: false, isGitlabCompatibilityEnabled: false, mermaidTheme: 'default', sequenceTheme: 'hand' } })
      const html = await exporter.generate({ title: '', toc: false, printOptimization: true, extraCss: '' })
      const adapted = adaptExportHeadingAnchors(html, normalized.markdown)
      const document = new DOMParser().parseFromString(adapted, 'text/html')
      return {
        headingId: document.querySelector('.markdown-body h1')?.id,
        linkHref: document.querySelector('.markdown-body a')?.getAttribute('href'),
      }
    })

    expect(result.headingId).toBeTruthy()
    expect(decodeURIComponent(result.linkHref!.slice(1))).toBe(result.headingId)
  })

  test('keeps a diagram code block when its renderer is blocked by CSP', async ({ page }) => {
    const html = await generateHtml(page, '```sequence\nAlice->Bob: Hello\n```')

    expect(html).toContain('language-sequence')
    expect(html).toContain('Alice-&gt;Bob: Hello')
  })

  test('keeps PlantUML source when browser compression is unavailable', async ({ page }) => {
    const html = await generateHtml(page, '```plantuml\nAlice -> Bob: Hello\n```')

    expect(html).toContain('language-plantuml')
    expect(html).toContain('Alice -&gt; Bob: Hello')
  })

  test('renders Mermaid without loading the CSP-incompatible Sequence renderer', async ({ page }) => {
    const html = await generateHtml(page, '```mermaid\ngraph TD; A-->B;\n```')

    expect(html).toContain('<svg')
    expect(html).toContain('flowchart')
  })
})
