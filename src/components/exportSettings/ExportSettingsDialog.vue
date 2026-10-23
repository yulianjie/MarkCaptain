<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessageBox } from 'element-plus'
import { bus } from '@/bus'
import { useI18n } from '@/i18n'
import { useEditorStore } from '@/stores/editor'
import { useProjectStore } from '@/stores/project'
import { useNotificationStore } from '@/stores/notification'
import {
  exportPreflight,
  exportSaveDialog,
  exportStart,
  onExportProgress,
} from '@/services/tauri-invoke'
import ExportPreview from '@/components/export/ExportPreview.vue'
import { BUILTIN_PROFILES, createProfileSourceMap, loadPersonalExportDefaults, savePersonalExportDefaults, resolveExportProfile, validateExportProjectConfig } from '@/services/export/profiles'
import { loadProjectExportConfig, saveProjectExportProfile } from '@/services/export/config'
import { createExportRequest } from '@/services/export/request'
import { captureExportSnapshot, projectForExport, projectOutputDirectory, suggestedExportFileName } from '@/services/export/snapshot'
import { restoreExternalImageLinks } from '@/services/export/resources'
import { cancelExport, renderExportPreview } from '@/services/export/workflow'
import { EXPORT_THEME_LABELS } from '@/export-themes'
import { projectExportCopy } from '@/services/export/project-copy'
import type {
  ExportConfigSnapshot,
  ExportDiagnostic,
  ExportFormat,
  ExportProgressEvent,
  ExportProfile,
  ExportRequest,
  ExportThemeId,
} from '@/services/export/types'

const { locale, t } = useI18n()
const editor = useEditorStore()
const project = useProjectStore()
const notify = useNotificationStore()

const translations = {
  en: {
    title: 'Export document', format: 'Format', theme: 'Export theme', preset: 'Preset', presetName: 'Preset name',
    preview: 'Preview', refreshPreview: 'Refresh preview', export: 'Export', print: 'Open print dialog', cancel: 'Cancel',
    saveProject: 'Save as project preset', savePersonal: 'Use as personal default', source: 'Setting source',
    builtIn: 'Built-in default', personal: 'Personal default', project: 'Project preset', temporary: 'This export',
    output: 'Output', page: 'Paper', orientation: 'Orientation', portrait: 'Portrait', landscape: 'Landscape',
    includeTitle: 'Include title', toc: 'Table of contents', tocDepth: 'TOC depth', resourceMode: 'HTML images',
    embedded: 'Embed local images', folder: 'Create assets folder', remote: 'Download remote images',
    remoteUnavailable: 'Remote image downloads are not available in this release.',
    formatPreview: 'Content preview. Pandoc styles and final pagination depend on the selected writer and engine.',
    htmlPreview: 'HTML and print use this isolated rendered preview. Local images are embedded for preview.',
    noDocument: 'Open a Markdown document before exporting.', noProject: 'Open a project to save a project preset.',
    outsideProject: 'This document is outside the open project; its preset and resources are not used.',
    previewFirst: 'Refresh the preview after changing the document or export settings.',
    acknowledge: 'I reviewed the warnings and want to continue.', warnings: 'Warnings', errors: 'Cannot export yet',
    noWarnings: 'No blocking issues found.', loading: 'Loading project preset…', stale: 'Preview is out of date.',
    printWaiting: 'Print dialog opened. Choose Print or Save as PDF there.', printClosed: 'Print dialog closed. MarkCaptain cannot tell whether a file was saved.',
    printClosedButton: 'Print dialog is closed', pandocFallbackTitle: 'Pandoc PDF export failed',
    pandocFallback: 'Pandoc could not create the PDF. Open the system print dialog instead?', usePrint: 'Use system print', keepError: 'Keep error',
    saved: 'Export preset saved for this project.', savedPersonal: 'Personal export defaults saved.',
    html: 'HTML', pdf: 'PDF', docx: 'Word (DOCX)', odt: 'OpenDocument (ODT)', epub: 'EPUB',
    simpleReading: 'Simple reading', technical: 'Technical document', formalReport: 'Formal report',
    systemPrint: 'System print / Save as PDF', pandoc: 'Pandoc PDF',
    untitled: 'Untitled', unsavedBuffer: 'Unsaved buffer', waitingPreview: 'Waiting for fonts and images…',
    choosePreview: 'Choose Preview to render this document.', previewTimeout: 'Fonts or images did not become ready within 15 seconds.',
    previewFailed: 'The isolated preview could not be opened.', pandocMissing: 'Pandoc is not installed or not on PATH.',
    pdfEngineMissing: 'Install an available PDF engine (XeLaTeX, Typst or WeasyPrint).',
    remoteDownloadUnavailable: 'Remote resource downloads are not available in this release.',
    remoteNotEmbedded: 'Remote images remain external and are not loaded in preview.',
    resourceBaseMissing: 'Local images need a saved source path before they can be exported.',
    resourceBudget: 'Embedded local images exceed the 48 MiB preview limit.',
    resourceUnavailable: 'A local image could not be read; its alternative text will be shown.',
    pandocFailed: 'Pandoc could not create this document.',
    unbundledNoteLink: 'The linked Markdown note is not included in this single-file export; its .md link is preserved.',
    missingHeading: 'The linked heading is not in this document; the original fragment is kept.', line: 'Line',
    advanced: 'Advanced typography & output', bodyFont: 'Body font', systemCjk: 'System CJK sans-serif', systemSerif: 'System CJK serif',
    bodySizePt: 'Body size (pt)', lineHeight: 'Line height', lineHeightUnsupported: 'Line height is not mapped for DOCX/ODT yet.',
    margins: 'Page margins (mm)', marginTop: 'Top (mm)', marginRight: 'Right (mm)', marginBottom: 'Bottom (mm)', marginLeft: 'Left (mm)',
    marginsUnsupported: 'EPUB readers control page layout; page margins do not apply.', numberHeadings: 'Number headings',
    outputDirectory: 'Project output directory', outputFileName: 'Output file name',
    outputFileNameHelp: 'Supported variables: {name}, {profile}, {date}. The extension is added automatically.',
    profileInvalid: 'Correct the advanced settings before saving this project preset.',
    projectDirectoryOnly: 'Open a project to configure a project-relative output directory.',
  },
  'zh-CN': {
    title: '导出文档', format: '格式', theme: '导出主题', preset: '预设', presetName: '预设名称',
    preview: '预览', refreshPreview: '刷新预览', export: '导出', print: '打开打印对话框', cancel: '取消',
    saveProject: '保存为项目预设', savePersonal: '设为个人默认', source: '设置来源',
    builtIn: '内置默认', personal: '个人默认', project: '项目预设', temporary: '本次导出',
    output: '输出', page: '纸张', orientation: '方向', portrait: '纵向', landscape: '横向',
    includeTitle: '包含标题', toc: '目录', tocDepth: '目录深度', resourceMode: 'HTML 图片',
    embedded: '嵌入本地图片', folder: '另建资源目录', remote: '下载远程图片',
    remoteUnavailable: '当前版本暂不支持下载远程图片。',
    formatPreview: '这是正文预览。Pandoc 样式和最终分页取决于所选格式与引擎。',
    htmlPreview: 'HTML 和打印使用此隔离预览。本地图片已嵌入预览。',
    noDocument: '请先打开一个 Markdown 文档。', noProject: '打开项目后才能保存项目预设。',
    outsideProject: '当前文档位于已打开项目之外，不使用该项目的预设和资源范围。',
    previewFirst: '文档或导出设置变化后，请刷新预览。',
    acknowledge: '我已查看警告，仍要继续。', warnings: '警告', errors: '暂时无法导出',
    noWarnings: '没有阻止导出的项目。', loading: '正在读取项目预设…', stale: '预览已过期。',
    printWaiting: '已打开打印对话框。请在系统对话框中选择打印或另存为 PDF。', printClosed: '打印对话框已关闭。MarkCaptain 无法判断是否保存了文件。',
    printClosedButton: '打印对话框已关闭', pandocFallbackTitle: 'Pandoc PDF 导出失败',
    pandocFallback: 'Pandoc 无法生成 PDF。是否改用系统打印对话框？', usePrint: '改用系统打印', keepError: '保留错误',
    saved: '项目导出预设已保存。', savedPersonal: '个人导出默认值已保存。',
    html: 'HTML', pdf: 'PDF', docx: 'Word（DOCX）', odt: 'OpenDocument（ODT）', epub: 'EPUB',
    simpleReading: '简洁阅读', technical: '技术文档', formalReport: '正式报告',
    systemPrint: '系统打印 / 另存为 PDF', pandoc: 'Pandoc PDF',
    untitled: '未命名文档', unsavedBuffer: '未保存缓冲区', waitingPreview: '正在等待字体和图片…',
    choosePreview: '选择“预览”以生成文档预览。', previewTimeout: '字体或图片在 15 秒内未就绪。',
    previewFailed: '无法打开隔离预览。', pandocMissing: '未安装 Pandoc，或系统 PATH 中找不到它。',
    pdfEngineMissing: '请安装可用 PDF 引擎（XeLaTeX、Typst 或 WeasyPrint）。',
    remoteDownloadUnavailable: '当前版本暂不支持下载远程资源。',
    remoteNotEmbedded: '远程图片保持外链，预览中不会加载。',
    resourceBaseMissing: '本地图片需要文档源文件路径才能导出。',
    resourceBudget: '本地嵌入图片超过 48 MiB 预览限制。',
    resourceUnavailable: '无法读取本地图片，将显示其替代文本。',
    pandocFailed: 'Pandoc 无法生成此文档。',
    unbundledNoteLink: '单文件导出不包含此 Markdown 笔记，链接保留为 .md。',
    missingHeading: '本文档中没有此标题，导出时保留原始锚点。', line: '第',
    advanced: '高级排版与输出', bodyFont: '正文字体', systemCjk: '系统中文无衬线', systemSerif: '系统中文衬线',
    bodySizePt: '正文字号（pt）', lineHeight: '行距', lineHeightUnsupported: 'DOCX/ODT 尚未映射行距设置。',
    margins: '页边距（mm）', marginTop: '上（mm）', marginRight: '右（mm）', marginBottom: '下（mm）', marginLeft: '左（mm）',
    marginsUnsupported: 'EPUB 阅读器控制页面布局，页边距设置不适用。', numberHeadings: '标题编号',
    outputDirectory: '项目输出目录', outputFileName: '输出文件名',
    outputFileNameHelp: '支持变量：{name}、{profile}、{date}。扩展名会自动添加。',
    profileInvalid: '请先修正高级设置，再保存项目预设。',
    projectDirectoryOnly: '打开项目后才能设置项目相对输出目录。',
  },
  ja: {
    title: 'ドキュメントを書き出す', format: '形式', theme: '書き出しテーマ', preset: 'プリセット', presetName: 'プリセット名',
    preview: 'プレビュー', refreshPreview: 'プレビューを更新', export: '書き出す', print: '印刷ダイアログを開く', cancel: 'キャンセル',
    saveProject: 'プロジェクトプリセットとして保存', savePersonal: '個人の既定値にする', source: '設定元',
    builtIn: '組み込み既定値', personal: '個人設定', project: 'プロジェクト設定', temporary: '今回のみ',
    output: '出力', page: '用紙', orientation: '向き', portrait: '縦', landscape: '横',
    includeTitle: 'タイトルを含める', toc: '目次', tocDepth: '目次の深さ', resourceMode: 'HTML 画像',
    embedded: 'ローカル画像を埋め込む', folder: 'リソースフォルダーを作成', remote: 'リモート画像をダウンロード',
    remoteUnavailable: 'このリリースではリモート画像をダウンロードできません。',
    formatPreview: '本文のプレビューです。Pandoc のスタイルと改ページは出力形式とエンジンによって異なります。',
    htmlPreview: 'HTML と印刷にはこの隔離プレビューを使用します。ローカル画像はプレビューに埋め込みます。',
    noDocument: '書き出す Markdown ドキュメントを開いてください。', noProject: 'プロジェクトを開くとプロジェクトプリセットを保存できます。',
    outsideProject: 'このドキュメントは開いているプロジェクトの外にあるため、そのプリセットとリソース範囲は適用されません。',
    previewFirst: 'ドキュメントまたは設定を変更した後、プレビューを更新してください。',
    acknowledge: '警告を確認し、続行します。', warnings: '警告', errors: 'まだ書き出せません',
    noWarnings: 'ブロックする問題はありません。', loading: 'プロジェクトプリセットを読み込み中…', stale: 'プレビューが古くなっています。',
    printWaiting: '印刷ダイアログを開きました。システム側で印刷または PDF 保存を選んでください。', printClosed: '印刷ダイアログが閉じました。ファイルが保存されたかは確認できません。',
    printClosedButton: '印刷ダイアログを閉じました', pandocFallbackTitle: 'Pandoc PDF の書き出しに失敗しました',
    pandocFallback: 'Pandoc で PDF を作成できませんでした。システム印刷を使いますか？', usePrint: 'システム印刷を使う', keepError: 'エラーを保持',
    saved: 'プロジェクトの書き出しプリセットを保存しました。', savedPersonal: '個人の書き出し既定値を保存しました。',
    html: 'HTML', pdf: 'PDF', docx: 'Word（DOCX）', odt: 'OpenDocument（ODT）', epub: 'EPUB',
    simpleReading: 'シンプルな読書', technical: '技術文書', formalReport: '正式レポート',
    systemPrint: 'システム印刷 / PDF として保存', pandoc: 'Pandoc PDF',
    untitled: '無題', unsavedBuffer: '未保存のバッファー', waitingPreview: 'フォントと画像を待機中…',
    choosePreview: 'プレビューを選択してドキュメントを表示してください。', previewTimeout: 'フォントまたは画像が 15 秒以内に準備できませんでした。',
    previewFailed: '隔離プレビューを開けませんでした。', pandocMissing: 'Pandoc がインストールされていないか、PATH にありません。',
    pdfEngineMissing: '利用可能な PDF エンジン（XeLaTeX、Typst、WeasyPrint）をインストールしてください。',
    remoteDownloadUnavailable: 'このリリースではリモートリソースをダウンロードできません。',
    remoteNotEmbedded: 'リモート画像は外部リンクのままになり、プレビューでは読み込みません。',
    resourceBaseMissing: 'ローカル画像の書き出しには保存済みの元ファイルパスが必要です。',
    resourceBudget: '埋め込みローカル画像が 48 MiB のプレビュー上限を超えています。',
    resourceUnavailable: 'ローカル画像を読み込めません。代替テキストを表示します。',
    pandocFailed: 'Pandoc でドキュメントを作成できませんでした。',
    unbundledNoteLink: 'リンク先の Markdown ノートは単一ファイル書き出しに含まれず、.md リンクを保持します。',
    missingHeading: 'このドキュメントにリンク先の見出しがないため、元のフラグメントを保持します。', line: '行',
    advanced: '高度な組版と出力', bodyFont: '本文フォント', systemCjk: 'システム CJK サンセリフ', systemSerif: 'システム CJK セリフ',
    bodySizePt: '本文サイズ（pt）', lineHeight: '行間', lineHeightUnsupported: 'DOCX/ODT の行間設定はまだ未対応です。',
    margins: 'ページ余白（mm）', marginTop: '上（mm）', marginRight: '右（mm）', marginBottom: '下（mm）', marginLeft: '左（mm）',
    marginsUnsupported: 'EPUB のページレイアウトはリーダー側で管理されるため、余白設定は適用されません。', numberHeadings: '見出し番号',
    outputDirectory: 'プロジェクトの出力フォルダー', outputFileName: '出力ファイル名',
    outputFileNameHelp: '使用できる変数：{name}、{profile}、{date}。拡張子は自動で追加されます。',
    profileInvalid: 'プロジェクトプリセットを保存する前に詳細設定を修正してください。',
    projectDirectoryOnly: 'プロジェクトを開くとプロジェクト相対の出力フォルダーを設定できます。',
  },
} as const

type Copy = { [Key in keyof typeof translations.en]: string }
const copy = computed<Copy>(() => {
  const selected = locale.value === 'zh-CN' ? 'zh-CN' : locale.value === 'ja' ? 'ja' : 'en'
  return translations[selected]
})
const visible = ref(false)
const format = ref<ExportFormat>('html')
const profileDraft = ref<ExportProfile>(clone(BUILTIN_PROFILES['simple-reading']))
const profileName = ref(profileDraft.value.name)
const selectedProfileId = ref(profileDraft.value.id)
const configSnapshot = ref<ExportConfigSnapshot>({ config: null, fingerprint: null })
const profileSources = ref<Record<string, 'builtin' | 'personal' | 'project' | 'this-export'>>({})
const personalDefaults = ref(loadPersonalExportDefaults())
const configLoading = ref(false)
const configError = ref('')
const hasTemporaryOverrides = ref(false)
const snapshot = ref<ReturnType<typeof captureExportSnapshot> | null>(null)
const previewRequest = ref<ExportRequest | null>(null)
const previewHtml = ref('')
const previewStale = ref(false)
const previewReady = ref(false)
const previewBusy = ref(false)
const taskStage = ref<'idle' | 'preflighting' | 'rendering' | 'writing' | 'ready' | 'waitingForPrintDialog' | 'completed' | 'cancelled' | 'failed'>('idle')
const taskError = ref('')
const preflightWarnings = ref<ExportDiagnostic[]>([])
const preflightBlocking = ref<ExportDiagnostic[]>([])
const warningsAcknowledged = ref(false)
const previewRef = ref<InstanceType<typeof ExportPreview> | null>(null)
const activePreviewController = ref<AbortController | null>(null)
const currentTaskId = ref('')
const lastProgressSequence = ref(0)
const printDialogClosed = ref(false)
const openingFormat = ref<ExportFormat | null>(null)
const openingPdfBackend = ref<'system-print' | 'pandoc' | null>(null)
let generation = 0
let operationGeneration = 0
let loadGeneration = 0
let unsubBus: (() => void) | null = null
let removeProgressListener: (() => void) | null = null
let disposed = false

const workspaceRoot = computed(() => project.projectTree?.pathname || '')
const activeDocument = computed(() => editor.currentFile)
const projectRoot = computed(() => projectForExport(activeDocument.value?.pathname, workspaceRoot.value))
const projectScopeHint = computed(() => workspaceRoot.value && activeDocument.value?.pathname && !projectRoot.value
  ? copy.value.outsideProject
  : copy.value.noProject)
const busy = computed(() => ['preflighting', 'rendering', 'writing'].includes(taskStage.value))
const projectProfiles = computed(() => configSnapshot.value.config?.profiles ?? [])
const profileChoices = computed(() => {
  const profiles = [...projectProfiles.value]
  for (const builtIn of Object.values(BUILTIN_PROFILES)) {
    if (!profiles.some(profile => profile.id === builtIn.id)) profiles.push(builtIn)
  }
  return profiles
})
const visibleWarnings = computed(() => preflightWarnings.value)
const displayPreviewMessage = computed(() => format.value === 'html' || (format.value === 'pdf' && profileDraft.value.pdf.backend === 'system-print')
  ? copy.value.htmlPreview
  : copy.value.formatPreview)
const formats = computed(() => [
  { value: 'html' as const, label: copy.value.html },
  { value: 'pdf' as const, label: copy.value.pdf },
  { value: 'docx' as const, label: copy.value.docx },
  { value: 'odt' as const, label: copy.value.odt },
  { value: 'epub' as const, label: copy.value.epub },
])
const themes = computed(() => Object.keys(EXPORT_THEME_LABELS).map(id => ({
  id: id as ExportThemeId,
  label: EXPORT_THEME_LABELS[id as ExportThemeId][locale.value === 'zh-CN' ? 'zh' : locale.value === 'ja' ? 'ja' : 'en'],
})))
const formatCanExport = computed(() => profileDraft.value.formats.includes(format.value))
const canExport = computed(() => !busy.value && !configLoading.value && !previewStale.value && previewReady.value
  && !preflightBlocking.value.length && formatCanExport.value && (!visibleWarnings.value.length || warningsAcknowledged.value))
const projectProfileIsValid = computed(() => {
  const profile = clone(profileDraft.value)
  profile.id = configSnapshot.value.config?.profiles.some(item => item.id === selectedProfileId.value)
    ? selectedProfileId.value
    : slug(profileName.value || profile.id)
  profile.name = profileName.value || profile.name
  return validateExportProjectConfig({ schemaVersion: 1, defaultProfile: profile.id, profiles: [profile] })
})
const canSaveProjectPreset = computed(() => Boolean(projectRoot.value) && !configLoading.value && !configError.value && projectProfileIsValid.value)
const currentProfileSource = computed(() => hasTemporaryOverrides.value
  ? 'this-export'
  : configSnapshot.value.config?.profiles.some(profile => profile.id === selectedProfileId.value)
    ? 'project'
    : personalDefaults.value.isSaved
      ? 'personal'
      : 'builtin')

function sourceName(source?: string): string {
  switch (source) {
    case 'project': return copy.value.project
    case 'personal': return copy.value.personal
    case 'this-export': return copy.value.temporary
    default: return copy.value.builtIn
  }
}

function fieldSource(field: string): string {
  return sourceName(profileSources.value[field] ?? currentProfileSource.value)
}

function applyResolvedProfile(profileId?: string) {
  const resolved = resolveExportProfile({
    projectConfig: configSnapshot.value.config,
    personalDefaults: personalDefaults.value,
    selectedProfileId: profileId,
  })
  profileDraft.value = clone(resolved.profile)
  selectedProfileId.value = resolved.profileId ?? resolved.profile.id
  profileName.value = resolved.profile.name
  profileSources.value = resolved.sources
  hasTemporaryOverrides.value = false
  const nextFormat = openingFormat.value ?? (resolved.profile.formats.includes('html') ? 'html' : resolved.profile.formats[0] ?? 'html')
  format.value = nextFormat
  if (nextFormat === 'pdf' && openingPdfBackend.value) {
    profileDraft.value.pdf.backend = openingPdfBackend.value
    profileSources.value = { ...profileSources.value, 'pdf.backend': 'this-export' }
    hasTemporaryOverrides.value = true
  }
  openingFormat.value = null
  openingPdfBackend.value = null
  clearPreview()
}

function clearPreview() {
  generation++
  operationGeneration++
  currentTaskId.value = ''
  activePreviewController.value?.abort()
  activePreviewController.value = null
  snapshot.value = null
  previewRequest.value = null
  previewHtml.value = ''
  previewReady.value = false
  previewStale.value = false
  previewBusy.value = false
  preflightWarnings.value = []
  preflightBlocking.value = []
  warningsAcknowledged.value = false
  taskStage.value = 'idle'
  taskError.value = ''
  printDialogClosed.value = false
}

async function loadSettings(root = projectRoot.value) {
  const requestGeneration = ++loadGeneration
  configLoading.value = true
  configError.value = ''
  personalDefaults.value = loadPersonalExportDefaults()
  try {
    const loaded = await loadProjectExportConfig(root || undefined)
    if (requestGeneration !== loadGeneration || root !== projectRoot.value) return
    configSnapshot.value = loaded
    applyResolvedProfile(loaded.config?.defaultProfile)
  } catch (error) {
    if (requestGeneration !== loadGeneration || root !== projectRoot.value) return
    configSnapshot.value = { config: null, fingerprint: null }
    configError.value = errorText(error)
    applyResolvedProfile()
  } finally {
    if (requestGeneration === loadGeneration) configLoading.value = false
  }
}

function open(payload?: { format?: ExportFormat; pdfBackend?: 'system-print' | 'pandoc' } | void) {
  visible.value = true
  openingFormat.value = payload?.format ?? null
  openingPdfBackend.value = payload?.pdfBackend ?? null
  void loadSettings()
}

function selectProfile(id: string) {
  applyResolvedProfile(id)
}

function selectTheme(theme: ExportThemeId) {
  const old = profileDraft.value
  const next = clone(BUILTIN_PROFILES[theme])
  next.id = old.id
  next.name = profileName.value || next.name
  profileDraft.value = next
  profileSources.value = { ...profileSources.value, theme: 'this-export', page: 'this-export', typography: 'this-export', toc: 'this-export' }
  hasTemporaryOverrides.value = true
}

function setOverride(field: string) {
  hasTemporaryOverrides.value = true
  profileSources.value = { ...profileSources.value, [field]: 'this-export' }
}

function currentConfigSource(): 'builtin' | 'personal' | 'project' | 'this-export' {
  return currentProfileSource.value
}

async function preview() {
  const tab = activeDocument.value
  if (!tab) {
    taskError.value = copy.value.noDocument
    taskStage.value = 'failed'
    return
  }
  const currentGeneration = ++generation
  activePreviewController.value?.abort()
  const controller = new AbortController()
  activePreviewController.value = controller
  const frozen = captureExportSnapshot(tab)
  const frozenProfile = clone(profileDraft.value)
  frozenProfile.name = profileName.value
  const frozenFormat = format.value
  const frozenProfileId = selectedProfileId.value
  const frozenSource = currentConfigSource()
  snapshot.value = frozen
  previewRequest.value = null
  previewBusy.value = true
  previewReady.value = false
  previewStale.value = false
  taskStage.value = 'preflighting'
  taskError.value = ''
  preflightWarnings.value = []
  preflightBlocking.value = []
  warningsAcknowledged.value = false

  try {
    const result = await renderExportPreview({
      snapshot: frozen,
      profile: frozenProfile,
      format: frozenFormat,
      projectRoot: projectRoot.value || undefined,
      profileId: frozenProfileId,
      configSource: frozenSource,
      muya: editor.getMuyaInstance() as { options: { [key: string]: unknown } } | null,
      language: locale.value,
      signal: controller.signal,
    })
    if (currentGeneration !== generation) return
    previewRequest.value = result.request
    previewHtml.value = result.html
    preflightWarnings.value = result.preflight.warnings
    preflightBlocking.value = result.preflight.blocking
    previewReady.value = false
    taskStage.value = result.preflight.blocking.length ? 'failed' : 'rendering'
    if (result.preflight.blocking.length) taskError.value = result.preflight.blocking.map(item => item.message).join('\n')
  } catch (error) {
    if (currentGeneration !== generation) return
    if (isAbort(error)) taskStage.value = 'cancelled'
    else {
      taskStage.value = 'failed'
      taskError.value = errorText(error)
    }
  } finally {
    if (currentGeneration === generation) {
      previewBusy.value = false
      activePreviewController.value = null
    }
  }
}

function handlePreviewReady() {
  previewReady.value = !previewStale.value && Boolean(previewRequest.value) && preflightBlocking.value.length === 0 && Boolean(previewHtml.value)
  if (previewReady.value && taskStage.value === 'rendering') taskStage.value = 'ready'
}

async function startSystemPrint(frozen: ExportRequest, operation: number) {
  if (!operationIsCurrent(operation)) return
  const request = createExportRequest({
    ...frozen,
    format: 'pdf',
    pdfBackend: 'system-print',
    options: { ...clone(frozen.options), pdf: { backend: 'system-print' } },
  })
  taskStage.value = 'preflighting'
  const result = await exportPreflight(request)
  if (!operationIsCurrent(operation)) return
  preflightWarnings.value = result.warnings
  preflightBlocking.value = result.blocking
  if (result.blocking.length) {
    taskStage.value = 'failed'
    taskError.value = result.blocking.map(item => item.message).join('\n')
    return
  }
  if (result.warnings.length && !warningsAcknowledged.value) {
    taskStage.value = 'ready'
    return
  }
  await nextTick()
  if (!operationIsCurrent(operation)) return
  printDialogClosed.value = false
  currentTaskId.value = request.taskId
  if (!previewRef.value?.print()) {
    taskStage.value = 'failed'
    taskError.value = 'The isolated print view is unavailable.'
    return
  }
  taskStage.value = 'waitingForPrintDialog'
}

async function doExport() {
  if (!canExport.value || !previewRequest.value) return
  const operation = ++operationGeneration
  // Keep the entire preview request, including options and project scope.
  // No mutable form state may enter this operation after an await.
  const frozen = { ...clone(previewRequest.value), renderedHtml: previewHtml.value }
  taskStage.value = 'preflighting'
  try {
    if (frozen.format === 'pdf' && frozen.options.pdf.backend === 'system-print') {
      await startSystemPrint(frozen, operation)
      return
    }
    const fileName = suggestedExportFileName(frozen.options.output.fileName, frozen.snapshot, frozen.options.name, frozen.format)
    const target = await exportSaveDialog(frozen.format, fileName, projectOutputDirectory(frozen.projectRoot, frozen.options.output.directory))
    if (!operationIsCurrent(operation)) return
    if (!target) {
      taskStage.value = 'cancelled'
      return
    }
    const request = createExportRequest({
      ...frozen,
      outputPath: target,
      renderedHtml: frozen.format === 'html' ? restoreExternalImageLinks(frozen.renderedHtml) : frozen.renderedHtml,
    })
    currentTaskId.value = request.taskId
    lastProgressSequence.value = 0
    const preflight = await exportPreflight(request)
    if (!operationIsCurrent(operation)) return
    preflightWarnings.value = preflight.warnings
    preflightBlocking.value = preflight.blocking
    if (preflight.blocking.length) {
      taskStage.value = 'failed'
      taskError.value = preflight.blocking.map(item => item.message).join('\n')
      return
    }
    if (preflight.warnings.length && !warningsAcknowledged.value) {
      taskStage.value = 'ready'
      return
    }
    taskStage.value = 'writing'
    const result = await exportStart(request)
    if (!operationIsCurrent(operation)) return
    taskStage.value = 'completed'
    notify.pushToast({ type: 'success', message: t('toast.exportedTo', { path: result.outputPath }) })
  } catch (error) {
    if (!operationIsCurrent(operation)) return
    const message = errorText(error)
    if (isAbort(error) || /export:cancelled/i.test(message)) {
      taskStage.value = 'cancelled'
      return
    }
    taskStage.value = 'failed'
    taskError.value = message
    if (frozen.format === 'pdf' && frozen.options.pdf.backend === 'pandoc') {
      await offerSystemPrintFallback(frozen, operation)
    } else {
      showError(error)
    }
  }
}

function operationIsCurrent(operation: number): boolean {
  return operation === operationGeneration && !disposed && !previewStale.value
}

async function offerSystemPrintFallback(frozen: ExportRequest, operation: number) {
  try {
    await ElMessageBox.confirm(copy.value.pandocFallback, copy.value.pandocFallbackTitle, {
      type: 'warning', confirmButtonText: copy.value.usePrint, cancelButtonText: copy.value.keepError,
      distinguishCancelAndClose: true,
    })
    if (!operationIsCurrent(operation)) return
    await startSystemPrint(frozen, operation)
  } catch {
    if (operationIsCurrent(operation)) showError(taskError.value)
  }
}

async function saveProjectPreset() {
  if (!projectRoot.value) return
  const profile = clone(profileDraft.value)
  const existing = configSnapshot.value.config?.profiles.some(item => item.id === selectedProfileId.value)
  const id = existing ? selectedProfileId.value : slug(profileName.value || profile.id)
  profile.id = id
  profile.name = profileName.value || profile.name
  try {
    const result = await saveProjectExportProfile(projectRoot.value, profile, configSnapshot.value, true)
    configSnapshot.value = result
    selectedProfileId.value = profile.id
    profileDraft.value.id = profile.id
    profileDraft.value.name = profile.name
    profileSources.value = createProfileSourceMap(profile, 'project')
    hasTemporaryOverrides.value = false
    notify.pushToast({ type: 'success', message: copy.value.saved })
  } catch (error) {
    if (/export:configConflict/i.test(errorText(error))) {
      configError.value = 'Project export settings changed elsewhere. Reload the project configuration before saving again.'
      await loadSettings(projectRoot.value)
    } else showError(error)
  }
}

function savePersonal() {
  const { id: _id, name: _name, ...options } = clone(profileDraft.value)
  const defaults = { defaultTheme: profileDraft.value.theme, options, isSaved: true }
  savePersonalExportDefaults(defaults)
  personalDefaults.value = defaults
  const activeProjectProfile = configSnapshot.value.config?.profiles.some(profile => profile.id === selectedProfileId.value)
  if (!activeProjectProfile) {
    hasTemporaryOverrides.value = false
    profileSources.value = createProfileSourceMap(profileDraft.value, 'personal')
  }
  notify.pushToast({ type: 'success', message: copy.value.savedPersonal })
}

async function cancelCurrent() {
  generation++
  operationGeneration++
  activePreviewController.value?.abort()
  activePreviewController.value = null
  const taskId = currentTaskId.value
  const writing = ['rendering', 'writing'].includes(taskStage.value)
  currentTaskId.value = ''
  taskStage.value = 'cancelled'
  previewBusy.value = false
  if (taskId && writing) {
    try { await cancelExport(taskId) } catch { /* the task may already have completed */ }
  }
}

function handleProgress(event: ExportProgressEvent) {
  if (event.taskId !== currentTaskId.value || event.sequence <= lastProgressSequence.value) return
  lastProgressSequence.value = event.sequence
  taskStage.value = event.stage === 'rendering' || event.stage === 'writing' || event.stage === 'waitingForPrintDialog'
    ? event.stage
    : event.stage === 'completed' || event.stage === 'cancelled' || event.stage === 'failed'
      ? event.stage
      : taskStage.value
  if (event.stage === 'failed' && event.message) taskError.value = event.message
}

function handlePrintClosed() {
  if (taskStage.value === 'waitingForPrintDialog') {
    taskStage.value = 'ready'
    printDialogClosed.value = true
  }
}

function sourceStatus(source?: string) {
  return `${copy.value.source}: ${sourceName(source)}`
}

function formatLabel(value: ExportFormat): string {
  return formats.value.find(item => item.value === value)?.label ?? value.toUpperCase()
}

function showError(error: unknown) {
  notify.pushToast({ type: 'error', title: t('toast.exportFailed'), message: errorText(error) })
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const match = message.match(/export:([A-Za-z]+)(?::([\s\S]*))?/)
  if (!match) return message
  const key = ({
    pandocMissing: 'pandocMissing',
    pdfEngineMissing: 'pdfEngineMissing',
    remoteDownloadUnavailable: 'remoteDownloadUnavailable',
    missingResourceBase: 'resourceBaseMissing',
    resourceOutsideScope: 'resourceUnavailable',
    resourceTooLarge: 'resourceBudget',
    pandocFailed: 'pandocFailed',
  } as const)[match[1] as 'pandocMissing' | 'pdfEngineMissing' | 'remoteDownloadUnavailable' | 'missingResourceBase' | 'resourceOutsideScope' | 'resourceTooLarge' | 'pandocFailed']
  return key ? `${copy.value[key]}${match[2] ? `\n${match[2]}` : ''}` : message
}

function diagnosticMessage(item: ExportDiagnostic): string {
  const key = ({
    pandocMissing: 'pandocMissing',
    pdfEngineMissing: 'pdfEngineMissing',
    remoteDownloadUnavailable: 'remoteDownloadUnavailable',
    'remote-resource-download-unavailable': 'remoteDownloadUnavailable',
    'remote-resource-not-embedded': 'remoteNotEmbedded',
    'resource-base-path-missing': 'resourceBaseMissing',
    'embedded-resource-budget-exceeded': 'resourceBudget',
    'local-resource-unavailable': 'resourceUnavailable',
    'unbundled-note-link': 'unbundledNoteLink',
    'missing-export-heading': 'missingHeading',
  } as const)[item.code as 'pandocMissing' | 'pdfEngineMissing' | 'remoteDownloadUnavailable' | 'remote-resource-download-unavailable' | 'remote-resource-not-embedded' | 'resource-base-path-missing' | 'embedded-resource-budget-exceeded' | 'local-resource-unavailable']
  const message = key ? copy.value[key] : item.message
  if (!item.line) return message
  return locale.value === 'en' ? `${copy.value.line} ${item.line}: ${message}` : `${copy.value.line}${item.line}：${message}`
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function slug(value: string): string {
  return value.normalize('NFKD').toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'export-profile'
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

watch(projectRoot, root => {
  invalidatePreview()
  if (visible.value) void loadSettings(root)
}, { flush: 'sync' })
function invalidatePreview() {
  if (!snapshot.value) return
  generation++
  operationGeneration++
  activePreviewController.value?.abort()
  activePreviewController.value = null
  previewStale.value = true
  previewReady.value = false
  previewBusy.value = false
  currentTaskId.value = ''
  taskStage.value = 'idle'
}
watch(() => [editor.currentFile?.markdown, editor.currentFile?.pathname, editor.currentFile?.filename, editor.currentFileId], invalidatePreview, { flush: 'sync' })
watch(profileDraft, invalidatePreview, { deep: true, flush: 'sync' })
watch(format, invalidatePreview, { flush: 'sync' })
watch(profileName, invalidatePreview, { flush: 'sync' })
watch(() => locale.value, invalidatePreview, { flush: 'sync' })

onMounted(() => {
  unsubBus = bus.on('show-export-dialog', open)
  void onExportProgress(handleProgress).then(unlisten => {
    if (disposed) unlisten()
    else removeProgressListener = unlisten
  }).catch(() => undefined)
})

onBeforeUnmount(() => {
  disposed = true
  operationGeneration++
  unsubBus?.()
  removeProgressListener?.()
  activePreviewController.value?.abort()
})
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="copy.title"
    width="96vw"
    top="2vh"
    :close-on-click-modal="false"
    :show-close="!busy && !previewBusy"
    append-to-body
    class="export-dialog"
    @close="cancelCurrent"
    @closed="clearPreview"
  >
    <div class="export-layout">
      <section class="export-options" aria-label="Export options">
        <div class="document-summary">
          <strong>{{ activeDocument?.filename || copy.untitled }}</strong>
          <span>{{ activeDocument?.pathname || copy.noDocument }}</span>
          <el-tag v-if="activeDocument && !activeDocument.isSaved" size="small" type="warning">{{ copy.unsavedBuffer }}</el-tag>
        </div>
        <el-button
          data-testid="project-export-open"
          :disabled="busy || previewBusy || !workspaceRoot"
          @click="visible = false; bus.emit('show-project-export-dialog', undefined)"
        >
          {{ projectExportCopy(locale).open }}
        </el-button>

        <el-form label-position="top" size="small">
          <el-form-item :label="copy.preset">
            <el-select v-model="selectedProfileId" :disabled="configLoading" @change="selectProfile">
              <el-option v-for="item in profileChoices" :key="item.id" :label="item.name" :value="item.id" />
            </el-select>
            <div class="field-source">{{ sourceStatus(currentProfileSource) }}</div>
          </el-form-item>
          <el-form-item :label="copy.presetName">
            <el-input v-model="profileName" maxlength="80" @input="setOverride('name')" />
          </el-form-item>
          <el-form-item :label="copy.format">
            <el-select v-model="format">
              <el-option
                v-for="item in formats"
                :key="item.value"
                :label="item.label"
                :value="item.value"
                :disabled="!profileDraft.formats.includes(item.value)"
              />
            </el-select>
            <div class="field-source">{{ sourceStatus('this-export') }}</div>
          </el-form-item>
          <el-form-item :label="copy.theme">
            <el-select :model-value="profileDraft.theme" @update:model-value="selectTheme">
              <el-option v-for="item in themes" :key="item.id" :label="item.label" :value="item.id" />
            </el-select>
            <div class="field-source">{{ sourceStatus(fieldSource('theme')) }}</div>
          </el-form-item>
          <el-form-item v-if="format === 'pdf'" :label="copy.pdf">
            <el-radio-group v-model="profileDraft.pdf.backend" @change="setOverride('pdf.backend')">
              <el-radio value="system-print">{{ copy.systemPrint }}</el-radio>
              <el-radio value="pandoc">{{ copy.pandoc }}</el-radio>
            </el-radio-group>
            <div class="field-source">{{ sourceStatus(fieldSource('pdf.backend')) }}</div>
          </el-form-item>
          <div v-if="format === 'html' || format === 'pdf'" class="two-columns">
            <el-form-item :label="copy.page">
              <el-select v-model="profileDraft.page.size" @change="setOverride('page.size')">
                <el-option v-for="size in ['A4','A5','Letter','Legal']" :key="size" :label="size" :value="size" />
              </el-select>
            </el-form-item>
            <el-form-item :label="copy.orientation">
              <el-select v-model="profileDraft.page.orientation" @change="setOverride('page.orientation')">
                <el-option value="portrait" :label="copy.portrait" />
                <el-option value="landscape" :label="copy.landscape" />
              </el-select>
            </el-form-item>
          </div>
          <el-form-item class="inline-option">
            <el-checkbox v-model="profileDraft.html.showTitle" @change="setOverride('html.showTitle')">{{ copy.includeTitle }}</el-checkbox>
            <div class="field-source">{{ sourceStatus(fieldSource('html.showTitle')) }}</div>
          </el-form-item>
          <el-form-item class="inline-option">
            <el-checkbox v-model="profileDraft.toc.enabled" @change="setOverride('toc.enabled')">{{ copy.toc }}</el-checkbox>
            <el-select v-model="profileDraft.toc.depth" class="depth-select" :disabled="!profileDraft.toc.enabled" @change="setOverride('toc.depth')">
              <el-option v-for="depth in [1,2,3,4,5,6]" :key="depth" :label="String(depth)" :value="depth" />
            </el-select>
            <span>{{ copy.tocDepth }}</span>
            <div class="field-source">{{ sourceStatus(fieldSource('toc.enabled')) }}</div>
          </el-form-item>
          <el-form-item v-if="format === 'html'" :label="copy.resourceMode">
            <el-select v-model="profileDraft.resources.htmlMode" @change="setOverride('resources.htmlMode')">
              <el-option value="embed" :label="copy.embedded" />
              <el-option value="folder" :label="copy.folder" />
            </el-select>
            <div class="field-source">{{ sourceStatus(fieldSource('resources.htmlMode')) }}</div>
          </el-form-item>
          <details class="export-advanced">
            <summary>{{ copy.advanced }}</summary>
            <div class="advanced-content">
              <el-form-item :label="copy.bodyFont">
                <el-select v-model="profileDraft.typography.bodyFont" @change="setOverride('typography.bodyFont')">
                  <el-option value="system-cjk" :label="copy.systemCjk" />
                  <el-option value="system-serif" :label="copy.systemSerif" />
                </el-select>
                <div class="field-source">{{ sourceStatus(fieldSource('typography.bodyFont')) }}</div>
              </el-form-item>
              <el-form-item :label="copy.bodySizePt">
                <el-input-number
                  v-model="profileDraft.typography.bodySizePt"
                  :min="6"
                  :max="48"
                  :step="0.5"
                  :precision="1"
                  @change="setOverride('typography.bodySizePt')"
                />
                <div class="field-source">{{ sourceStatus(fieldSource('typography.bodySizePt')) }}</div>
              </el-form-item>
              <el-form-item :label="copy.lineHeight">
                <el-input-number
                  v-model="profileDraft.typography.lineHeight"
                  :min="1"
                  :max="3"
                  :step="0.05"
                  :precision="2"
                  :disabled="format === 'docx' || format === 'odt'"
                  @change="setOverride('typography.lineHeight')"
                />
                <div class="field-source">{{ sourceStatus(fieldSource('typography.lineHeight')) }}</div>
                <div v-if="format === 'docx' || format === 'odt'" class="setting-note">{{ copy.lineHeightUnsupported }}</div>
              </el-form-item>

              <div class="advanced-setting-group">
                <div class="advanced-group-label">{{ copy.margins }}</div>
                <div class="margin-grid">
                  <el-form-item :label="copy.marginTop">
                    <el-input-number v-model="profileDraft.page.marginMm.top" :min="0" :max="80" :step="1" :disabled="format === 'epub'" @change="setOverride('page.marginMm.top')" />
                  </el-form-item>
                  <el-form-item :label="copy.marginRight">
                    <el-input-number v-model="profileDraft.page.marginMm.right" :min="0" :max="80" :step="1" :disabled="format === 'epub'" @change="setOverride('page.marginMm.right')" />
                  </el-form-item>
                  <el-form-item :label="copy.marginBottom">
                    <el-input-number v-model="profileDraft.page.marginMm.bottom" :min="0" :max="80" :step="1" :disabled="format === 'epub'" @change="setOverride('page.marginMm.bottom')" />
                  </el-form-item>
                  <el-form-item :label="copy.marginLeft">
                    <el-input-number v-model="profileDraft.page.marginMm.left" :min="0" :max="80" :step="1" :disabled="format === 'epub'" @change="setOverride('page.marginMm.left')" />
                  </el-form-item>
                </div>
                <div class="field-source">{{ sourceStatus(fieldSource('page.marginMm.top')) }}</div>
                <div v-if="format === 'epub'" class="setting-note">{{ copy.marginsUnsupported }}</div>
              </div>

              <el-form-item class="inline-option">
                <el-checkbox v-model="profileDraft.numberHeadings" @change="setOverride('numberHeadings')">{{ copy.numberHeadings }}</el-checkbox>
                <div class="field-source">{{ sourceStatus(fieldSource('numberHeadings')) }}</div>
              </el-form-item>
              <el-form-item :label="copy.outputDirectory">
                <el-input v-model="profileDraft.output.directory" :disabled="!projectRoot" @input="setOverride('output.directory')" />
                <div class="field-source">{{ sourceStatus(fieldSource('output.directory')) }}</div>
                <div v-if="!projectRoot" class="setting-note">{{ projectScopeHint }}</div>
              </el-form-item>
              <el-form-item :label="copy.outputFileName">
                <el-input v-model="profileDraft.output.fileName" maxlength="180" @input="setOverride('output.fileName')" />
                <div class="field-source">{{ sourceStatus(fieldSource('output.fileName')) }}</div>
                <div class="setting-note">{{ copy.outputFileNameHelp }}</div>
              </el-form-item>
            </div>
          </details>
          <el-form-item v-if="profileDraft.resources.downloadRemote" class="remote-warning">
            <el-checkbox :model-value="true" disabled>{{ copy.remote }}</el-checkbox>
            <div>{{ copy.remoteUnavailable }}</div>
          </el-form-item>
        </el-form>

        <div class="preset-actions">
          <el-button size="small" :disabled="!canSaveProjectPreset" @click="saveProjectPreset">{{ copy.saveProject }}</el-button>
          <el-button size="small" @click="savePersonal">{{ copy.savePersonal }}</el-button>
          <span v-if="!projectRoot" class="field-source">{{ projectScopeHint }}</span>
        </div>
        <el-alert v-if="configLoading" :title="copy.loading" type="info" :closable="false" />
        <el-alert v-if="configError" :title="configError" type="error" :closable="false" />
        <el-alert v-if="projectRoot && !projectProfileIsValid" :title="copy.profileInvalid" type="warning" :closable="false" />
      </section>

      <section class="export-preview-column" aria-label="Export preview">
        <div class="preview-heading">
          <p>{{ displayPreviewMessage }}</p>
          <el-tag v-if="previewStale" type="warning" size="small">{{ copy.stale }}</el-tag>
        </div>
        <ExportPreview
          ref="previewRef"
          :html="previewHtml"
          :stale="previewStale"
          :title="`${copy.title}: ${activeDocument?.filename || ''}`"
          :loading-message="copy.waitingPreview"
          :empty-message="copy.choosePreview"
          :stale-message="copy.previewFirst"
          :failed-message="copy.previewFailed"
          :timeout-message="copy.previewTimeout"
          @ready="handlePreviewReady"
          @failed="message => { taskError = message; previewReady = false }"
          @print-closed="handlePrintClosed"
        />
        <div v-if="preflightBlocking.length" class="diagnostics" role="alert">
          <strong>{{ copy.errors }}</strong>
          <ul><li v-for="(item, index) in preflightBlocking" :key="`${item.code}-${index}`">{{ diagnosticMessage(item) }}</li></ul>
        </div>
        <div v-else-if="visibleWarnings.length" class="diagnostics warning-list">
          <strong>{{ copy.warnings }}</strong>
          <ul><li v-for="(item, index) in visibleWarnings" :key="`${item.code}-${index}`">{{ diagnosticMessage(item) }}</li></ul>
          <el-checkbox v-model="warningsAcknowledged">{{ copy.acknowledge }}</el-checkbox>
        </div>
        <div v-else-if="previewReady" class="diagnostics success-text">{{ copy.noWarnings }}</div>
        <div v-if="taskError" class="task-error" role="alert">{{ taskError }}</div>
        <div v-if="taskStage === 'waitingForPrintDialog'" class="print-status" role="status">
          {{ copy.printWaiting }}
          <el-button link @click="handlePrintClosed">{{ copy.printClosedButton }}</el-button>
        </div>
        <div v-else-if="printDialogClosed" class="print-status" role="status">{{ copy.printClosed }}</div>
      </section>
    </div>

    <template #footer>
      <el-button @click="visible = false">{{ copy.cancel }}</el-button>
      <el-button :loading="previewBusy" :disabled="busy || !activeDocument" @click="preview">
        {{ previewHtml ? copy.refreshPreview : copy.preview }}
      </el-button>
      <el-button
        v-if="format === 'pdf' && profileDraft.pdf.backend === 'system-print'"
        type="primary"
        :disabled="!canExport"
        @click="doExport"
      >
        {{ copy.print }}
      </el-button>
      <el-button v-else type="primary" :disabled="!canExport" :loading="busy" @click="doExport">
        {{ copy.export }} {{ formatLabel(format) }}
      </el-button>
      <el-button v-if="busy || previewBusy" type="danger" plain @click="cancelCurrent">{{ copy.cancel }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.export-layout {
  display: grid;
  grid-template-columns: minmax(300px, 370px) minmax(0, 1fr);
  gap: 18px;
  align-items: start;
}

.export-options {
  max-height: 76vh;
  overflow: auto;
  padding-right: 5px;
}

.document-summary {
  display: grid;
  gap: 4px;
  margin-bottom: 14px;
  overflow-wrap: anywhere;
}

.document-summary span,
.field-source {
  color: var(--el-text-color-secondary);
  font-size: 11px;
}

.field-source { margin-top: 3px; }

.two-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}

.inline-option :deep(.el-form-item__content) {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.inline-option .field-source { flex-basis: 100%; margin-top: 0; }
.depth-select { width: 68px; }

.export-advanced {
  grid-column: 1 / -1;
  margin: 3px 0 12px;
  border-top: 1px solid var(--el-border-color-lighter);
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.export-advanced > summary {
  padding: 10px 2px;
  color: var(--el-text-color-primary);
  cursor: pointer;
  font-weight: 600;
}

.advanced-content {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 14px;
  padding: 4px 2px 10px;
}

.advanced-content :deep(.el-form-item) { margin-bottom: 12px; }
.advanced-setting-group { grid-column: 1 / -1; }
.advanced-group-label { margin: 0 0 8px; font-size: 12px; font-weight: 600; }
.margin-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
.setting-note { margin-top: 4px; color: var(--el-text-color-secondary); font-size: 11px; }

.preset-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 12px 0;
}

.preset-actions .field-source { flex-basis: 100%; }
.remote-warning { color: var(--el-color-warning); }
.remote-warning div { font-size: 11px; }

.export-preview-column { min-width: 0; }
.preview-heading { display: flex; justify-content: space-between; gap: 12px; align-items: center; min-height: 28px; }
.preview-heading p { margin: 0 0 8px; color: var(--el-text-color-secondary); font-size: 12px; }

.diagnostics,
.task-error,
.print-status {
  margin-top: 10px;
  padding: 9px 11px;
  border-radius: 5px;
  font-size: 12px;
}

.diagnostics { background: var(--el-color-danger-light-9); color: var(--el-color-danger-dark-2); }
.warning-list { background: var(--el-color-warning-light-9); color: var(--el-color-warning-dark-2); }
.diagnostics ul { margin: 5px 0; padding-left: 18px; }
.success-text { background: var(--el-color-success-light-9); color: var(--el-color-success-dark-2); }
.task-error { white-space: pre-wrap; background: var(--el-color-danger-light-9); color: var(--el-color-danger-dark-2); }
.print-status { display: flex; justify-content: space-between; align-items: center; background: var(--el-color-info-light-9); }

@media (max-width: 920px) {
  .export-layout { grid-template-columns: 1fr; }
  .export-options { max-height: 35vh; }
  .preview-shell { height: 55vh; }
}

@media (max-width: 500px) {
  .advanced-content,
  .margin-grid { grid-template-columns: 1fr; }
}
</style>
