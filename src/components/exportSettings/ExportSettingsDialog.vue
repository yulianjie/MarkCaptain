<script setup lang="ts">
/**
 * Export settings dialog — replaces the upstream
 * `src/renderer/components/exportSettings/` Vue 2 dialog.
 *
 * Opens on `bus.emit('show-export-dialog')` and keeps the three export paths
 * explicit: OS printing, Pandoc PDF generation, and styled HTML. OS printing
 * deliberately has no save-path step because the platform print dialog owns
 * the "Save as PDF" destination.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { ElMessageBox } from 'element-plus'
import { bus } from '@/bus'
import { useI18n } from '@/i18n'
import { useEditorStore } from '@/stores/editor'
import { useNotificationStore } from '@/stores/notification'
import { exportHtml, exportPdf, pandocPdfExport, saveAsDialog } from '@/services/tauri-invoke'

const { t, locale } = useI18n()
const editor = useEditorStore()
const notify = useNotificationStore()

type ExportFormat = 'print' | 'pandoc-pdf' | 'html'

const localizedCopy = {
  en: {
    systemPrint: 'System print / Save as PDF',
    systemPrintDescription: 'Uses the operating system print dialog. Choose “Save as PDF” there; Pandoc is not required.',
    pandocPdf: 'Pandoc PDF',
    pandocPdfDescription: 'Creates a PDF file directly. Requires Pandoc and a compatible PDF engine.',
    htmlDescription: 'Creates a self-contained HTML file with the editor styling.',
    openPrint: 'Open Print Dialog',
    fallbackTitle: 'Pandoc PDF export failed',
    fallbackPrompt: 'Pandoc could not create the PDF. Use the system print dialog instead and choose “Save as PDF”?\n\nDetails: {error}',
    fallbackConfirm: 'Use System Print',
    fallbackCancel: 'Keep Error',
  },
  'zh-CN': {
    systemPrint: '系统打印 / 另存为 PDF',
    systemPrintDescription: '使用操作系统打印对话框，可在其中选择“另存为 PDF”，不依赖 Pandoc。',
    pandocPdf: 'Pandoc PDF',
    pandocPdfDescription: '直接生成 PDF 文件，需要安装 Pandoc 和兼容的 PDF 引擎。',
    htmlDescription: '生成包含编辑器样式的独立 HTML 文件。',
    openPrint: '打开打印对话框',
    fallbackTitle: 'Pandoc PDF 导出失败',
    fallbackPrompt: 'Pandoc 无法生成 PDF。是否改用系统打印，并在打印对话框中选择“另存为 PDF”？\n\n错误详情：{error}',
    fallbackConfirm: '改用系统打印',
    fallbackCancel: '保留错误',
  },
  ja: {
    systemPrint: 'システム印刷 / PDF として保存',
    systemPrintDescription: 'OS の印刷ダイアログを使用します。そこで「PDF として保存」を選べるため、Pandoc は不要です。',
    pandocPdf: 'Pandoc PDF',
    pandocPdfDescription: 'PDF ファイルを直接作成します。Pandoc と互換性のある PDF エンジンが必要です。',
    htmlDescription: 'エディターのスタイルを含む単一の HTML ファイルを作成します。',
    openPrint: '印刷ダイアログを開く',
    fallbackTitle: 'Pandoc PDF のエクスポートに失敗しました',
    fallbackPrompt: 'Pandoc で PDF を作成できませんでした。システム印刷に切り替えて「PDF として保存」を選びますか？\n\n詳細：{error}',
    fallbackConfirm: 'システム印刷を使う',
    fallbackCancel: 'エラーを保持',
  },
} as const

const copy = computed(() => localizedCopy[locale.value] ?? localizedCopy.en)
const visible = ref(false)
const format = ref<ExportFormat>('print')
const paperSize = ref<'A4' | 'A5' | 'Letter' | 'Legal'>('A4')
const orientation = ref<'portrait' | 'landscape'>('portrait')
const includeTitle = ref(true)
const enableToc = ref(false)

function open() {
  visible.value = true
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function showExportError(err: unknown) {
  notify.pushToast({
    type: 'error',
    title: t('toast.exportFailed'),
    message: errorMessage(err),
  })
}

async function requestSystemPrint() {
  visible.value = false
  // Let Element Plus remove the modal before the print snapshot is taken.
  await nextTick()
  await exportPdf(getCurrentWindow().label)
}

async function offerSystemPrintFallback(err: unknown) {
  const message = copy.value.fallbackPrompt.replace('{error}', errorMessage(err))
  try {
    await ElMessageBox.confirm(message, copy.value.fallbackTitle, {
      type: 'warning',
      confirmButtonText: copy.value.fallbackConfirm,
      cancelButtonText: copy.value.fallbackCancel,
      distinguishCancelAndClose: true,
    })
  } catch {
    showExportError(err)
    return
  }

  try {
    await requestSystemPrint()
  } catch (printErr) {
    showExportError(printErr)
  }
}

async function doExport() {
  const tab = editor.currentFile
  if (!tab) {
    visible.value = false
    return
  }

  if (format.value === 'print') {
    try {
      await requestSystemPrint()
    } catch (err) {
      showExportError(err)
    }
    return
  }

  const exportFormat = format.value
  const markdown = tab.markdown
  const filename = tab.filename
  const exportMuya = exportFormat === 'html' ? editor.getMuyaInstance() : null
  const exportOptions = {
    paperSize: paperSize.value,
    orientation: orientation.value,
    includeTitle: includeTitle.value,
    enableToc: enableToc.value,
  }
  const ext = exportFormat === 'pandoc-pdf' ? 'pdf' : 'html'
  const base = filename.replace(/\.md$/i, '') || 'untitled'
  const target = await saveAsDialog(`${base}.${ext}`)
  if (!target) return
  visible.value = false
  try {
    if (exportFormat === 'pandoc-pdf') {
      await pandocPdfExport(markdown, target, {
        paperSize: exportOptions.paperSize,
        orientation: exportOptions.orientation,
        title: exportOptions.includeTitle ? base : undefined,
        toc: exportOptions.enableToc,
      })
    } else {
      if (!exportMuya) throw new Error(t('toast.editorNotReady'))
      const { default: ExportHtml } = await import('muya/lib/utils/exportHtml')
      const exporter = new ExportHtml(markdown, exportMuya)
      const html = await exporter.generate({
        title: exportOptions.includeTitle ? base : '',
        toc: exportOptions.enableToc,
        printOptimization: true,
        extraCss: '',
      })
      await exportHtml(target, html)
    }
    notify.pushToast({ type: 'success', message: t('toast.exportedTo', { path: target }) })
  } catch (err) {
    if (exportFormat === 'pandoc-pdf') {
      await offerSystemPrintFallback(err)
    } else {
      showExportError(err)
    }
  }
}

let unsub: (() => void) | null = null
onMounted(() => { unsub = bus.on('show-export-dialog', open) })
onBeforeUnmount(() => { unsub?.() })
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="t('exportSettings.title')"
    width="420px"
    :close-on-click-modal="false"
    append-to-body
  >
    <el-form label-position="left" label-width="140px">
      <el-form-item :label="t('exportSettings.format')">
        <el-radio-group v-model="format" class="format-list">
          <el-radio value="print" class="format-option">
            <span class="format-name">{{ copy.systemPrint }}</span>
            <span class="format-description">{{ copy.systemPrintDescription }}</span>
          </el-radio>
          <el-radio value="pandoc-pdf" class="format-option">
            <span class="format-name">{{ copy.pandocPdf }}</span>
            <span class="format-description">{{ copy.pandocPdfDescription }}</span>
          </el-radio>
          <el-radio value="html" class="format-option">
            <span class="format-name">{{ t('exportSettings.formatHtmlStyled') }}</span>
            <span class="format-description">{{ copy.htmlDescription }}</span>
          </el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item v-if="format === 'pandoc-pdf'" :label="t('exportSettings.paperSize')">
        <el-select v-model="paperSize" style="width: 160px">
          <el-option label="A4" value="A4" />
          <el-option label="A5" value="A5" />
          <el-option label="Letter" value="Letter" />
          <el-option label="Legal" value="Legal" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="format === 'pandoc-pdf'" :label="t('exportSettings.orientation')">
        <el-radio-group v-model="orientation">
          <el-radio value="portrait">{{ t('exportSettings.orientationPortrait') }}</el-radio>
          <el-radio value="landscape">{{ t('exportSettings.orientationLandscape') }}</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item v-if="format !== 'print'" :label="t('exportSettings.includeTitle')">
        <el-switch v-model="includeTitle" />
      </el-form-item>
      <el-form-item v-if="format !== 'print'" :label="t('exportSettings.enableToc')">
        <el-switch v-model="enableToc" />
      </el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="visible = false">{{ t('common.cancel') }}</el-button>
      <el-button type="primary" @click="doExport">
        {{ format === 'print' ? copy.openPrint : t('exportSettings.export') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.format-list {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
  width: 100%;
}

.format-option {
  height: auto;
  margin-right: 0;
  white-space: normal;
}

.format-option :deep(.el-radio__label) {
  display: grid;
  gap: 2px;
  line-height: 1.35;
}

.format-name {
  color: var(--el-text-color-primary);
}

.format-description {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>
