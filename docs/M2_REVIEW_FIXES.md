# M0–M2 审查整改与验证记录

日期：2026-10-23。版本仍为 0.8.4，基线为 `a5be6a1` 加现有未提交工作区；不包含提交、推送或发布。

状态：14 项修复、正式回归和本轮 Windows 原生验证均已完成。4 个 `gpt-6-astra` 子 agent 并行修复，先处理 R01/R02 两项 P1；历史和项目边界另做交叉复核。

## 整改与正式回归

| ID | 修复 | 回归覆盖 |
| --- | --- | --- |
| R01 P1 | 关联期间阻止发送/重试/总结；文件读取后复核会话身份与活动任务，禁止迁移活动请求 | `agent-history.spec.ts`：等待文件 IO 时发送、done/cancelled/error、活动请求竞态 |
| R02 P1 | 惰性 HTML 中剥离加载属性后才插入页面；外部图表资源禁用，保留源码与提示 | `m1-export-dialog.spec.ts`：图片、CSS、Mermaid、Vega 网络拦截；禁用 CSP 的 Vega 回归和内联图表正例 |
| R03 | 导出操作代次贯穿保存对话框、预检、写出和打印；取消/关闭后不再发起后续步骤 | 导出 E2E：延迟保存、预检及关闭窗口；断言未发起写出/打印 |
| R04 | 首次预览中的文档/设置变更也失效；输出复用完整冻结请求 | 导出 E2E：延迟首次预检后改变设置、刷新再导出 |
| R05 | 显式内置预设 ID 参与主题基底解析 | `export-profiles.spec.ts` 及导出预设 UI |
| R06 | 本地 Rust 统一 glob 过滤，前端不再用近似规则遗漏脏缓冲区 | `agent-m2.spec.ts`、Rust `prepare_access/search/read`：brace/class 包含与排除、脏缓冲区覆盖磁盘 |
| R07 | 文档检查按身份/版本同步失效；代次保护阻止旧成功、失败和 finally 干扰新检查 | `agent-document-check.spec.ts` 8 个 freshness/race 用例及 M2 浏览器流程 |
| R08 | 最终 pretty JSON 的字节上限在原子替换前检查 | Rust 配置回归：超限保存不改旧文件，合法配置仍可加载 |
| R09 | 引用要求已有成功读取回执 | Rust：错误行范围读取后禁止引用；成功重读后正常引用 |
| R10 | 已有候选先于新发现预算匹配，不重复计费 | Rust：磁盘/缓冲区满候选缓存和字节预算仍可收窄筛选 |
| R11 | Rust 与界面读取上限来自 `agent-project-limits.json`，成功的不同来源才计数 | Rust：第 41 份拒绝、失败不占名额、重复读取可用 |
| R12 | 会话内保存经验证的原请求关系，归档快照和权限保持原样 | 历史回归：重新授权后生成；选区保持与重新选择；历史关系序列化 |
| R13 | 插入定位偏移排除目标本身 | 真实 Vue/CodeMirror 浏览器回归：正文中间与文末插入定位 |
| R14 | 未修改表格单元格只输出一次 | 真实 Vue 浏览器回归：单元格文本与 del/ins 结构 |

所有回归进入正式 `test/unit`、`test/e2e` 或生产 Rust 模块测试；审查时放在 `output/astra-review` 的独立复现不充当正式覆盖。

## 最终验证

| 检查 | 最终结果 | 证据 |
| --- | --- | --- |
| 前端单测 | 75 个文件、491 项通过 | `output/review-fixes-native/unit-final.log` |
| Rust 库测试 | 245 项通过、1 项公开网络 probe 默认忽略 | `output/review-fixes-rust.log` |
| 浏览器 E2E | 118 项通过 | `output/review-fixes-native/e2e-final.log` |
| 构建 | vue-tsc、Vite production、Rust custom-protocol 调试构建通过 | `frontend-build-final.log`、`native-build.log` |
| 静态检查 | ESLint、rustfmt、正常仓库换行配置下的 diff 检查、两份原生脚本语法检查通过 | `lint-final.log`、`diff-check.log` 及对应命令 |
| Windows 原生问题回归 | 12 项检查覆盖 R01–R14；success=true，pageErrors=[] | `run-2026-10-23T03-20-13-234Z/receipt.json` |
| Windows 原生输出补验 | 10 项通过；实际 HTML、DOCX、ODT、EPUB、PDF 输出及源文件 SHA-256 保持不变 | `production-20261023-032615773Z/receipt.json`、`pandoc-native-final.log` |

表中省略的证据路径前缀均为 `output/review-fixes-native/`。Rust 全套日志位于表中写明的独立路径。

汇总清单 `output/review-fixes-native/acceptance.json` 从两份成功原生 receipt 核对 R01–R14 全覆盖，并记录验证程序 SHA-256。验收结束后已停止本轮创建的验证进程，未终止用户应用。

原生脚本为 [review-fixes-native-smoke.mjs](../scripts/review-fixes-native-smoke.mjs)，要求独立应用标识 `io.github.yulianjie.markcaptain.review-validation`、生产前端资源、当前 EditorPage bundle 和仅在 `output/review-fixes-native` 内的夹具路径。本轮加载 `EditorPage-E885QBXU.js`，程序副本为 `output/review-fixes-native/MarkCaptain-Review-Validation-110833.exe`。

原生测试使用实际 Rust IPC、文件系统和工具循环；模型使用本机无密钥 HTTP fixture。为稳定重现竞态，harness 只延迟真实 IPC/文件打开结果，不替换结果；Windows 文件选择和保存选择由 Computer Use 操作。浏览器测试、函数测试、实际 WebView2 和安装器验收分别记录，不能互相替代。

实际验证包括：项目缓存 50 份后仍可收窄查询、40 份成功来源和第 41 份拒绝、错误读取不能引用、brace glob 中的未保存中文/Emoji 证据、配置失败不改磁盘、编辑与切换后检查过期；历史经原生选择器关联时禁止发送，随后用新授权重新生成；真实表格显示和插入范围选择；第一次导出预检中修改设置使旧结果失效、网络请求数为零、选择保存位置后取消不生成文件、随后正常 HTML 保存。

输出补验复用 [m1-production-smoke.mjs](../scripts/m1-production-smoke.mjs)，增加受限的 `M1_PRODUCTION_OUTPUT_ROOT` 参数以复用本轮隔离路径；该路径必须为仓库 `output/` 下的独立目录，原有身份与 canonical path 检查仍保留。夹具包含 80 行表格、12 列宽表、200 行代码、脚注、中文、公式及 Mermaid。实际输出检查了表格尾部、代码 row200、MathML/OMML、资源与文件结构；不等于每页排版均已人工验收。

本机测试工具为已有 `output/m1-tools` 中的 Pandoc 3.12.1 与 Typst；仅向隔离测试程序的子进程 PATH 加入其目录，没有改系统 PATH 或安装软件。

诊断轮记录保留：最初的 native hook 尝试替换只读 invoke 未生效；后改为在 Tauri callback Map 中延迟真实预检结果，并修正恢复弹窗和隐藏 checkbox 的测试操作。最终 12 项整轮通过，早期失败记录不算成功证据。额外导出轮因进程 PATH 未含 Pandoc 正确报告依赖缺失，补入已存在测试工具后 10 项输出补验通过；未放宽产品依赖检测。

## 行为与限制

- 远程图片仍不会下载；保留外链的 HTML 需要网络才能显示。PlantUML、外部资源或自定义配置 Mermaid、需要外部数据/图片的 Vega 保留可读源码与警告。普通 Mermaid 和内联 Vega 图表继续静态输出。
- 前端将有界项目内脏缓冲区通过本地 IPC 交给 Rust 再过滤；不直接把这些缓冲区发给模型。为保持请求有界，其他过大的脏标签也可能阻止较窄范围检索。
- 不恢复归档时的文档、项目或联网授权；原选区冲突后仍需显式重新选择。
- 本轮未推进 M3，未替换 Muya，也未解决 M0 超长文档性能基线；没有计划发布新版本。
- 原生程序为未优化 Rust 调试构建加生产前端资源，复用本地编译缓存并复制为独立运行文件；没有覆盖已安装程序或使用其配置。优化 release、安装器、macOS/Linux、真实商业模型质量及系统打印保存结果未在本轮验收。
- 公网研究实现未修改，本轮没有重跑真实网络 probe；其上一轮成功证据仍见 [M2 验证记录](M2_VALIDATION.md)。
