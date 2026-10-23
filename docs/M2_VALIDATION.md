# M2 实施与验证记录

更新日期：2026-10-23。应用版本：0.8.4。代码基线仍为 `a5be6a1` 加工作区中的 M0/M1/M2 改动，未提交、打 tag 或发布。

状态：M2 功能及后续 14 项审查整改已完成。2026-10-23 最新回归为前端 491 项、Rust 245 项（另 1 项网络 probe 默认忽略）、浏览器 118 项；Windows 原生整改 12 项及输出补验 10 项通过。逐项修复和最新证据见 [审查整改记录](M2_REVIEW_FIXES.md)。下文保留整改前的 M2 首轮与重启恢复历史记录，不能替代最新结果。

## 交付范围

| 任务 | 实现 |
| --- | --- |
| A03 | 窗口绑定的项目范围授权/撤权；有界字面检索；先候选、后按 ID 读取；未保存缓冲区优先；只读快照和引用；排除构建/缓存/导出及自定义输出目录；权限或配置变化失效；扫描取消。 |
| A04 | `.markcaptain/agent.json` 版本与 fingerprint；原子保存和扩展字段保留；项目写作偏好；当前缓冲区术语、标题层级、本地 Markdown 链接/图片存在性检查；定位、只读模型检查及待审修订。 |
| A05 | 复用可选本地历史、快照去重和限额；恢复旧卡锁定；显式选择文档后保守重建 pending 卡；保留旧决定；历史不恢复范围、联网或公共 DNS 授权。 |
| A06 | 默认关闭的联网；可编辑候选及逐条批准的确切查询；任务来源 ID；Bing RSS 搜索和网页读取；来源状态/时间/摘录；公网、DNS pin、peer 和重定向校验；显式可选公共 DNS；历史仅保存 Web 来源元数据。 |

使用方法与精确限额见 [M2 工作流](M2_WORKFLOWS.md)。M2 没有增加 Shell、任意文件写入、多文档自动修改、自动接受建议、批量导出或合并成册。

## 自动化结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 前端单测 | 74 个文件、473 项通过 | `output/m2-native/unit-final.log` |
| Rust 库测试 | 237 项通过、1 项 live test 默认忽略 | `output/m2-native/rust-final.log` |
| 真实网络 probe | 单独显式运行的 1 项通过 | `output/m2-native/live-web.log`；真实 Reqwest、Cloudflare DoH、Bing RSS、example.com |
| 浏览器 E2E | 103 项通过 | `output/m2-native/e2e-final.log` |
| 构建 | 前端 production 资源和 Rust custom-protocol 调试构建通过 | `frontend-build.log`、`production-build.log` |
| 静态检查 | ESLint、vue-tsc、rustfmt、diff 空白检查通过 | 构建及 `lint-final.log`；脚本 `node --check` 通过 |

浏览器测试不等于原生应用测试。两处已有 E2E 已按新行为修正：历史分章总结在显式重新附加前不得继续发送正文；偏好持久化断言等待异步写入完成。开发服务器长期热更新产生的模块实例差异曾干扰检查，冻结代码并重启 Vite 后全量回归通过。

## Windows 原生应用首轮

构建使用专用标识 `io.github.yulianjie.markcaptain.m2-validation`，生产前端资源通过 `http://tauri.localhost` 加载，Rust 为未优化调试构建，不是 release 安装器。测试没有替换用户安装的 MarkCaptain，也没有使用其配置目录。

脚本 [m2-native-smoke.mjs](../scripts/m2-native-smoke.mjs) 拒绝其他应用标识、开发资源 URL、输出目录外恢复路径，并核对已加载的 EditorPage bundle 与本轮 `dist` 产物相同。Agent 模型响应使用本机 HTTP fixture；Rust IPC、文件系统、工具循环和公开网络请求均真实执行。

`output/m2-native/exercise-2026-10-22T15-21-24-638Z/receipt.json` 为首轮最终记录：`success: true`、9 项检查通过、`pageErrors: []`。包括：

1. 隔离应用身份、生产资源及最新 bundle。
2. 真实项目配置读写、未知字段保留、旧 fingerprint 拒绝；`enabledByDefault: true` 不产生 grant。
3. 当前缓冲区术语和缺失本地目标检查，不调用模型。
4. 只读模型检查中，即使 fixture 试图调用 `propose_edit`，Rust 仍拒绝。
5. 项目检索/读取/引用采用未保存的中文与 Emoji 缓冲区；初始模型消息不包含参考正文。项目参考修改被拒绝，排除目录和输出目录的标记没有进入模型请求。
6. 可选历史保存 pending/applied/dismissed/reverted 四种不同决定。
7. 经显式公共 DNS 模式真实搜索公开网络并读取页面；未经批准的查询被拒绝，来源卡记录正确状态和时间。
8. 参考 Markdown 的磁盘 SHA-256 前后相同，未自动保存未保存缓冲区。

检查名、模型工具调用、真实事件和截图分别保存在该目录的 `receipt.json`、`model-receipt.json`、`events.json`、`native-m2.png`。读取结果可能包含测试夹具正文，这些产物位于 Git 忽略的 `output/`，不会加入源码。

原生验证发现并修复了 Windows `\\?\` / `\\?\UNC\` 规范化路径与前端项目范围不匹配的问题。新增单测覆盖驱动器大小写、UNC、点路径和脏缓冲区过滤。另修正原生 harness 的初始 Muya baseline 与真正未保存编辑的区别，防止把测试夹具的首次加载当成用户修改。

## 原生重启恢复：已完成

首轮结束后已真正停止并重启该隔离应用。2026-10-22 的首次恢复检查确认了应用身份、最新资源、恢复旧审阅卡只读且所有源访问授权关闭，四种原决定保持不变；后续因锁屏等待系统文件选择超时，该轮 `success: false` 保留作诊断。

2026-10-23 用户解锁后重新启动同一隔离应用，通过正常 Tauri 文件选择命令打开 Windows 原生 Markdown 选择器，并选择 `history-resume.json` 指定的测试文件。应用成功把历史关联到实际打开的 Markdown，旧卡保持锁定，原来的 pending/applied/dismissed/reverted 决定未变，只创建一张包含一条 pending 修改的新卡。

系统选择器由 Computer Use 操作；WebView2 中的新卡应用、编辑器撤销和继续发送由原生软件测试 harness 驱动。最后一段使用 `--finish-restore` 从已经完成的系统选择继续，避免重放恢复动作。最终证据为 `output/m2-native/finish-restore-2026-10-23T02-18-38-552Z/receipt.json`：`success: true`，6 项检查通过，`pageErrors: []`。本轮 WebView2 运行时为 156.0.4314.42。

实际覆盖：原生身份及最新 bundle、重启后权限关闭和旧卡只读、文件选择后仅重建 pending、界面应用与 Ctrl+Z 撤销、继续对话的审阅反馈。额外的 `feedback-verification.json` 将新卡的稳定修改 ID 与真实模型请求逐项比对，确认该条修改的界面状态和反馈均为 `reverted`；之前已接受的另一处修改仍在正文中。这里没有用旧卡中原本就存在的 reverted 项替代新卡的撤销验证。

等待选择期间的超时和首次启动时调试端口尚未就绪的失败记录均保留，不能当成成功证据。harness 已加入有界启动重试，并支持选择器操作完成后继续补验；产品代码没有为测试绕过系统文件选择或审阅保护。

## 网络与其他边界

- 本机系统 DNS 为 Bing/example.com 返回 `198.18.0.0/15` 虚拟保留地址，系统解析模式正确拒绝。没有放宽私网限制或借用系统代理。显式公共 DNS 模式通过固定 Cloudflare 公网 bootstrap 得到真实公网地址，之后仍检查每跳 DNS、实际 peer、大小和超时。相关 API 依据见 [Cloudflare DNS JSON](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/) 和 [Reqwest ClientBuilder](https://docs.rs/reqwest/0.12.28/reqwest/struct.ClientBuilder.html)。
- 模型端使用本机 fixture；没有使用商业云模型或用户密钥，未验证不同真实模型的研究和写作品质。
- 项目检索采用明确标记的有界字面搜索，不声称建立语义索引或扫描完超预算项目。达到限额时返回不完整状态。
- 确定性检查不验证远程 URL 可用性、跨文件标题锚点或论点真假；模型检查必须按疑点处理。
- 本轮没有重新测量或修复 M0/M1 的超长 Muya 文档性能；历史基线见 [M0 基线](M0_BASELINE.md)。macOS/Linux、优化 release 及安装器未验收。
