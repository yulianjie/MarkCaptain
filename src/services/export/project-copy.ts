const en = {
  title: 'Export project', open: 'Export project…', noProject: 'Open a local project to export multiple documents.',
  mode: 'Export mode', batch: 'Separate documents', book: 'Combine as a book', formats: 'Formats',
  profile: 'Preset', theme: 'Theme', directory: 'Project output directory', fileName: 'File name pattern',
  fileNameHelp: 'Variables: {name}, {profile}, {date}. Duplicate names receive a deterministic suffix.',
  bookTitle: 'Book title', candidates: 'Choose documents', filter: 'Filter candidate paths', selected: 'Ordered chapters',
  select: 'Include', chapterTitle: 'Chapter title', level: 'Heading level', up: 'Move up', down: 'Move down', remove: 'Remove',
  untitled: 'Unsaved document — this run only', buffer: 'Editor buffer', disk: 'Disk', empty: 'Select at least one document.',
  review: 'Freeze and review', run: 'Export reviewed snapshot', cancel: 'Cancel task', close: 'Close', retry: 'Validate and retry failed items',
  save: 'Save project plan', reload: 'Reload project plan', saved: 'Project plan saved. Export has not started.',
  saveHelp: 'The plan saves relative chapter paths and settings. Unsaved documents are excluded.',
  reviewHelp: 'This task uses a frozen snapshot. Review the source versions and output paths before exporting.',
  stale: 'Settings changed. Freeze and review again before exporting.', acknowledge: 'I reviewed these warnings and want to continue.',
  warnings: 'Warnings', errors: 'Cannot export yet', outputs: 'Output paths and collision preview', snapshots: 'Frozen source versions',
  results: 'Per-item results', status: 'Status', output: 'Output', error: 'Error', ready: 'Ready', pending: 'Pending', running: 'Exporting',
  completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', skipped: 'Skipped', loading: 'Loading project documents…',
  busy: 'Preparing export…', refresh: 'Refresh candidates', pdfHelp: 'Project PDF export uses Pandoc and requires a PDF engine.',
  missing: 'A saved chapter is no longer available. Reload candidates or remove it.', invalid: 'The project export plan is invalid or uses an unsupported version.',
  configConflict: 'The project configuration changed on disk. Reload it before saving.', taskChanged: 'Source versions changed. Freeze and review again.',
  taskFailed: 'The export could not complete.', configFailed: 'The project plan could not be loaded or saved.',
  collision: 'Name adjusted to avoid another output', selectAll: 'Include filtered documents', clear: 'Clear selection',
  overwrite: 'Replace existing output files',
  selectionLimit: 'A task can include at most 64 documents. Remove a chapter before adding another.',
} as const

export type ProjectExportCopy = { [K in keyof typeof en]: string }

const zh: ProjectExportCopy = {
  title: '导出项目', open: '导出项目…', noProject: '请打开本地项目，再导出多份文档。',
  mode: '导出模式', batch: '分别导出文档', book: '合并成册', formats: '格式', profile: '预设', theme: '主题',
  directory: '项目输出目录', fileName: '文件名规则', fileNameHelp: '变量：{name}、{profile}、{date}。重名文件将添加确定的后缀。',
  bookTitle: '书名', candidates: '选择文档', filter: '筛选候选路径', selected: '章节顺序', select: '加入', chapterTitle: '章节标题',
  level: '标题层级', up: '上移', down: '下移', remove: '移除', untitled: '未保存文档 — 仅用于本次任务', buffer: '编辑器缓冲区', disk: '磁盘',
  empty: '请至少选择一份文档。', review: '冻结快照并审阅', run: '导出已审阅快照', cancel: '取消任务', close: '关闭', retry: '校验版本并重试失败项',
  save: '保存项目方案', reload: '重新加载项目方案', saved: '项目方案已保存，尚未开始导出。', saveHelp: '方案保存相对章节路径和设置，不包含未保存文档。',
  reviewHelp: '本任务使用冻结快照。导出前请检查源文件版本和输出路径。', stale: '设置已变更，请重新冻结快照并审阅。',
  acknowledge: '我已查看这些警告，仍要继续。', warnings: '警告', errors: '暂时无法导出', outputs: '输出路径与重名预览', snapshots: '冻结的源文档版本',
  results: '逐项结果', status: '状态', output: '输出', error: '错误', ready: '就绪', pending: '等待', running: '正在导出', completed: '已完成',
  failed: '失败', cancelled: '已取消', skipped: '已跳过', loading: '正在加载项目文档…', busy: '正在准备导出…', refresh: '刷新候选文档',
  pdfHelp: '项目 PDF 导出使用 Pandoc，需要可用的 PDF 引擎。', missing: '已保存的章节已不可用，请刷新候选文档或移除该章节。',
  invalid: '项目导出方案无效或版本不受支持。', configConflict: '磁盘上的项目配置已变更，请重新加载后再保存。',
  taskChanged: '源文档版本已变更，请重新冻结快照并审阅。', taskFailed: '导出未能完成。', configFailed: '无法加载或保存项目方案。',
  collision: '文件名已调整以避免输出重名', selectAll: '加入筛选出的文档', clear: '清空选择',
  overwrite: '替换已有输出文件',
  selectionLimit: '每个任务最多包含 64 份文档，请先移除章节再添加。',
}

const ja: ProjectExportCopy = {
  title: 'プロジェクトを書き出す', open: 'プロジェクトを書き出す…', noProject: '複数の文書を書き出すにはローカルプロジェクトを開いてください。',
  mode: '書き出しモード', batch: '文書ごとに書き出す', book: '一冊にまとめる', formats: '形式', profile: 'プリセット', theme: 'テーマ',
  directory: 'プロジェクトの出力フォルダー', fileName: 'ファイル名パターン', fileNameHelp: '変数：{name}、{profile}、{date}。同名には一定の接尾辞を追加します。',
  bookTitle: '書名', candidates: '文書を選択', filter: '候補パスを絞り込む', selected: '章の順序', select: '追加', chapterTitle: '章タイトル',
  level: '見出しレベル', up: '上へ', down: '下へ', remove: '削除', untitled: '未保存の文書 — 今回のみ', buffer: '編集バッファー', disk: 'ディスク',
  empty: '文書を一つ以上選択してください。', review: 'スナップショットを固定して確認', run: '確認済みスナップショットを書き出す', cancel: 'タスクをキャンセル', close: '閉じる',
  retry: 'バージョンを検証して失敗項目を再試行', save: 'プロジェクト計画を保存', reload: 'プロジェクト計画を再読み込み', saved: '計画を保存しました。書き出しは開始していません。',
  saveHelp: '相対パスと設定を保存します。未保存の文書は含まれません。', reviewHelp: '固定したスナップショットを使用します。元文書のバージョンと出力パスを確認してください。',
  stale: '設定が変わりました。スナップショットを再作成して確認してください。', acknowledge: '警告を確認し、続行します。', warnings: '警告', errors: 'まだ書き出せません',
  outputs: '出力パスと名前の競合プレビュー', snapshots: '固定した元文書のバージョン', results: '項目別の結果', status: '状態', output: '出力', error: 'エラー',
  ready: '準備完了', pending: '待機中', running: '書き出し中', completed: '完了', failed: '失敗', cancelled: 'キャンセル済み', skipped: 'スキップ済み',
  loading: 'プロジェクト文書を読み込み中…', busy: '書き出しを準備中…', refresh: '候補を更新', pdfHelp: 'プロジェクトの PDF 書き出しには Pandoc と PDF エンジンが必要です。',
  missing: '保存した章が見つかりません。候補を更新するか章を削除してください。', invalid: '書き出し計画が無効か、バージョンが未対応です。',
  configConflict: 'ディスク上の設定が変わりました。再読み込みしてから保存してください。', taskChanged: '元文書のバージョンが変わりました。スナップショットを再作成してください。',
  taskFailed: '書き出しを完了できませんでした。', configFailed: 'プロジェクト計画を読み込み、または保存できませんでした。', collision: '出力の重複を避けるため名前を調整しました',
  selectAll: '絞り込んだ文書を追加', clear: '選択を解除',
  overwrite: '既存の出力ファイルを置き換える',
  selectionLimit: '一つのタスクに含められる文書は 64 件までです。追加する前に章を削除してください。',
}

export function projectExportCopy(locale: string): ProjectExportCopy {
  return locale === 'zh-CN' ? zh : locale === 'ja' ? ja : en
}

const diagnostics: Record<string, readonly [string, string, string]> = {
  'export:projectPrepareAgain': ['Freeze and review the snapshot again before exporting. Preparation was interrupted or an item needs a new preview.', '请重新冻结快照并审阅后导出。准备过程被中断，或某个项目需要新的预览。', 'スナップショットを再度固定して確認してください。準備が中断されたか、新しいプレビューが必要な項目があります。'],
  'export:invalidProjectSelection': ['Choose between 1 and 64 documents in the open project.', '请选择已打开项目中的 1 至 64 份文档。', '開いているプロジェクトの文書を 1～64 件選択してください。'],
  'export:invalidFormats': ['Choose formats supported by the selected preset.', '请选择当前预设支持的格式。', '選択したプリセットが対応する形式を選んでください。'],
  'export:invalidProjectTitle': ['Enter a title of up to 200 UTF-8 bytes and a file name of up to 120 bytes.', '请输入不超过 200 字节的标题和 120 字节的文件名。', 'タイトルは UTF-8 で 200 バイト以内、ファイル名は 120 バイト以内にしてください。'],
  'export:invalidProjectChapter': ['Check chapter paths, titles and heading levels (1–5).', '请检查章节路径、标题和层级（1–5）。', '章のパス、タイトル、見出しレベル（1～5）を確認してください。'],
  'export:duplicateProjectChapter': ['A document is included more than once.', '同一文档被重复加入。', '同じ文書が複数回含まれています。'],
  'export:projectSnapshotChanged': ['Source versions changed. Freeze and review again before retrying.', '源文档版本已变更，请重新冻结快照并审阅后重试。', '元文書のバージョンが変わりました。再度固定して確認してください。'],
  'export:untitledSourceChanged': ['The selected unsaved document is no longer available.', '选中的未保存文档已不可用。', '選択した未保存の文書が利用できなくなりました。'],
  'export:projectSnapshotTooLarge': ['The selected sources exceed the snapshot size limit (2 MB per document, 4 MiB total).', '源文档超过快照限制（单篇 2 MB，总计 4 MiB）。', 'スナップショットの上限（文書ごとに 2 MB、合計 4 MiB）を超えています。'],
  'export:projectRenderedTooLarge': ['Rendered content exceeds the 48 MiB limit.', '渲染内容超过 48 MiB 限制。', 'レンダリングした内容が 48 MiB の上限を超えています。'],
  'export:bookSourceMissing': ['Every selected chapter must be readable before building a book.', '合并成册前，所有选中的章节都必须可读。', '一冊にまとめるには、選択したすべての章を読み込める必要があります。'],
  'export:noReadyItems': ['No output is ready. Review the per-item errors.', '没有可导出的项目，请查看逐项错误。', '書き出せる項目がありません。項目別のエラーを確認してください。'],
  'export:outputExists': ['The output already exists. Choose another name or enable replacement.', '输出文件已存在，请更改文件名或启用替换。', '出力が既に存在します。別名を選ぶか置き換えを有効にしてください。'],
  'export:pandocMissing': ['Pandoc is not installed or is not on PATH.', '未安装 Pandoc，或 PATH 中找不到它。', 'Pandoc が未インストールか PATH にありません。'],
  'export:pdfEngineMissing': ['Install a supported PDF engine before exporting PDF.', '导出 PDF 前请安装支持的 PDF 引擎。', 'PDF の書き出しには対応する PDF エンジンが必要です。'],
  'export:pandocFailed': ['Pandoc could not create this output.', 'Pandoc 无法生成此文件。', 'Pandoc で出力を作成できませんでした。'],
  'duplicate-export-id': ['A source has duplicate anchors. Links use the first occurrence.', '源文档有重复锚点，链接指向第一次出现的位置。', '元文書に重複アンカーがあります。最初の位置を使用します。'],
  'ambiguous-export-note-link': ['A linked note matches multiple included chapters.', '链接的笔记匹配多个已加入章节。', 'リンク先のノートが複数の章に一致します。'],
  'unbundled-note-link': ['The linked note is not included in this export.', '链接的笔记未包含在本次导出中。', 'リンク先のノートは今回の書き出しに含まれていません。'],
  'missing-export-heading': ['The linked heading or anchor was not found in the included chapter.', '已加入章节中找不到链接的标题或锚点。', '含まれる章にリンク先の見出しやアンカーがありません。'],
  'export-heading-depth-clamped': ['A heading exceeds level 6 and will use level 6.', '标题层级超过 6，将使用第 6 级。', '見出しがレベル 6 を超えるため、レベル 6 を使用します。'],
  'remote-resource-not-embedded': ['Remote images remain external and are not loaded in preview.', '远程图片保留外链，预览中不会加载。', 'リモート画像は外部リンクのままで、プレビューには読み込みません。'],
  'remote-resource-download-unavailable': ['Remote image downloading is unavailable.', '暂不支持下载远程图片。', 'リモート画像のダウンロードは利用できません。'],
  'resource-base-path-missing': ['Local images require a saved source path.', '本地图片需要已保存的源文件路径。', 'ローカル画像には保存済みの元ファイルパスが必要です。'],
  'local-resource-unavailable': ['A local image could not be read; its alternative text is used.', '无法读取本地图片，将使用替代文本。', 'ローカル画像を読み込めないため代替テキストを使用します。'],
  'embedded-resource-budget-exceeded': ['Embedded resources exceed the 48 MiB limit.', '嵌入资源超过 48 MiB 限制。', '埋め込みリソースが 48 MiB の上限を超えています。'],
  'diagram-resource-disabled': ['External diagram resources are disabled.', '图表的外部资源已禁用。', '図の外部リソースは無効になっています。'],
  'wide-table-layout': ['A wide table may need landscape pages or smaller text.', '宽表格可能需要横向页面或更小的字号。', '幅広い表には横向きのページや小さい文字が必要な場合があります。'],
  'svg-serialization-failed': ['A diagram could not be prepared for export.', '无法准备导出所需的图表。', '書き出し用の図を準備できませんでした。'],
  externalLinks: ['External links stay external. Remote images are not downloaded.', '外部链接保持外链，不下载远程图片。', '外部リンクはそのまま保持し、リモート画像はダウンロードしません。'],
}

export function projectExportDiagnostic(locale: string, code: string, fallback = code): string {
  const index = locale === 'zh-CN' ? 1 : locale === 'ja' ? 2 : 0
  const alias = /Pandoc is not installed/i.test(code) ? 'export:pandocMissing'
    : /Install an available PDF engine/i.test(code) ? 'export:pdfEngineMissing'
      : /Output already exists/i.test(code) ? 'export:outputExists'
        : /Remote resource downloading|remoteDownloadUnavailable/.test(code) ? 'remote-resource-download-unavailable' : code
  const known = diagnostics[alias] ?? diagnostics[`export:${alias}`]
    ?? Object.entries(diagnostics).find(([key, messages]) => code.includes(key) || code === messages[0])?.[1]
  if (known) return known[index]
  if (/sourceUnreadable|sourceDecodeError|projectSourceUnavailable|projectUnreadable|sourceTooLarge/.test(code)) {
    return ['A selected source is unreadable, missing, or too large.', '选中的源文档无法读取、已丢失或过大。', '選択した元文書を読み込めないか、存在しないか、大きすぎます。'][index]
  }
  if (/invalid|unsupportedConfig|unsupportedFont|configTooLarge/.test(code)) return projectExportCopy(locale).invalid
  if (/configConflict/.test(code)) return projectExportCopy(locale).configConflict
  if (/cancelled|canceled|AbortError/.test(code)) return projectExportCopy(locale).cancelled
  if (/NotAuthorized|Outside|NotOwned|symlink|excludedSource/.test(code)) return ['The path is outside the authorized project scope.', '路径不在已授权的项目范围内。', 'パスが許可されたプロジェクトの範囲外です。'][index]
  if (/Limit/.test(code)) return ['The project exceeds an export limit. Reduce the selected scope.', '项目超过导出限制，请缩小选择范围。', 'プロジェクトが書き出し上限を超えています。選択範囲を縮小してください。'][index]
  return fallback
}
