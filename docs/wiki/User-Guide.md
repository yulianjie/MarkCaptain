# MarkCaptain User Guide

[Home](https://github.com/yulianjie/MarkCaptain/wiki/Home) · [简体中文指南](https://github.com/yulianjie/MarkCaptain/wiki/%E4%BD%BF%E7%94%A8%E6%8C%87%E5%8D%97) · [Feature catalogue / 功能总览](https://github.com/yulianjie/MarkCaptain/wiki/%E5%8A%9F%E8%83%BD%E6%80%BB%E8%A7%88)

MarkCaptain is a desktop Markdown editor with visual and source editing, project notes, a writing Agent with human review, and document/project export. Your documents remain normal local files.

This guide describes the workspace source inspected on **2026-10-24**, whose application version is **0.8.5**. An installed package may differ, including earlier builds with the same version. This documentation update does not establish fresh installer or cross-platform acceptance evidence.

## Install and start

Choose a version and architecture from [Releases](https://github.com/yulianjie/MarkCaptain/releases). The release workflow targets Windows x64 (NSIS/MSI), Linux x64 (AppImage/DEB/RPM), and macOS ARM64/x64 (`.app.tar.gz`, plus DMG when available). Check the assets attached to your chosen release.

Windows uses WebView2. Follow operating-system prompts for independently distributed apps. Updater signatures and `latest.json` are verification files, not installers.

No MarkCaptain account is required for local editing. Model and storage services may require their own credentials. The UI supports English, Simplified Chinese, and Japanese.

1. Create a tab with `Ctrl/Cmd+T`, or open a file with `Ctrl/Cmd+O`.
2. Write in the visual editor; toggle source mode with `Ctrl/Cmd+Alt+S`.
3. Save with `Ctrl/Cmd+S` and choose a path for a new document.
4. Open a project folder with `Ctrl/Cmd+Shift+O` for project navigation and notes.
5. Use `Ctrl/Cmd+Shift+P` to find commands.

Here `Ctrl/Cmd` means Ctrl on Windows/Linux and Cmd on macOS. Some shortcuts can be changed in Preferences; native, system, and editor-reserved actions are not all remappable.

## Editing and workspace

The Muya visual editor supports headings, emphasis, lists, tasks, tables, quotes, code, links, images, formulas, and diagram fences. Some Markdown extensions, including footnotes and superscript/subscript, require enabling their settings. Source mode is useful for exact YAML, link, and diagram edits.

Use Find/Replace for the active document and the search sidebar for project full-text/regex search. The outline navigates headings. The right inspector switches between outline, links, and Agent; links can be pinned beside the Agent.

Open multiple tabs and windows. Split right or down through the command palette, up to four panes in one orientation. Panes showing the same document share content, save state, and undo history, but keep their own cursors and display modes. The active pane determines editing and Agent targets. Closing a pane does not close its document.

Named layouts save paths, orientation, proportions, active pane, modes, and cursor/selection positions. They do not save document bodies or full undo histories. Untitled documents cannot be restored by persistent path.

The status bar shows document statistics, encoding/BOM, line endings, save state, mode, and separate cloud state. Automatic encoding detection is supported. Auto save is off by default; enabling it uses a default five-second delay and requires a previously saved path. External changes can pause auto save and require conflict handling.

Images may reference their original paths, be copied into a folder, or use a configured GitHub/PicGo/script uploader. Keep project-relative assets with your Markdown when moving devices. The GitHub image-upload token is session-only; it is separate from Agent credential storage.

See [Editing and workspace / 编辑与工作区](https://github.com/yulianjie/MarkCaptain/wiki/%E7%BC%96%E8%BE%91%E4%B8%8E%E5%B7%A5%E4%BD%9C%E5%8C%BA).

## Everyday notes and relations

- **Quick open** (`Ctrl/Cmd+K`) searches names, relative paths, and YAML aliases. Empty queries show recent notes; unmatched names can create Markdown notes without overwriting existing files.
- **Templates** (`Ctrl/Cmd+Alt+T`) insert at the active cursor and support <code>&#123;&#123;title&#125;&#125;</code>, <code>&#123;&#123;date&#125;&#125;</code>, <code>&#123;&#123;time&#125;&#125;</code>, and <code>&#123;&#123;date:YYYY/MM/DD&#125;&#125;</code>.
- **Today's note** (`Ctrl/Cmd+Alt+D`) creates the dated note only when missing; existing content and unsaved buffers are preserved.
- **Wiki links** support names, paths, aliases, and headings, such as `[[Plan]]`, `[[folder/Plan]]`, `[[Plan|label]]`, and `[[Plan#Milestones]]`.
- **Navigation** uses `Ctrl/Cmd+click` or the link popup. Markdown paths resolve from the source file; the current workspace also supports relative document navigation without an open project.
- **Backlinks and unlinked mentions** show source context and navigation. Ambiguous names need explicit paths.
- **Rename/move reference maintenance** previews affected references, checks versions, and retains transaction backups. External moves do not automatically rewrite links.
- **Tags and properties** combine body tags and YAML, support nested tags, and edit supported scalar/list values while preserving unrelated content. Complex YAML belongs in source mode.
- **Tasks** aggregate actual Markdown tasks outside code examples; toggling uses normal editor undo/save behavior.

Project note settings live in `.markcaptain/notes.json`; default template/daily directories are `Templates` and `Daily`. Note indexing is bounded, skips symlinks and generated/internal directories, and uses open unsaved project buffers in preference to disk.

Structured queries support `name:`, `path:`, `tag:`, `prop.key:`, and `task:open|done|any`. Spaces/AND combine terms, OR combines groups, and NOT or a field prefix `-` excludes. AND binds more tightly than OR; parentheses are not supported. Quote values containing spaces.

```text
tag:work prop.priority:>=2 NOT task:done
tag:reading OR tag:research
```

Indexing permits up to 4 MiB per document and 128 MiB of project bodies; task/search displays are capped at 1000 results. Incomplete indexing must not be interpreted as an absence of links or tasks. See [Notes / 笔记与知识管理](https://github.com/yulianjie/MarkCaptain/wiki/%E7%AC%94%E8%AE%B0%E4%B8%8E%E7%9F%A5%E8%AF%86%E7%AE%A1%E7%90%86).

## Configure and use the writing Agent

Open AI Assistant from the title bar, inspector, View menu, command palette, or `Ctrl/Cmd+Shift+A`. Configure a DeepSeek/OpenAI preset, another OpenAI-compatible service, or local Ollama with its base URL and model ID. Choose system credential authentication or no authentication, then save and test.

Keys and custom headers use the OS credential store, isolated by normalized base URL. Saved secrets are not returned to the UI. Linux needs an available, unlocked Secret Service. HTTP sends content and credentials without transport encryption. Text connection tests do not establish image support or full tool compatibility.

Writing actions include polish, shorten, continue, translate, explain, and terminology/structure assistance. They fill a draft for inspection before sending. Attach the intended document, selection, or read-only references; verify the active pane and scope. Full-document reference and selection editing can be separated.

Normal requests begin with attachment metadata, and tools read authorized body segments as needed. Explicit whole-document checks and chapter summaries send the corresponding snapshot/chunks. A remote model receives the content actually used; local files do not imply offline AI. Disabling an attachment does not erase prior conversation messages.

Answers can be copied, inserted at the cursor, appended, used to replace a selection, or opened as a new unsaved document. Citations can locate original evidence. Chapter summaries show progress and can resume only when the required original scope still matches.

Image input accepts pasted or selected PNG/JPEG/WebP: up to four per message, 5 MiB each, and twelve/20 MiB per conversation. Images stay in window memory and are sent to the configured model when requested. They are not persisted in history. The model must support vision, streaming, and tools.

### Review edits

Proposals show Markdown differences, source locations, and per-change decisions. Chinese text, link destinations, tables, code, and frontmatter receive review aids. Inline previews are read-only and do not enter saves or exports.

Apply, dismiss, revert, and editor undo/redo remain connected. Identity, exact source text, scope, and conflicts are checked again before changes. Conflicting or ambiguous proposals require a new comparison/request. Ordinary single-document edits may subsequently be written by normal auto save if enabled; the model cannot save directly.

### Revise multiple documents

Use **Revise multiple documents** to explicitly select 1–8 open tabs, including unsaved and untitled documents. Each snapshot is limited to 2,000,000 UTF-8 bytes, with 4,000,000 bytes total. Unselected documents and read-only references do not become targets.

The task freezes the selected set, pauses those tabs' auto save, and reads bodies through tools. Review/apply/dismiss/revert per document, then save manually. There is no cross-file Apply All transaction or global undo. Disk bytes and buffer/tab identities are checked; external changes and saves can invalidate old proposals.

Original copies and review records exist only for the current task/session, are replaced by a new request, and are not stored in ordinary conversation history. Stop or closing the dialog during generation cancels the request; already validated proposals may remain for review.

### Skills and local history

Six built-in skills cover ELI5 explanations, Mermaid, concise writing, Markdown documentation, team communications, and Markdown coauthoring. Enable/disable them, choose one explicitly, or let the model load instructions as needed. Importing `SKILL.md` copies allowed text resources; skills do not execute scripts or add permissions.

Conversation persistence is off by default. Enabling it permits local history browsing, Markdown export, and deletion. Images, API keys, project grants, and Web permissions are not restored. Restored review cards are read-only; explicitly reassociate and validate pending edits against a selected current Markdown file to create new review cards. Existing decisions are never replayed automatically.

### External MCP

Authorize one current buffer in **External Agent (MCP)** and use the displayed Node.js stdio adapter with temporary environment credentials. Node.js 18+ is required. The whole document is shared; selection metadata does not narrow read access.

The bridge only reads that document, submits reviewed proposals, and polls outcomes. It offers no arbitrary file access, direct apply/save, network, or Shell. Document/panel/window changes or revocation invalidate access. Keep tokens out of URLs, command arguments, persistent project files, and Git. The external client's own capabilities remain outside this bridge's control.

See [Writing Agent / AI 写作助手](https://github.com/yulianjie/MarkCaptain/wiki/AI%E5%86%99%E4%BD%9C%E5%8A%A9%E6%89%8B).

## Project research and document checks

Project retrieval requires an explicit session/window grant over the current project's include/exclude globs. It is bounded literal search, not vector retrieval. Candidates are distinct from actually read sources; all retrieved project content remains read-only. Changes to scope, relevant configuration, or project require renewed authorization.

`.markcaptain/agent.json` stores language, audience, tone, glossary, and search preferences. These settings are not permissions. Writing rules are sent only when enabled for the request.

Local checks do not call a model: they inspect heading jumps, allowed local link/image existence, and discouraged terminology. They do not verify external URLs, heading anchors, or semantics. Model read-only checks send the document snapshot without edit/project/Web tools. Generating a revision from an issue starts a separate reviewed request.

Web research is off by default and resets after sending. Review/edit and approve exact query strings before Bing RSS search, or explicitly supply public URLs. It accepts public HTTP/HTTPS on ports 80/443, not private-network endpoints or authenticated pages; it does not use the system proxy. Optional Cloudflare public DNS discloses target domains, does not change system DNS, and fails explicitly rather than silently falling back.

Per task, project research permits up to eight searches and forty successfully read sources. Web research permits eight approved queries, eight direct URLs, and twenty-four sources; each search returns up to five results. Budget limits and read failures are reported as incomplete, not as proof that nothing else exists. History does not restore grants or live webpage bodies.

See [Project research / 项目检索与联网研究](https://github.com/yulianjie/MarkCaptain/wiki/%E9%A1%B9%E7%9B%AE%E6%A3%80%E7%B4%A2%E4%B8%8E%E8%81%94%E7%BD%91%E7%A0%94%E7%A9%B6).

## Export documents and projects

Export menus open one workflow: choose format/theme/layout, freeze the current buffer, review resources and warnings, and export that reviewed snapshot. Editing or changing settings makes the preview stale. Export does not save the source document.

HTML and system printing do not need Pandoc. DOCX/ODT/EPUB need Pandoc; direct PDF also needs an available engine. Opening the system print dialog is not proof that a PDF was saved. Technical, simple-reading, and formal-report themes are separate from editor themes.

Local resources are checked against source paths and authorized scope. Remote resources are not automatically downloaded; HTML retaining external URLs still needs network access. Diagrams requiring external resources may remain readable source with warnings. Office/ebook previews approximate content; verify the actual file in its reader.

From **Export project…**, choose individual document outputs or an explicitly ordered book. Select up to 64 documents, review frozen source versions and names, and export. Open dirty buffers take precedence over disk. Books process each chapter's resources separately and remap headings, footnotes, and included links; missing chapters block the book.

Outputs do not overwrite existing files by default. Explicit replacement requires a new frozen review. Results remain per item; retry revalidates sources and preserves successful outputs. Cancel retains already completed files. Project settings and chapters live in `.markcaptain/export.json`; saving them does not launch export or persist untitled text.

See [Export / 导出与成册](https://github.com/yulianjie/MarkCaptain/wiki/%E5%AF%BC%E5%87%BA%E4%B8%8E%E6%88%90%E5%86%8C).

## Storage, recovery, and updates

Optional providers are self-hosted MarkCaptain Sync, Git, WebDAV, and trusted native storage plugins. Configure/test connections in Preferences, then use manual synchronization and inspect results. Local save success is separate from remote success. Do not assume a complete background retry scheduler or general remote-version browser from design plans.

Git supports fetch, fast-forward pull, and non-force push without auto-commit/reset. Divergence can enter an explicitly requested review merge. Agent-assisted conflict editing remains reviewed; the Agent cannot commit/push. WebDAV relies on version/ETag checks and refuses unsafe overwrites. A native plugin runs with your OS account's permissions.

Independent local history records named document snapshots on open/save/changed-content checks: default 60-second interval, 30 days, and 256 MiB total. Compare, copy, restore as a new tab, or restore the current buffer after preserving its prior content. Restoration is undoable and still needs saving. History is path-based, bounded, and separate from crash drafts, Agent history, and transient multi-document originals.

Automatic update checking defaults to about ten seconds after startup and every four hours. Automatic failures stay quiet; manual checks report errors. Download/install requires a click and signature verification. Save work and close other editor windows before installation; failed/cancelled saves pause installation. Download completion is distinct from installation success.

See [Storage and recovery / 同步与数据安全](https://github.com/yulianjie/MarkCaptain/wiki/%E5%90%8C%E6%AD%A5%E4%B8%8E%E6%95%B0%E6%8D%AE%E5%AE%89%E5%85%A8), [Preferences / 快捷键与偏好设置](https://github.com/yulianjie/MarkCaptain/wiki/%E5%BF%AB%E6%8D%B7%E9%94%AE%E4%B8%8E%E5%81%8F%E5%A5%BD%E8%AE%BE%E7%BD%AE), and [Troubleshooting / 常见问题](https://github.com/yulianjie/MarkCaptain/wiki/%E5%B8%B8%E8%A7%81%E9%97%AE%E9%A2%98).

## Report a problem

Use [Issues](https://github.com/yulianjie/MarkCaptain/issues) with the app version, OS/architecture, package type, minimal reproduction, expected/actual result, editing mode, and relevant dependency details. Distinguish browser preview, native app, and exported-reader behavior. Remove private text, keys, authentication headers, and temporary MCP credentials from examples and screenshots.
