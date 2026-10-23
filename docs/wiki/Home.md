# MarkCaptain 使用文档 / User Documentation

MarkCaptain 是以本地 Markdown 文件为基础的桌面写作与笔记工具，集成所见即所得编辑、源码编辑、项目笔记管理、可审阅的写作 Agent，以及单篇和项目导出。文档仍是普通文件，可以继续交给 Git、同步盘或其他编辑器管理。

本 Wiki 按 **2026-10-24 的当前工作区源码**整理，应用版本字段为 **0.8.5**。这表示文档描述的代码基线，不保证每个已安装版本都包含全部功能，也不表示本次重新验收了各平台安装包。下载时请核对对应版本的发布说明。

## 从这里开始

| 你想做什么 | 阅读页面 |
| --- | --- |
| 了解程序目前有哪些功能、需要什么依赖 | [功能总览](https://github.com/yulianjie/MarkCaptain/wiki/%E5%8A%9F%E8%83%BD%E6%80%BB%E8%A7%88) |
| 安装并完成第一次编辑、保存和导出 | [使用指南](https://github.com/yulianjie/MarkCaptain/wiki/%E4%BD%BF%E7%94%A8%E6%8C%87%E5%8D%97) |
| 管理文件、切换源码、查找替换、分屏写作 | [编辑与工作区](https://github.com/yulianjie/MarkCaptain/wiki/%E7%BC%96%E8%BE%91%E4%B8%8E%E5%B7%A5%E4%BD%9C%E5%8C%BA) |
| 使用每日笔记、模板、双链、标签、属性和任务 | [笔记与知识管理](https://github.com/yulianjie/MarkCaptain/wiki/%E7%AC%94%E8%AE%B0%E4%B8%8E%E7%9F%A5%E8%AF%86%E7%AE%A1%E7%90%86) |
| 配置模型、附加资料、审阅修改、修订多个文档 | [AI 写作助手](https://github.com/yulianjie/MarkCaptain/wiki/AI%E5%86%99%E4%BD%9C%E5%8A%A9%E6%89%8B) |
| 授权项目检索、检查文档、进行联网研究 | [项目检索与联网研究](https://github.com/yulianjie/MarkCaptain/wiki/%E9%A1%B9%E7%9B%AE%E6%A3%80%E7%B4%A2%E4%B8%8E%E8%81%94%E7%BD%91%E7%A0%94%E7%A9%B6) |
| 导出 HTML/PDF/办公文档、批量导出、合并成册 | [导出与成册](https://github.com/yulianjie/MarkCaptain/wiki/%E5%AF%BC%E5%87%BA%E4%B8%8E%E6%88%90%E5%86%8C) |
| 配置 Git/WebDAV 等同步、理解历史与数据位置 | [同步与数据安全](https://github.com/yulianjie/MarkCaptain/wiki/%E5%90%8C%E6%AD%A5%E4%B8%8E%E6%95%B0%E6%8D%AE%E5%AE%89%E5%85%A8) |
| 查找快捷键，调整主题、图片、拼写和窗口设置 | [快捷键与偏好设置](https://github.com/yulianjie/MarkCaptain/wiki/%E5%BF%AB%E6%8D%B7%E9%94%AE%E4%B8%8E%E5%81%8F%E5%A5%BD%E8%AE%BE%E7%BD%AE) |
| 处理启动、链接、模型、导出和同步问题 | [常见问题](https://github.com/yulianjie/MarkCaptain/wiki/%E5%B8%B8%E8%A7%81%E9%97%AE%E9%A2%98) |
| Read the English overview and workflows | [English User Guide](https://github.com/yulianjie/MarkCaptain/wiki/User-Guide) |

## 三种常用工作方式

**写一篇文章**：打开或新建 Markdown → 编辑和保存 → 按需用 Agent 提出局部修改 → 核对差异 → 预览并导出。

**管理一个笔记项目**：打开文件夹 → 快速打开或创建笔记 → 使用模板和每日笔记 → 用链接、标签与任务组织内容 → 通过分屏、双链和历史查阅。

**交付一套文档**：打开项目 → 检查链接与术语 → 明确授权 Agent 参考范围 → 按文档审阅修订 → 选择章节和主题 → 冻结快照 → 批量导出或合并成册。

## 使用前了解

- 普通编辑、笔记索引和本地历史可在本机使用；远端同步、图片上传与远程模型按各自配置联网。
- Agent 使用你配置的模型服务。本地文件并不意味着模型离线；发送前查看本轮文档、选区和参考资料。
- 模型提出修改，由用户审阅后应用。项目检索是只读权限，多文档修订需要另行选择目标。
- 系统打印打开操作系统对话框；只有完成系统中的保存操作，才会得到 PDF 文件。Pandoc 导出需要额外依赖。
- 本地历史、崩溃草稿和 Agent 对话历史用途不同，均不能替代独立备份。

## 项目入口

[源码仓库](https://github.com/yulianjie/MarkCaptain) · [下载与发布说明](https://github.com/yulianjie/MarkCaptain/releases) · [问题反馈](https://github.com/yulianjie/MarkCaptain/issues)

Wiki 内容的仓库源文件位于 `docs/wiki`，同时发布到 GitHub Wiki。页面导航使用统一的 Wiki 地址，便于从仓库、GitHub Pages 或 Wiki 阅读时跳转。功能入口以所安装版本为准。
