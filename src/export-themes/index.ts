import baseCss from './base.css?inline'
import simpleReadingCss from './simple-reading.css?inline'
import technicalCss from './technical.css?inline'
import formalReportCss from './formal-report.css?inline'
import type { ExportProfile, ExportThemeId } from '@/services/export/types'

const themeCss: Record<ExportThemeId, string> = {
  'simple-reading': simpleReadingCss,
  technical: technicalCss,
  'formal-report': formalReportCss,
}

const bodyFonts: Record<string, string> = {
  'system-cjk': '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  'system-serif': 'Georgia, "Songti SC", "Noto Serif CJK SC", serif',
}
const codeFonts: Record<string, string> = {
  'system-monospace': 'ui-monospace, "Cascadia Code", "SFMono-Regular", Consolas, monospace',
}

export function buildExportThemeCss(profile: ExportProfile): string {
  const { top, right, bottom, left } = profile.page.marginMm
  const margin = `${top}mm ${right}mm ${bottom}mm ${left}mm`
  const bodyFont = bodyFonts[profile.typography.bodyFont] ?? bodyFonts['system-cjk']
  const codeFont = codeFonts[profile.typography.codeFont] ?? codeFonts['system-monospace']
  const variables = `:root { --export-body-font: ${bodyFont}; --export-code-font: ${codeFont}; --export-body-size: ${profile.typography.bodySizePt}pt; --export-line-height: ${profile.typography.lineHeight}; }`
  const page = `@media print { @page { size: ${profile.page.size} ${profile.page.orientation}; margin: ${margin}; } }`
  const numbering = profile.numberHeadings
    ? '.markdown-body { counter-reset: export-h1; } .markdown-body h1 { counter-reset: export-h2; counter-increment: export-h1; } .markdown-body h1::before { content: counter(export-h1) ". "; } .markdown-body h2 { counter-reset: export-h3; counter-increment: export-h2; } .markdown-body h2::before { content: counter(export-h1) "." counter(export-h2) " "; } .markdown-body h3 { counter-increment: export-h3; } .markdown-body h3::before { content: counter(export-h1) "." counter(export-h2) "." counter(export-h3) " "; }'
    : ''
  return `${baseCss}\n${themeCss[profile.theme]}\n${variables}\n${page}\n${numbering}`
}

export const EXPORT_THEME_LABELS: Record<ExportThemeId, { en: string; zh: string; ja: string }> = {
  'simple-reading': { en: 'Simple reading', zh: '简洁阅读', ja: 'シンプルな読書' },
  technical: { en: 'Technical document', zh: '技术文档', ja: '技術文書' },
  'formal-report': { en: 'Formal report', zh: '正式报告', ja: '正式レポート' },
}
