# 日常笔记 / Everyday notes

这些功能使用当前打开的项目，保留普通 Markdown 文件，不给写作 Agent 增加文件访问权限。打开文件夹后，使用左侧“笔记”图标或 `Ctrl/Cmd+Shift+P` 命令面板。

## 入口

| 功能 | 入口 | 默认快捷键 |
| --- | --- | --- |
| 快速打开笔记 | 文件菜单、命令面板、笔记侧栏搜索按钮 | `Ctrl/Cmd+K` |
| 今日笔记 | 文件菜单、命令面板 | `Ctrl/Cmd+Alt+D` |
| 插入文档模板 | 文件菜单、命令面板 | `Ctrl/Cmd+Alt+T` |
| 模板／每日笔记配置 | 笔记项目设置 | 命令面板 |
| 分屏 | 左右分屏 / 上下分屏 / 关闭区域 | 命令面板 |
| 命名布局 | 保存的布局 | 命令面板 |
| 历史 | 本地历史版本 | 命令面板 |
| 引用回滚 | 恢复上次引用更新事务 | 命令面板 |

前三个快捷键可在现有快捷键设置中修改。快速打开按文件名、相对路径、YAML 别名进行模糊搜索，方向键选择、Enter 打开标签，已有标签会复用。空查询显示最近使用的笔记。结果显示完整相对路径以区别同名文件。无精确匹配时点击“创建”建立 `.md` 文件，不覆盖已有文件。

## 模板与每日笔记

项目设置位于 `.markcaptain/notes.json`。默认模板目录 `Templates`、每日目录 `Daily`、日期格式 `YYYY-MM-DD`。可选择项目模板或会议记录、读书笔记、工作日志示例。目录必须在项目内，不允许绝对路径、盘符、`..` 或逃逸项目的符号链接。

变量：<code>&#123;&#123;title&#125;&#125;</code>、<code>&#123;&#123;date&#125;&#125;</code>、<code>&#123;&#123;time&#125;&#125;</code>、<code>&#123;&#123;date:YYYY/MM/DD&#125;&#125;</code>，按本机日历及 Day.js 基础格式展开。模板插入当前活动区域的光标位置，可以撤销。今日笔记不存在时用指定模板独占创建；已存在时直接打开，保留已有内容及未保存缓冲区。文档模板与 Agent 的 `SKILL.md` 分别管理。

## 分屏与布局

最多四个区域，整个布局按左右或上下方向排列。区域下拉框独立选文档；点击区域切换活动区域。拖动分隔线调整大小，或聚焦分隔线后按方向键调整。关闭区域不关闭文档标签，不丢弃修改。

同一文件共享内容、脏状态和保存队列，光标与显示模式属于各区域。分屏文档使用共享撤销序列，连续输入分组，Agent 应用、属性、任务、模板插入为独立步骤。Agent 的文档、选区、定位和应用目标跟随活动区域；保留附加上下文、快照校验及审阅机制。

命名布局保存路径、区域方向、大小、活动区域、模式及各区域的光标／选区，可保存、恢复、删除多套。布局只存轻量位置，不保存文档正文或 CodeMirror 历史；越界或拆开 UTF-16 字符的位置会被丢弃。命名布局中的未命名文档没有持久路径，恢复时使用当前文档。常规会话及崩溃草稿仍由原机制恢复，不因恢复布局被覆盖；删除文件留下的区域不会被错绑到另一文档。个人布局存于 WebView 本地存储，命名布局按项目区分。

## 独立本地历史

已保存为文件的 Markdown 文档在打开、保存及定时检查内容变化时记录快照。默认间隔 60 秒、期限 30 天、总空间 256 MiB，可在历史窗口调整。正文按 SHA-256 内容寻址去重；列表只加载元数据，选择版本后读取正文并校验哈希。

历史窗口提供时间、当前／旧正文、差异、复制、恢复为新文档、恢复当前文档。恢复当前文档前先保留尚未保存的内容，通过编辑事务替换，可撤销，仍需正常保存。活动文档变化或外部冲突时拒绝恢复。

历史在本机应用数据目录的 `local-history`，独立于 Agent 对话、崩溃草稿及远端版本，不需要网络。未命名文档保存为文件后启用历史；此前由崩溃草稿保护。历史按文件路径归档，移动后旧版本保留在旧路径归档；当前界面仅列出现存活动路径的历史，没有浏览移除路径归档的入口。超过期限／空间上限会清理旧版本；历史不能代替项目备份。单个快照正文上限 4 MiB；超限或存储失败会提示并继续正常文件保存。恢复当前文档时仍必须成功记录恢复前快照，才会替换内容。强制保护会校验去重正文，损坏或缺失时修复，失败则拒绝恢复。

## 链接、反向链接与引用维护

支持 `[[笔记]]`、`[[目录/笔记]]`、`[[笔记|显示文字]]`、`[[笔记#标题]]`、`[[#当前标题]]`。标准 Markdown 内部链接及引用式链接的目标定义使用同一索引。源码和可视化编辑器均提供 `[[` 补全。`Ctrl/Cmd+点击` 跳转，或使用笔记侧栏当前文档的链接列表。不存在的目标经创建提示后建立文件。

Markdown 链接可用无扩展名路径指向现有 Markdown 笔记；不存在的无扩展名目标可创建为 `.md`。带其他扩展名的本地目标（例如 PDF）不会伪装成笔记创建，点击时会提示该链接不是 Markdown 笔记。

短名称优先匹配引用文件所在目录，仍有歧义时要求完整路径。别名来自 YAML `aliases` 字符串或字符串列表。反向链接显示引用文件、上下文并定位；未链接提及排除已链接文字和代码，歧义名称不任意归属。

文件树重命名／剪切移动及项目内标签重命名前，预览引用文件与歧义。保留显式显示文字、标题锚点、编码、BOM 和换行；移动源文档也重新计算其 Markdown 相对路径。先保存或关闭项目内修改的标签，解决外部冲突。操作期间暂时阻止编辑并延迟文件监视事件。

事务在确认后暂停编辑、等待在途保存完成，再核对完整 Markdown 文件清单和磁盘 SHA-256；文件增删或变化会要求重新预览。写入失败尝试回滚并报告事务 ID。原始字节保存在应用数据目录 `reference-transactions/<ID>.json`。“恢复上次引用更新事务”再次检查文件，拒绝覆盖后续变更，保留备份供手工恢复；成功后立即同步打开文档的路径与正文。引用备份不受历史清理策略影响。外部编辑器移动／重命名会更新索引，但不会自动改写引用。

## 标签、属性、搜索与任务

笔记侧栏下拉框切换链接、标签、属性、结构化搜索、任务。正文 `#标签` 与 YAML `tags` 合并统计；`work/team` 同时归入父级 `work`，每个文档只计一次。点击标签筛选。

属性支持文本、字符串列表、数字、布尔值、日期。只替换选中的 YAML 值或添加字段，保留其他原始内容、注释和未知数据。嵌套对象、自定义 YAML 标签、锚点、多行文本，以及含空项、首尾空白或换行项的列表在源码中编辑；无效 YAML 拒绝修改。保存相同值保留原始格式。改动使用正常撤销、保存，并更新索引。

```text
name:"Weekly sync" path:会议
tag:work prop.priority:>=2 NOT task:done
tag:reading OR tag:research
-tag:archive task:open
```

空格／`AND` 表示同时满足，`OR`（或独立 `|`）连接条件组，`NOT`／字段前 `-` 排除。AND 优先于 OR，不支持括号。字段：`name:`（含别名）、`path:`、`tag:`（含子标签）、`prop.属性名:`（相等，数字可用 `> >= < <=`）、`task:open|done|any`。含空格的值加双引号。普通词搜索代码之外的正文；语法错误明确显示。原有全文／正则搜索保留在“搜索”侧栏。

任务汇总真正的未完成 Markdown 任务，排除代码示例。点击文字定位，勾选通过活动编辑器修改 `[ ]`，可撤销；磁盘写入沿用正常保存／自动保存。结果与任务最多显示 1000 条。

## 范围与限制

仅扫描已打开项目，忽略符号链接及 `.git`、`.markcaptain`、`node_modules`、`target`。扫描在 Rust 工作线程，可取消；读取分批执行，解析和结构化搜索在 Web Worker 中执行。文件监视触发增量重读；重建索引丢弃缓存。未保存的已打开项目文档覆盖磁盘内容参与索引。

单文件索引正文最大 4 MiB，项目正文总上限 128 MiB，引用事务原始／新正文总上限 64 MiB。无法读取、解码失败或超限的条目显示原因，文件名仍可搜索；索引不完整时拒绝引用更新。索引可重建，不是用户数据的唯一副本。

## English

Open a project folder and use **Notes** or the command palette. `Ctrl/Cmd+K` searches names, paths and aliases; empty input shows recent notes. `Ctrl/Cmd+Alt+T` inserts a document template; `Ctrl/Cmd+Alt+D` opens today's note without overwriting existing content. Project settings are in `.markcaptain/notes.json`; Agent skills remain separate.

Split right/down creates independent regions with shared document content and saves. Resize separators and save named personal layouts. Layouts preserve paths, sizes, modes, each region's caret/selection and the active region; they do not replace session or crash drafts. Invalid positions are discarded. Unsaved files in named layouts use the current document when restored. Agent edits follow the active region and remain reviewed.

Local history is separate from Agent/cloud history. Defaults: 60 seconds, 30 days, 256 MiB. Compare, copy and restore versions; restoration verifies a protection snapshot of unsaved content and remains undoable. Save untitled notes first. Archives are path-based: old-path versions remain after moves, but the current UI has no entry to browse archives for removed paths.

Wiki links, headings and Markdown links share a code-aware index. Extensionless Markdown targets resolve against note stems and can create a `.md` note when missing; targets with other extensions are not created as notes. Ctrl/Cmd-click navigates; ambiguous names require full paths. App moves/renames preview recoverable reference updates; save dirty project tabs first. The commit drains in-flight saves and checks the complete Markdown path/hash manifest. Restoration refuses to overwrite later changes and synchronizes open tabs immediately. External moves update the index but do not rewrite references.

Tags include hashtags and YAML tags. Properties preserve unknown YAML; edit complex fields, multiline text and lists with empty, padded or multiline items in source. Saving an unchanged value preserves its original formatting. Queries use `name:`, `path:`, `tag:`, `prop.key:`, `task:open|done|any`, AND, OR and NOT. Quote values containing spaces. Tasks use normal editing, undo and save; regex/full-text search remains separate.

Limits: four regions, 4 MiB per indexed file/history body, 128 MiB project text, 64 MiB reference transaction, 1000 displayed results. Unreadable index entries are reported and prevent automatic rewrites. This adds no Agent file permission or cloud dependency.

## 日本語

プロジェクトを開き、「ノート」またはコマンドパレットを使います。`Ctrl/Cmd+K` は名前・相対パス・別名を検索、`Ctrl/Cmd+Alt+T` はテンプレートを挿入、`Ctrl/Cmd+Alt+D` は今日のノートを開きます。既存内容は上書きしません。設定は `.markcaptain/notes.json`、個人レイアウトは WebView ローカルストレージに保存されます。

分割領域は文書内容と保存状態を共有し、カーソルと表示モードを個別管理します。Agent はアクティブ領域の添付文書を使用し、確認後に変更を適用します。ローカル履歴は Agent／クラウドとは別で、復元前に未保存内容を保管し、元に戻せます。未命名文書は先に保存してください。

レイアウトは各領域のカーソル／選択範囲も保存します。本文と CodeMirror の履歴は含みません。範囲外の位置は破棄され、削除された文書の領域を別文書に誤って割り当てません。

履歴はパス単位の保存です。移動後も旧パスの履歴は残りますが、現在の画面には削除されたパスの履歴を開く入口がありません。参照更新は進行中の保存を待ち、Markdown ファイル一覧とハッシュを検証します。復元後は開いている文書のパスと内容をすぐに同期します。

パネルでリンク、タグ、プロパティ、構造化検索、タスクを切り替えます。`[[パス/ノート#見出し|表示文字]]` と Markdown 内部リンクを索引します。Markdown の拡張子なしリンクはノート名で解決し、見つからない場合は `.md` ノートを作成できます。PDF など Markdown 以外の拡張子はノートとして作成しません。曖昧な名前は完全なパスで指定します。移動前に未保存文書と外部変更を解決してください。参照更新はバックアップを持ち、後続の変更を上書きする復元を拒否します。

未知の YAML は保持されます。複雑な値、複数行の文字列、空項目・前後の空白・改行を含むリストはソースで編集します。同じ値の保存では元の書式を保持します。検索例：`tag:work prop.priority:>=2 NOT task:done`。コードのリンク／タグ／タスクは対象外です。上限：四領域、1 ファイル 4 MiB、本文索引 128 MiB、参照更新 64 MiB、表示 1000 件。外部移動は索引を更新しますが参照を書き換えません。
