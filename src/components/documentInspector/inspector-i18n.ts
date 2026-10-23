import type { LocaleId } from '@/i18n'

const messages = {
  en: {
    outline: 'Outline', links: 'Links', agent: 'Agent', close: 'Hide inspector',
    pinLinks: 'Pin links above the current panel', unpinLinks: 'Unpin links', openTarget: 'Open this document in the editor',
    target: 'Link target', followActive: 'Follow active document', fixed: 'Fixed document',
    fixTarget: 'Fix this document', useActive: 'Follow active document',
    filter: 'Filter links and context', clearFilter: 'Clear filter', back: 'Back to previous location',
    openOtherPane: 'Open in another split', expandContext: 'Show context', collapseContext: 'Hide context',
    backlinks: 'Backlinks', mentions: 'Unlinked mentions', outgoing: 'Outgoing links',
    inspector: 'Document inspector', noWorkspace: 'Open a folder to inspect project links.',
    noDocument: 'Open a Markdown document to see its links.',
    noPath: 'This untitled document has no project path, so it has no project backlinks yet.',
    outsideWorkspace: 'This document is outside the open folder.',
    notIndexed: 'This document is not in the current project index.',
    indexing: 'Indexing project notes…', partial: 'Some files could not be indexed; link counts may be incomplete.',
    pinnedMissing: 'The fixed document is no longer in this project.',
    noBacklinks: 'No backlinks yet.', noMentions: 'No unlinked mentions.', noOutgoing: 'No outgoing links.',
    noMatches: 'No matching results.', noRelations: 'No links or mentions for this document yet.',
    selectResult: 'Open source location', emptyAgent: 'Agent panel is supplied by the editor.', targetError: 'The target note could not be indexed.',
  },
  'zh-CN': {
    outline: '大纲', links: '双链', agent: 'AI', close: '隐藏检查器',
    pinLinks: '将双链固定在当前面板上方', unpinLinks: '取消固定双链', openTarget: '在编辑区打开此文档',
    target: '关联文档', followActive: '跟随活动文档', fixed: '固定文档',
    fixTarget: '固定当前文档', useActive: '跟随活动文档',
    filter: '筛选链接和上下文', clearFilter: '清除筛选', back: '返回上一个位置',
    openOtherPane: '在另一分屏打开', expandContext: '显示上下文', collapseContext: '收起上下文',
    backlinks: '反向链接', mentions: '未链接提及', outgoing: '当前文档链接',
    inspector: '文档检查器', noWorkspace: '打开一个文件夹以查看项目双链。',
    noDocument: '打开一篇 Markdown 文档以查看双链。',
    noPath: '当前文档尚未保存到项目中，因此没有项目反向链接。',
    outsideWorkspace: '当前文档不在已打开的文件夹中。',
    notIndexed: '当前文档尚未进入项目索引。',
    indexing: '正在索引项目文档…', partial: '部分文件无法索引，双链结果可能不完整。',
    pinnedMissing: '固定的文档已不在当前项目中。',
    noBacklinks: '还没有反向链接。', noMentions: '还没有未链接提及。', noOutgoing: '当前文档没有链接。',
    noMatches: '没有匹配的结果。', noRelations: '当前文档还没有链接或提及。',
    selectResult: '打开来源位置', emptyAgent: 'Agent 面板由编辑器提供。', targetError: '关联文档无法完成索引。',
  },
  ja: {
    outline: 'アウトライン', links: 'リンク', agent: 'AI', close: 'インスペクターを非表示',
    pinLinks: 'リンクを現在のパネルの上に固定', unpinLinks: 'リンクの固定を解除', openTarget: 'この文書をエディターで開く',
    target: 'リンク先', followActive: 'アクティブな文書に追従', fixed: '固定した文書',
    fixTarget: 'この文書を固定', useActive: 'アクティブな文書に追従',
    filter: 'リンクとコンテキストを絞り込む', clearFilter: '絞り込みを解除', back: '前の場所に戻る',
    openOtherPane: '別の分割領域で開く', expandContext: 'コンテキストを表示', collapseContext: 'コンテキストを隠す',
    backlinks: 'バックリンク', mentions: '未リンクの言及', outgoing: 'この文書のリンク',
    inspector: 'ドキュメントインスペクター', noWorkspace: 'プロジェクトのリンクを見るにはフォルダーを開いてください。',
    noDocument: 'リンクを見るには Markdown 文書を開いてください。',
    noPath: '未保存文書にはプロジェクト内のパスがないため、バックリンクはありません。',
    outsideWorkspace: 'この文書は開いているフォルダーの外にあります。',
    notIndexed: 'この文書は現在のプロジェクト索引にありません。',
    indexing: 'プロジェクト文書を索引中…', partial: '索引できないファイルがあるため、結果が不完全な場合があります。',
    pinnedMissing: '固定した文書は現在のプロジェクトにありません。',
    noBacklinks: 'バックリンクはまだありません。', noMentions: '未リンクの言及はまだありません。', noOutgoing: 'この文書にリンクはありません。',
    noMatches: '一致する結果はありません。', noRelations: 'この文書にリンクや言及はまだありません。',
    selectResult: '参照元を開く', emptyAgent: 'Agent パネルはエディターから提供されます。', targetError: 'リンク先の文書を索引できませんでした。',
  },
} satisfies Record<LocaleId, Record<string, string>>

export type InspectorMessageKey = keyof typeof messages.en

export function translateInspector(locale: LocaleId, key: InspectorMessageKey): string {
  return messages[locale][key] ?? messages.en[key]
}
