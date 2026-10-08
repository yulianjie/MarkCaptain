# MarkCaptain Tauri 移植对比审计（distance）

> 对比 `C:\Users\jack\Desktop\github\markcaptain`（原版 Electron） vs. 本仓库（Tauri 2 + Vue 3 + Rust 移植版），按"完全缺失 / 部分迁移 / 编辑体验差异"三类盘点距离 feature parity 的距离。

## 总览

| 维度 | 进度 |
|---|---|
| Rust 后端命令 | 27 个已实现（覆盖 ≈ 80% IPC 通道） |
| Vue 3 前端骨架 | EditorPage / PreferencesPage / 10 个 Pinia store 已搭好 |
| Muya 内核 | 保持原样，13 个插件、23 个构造选项均已对齐 |
| 偏好 → Muya 同步 | 21 / 24 watcher 到位 |
| i18n | en / zh-CN / ja 三语 |
| 关键短板 | 拼写检查、PDF 导出、命令面板入口、内置主题、PicGo 图床、标题栏统计、表格对话框 |

整体可视为约 90% 命令层迁移完成，但**外围 UI 与系统级特性**还有 20+ 项尚未补齐。

---

## A. 完全未迁移（用户感知最强的缺口）

### A1. 拼写检查（Spellchecker）
- **原版**：Electron 原生拼写器 + 自定义词典（add/remove）+ 多语言切换 + 右键候选词替换 + 可选关闭波浪线。
- **现状**：[src/services/spellchecker.ts](src/services/spellchecker.ts) 全部 stub，`setEnabled / setLanguage / replaceMisspelling / addWord / removeWord` 均 no-op；只剩浏览器 contenteditable 自带的 OS 级拼写。
- **影响**：核心写作功能缺失，需 Hunspell 集成 + 词典 bundling。

### A2. PicGo / 自定义脚本图床
- **原版**：3 个上传后端 — PicGo（命令行）、GitHub（保留）、自定义 CLI 脚本。
- **现状**：[src-tauri/src/commands/mod.rs](src-tauri/src/commands/mod.rs) 只有 `cmd_upload_image_github` 与 `cmd_search_unsplash`，PicGo 与脚本两条路径缺失。

### A3. 命令面板入口（Command Palette）
- **原版**：`Ctrl+Shift+P` 触发，模糊命令搜索，菜单中有专门入口。
- **现状**：[src/components/commandPalette/](src/components/commandPalette/) 组件存在，但**原生菜单未挂入口、全局快捷键未注册**，功能等于半埋。

### A4. Pandoc PDF 导出 + 导出设置对话框
- **原版**：`pandoc` 子进程导出 PDF / styled HTML，弹窗可配置纸张/方向/主题。
- **现状**：
  - `cmd_export_pdf` 改用 `window.print()`（前端打印对话框），**不是真正的 Pandoc 导出**。
  - `cmd_pandoc_convert` 命令在但前端 UI 没接。
  - **缺失整套导出设置对话框**（参考原版 `src/renderer/components/exportSettings/`）。

### A5. 内置主题数量
- **原版**：8 个内置主题（dark / light / one-dark / material-dark / ulysses / graphite / glass / macos / minimalist）。
- **现状**：[src/muya/themes/](src/muya/themes/) 主要只有 `default.css` + 新增的 prism light/dark；**绝大多数主题 CSS 还没移植**，导致主题选项可能有名无实。

### A6. 主题菜单（Theme menu）
- **原版**：原生菜单有独立 "Theme" 顶级菜单，列出全部主题。
- **现状**：[src-tauri/src/menu/mod.rs](src-tauri/src/menu/mod.rs) 仅有 File/Edit/Paragraph/Format/View/Window/Help，**没有 Theme 菜单**。

### A7. 截图工具
- **原版**：`screen-capture` IPC，输出到 `screenshotFolderPath`。
- **现状**：未实现（CLAUDE.md / IPC_MAP.md 标 TBD）。

### A8. 自动更新 UI
- **原版**：`electron-updater` + 菜单"检查更新" + 下载完成后 Quit & Install 提示。
- **现状**：`tauri-plugin-updater` 已注册（[src-tauri/src/lib.rs](src-tauri/src/lib.rs)），但**前端没有任何检查入口、进度或重启 UI**，菜单未挂动作。

### A9. 项目级配置
- **上游实现**：工作目录根的项目配置文件可覆盖全局偏好；打开文件夹时自动检测。
- **现状**：未实现，所有偏好走 [src-tauri/src/preferences/store.rs](src-tauri/src/preferences/store.rs) 全局单 store。

### A10. 键盘布局识别（native-keymap）
- **原版**：`native-keymap` 探测物理键码 → 字符映射，解决跨布局快捷键。
- **现状**：未迁移；自定义键绑定 store 在，但**不识别用户键盘布局**，非 US-QWERTY 用户的快捷键会退化。

### A11. macOS dock 菜单 / 第二实例文件路由
- **原版**：`dock.js` 模板 + `app.on('open-file')` / `second-instance` 将文件路由到现有窗口。
- **现状**：`single-instance` 插件已启用，但 [src-tauri/src/cli.rs](src-tauri/src/cli.rs) / [src-tauri/src/app.rs](src-tauri/src/app.rs) 的路由比原版简化，**dock 菜单（macOS 特有）未实现**。

### A12. 双栏视图（Two-column view）
- **原版**：CSS 切换的左编辑右预览。
- **现状**：未实现；只有 source / typewriter / focus 三模式。

---

## B. 部分迁移（有但简化或半残）

### B1. 标题栏多统计 + 面包屑
- **原版**：tooltip 同时显示 words / characters / paragraphs，并提供路径面包屑。
- **现状** [src/components/titleBar/TitleBar.vue](src/components/titleBar/TitleBar.vue)：只显示文件名 + dirty 点 + 单一字数；无面包屑、无多统计 tooltip。

### B2. 表格插入对话框
- **原版**：行/列数 spinner 的 `el-dialog`。
- **现状**：依赖 Muya 自带 quick-insert，**独立对话框缺失**，菜单"插入表格"动作未必有弹窗。

### B3. 图片插入路径模板变量
- **原版**：`${filename}` / `${fileBasenameNoExtension}` / `${fileWorkspaceFolder}` / `${relativeFileDirname}` 全部展开。
- **现状** [src/services/muya-image-action.ts](src/services/muya-image-action.ts) L51-54：只简单父目录解析，**模板变量未实现**。

### B4. 剪贴板文件路径检测
- **原版**：`clipboardFilePath()` 在粘贴时识别 Finder/Explorer 复制的文件引用。
- **现状**：`muya-image-action.ts:70` 返回空字符串，**未接通**。

### B5. 偏好 Watcher 数量
- **原版**：24 个 watcher 同步到 Muya。
- **现状** [src/services/muya-preferences-applier.ts](src/services/muya-preferences-applier.ts)：21 个；缺 `spellcheckerLanguage`、`editorLineWidth`（CSS 宽度类）、部分 markdown 扩展项。

### B6. 用户主题热重载
- **上游实现**：`mt::reload-user-themes` 监视用户主题目录，改动即时生效。
- **现状**：[src-tauri/src/commands/mod.rs](src-tauri/src/commands/mod.rs) 有 `cmd_list_themes` / `cmd_read_theme_css`，但**没有用户主题目录的文件监视**。

### B7. 最近打开（Open Recent）
- **原版**：File → Open Recent 子菜单（动态生成）+ `mt::add-recently-used-document` 写 OS-level recent。
- **现状**：`AppState` 有 `recent_files / recent_folders` 字段，但**菜单中 Open Recent 子菜单未生成**、OS recent docs 未注册。

### B8. 搜索选项是否真生效
- **原版**：`searchExclusions / searchMaxFileSize / searchIncludeHidden / searchNoIgnore / searchFollowSymlinks` 全部传给 ripgrep。
- **现状**：`cmd_search_in_folder` 用 `grep + ignore` crate，**偏好 schema 中保留了这些键，但是否真传到 grep 调用需要 verify**。

### B9. 自动保存定时器
- **原版**：`autoSaveDelay` 毫秒级控制 + 菜单"Auto Save"勾选。
- **现状**：偏好 store 有 `autoSave / autoSaveDelay`，但**前端 debounced save 定时器需要 verify**（[src/stores/editor.ts](src/stores/editor.ts)）。

---

## C. 编辑体验不一致（能用但手感不同）

### C1. 标签页拖拽
- 原版用 `dragula` 库 + 边缘自动滚动；移植用 HTML5 native drag — **长标签条不能边缘滚动**。

### C2. Find / Replace 位置
- 原版：嵌入编辑器顶部，跟随滚动。
- 移植 [src/components/search/FindReplaceBar.vue](src/components/search/FindReplaceBar.vue)：浮于右上 absolute。属主观差异。

### C3. 拼写右键替换
- 原版：错词右键菜单显示候选词。
- 移植：因 spellchecker stub，**右键无候选词**，仅浏览器默认菜单。

### C4. 拖拽视觉反馈
- 移植版 [src/pages/EditorPage.vue](src/pages/EditorPage.vue) L244-260 增加了 "Drop to open" 蒙层 —— **优于原版**，不算问题。

### C5. 自定义键绑定
- 原版：`keybindings.json` 用户手编 + Electron menu accelerator。
- 移植：[src/stores/keybindings.ts](src/stores/keybindings.ts) 实现自定义键绑定 store；架构上**改进**，但需要保证原版 keybindings.json 格式兼容（用户迁移）。

### C6. 偏好"默认编码"长列表
- 原版编辑器面板支持 30+ 编码（utf8 / utf16 / cp1252 / ascii / ...）。
- 移植 [src/pages/PreferencesPage.vue](src/pages/PreferencesPage.vue)：需 verify 下拉项是否完整。

### C7. 状态栏 / 行尾符显示
- 原版：title bar 显示文件状态（行尾符、字数）。
- 移植 title bar 简化更多，导致用户难一眼看到行尾符、光标位置。

### C8. 命令行参数
- 原版：`--debug / --safe / --new-window / --disable-gpu / --disable-spellcheck / --user-data-dir / --verbose` 等丰富。
- 移植 [src-tauri/src/cli.rs](src-tauri/src/cli.rs)：相对简化，需 verify 哪些 flag 已支持。

---

## D. 优先级建议

| 优先级 | 缺口 | 工时（人日） | 备注 |
|---|---|---|---|
| **P0** | A1 拼写检查（Hunspell + 词典） | 5-8 | 用户感知最强 |
| **P0** | A3 命令面板入口 + 全局快捷键 | 1-2 | 组件已在，仅挂入口 |
| **P0** | A4 Pandoc PDF + 导出设置对话框 | 3-5 | 命令已在，补 UI |
| **P0** | A5+A6 主题菜单 + 8 内置主题 CSS | 2-3 | 大部分是 CSS 复制 |
| **P1** | B1 标题栏多统计 + 面包屑 | 1-2 | 视觉一致 |
| **P1** | B2 表格插入对话框 | 1 | el-dialog 复制 |
| **P1** | A2 PicGo / 自定义脚本图床 | 2-3 | 命令行调用 + 配置 UI |
| **P1** | B7 Open Recent 子菜单 + OS recent | 1-2 | AppState 已有数据 |
| **P1** | A8 自动更新 UI 入口 + 进度 | 2 | 插件已注册 |
| **P1** | B5 偏好 watcher 补 3 项 | 0.5 | 一次性差异修复 |
| **P2** | B3 图片路径模板变量 | 1 | `${filename}` 等 |
| **P2** | B4 剪贴板文件路径检测 | 1 | 平台相关 |
| **P2** | A9 项目级 `markcaptain.json` 覆盖 | 1-2 | 文件加载 + merge |
| **P2** | B6 用户主题目录监视 | 1 | notify 监视 + 事件 |
| **P2** | A7 截图工具 | 2 | 平台特定 API |
| **P3** | A10 键盘布局识别替代 | 2-3 | 用 tauri-plugin-os 或第三方 |
| **P3** | A12 双栏视图模式 | 1 | CSS 切换 |
| **P3** | A11 macOS dock 菜单 | 1 | 平台特定 |
| **P3** | C1 标签拖拽自动滚动 | 1 | 换支持滚动的拖拽库 |

---

## E. 切入点索引

**Rust 侧新增**
- 拼写检查：新建 `src-tauri/src/spellcheck/`（Hunspell + 词典 bundle）
- 图床扩展：[src-tauri/src/commands/mod.rs](src-tauri/src/commands/mod.rs) 加 `cmd_upload_image_picgo` / `cmd_upload_image_script`
- 主题热重载：[src-tauri/src/filesystem/watcher.rs](src-tauri/src/filesystem/watcher.rs) 加用户主题目录订阅
- 项目级偏好：[src-tauri/src/preferences/store.rs](src-tauri/src/preferences/store.rs) 加 per-workspace overlay
- Theme 顶级菜单：[src-tauri/src/menu/mod.rs](src-tauri/src/menu/mod.rs)

**前端补**
- 命令面板入口：[src/components/commandPalette/](src/components/commandPalette/) + [src/pages/EditorPage.vue](src/pages/EditorPage.vue) 全局快捷键
- 标题栏：[src/components/titleBar/TitleBar.vue](src/components/titleBar/TitleBar.vue) 加多统计 + 面包屑
- 导出对话框：新建 `src/components/exportSettings/`
- 图片动作：[src/services/muya-image-action.ts](src/services/muya-image-action.ts) 补模板与剪贴板
- 偏好 watcher：[src/services/muya-preferences-applier.ts](src/services/muya-preferences-applier.ts) 补 3 项
- 主题 CSS：从原版 `src/renderer/assets/themes/` 拷到 [src/muya/themes/](src/muya/themes/)
- 自动更新 UI：[src/pages/PreferencesPage.vue](src/pages/PreferencesPage.vue) 或 Help 菜单

**原版对照参考**
- 拼写：`upstream/src/renderer/spellchecker/index.js`
- 命令面板：`upstream/src/renderer/components/commandPalette/index.vue`
- 标题栏：`upstream/src/renderer/components/titleBar/index.vue`
- 图片动作：`upstream/src/renderer/components/editorWithTabs/editor.vue` L684-800
- 导出对话框：`upstream/src/renderer/components/exportSettings/`
- 主题 CSS：`upstream/src/renderer/assets/themes/*.theme.css`

---

## F. Verification 方法

本审计**不修改代码**，仅出具对比报告。如逐项补齐：

1. 在原版 Electron 中实操记录基线
2. 在 `npm run tauri:dev` 中重现同操作
3. 关键路径（拼写、导出、图床、命令面板）补 Playwright 用例到 [tests/](tests/)
4. 偏好同步改动用 `npm run test:unit`（Pinia store 单测）
5. 主题 / UI 视觉差异用 light + dark 双套截图对比
