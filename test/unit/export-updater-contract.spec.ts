import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

const exportDialog = readSource('../../src/components/exportSettings/ExportSettingsDialog.vue')
const updaterDialog = readSource('../../src/components/updater/UpdaterDialog.vue')
const updaterConfig = JSON.parse(readSource('../../src-tauri/tauri.conf.json')) as {
  plugins: {
    updater: {
      active: boolean
      endpoints: string[]
      pubkey: string
    }
  }
}
const updaterDocs = readSource('../../docs/UPDATER.md')

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
      'paperSize: paperSize.value',
      'orientation: orientation.value',
      'title: includeTitle.value ? base : undefined',
      'toc: enableToc.value',
    ]) {
      expect(exportDialog).toContain(option)
    }
    expect(exportDialog).toContain("v-if=\"format === 'pandoc-pdf'\"")
  })
})

describe('updater fail-closed contract', () => {
  it('uses this repository endpoint while remaining disabled without a key', () => {
    expect(updaterConfig.plugins.updater).toEqual({
      active: false,
      endpoints: [
        'https://github.com/yulianjie/MarkCaptain/releases/latest/download/latest.json',
      ],
      pubkey: '',
    })
  })

  it('blocks disabled or unsafe configuration before importing the updater check', () => {
    const readiness = functionBody(updaterDialog, 'function updaterReadiness', 'async function open()')
    expect(readiness).toContain('if (!updaterConfig.active)')
    expect(readiness).toContain('updaterConfig.pubkey.trim().length > 0')
    expect(readiness).toContain("endpoint.startsWith('https://')")

    const open = functionBody(updaterDialog, 'async function open()', 'async function downloadAndInstall()')
    const guard = open.indexOf("if (readiness !== 'ready')")
    const checkImport = open.indexOf("await import('@tauri-apps/plugin-updater')")
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(checkImport).toBeGreaterThan(guard)
    expect(updaterDialog).toContain("phase === 'disabled'")
    expect(updaterDialog).toContain("phase === 'unconfigured'")
  })

  it('reports up-to-date only after a configured check returns no update', () => {
    const open = functionBody(updaterDialog, 'async function open()', 'async function downloadAndInstall()')
    expect(open).toMatch(/const update = await check\(\)[\s\S]*?if \(!update\) \{[\s\S]*?phase\.value = 'uptodate'/)
    expect(updaterDialog.match(/phase\.value = 'uptodate'/g)).toHaveLength(1)
    expect(updaterDialog).toContain("phase.value = 'error'")
  })

  it('documents the actual registered-plugin and unsigned-release state', () => {
    expect(updaterDocs).toContain('The Rust plugin **is registered**')
    expect(updaterDocs).toContain('yulianjie/MarkCaptain')
    expect(updaterDocs).toContain('current release workflow does not sign updater artifacts')
    expect(updaterDocs).toContain('`active` is a MarkCaptain renderer gate')
    expect(updaterDocs).not.toContain('uncomment')
  })
})
