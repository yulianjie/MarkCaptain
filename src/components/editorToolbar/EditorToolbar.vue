<script setup lang="ts">
/**
 * Compact editor command bar. All editing commands go through the same bus
 * and Pinia actions as the native menu, so this component does not own editor
 * state or reach into Muya directly.
 *
 * Pointer presses on editing buttons deliberately keep the current editor
 * selection alive. Keyboard activation still follows normal button semantics.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  Focus as Aim, ChevronDown as ArrowDown, PencilLine as EditPen,
  Table as Grid, Link, Ellipsis as MoreFilled, Image as Picture,
  Undo2 as RefreshLeft, Redo2 as RefreshRight, Search,
  Bold, Italic, Strikethrough, Code, List, ListOrdered, ListTodo, Quote, Braces,
  CloudUpload,
} from '@lucide/vue'
import { bus } from '@/bus'
import { useEditorStore } from '@/stores/editor'
import { useKeybindingsStore } from '@/stores/keybindings'
import { usePreferencesStore } from '@/stores/preferences'
import { useProjectStore } from '@/stores/project'
import { useI18n } from '@/i18n'
import {
  displayAccelerator,
  getShortcutDefault,
  isShortcutRemappable,
  shortcutPlatformFromNavigator,
} from '@/common/shortcut-registry'
import CloudUploadDialog from '@/components/cloud/CloudUploadDialog.vue'

type ToolbarMenu = 'paragraph' | 'more'

const editor = useEditorStore()
const keys = useKeybindingsStore()
const prefs = usePreferencesStore()
const project = useProjectStore()
const { locale } = useI18n()
const shortcutPlatform = shortcutPlatformFromNavigator(navigator.platform)

const toolbarCopy = {
  en: {
    toolbar: 'Editor toolbar',
    history: 'History',
    blocks: 'Paragraph styles',
    inline: 'Inline formatting',
    lists: 'Lists',
    paragraphMenu: 'Choose paragraph style',
    more: 'More commands',
    moreFormatting: 'More formatting',
    moreInsert: 'Insert',
    moreView: 'Find and view',
    undo: 'Undo',
    redo: 'Redo',
    paragraph: 'Paragraph',
    heading: 'Heading {level}',
    bold: 'Bold',
    italic: 'Italic',
    strike: 'Strikethrough',
    inlineCode: 'Inline code',
    link: 'Link',
    image: 'Image',
    bulletList: 'Bulleted list',
    orderedList: 'Numbered list',
    taskList: 'Task list',
    quote: 'Block quote',
    codeBlock: 'Code block',
    table: 'Table',
    find: 'Find',
    source: 'Source-code mode',
    focus: 'Focus mode',
    typewriter: 'Typewriter mode',
    uploadCloud: 'Upload this file to cloud storage',
  },
  'zh-CN': {
    toolbar: '编辑器工具栏',
    history: '历史记录',
    blocks: '段落样式',
    inline: '行内格式',
    lists: '列表',
    paragraphMenu: '选择段落样式',
    more: '更多命令',
    moreFormatting: '更多格式',
    moreInsert: '插入',
    moreView: '查找与视图',
    undo: '撤销',
    redo: '重做',
    paragraph: '正文',
    heading: '{level} 级标题',
    bold: '粗体',
    italic: '斜体',
    strike: '删除线',
    inlineCode: '行内代码',
    link: '链接',
    image: '图片',
    bulletList: '无序列表',
    orderedList: '有序列表',
    taskList: '任务列表',
    quote: '引用',
    codeBlock: '代码块',
    table: '表格',
    find: '查找',
    source: '源码模式',
    focus: '专注模式',
    typewriter: '打字机模式',
    uploadCloud: '将此文件上传到云存储',
  },
  ja: {
    toolbar: 'エディターツールバー',
    history: '履歴',
    blocks: '段落スタイル',
    inline: 'インライン書式',
    lists: 'リスト',
    paragraphMenu: '段落スタイルを選択',
    more: 'その他のコマンド',
    moreFormatting: 'その他の書式',
    moreInsert: '挿入',
    moreView: '検索と表示',
    undo: '元に戻す',
    redo: 'やり直す',
    paragraph: '本文',
    heading: '見出し {level}',
    bold: '太字',
    italic: '斜体',
    strike: '取り消し線',
    inlineCode: 'インラインコード',
    link: 'リンク',
    image: '画像',
    bulletList: '箇条書き',
    orderedList: '番号付きリスト',
    taskList: 'タスクリスト',
    quote: '引用',
    codeBlock: 'コードブロック',
    table: '表',
    find: '検索',
    source: 'ソースコードモード',
    focus: '集中モード',
    typewriter: 'タイプライターモード',
    uploadCloud: 'このファイルをクラウドへアップロード',
  },
} as const

const copy = computed(() => toolbarCopy[locale.value] ?? toolbarCopy.en)
const toolbarElement = ref<HTMLElement | null>(null)
const paragraphTrigger = ref<HTMLButtonElement | null>(null)
const moreTrigger = ref<HTMLButtonElement | null>(null)
const menuElement = ref<HTMLElement | null>(null)
const openMenu = ref<ToolbarMenu | null>(null)
const menuPosition = ref({ top: 0, left: 0, maxHeight: 520 })
const cloudUploadOpen = ref(false)

const hasDocument = computed(() => editor.currentFile !== null)
const documentDisabled = computed(() => !hasDocument.value)
const wysiwygDisabled = computed(() => documentDisabled.value || editor.sourceCodeMode)
const singleFileMode = computed(() => hasDocument.value && !project.projectTree)

const paragraphActions = computed(() => [
  { type: 'paragraph', glyph: 'P', label: copy.value.paragraph, actionId: undefined },
  ...Array.from({ length: 6 }, (_, index) => {
    const level = index + 1
    return {
      type: `heading ${level}`,
      glyph: `H${level}`,
      label: copy.value.heading.replace('{level}', String(level)),
      actionId: `paragraph.h${level}`,
    }
  }),
])

const inlineActions = computed(() => [
  { type: 'strong', icon: Bold, label: copy.value.bold, className: 'strong', actionId: 'format.bold' },
  { type: 'em', icon: Italic, label: copy.value.italic, className: 'emphasis', actionId: 'format.italic' },
])

const listActions = computed(() => [
  { type: 'ul-bullet', icon: List, label: copy.value.bulletList },
  { type: 'ol-order', icon: ListOrdered, label: copy.value.orderedList },
])

function shortcutTitle(label: string, actionId?: string): string {
  if (!actionId) return label
  const accelerator = isShortcutRemappable(actionId)
    ? keys.accel(actionId)
    : getShortcutDefault(actionId)
  return accelerator ? `${label} (${displayAccelerator(accelerator, shortcutPlatform)})` : label
}

function emitParagraph(type: string): void {
  if (!wysiwygDisabled.value) bus.emit('paragraph', type)
}

function emitFormat(type: string): void {
  if (!wysiwygDisabled.value) bus.emit('format', type)
}

function formatActive(type: string): boolean {
  return !wysiwygDisabled.value && editor.currentSelectionFormats.includes(type)
}

function undo(): void {
  if (!documentDisabled.value) bus.emit('undo', undefined)
}

function redo(): void {
  if (!documentDisabled.value) bus.emit('redo', undefined)
}

function insertTable(): void {
  if (!wysiwygDisabled.value) bus.emit('show-table-dialog', undefined)
}

function showFind(): void {
  if (hasDocument.value) bus.emit('request-find-replace', { mode: 'find' })
}

function toggleSource(): void {
  if (hasDocument.value) editor.toggleSourceCode()
}

function toggleViewMode(mode: 'focus' | 'typewriter'): void {
  prefs.toggleViewMode(mode)
}

function menuTrigger(menu: ToolbarMenu): HTMLButtonElement | null {
  return menu === 'paragraph' ? paragraphTrigger.value : moreTrigger.value
}

function positionMenu(menu: ToolbarMenu): void {
  const trigger = menuTrigger(menu)
  if (!trigger) return
  const rect = trigger.getBoundingClientRect()
  const menuWidth = menu === 'paragraph' ? 210 : 232
  menuPosition.value = {
    top: rect.bottom + 5,
    left: Math.min(Math.max(8, rect.left), window.innerWidth - menuWidth - 8),
    maxHeight: Math.min(520, Math.max(80, window.innerHeight - rect.bottom - 13)),
  }
}

function visibleMenuItems(): HTMLButtonElement[] {
  if (!menuElement.value) return []
  return Array.from(menuElement.value.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]'))
    .filter(item => !item.disabled && item.offsetParent !== null)
}

function focusMenuItem(index: number): void {
  const items = visibleMenuItems()
  if (!items.length) return
  items[(index + items.length) % items.length]?.focus()
}

async function openToolbarMenu(menu: ToolbarMenu, focusFirst = false): Promise<void> {
  if (menu === 'paragraph' && wysiwygDisabled.value) return
  positionMenu(menu)
  openMenu.value = menu
  await nextTick()
  if (focusFirst) focusMenuItem(0)
}

function closeToolbarMenu(restoreTrigger = false): void {
  const menu = openMenu.value
  openMenu.value = null
  if (restoreTrigger && menu) nextTick(() => menuTrigger(menu)?.focus())
}

function toggleToolbarMenu(menu: ToolbarMenu, event: MouseEvent): void {
  if (openMenu.value === menu) {
    closeToolbarMenu(event.detail === 0)
    return
  }
  void openToolbarMenu(menu, event.detail === 0)
}

function runMenuAction(action: () => void, event: MouseEvent): void {
  action()
  closeToolbarMenu(event.detail === 0)
}

function onMenuKeydown(event: KeyboardEvent): void {
  const items = visibleMenuItems()
  const index = items.indexOf(event.target as HTMLButtonElement)
  if (event.key === 'Escape') {
    event.preventDefault()
    closeToolbarMenu(true)
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    focusMenuItem(index + 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    focusMenuItem(index - 1)
  } else if (event.key === 'Home') {
    event.preventDefault()
    focusMenuItem(0)
  } else if (event.key === 'End') {
    event.preventDefault()
    focusMenuItem(items.length - 1)
  }
}

function onDocumentPointerDown(event: MouseEvent): void {
  const target = event.target as Node
  if (toolbarElement.value?.contains(target) || menuElement.value?.contains(target)) return
  closeToolbarMenu()
}

function onWindowResize(): void {
  closeToolbarMenu()
}

onMounted(() => {
  document.addEventListener('mousedown', onDocumentPointerDown)
  window.addEventListener('resize', onWindowResize)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocumentPointerDown)
  window.removeEventListener('resize', onWindowResize)
})
</script>

<template>
  <nav
    ref="toolbarElement"
    class="editor-toolbar"
    role="toolbar"
    aria-orientation="horizontal"
    :aria-label="copy.toolbar"
    @keydown.esc="closeToolbarMenu(true)"
  >
    <div class="toolbar-scroll">
      <div class="toolbar-content">
        <div class="toolbar-group" role="group" :aria-label="copy.history">
          <button
            type="button"
            class="tool-button"
            data-action="undo"
            :disabled="documentDisabled"
            :aria-label="copy.undo"
            :title="shortcutTitle(copy.undo, 'edit.undo')"
            @mousedown.prevent
            @click="undo"
          >
            <el-icon><RefreshLeft /></el-icon>
          </button>
          <button
            type="button"
            class="tool-button compact-collapsible"
            data-action="redo"
            :disabled="documentDisabled"
            :aria-label="copy.redo"
            :title="shortcutTitle(copy.redo, 'edit.redo')"
            @mousedown.prevent
            @click="redo"
          >
            <el-icon><RefreshRight /></el-icon>
          </button>
        </div>

        <div class="toolbar-divider" aria-hidden="true" />

        <div class="toolbar-group" role="group" :aria-label="copy.blocks">
          <button
            ref="paragraphTrigger"
            type="button"
            class="tool-button paragraph-trigger"
            data-action="paragraph-menu"
            :disabled="wysiwygDisabled"
            :aria-label="copy.paragraphMenu"
            :aria-expanded="openMenu === 'paragraph'"
            aria-haspopup="menu"
            :title="copy.paragraphMenu"
            @mousedown.prevent
            @click="toggleToolbarMenu('paragraph', $event)"
            @keydown.down.prevent="openToolbarMenu('paragraph', true)"
          >
            <span class="paragraph-label">{{ copy.paragraph }}</span>
            <el-icon class="trigger-chevron" aria-hidden="true"><ArrowDown /></el-icon>
          </button>
        </div>

        <div class="toolbar-divider" aria-hidden="true" />

        <div class="toolbar-group" role="group" :aria-label="copy.inline">
          <button
            v-for="action in inlineActions"
            :key="action.type"
            type="button"
            class="tool-button text-button"
            :class="[action.className, { active: formatActive(action.type) }]"
            :data-action="`format:${action.type}`"
            :disabled="wysiwygDisabled"
            :aria-label="action.label"
            :aria-pressed="formatActive(action.type)"
            :title="shortcutTitle(action.label, action.actionId)"
            @mousedown.prevent
            @click="emitFormat(action.type)"
          >
            <component :is="action.icon" aria-hidden="true" />
          </button>
          <button
            v-for="action in [
              { type: 'del', icon: Strikethrough, label: copy.strike, className: 'strike', actionId: 'format.strikethrough' },
              { type: 'inline_code', icon: Code, label: copy.inlineCode, className: 'code', actionId: 'format.inlineCode' },
            ]"
            :key="action.type"
            type="button"
            class="tool-button text-button toolbar-expanded-action"
            :class="[action.className, { active: formatActive(action.type) }]"
            :data-action="`format:${action.type}`"
            :disabled="wysiwygDisabled"
            :aria-label="action.label"
            :aria-pressed="formatActive(action.type)"
            :title="shortcutTitle(action.label, action.actionId)"
            @mousedown.prevent
            @click="emitFormat(action.type)"
          >
            <component :is="action.icon" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="tool-button"
            :class="{ active: formatActive('link') }"
            data-action="format:link"
            :disabled="wysiwygDisabled"
            :aria-label="copy.link"
            :aria-pressed="formatActive('link')"
            :title="shortcutTitle(copy.link, 'format.link')"
            @mousedown.prevent
            @click="emitFormat('link')"
          >
            <el-icon><Link /></el-icon>
          </button>
        </div>

        <div class="toolbar-divider compact-collapsible" aria-hidden="true" />

        <div class="toolbar-group compact-collapsible" role="group" :aria-label="copy.lists">
          <button
            v-for="action in listActions"
            :key="action.type"
            type="button"
            class="tool-button text-button"
            :data-action="`paragraph:${action.type}`"
            :disabled="wysiwygDisabled"
            :aria-label="action.label"
            :title="action.label"
            @mousedown.prevent
            @click="emitParagraph(action.type)"
          >
            <component :is="action.icon" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="tool-button text-button toolbar-expanded-action"
            data-action="paragraph:ul-task"
            :disabled="wysiwygDisabled"
            :aria-label="copy.taskList"
            :title="copy.taskList"
            @mousedown.prevent
            @click="emitParagraph('ul-task')"
          >
            <ListTodo aria-hidden="true" />
          </button>
        </div>

        <div class="toolbar-divider toolbar-expanded-action" aria-hidden="true" />

        <div class="toolbar-group toolbar-expanded-action" role="group" :aria-label="copy.moreInsert">
          <button
            v-for="action in [
              { type: 'blockquote', icon: Quote, label: copy.quote },
              { type: 'pre', icon: Braces, label: copy.codeBlock },
            ]"
            :key="action.type"
            type="button"
            class="tool-button text-button"
            :data-action="`paragraph:${action.type}`"
            :disabled="wysiwygDisabled"
            :aria-label="action.label"
            :title="action.label"
            @mousedown.prevent
            @click="emitParagraph(action.type)"
          >
            <component :is="action.icon" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="tool-button"
            data-action="format:image"
            :disabled="wysiwygDisabled"
            :aria-label="copy.image"
            :title="shortcutTitle(copy.image, 'format.image')"
            @mousedown.prevent
            @click="emitFormat('image')"
          >
            <el-icon><Picture /></el-icon>
          </button>
          <button
            type="button"
            class="tool-button"
            data-action="insert-table"
            :disabled="wysiwygDisabled"
            :aria-label="copy.table"
            :title="copy.table"
            @mousedown.prevent
            @click="insertTable"
          >
            <el-icon><Grid /></el-icon>
          </button>
        </div>

        <div class="toolbar-divider" aria-hidden="true" />

        <div class="toolbar-group" role="group" :aria-label="copy.moreView">
          <button
            v-if="singleFileMode"
            type="button"
            class="tool-button"
            data-action="cloud-upload"
            :aria-label="copy.uploadCloud"
            :title="copy.uploadCloud"
            @click="cloudUploadOpen = true"
          >
            <CloudUpload aria-hidden="true" />
          </button>
          <button
            type="button"
            class="tool-button toolbar-find"
            data-action="find"
            :disabled="!hasDocument"
            :aria-label="copy.find"
            :title="shortcutTitle(copy.find, 'edit.find')"
            @mousedown.prevent
            @click="showFind"
          >
            <el-icon><Search /></el-icon>
          </button>
          <button
            ref="moreTrigger"
            type="button"
            class="tool-button more-trigger"
            data-action="more-menu"
            :aria-label="copy.more"
            :aria-expanded="openMenu === 'more'"
            aria-haspopup="menu"
            :title="copy.more"
            @mousedown.prevent
            @click="toggleToolbarMenu('more', $event)"
            @keydown.down.prevent="openToolbarMenu('more', true)"
          >
            <el-icon><MoreFilled /></el-icon>
          </button>
        </div>
      </div>
    </div>
  </nav>

  <Teleport to="body">
    <div
      v-if="openMenu"
      ref="menuElement"
      class="toolbar-menu"
      :class="`toolbar-menu-${openMenu}`"
      role="menu"
      :aria-label="openMenu === 'paragraph' ? copy.paragraphMenu : copy.more"
      :style="{ top: `${menuPosition.top}px`, left: `${menuPosition.left}px`, maxHeight: `${menuPosition.maxHeight}px` }"
      @mousedown.prevent
      @keydown="onMenuKeydown"
    >
      <template v-if="openMenu === 'paragraph'">
        <button
          v-for="action in paragraphActions"
          :key="action.type"
          type="button"
          class="menu-item"
          role="menuitem"
          :data-action="`paragraph:${action.type}`"
          :title="shortcutTitle(action.label, action.actionId)"
          @click="runMenuAction(() => emitParagraph(action.type), $event)"
        >
          <span class="menu-glyph" aria-hidden="true">{{ action.glyph }}</span>
          <span>{{ action.label }}</span>
        </button>
      </template>

      <template v-else>
        <div class="menu-section-label" role="presentation">{{ copy.moreFormatting }}</div>
        <button
          type="button"
          class="menu-item compact-menu-action"
          role="menuitem"
          :disabled="documentDisabled"
          data-action="redo"
          @click="runMenuAction(redo, $event)"
        >
          <el-icon><RefreshRight /></el-icon><span>{{ copy.redo }}</span>
        </button>
        <button
          type="button"
          class="menu-item"
          :class="{ active: formatActive('del') }"
          role="menuitemcheckbox"
          :aria-checked="formatActive('del')"
          :disabled="wysiwygDisabled"
          data-action="format:del"
          @click="runMenuAction(() => emitFormat('del'), $event)"
        >
          <Strikethrough aria-hidden="true" /><span>{{ copy.strike }}</span>
        </button>
        <button
          type="button"
          class="menu-item"
          :class="{ active: formatActive('inline_code') }"
          role="menuitemcheckbox"
          :aria-checked="formatActive('inline_code')"
          :disabled="wysiwygDisabled"
          data-action="format:inline_code"
          @click="runMenuAction(() => emitFormat('inline_code'), $event)"
        >
          <Code aria-hidden="true" /><span>{{ copy.inlineCode }}</span>
        </button>
        <button
          v-for="action in listActions"
          :key="`compact-${action.type}`"
          type="button"
          class="menu-item compact-menu-action"
          role="menuitem"
          :disabled="wysiwygDisabled"
          :data-action="`paragraph:${action.type}`"
          @click="runMenuAction(() => emitParagraph(action.type), $event)"
        >
          <component :is="action.icon" aria-hidden="true" /><span>{{ action.label }}</span>
        </button>

        <div class="menu-separator" role="separator" />
        <div class="menu-section-label" role="presentation">{{ copy.moreInsert }}</div>
        <button
          type="button"
          class="menu-item"
          role="menuitem"
          :disabled="wysiwygDisabled"
          data-action="format:image"
          :title="shortcutTitle(copy.image, 'format.image')"
          @click="runMenuAction(() => emitFormat('image'), $event)"
        >
          <el-icon><Picture /></el-icon><span>{{ copy.image }}</span>
        </button>
        <button
          v-for="action in [
            { type: 'ul-task', icon: ListTodo, label: copy.taskList },
            { type: 'blockquote', icon: Quote, label: copy.quote },
            { type: 'pre', icon: Braces, label: copy.codeBlock },
          ]"
          :key="action.type"
          type="button"
          class="menu-item"
          role="menuitem"
          :disabled="wysiwygDisabled"
          :data-action="`paragraph:${action.type}`"
          @click="runMenuAction(() => emitParagraph(action.type), $event)"
        >
          <component :is="action.icon" aria-hidden="true" /><span>{{ action.label }}</span>
        </button>
        <button
          type="button"
          class="menu-item"
          role="menuitem"
          :disabled="wysiwygDisabled"
          data-action="insert-table"
          @click="runMenuAction(insertTable, $event)"
        >
          <el-icon><Grid /></el-icon><span>{{ copy.table }}</span>
        </button>

        <div class="menu-separator" role="separator" />
        <div class="menu-section-label" role="presentation">{{ copy.moreView }}</div>
        <button
          type="button"
          class="menu-item compact-menu-action"
          role="menuitem"
          :disabled="!hasDocument"
          data-action="find"
          @click="runMenuAction(showFind, $event)"
        >
          <el-icon><Search /></el-icon><span>{{ copy.find }}</span>
        </button>
        <button
          type="button"
          class="menu-item"
          :class="{ active: editor.sourceCodeMode }"
          role="menuitemcheckbox"
          :aria-checked="editor.sourceCodeMode"
          :disabled="!hasDocument"
          data-action="toggle-source"
          @click="runMenuAction(toggleSource, $event)"
        >
          <Code aria-hidden="true" /><span>{{ copy.source }}</span>
        </button>
        <button
          type="button"
          class="menu-item"
          :class="{ active: prefs.focus }"
          role="menuitemcheckbox"
          :aria-checked="prefs.focus"
          data-action="toggle-focus"
          @click="runMenuAction(() => toggleViewMode('focus'), $event)"
        >
          <el-icon><Aim /></el-icon><span>{{ copy.focus }}</span>
        </button>
        <button
          type="button"
          class="menu-item"
          :class="{ active: prefs.typewriter }"
          role="menuitemcheckbox"
          :aria-checked="prefs.typewriter"
          data-action="toggle-typewriter"
          @click="runMenuAction(() => toggleViewMode('typewriter'), $event)"
        >
          <el-icon><EditPen /></el-icon><span>{{ copy.typewriter }}</span>
        </button>
      </template>
    </div>
  </Teleport>
  <CloudUploadDialog v-model="cloudUploadOpen" />
</template>

<style scoped>
.editor-toolbar {
  box-sizing: border-box;
  container-type: inline-size;
  flex: 0 0 auto;
  min-width: 0;
  height: 38px;
  color: var(--mt-fg-muted, #586069);
  background: var(--mt-bg, #fff);
  border-bottom: 1px solid var(--mt-border, #e1e4e8);
  user-select: none;
}

.toolbar-scroll {
  width: 100%;
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.toolbar-scroll::-webkit-scrollbar { display: none; }

.toolbar-content {
  display: flex;
  align-items: center;
  gap: 3px;
  width: max-content;
  min-width: 100%;
  height: 100%;
  padding: 0 20px;
  box-sizing: border-box;
  justify-content: flex-start;
}

.toolbar-group {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  flex: 0 0 auto;
}

/* Only the search/more group consumes spare space, never the editing groups. */
.toolbar-group:last-child { margin-inline-start: auto; position: sticky; right: 0; background: var(--mt-bg); }

.toolbar-divider {
  width: 1px;
  height: 18px;
  margin: 0 2px;
  flex: 0 0 auto;
  background: var(--mt-border, #dfe2e5);
}

.tool-button {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 29px;
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--mt-radius-control);
  color: inherit;
  background: transparent;
  font: inherit;
  cursor: pointer;
  transition: color 120ms ease, background-color 120ms ease, border-color 120ms ease;
}

.tool-button:hover:not(:disabled),
.tool-button[aria-expanded="true"] {
  color: var(--mt-fg, #24292e);
  background: var(--mt-row-hover, #f1f3f5);
}

.tool-button.active,
.menu-item.active {
  color: var(--mt-accent, #0366d6);
  background: color-mix(in srgb, var(--mt-accent, #0366d6) 12%, transparent);
  border-color: color-mix(in srgb, var(--mt-accent, #0366d6) 30%, transparent);
}

.tool-button :deep(svg), .menu-item :deep(svg) {
  width: 16px;
  height: 16px;
  stroke-width: 1.6;
  flex-shrink: 0;
}
.trigger-chevron :deep(svg) { width: 12px; height: 12px; }

.tool-button:focus-visible {
  outline: 2px solid var(--mt-accent, #0366d6);
  outline-offset: 1px;
}

.menu-item:focus-visible {
  outline: 2px solid var(--mt-accent, #0366d6);
  outline-offset: 1px;
}

.tool-button:disabled,
.menu-item:disabled {
  opacity: 0.38;
  cursor: default;
}

.text-button {
  width: 27px;
  font-size: 13px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.text-button.strong { font-weight: 800; }
.text-button.emphasis { font-family: Georgia, 'Times New Roman', serif; font-style: italic; }
.text-button.strike { text-decoration: line-through; }
.text-button.code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 10px;
  letter-spacing: -0.08em;
}

.paragraph-trigger {
  justify-content: flex-start;
  width: auto;
  min-width: 88px;
  padding: 0 6px;
  gap: 7px;
}

.paragraph-label {
  max-width: 76px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.trigger-chevron {
  width: 12px;
  margin-left: auto;
  font-size: 11px;
}

.toolbar-menu {
  position: fixed;
  z-index: 4000;
  display: flex;
  flex-direction: column;
  width: 210px;
  max-height: min(520px, calc(100vh - 56px));
  padding: 5px;
  overflow-y: auto;
  box-sizing: border-box;
  color: var(--mt-fg, #24292e);
  background: var(--mt-surface-raised, var(--mt-bg));
  border: 1px solid var(--mt-border, #dfe2e5);
  border-radius: var(--mt-radius-menu);
  box-shadow: var(--mt-shadow-panel, 0 10px 28px rgb(0 0 0 / 16%));
  user-select: none;
}

.toolbar-menu-more { width: 232px; }

.menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 32px;
  padding: 5px 9px;
  border: 1px solid transparent;
  border-radius: 6px;
  color: inherit;
  background: transparent;
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.menu-item:hover:not(:disabled) { background: var(--mt-row-hover, #f1f3f5); }
.menu-item > :deep(svg),
.menu-item > .el-icon,
.menu-glyph { width: 22px; flex: 0 0 22px; text-align: center; }
.menu-glyph { font-weight: 650; }
.menu-glyph.strike { text-decoration: line-through; }
.menu-glyph.code {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 10px;
  letter-spacing: -0.08em;
}

.menu-section-label {
  padding: 6px 9px 3px;
  color: var(--mt-fg-muted, #6a737d);
  font-size: 10px;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.menu-separator {
  height: 1px;
  margin: 5px 4px;
  background: var(--mt-border, #dfe2e5);
}

.compact-menu-action { display: flex; }

@container (max-width: 699px) {
  .tool-button { width: 25px; }
  .paragraph-trigger { width: auto; min-width: 76px; }
  .toolbar-content { gap: 2px; padding-inline: 5px; }
  .toolbar-divider { margin-inline: 1px; }
}

/* Preserve all controls at normal widths; More retains every folded action. */
@container (max-width: 599px) {
  .toolbar-expanded-action { display: none; }
}

@container (max-width: 419px) {
  .compact-collapsible { display: none; }
  .paragraph-trigger { min-width: 64px; }
  .paragraph-label { max-width: 50px; }
  .toolbar-content { gap: 2px; padding-inline: 6px; }
  .toolbar-divider { margin-inline: 1px; }
}

@container (max-width: 390px) {
  .paragraph-trigger { min-width: 56px; padding-inline: 5px; }
  .paragraph-label { max-width: 36px; }
  .toolbar-divider { display: none; }
}

@media (forced-colors: active) {
  .tool-button.active,
  .menu-item.active { border-color: Highlight; }
  .toolbar-divider,
  .menu-separator { background: CanvasText; }
  .toolbar-menu { border-color: CanvasText; }
}
</style>
