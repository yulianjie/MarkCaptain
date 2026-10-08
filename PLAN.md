# markcaptain 后续工作计划

## 已完成（按 commit 顺序）

- **ff1529e** Initial Tauri 2 + Vue 3 + Rust 脚手架，含 28 个 `#[tauri::command]`、84 IPC 映射文档、Muya 5 项兼容补丁、debug-bridge
- **608e9bf** Phase 3 — 8 个 Pinia stores（取代 12 Vuex 模块），10 个 Vue 3 组件（TitleBar/TabsBar/MuyaEditor/SideBar/TreePane/TreeRow/TocPane/CommandPalette/AboutDialog/EditorPage 拼装）
- **c1659b2** Phase 4 — 完整原生菜单（7 组 47 项含快捷键）、源码模式 textarea、查找替换栏、侧栏全局搜索、Rename/Recent 弹窗、拖放打开、HTML/PDF 导出雏形
- **ddb71fd** Phase 5 — 接通菜单 Paragraph/Format/Undo/Redo 到 Muya、完整 HTML 导出（Muya getSanitizeHtml + 嵌入 CSS）、HTML5 拖拽 tab 重排、CodeMirror 6 源码模式
- **本次（Phase 6 主体）** — 完整 Preferences 多分区表单（General/Editor/Markdown/Theme/Image/Spellchecker/View/Search）、主题系统（CSS vars + light/dark/material-dark/one-dark/graphite-light/ulysses-light + autoSwitchTheme OS 跟随）、实时应用 zoom/font/line-width 到编辑器、Typewriter/Focus 模式、Always-on-Top/Fullscreen 菜单、PDF 通过 OS 打印对话框（emit mt://export/print 由前端 window.print()）、CLI 文件参数启动开文件 + single-instance 转发、Rust 端 set_preference/set_user_data 广播 mt://prefs/changed 给所有窗口
- **73d1921** Phase 7 — i18n（en + zh-CN 自建 ~40 LOC，无额外依赖），ESLint v9 flat config 修复 `npm run lint`，Muya `imageAction` 三模式（path/folder/upload）路由 + 走 prefs 配置，preferences.ts 类型修复
- **本次（Phase 8）** — 用户主题加载器（`~/<config>/markcaptain/themes/*.css` 自动列出 + 注入），全局右键菜单（Tab + 文件树菜单项），多窗口菜单/启动事件路由到聚焦窗口，键位重映射 UI（Preferences 中录入 + 持久化 + 运行时解析），Pandoc 子进程导出 docx/odt/epub，Playwright E2E 配置 + smoke 用例，GitHub Actions CI（release.yml 跨四平台 + ci.yml 前端 + Rust 检查），auto-updater 配置 stub + docs/UPDATER.md

## Phase 9 — 后续

## Phase 5 — 完成（保留作为施工记录）

### 1. 接通菜单 Paragraph / Format → Muya 实际 API

**现状**：Rust 菜单点击发 `mt://menu/action`，EditorPage 把 `paragraph.*` / `format.*` 转成 bus 事件 `paragraph` / `format`，但**没有消费方**。Muya 本身有方法叫 `updateParagraph(type)` 和 `format(type)`，要在 `MuyaEditor.vue` 里订阅这两个 bus 事件并调用 Muya 实例方法。

**改动**：
- [src/components/editorWithTabs/MuyaEditor.vue](src/components/editorWithTabs/MuyaEditor.vue) 在 onMounted 里订阅 `bus.on('paragraph', ...)` 和 `bus.on('format', ...)`，转发到 `muyaRef.value.updateParagraph(type)` / `muyaRef.value.format(type)`
- 同时支持 Undo / Redo / Copy as HTML / Copy as Markdown / Paste as Plain — 这些菜单项也调 Muya 内部方法。原版 `editor.vue` 的 mounted 钩子里有完整的 bus 订阅清单，按图施工。

**验收**：从 Format 菜单点 "Bold"，光标处选中的文字会被 `**...**` 包围。

### 2. 完整 HTML 导出（Muya `getSanitizeHtml`）

**现状**：EditorPage 的 `doExportHtml` 用 `<pre>` 包了一下原始 markdown，等同于没做。

**改动**：
- 改成调 Muya 的 `getSanitizeHtml(markdown, opts)`（来自 `muya/lib/utils/exportHtml.js`，里面已经处理 KaTeX/Mermaid/Prism/`?inline` CSS 拼接）
- 把它包到 `services/muya-export.ts` 里以便测试和复用
- HTML 头里加 `<style>` 嵌入 githubMarkdown/exportStyle/prism/katex CSS（这些都是 `?inline` 字符串，已经能拿到）
- 文件名默认 `{filename}.html`

**验收**：导出后用浏览器打开，标题/代码高亮/数学公式应该都渲染正常。

### 3. 标签拖拽重排

**现状**：原版用 dragula。我们已经在 editor store 实现了 `exchangeTabs(fromIndex, toIndex)`，但 UI 没有触发。

**改动**：
- [TabsBar.vue](src/components/editorWithTabs/TabsBar.vue) 用 HTML5 原生 `draggable="true"` + `@dragstart` / `@dragover` / `@drop` 实现，不引入 dragula 依赖。
- 拖动时显示 placeholder/indicator，drop 后调 `editor.exchangeTabs(from, to)`

**验收**：能用鼠标拖动 tab 调换顺序，松手后顺序持久（直到关闭窗口）。

### 4. CodeMirror 6 替换源码模式 textarea

**现状**：[SourceCodePane.vue](src/components/editorWithTabs/SourceCodePane.vue) 是 monospace textarea，没有语法高亮、行号、折叠。

**改动**：
- 装依赖：`@codemirror/state`、`@codemirror/view`、`@codemirror/lang-markdown`、`@codemirror/commands`、`@codemirror/language`、`@codemirror/theme-one-dark`（约 200 KB）
- 改造 SourceCodePane 用 `EditorView` 替代 textarea，markdown 语言扩展提供 `#` heading / fence code 等高亮
- 编辑事件通过 `EditorView.updateListener` 转发到 `editor.setMarkdownExternal`
- 切 tab 时 `EditorView.dispatch` 替换 doc 而不是销毁重建

**验收**：源码模式下能看到 markdown 语法着色 + 行号。

### 5. 提交

`git commit -m "Phase 5: ..."`

## Phase 9 — 后续

| 项目 | 工作量估 | 备注 |
|---|---|---|
| 拼写检查（Hunspell/spellbook + dic 文件） | 2-3 天 | 用户明确推迟到最后 |
| Tauri-driver 接入 Playwright（真二进制 E2E） | 1 天 | 现 e2e 只测 dev server，未拉起 .exe |
| 完整 Muya 工具栏（粘贴格式按钮 UI 触发） | 0.5 天 | FormatPicker 已自动浮窗，但工具栏入口缺图标 |
| 打包签名 / macOS notarize / Windows code signing | 1 天 | release.yml 已就绪，缺签名密钥 |

## 执行顺序

Phase 5～8 已合入。拼写检查留作最后压轴。其余按列表优先级挑选。

---

## Bugfix（进行中）— 首次输入 `## hi` 不解析为 H2

### 现象

新建（Untitled）标签页首次点入编辑器输入 `## hi`，**不转换为 H2 标题**，停留在 paragraph。全选删除后重输则正常变 H2。后续输入也都正常。

### 既试无效的方案

1. `muya.focus()` 挂载后立刻调用（[MuyaEditor.vue:118](src/components/editorWithTabs/MuyaEditor.vue#L118)）。
2. 给空 `paragraphContent`/`atxLine` span 注入 `<br>` 占位（[renderLeafBlock.js:118-124](src/muya/lib/parser/render/renderBlock/renderLeafBlock.js#L118)）。

两者都在治症状，没动根因。

### 根因（与上游 Electron 实现对照）

参照上游 `src/renderer/components/editorWithTabs/editor.vue`：

1. **空文档种子差异。** 原版 `markdown: ''`（从 `getBlankFileState` 来），我们 [MuyaEditor.vue:74](src/components/editorWithTabs/MuyaEditor.vue#L74) 用了 `'\n'` 作为 workaround。原版用 `''` 不崩，说明所谓"空输入崩溃"是别的 bug 的症状（极可能是下面的 race），不是真的需要这个 seed。

2. **双重挂载 race（致命）。** 我们的 [MuyaEditor.vue](src/components/editorWithTabs/MuyaEditor.vue) 同时有两条路径调 `mount()`：
   - [line 199](src/components/editorWithTabs/MuyaEditor.vue#L199) `onMounted` 里直接 `await mount(...)`
   - [line 124-137](src/components/editorWithTabs/MuyaEditor.vue#L124) `watch(currentFileId, ...)` 也调 `mount(...)`

   `onMounted` 同步执行 `editor.bootstrap()` 把 `currentFileId.value` 从 null 写成 file.id —— Vue 把 watcher 入队成 microtask。然后 `await mount(...)` 在 `await loadMuya()` 处让出控制权，microtask 队列跑 watcher，此时 `muyaRef.value` 还没赋值（第一次 mount 还在 await 中），watcher 也走进 mount 分支再调一次 `mount(...)`。两次 mount 交错跑 destroy / new Muya / setMuyaInstance，最终 DOM 处于半构造状态：用户点入空 span 时插入符落在 `<p>` 外面，第一个 `#` 写到 Muya 追踪不到的位置，`inputHandler` 读到的 `block.text` 仍是 `""`，`checkInlineUpdate` 永远拿不到 `##` → 不触发 heading 转换。

   全选删除时，`backspaceCtrl` 用 `setCursor` 把光标重新放回 span 内部 → 之后重输就正常。

   上游实现没有这个 race —— Muya 在 `created() { $nextTick(...) }` 里只 new 一次，**永不 destroy/recreate**；切 tab / 加载文件走 bus 事件 → `setMarkdownToEditor` → `editor.setMarkdown(markdown, cursor, true)`（上游 `editor.vue:1096-1106`）。

### 修复方案 — 镜像原版架构

把 [MuyaEditor.vue](src/components/editorWithTabs/MuyaEditor.vue) 改成"一个 Muya 实例 + setMarkdown 切内容"：

1. **拆分 `mount()` 为 `construct()` 和 `loadFile(tab)` 两步。**
   - `construct()`：`onMounted` 里只调一次。`new Muya(..., { markdown: '', ...})`，**移除 `'\n'` seed**，**移除 `muya.focus()`**。
   - `loadFile(tab)`：`muyaRef.value.clearHistory()` → `muyaRef.value.setMarkdown(tab.markdown, tab.cursor, true)`，更新 `activeBoundId`。

2. **`change` 事件闭包改成动态读取 tab id。**
   原代码闭包捕获了 mount 时的 `id`，单实例下会把所有 tab 的修改都写到第一个 tab。改成：
   ```ts
   muya.on('change', (changes) => {
     const id = editor.currentFileId
     if (!id) return
     editor.applyContentChange(id, changes.markdown, { ... })
   })
   ```
   对应上游 `id: 'muya'` placeholder + Vuex 解析当前 tab 的做法（上游 `editor.vue:596-599`）。

3. **`watch(currentFileId)` 只调 `loadFile`，不调 `mount`。**
   `if (activeBoundId.value !== id) loadFile(tab)`。彻底消除 race。

4. **回滚 [renderLeafBlock.js:118-124](src/muya/lib/parser/render/renderBlock/renderLeafBlock.js#L118) 的 `<br>` 占位**。原版没有，架构修好后也用不到。

5. **`onBeforeUnmount`** destroy 这一个 Muya 实例（已经在做了，保留）。

### 不在本次范围

- 切 tab 时保留每 tab 的 history（上游 `editor.vue:1109-1124` 有 `setHistory` 链路，但需要在 store 里加 history 持久化字段，先放后面）。

### 验证

1. `npm run tauri:build`（旧 `markcaptain.exe` 要先关掉，否则 cargo 链接失败）。
2. 跑出来的二进制：打开 Untitled tab，点入编辑器，**立即**输入 `## hi` → 期望出现 H2。
3. 同位置 `### sub` → H3；新行 `- bullet` → 列表；`**bold**` → 行内粗体。
4. 打开一个已有 md 文件，编辑一个字符，切回 Untitled tab → 内容互不丢失。
5. 打开两个文件，tab 间切换 → 每个 tab 内容正确保留。
6. 输入 → Ctrl+Z → Ctrl+Y → undo/redo 仍工作。
7. `npm run test:unit`、`npm run test:e2e` 不引入 regression。

3-6 全部通过且 7 无回归即视为修复完成。
