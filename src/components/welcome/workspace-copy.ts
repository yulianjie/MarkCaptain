import { computed } from 'vue'
import { useI18n } from '@/i18n'

const messages = {
  en: {
    workspace: 'Writing space', localFolder: 'Local folder', localWorkspace: 'Local workspace',
    commands: 'Search and commands', start: 'Start', newDocument: 'New document',
    title: 'What would you like to write?', subtitle: 'Start with a new idea, or return to your thoughts.',
    recent: 'Recently opened', allRecent: 'View all', emptyRecent: 'Your recently opened documents will appear here.',
    localNote: 'Your words, in your own folders.', openDocument: 'Open a document',
    welcome: 'A SPACE FOR YOUR THOUGHTS', format: 'Formatting', export: 'Export document',
    closeNavigation: 'Close navigation', document: 'Document',
  },
  'zh-CN': {
    workspace: '写作空间', localFolder: '本地文件夹', localWorkspace: '本地工作区',
    commands: '搜索与命令', start: '开始', newDocument: '新建文档',
    title: '今天，想写点什么？', subtitle: '从新的想法开始，或继续上次的思考。',
    recent: '最近打开', allRecent: '查看全部', emptyRecent: '最近打开的文档会显示在这里。',
    localNote: '你的文字，始终在你自己的文件夹里。', openDocument: '打开文档',
    welcome: '留一点空间，给自己的想法', format: '格式工具', export: '导出文档',
    closeNavigation: '关闭导航', document: '文档',
  },
  ja: {
    workspace: '執筆スペース', localFolder: 'ローカルフォルダー', localWorkspace: 'ローカルワークスペース',
    commands: '検索とコマンド', start: 'スタート', newDocument: '新規ドキュメント',
    title: '今日は何を書きますか？', subtitle: '新しいアイデアから始める、または思考の続きを。',
    recent: '最近開いた項目', allRecent: 'すべて表示', emptyRecent: '最近開いたドキュメントがここに表示されます。',
    localNote: 'あなたの言葉を、あなたのフォルダーに。', openDocument: 'ドキュメントを開く',
    welcome: '思考のための余白', format: '書式設定', export: 'ドキュメントを書き出す',
    closeNavigation: 'ナビゲーションを閉じる', document: 'ドキュメント',
  },
} as const

export function useWorkspaceCopy() {
  const { locale } = useI18n()
  return computed(() => messages[locale.value] ?? messages.en)
}
