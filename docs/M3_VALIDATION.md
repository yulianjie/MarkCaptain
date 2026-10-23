# M3 E04/E05 实施与验证记录

日期：2026-10-23。版本仍为 0.8.4；基线为 `a5be6a1` 加工作区已有 M0/M1/M2 与本轮 E04/E05 改动。没有提交、打 tag、推送或发布。

状态（E04/E05 当轮验收）：批量输出、合并成册、正式回归及限定范围 Windows 原生/可视验收均已完成。前端单测 517 项、Rust 261 项（另 1 项公网 probe 默认忽略）、浏览器 137 项通过。A07 后续已完成，单独记录于下方关联文档。

## 后续 A07 关联

上述结果和下文证据保留为 E04/E05 当轮验收记录。2026-10-23 后续实施的多文档 Agent 修订另见 [A07 工作流](A07_WORKFLOWS.md) 与 [A07 验证记录](A07_VALIDATION.md)；其整改后全量复跑及原生验收状态独立记录，不能沿用本页的原生成功结论。

## 交付与设计

4 个 `gpt-6-astra` 子 agent 并行开发 Rust/IPC、结构化成册、项目 UI/配置、回归测试；主 agent 统一类型和工作流，集成并执行全量与原生验证。后端与成册另做交叉复核。

- E04：窗口所属项目候选、排除输出目录、有界整体快照、脏缓冲和未命名来源、确定文件名、格式逐项结果、保留旧成品、取消及版本校验后重试。
- E05：显式章节顺序/层级、原来源资源基准、准备后 DOM 合并、标题/脚注/图表命名空间、Markdown/Wiki/别名链接及共享目录。
- 配置：外层 schemaVersion=1 不变，新增可选 projectExport；保留扩展、fingerprint 和实际序列化字节校验。

使用流程、配置字段和明确限制见 [M3 工作流](M3_WORKFLOWS.md)。

## 回归覆盖

| 层次 | 覆盖 |
| --- | --- |
| Rust 生产函数 | 窗口所有权/撤销、路径越界、符号链接及 Windows junction、输出目录排除、候选上限、脏缓冲/磁盘顺序、版本与限额、并发禁止覆盖、格式化配置大小 |
| 工作流/配置单测 | 脏/干净/未命名快照，非法与重名输出，4 MiB 限额，各 await 边界取消，单篇失败，版本变化，成功项不重写，重试出现新警告/恢复渲染后重新审阅，原方案扩展保留 |
| 真实 Vue/渲染器浏览器测试 | 项目入口、选择/排序/持久化/重试，Windows 路径失效，64 份上限；重复 ID A/B/A/B、原生 HTML 标题、跨章/self/引用式链接、重复脚注、不同格式链接与实际 DOM 命名空间 |

审查和测试发现后修复：重试等待期间取消失效、单章渲染失败中断整批、新警告未经确认自动运行、交错重复 ID 碰撞、原生 HTML 标题导致锚点映射错位、未打开章节的资源来源授权遗漏、srcdoc 预览链接点击后导航回应用而使预览空白。测试使用真实状态机、生产 Rust 函数和实际 Vue/渲染模块；浏览器中受控 IPC 不冒充原生文件证据。

## 自动化与原生结果

| 检查 | 当前结果 | 证据 |
| --- | --- | --- |
| 前端单测 | 76 个文件、517 项通过 | `output/m3-unit-navigation-final.log` |
| Rust 库测试 | 261 项通过、1 项公网 probe 默认忽略 | `output/m3-rust-final.log` |
| 浏览器 E2E | 137 项通过，包含真实跨章/自身/脚注及外部链接点击 | `output/m3-e2e-navigation-final.log` |
| 构建 | vue-tsc、生产 Vite、Rust custom-protocol 调试构建通过 | `output/m3-build-navigation-final.log`、`output/m3-native/native-build-navigation-final.log` |
| 静态检查 | ESLint、rustfmt、diff 空白检查通过 | `output/m3-lint-navigation-final.log`、`output/m3-rustfmt.log`、`output/m3-diff-check.log` |
| Windows 原生 | 4 组综合检查全部通过，success=true、pageErrors=[]；另完成人工原生窗口点击与可视检查 | `output/m3-native/run-2026-10-23T06-26-52-973Z/receipt.json`、`native-smoke-navigation-final.log` |
| PDF 内容与显示 | 最终两页已用 pypdf 提取并由 Poppler 渲染检查 | 同一成功 run 内的 `project/exports/native-handbook.pdf`、`pdf-page-1.png`、`pdf-page-2.png` |

原生脚本为 [m3-native-smoke.mjs](../scripts/m3-native-smoke.mjs)，专用标识 `io.github.yulianjie.markcaptain.m3-validation`。测试夹具、输出和诊断位于 `output/m3-native`，脚本拒绝恢复路径落在该目录之外。

原生使用生产前端资源与未优化 Rust 调试构建、真实本地 IPC、文件系统、Pandoc 和 Typst；没有模型或联网依赖。只向测试子进程 PATH 加入已存在的测试工具，不修改系统 PATH。验证过程中会通过 callback Map 延迟一次真实写出结果，以检验“首项实际提交后取消仍保留成功、其余项停止”；不会伪造 Rust 返回值。

锁屏时已停止原生界面操作并等待用户解锁；用户于 2026-10-23 解锁后继续验收。锁屏截图不作为应用 UI 证据。早期失败和脚本诊断记录保留，不计为成功结果。

首轮原生脚本曾在重试仍等待校验时过早读取旧终态，导致 `success=false`；完成等待条件已修正。该轮发现的未打开章节图片授权遗漏已通过成功快照后精确授予现有来源能力解决，不放宽资源路径边界。脚注检查也改为匹配实际生成的 `a.footnote-ref`，避免将测试选择器错误视为产品失败。

原生人工点击进一步发现：srcdoc 中的片段链接会按宿主基准地址导航，清空预览。共享 ExportPreview 现由父层监听点击，片段只滚动至当前文档目标；预览不打开外部目标。iframe 仍不允许脚本，实际导出文件的链接不变。新增真实组件回归点击跨章 Markdown、Wiki 别名、自身标题和脚注，检查滚动位置、`about:srcdoc`、正文保留及没有外部请求/新标签。最终原生脚本也实际点击跨章链接，人工又完成 Beta→Alpha 与 Alpha→Beta 的往返验证。

## Windows 成功验收范围

最终程序为 `output/m3-native/MarkCaptain-M3-Validation-142651.exe`，内嵌 `EditorPage-F7VCCqxn.js`。汇总与 SHA-256 见 `output/m3-native/status.json`。

验收结束后已停止本轮创建的验证程序，没有终止用户日常应用；程序副本和证据保留在测试输出目录。

1. 原生身份、生产协议与最新资源一致；候选只含两篇来源，排除 exports、published 及 build 中的 Markdown。
2. 两份同名 Guide 加一个未命名来源，实际生成六份 HTML/DOCX；冻结中文与 Emoji 脏缓冲区。已有输出保留原字节，一项失败不影响其他五项；重试只补失败项，成功项修改时间不变。
3. 首个文件已实际提交后取消，保留该文件，其他两项停止。随后改动关闭文档的磁盘内容，重试拒绝版本变化，没有继续写出。
4. 按 Beta、Alpha、未命名章节成册；两章同名图片分别取自各自目录，同名标题与脚注保持不同身份。项目配置保留未知扩展与相对顺序，省略未命名正文和标签身份。HTML、PDF、DOCX、ODT、EPUB 五份实际文件均成功，源 Markdown 未被导出流程改写。

DOCX 有两条真实脚注引用及 footnotes.xml，ODT 有两条 text:note，EPUB 有两条 noteref，并保留嵌入图片。PDF 使用既有 Pandoc 3.12.1、Typst 0.15.1；两页的中文、图片、公式、图表与脚注可读，未见截断或重叠。脚注分页与最终布局仍由格式引擎处理，不声称所有阅读器逐像素一致。

## 未包含与限制

- 本页仅记录 E04/E05 当轮证据；A07 分文件审阅与会话原文副本已于后续完成，见 [A07 验证记录](A07_VALIDATION.md)。
- 运行结果保留在当前任务窗口，不声称跨重启后台续跑；准备中取消或无可冻结快照的来源需重新准备。
- 未命名文档不保存到章节配置；原文件导出不触发保存。
- PDF 必须由可用引擎实际生成，未调用系统打印；没有验证系统打印对话框中的保存结果。
- 未验收优化 release、安装器、macOS/Linux 和所有外部阅读器的分页/跨文件锚点行为；本轮不重测 M0 超长 Muya 文档性能。
