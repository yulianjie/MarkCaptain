# MarkCaptain User Guide

[Wiki home](Home) · [简体中文](使用指南) · [Download](https://github.com/yulianjie/MarkCaptain/releases/latest) · [Report an issue](https://github.com/yulianjie/MarkCaptain/issues)

This guide covers the Tauri edition published from [`yulianjie/MarkCaptain`](https://github.com/yulianjie/MarkCaptain).

## 1. Install and launch

Download the package for your platform from [GitHub Releases](https://github.com/yulianjie/MarkCaptain/releases/latest):

| Platform | Package |
| --- | --- |
| Windows x64 | NSIS `.exe` or MSI |
| Linux x64 | AppImage, DEB, or RPM |
| macOS Apple Silicon | ARM64 `.app.tar.gz` |
| macOS Intel | x64 `.app.tar.gz` |

Windows 11 normally includes WebView2. Windows 10 may need the Microsoft WebView2 Runtime. On macOS, follow the normal Gatekeeper prompts for an independently distributed app.

MarkCaptain saves documents to paths you choose and does not require an account. Save all open documents before updating the app.

## 2. Open documents and projects

- **New document** creates an unsaved Markdown tab. Choose a path when you first save it.
- **Open file** opens one or more Markdown files. Recently used files are available from the recent-files dialog.
- **Open folder** treats a folder as a project and enables the project tree, open-files list, outline, and project search.
- **Tabs** let you edit several documents at once. Closing a dirty tab or window asks for confirmation.
- **External changes** are watched on disk. When another program changes an open document, follow the prompt before reloading it.

The files remain ordinary Markdown, so you can keep using Git, sync folders, and your normal backup tools.

## 3. Edit Markdown

Muya provides the default WYSIWYG editing surface. Headings, lists, tables, tasks, code, quotes, links, images, footnotes, math, and other Markdown constructs render in place.

- Use **View → Source Code Mode** to switch between WYSIWYG and raw Markdown.
- Use **Edit → Find** or **Edit → Replace** in the current document.
- Use project search in the sidebar to search Markdown files in the open folder.
- Use the outline to jump between headings.
- Enable focus or typewriter mode for a quieter writing surface.
- Formatting actions are available from the toolbar, native menus, context menu, and command palette.

### Diagrams and code

Fenced code blocks support syntax highlighting. Diagram blocks include Mermaid, Flowchart, Sequence, and PlantUML formats; use the appropriate language identifier for each block.

### Images

Insert images by selecting, pasting, or dropping them. The result depends on the image preference: keep the source path, copy into a configured folder, or use a configured uploader. After moving documents or images, verify that relative references still resolve.

## 4. Command palette and shortcuts

The command palette exposes file, edit, paragraph, format, view, window, and help actions. Inspect, record, customize, or reset shortcuts under **Preferences → Shortcuts**.

Native menus, the command palette, and the editor use one shortcut registry. Because shortcuts are customizable, treat Preferences as the authoritative list for your installation.

## 5. Export and print

- **HTML** exports a styled HTML file.
- **Print / Save as PDF** opens the system print dialog and can use the operating system's PDF destination.
- **Pandoc export** can create PDF, DOCX, ODT, or EPUB after Pandoc and any required document engine are installed.

Pandoc is not bundled. If export fails, confirm that `pandoc` is on the system path, then check the PDF engine, fonts, and image references.

## 6. Writing Agent

Open **AI Assistant** from the title bar, View menu, or command palette, or use the shortcut shown in Preferences.

### Configure a model

1. Open Agent settings.
2. Choose the DeepSeek preset, a custom OpenAI-compatible endpoint, or local Ollama.
3. Enter the endpoint, model ID, and required credentials.
4. Save and send a short test message.

HTTP endpoints are allowed on trusted local networks, but prompts and credentials are not transport-encrypted. Prefer HTTPS outside a controlled network.

### Work with the Agent

- The Agent reads only the current document, selection, images, or read-only Markdown references that you explicitly attach.
- Ask it to polish, continue, explain, compare, outline, or summarize long documents in sections.
- Proposed edits appear as diffs. You decide whether to apply, dismiss, locate, or revert each change.
- Reuse an answer at the cursor, at the end of the document, over the selection, or in a new unsaved note.
- Optional conversation history is local and disabled by default. It does not store API keys or images.

The Agent cannot scan the general filesystem, run a shell, commit Git changes, search the web, or bypass review to save a document. See the [Writing Agent guide](https://github.com/yulianjie/MarkCaptain/blob/master/docs/AI_AGENT.md) for the complete safety model.

## 7. Local projects and remote storage

MarkCaptain saves the local working copy first. Optional remote storage keeps local save status separate from remote sync status.

- **MarkCaptain Sync** connects to a self-hosted service.
- **Git** supports repository validation, fetch, fast-forward pull, and non-force push. It does not reset, auto-commit, or force-push.
- **WebDAV** uses ETags for safe conditional writes and refuses unsafe automatic overwrites when the remote version cannot be checked reliably.
- **Storage plugins** are trusted native programs; install only providers you understand.

When the app reports offline state, divergence, or a conflict, preserve the local copy before choosing how to reconcile local and remote content.

## 8. Preferences

Preferences cover appearance, editing, images, spellcheck, shortcuts, Agent providers, the app icon, and desktop behavior. The interface supports English, Simplified Chinese, and Japanese, with automatic light/dark mode and several built-in themes.

After changing a shortcut, image folder, or external tool path, test it with a temporary document. Agent keys and custom authentication headers are stored in the operating-system credential store rather than ordinary preferences.

## 9. Updates, help, and issue reports

- **Help → Open Documentation** opens this project's Wiki.
- **Help → Report an Issue** opens this project's issue tracker.
- **Help → Check for Updates** is available only when a release has a verifiable updater feed. You can always check [Releases](https://github.com/yulianjie/MarkCaptain/releases/latest) directly.

Before filing an issue, collect:

1. the MarkCaptain version, operating system, and package type;
2. the shortest reliable reproduction steps;
3. expected and actual behavior;
4. screenshots or logs with private documents, API keys, authentication headers, and other secrets removed.

Search [GitHub Issues](https://github.com/yulianjie/MarkCaptain/issues) before opening a new report.

## 10. Troubleshooting

### MarkCaptain does not start on Windows

Install or repair the WebView2 Runtime and retry the latest release. Managed devices may also have application execution policies.

### Images disappear on another computer

Prefer relative paths and sync the image folder with the Markdown files. Absolute paths normally work only on the original computer.

### PDF or document export fails

System printing does not require Pandoc. Pandoc exports do require a separate Pandoc installation and the engine needed by the target format; diagnose the two paths independently.

### Agent requests fail

Check the endpoint, model ID, authentication mode, and network reachability. Local Ollama normally needs no API key; remote compatible endpoints may require a bearer key or custom header. Never paste credentials into an issue.

### A file changed outside MarkCaptain

Compare the disk version with your unsaved content before overwriting either one. Save a separate copy first when the difference is unclear.
