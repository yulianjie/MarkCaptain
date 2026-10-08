# 写作 Agent 技能

## 使用方式

1. 打开 AI 助手，点击顶部书本按钮「技能管理」。
2. 启用适合自己的技能。默认由模型根据名称和用途自动选择，正文不会全部装入每次请求。
3. 要明确使用某个技能，在输入框上方的选择框指定它，或者在消息中写出技能名称。
4. 要添加技能，先下载并解压技能包，再点击「导入 SKILL.md」，选择该技能文件夹中的入口文件。导入的是本地副本，之后移动原文件不影响使用；更新技能时删除旧副本再重新导入。

关闭技能会将其从后续运行的技能目录中移除。已开始的任务使用启动时固定的技能快照。删除只删除应用中的导入副本，保留原始文件；内置技能可停用。

## 内置来源

| 界面名称 | 上游技能 | 固定版本 | 许可 |
| --- | --- | --- | --- |
| 通俗解释 · ELI5 | [DreambigOu/ELI5](https://github.com/DreambigOu/ELI5/tree/a766623b062331fdde53467001379b4ddf3acc2f/skills/eli5) | `a766623b062331fdde53467001379b4ddf3acc2f` | MIT |
| Mermaid 图表 | [softaworks/agent-toolkit / mermaid-diagrams](https://github.com/softaworks/agent-toolkit/tree/3027f20f3181758385a1bb8c022d4041dfb4de84/skills/mermaid-diagrams) | `3027f20f3181758385a1bb8c022d4041dfb4de84` | MIT |
| 清晰简洁的写作 | [softaworks/agent-toolkit / writing-clearly-and-concisely](https://github.com/softaworks/agent-toolkit/tree/3027f20f3181758385a1bb8c022d4041dfb4de84/skills/writing-clearly-and-concisely) | 同上 | 技能 MIT；部分参考资料为公有领域、CC BY-SA 4.0 |
| Markdown 说明文档 | [softaworks/agent-toolkit / crafting-effective-readmes](https://github.com/softaworks/agent-toolkit/tree/3027f20f3181758385a1bb8c022d4041dfb4de84/skills/crafting-effective-readmes) | 同上 | 技能 MIT；部分参考资料为 CC BY 2.0 |
| 团队沟通文档 | [Anthropic / internal-comms](https://github.com/anthropics/skills/tree/34040c9c568585f6929bedeaad110ad08f079624/skills/internal-comms) | `34040c9c568585f6929bedeaad110ad08f079624` | Apache 2.0 |
| Markdown 协作写作 | [MarkCaptain / markdown-coauthor](../src-tauri/skills/markdown-coauthor/SKILL.md) | 随 MarkCaptain 版本发布 | MIT |

资源位于 `src-tauri/skills/`，保留上游入口和文本参考资料，`source.json` 记录来源与版本。原始许可证随包保留，额外参考资料署名及许可见各包的 `NOTICE.txt` 和 `LICENSE-*.txt`。`build.rs` 将这些文本嵌入原生程序；运行时不下载或自动更新技能。

引入的上游技能按原文保留。Agent 的系统规则负责适配 MarkCaptain：使用文档审阅工具代替 CLI 文件写入；只按需读取段落；使用本地 Mermaid 10 支持的语法；简化解释时保持准确；没有子 Agent 时自行检查读者理解。技能文本不能增加权限或工具。

`internal-comms` 保留四份官方参考资料，分别用于进展/计划/问题、内部通讯、FAQ 和一般团队沟通。按实际写作任务选择参考资料；MarkCaptain 中没有 Slack、邮件或公司知识库工具时，依照用户提供的材料写作。

`markdown-coauthor` 是 MarkCaptain 自主编写的精简技能，参考 `doc-coauthoring` 的文档协作思路，使用新的名称和指令正文。它按读者和目标起草、局部修订并检查理解难点，不要求固定轮次的访谈、逐章节确认或外部子 Agent。由于已核对的上游 `doc-coauthoring` 目录没有明确的技能许可，本项目只采用通用方法，不包含其原文；来源说明见该包的 `NOTICE.txt`。

## 自定义技能格式

```text
my-writing-style/
  SKILL.md
  references/
    examples.md
  LICENSE.txt
```

`SKILL.md` 示例：

```markdown
---
name: my-writing-style
description: 按团队风格润色 Markdown 技术说明，适用于发布说明和使用指南。
license: MIT
---

# 团队写作风格

先说明结果和适用范围，再给出操作步骤。保留原文事实和术语。
需要示例时读取 references/examples.md。
```

支持 UTF-8（含 BOM）、CRLF 和标准 YAML 头部，包括引号、折叠/多行描述及额外元数据。必填字段为 `name` 和 `description`；名称最长 64 字符，使用小写字母、数字和短横线。入口必须有正文。

导入包含同目录及最多 8 层子目录中的 `.md`、`.txt`、`.mmd` 和许可证文本；跳过隐藏目录、脚本和其他格式，拒绝符号链接及越界路径。最多 30 个导入技能，每个 128 个文件/1 MB，单文件 100 KB；序列化配置最多 32 MB。脚本、二进制、远程 URL 和外部目录引用不会获得执行或读取能力。

自定义包和启停状态保存在应用配置目录的 `agent-skills.json`（Windows 通常为 `%APPDATA%\io.github.yulianjie.markcaptain\agent-skills.json`）。它与模型密钥、会话记录分开；不存入正在编辑的 Markdown。导入技能可能把其正文/参考资料发送给所配置的模型，因此请只导入准备在模型中使用的文本。

## 工具与上下文

| 工具 | 输入 | 行为 |
| --- | --- | --- |
| `read_document` | `{}` | 返回名称、字节数、行数和最多 80 个 ATX 标题；不返回段落正文 |
| `read_document` | `startLine`, `endLine` | 1 起始、包含两端，最多 200 行/48 KB，返回原始 Markdown 及行号 |
| `read_document` | `full: true` | 显式全文读取，最多 240 KB；仅用于涉及全文的任务 |
| `search_document` | `query` | 返回最多 20 个匹配行的有界片段，适合定位待解释或修改的段落 |
| `read_skill` | `id` | 读取一个启用技能的入口正文并列出参考文件 |
| `read_skill_file` | `id`, `path` | 读取该包中已导入的指定文本参考文件 |
| `propose_edit` | `title`, `oldText`, `newText` | 提出可审阅修改，不直接写入文档 |

内置与用户技能分别使用 `builtin:`、`user:` ID，导入不会覆盖内置资源。选区仍是硬性读取/编辑边界。普通问答只需对话消息；本地快照留在后端，只有实际读取的片段进入后续模型请求。
