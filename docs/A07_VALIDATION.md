# A07 实施与验证记录

日期：2026-10-23。本记录是发布前的实现验收：当时版本为 0.8.4，基线为 a5be6a1 加工作区已有 M0/M1/M2、E04/E05 与本轮 A07 改动，未执行发布操作。后续版本整理见 [v0.8.5 发布说明](releases/v0.8.5.md)。

**状态：A07 已完成，Astra 并行开发与交叉审查整改、自动化回归、限定范围 Windows 原生及可视验收通过。** 使用说明见 [A07 工作流](A07_WORKFLOWS.md)。既有导出证据保留在 [M3 E04/E05 验证记录](M3_VALIDATION.md)。

## 实施范围

- 显式选择 1–8 个打开的文档，包含脏缓冲区与未命名文档；每份最多 2 MB，合计 4 MB。
- 元数据目录先发送，正文按需读取；准确的文档 ID/快照路由，每篇一份建议、最多 32 处替换。
- 按文件应用、忽略、撤回、定位和只读原文查看；源码/所见即所得模式与分屏正常撤销/重做。
- 应用只修改缓冲区；所选标签暂停自动保存。校验磁盘原始字节、指定编码解码后的内容、标签/路径/编码/窗格身份及保存队列版本。
- 与普通 Agent 任务互斥，取消与迟到事件隔离；原文副本和多文档审阅仅保留当前会话，不进入普通历史，不提供跨重启恢复。

## 最终自动化结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 完整前端单测 | 78 文件、583 项通过；其中 A07 59 项 | output/a07-unit-final.log |
| 完整 Rust 库测试 | 273 项通过、1 项既有公网 probe 默认忽略 | output/a07-rust-final.log |
| 浏览器完整运行 | 140 项通过、1 项被开发 HMR 打断；该项干净复跑通过 | output/a07-browser-final.log、原 test-results trace |
| 冻结源码后浏览器复跑 | 36/36 通过：A07、普通 Agent、M3 项目导出整文件和历史/撤销精选 | output/a07-browser-rerun.log（28 项）、output/a07-browser-tracker-rerun.log（8 项） |
| TypeScript / ESLint / 生产前端构建 | 全部通过 | output/a07-build-final.log、output/a07-lint-final.log |
| Rust custom-protocol 构建 | 调试构建通过，内嵌最新生产前端 | output/a07-native/native-build-final.log |
| Windows 原生脚本 | 7 场景、15 项检查通过，success=true、pageErrors=[] | output/a07-native/run-2026-10-23T07-43-00-904Z/receipt.json |
| Windows 原生输入与可视复核 | 真实窗口点击原文副本/定位；Windows SendInput 撤销/重做后精确校验状态和磁盘 | 同一 run 的 windows-key-undo.json、windows-key-redo.json 及截图 |

完整浏览器运行的唯一失败为 M3 changing output options disables reviewed output until the new plan is rendered。trace 显示 checkbox 操作期间 Vite 在 243368 ms 热更新并重新挂载 EditorPage，243502 ms 元素脱离 DOM，随后再次热更新，导出弹窗消失且出现重复恢复弹窗。冻结源码后的该测试 3.2 秒通过；整个 M3 项目导出文件及受共享审阅状态影响的场景均复跑通过。没有修改测试绕过失败，也不将首次完整运行描述为无失败运行。

## Windows 原生证据

脚本：[a07-native-smoke.mjs](../scripts/a07-native-smoke.mjs)。实际 Windows WebView2、http://tauri.localhost 内嵌资源、真实 Rust IPC 与文件能力；模型使用本地 OpenAI-compatible SSE 夹具。未替换 Agent transport、文件读写或版本探针结果。回调 gate 只延迟真实 Rust 响应的交付。

最终程序：output/a07-native/MarkCaptain-A07-Validation-154224.exe。

- 应用标识：io.github.yulianjie.markcaptain.a07-validation，与正常用户配置隔离；脚本拒绝非测试目录的恢复路径。
- 前端：EditorPage-zaOalC2A.js，脚本核对其与 dist 一致。
- EXE SHA-256：23FCCD21BBC7730D0E33CE4EA0DB7CC5D0FB211E111554538A21D6897240401D。
- 最终回执目录：output/a07-native/run-2026-10-23T07-43-00-904Z；33 次真实模型接口请求、69 次工具调用，夹具错误为空。
- 同目录保存请求、工具调用、事件、最终状态、8 张脚本截图与额外 Windows 原生按键截图。汇总及进程清理记录见 output/a07-native/status.json。

| 原生场景 | 验证结果 |
| --- | --- |
| 按文件审阅与源码分屏 | 两篇独立建议；逐文件 Apply、CodeMirror Ctrl+Z/Redo、Revert、只读原文；未选第三篇不进入模型请求，自动保存开启仍不写源文件 |
| Muya 整文规范化 | 建议不带末尾 LF，真实编辑器补 LF 后 Undo/Redo/Revert 均正常 |
| 真实磁盘外部修改 | 受影响文档拒绝旧建议，另一篇仍可接受；外部字节不被覆盖 |
| 探针等待期间编辑 | 延迟真实版本响应，修改缓冲区后拒绝应用并保留用户文字 |
| 探针等待期间切换窗格 | 拒绝旧操作，不切回旧窗格，不修改磁盘 |
| 取消 | Stop 终止实际 HTTP 流，无 proposal 事件，无缓冲区或磁盘修改 |
| 单窗格、无 LF 原文 | trimTrailingNewline=0 后实际手动保存，确认原文/磁盘无 LF；Muya Undo/Revert 恢复正文并补一个 LF，状态正确，保护快照及原磁盘字节不变 |

取消场景的 HTTP 流在夹具尝试发送迟到建议前已关闭，因此原生证明的是“取消终止流并阻止提案”。已实际收到的迟到事件过滤由单元与浏览器测试覆盖，不声称原生收到了迟到 SSE 后再过滤。

额外 Windows SendInput 复核在最后一个场景中撤销 Revert：Alpha 返回 applied、Beta 保持 pending；重做后 Alpha 为 reverted。两个状态均重新读取实际 Pinia 和源文件 SHA-256 校验。

## 交叉审查与回归整改

1. 同步切换标签及窗格编辑模式，消除混合源码/所见即所得目标误冲突。
2. 后续操作使用编辑器实际序列化结果；用有界检查点识别已知 Muya 规范化。仅成功的所见即所得事务允许原文补一个末尾 LF；额外空行仍冲突。
3. 每个异步边界重查保存 revision/pending。新手动保存使旧操作失效；旧保存结束不会解除已变化缓冲区的自动保存保护。单测覆盖 pause、挂载、probe、listen/start 等等待边界。
4. 探针使用实际文档编码且冻结编码身份；Rust 回归覆盖无 BOM UTF-16LE、指定 Windows-1251、有损/未知编码和容量限制。原始字节 fingerprint 不变。
5. 多文档轮次按数量扩展，上限 31，单文档仍为 10。8 文档逐次 read/propose 的真实回环 SSE 回归通过：17 次 HTTP 请求、8 份建议及最终回答。

其余回归覆盖错误/重复/未选择 ID、跨文档锚点、参考只读、同文件重复提案、元数据与正文发送时机、改名/删除/关闭重开、取消、新旧任务隔离、局部应用及独立撤销。单元测试采用受控 IPC/渲染回调；浏览器采用真实编辑器并替换 transport/文件 IPC；原生场景补齐真实桥接和文件证据。

## 适用边界

已验证 Windows 调试程序内嵌生产前端，不代表优化 release、安装器、macOS/Linux 原生或真实云模型效果。保存并发的全边界由受控单测覆盖；原生覆盖正常手动保存、自动保存暂停及真实外部内容修改，未逐一重放所有磁盘删除/改名/编码与保存并发排列。

会话原文副本不是磁盘历史归档或跨重启恢复；没有跨文件全局撤销。Muya 正常文本序列化可能补一个末尾 LF，原始保护快照和磁盘字节仍保留。测试进程在完成可视检查后关闭；保留隔离夹具、可执行程序和回执便于复核。
