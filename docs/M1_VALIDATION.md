# M0/M1 实施与验证记录

2026-10-23 补充：统一导出与审阅的后续问题已纳入 [14 项审查整改记录](M2_REVIEW_FIXES.md)，最新回归、Windows 原生与 Pandoc 输出结果以该记录为准。本文保留 M0/M1 阶段的历史基线。

更新日期：2026-10-22

应用版本：0.8.4

源码基线：`a5be6a1`，本次实施留在工作区，未提交或发布。

状态：M0/M1 已实施并完成本报告范围内的 Windows 原生验收。M2/M3 尚未开展；性能与平台限制见下文。

本文记录目前有日志或 receipt 支持的验证结果。M1 工作流说明见 [README/M1_WORKFLOWS](M1_WORKFLOWS.md)，方案和后续范围见 [实施方案](LOCAL_DOCUMENT_AGENT_EXPORT_PLAN.md)，M0 的样例、脚本和早期基线见 [M0 基线](M0_BASELINE.md)。

## 实施交付

| 任务 | 本次结果 |
| --- | --- |
| B01 | 固定小样例、20 万字符、1 MiB、1200/10000 文件夹具，以及可重复的文件读取和原生诊断脚本。 |
| B02 | 类型化快照、项目配置 schemaVersion 1、配置 fingerprint、资源边界、预检/进度/取消和输出授权。 |
| U01 / U02 | 左侧导航与右侧大纲/双链/Agent 并存；宽度和状态持久化、窄窗收起、分组计数/筛选、固定目标、另一分屏定位和返回。 |
| A01 / A02 | 授权上下文和实际读取片段可见；写作操作统一填入草稿；中文细粒度及链接目的地差异、只读正文预览，保留逐项审阅与撤销/重做。 |
| E01 | 各导出菜单进入统一窗口；冻结未保存缓冲区；独立静态预览、字体/图片就绪、过期检测、打印窗口状态与导出取消。 |
| E02 | 三套独立主题、本地资源内嵌/打包、生产字体内嵌、语义公式、静态 XML 图表、长表跨页、长代码、目录及深度设置。 |
| E03 | 内置/个人/项目/本次配置覆盖；项目预设与未知字段保留；DOCX/ODT 参考文档、EPUB CSS、Pandoc PDF 引擎样式映射。 |

本次没有自动保存源文档或自动接受 Agent 修改。项目检索、联网研究和批量成册仍按后续 M2/M3 范围处理。

## 自动化检查

| 检查 | 结果 | 证据和边界 |
| --- | --- | --- |
| Vitest | 73 个测试文件，452 项通过 | `output/m1-native/unit-final.log` |
| Playwright 浏览器 E2E | 102 项全量通过；最后的宽表警告变更另经导出专项 14 项通过 | `output/m1-native/e2e-final.log` 和 `export-e2e-final.log`。这是 Vite renderer 浏览器测试，不等同于 Tauri 原生验证。 |
| Rust 单元测试 | 201 项通过 | `output/m1-native/rust-tests.log`，包含 SVG/XML 适配、CSS 原始文本、KaTeX 镜像去重、资源和配置边界。 |
| 前端 production build | 通过 | `output/m1-native/frontend-build.log`；打包资源已生成。 |
| production 配置下 Rust app | 已构建为调试版 | 使用 Tauri custom protocol 加载 production 前端资源；不是优化 release 构建或安装包。 |
| ESLint / rustfmt / diff 空白检查 | 通过 | `npm run lint`、`cargo fmt -- --check`、`git diff --check`。 |

自动化结果不覆盖 macOS、Linux、优化版 release 或安装器。本轮没有声称这些平台或分发路径已验收。

## Windows 原生开发版 M1 流程

`output/m1-native/receipt.json` 记录 Tauri 2 WebView2 与 Rust 后端的原生开发版流程。receipt 中 `backendMocked` 为 false、`success` 为 true，13 项检查全部通过，`pageErrors` 为空。应用使用专用标识 `io.github.yulianjie.markcaptain.m1-validation`，测试项目及导出产物均位于 `output/m1-native`。

实际覆盖包括：

- 左侧文件树与右侧检查器并存；反链按来源文件分组，固定目标后切换文档仍保持目标；固定双链栏后可在另一分屏打开来源，并返回原分屏与文档。
- 真实 Rust IPC 保存并重读项目导出配置；使用旧 fingerprint 再次保存时得到配置冲突。资源读取允许项目内 SVG，拒绝项目根外的相邻文件。
- 通过命令面板打开导出窗口，选择正式报告主题和资源目录模式，预览中显示本地图片。
- 三套主题均生成真实 HTML 文件并内嵌 SVG；技术主题另生成资源目录版 HTML，验证导出 SVG 字节与源文件相同。
- Pandoc 与 Typst 由隔离验证进程的 PATH 提供。Rust 实际生成 DOCX、ODT、EPUB 与 PDF；receipt 检查 ZIP 成员和 `%PDF-1.7` 签名。记录的文件大小分别为 11,223、7,938、5,400 与 45,517 字节。
- Rust 导出任务真实取消，返回 `export:cancelled`，未留下 HTML 或资源目录。
- Agent 对话使用本机 HTTP 模型 fixture；Rust 工具读取和 `propose_edit` 审阅是真实调用。用户通过界面应用修改，执行撤销、重做、再次撤销后继续对话，服务收到 `reverted` 审阅状态。

Agent receipt 中 4 个 HTTP 请求包含读取与建议工具循环。模型响应来自本机 fixture；本轮没有使用真实商业云模型或用户凭据，不能据此宣称商业云服务已测。

## Windows 打印对话框

`output/m1-native/manual-print.json` 记录 Windows WebView2 实际打开了系统打印窗口，并选择 `Microsoft Print to PDF` 后由操作者取消。`fileSaveClaimed` 为 false；本记录不代表 PDF 文件已创建或内容已验证。

## Production custom-protocol 复验

最终证据是 `output/m1-native/production-20261022-141600195Z/receipt.json`：`success: true`、10 项检查通过、页面异常为空。脚本为 `scripts/m1-production-smoke.mjs`；它拒绝 Vite URL，使用真实 `http://tauri.localhost` 资源和 Rust IPC，没有导入开发源码。构建使用 production 前端、Tauri `custom-protocol` 和 Rust **调试构建**，不代表优化 release 或安装器验收。

本轮使用 Pandoc 3.12.1、Typst 0.15.1，通过隔离验证进程 PATH 提供，没有修改全局安装。样例包含中文、公式、Mermaid、相对 SVG、80 行表、12 列宽表、脚注和 200 行代码。检查覆盖：

- 真正的项目扫描/关系 worker、文件树与右检查器、项目预设读写、写作命令只填草稿不发送。
- 实际预览中存在目录、公式语义、内嵌图片、静态图表和宽表警告；没有开发路径、外部字体地址或脚本。
- Rust 写出的 HTML、DOCX、ODT、EPUB、PDF 均存在。ZIP 内容保留表尾与 `row200`，DOCX 含 OMML，ODT/EPUB 含 MathML。此项验证文件结构和内容，不声称已在 Word/LibreOffice/EPUB 阅读器逐页验收。
- PDF 为 9 页、192742 字节；`pdf-review/receipt.json` 检查目录、公式、表尾、代码尾、脚注及图表文字，表格标记允许提取文本的换行。`pdf-review/page-1.png` 至 `page-9.png` 已全部渲染查看：公式可见、长表重复表头、代码继续跨页且末行存在、图表可见。
- 源 Markdown SHA-256 在全部导出前后相同；脚注选项只在已验证的隔离配置中临时修改内存，并在 finally 恢复。

12 列纵向样例保留内容，但换行过多，不能当作“自动排版始终可读”的证明。应用对超过 8 列的表格给出布局警告。另一次真实 Rust/Pandoc 输出将设置调整为 A4 横向、10pt；`output/m1-native/production-20261022-141050537Z/landscape-receipt.json` 与 `landscape-review/page-5.png` 记录宽表完整、可读的结果。页数因横向纸张高度减小而增加，不是内容丢失。

最终验证前实际发现并修复了：预览 iframe 就绪等待死锁、production 字体哈希路径残留、Pandoc 对 SVG XML 的破坏、CSS data URI 图标误识别、公式语义被过滤、Typst 长表整块分页、目录布尔参数和深度不生效。早期失败 receipts 留作诊断，不用于替代最终成功记录。

## 性能结果与限制

`output/m1-native/performance.json` 记录 Windows 当前机器上的原生样例：Core Ultra 9 185H、22 逻辑处理器、31.4 GiB RAM。测量包含调试版 WebView2、CDP 往返和页面事件循环，不是硬件输入到像素的纯前端延迟；每项只采样 12 次，作为诊断数据，不构成性能保证。

| 样例 | 打开到双帧就绪 | 输入与模型提交 P50 / P95 | 结论 |
| --- | ---: | ---: | --- |
| 20 万 Unicode 字符，可视化模式 | 约 4.30 秒 | 1,139 / 2,721 ms | P95 远高于候选 50 ms 目标，长篇可视化编辑性能未达标。 |
| 1 MiB Markdown，源码模式 | 约 1.82 秒 | 38.5 / 200.7 ms | P95 也高于 50 ms，仍需 profile 和优化。 |
| 1,200 文件项目读取 | — | 2.78 秒 | 笔记集合读取完成；不等同于所有关系 worker 已完成。 |
| 10,000 文件项目读取 | — | 12.34 秒 | 是当前机器和调试构建样本，不代表各类磁盘的保证值。 |

50 ms 是方案中的候选交互目标，不是已达成的承诺。后续应分别分析长文解析、Muya 更新、Markdown 序列化、共享历史和关系索引成本。

## 未完成项

- 优化 release、安装器、macOS 与 Linux 原生应用均未验证。
- 没有用真实商业云模型或用户密钥进行 Agent 测试。
- 超宽表仍需要横向/字号/列拆分等人工排版选择；HTML 近似预览不能替代各目标阅读器的最终版式确认。
- 远程资源下载未提供；DOCX/ODT 行距映射未提供并在界面禁用。EPUB 的分页由阅读器决定。
- M2 的本地项目检索/写作规范/联网研究，及 M3 的批量导出、合并成册和多文档修订均尚未开始。
