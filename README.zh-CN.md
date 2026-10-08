# MarkCaptain

[English](README.md) | [简体中文](README.zh-CN.md)

> 不仅是 Markdown 编辑器：这是一个现代、本地优先的智能写作空间；内置 Agent，帮助你思考、写作、审阅和修改，但不会越过你直接控制文档。

[下载最新版本](https://github.com/yulianjie/MarkCaptain/releases/latest) · [使用指南](https://github.com/yulianjie/MarkCaptain/wiki) · [写作 Agent 指南](docs/AI_AGENT.md) · [v0.7.0 发布说明](docs/releases/v0.7.0.md)

![带文章目录、多标签页与实时 Markdown 预览的 MarkCaptain 编辑器](img/markcaptain-view.png)

MarkCaptain 基于 Tauri 2、Vue 3 与 Rust，将专注、实时的写作体验与原生桌面集成、本地优先存储和以审阅为核心的 AI 工作流结合在一起。支持 Windows、macOS 与 Linux。

## 为什么选择 MarkCaptain

- **直接写作，不必来回预览。** 在实时所见即所得界面中编辑 Markdown，需要精确控制时可随时切换源码模式。
- **使用 AI，但不交出控制权。** Agent 可以读取你附加的快照并提出修改，不能静默改写或保存文件。
- **本地工作始终可靠。** 文件优先写入本地；可选远端存储拥有明确的同步、离线和冲突状态。
- **自由选择模型。** 默认提供 DeepSeek 预设，也可连接 OpenAI 兼容接口或本地 Ollama。
- **真正跨平台。** 提供 Windows x64、Linux x64、Apple Silicon 与 Intel Mac 安装包。

## 写作 Agent

从标题栏、视图菜单、命令面板打开 **AI 助手**，或按 `Ctrl/Cmd+Shift+A`。Agent 已直接集成到编辑器中，不需要额外安装 CLI、Node 或 Python 服务。

### 以审阅为核心的写作流程

1. **只附加任务需要的上下文。** 可使用当前文档、自动捕获的选区、粘贴图片，或最多八份只读 Markdown 参考资料。
2. **用自然语言提出要求。** 润色段落、续写草稿、整理提纲、解释截图、比较参考资料，或总结长文档。
3. **逐项审阅修改。** Agent 展示带行号的原文/建议差异；每一处都可应用、忽略、定位或撤回，也可批量处理已审阅的修改。
4. **灵活使用回答。** 将答案插入光标、追加到文末、替换当前选区，或创建新的未保存 Markdown 笔记。

![应用前逐项审阅 Agent 提出的多处修改](img/agent-review.png)

### Agent 能力一览

| 能力 | 说明 |
| --- | --- |
| DeepSeek 优先的模型配置 | 内置 DeepSeek 预设，支持自定义 OpenAI 兼容地址、本地 Ollama、自定义模型 ID 与自定义请求头。 |
| 按需读取文档 | 先获取元数据与标题，再搜索或读取相关行；全文读取是显式操作，不会默认发送整篇正文。 |
| 选区感知编辑 | 在所见即所得和源码模式中自动捕获选区；除非你允许参考全文，否则修改范围被限制在选区。 |
| 多处修改审阅 | 单次最多提出 32 处互不重叠的替换，支持逐项或批量应用、忽略、定位与撤回。 |
| 快照冲突保护 | 文档发生变化后，拒绝旧修改、旧引用和旧插入位置覆盖新内容。 |
| 原文依据 | `cite_document` 生成基于快照的可点击引用卡片，可在编辑器中定位对应原文。 |
| 长文分章总结 | 按受限段落拆分长文，显示进度和中间笔记；原文未变化时可继续未完成的总结。 |
| 图片输入 | 可粘贴或选择 PNG、JPEG、WebP 图片，配合支持视觉的模型进行纯图片提问和连续追问。 |
| 写作技能 | 内置清晰写作、Markdown 说明文档、Mermaid 图表、通俗解释、团队沟通和协作写作六个可查看技能，也可导入自己的纯文本 `SKILL.md` 技能包。 |
| 可选本地历史 | 搜索、恢复、导出与删除本地对话。默认关闭，永不保存 API Key 和图片。 |

### 长文、图片、历史与技能

| 分章总结 | 图片对话 |
| --- | --- |
| ![带进度和回答复用操作的 Agent 分章总结](img/agent-summary.png) | ![带粘贴图片上下文的 Agent 对话](img/agent-images.png) |

| 可选本地历史 | 内置与导入的写作技能 |
| --- | --- |
| ![Agent 本地对话历史](img/agent-history.png) | ![写作技能管理](img/agent-skills.png) |

### 隐私与安全边界

- API Key 与自定义认证请求头保存在操作系统凭据库，不写入普通偏好设置文件。
- Rust 后端负责模型请求、流式响应、取消、请求限制和工具循环；WebView 不接收可复用密钥。
- 模型只能获取你明确附加的快照，没有通用文件系统、Shell、工作区扫描、联网搜索、Git 提交或直接保存工具。
- 参考文档始终只读，只有当前文档可以接收需要人工确认的修改建议。
- 模型输出在渲染前会被清理；应用或撤回建议时必须再次匹配文档身份与内容。
- 远程 HTTP 接口适用于受信任网络，但提示词与凭据不会获得传输加密；离开受控本地网络时应优先使用 HTTPS。

完整配置、限制、协议与隐私模型见 [docs/AI_AGENT.md](docs/AI_AGENT.md)。内置技能来源及导入格式见 [docs/AI_AGENT_SKILLS.md](docs/AI_AGENT_SKILLS.md)。

## 编辑器功能

- 基于 Muya 的实时所见即所得 Markdown 编辑，同时提供源码模式。
- 多标签页、项目文件树、文章目录、全局搜索、查找替换、文件监听与编码检测。
- CommonMark/GFM、表格、任务列表、数学公式、代码块、图片、链接、脚注，以及 Mermaid、Flowchart、Sequence、PlantUML 等图表。
- 专注模式、打字机模式、多套内置主题、用户主题和自动深浅色切换。
- 键盘优先的命令面板；原生菜单与编辑器共用一套可自定义快捷键系统。
- 导出带样式 HTML；通过系统打印对话框打印或保存 PDF；可选 Pandoc 导出 PDF、DOCX、ODT 与 EPUB。
- 本地优先的项目存储，并可选接入私有 MarkCaptain Sync、Git、WebDAV 与 Storage Plugin Protocol 存储插件。
- 应用界面支持简体中文、英文与日文。

## 本地优先的存储与同步

MarkCaptain 始终先写入本地工作副本。可选项目存储会把本地保存状态与远端同步状态分开，因此网络故障不会让一次成功的本地保存变成失败。

- **私有 MarkCaptain Sync：** 基于 Axum/SQLite 的自建服务，提供版本历史、条件写入、增量游标和软删除墓碑。
- **Git：** 校验仓库、fetch、仅快进 pull 和非 force push。分叉与冲突会明确展示，不会 reset、自动提交或自动推送。
- **WebDAV：** 使用强 ETag 进行安全的条件修改；远端无法提供可靠版本检查时，拒绝不安全的自动写入。
- **存储插件：** 面向用户主动安装并信任的原生提供商，使用与厂商无关的 JSON-RPC stdio 协议。

安全模型和提供商协议见 [docs/STORAGE_PLUGIN_PROTOCOL.md](docs/STORAGE_PLUGIN_PROTOCOL.md) 与 [docs/CLOUD_STORAGE_DESIGN.md](docs/CLOUD_STORAGE_DESIGN.md)。

## 下载

从 [GitHub 最新版本](https://github.com/yulianjie/MarkCaptain/releases/latest) 获取发布包：

| 平台 | 安装包 |
| --- | --- |
| Windows x64 | NSIS `.exe`、MSI |
| Linux x64 | AppImage、DEB、RPM |
| macOS Apple Silicon | `.app.tar.gz` |
| macOS Intel | `.app.tar.gz` |

Windows 11 已自带 WebView2；Windows 10 可能需要安装 WebView2 Runtime。macOS 独立分发的压缩包可能需要按系统提示完成 Gatekeeper 确认。

## 从源码构建

### 环境要求

| 工具 | 要求 |
| --- | --- |
| Node.js | 20 或更高版本 |
| npm | 10 或更高版本 |
| Rust | Stable 工具链，1.77 或更高版本 |
| 平台依赖 | [Tauri 2 环境要求](https://tauri.app/start/prerequisites/) |

Windows 需要 Visual Studio C++ Build Tools 与 WebView2；macOS 需要 Xcode Command Line Tools；Linux 需要对应发行版的 Tauri WebKitGTK/AppIndicator 开发依赖。

### 开发

```bash
npm install
npm run tauri:dev
```

常用命令：

```bash
npm run dev          # 仅启动 Vite 前端
npm run build        # 类型检查与前端生产构建
npm run lint         # ESLint
npm run test:unit    # Vitest
npm run test:e2e     # Playwright
npm run tauri:build  # 原生生产安装包
```

原生安装包输出到 `src-tauri/target/release/bundle/`。

## 架构

```text
Vue 3 + Pinia + Muya WebView
  ├─ 编辑器状态、界面、会话与人工审阅交互
  └─ 类型化 Tauri invoke/event 桥接
                 │
Rust / Tauri 2 后端
  ├─ 文件系统、监听、搜索、偏好设置与原生菜单
  ├─ Agent 网络传输、凭据、工具与本地历史
  └─ 本地优先存储、同步、Git、WebDAV 与插件
```

渲染层到 Rust 的调用统一经过 `src/services/tauri-invoke.ts` 类型封装，Rust 到渲染层的事件在 `src/services/tauri-bridge.ts` 注册。迁移映射见 [docs/IPC_MAP.md](docs/IPC_MAP.md)。

## 项目状态

MarkCaptain 是持续开发中的 Tauri 桌面应用。核心编辑器、桌面工作流、写作 Agent、导出路径与本地优先存储已经实现；功能覆盖和各平台细节仍在持续完善。当前已验证范围请以[版本说明](docs/releases/)与[最新版本](https://github.com/yulianjie/MarkCaptain/releases/latest)为准。

## 致谢与许可证

MarkCaptain 使用与 MarkText 同款的 [Muya](https://github.com/marktext/muya) 所见即所得编辑器引擎。本仓库采用 [MIT License](LICENSE)，并在许可证和第三方声明中保留上游署名。
