<script setup lang="ts">
/**
 * Preferences window — sectioned settings UI.
 *
 * Each section maps to one cluster from the original
 * the upstream renderer preference components. Writes go straight through the
 * preferences store (which persists via tauri-plugin-store), so changes are
 * effective immediately. Edits made here propagate to other open windows via
 * the Rust-emitted `mt://prefs/changed` event.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { Check, Cloud, Code2, Image, Keyboard, Layout, Monitor, Palette, Search, Settings2, SpellCheck, Type } from '@lucide/vue'
import {
  usePreferencesStore,
  type AutoSwitchTheme,
  type ListIndentation,
  type TabSize,
} from '@/stores/preferences'
import { useKeybindingsStore, eventAccel } from '@/stores/keybindings'
import {
  displayAccelerator,
  serialiseAccelerator,
  shortcutPlatformFromNavigator,
} from '@/common/shortcut-registry'
import { refreshUserTheme } from '@/services/preferences-applier'
import {
  destroySettingsWindow,
  listThemes,
  openFolder,
  setMenuAcceleratorsEnabled,
  spellcheckAvailableDictionaries,
  type UserTheme,
} from '@/services/tauri-invoke'
import { appIconOptions, type AppIconId } from '@/services/app-icon'
import type { TrailingNewlinePolicy } from '@/services/trailing-newline'
import { useI18n } from '@/i18n'
import CloudStorageSettings from '@/components/cloud/CloudStorageSettings.vue'

const prefs = usePreferencesStore()
const keys = useKeybindingsStore()
const userThemes = ref<UserTheme[]>([])
const themesLoading = ref(false)
const themeRefreshFailed = ref(false)
const availableDictionaries = ref<string[]>([])
const dictionariesLoading = ref(false)
const dictionariesLoadFailed = ref(false)
const { t, locale } = useI18n()
const shortcutPlatform = shortcutPlatformFromNavigator(navigator.platform)

// Keep text input responsive while avoiding one IPC write per keystroke. Dirty
// drafts are not replaced by cross-window events; they are debounced during
// typing and synchronously flushed by the settings-window close handler.
interface TextDraftControl {
  flush: () => Promise<boolean>
  cancelTimer: () => void
}

const textDraftControls: TextDraftControl[] = []

function useTextDraft(
  source: () => string,
  persist: (value: string) => Promise<boolean>,
) {
  const draft = ref(source())
  let dirty = false
  let syncingFromStore = false
  let version = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const cancelTimer = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  const flush = async (): Promise<boolean> => {
    cancelTimer()
    if (!dirty) return true
    const value = draft.value
    const startedAtVersion = version
    const saved = await persist(value)
    if (saved && version === startedAtVersion) dirty = false
    return saved
  }

  watch(source, value => {
    if (dirty || value === draft.value) return
    syncingFromStore = true
    draft.value = value
    syncingFromStore = false
  }, { flush: 'sync' })
  watch(draft, () => {
    if (syncingFromStore) return
    dirty = true
    version += 1
    cancelTimer()
    timer = setTimeout(() => { void flush() }, 400)
  }, { flush: 'sync' })

  textDraftControls.push({ flush, cancelTimer })
  return draft
}

async function flushTextDrafts(): Promise<boolean> {
  const results = await Promise.all(textDraftControls.map(control => control.flush()))
  return results.every(Boolean)
}

const startupDirectoryDraft = useTextDraft(
  () => prefs.defaultDirectoryToOpen,
  value => prefs.set('defaultDirectoryToOpen', value),
)
const editorFontFamilyDraft = useTextDraft(
  () => prefs.editorFontFamily,
  value => prefs.set('editorFontFamily', value),
)
const editorLineWidthDraft = useTextDraft(
  () => prefs.editorLineWidth,
  value => prefs.set('editorLineWidth', value),
)
const codeFontFamilyDraft = useTextDraft(
  () => prefs.codeFontFamily,
  value => prefs.set('codeFontFamily', value),
)
const imageRelativeDirectoryDraft = useTextDraft(
  () => prefs.imageRelativeDirectoryName,
  value => prefs.set('imageRelativeDirectoryName', value),
)
const imageFolderPathDraft = useTextDraft(
  () => prefs.imageFolderPath,
  value => prefs.patchUserData({ imageFolderPath: value }),
)
const picgoPathDraft = useTextDraft(
  () => prefs.picgoPath,
  value => prefs.patchUserData({ picgoPath: value }),
)
const cliScriptDraft = useTextDraft(
  () => prefs.cliScript,
  value => prefs.patchUserData({ cliScript: value }),
)
const githubTokenDraft = useTextDraft(
  () => prefs.githubToken,
  value => prefs.patchUserData({ githubToken: value }),
)
const githubOwnerDraft = useTextDraft(
  () => prefs.imageBed.github.owner,
  value => prefs.patchUserData({ imageBed: { github: { owner: value } } }),
)
const githubRepoDraft = useTextDraft(
  () => prefs.imageBed.github.repo,
  value => prefs.patchUserData({ imageBed: { github: { repo: value } } }),
)
const githubBranchDraft = useTextDraft(
  () => prefs.imageBed.github.branch,
  value => prefs.patchUserData({ imageBed: { github: { branch: value } } }),
)
const searchExclusionsDraft = useTextDraft(
  () => prefs.searchExclusions.join('\n'),
  value => prefs.set('searchExclusions', value.split(/\r?\n/).map(s => s.trim()).filter(Boolean)),
)
const searchMaxFileSizeDraft = useTextDraft(
  () => prefs.searchMaxFileSize,
  value => prefs.set('searchMaxFileSize', value),
)
const zoomDraft = ref(prefs.zoom)
watch(() => prefs.zoom, value => { zoomDraft.value = value })

/* ── keybindings UI state ─────────────────────────────────────── */
const editingAccel = ref<string | null>(null)   // action id currently being recorded
const recordedAccel = ref<string>('')
const accelResultMessage = ref('')
const keybindingsNotice = ref<{ type: 'success' | 'error'; text: string } | null>(null)
let menuAcceleratorsEnabled = true
let menuAcceleratorTransition: Promise<void> = Promise.resolve()

const keybindingActionKeys: Record<string, string> = {
  'file.new': 'prefs.keybindings.actions.fileNew',
  'file.quickOpen': 'notes.quick',
  'file.dailyNote': 'notes.daily',
  'edit.insertTemplate': 'notes.templates',
  'file.open': 'prefs.keybindings.actions.fileOpen',
  'file.openFolder': 'prefs.keybindings.actions.fileOpenFolder',
  'file.save': 'prefs.keybindings.actions.fileSave',
  'file.saveAs': 'prefs.keybindings.actions.fileSaveAs',
  'file.closeTab': 'prefs.keybindings.actions.fileCloseTab',
  'file.print': 'prefs.keybindings.actions.filePrint',
  'edit.find': 'prefs.keybindings.actions.editFind',
  'edit.replace': 'prefs.keybindings.actions.editReplace',
  'view.toggleSidebar': 'prefs.keybindings.actions.viewToggleSidebar',
  'view.commandPalette': 'prefs.keybindings.actions.viewCommandPalette',
}

function keybindingActionLabel(actionId: string): string {
  const key = keybindingActionKeys[actionId]
  return key ? t(key) : actionId
}

const accelValidation = computed(() => {
  if (!editingAccel.value || !recordedAccel.value) return null
  return keys.validate(editingAccel.value, recordedAccel.value)
})

const accelFeedback = computed(() => {
  if (accelResultMessage.value) return accelResultMessage.value
  const validation = accelValidation.value
  if (!validation || validation.ok) return ''
  if (validation.code === 'conflict' && validation.conflictWith) {
    return t('prefs.keybindings.conflict', {
      action: keybindingActionLabel(validation.conflictWith),
    })
  }
  if (validation.code === 'modifier-required') {
    return t('prefs.keybindings.modifierRequired')
  }
  if (validation.code === 'reserved') return t('prefs.keybindings.reserved')
  return validation.message || t('prefs.keybindings.invalid')
})

const canApplyAccel = computed(() => accelValidation.value?.ok === true)

function keybindingInputId(actionId: string): string {
  return `keybinding-input-${actionId.replace(/[^a-z0-9_-]/gi, '-')}`
}

async function startEdit(actionId: string) {
  keybindingsNotice.value = null
  try {
    await transitionMenuAccelerators(false)
  } catch (error) {
    keybindingsNotice.value = {
      type: 'error',
      text: t('prefs.keybindings.recorderFailed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    }
    return
  }
  editingAccel.value = actionId
  recordedAccel.value = ''
  accelResultMessage.value = ''
  void nextTick(() => document.getElementById(keybindingInputId(actionId))?.focus())
}

function onAccelKey(ev: KeyboardEvent) {
  if (!editingAccel.value) return
  const hasCommandModifier = ev.ctrlKey || ev.metaKey || ev.altKey
  // Plain Escape remains a convenient cancellation key. Ctrl/Cmd/Alt+Escape
  // is a real, recorder-safe accelerator and must reach validation instead.
  // Shift+Escape preserves the same cancellation behavior as plain Escape.
  if (ev.key === 'Escape' && !hasCommandModifier) {
    ev.preventDefault()
    ev.stopPropagation()
    cancelEdit()
    return
  }
  // Plain Tab keeps native focus movement so Set/Cancel remain reachable;
  // Ctrl/Cmd/Alt+Tab is recorded just like every other modified shortcut.
  // Shift+Tab must continue to move focus backwards rather than become a key.
  if (ev.key === 'Tab' && !hasCommandModifier) return
  // Ignore lone modifier keys — wait for the user to press the actual key.
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(ev.key)) {
    ev.preventDefault()
    return
  }
  ev.preventDefault()
  recordedAccel.value = serialiseAccelerator(eventAccel(ev, shortcutPlatform))
  accelResultMessage.value = ''
}

function cancelEdit() {
  editingAccel.value = null
  recordedAccel.value = ''
  accelResultMessage.value = ''
  void restoreMenuAccelerators()
}

async function restoreMenuAccelerators() {
  try {
    await transitionMenuAccelerators(true)
  } catch (error) {
    keybindingsNotice.value = {
      type: 'error',
      text: t('prefs.keybindings.recorderFailed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    }
  }
}

function transitionMenuAccelerators(enabled: boolean): Promise<void> {
  const transition = async () => {
    if (menuAcceleratorsEnabled === enabled) return
    await setMenuAcceleratorsEnabled(enabled)
    menuAcceleratorsEnabled = enabled
  }
  menuAcceleratorTransition = menuAcceleratorTransition.then(transition, transition)
  return menuAcceleratorTransition
}

function onAccelBlur(ev: FocusEvent) {
  const row = (ev.currentTarget as HTMLElement).closest('tr')
  const blurredAction = editingAccel.value
  requestAnimationFrame(() => {
    if (editingAccel.value === blurredAction && (!row || !row.contains(document.activeElement))) {
      cancelEdit()
    }
  })
}

async function applyAccel() {
  if (!canApplyAccel.value || !editingAccel.value) return
  const actionId = editingAccel.value
  const result = await keys.set(actionId, recordedAccel.value)
  if (editingAccel.value !== actionId) return
  if (result.ok) {
    cancelEdit()
    return
  }
  if (result.code === 'conflict' && result.conflictWith) {
    accelResultMessage.value = t('prefs.keybindings.conflict', {
      action: keybindingActionLabel(result.conflictWith),
    })
  } else if (result.code === 'modifier-required') {
    accelResultMessage.value = t('prefs.keybindings.modifierRequired')
  } else if (result.code === 'reserved') {
    accelResultMessage.value = t('prefs.keybindings.reserved')
  } else if (result.code === 'persist-failed') {
    accelResultMessage.value = t('prefs.keybindings.saveFailed')
  } else {
    accelResultMessage.value = result.message || t('prefs.keybindings.invalid')
  }
}

async function resetKeybindings() {
  const result = await keys.resetAll()
  if (result.ok) {
    cancelEdit()
    keybindingsNotice.value = {
      type: 'success',
      text: t('prefs.keybindings.resetSuccess'),
    }
  } else {
    keybindingsNotice.value = {
      type: 'error',
      text: result.message || t('prefs.keybindings.resetFailed'),
    }
  }
}

async function reloadUserThemes() {
  themesLoading.value = true
  themeRefreshFailed.value = false
  try {
    userThemes.value = await listThemes()
    // Resolve through the active auto-switch mode instead of forcing the
    // manually selected theme while the app is following the OS.
    themeRefreshFailed.value = !(await refreshUserTheme())
  } catch {
    userThemes.value = []
    themeRefreshFailed.value = true
  } finally {
    themesLoading.value = false
  }
}

async function reloadDictionaries() {
  dictionariesLoading.value = true
  dictionariesLoadFailed.value = false
  try {
    availableDictionaries.value = await spellcheckAvailableDictionaries()
  } catch {
    availableDictionaries.value = []
    dictionariesLoadFailed.value = true
  } finally {
    dictionariesLoading.value = false
  }
}

const currentDictionaryMissing = computed(() => (
  !dictionariesLoading.value &&
  !dictionariesLoadFailed.value &&
  Boolean(prefs.spellcheckerLanguage) &&
  !availableDictionaries.value.includes(prefs.spellcheckerLanguage)
))

type SectionId =
  | 'general'
  | 'editor'
  | 'markdown'
  | 'theme'
  | 'image'
  | 'cloud'
  | 'spellchecker'
  | 'view'
  | 'search'
  | 'keybindings'

const sections = computed<{ id: SectionId; label: string }[]>(() => [
  { id: 'general', label: t('prefs.sections.general') },
  { id: 'editor', label: t('prefs.sections.editor') },
  { id: 'markdown', label: t('prefs.sections.markdown') },
  { id: 'theme', label: t('prefs.sections.theme') },
  { id: 'image', label: t('prefs.sections.image') },
  { id: 'cloud', label: t('prefs.sections.cloud') },
  { id: 'spellchecker', label: t('prefs.sections.spellchecker') },
  { id: 'view', label: t('prefs.sections.view') },
  { id: 'search', label: t('prefs.sections.search') },
  { id: 'keybindings', label: t('prefs.sections.keybindings') },
])

const sectionIcons = { general: Settings2, editor: Type, markdown: Code2, theme: Palette, image: Image, cloud: Cloud, spellchecker: SpellCheck, view: Layout, search: Search, keybindings: Keyboard }
// Page-specific editorial copy stays together so the settings hierarchy remains
// translated without adding presentation-only keys to the shared catalog.
const pageCopy = {
  en: {
    workspace: 'Writing space', resources: 'Resources', advanced: 'Advanced',
    instant: 'Changes take effect immediately', application: 'Application & saving',
    appearance: 'Appearance', files: 'Files & startup', typography: 'Typography',
    code: 'Code blocks', editing: 'Editing behavior', fileFormat: 'File format',
    syntax: 'Markdown syntax', extensions: 'Extensions & diagrams',
    imageLocation: 'Image location', uploading: 'Image uploads', themeOptions: 'Theme options',
    general: 'File saving, startup, and your everyday preferences.',
    editor: 'Fonts, paragraphs, and the way you write.',
    markdown: 'Choose how Markdown is written and rendered.',
    theme: 'Make your writing space feel comfortable.',
    image: 'Choose where images are stored and how they are uploaded.',
    cloud: 'Manage connections and synchronize your local documents.',
    spellchecker: 'Languages and spelling feedback while you write.',
    view: 'Choose the parts of your writing space you want to see.',
    search: 'Control which files are included in project search.',
    keybindings: 'Keep your most frequent actions close at hand.',
  },
  'zh-CN': {
    workspace: '写作空间', resources: '资源与服务', advanced: '高级',
    instant: '更改会立即生效', application: '应用与保存',
    appearance: '界面外观', files: '文件与启动', typography: '正文排版',
    code: '代码块', editing: '编辑习惯', fileFormat: '文件格式',
    syntax: 'Markdown 语法', extensions: '扩展与图表',
    imageLocation: '图片位置', uploading: '图片上传', themeOptions: '主题选项',
    general: '文件保存、启动行为，以及日常使用偏好。',
    editor: '字体、段落与编辑习惯。',
    markdown: '选择 Markdown 的书写与呈现方式。',
    theme: '让写作空间，适合你的习惯。',
    image: '配置图片的存放位置与上传方式。',
    cloud: '管理连接，同步保存在本地的文档。',
    spellchecker: '设置写作时使用的语言与拼写提示。',
    view: '选择写作空间中需要显示的界面元素。',
    search: '控制项目搜索包含的文件范围。',
    keybindings: '让常用操作保持顺手。',
  },
  ja: {
    workspace: '執筆スペース', resources: 'リソースとサービス', advanced: '詳細設定',
    instant: '変更はすぐに適用されます', application: 'アプリと保存',
    appearance: '外観', files: 'ファイルと起動', typography: '文字と段落',
    code: 'コードブロック', editing: '編集動作', fileFormat: 'ファイル形式',
    syntax: 'Markdown 構文', extensions: '拡張と図表',
    imageLocation: '画像の保存先', uploading: '画像のアップロード', themeOptions: 'テーマの設定',
    general: 'ファイルの保存、起動時の動作、日常の設定。',
    editor: 'フォント、段落、書き方を整えます。',
    markdown: 'Markdown の記述と表示を設定します。',
    theme: '自分に合った、心地よい執筆スペースに。',
    image: '画像の保存先とアップロード方法を選びます。',
    cloud: '接続を管理し、ローカルの文書を同期します。',
    spellchecker: '執筆中の言語とスペルチェックを設定します。',
    view: '執筆スペースに表示する要素を選びます。',
    search: 'プロジェクト内の検索対象を設定します。',
    keybindings: 'よく使う操作を、手の届く場所に。',
  },
} as const
const copy = computed(() => pageCopy[locale.value])
const themeChoices = computed(() => [
  { id: 'light', label: t('prefs.theme.themeLight') },
  { id: 'dark', label: t('prefs.theme.themeDark') },
  { id: 'system', label: t('prefs.theme.autoSwitchFollowOs') },
] as const)

function isThemeChoiceSelected(choice: string): boolean {
  return choice === 'system' ? prefs.autoSwitchTheme === 1 : prefs.autoSwitchTheme !== 1 && prefs.theme === choice
}

async function selectThemeChoice(choice: 'light' | 'dark' | 'system') {
  if (choice === 'system') await prefs.set('autoSwitchTheme', 1)
  else await prefs.patch({ theme: choice, autoSwitchTheme: 2 })
}

const active = ref<SectionId>('general')
const prefsBody = ref<HTMLElement | null>(null)
const compactNavigation = ref(false)
let navigationMediaQuery: MediaQueryList | null = null

function updateNavigationOrientation() {
  compactNavigation.value = navigationMediaQuery?.matches ?? false
}

function selectSection(sectionId: SectionId) {
  active.value = sectionId
  void nextTick(() => prefsBody.value?.scrollTo({ top: 0 }))
}

function onSectionKeydown(ev: KeyboardEvent, index: number) {
  let nextIndex: number | null = null
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') {
    nextIndex = (index + 1) % sections.value.length
  } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') {
    nextIndex = (index - 1 + sections.value.length) % sections.value.length
  } else if (ev.key === 'Home') {
    nextIndex = 0
  } else if (ev.key === 'End') {
    nextIndex = sections.value.length - 1
  }
  if (nextIndex === null) return
  ev.preventDefault()
  const nextSection = sections.value[nextIndex]
  selectSection(nextSection.id)
  void nextTick(() => document.getElementById(`prefs-tab-${nextSection.id}`)?.focus())
}

const fontSize = computed({
  get: () => prefs.fontSize,
  set: v => { void prefs.set('fontSize', Number(v)) },
})

let unlistenCloseRequested: (() => void) | null = null
let closingSettingsWindow = false

onMounted(async () => {
  navigationMediaQuery = window.matchMedia('(max-width: 760px)')
  updateNavigationOrientation()
  navigationMediaQuery.addEventListener('change', updateNavigationOrientation)
  await Promise.all([reloadUserThemes(), reloadDictionaries()])
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    const settingsWindow = getCurrentWindow()
    unlistenCloseRequested = await settingsWindow.onCloseRequested(async event => {
      event.preventDefault()
      if (closingSettingsWindow) return
      closingSettingsWindow = true
      const flushed = await flushTextDrafts()
      if (!flushed) {
        closingSettingsWindow = false
        return
      }
      await restoreMenuAccelerators()
      try {
        await destroySettingsWindow()
      } catch (error) {
        closingSettingsWindow = false
        prefs.lastError = `Unable to close Preferences: ${error instanceof Error ? error.message : String(error)}`
      }
    })
  }
})

onBeforeUnmount(() => {
  navigationMediaQuery?.removeEventListener('change', updateNavigationOrientation)
  unlistenCloseRequested?.()
  textDraftControls.forEach(control => control.cancelTimer())
  if (!closingSettingsWindow) void flushTextDrafts()
  void restoreMenuAccelerators()
})

async function chooseStartupFolder() {
  const selected = await openFolder()
  if (selected) startupDirectoryDraft.value = selected
}

function appIconLabel(icon: { id: AppIconId; label: string }): string {
  return icon.id === 'default' ? t('prefs.general.appIconDefault') : icon.label
}

function appIconDescription(iconId: AppIconId): string {
  if (iconId === 'ios26') return t('prefs.general.appIconLiquidGlass')
  if (iconId === 'ios26-alt') return t('prefs.general.appIconLiquidGlassAlt')
  return t('prefs.general.appIconOriginal')
}

function appIconButtonId(iconId: AppIconId): string {
  return `prefs-app-icon-${iconId}`
}

function onAppIconKeydown(event: KeyboardEvent, index: number) {
  let nextIndex: number | null = null
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    nextIndex = (index + 1) % appIconOptions.length
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    nextIndex = (index - 1 + appIconOptions.length) % appIconOptions.length
  } else if (event.key === 'Home') {
    nextIndex = 0
  } else if (event.key === 'End') {
    nextIndex = appIconOptions.length - 1
  }
  if (nextIndex === null) return
  event.preventDefault()
  const icon = appIconOptions[nextIndex]
  void prefs.set('appIcon', icon.id)
  void nextTick(() => document.getElementById(appIconButtonId(icon.id))?.focus())
}

watchEffect(() => {
  const title = t('prefs.title')
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    void getCurrentWindow().setTitle(title)
  }
})
</script>

<template>
  <div class="prefs-page">
    <aside class="prefs-nav">
      <div class="prefs-brand"><Settings2 :size="19" aria-hidden="true" /><h2 class="prefs-title">{{ t('prefs.title') }}</h2></div>
      <nav :aria-label="t('prefs.navigationLabel')">
        <ul
          role="tablist"
          :aria-orientation="compactNavigation ? 'horizontal' : 'vertical'"
        >
          <li v-for="(sec, index) in sections" :key="sec.id" role="presentation">
            <div v-if="index === 0 || index === 4 || index === 7" class="prefs-nav-group" aria-hidden="true">
              {{ index === 0 ? copy.workspace : index === 4 ? copy.resources : copy.advanced }}
            </div>
            <button
              :id="`prefs-tab-${sec.id}`"
              type="button"
              role="tab"
              class="prefs-nav-button"
              :class="{ active: active === sec.id }"
              :aria-selected="active === sec.id"
              :aria-controls="`prefs-panel-${sec.id}`"
              :tabindex="active === sec.id ? 0 : -1"
              @click="selectSection(sec.id)"
              @keydown="onSectionKeydown($event, index)"
            >
              <component :is="sectionIcons[sec.id]" :size="16" :stroke-width="1.7" aria-hidden="true" />
              <span>{{ sec.label }}</span>
            </button>
          </li>
        </ul>
      </nav>
      <div class="prefs-nav-note"><Check :size="13" aria-hidden="true" /><span>{{ copy.instant }}</span></div>
    </aside>

    <main ref="prefsBody" class="prefs-body">
      <div
        v-if="prefs.saving || prefs.lastError"
        class="prefs-save-status"
        aria-live="polite"
      >
        <span v-if="prefs.saving" class="saving-indicator" role="status">
          <span class="saving-dot" aria-hidden="true"></span>
          {{ t('prefs.saving') }}
        </span>
        <el-alert
          v-if="prefs.lastError"
          type="error"
          :closable="true"
          show-icon
          role="alert"
          @close="prefs.clearError()"
        >
          {{ t('prefs.saveFailed', { error: prefs.lastError }) }}
        </el-alert>
      </div>
      <!-- ── General ─────────────────────────────────────── -->
      <section
        v-show="active === 'general'"
        id="prefs-panel-general"
        class="prefs-section"
        role="tabpanel"
        aria-labelledby="prefs-tab-general"
        tabindex="0"
      >
        <h3>{{ t('prefs.sections.general') }}</h3>
        <p class="prefs-description">{{ copy.general }}</p>
        <el-form label-width="220px" label-position="left">
          <h4 class="prefs-subheading">{{ copy.application }}</h4>
          <el-form-item :label="t('prefs.general.autoCheckUpdates')">
            <el-switch :model-value="prefs.autoCheckUpdates" @update:model-value="v => prefs.set('autoCheckUpdates', !!v)" />
            <span class="hint inline-hint">{{ t('prefs.general.autoCheckUpdatesHint') }}</span>
          </el-form-item>
          <el-form-item :label="t('prefs.general.autoSave')">
            <el-switch :model-value="prefs.autoSave" @update:model-value="v => prefs.set('autoSave', !!v)" />
          </el-form-item>
          <el-form-item :label="t('prefs.general.autoSaveDelay')">
            <el-input-number
              :model-value="prefs.autoSaveDelay"
              :min="1000"
              :step="500"
              :disabled="!prefs.autoSave"
              @update:model-value="v => prefs.set('autoSaveDelay', Number(v))"
            />
          </el-form-item>
          <el-form-item :label="t('prefs.general.rememberWindowSize')">
            <el-switch
              :model-value="prefs.rememberWindowSize"
              @update:model-value="v => prefs.set('rememberWindowSize', !!v)"
            />
            <span class="hint inline-hint">
              {{ t('prefs.general.rememberWindowSizeHint') }}
            </span>
          </el-form-item>
          <h4 class="prefs-subheading">{{ copy.appearance }}</h4>
          <el-form-item :label="t('prefs.general.appIcon')">
            <div
              class="icon-choices"
              role="radiogroup"
              :aria-label="t('prefs.general.appIcon')"
            >
              <button
                v-for="(icon, index) in appIconOptions"
                :key="icon.id"
                :id="appIconButtonId(icon.id)"
                type="button"
                class="icon-choice"
                :class="{ selected: prefs.appIcon === icon.id }"
                role="radio"
                :aria-checked="prefs.appIcon === icon.id"
                :tabindex="prefs.appIcon === icon.id ? 0 : -1"
                :aria-label="t('prefs.general.appIconChoice', {
                  label: appIconLabel(icon),
                  description: appIconDescription(icon.id),
                })"
                @click="prefs.set('appIcon', icon.id as AppIconId)"
                @keydown="onAppIconKeydown($event, index)"
              >
                <img :src="icon.src" alt="" aria-hidden="true" />
                <span class="icon-choice-title">{{ appIconLabel(icon) }}</span>
                <span class="icon-choice-desc">{{ appIconDescription(icon.id) }}</span>
              </button>
            </div>
          </el-form-item><!-- app icon choices -->
          <el-form-item :label="t('prefs.general.zoom')">
            <el-slider
              v-model="zoomDraft"
              :min="0.5"
              :max="2.0"
              :step="0.1"
              style="width: 220px"
              @change="v => prefs.set('zoom', Number(v))"
            />
          </el-form-item>
          <el-form-item :label="t('prefs.general.hideScrollbar')">
            <el-switch :model-value="prefs.hideScrollbar" @update:model-value="v => prefs.set('hideScrollbar', !!v)" />
          </el-form-item>
          <el-form-item :label="t('prefs.general.wordWrapInToc')">
            <el-switch :model-value="prefs.wordWrapInToc" @update:model-value="v => prefs.set('wordWrapInToc', !!v)" />
          </el-form-item>
          <h4 class="prefs-subheading">{{ copy.files }}</h4>
          <el-form-item :label="t('prefs.general.sortBy')">
            <el-select
              :model-value="prefs.fileSortBy"
              style="width: 200px"
              @update:model-value="v => prefs.set('fileSortBy', v as 'created' | 'modified' | 'title')"
            >
              <el-option :label="t('prefs.general.sortByModified')" value="modified" />
              <el-option :label="t('prefs.general.sortByCreated')" value="created" />
              <el-option :label="t('prefs.general.sortByTitle')" value="title" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('prefs.general.onStartup')">
            <el-select
              :model-value="prefs.startUpAction"
              style="width: 200px"
              @update:model-value="v => prefs.set('startUpAction', v as 'folder' | 'lastState' | 'blank')"
            >
              <el-option :label="t('prefs.general.startupBlank')" value="blank" />
              <el-option :label="t('prefs.general.startupLastState')" value="lastState" />
              <el-option :label="t('prefs.general.startupFolder')" value="folder" />
            </el-select>
          </el-form-item>
          <el-form-item
            v-show="prefs.startUpAction === 'folder'"
            :label="t('prefs.general.startupDirectory')"
          >
            <div class="input-with-action">
              <el-input
                v-model="startupDirectoryDraft"
                :placeholder="t('prefs.general.startupDirectoryPlaceholder')"
              />
              <el-button native-type="button" @click="chooseStartupFolder">
                {{ t('common.browse') }}
              </el-button>
            </div>
          </el-form-item>
          <el-form-item :label="t('prefs.general.language')">
            <el-select
              :model-value="prefs.language"
              style="width: 200px"
              @update:model-value="v => prefs.set('language', v as string)"
            >
              <el-option label="English" value="en" />
              <el-option label="简体中文" value="zh-CN" />
              <el-option label="日本語" value="ja" />
            </el-select>
          </el-form-item>
        </el-form>
      </section>

      <!-- ── Editor ─────────────────────────────────────── -->
      <section
        v-show="active === 'editor'"
        id="prefs-panel-editor"
        class="prefs-section"
        role="tabpanel"
        aria-labelledby="prefs-tab-editor"
        tabindex="0"
      >
        <h3>{{ t('prefs.sections.editor') }}</h3>
        <p class="prefs-description">{{ copy.editor }}</p>
        <el-form label-width="220px" label-position="left">
          <h4 class="prefs-subheading">{{ copy.typography }}</h4>
          <el-form-item :label="t('prefs.editor.fontSize')">
            <el-input-number v-model="fontSize" :min="12" :max="32" />
          </el-form-item>
          <el-form-item :label="t('prefs.editor.lineHeight')">
            <el-input-number
              :model-value="prefs.lineHeight"
              :min="1.2"
              :max="2"
              :step="0.1"
              :precision="1"
              @update:model-value="v => prefs.set('lineHeight', Number(v))"
            />
          </el-form-item>
          <el-form-item :label="t('prefs.editor.fontFamily')">
            <el-input
              v-model="editorFontFamilyDraft"
              style="width: 240px"
            />
          </el-form-item>
          <el-form-item :label="t('prefs.editor.lineWidth')">
            <el-input
              v-model="editorLineWidthDraft"
              :placeholder="t('prefs.editor.lineWidthPlaceholder')"
              style="width: 200px"
            />
          </el-form-item>
          <h4 class="prefs-subheading">{{ copy.code }}</h4>
          <el-form-item :label="t('prefs.editor.codeFontSize')">
            <el-input-number
              :model-value="prefs.codeFontSize"
              :min="12"
              :max="28"
              @update:model-value="v => prefs.set('codeFontSize', Number(v))"
            />
          </el-form-item>
          <el-form-item :label="t('prefs.editor.codeFontFamily')">
            <el-input
              v-model="codeFontFamilyDraft"
              style="width: 240px"
            />
          </el-form-item>
          <el-form-item :label="t('prefs.editor.codeLineNumbers')">
            <el-switch :model-value="prefs.codeBlockLineNumbers" @update:model-value="v => prefs.set('codeBlockLineNumbers', !!v)" />
          </el-form-item>
          <el-form-item :label="t('prefs.editor.trimEmpty')">
            <el-switch :model-value="prefs.trimUnnecessaryCodeBlockEmptyLines" @update:model-value="v => prefs.set('trimUnnecessaryCodeBlockEmptyLines', !!v)" />
          </el-form-item>
          <h4 class="prefs-subheading">{{ copy.editing }}</h4>
          <el-form-item :label="t('prefs.editor.autoPairBracket')">
            <el-switch :model-value="prefs.autoPairBracket" @update:model-value="v => prefs.set('autoPairBracket', !!v)" />
          </el-form-item>
          <el-form-item :label="t('prefs.editor.autoPairMd')">
            <el-switch :model-value="prefs.autoPairMarkdownSyntax" @update:model-value="v => prefs.set('autoPairMarkdownSyntax', !!v)" />
          </el-form-item>
          <el-form-item :label="t('prefs.editor.autoPairQuote')">
            <el-switch :model-value="prefs.autoPairQuote" @update:model-value="v => prefs.set('autoPairQuote', !!v)" />
          </el-form-item>
          <h4 class="prefs-subheading">{{ copy.fileFormat }}</h4>
          <el-form-item :label="t('prefs.editor.eol')">
            <el-select
              :model-value="prefs.endOfLine"
              style="width: 200px"
              @update:model-value="v => prefs.set('endOfLine', v as 'default' | 'lf' | 'crlf')"
            >
              <el-option :label="t('prefs.editor.eolDefault')" value="default" />
              <el-option :label="t('prefs.editor.eolLf')" value="lf" />
              <el-option :label="t('prefs.editor.eolCrlf')" value="crlf" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('prefs.editor.encoding')">
            <el-select
              :model-value="prefs.defaultEncoding"
              style="width: 200px"
              @update:model-value="v => prefs.set('defaultEncoding', String(v))"
            >
              <el-option label="UTF-8" value="utf8" />
              <el-option label="UTF-16LE" value="utf16le" />
              <el-option label="UTF-16BE" value="utf16be" />
              <el-option label="GBK" value="gbk" />
              <el-option label="GB18030" value="gb18030" />
              <el-option label="Big5" value="big5" />
              <el-option label="Shift JIS" value="shiftjis" />
              <el-option label="EUC-JP" value="eucjp" />
              <el-option label="EUC-KR" value="euckr" />
              <el-option label="CP1252" value="cp1252" />
              <el-option label="Latin-1" value="iso885915" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('prefs.editor.autoGuessEncoding')">
            <el-switch :model-value="prefs.autoGuessEncoding" @update:model-value="v => prefs.set('autoGuessEncoding', !!v)" />
          </el-form-item>
          <el-form-item :label="t('prefs.editor.trimTrailingNewline')">
            <el-select
              :model-value="prefs.trimTrailingNewline"
              style="width: 300px"
              @update:model-value="v => prefs.set('trimTrailingNewline', Number(v) as TrailingNewlinePolicy)"
            >
              <el-option :label="t('prefs.editor.trimTrailingNewlineTrimAll')" :value="0" />
              <el-option :label="t('prefs.editor.trimTrailingNewlineEnsureOne')" :value="1" />
              <el-option :label="t('prefs.editor.trimTrailingNewlinePreserve')" :value="2" />
              <el-option :label="t('prefs.editor.trimTrailingNewlineNothing')" :value="3" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('prefs.editor.textDirection')">
            <el-select
              :model-value="prefs.textDirection"
              style="width: 200px"
              @update:model-value="v => prefs.set('textDirection', v as 'ltr' | 'rtl')"
            >
              <el-option :label="t('prefs.editor.textDirectionLtr')" value="ltr" />
              <el-option :label="t('prefs.editor.textDirectionRtl')" value="rtl" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('prefs.editor.hideQuickInsert')">
            <el-switch :model-value="prefs.hideQuickInsertHint" @update:model-value="v => prefs.set('hideQuickInsertHint', !!v)" />
          </el-form-item>
          <el-form-item :label="t('prefs.editor.hideLinkPopup')">
            <el-switch :model-value="prefs.hideLinkPopup" @update:model-value="v => prefs.set('hideLinkPopup', !!v)" />
          </el-form-item>
          <el-form-item :label="t('prefs.editor.autoCheck')">
            <el-switch :model-value="prefs.autoCheck" @update:model-value="v => prefs.set('autoCheck', !!v)" />
          </el-form-item>
        </el-form>
      </section>

      <!-- ── Markdown ───────────────────────────────────── -->
      <section
        v-show="active === 'markdown'"
        id="prefs-panel-markdown"
        class="prefs-section"
        role="tabpanel"
        aria-labelledby="prefs-tab-markdown"
        tabindex="0"
      >
        <h3>{{ t('prefs.sections.markdown') }}</h3>
        <p class="prefs-description">{{ copy.markdown }}</p>
        <el-form label-width="220px" label-position="left">
          <h4 class="prefs-subheading">{{ copy.syntax }}</h4>
          <el-form-item :label="t('prefs.markdown.preferLooseListItem')">
            <el-switch :model-value="prefs.preferLooseListItem" @update:model-value="v => prefs.set('preferLooseListItem', !!v)" />
          </el-form-item>
          <el-form-item :label="t('prefs.markdown.bulletListMarker')">
            <el-select
              :model-value="prefs.bulletListMarker"
              style="width: 120px"
              @update:model-value="v => prefs.set('bulletListMarker', v as '-' | '*' | '+')"
            >
              <el-option label="-" value="-" />
              <el-option label="*" value="*" />
              <el-option label="+" value="+" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('prefs.markdown.orderListDelimiter')">
            <el-select
              :model-value="prefs.orderListDelimiter"
              style="width: 120px"
              @update:model-value="v => prefs.set('orderListDelimiter', v as '.' | ')')"
            >
              <el-option label="." value="." />
              <el-option label=")" value=")" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('prefs.markdown.preferHeadingStyle')">
            <el-select
              :model-value="prefs.preferHeadingStyle"
              style="width: 200px"
              @update:model-value="v => prefs.set('preferHeadingStyle', v as 'atx' | 'setext')"
            >
              <el-option :label="t('prefs.markdown.headingAtx')" value="atx" />
              <el-option :label="t('prefs.markdown.headingSetext')" value="setext" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('prefs.markdown.tabSize')">
            <el-input-number
              :model-value="prefs.tabSize"
              :min="1"
              :max="4"
              @update:model-value="v => prefs.set('tabSize', Number(v) as TabSize)"
            />
          </el-form-item>
          <el-form-item :label="t('prefs.markdown.listIndentation')">
            <el-select
              :model-value="prefs.listIndentation"
              style="width: 200px"
              @update:model-value="v => prefs.set('listIndentation', v as ListIndentation)"
            >
              <el-option :label="t('prefs.markdown.listIndentDfm')" value="dfm" />
              <el-option :label="t('prefs.markdown.listIndent1')" :value="1" />
              <el-option :label="t('prefs.markdown.listIndent2')" :value="2" />
              <el-option :label="t('prefs.markdown.listIndent3')" :value="3" />
              <el-option :label="t('prefs.markdown.listIndent4')" :value="4" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('prefs.markdown.frontmatterType')">
            <el-select
              :model-value="prefs.frontmatterType"
              style="width: 200px"
              @update:model-value="v => prefs.set('frontmatterType', v as '-' | '+' | ';' | '{')"
            >
              <el-option :label="t('prefs.markdown.frontmatterYaml')" value="-" />
              <el-option :label="t('prefs.markdown.frontmatterToml')" value="+" />
              <el-option :label="t('prefs.markdown.frontmatterJson')" value="{" />
              <el-option :label="t('prefs.markdown.frontmatterEzhil')" value=";" />
            </el-select>
          </el-form-item>
          <h4 class="prefs-subheading">{{ copy.extensions }}</h4>
          <el-form-item :label="t('prefs.markdown.sequenceTheme')">
            <el-select
              :model-value="prefs.sequenceTheme"
              style="width: 200px"
              @update:model-value="v => prefs.set('sequenceTheme', v as 'hand' | 'simple')"
            >
              <el-option :label="t('prefs.markdown.sequenceHand')" value="hand" />
              <el-option :label="t('prefs.markdown.sequenceSimple')" value="simple" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('prefs.markdown.superSubScript')">
            <el-switch :model-value="prefs.superSubScript" @update:model-value="v => prefs.set('superSubScript', !!v)" />
          </el-form-item>
          <el-form-item :label="t('prefs.markdown.footnote')">
            <el-switch :model-value="prefs.footnote" @update:model-value="v => prefs.set('footnote', !!v)" />
          </el-form-item>
          <el-form-item :label="t('prefs.markdown.isHtmlEnabled')">
            <el-switch :model-value="prefs.isHtmlEnabled" @update:model-value="v => prefs.set('isHtmlEnabled', !!v)" />
          </el-form-item>
          <el-form-item :label="t('prefs.markdown.isGitlabCompatibilityEnabled')">
            <el-switch :model-value="prefs.isGitlabCompatibilityEnabled" @update:model-value="v => prefs.set('isGitlabCompatibilityEnabled', !!v)" />
          </el-form-item>
        </el-form>
      </section>

      <!-- ── Theme ──────────────────────────────────────── -->
      <section
        v-show="active === 'theme'"
        id="prefs-panel-theme"
        class="prefs-section"
        role="tabpanel"
        aria-labelledby="prefs-tab-theme"
        tabindex="0"
      >
        <h3>{{ t('prefs.sections.theme') }}</h3>
        <p class="prefs-description">{{ copy.theme }}</p>
        <h4 class="prefs-subheading">{{ copy.appearance }}</h4>
        <div class="theme-choices" role="group" :aria-label="t('prefs.theme.theme')">
          <button
            v-for="choice in themeChoices"
            :key="choice.id"
            type="button"
            class="theme-choice"
            :class="[`theme-choice-${choice.id}`, { selected: isThemeChoiceSelected(choice.id) }]"
            :aria-pressed="isThemeChoiceSelected(choice.id)"
            :disabled="prefs.saving"
            @click="selectThemeChoice(choice.id)"
          >
            <span class="theme-preview" aria-hidden="true"><span class="theme-preview-sidebar"></span><span class="theme-preview-page"><i></i><i></i><i></i><i></i></span><Monitor v-if="choice.id === 'system'" :size="21" /></span>
            <span class="theme-choice-label">{{ choice.label }}<Check v-if="isThemeChoiceSelected(choice.id)" :size="15" aria-hidden="true" /></span>
          </button>
        </div>
        <h4 class="prefs-subheading">{{ copy.themeOptions }}</h4>
        <el-form label-width="220px" label-position="left">
          <el-form-item :label="t('prefs.theme.theme')">
            <el-select
              :model-value="prefs.theme"
              style="width: 240px"
              :disabled="prefs.autoSwitchTheme === 1"
              @update:model-value="v => prefs.set('theme', v as string)"
            >
              <el-option-group :label="t('prefs.theme.groupBuiltin')">
                <el-option :label="t('prefs.theme.themeLight')" value="light" />
                <el-option :label="t('prefs.theme.themeDark')" value="dark" />
                <el-option :label="t('prefs.theme.themeGithubBlue')" value="github-blue" />
                <el-option :label="t('prefs.theme.themeGraphiteLight')" value="graphite-light" />
                <el-option :label="t('prefs.theme.themeMaterialDark')" value="material-dark" />
                <el-option :label="t('prefs.theme.themeOneDark')" value="one-dark" />
                <el-option :label="t('prefs.theme.themeUlyssesLight')" value="ulysses-light" />
              </el-option-group>
              <el-option-group v-if="userThemes.length" :label="t('prefs.theme.groupUser')">
                <el-option
                  v-for="ut in userThemes"
                  :key="ut.id"
                  :label="ut.name"
                  :value="ut.id"
                />
              </el-option-group>
            </el-select>
            <el-button
              size="small"
              link
              style="margin-left: 12px"
              :loading="themesLoading"
              @click="reloadUserThemes"
            >
              {{ t('prefs.theme.refreshUserThemes') }}
            </el-button>
          </el-form-item>
          <el-form-item :label="t('prefs.theme.autoSwitch')">
            <el-select
              :model-value="prefs.autoSwitchTheme"
              style="width: 240px"
              @update:model-value="v => prefs.set('autoSwitchTheme', Number(v) as AutoSwitchTheme)"
            >
              <el-option :label="t('prefs.theme.autoSwitchFollowOs')" :value="1" />
              <el-option :label="t('prefs.theme.autoSwitchUseSelected')" :value="2" />
            </el-select>
          </el-form-item>
        </el-form>
        <el-alert
          v-if="themeRefreshFailed"
          type="error"
          :closable="false"
          show-icon
        >
          {{ t('prefs.theme.refreshFailed') }}
        </el-alert>
      </section>

      <!-- ── Image ──────────────────────────────────────── -->
      <section
        v-show="active === 'image'"
        id="prefs-panel-image"
        class="prefs-section"
        role="tabpanel"
        aria-labelledby="prefs-tab-image"
        tabindex="0"
      >
        <h3>{{ t('prefs.sections.image') }}</h3>
        <p class="prefs-description">{{ copy.image }}</p>
        <el-form label-width="220px" label-position="left">
          <h4 class="prefs-subheading">{{ copy.imageLocation }}</h4>
          <el-form-item :label="t('prefs.image.insertAction')">
            <el-select
              :model-value="prefs.imageInsertAction"
              style="width: 220px"
              @update:model-value="v => prefs.set('imageInsertAction', v as 'upload' | 'folder' | 'path')"
            >
              <el-option :label="t('prefs.image.insertActionPath')" value="path" />
              <el-option :label="t('prefs.image.insertActionFolder')" value="folder" />
              <el-option :label="t('prefs.image.insertActionUpload')" value="upload" />
            </el-select>
          </el-form-item>
          <el-form-item :label="t('prefs.image.preferRelativeDirectory')">
            <el-switch
              :model-value="prefs.imagePreferRelativeDirectory"
              :disabled="prefs.imageInsertAction !== 'folder'"
              @update:model-value="v => prefs.set('imagePreferRelativeDirectory', !!v)"
            />
          </el-form-item>
          <el-form-item :label="t('prefs.image.relativeDirectoryName')">
            <el-input
              v-model="imageRelativeDirectoryDraft"
              style="width: 220px"
              :disabled="prefs.imageInsertAction !== 'folder' || !prefs.imagePreferRelativeDirectory"
            />
          </el-form-item>
          <el-form-item :label="t('prefs.image.folderAbsolute')">
            <el-input
              v-model="imageFolderPathDraft"
              style="width: 320px"
              :disabled="prefs.imageInsertAction !== 'folder'"
            />
          </el-form-item>
          <h4 class="prefs-subheading">{{ copy.uploading }}</h4>
          <el-form-item :label="t('prefs.image.currentUploader')">
            <el-select
              :model-value="prefs.currentUploader"
              style="width: 220px"
              :disabled="prefs.imageInsertAction !== 'upload'"
              @update:model-value="v => prefs.patchUserData({ currentUploader: v as 'none' | 'github' | 'picgo' | 'script' })"
            >
              <el-option :label="t('prefs.image.uploaderNone')" value="none" />
              <el-option :label="t('prefs.image.uploaderGithub')" value="github" />
              <el-option :label="t('prefs.image.uploaderPicgo')" value="picgo" />
              <el-option :label="t('prefs.image.uploaderScript')" value="script" />
            </el-select>
          </el-form-item>
          <el-form-item v-show="prefs.currentUploader === 'picgo'" :label="t('prefs.image.picgoPath')">
            <el-input
              v-model="picgoPathDraft"
              placeholder="picgo"
              style="width: 320px"
              :disabled="prefs.imageInsertAction !== 'upload'"
            />
          </el-form-item>
          <el-form-item v-show="prefs.currentUploader === 'script'" :label="t('prefs.image.cliScript')">
            <el-input
              v-model="cliScriptDraft"
              placeholder="/path/to/upload.sh"
              style="width: 320px"
              :disabled="prefs.imageInsertAction !== 'upload'"
            />
          </el-form-item>
          <el-form-item v-show="prefs.currentUploader === 'github'" :label="t('prefs.image.githubToken')">
            <el-input
              v-model="githubTokenDraft"
              type="password"
              show-password
              style="width: 320px"
              :disabled="prefs.imageInsertAction !== 'upload'"
            />
            <span class="hint field-hint">{{ t('prefs.image.githubTokenSessionOnly') }}</span>
          </el-form-item>
          <el-form-item v-show="prefs.currentUploader === 'github'" :label="t('prefs.image.githubOwner')">
            <el-input
              v-model="githubOwnerDraft"
              style="width: 220px"
              :disabled="prefs.imageInsertAction !== 'upload'"
            />
          </el-form-item>
          <el-form-item v-show="prefs.currentUploader === 'github'" :label="t('prefs.image.githubRepo')">
            <el-input
              v-model="githubRepoDraft"
              style="width: 220px"
              :disabled="prefs.imageInsertAction !== 'upload'"
            />
          </el-form-item>
          <el-form-item v-show="prefs.currentUploader === 'github'" :label="t('prefs.image.githubBranch')">
            <el-input
              v-model="githubBranchDraft"
              placeholder="main"
              style="width: 220px"
              :disabled="prefs.imageInsertAction !== 'upload'"
            />
          </el-form-item>
        </el-form>
      </section>

      <!-- ── Cloud storage ──────────────────────────────── -->
      <section
        v-show="active === 'cloud'"
        id="prefs-panel-cloud"
        class="prefs-section"
        role="tabpanel"
        aria-labelledby="prefs-tab-cloud"
        tabindex="0"
      >
        <h3>{{ t('prefs.sections.cloud') }}</h3>
        <p class="prefs-description">{{ copy.cloud }}</p>
        <CloudStorageSettings />
      </section>

      <!-- ── Spellchecker ───────────────────────────────── -->
      <section
        v-show="active === 'spellchecker'"
        id="prefs-panel-spellchecker"
        class="prefs-section"
        role="tabpanel"
        aria-labelledby="prefs-tab-spellchecker"
        tabindex="0"
      >
        <h3>{{ t('prefs.sections.spellchecker') }}</h3>
        <p class="prefs-description">{{ copy.spellchecker }}</p>
        <el-form label-width="220px" label-position="left">
          <el-form-item :label="t('prefs.spellchecker.enabled')">
            <el-switch :model-value="prefs.spellcheckerEnabled" @update:model-value="v => prefs.set('spellcheckerEnabled', !!v)" />
          </el-form-item>
          <el-form-item :label="t('prefs.spellchecker.noUnderline')">
            <el-switch
              :model-value="prefs.spellcheckerNoUnderline"
              :disabled="!prefs.spellcheckerEnabled"
              @update:model-value="v => prefs.set('spellcheckerNoUnderline', !!v)"
            />
          </el-form-item>
          <el-form-item :label="t('prefs.spellchecker.language')">
            <div class="input-with-action">
              <el-select
                :model-value="prefs.spellcheckerLanguage"
                :placeholder="t('prefs.spellchecker.languagePlaceholder')"
                :loading="dictionariesLoading"
                :disabled="!prefs.spellcheckerEnabled"
                filterable
                @update:model-value="v => prefs.set('spellcheckerLanguage', String(v))"
              >
                <el-option
                  v-if="currentDictionaryMissing"
                  :label="t('prefs.spellchecker.dictionaryUnavailable', { language: prefs.spellcheckerLanguage })"
                  :value="prefs.spellcheckerLanguage"
                  disabled
                />
                <el-option
                  v-for="language in availableDictionaries"
                  :key="language"
                  :label="language"
                  :value="language"
                />
              </el-select>
              <el-button
                native-type="button"
                :loading="dictionariesLoading"
                @click="reloadDictionaries"
              >
                {{ t('common.refresh') }}
              </el-button>
            </div>
          </el-form-item>
          <el-alert
            v-if="dictionariesLoadFailed"
            type="error"
            :closable="false"
            show-icon
          >
            {{ t('prefs.spellchecker.loadFailed') }}
          </el-alert>
          <el-alert
            v-else-if="!dictionariesLoading"
            :type="availableDictionaries.length ? 'info' : 'warning'"
            :closable="false"
            show-icon
          >
            {{ availableDictionaries.length
              ? t('prefs.spellchecker.infoReady', { count: availableDictionaries.length })
              : t('prefs.spellchecker.infoEmpty') }}
          </el-alert>
        </el-form>
      </section>

      <!-- ── View ───────────────────────────────────────── -->
      <section
        v-show="active === 'view'"
        id="prefs-panel-view"
        class="prefs-section"
        role="tabpanel"
        aria-labelledby="prefs-tab-view"
        tabindex="0"
      >
        <h3>{{ t('prefs.sections.view') }}</h3>
        <p class="prefs-description">{{ copy.view }}</p>
        <el-form label-width="220px" label-position="left">
          <el-form-item :label="t('prefs.view.sidebarVisibility')">
            <el-switch :model-value="prefs.sideBarVisibility" @update:model-value="v => prefs.set('sideBarVisibility', !!v)" />
          </el-form-item>
          <el-form-item :label="t('prefs.view.tabBarVisibility')">
            <el-switch :model-value="prefs.tabBarVisibility" @update:model-value="v => prefs.set('tabBarVisibility', !!v)" />
          </el-form-item>
          <el-form-item :label="t('prefs.view.toolBarVisibility')">
            <el-switch :model-value="prefs.toolBarVisibility" @update:model-value="v => prefs.set('toolBarVisibility', !!v)" />
          </el-form-item>
          <el-form-item :label="t('prefs.view.statusBarVisibility')">
            <el-switch :model-value="prefs.statusBarVisibility" @update:model-value="v => prefs.set('statusBarVisibility', !!v)" />
          </el-form-item>
          <el-form-item :label="t('prefs.view.sourceCodeMode')">
            <el-switch :model-value="prefs.sourceCodeModeEnabled" @update:model-value="v => prefs.set('sourceCodeModeEnabled', !!v)" />
          </el-form-item>
        </el-form>
      </section>

      <!-- ── Search ─────────────────────────────────────── -->
      <section
        v-show="active === 'search'"
        id="prefs-panel-search"
        class="prefs-section"
        role="tabpanel"
        aria-labelledby="prefs-tab-search"
        tabindex="0"
      >
        <h3>{{ t('prefs.sections.search') }}</h3>
        <p class="prefs-description">{{ copy.search }}</p>
        <el-form label-width="220px" label-position="left">
          <el-form-item :label="t('prefs.search.exclusions')">
            <el-input
              v-model="searchExclusionsDraft"
              type="textarea"
              :rows="4"
              placeholder="**/node_modules/**&#10;**/.git/**"
              style="width: 360px"
            />
          </el-form-item>
          <el-form-item :label="t('prefs.search.maxFileSize')">
            <el-input
              v-model="searchMaxFileSizeDraft"
              style="width: 200px"
            />
          </el-form-item>
          <el-form-item :label="t('prefs.search.includeHidden')">
            <el-switch :model-value="prefs.searchIncludeHidden" @update:model-value="v => prefs.set('searchIncludeHidden', !!v)" />
          </el-form-item>
          <el-form-item :label="t('prefs.search.noIgnore')">
            <el-switch :model-value="prefs.searchNoIgnore" @update:model-value="v => prefs.set('searchNoIgnore', !!v)" />
          </el-form-item>
          <el-form-item :label="t('prefs.search.followSymlinks')">
            <el-switch :model-value="prefs.searchFollowSymlinks" @update:model-value="v => prefs.set('searchFollowSymlinks', !!v)" />
          </el-form-item>
        </el-form>
      </section>

      <!-- ── Keybindings ────────────────────────────────── -->
      <section
        v-show="active === 'keybindings'"
        id="prefs-panel-keybindings"
        class="prefs-section"
        role="tabpanel"
        aria-labelledby="prefs-tab-keybindings"
        tabindex="0"
      >
        <h3>{{ t('prefs.sections.keybindings') }}</h3>
        <p class="prefs-description">{{ copy.keybindings }}</p>
        <p class="hint">{{ t('prefs.keybindings.hint') }}</p>
        <div
          class="kb-table-scroll"
          role="region"
          tabindex="0"
          :aria-label="t('prefs.keybindings.tableLabel')"
        >
          <table class="kb-table">
          <thead>
            <tr>
              <th>{{ t('prefs.keybindings.action') }}</th>
              <th>{{ t('prefs.keybindings.shortcut') }}</th>
              <th><span class="sr-only">{{ t('prefs.keybindings.controls') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(accel, id) in keys.map" :key="id">
              <td class="kb-id">
                <span>{{ keybindingActionLabel(id) }}</span>
                <code class="kb-action-id">{{ id }}</code>
              </td>
              <td class="kb-accel">
                <button
                  v-if="editingAccel !== id"
                  type="button"
                  class="kb-button"
                  :disabled="keys.saving"
                  :aria-label="t('prefs.keybindings.editLabel', {
                    action: keybindingActionLabel(id),
                    shortcut: accel ? displayAccelerator(accel, shortcutPlatform) : t('prefs.keybindings.unassigned'),
                  })"
                  @click="startEdit(id)"
                >
                  {{ accel ? displayAccelerator(accel, shortcutPlatform) : '—' }}
                </button>
                <input
                  v-else
                  :id="keybindingInputId(id)"
                  type="text"
                  class="kb-input"
                  autofocus
                  :value="displayAccelerator(recordedAccel, shortcutPlatform)"
                  :placeholder="t('prefs.keybindings.pressKeys')"
                  :aria-label="t('prefs.keybindings.recordLabel', { action: keybindingActionLabel(id) })"
                  :aria-describedby="accelFeedback ? `keybinding-error-${id}` : undefined"
                  :aria-invalid="Boolean(accelFeedback)"
                  readonly
                  @keydown="onAccelKey"
                  @blur="onAccelBlur"
                />
                <span
                  v-if="editingAccel === id && accelFeedback"
                  :id="`keybinding-error-${id}`"
                  class="kb-error"
                  role="alert"
                >
                  {{ accelFeedback }}
                </span>
              </td>
              <td>
                <template v-if="editingAccel === id">
                  <el-button
                    size="small"
                    type="primary"
                    :disabled="!canApplyAccel || keys.saving"
                    @click="applyAccel"
                  >
                    {{ t('common.set') }}
                  </el-button>
                  <el-button size="small" @click="cancelEdit">
                    {{ t('common.cancel') }}
                  </el-button>
                </template>
              </td>
            </tr>
          </tbody>
          </table>
        </div>
        <el-button
          size="small"
          style="margin-top: 16px"
          :disabled="keys.saving || Boolean(editingAccel)"
          @click="resetKeybindings"
        >
          {{ t('prefs.keybindings.resetAll') }}
        </el-button>
        <el-alert
          v-if="keybindingsNotice"
          class="kb-notice"
          :type="keybindingsNotice.type"
          :closable="false"
          show-icon
        >
          {{ keybindingsNotice.text }}
        </el-alert>
      </section>
    </main>
  </div>
</template>

<style scoped>
.prefs-page {
  display: flex;
  height: 100%;
  min-width: 0;
  background: var(--mt-bg, #fdfcf9);
  color: var(--mt-fg, #252923);
  font-family: var(--mt-ui-font, inherit);
}
.prefs-nav {
  display: flex;
  flex-direction: column;
  width: 204px;
  box-sizing: border-box;
  border-right: 1px solid var(--mt-border, #deded5);
  background: var(--mt-sidebar-bg, #f1f0eb);
  padding: 27px 14px 18px;
  flex-shrink: 0;
  overflow: auto;
  scrollbar-gutter: stable;
}
.prefs-brand { display: flex; align-items: center; gap: 9px; padding: 0 12px 18px; color: var(--mt-accent, #3e6250); }
.prefs-title { margin: 0; font-size: 17px; font-weight: 650; letter-spacing: -.02em; color: var(--mt-fg); }
.prefs-nav nav { flex: 1; }
.prefs-nav ul { list-style: none; padding: 0; margin: 0; }
.prefs-nav-group { padding: 22px 12px 9px; color: var(--mt-fg-muted); font-size: 10px; letter-spacing: .08em; font-weight: 600; }
.prefs-nav li:first-child .prefs-nav-group { padding-top: 8px; }
.prefs-nav-button {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 38px;
  box-sizing: border-box;
  border: 1px solid transparent;
  border-radius: 7px;
  padding: 8px 11px;
  margin: 2px 0;
  background: transparent;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  color: var(--mt-fg-muted, #74796e);
  transition: background .14s, color .14s;
}
.prefs-nav-button svg { flex-shrink: 0; }
.prefs-nav-button:hover { background: var(--mt-row-hover, #e9e9e1); color: var(--mt-fg); }
.prefs-nav-button:focus-visible { outline: 2px solid var(--mt-accent, #3e6250); outline-offset: 1px; }
.prefs-nav-button.active { background: var(--mt-accent-soft, #e5ece3); color: var(--mt-accent, #3e6250); font-weight: 600; }
.prefs-nav-note { display: flex; align-items: flex-start; gap: 7px; padding: 26px 10px 0; font-size: 10px; line-height: 1.5; color: var(--mt-fg-muted); }
.prefs-nav-note svg { flex-shrink: 0; margin-top: 1px; color: var(--mt-accent); }
.prefs-body { flex: 1; min-width: 0; box-sizing: border-box; overflow: auto; padding: 38px 44px 48px; scrollbar-gutter: stable; }
.prefs-section { max-width: 780px; margin: 0; }
.prefs-save-status { position: sticky; top: -16px; z-index: 4; max-width: 780px; margin: -16px 0 18px; padding: 8px 0; background: var(--mt-bg); }
.saving-indicator { display: inline-flex; align-items: center; gap: 7px; color: var(--mt-fg-muted); font-size: 12px; }
.saving-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--mt-accent); animation: saving-pulse 1s ease-in-out infinite alternate; }
@keyframes saving-pulse { from { opacity: .35; } to { opacity: 1; } }
.prefs-section:focus-visible { outline: 2px solid var(--mt-accent); outline-offset: 8px; border-radius: 4px; }
.prefs-section h3 { margin: 0; font-size: 27px; line-height: 1.35; font-weight: 620; letter-spacing: -.035em; }
.prefs-description { color: var(--mt-fg-muted); margin: 9px 0 30px; font-size: 13px; line-height: 1.7; }
.prefs-subheading { margin: 30px 0 5px; padding: 0 0 11px; font-size: 12px; font-weight: 650; letter-spacing: .025em; border-bottom: 1px solid var(--mt-border); color: var(--mt-fg); }
.prefs-section :deep(.el-form) > .prefs-subheading:first-child { margin-top: 0; }
.prefs-section :deep(.el-form-item) { margin-bottom: 0; padding: 15px 0; border-bottom: 1px solid color-mix(in srgb, var(--mt-border) 60%, transparent); }
.prefs-section :deep(.el-form-item__label) { line-height: 1.6; align-items: center; height: auto; padding-right: 20px; font-size: 13px; color: var(--mt-fg); }
.prefs-section :deep(.el-form-item__content) { min-width: 0; line-height: 1.6; gap: 5px 0; }
.prefs-section :deep(.el-input), .prefs-section :deep(.el-select), .prefs-section :deep(.el-input-number), .prefs-section :deep(.el-textarea), .prefs-section :deep(.el-slider) { max-width: 100%; }
.prefs-section :deep(.el-alert) { margin-top: 14px; }
.hint { color: var(--mt-fg-muted); font-size: 12px; margin: -12px 0 16px; }
.inline-hint { margin: 0 0 0 12px; display: inline-block; max-width: 300px; line-height: 1.5; }
.field-hint { flex-basis: 100%; margin: 6px 0 0; line-height: 1.5; }
.input-with-action { display: flex; width: min(100%, 460px); min-width: 0; align-items: flex-start; gap: 8px; }
.input-with-action :deep(.el-input), .input-with-action :deep(.el-select) { flex: 1; min-width: 0; }
.theme-choices { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-top: 17px; }
.theme-choice { padding: 8px 8px 10px; border: 1px solid var(--mt-border); border-radius: 10px; color: var(--mt-fg); background: var(--mt-surface-raised, #fff); cursor: pointer; font: inherit; }
.theme-choice:hover { border-color: var(--mt-fg-muted); }
.theme-choice.selected { border-color: var(--mt-accent); box-shadow: 0 0 0 1px var(--mt-accent); }
.theme-choice:focus-visible { outline: 2px solid var(--mt-accent); outline-offset: 4px; }
.theme-choice:disabled { cursor: progress; opacity: .6; }
.theme-choice-label { display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 18px; margin-top: 10px; font-size: 12px; }
.theme-choice.selected .theme-choice-label { color: var(--mt-accent); font-weight: 600; }
.theme-preview { --preview-bg: #fdfcf9; --preview-sidebar: #eeeee7; --preview-line: #b8c0b1; position: relative; display: flex; height: 82px; overflow: hidden; border: 1px solid #deded5; border-radius: 5px; background: var(--preview-bg); }
.theme-choice-dark .theme-preview { --preview-bg: #202321; --preview-sidebar: #191c1a; --preview-line: #718573; border-color: #343b34; }
.theme-preview-sidebar { width: 26%; border-right: 1px solid color-mix(in srgb, var(--preview-line) 30%, transparent); background: var(--preview-sidebar); }
.theme-preview-page { display: flex; flex: 1; flex-direction: column; gap: 5px; padding: 17px 13px; }
.theme-preview-page i { height: 3px; border-radius: 2px; background: var(--preview-line); opacity: .5; }
.theme-preview-page i:first-child { width: 55%; height: 5px; margin-bottom: 5px; opacity: 1; }
.theme-preview-page i:last-child { width: 72%; }
.theme-choice-system .theme-preview { background: linear-gradient(110deg, #fdfcf9 50%, #202321 50%); }
.theme-choice-system .theme-preview-page { opacity: .6; }
.theme-preview > svg { position: absolute; top: 50%; left: 55%; transform: translate(-50%, -50%); padding: 7px; box-sizing: content-box; color: var(--mt-accent); border: 1px solid var(--mt-border); border-radius: 8px; background: var(--mt-surface-raised, #fff); }
.kb-table-scroll { position: relative; box-sizing: border-box; width: 100%; overflow-x: auto; border: 1px solid var(--mt-border); border-radius: 9px; background: var(--mt-surface-raised); }
.kb-table-scroll:focus-visible { outline: 2px solid var(--mt-accent); outline-offset: 2px; }
.kb-table { width: 100%; min-width: 560px; border-collapse: collapse; font-size: 13px; }
.kb-table th, .kb-table td { text-align: left; padding: 12px; border-bottom: 1px solid var(--mt-border); }
.kb-table tr:last-child td { border-bottom: 0; }
.kb-table th { font-weight: 600; color: var(--mt-fg-muted); background: var(--mt-surface, var(--mt-sidebar-bg)); font-size: 10px; letter-spacing: .06em; }
.kb-id { color: var(--mt-fg); font-size: 13px; }
.kb-action-id { display: block; margin-top: 3px; color: var(--mt-fg-muted); font-family: ui-monospace, monospace; font-size: 10px; }
.kb-accel { min-width: 190px; }
.kb-button, .kb-input { font-family: ui-monospace, monospace; font-size: 12px; padding: 6px 10px; border: 1px solid var(--mt-border); border-radius: 5px; background: var(--mt-surface, var(--mt-sidebar-bg)); color: var(--mt-fg); cursor: pointer; min-width: 160px; }
.kb-button:hover { background: var(--mt-row-hover); }
.kb-button:disabled { opacity: .5; cursor: default; }
.kb-button:focus-visible, .kb-input:focus-visible, .icon-choice:focus-visible { outline: 2px solid var(--mt-accent); outline-offset: 2px; }
.kb-input { border-color: var(--mt-accent); background: var(--mt-surface-raised); cursor: text; }
.kb-error { display: block; max-width: 260px; margin-top: 5px; color: var(--el-color-danger); font-size: 11px; line-height: 1.4; }
.kb-notice { margin-top: 12px; }
.icon-choices { display: flex; gap: 10px; flex-wrap: wrap; }
.icon-choice { width: 108px; min-height: 128px; padding: 12px 8px; border: 1px solid var(--mt-border); border-radius: 9px; background: var(--mt-surface-raised); color: var(--mt-fg); cursor: pointer; display: flex; flex-direction: column; align-items: center; gap: 7px; }
.icon-choice:hover { background: var(--mt-row-hover); }
.icon-choice.selected { border-color: var(--mt-accent); box-shadow: 0 0 0 1px var(--mt-accent); background: var(--mt-accent-soft); }
.icon-choice img { width: 58px; height: 58px; object-fit: contain; flex-shrink: 0; }
.icon-choice-title { font-size: 12px; font-weight: 600; line-height: 1.3; }
.icon-choice-desc { font-size: 10px; color: var(--mt-fg-muted); line-height: 1.4; text-align: center; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 1000px) {
  .prefs-nav { width: 190px; padding-left: 10px; padding-right: 10px; }
  .prefs-body { padding: 32px 28px 40px; }
  .prefs-section :deep(.el-form-item__label) { width: 185px !important; }
}
@media (max-width: 760px) {
  .prefs-page { flex-direction: column; }
  .prefs-nav { width: 100%; max-height: 123px; padding: 15px 12px 9px; border-right: 0; border-bottom: 1px solid var(--mt-border); overflow-x: auto; overflow-y: hidden; scrollbar-gutter: auto; }
  .prefs-brand { padding: 0 4px 10px; }
  .prefs-title { font-size: 15px; }
  .prefs-nav ul { display: flex; gap: 4px; min-width: max-content; }
  .prefs-nav-button { width: auto; min-height: 34px; padding: 7px 11px; white-space: nowrap; font-size: 12px; }
  .prefs-nav-group, .prefs-nav-note { display: none; }
  .prefs-body { padding: 25px 24px 32px; }
  .prefs-section h3 { font-size: 24px; }
}
@media (max-width: 620px) {
  .prefs-body { padding: 23px 18px 28px; }
  .prefs-description { margin-bottom: 24px; }
  .prefs-section :deep(.el-form-item) { display: block; padding: 13px 0; }
  .prefs-section :deep(.el-form-item__label) { width: 100% !important; height: auto; margin-bottom: 8px; padding: 0; line-height: 1.4; }
  .prefs-section :deep(.el-form-item__content) { width: 100%; margin-left: 0 !important; }
  .inline-hint { display: block; margin: 6px 0 0; }
  .theme-choices { gap: 9px; }
  .theme-preview { height: 66px; }
  .theme-preview-page { padding: 13px 8px; }
  .theme-choice-label { font-size: 11px; gap: 3px; }
  .kb-table th, .kb-table td { padding: 9px 7px; }
  .kb-action-id { display: none; }
  .kb-button, .kb-input { min-width: 120px; }
  .icon-choice { width: min(108px, calc(50% - 5px)); }
}
@media (prefers-reduced-motion: reduce) { .saving-dot { animation: none; } .prefs-nav-button { transition: none; } }
</style>
