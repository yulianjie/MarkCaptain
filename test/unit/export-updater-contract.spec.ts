import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

const exportDialog = readSource('../../src/components/exportSettings/ExportSettingsDialog.vue')
const editorPage = readSource('../../src/pages/EditorPage.vue')
function functionBody(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('export dialog workflow contract', () => {
  it('presents system printing, Pandoc PDF, and styled HTML as distinct paths', () => {
    expect(exportDialog).toContain("type ExportFormat = 'print' | 'pandoc-pdf' | 'html'")
    expect(exportDialog).toContain('<el-radio value="print"')
    expect(exportDialog).toContain('<el-radio value="pandoc-pdf"')
    expect(exportDialog).toContain('<el-radio value="html"')
    expect(exportDialog).toContain('Pandoc is not required')
    expect(exportDialog).toContain('Requires Pandoc and a compatible PDF engine')
  })

  it('opens system printing without requesting a destination path first', () => {
    const doExport = functionBody(exportDialog, 'async function doExport()', 'let unsub:')
    const printBranch = doExport.indexOf("if (format.value === 'print')")
    const savePath = doExport.indexOf('const target = await saveAsDialog')

    expect(printBranch).toBeGreaterThanOrEqual(0)
    expect(savePath).toBeGreaterThan(printBranch)

    const printRequest = functionBody(
      exportDialog,
      'async function requestSystemPrint()',
      'async function offerSystemPrintFallback',
    )
    expect(printRequest).toContain('await nextTick()')
    expect(printRequest).toContain('await exportPdf(getCurrentWindow().label)')
  })

  it('offers an explicit system-print fallback after a Pandoc failure', () => {
    const fallback = functionBody(
      exportDialog,
      'async function offerSystemPrintFallback',
      'async function doExport()',
    )
    expect(fallback).toContain('await ElMessageBox.confirm')
    expect(fallback).toContain('confirmButtonText: copy.value.fallbackConfirm')
    expect(fallback).toContain('cancelButtonText: copy.value.fallbackCancel')
    expect(fallback).toContain('await requestSystemPrint()')

    const doExport = functionBody(exportDialog, 'async function doExport()', 'let unsub:')
    expect(doExport).toContain('await offerSystemPrintFallback(err)')
  })

  it('retains all existing Pandoc layout and document options', () => {
    for (const option of [
      'paperSize: exportOptions.paperSize',
      'orientation: exportOptions.orientation',
      'title: exportOptions.includeTitle ? base : undefined',
      'toc: exportOptions.enableToc',
    ]) {
      expect(exportDialog).toContain(option)
    }
    const doExport = functionBody(exportDialog, 'async function doExport()', 'let unsub:')
    expect(doExport.indexOf('const exportOptions = {')).toBeLessThan(doExport.indexOf('const target = await saveAsDialog'))
    for (const option of ['paperSize: paperSize.value', 'orientation: orientation.value', 'includeTitle: includeTitle.value', 'enableToc: enableToc.value']) {
      expect(doExport).toContain(option)
    }
    expect(exportDialog).toContain("v-if=\"format === 'pandoc-pdf'\"")
  })

  it('captures the active document and Muya instance before the HTML save dialog', () => {
    const doExport = functionBody(editorPage, 'async function doExportHtml()', 'function doPrint()')
    const targetDialog = doExport.indexOf('await saveAsDialog')
    expect(doExport.indexOf('const markdown = tab.markdown')).toBeLessThan(targetDialog)
    expect(doExport.indexOf('const muya = editor.getMuyaInstance()')).toBeLessThan(targetDialog)
    expect(doExport).toContain('new ExportHtml(markdown, muya)')
  })
})
