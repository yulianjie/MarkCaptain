---
title: MarkCaptain M0 代表性文档
aliases:
  - M0 样例
tags:
  - m0/baseline
  - 中文
priority: 3
---

# MarkCaptain M0 代表性文档

这份小型夹具用于复现编辑、关系索引、Agent 引用与导出中的常见 Markdown。它混合**中文**、English、`inline code`、Emoji 🧭 和非 BMP 字符 𠮷，正文换行采用 LF。

## 资料链接与重复标题

项目内双链：[[资料/边界条件|边界条件]]。普通链接：[本地插图](./m0-assets/diagram.svg)；外部链接：[Markdown Guide](https://www.markdownguide.org)。

## 表格与任务

| 格式 | 现状 | 用途 |
| --- | --- | --- |
| Markdown | `*.md` | 可读、可迁移的正文 |
| HTML | 独立预览 | 页面交付 |
| PDF | 系统打印或外部引擎 | 分页阅读 |

- [x] 保留用户原文
- [ ] 检查修改后再应用
  - 子项支持缩进与中文标点；金额示例：￥128.50。

> 引用块可以包含多行内容，
> 并同时保留 Markdown 源码和可视化结构。

## 代码、公式与图表

```ts
const documentId = '文档-01'
await invoke('cmd_export_preview', { documentId })
```

```rust
pub struct DocumentRef {
    pub relative_path: String,
}
```

行内公式 $E = mc^2$，块级公式：

$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
$$

```mermaid
flowchart LR
  edit[编辑] --> review[逐项审阅]
  review --> export[导出]
```

脚注示例[^baseline]，以及引用式链接[规范][spec]。

[^baseline]: 夹具只作为固定输入，不代表产品能力验收通过。

[spec]: https://commonmark.org/ "CommonMark"
