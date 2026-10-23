import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function readSource(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

const dialog = readSource('../../src/components/exportSettings/ExportSettingsDialog.vue')
const preview = readSource('../../src/components/export/ExportPreview.vue')
const config = readSource('../../src/services/export/config.ts')
const workflow = readSource('../../src/services/export/workflow.ts')

describe('unified export workflow contract', () => {
  it('renders from a frozen active buffer and reuses the same snapshot for output', () => {
    expect(dialog).toContain('captureExportSnapshot(tab)')
    expect(dialog).toContain('snapshot: frozen')
    expect(dialog).toContain('renderExportPreview({')
    expect(dialog).toContain('outputPath: target')
    expect(dialog).toContain('previewRequest.value = result.request')
    expect(dialog).toContain('const frozen = { ...clone(previewRequest.value), renderedHtml: previewHtml.value }')
    expect(dialog).toMatch(/createExportRequest\(\{\s*\.\.\.frozen,\s*outputPath: target,/)
    const exportOperation = dialog.slice(dialog.indexOf('async function doExport()'), dialog.indexOf('function operationIsCurrent'))
    expect(exportOperation).not.toMatch(/profileDraft\.value|format\.value|selectedProfileId\.value|projectRoot\.value/)
  })

  it('routes every automatic format through safe static HTML', () => {
    expect(dialog).toContain("renderedHtml: frozen.format === 'html' ? restoreExternalImageLinks(frozen.renderedHtml) : frozen.renderedHtml")
    expect(workflow).toContain('prepareHtmlResources(')
    expect(workflow).toContain('exportReadResource')
    expect(workflow).toContain('buildExportThemeCss(input.profile)')
  })

  it('keeps the preview isolated from editor UI and page scripts', () => {
    expect(preview).toContain('sandbox="allow-same-origin allow-modals"')
    expect(preview).not.toContain('allow-scripts')
    expect(preview).toContain('contentWindow.print()')
  })

  it('saves project presets with optimistic concurrency and surfaces source precedence', () => {
    expect(config).toContain('exportSaveConfig(root, config, current.fingerprint)')
    expect(dialog).toContain("sourceStatus(fieldSource('theme'))")
    expect(dialog).toContain('saveProjectPreset')
    expect(dialog).toContain('savePersonal')
  })

  it('does not claim a system print dialog saved a file', () => {
    expect(dialog).toContain("taskStage.value = 'waitingForPrintDialog'")
    expect(dialog).toContain('MarkCaptain cannot tell whether a file was saved')
    expect(dialog).not.toContain('await exportPdf(')
  })
})
