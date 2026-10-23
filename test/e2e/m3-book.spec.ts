import { expect, test } from '@playwright/test'

test.describe('M3 prepared chapter composition', () => {
  test('renders independent resources, repeated headings and footnotes, later math and diagrams into an ordered book', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
      const { default: ExportHtml } = await import('/src/muya/lib/utils/exportHtml.js')
      const { prepareHtmlResources } = await import('/src/services/export/resources.ts')
      const { composeExportBook, prepareProjectLinkMarkdown, exportSourceNamespace } = await import('/src/services/export/book.ts')
      const { adaptExportHeadingAnchors } = await import('/src/services/export/links.ts')
      const inputs = [
        { sourceId: 'source-a', relativePath: 'a/start.md', title: '<Opening>', level: 1, order: 0, markdown: '# Shared\n\n[forward](../b/end.md#shared) and [[b/end#Shared|wiki forward]]. [[b/end#shared-1|repeat]]\n\n![local](image.png)\n\nFirst[^same].\n\n[^same]: First note.\n' },
        { sourceId: 'source-b', relativePath: 'b/end.md', title: 'End', level: 2, order: 1, markdown: '# Shared\n\n[back](../a/start.md#shared)\n\n$x^2$\n\n![local](image.png)\n\nSecond[^same].\n\n[^same]: Second note.\n\n# Shared\n\n```mermaid\ngraph TD; A-->B;\n```\n' },
      ]
      const resources: string[] = []
      const chapters = []
      for (const input of inputs) {
        const snapshot = { markdown: input.markdown, fileName: input.relativePath.split('/').pop()!, sourcePath: `C:/project/${input.relativePath}`, capturedAt: '2026-10-23T00:00:00Z', revision: input.sourceId }
        const normalized = prepareProjectLinkMarkdown(snapshot, input.relativePath)
        const html = await new ExportHtml(normalized.markdown, { options: { footnote: true } }).generate({ title: '', includeTitleBlock: false })
        const prepared = await prepareHtmlResources(adaptExportHeadingAnchors(html, normalized.markdown), snapshot, 'C:/project', false, async (source: string, resource: string) => {
          resources.push(`${source}:${resource}`)
          return { sourcePath: source, mime: 'image/png', dataUrl: `data:image/png;base64,${btoa(source)}` }
        })
        chapters.push({ ...input, snapshot, html: prepared.html })
      }
      const original = JSON.stringify(chapters)
      const book = composeExportBook({ chapters: [...chapters].reverse(), title: '<Safe book>', toc: { enabled: true, depth: 4 } })
      const document = new DOMParser().parseFromString(book.html, 'text/html')
      const ids = [...document.querySelectorAll('[id]')].map(element => element.id)
      const anchors = [...document.querySelectorAll<HTMLAnchorElement>('article a[href^="#"]')].map(link => decodeURIComponent(link.getAttribute('href')!.slice(1)))
      const reordered = composeExportBook({ chapters: chapters.map(chapter => ({ ...chapter, order: 1 - chapter.order })), title: 'Reordered' })
      const other = new DOMParser().parseFromString(reordered.html, 'text/html')
      return {
        warnings: book.warnings,
        resources,
        titles: [...document.querySelectorAll('section > h1, section > h2')].map(heading => [heading.tagName, heading.textContent]),
        crossLinks: [...document.querySelectorAll('section a')].filter(link => /^(?:forward|wiki forward|back)$/.test(link.textContent!)).map(link => link.getAttribute('href')),
        repeatedLink: [...document.querySelectorAll('section a')].find(link => link.textContent === 'repeat')?.getAttribute('href'),
        repeatedHeading: [...document.querySelectorAll('[data-source-id="source-b"] h3')][1]?.id,
        uniqueIds: new Set(ids).size === ids.length,
        allTargetsExist: anchors.every(id => !!document.getElementById(id)),
        images: [...document.querySelectorAll('img[src]')].map(image => image.getAttribute('src')),
        math: document.querySelectorAll('.katex').length,
        diagrams: document.querySelectorAll('.mermaid svg[data-export-svg]').length,
        firstFootnotes: document.querySelector('[data-source-id="source-a"] .footnotes')?.textContent,
        secondFootnotes: document.querySelector('[data-source-id="source-b"] .footnotes')?.textContent,
        titleText: document.querySelector('.export-document-title')?.textContent,
        injected: !!document.querySelector('safe, opening'),
        unchanged: original === JSON.stringify(chapters),
        stableIds: ids.every(id => !!other.getElementById(id)),
        namespaces: inputs.map(input => exportSourceNamespace(input.sourceId)),
      }
    })
    expect(result.warnings).toEqual([])
    expect(result.resources).toEqual(['C:/project/a/start.md:image.png', 'C:/project/b/end.md:image.png'])
    expect(result.titles).toEqual([['H1', '<Opening>'], ['H2', 'Shared'], ['H2', 'End']])
    expect(result.crossLinks[0]).toBe(result.crossLinks[1])
    expect(result.crossLinks[0]).toContain(`#${result.namespaces[1]}-`)
    expect(result.crossLinks[2]).toContain(`#${result.namespaces[0]}-`)
    expect(result.repeatedLink).toBe(`#${result.repeatedHeading}`)
    expect(result.uniqueIds).toBe(true)
    expect(result.allTargetsExist).toBe(true)
    expect(result.images[0]).not.toEqual(result.images[1])
    expect(result.math).toBeGreaterThan(0)
    expect(result.diagrams).toBe(1)
    expect(result.firstFootnotes).toContain('First note')
    expect(result.secondFootnotes).toContain('Second note')
    expect(result.titleText).toBe('<Safe book>')
    expect(result.injected).toBe(false)
    expect(result.unchanged).toBe(true)
    expect(result.stableIds).toBe(true)
  })

  test('namespaces SVG paint servers, CSS selectors, accessibility and footnote references without network access', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
      const { composeExportBook } = await import('/src/services/export/book.ts')
      const chapters = ['one', 'two'].map((sourceId, order) => ({
        sourceId, relativePath: `${sourceId}.md`, title: sourceId, level: 1, order,
        snapshot: { markdown: '# Same', fileName: `${sourceId}.md`, capturedAt: '', revision: sourceId },
        html: `<html><head><style>#diagram { fill:url(#paint) } .accent { color:#abc }</style><style>.only-${sourceId}{color:red}</style></head><body><article class="markdown-body"><h1 id="same">Same</h1><svg id="diagram" aria-labelledby="caption"><title id="caption">${sourceId}</title><defs><linearGradient id="paint"/></defs><rect id="abc" style="fill:url('#paint')" fill="url(#paint)"/><use href="#paint"/></svg><a id="ref" href="#note">1</a><aside id="note"><a href="#ref">back</a></aside><img data-export-remote-src="https://blocked.invalid/image.png"></article></body></html>`,
      }))
      const book = composeExportBook({ chapters, title: 'Book' })
      const document = new DOMParser().parseFromString(book.html, 'text/html')
      return {
        warnings: book.warnings,
        sources: [...document.querySelectorAll('img')].map(image => image.getAttribute('src')),
        chapters: [...document.querySelectorAll('section')].map(section => {
          const svg = section.querySelector('svg')!
          const paint = section.querySelector('linearGradient')!.id
          const caption = section.querySelector('title')!.id
          return {
            svg: svg.id, paint, caption,
            label: svg.getAttribute('aria-labelledby'),
            fill: section.querySelector('rect')!.getAttribute('fill'),
            style: section.querySelector('rect')!.getAttribute('style'),
            use: section.querySelector('use')!.getAttribute('href'),
            targets: [...section.querySelectorAll('a[href]')].every(anchor => !!document.getElementById(anchor.getAttribute('href')!.slice(1))),
          }
        }),
        css: [...document.querySelectorAll('style')].map(style => style.textContent).join('\n'),
      }
    })
    expect(result.warnings).toEqual([])
    expect(result.sources).toEqual([null, null])
    expect(result.chapters[0].svg).not.toEqual(result.chapters[1].svg)
    for (const chapter of result.chapters) {
      expect(chapter.label).toEqual(chapter.caption)
      expect(chapter.fill).toEqual(`url(#${chapter.paint})`)
      expect(chapter.style).toEqual(`fill:url(#${chapter.paint})`)
      expect(chapter.use).toEqual(`#${chapter.paint}`)
      expect(chapter.targets).toBe(true)
      expect(result.css).toContain(`#${chapter.svg} { fill:url(#${chapter.paint}) }`)
    }
    expect(result.css).toContain('.only-one')
    expect(result.css).toContain('.only-two')
    expect(result.css).toContain('.accent { color:#abc }')
  })

  test('resolves aliases and reference links, diagnoses ambiguity and missing headings, and preserves fenced Wiki examples', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
      const { default: ExportHtml } = await import('/src/muya/lib/utils/exportHtml.js')
      const { composeExportBook, prepareProjectLinkMarkdown } = await import('/src/services/export/book.ts')
      const inputs = [
        ['start.md', '# Start\n\n[[Target]] [[Absent]] [[Chosen#Missing]] [[Chosen#Same|chosen]]\n\n[reference][next]\n\n[next]: a/Target.md#same\n\n```md\n[[Target]]\n```'],
        ['a/Target.md', '---\naliases: [Chosen]\n---\n# Same\n'],
        ['b/Target.md', '# Same\n'],
      ]
      const chapters = []
      for (const [relativePath, markdown] of inputs) {
        const snapshot = { markdown, fileName: relativePath, capturedAt: '', revision: relativePath }
        const prepared = prepareProjectLinkMarkdown(snapshot, relativePath)
        chapters.push({ sourceId: relativePath, relativePath, snapshot, title: relativePath, level: 1, order: chapters.length, html: await new ExportHtml(prepared.markdown, { options: {} }).generate({ includeTitleBlock: false }) })
      }
      const book = composeExportBook({ chapters, title: 'Book' })
      const document = new DOMParser().parseFromString(book.html, 'text/html')
      return {
        codes: book.warnings.map(warning => warning.code),
        warningLinks: [...document.querySelectorAll('[data-export-link-warning]')].map(link => link.getAttribute('data-export-link-warning')),
        chosen: [...document.querySelectorAll('a')].find(link => link.textContent === 'chosen')?.getAttribute('href'),
        reference: [...document.querySelectorAll('a')].find(link => link.textContent === 'reference')?.getAttribute('href'),
        code: document.querySelector('code')?.textContent,
        markers: book.html.includes('href="#mc-project-wiki-'),
      }
    })
    expect(result.codes).toEqual(['ambiguous-export-note-link', 'unbundled-note-link', 'missing-export-heading'])
    expect(result.warningLinks).toEqual(['ambiguous', 'not-included', 'missing-heading'])
    expect(result.chosen).toEqual(result.reference)
    expect(result.chosen).toMatch(/^#mc-/)
    expect(result.code).toContain('[[Target]]')
    expect(result.markers).toBe(false)
  })

  test('batch links target reserved format names and real renderer heading IDs, retaining each source TOC', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
      const { rewriteExportBatchLinks } = await import('/src/services/export/book.ts')
      const chapters = ['a', 'b'].map((sourceId, order) => ({
        sourceId, relativePath: `${sourceId}/same.md`, title: sourceId, order, level: 1,
        snapshot: { markdown: '# Heading', fileName: 'same.md', capturedAt: '', revision: sourceId },
        html: `<html><body><article class="markdown-body"><nav class="export-toc"><a href="#rendered">Contents</a></nav><h1 id="rendered">Heading</h1><a class="cross" href="../${sourceId === 'a' ? 'b' : 'a'}/same.md#heading">Other</a></article></body></html>`,
      }))
      return ['html', 'docx', 'epub'].map(format => {
        const result = rewriteExportBatchLinks(chapters, format as 'html' | 'docx' | 'epub', { a: `same-a.${format}`, b: `同名-b.${format}` })
        const documents = result.chapters.map(chapter => new DOMParser().parseFromString(chapter.html, 'text/html'))
        return {
          format, warnings: result.warnings,
          hrefs: documents.map(document => document.querySelector('.cross')?.getAttribute('href')),
          toc: documents.map(document => !!document.querySelector('.export-toc')),
        }
      })
    })
    for (const entry of result) {
      expect(entry.warnings).toEqual([])
      expect(entry.hrefs).toEqual([`${encodeURIComponent('同名-b')}.${entry.format}#rendered`, `same-a.${entry.format}#rendered`])
      expect(entry.toc).toEqual([true, true])
    }
  })

  test('raw HTML headings cannot redirect Markdown heading links during single-source adaptation or book composition', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
      const { default: ExportHtml } = await import('/src/muya/lib/utils/exportHtml.js')
      const { composeExportBook, prepareProjectLinkMarkdown } = await import('/src/services/export/book.ts')
      const { adaptExportHeadingAnchors, normalizeWikiLinks } = await import('/src/services/export/links.ts')
      const chapters = []
      for (const [relativePath, markdown] of [
        ['start.md', '# Start\n\n[cross](target.md#Real) [[target#Real|wiki cross]]'],
        ['target.md', '<h2 id="raw">Raw</h2>\n\n# Real\n\n[self](#Real) [lowercase](#real) [[#Real|wiki self]]\n\n[reference][local]\n\n[local]: #Real\n'],
      ]) {
        const snapshot = { markdown, fileName: relativePath, capturedAt: '', revision: relativePath }
        const prepared = prepareProjectLinkMarkdown(snapshot, relativePath)
        const normalized = normalizeWikiLinks(prepared.markdown, `C:/project/${relativePath}`, 'C:/project')
        const rendered = await new ExportHtml(normalized.markdown, { options: {} }).generate({ includeTitleBlock: false })
        const html = adaptExportHeadingAnchors(rendered, normalized.markdown)
        chapters.push({ sourceId: relativePath, relativePath, snapshot, title: relativePath, level: 1, order: chapters.length, html })
      }
      const book = composeExportBook({ title: 'Book', chapters })
      const document = new DOMParser().parseFromString(book.html, 'text/html')
      return {
        warnings: book.warnings,
        targets: [...document.querySelectorAll('section a')].map(anchor => document.getElementById(decodeURIComponent(anchor.getAttribute('href')!.slice(1)))?.textContent),
        markers: !!document.querySelector('[class*="mc-project-heading-"]'),
      }
    })
    expect(result.warnings).toEqual([])
    expect(result.targets).toEqual(['Real', 'Real', 'Real', 'Real', 'Real', 'Real'])
    expect(result.markers).toBe(false)
  })

  test('interleaved duplicate source IDs receive distinct output IDs and retain first-occurrence link targets', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
      const { composeExportBook } = await import('/src/services/export/book.ts')
      const book = composeExportBook({ title: 'Duplicate IDs', chapters: [{
        sourceId: 'chapter', relativePath: 'chapter.md', title: 'Chapter', order: 0, level: 1,
        snapshot: { markdown: '', fileName: 'chapter.md', capturedAt: '', revision: 'frozen' },
        html: '<article class="markdown-body"><p id="A">first A</p><p id="B">first B</p><p id="A">second A</p><p id="B">second B</p><a href="#A">A</a><a href="#B">B</a></article>',
      }] })
      const document = new DOMParser().parseFromString(book.html, 'text/html')
      return {
        ids: [...document.querySelectorAll('[id]')].map(element => element.id),
        targets: [...document.querySelectorAll('a')].map(anchor => document.getElementById(anchor.getAttribute('href')!.slice(1))?.textContent),
        warnings: book.warnings.map(warning => warning.code),
      }
    })
    expect(new Set(result.ids).size).toBe(result.ids.length)
    expect(result.targets).toEqual(['first A', 'first B'])
    expect(result.warnings).toEqual(['duplicate-export-id', 'duplicate-export-id'])
  })

  test('unnamed chapters resolve local anchors independently and duplicate source identities fail closed', async ({ page }) => {
    await page.goto('/')
    const result = await page.evaluate(async () => {
      const { composeExportBook } = await import('/src/services/export/book.ts')
      const chapters = ['untitled-1', 'untitled-2'].map((sourceId, order) => ({
        sourceId, title: 'Untitled', level: 5, order,
        snapshot: { markdown: '# Same\n## Deep', fileName: 'Untitled.md', capturedAt: '', revision: sourceId },
        html: '<article class="markdown-body"><h1 id="same">Same</h1><h2 id="deep">Deep</h2><a href="#same">Local</a></article>',
      }))
      const book = composeExportBook({ chapters, title: 'Book' })
      const document = new DOMParser().parseFromString(book.html, 'text/html')
      let rejected = false
      try { composeExportBook({ chapters: [chapters[0], chapters[0]], title: 'Duplicate' }) } catch { rejected = true }
      return {
        warnings: book.warnings.map(warning => warning.code),
        locals: [...document.querySelectorAll('section')].map(section => section.querySelector('a')?.getAttribute('href') === `#${section.querySelector('h6')?.id}`),
        rejected,
      }
    })
    expect(result.warnings).toEqual(['export-heading-depth-clamped', 'export-heading-depth-clamped'])
    expect(result.locals).toEqual([true, true])
    expect(result.rejected).toBe(true)
  })
})
