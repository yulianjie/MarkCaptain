# IPC migration map: Electron channels → Tauri commands/events

This document is the canonical mapping from the legacy Electron IPC surface
(`ipcMain.on` / `ipcMain.handle` in `upstream/src/main/`, and the matching
`ipcRenderer.send/invoke/on` calls in `src/renderer/`) to the new Tauri API.

Three things were unified during the rewrite:

1. **`renderer → main`** (write-style commands): `ipcRenderer.send` and
   `ipcMain.on` → Tauri `invoke('cmd_*')` + `#[tauri::command]`. We do **not**
   use the fire-and-forget `send`-style pattern in the new app; every command
   is awaitable and returns `AppResult<T>`.
2. **`renderer → main` (request/response)**: `ipcRenderer.invoke` /
   `ipcMain.handle` → same `invoke('cmd_*')`. Same shape, just consolidated.
3. **`main → renderer`** broadcasts: `BrowserWindow.webContents.send` → Tauri
   `emit('mt://<area>/<action>', payload)` + renderer-side `listen(...)`.

Channel naming convention:
- **Commands** (renderer-initiated): `cmd_<area>_<verb>` (snake_case).
- **Events** (main-initiated): `mt://<area>/<action>` (URL-style for grep-ability).

## File operations

| Original channel | Direction | New |
|---|---|---|
| `AGANI::ask-for-open-files` (was on the menu side) | renderer→main | `invoke('cmd_open_files')` |
| `mt::response-file-save` | renderer→main | `invoke('cmd_save_markdown', { path, markdown, options })` |
| `mt::response-file-save-as` | renderer→main | `invoke('cmd_save_as_dialog')` then `cmd_save_markdown` |
| `mt::save-tabs` | renderer→main | loop on renderer side calling `cmd_save_markdown` |
| `mt::save-and-close-tabs` | renderer→main | renderer orchestrates `cmd_save_markdown` + window close |
| `mt::rename` | renderer→main | `invoke('cmd_rename_file', { from, to })` |
| `mt::response-file-move-to` | renderer→main | `invoke('cmd_rename_file')` (move = rename) |
| `mt::window::drop` | renderer→main | Tauri's webview drop event handles this; `cmd_read_markdown` per dropped file |
| `mt::cmd-open-file` | renderer→main | `invoke('cmd_open_files')` |
| `mt::cmd-open-folder` | renderer→main | `invoke('cmd_open_folder')` |
| `mt::cmd-import-file` | renderer→main | `invoke('cmd_open_files')` + renderer-side conversion |
| `mt::ask-for-image-auto-path` | renderer→main | `invoke('cmd_save_image_local')` |
| `mt::ask-for-open-project-in-sidebar` | renderer→main | `invoke('cmd_open_folder')` + `cmd_watch_folder` |
| `mt::format-link-click` | renderer→main | `tauri-plugin-shell::open()` directly from renderer |

## Workspace / watcher

| Original | New |
|---|---|
| `watcher-watch-file` | `invoke('cmd_watch_folder', { path })` (folder-level only — file-level watching collapses into folder watcher) |
| `watcher-watch-directory` | `invoke('cmd_watch_folder', { path })` |
| `watcher-unwatch-file` | `invoke('cmd_unwatch_folder')` |
| `watcher-unwatch-directory` | `invoke('cmd_unwatch_folder')` |
| `watcher-unwatch-all-by-id` | renderer tracks workspaces and unwatches each |
| (FS change broadcast) | event `mt://fs/change` with `FileWatchEvent` payload |
| (file list) | `invoke('cmd_list_directory', { path })` |

## Window management

| Original | New |
|---|---|
| `mt::open-file` (open into target window) | Per-window Rust queue; `mt://window/open-file` wakes the target editor, which invokes `cmd_take_pending_open_files` |
| `mt::close-window` | `invoke('cmd_close_window')` |
| `mt::window-toggle-always-on-top` | `invoke('cmd_set_always_on_top')` |
| `app-create-editor-window` | `invoke('cmd_new_window')` |
| `app-create-settings-window` | `invoke('cmd_open_settings')` |
| First renderer paint | `invoke('cmd_show_window')` validates geometry, then reveals the calling window |
| `window-close-by-id` | `invoke('cmd_close_window', { label })` |
| `window-reload-by-id` | `WebviewWindow.reload()` via Tauri JS API |
| `mt::app-try-quit` | `invoke('process:plugin:exit')` from `@tauri-apps/plugin-process` |

Opening Preferences reuses its existing window on the invoking editor's monitor.
File-association launches and second-instance forwards enqueue paths before
notifying the target editor. After session restoration, the editor subscribes
and immediately drains its queue; later notifications trigger serialized drains.
Startup does not rely on a fixed delay or transient DOM events, and an explicit
file open selects its tab after restored tabs. Relative second-instance paths
resolve against the launching process's working directory.
Rust checks title-bar/content visibility against monitor work areas before showing
or refocusing windows, and after display layout changes. Background recovery
preserves minimized windows and does not take focus.

Native geometry smoke test: `cargo run --manifest-path src-tauri/Cargo.toml
--example window_placement_check`. This creates disposable blank windows and
checks recovery on the connected monitors without changing the display layout
or reading/writing the user's preferences.

## Preferences / user data

| Original | New |
|---|---|
| `mt::ask-for-user-preference` | `invoke('cmd_get_preferences')` |
| `mt::set-user-preference` | `invoke('cmd_set_preferences', { patch })` |
| `mt::user-preference` (broadcast) | event `mt://prefs/changed` |
| `mt::ask-for-user-data` | `invoke('cmd_get_user_data')` |
| `mt::set-user-data` | `invoke('cmd_set_user_data', { patch })` |
| `mt::ask-for-image-path` | `invoke('cmd_get_preference', { key: 'imageFolderPath' })` |
| `mt::ask-for-modify-image-folder-path` | `invoke('cmd_set_preference', { key, value })` |
| `set-image-folder-path` | same as above |
| `broadcast-preferences-changed` | event `mt://prefs/changed` |
| `broadcast-user-data-changed` | event `mt://userdata/changed` |
| `mt::ask-for-user-themes` | `invoke('cmd_list_directory', { path: userThemesDir })` |
| `mt::open-user-themes-folder` | `tauri-plugin-shell::open()` |
| `mt::reload-user-themes` | renderer reloads from disk; no IPC |
| `mt::select-default-directory-to-open` | `invoke('cmd_open_folder')` + `cmd_set_preference` |
| `mt::cmd-toggle-autosave` | `invoke('cmd_set_preference', { key: 'autoSave', value })` |

## Menu / view state

| Original | New |
|---|---|
| `mt::update-line-ending-menu` | event `mt://menu/line-ending` (main owns the menu state in Rust) |
| `mt::update-format-menu` | event `mt://menu/format` |
| `mt::update-sidebar-menu` | event `mt://menu/sidebar` |
| `mt::view-layout-changed` | renderer pushes via `cmd_set_preference` |
| `mt::editor-selection-changed` | event `mt://editor/selection-changed` |
| `mt::add-recently-used-document` | `invoke('cmd_set_preference', ...)` + Tauri recent docs API |
| `menu-add-recently-used` | same |
| `menu-clear-recently-used` | `invoke('cmd_set_preference', { key: 'recents', value: [] })` |

## Keybindings

| Original | New |
|---|---|
| `mt::request-keybindings` | renderer reads the canonical declarations from `src/common/shortcut-registry.json`; user overrides are hydrated from the `keybindings` preference |
| `mt::open-keybindings-config` | replaced by the in-app **Preferences → Keybindings** recorder; there is no external keybindings file |
| `mt::keybinding-get-pref-keybindings` | `invoke('cmd_get_preference', { key: 'keybindings' })`; values are stored under `keybindings` in `preferences.json` |
| `mt::keybinding-save-user-keybindings` | `invoke('cmd_set_preference', { key: 'keybindings', value })`; Rust validates and normalizes the map before persistence |
| `mt::keybinding-get-keyboard-info` | `@tauri-apps/plugin-os::platform()` / `arch()` |
| `mt::keybinding-debug-dump-keyboard-info` | renderer-side log only |

## Spellchecker

| Original | New |
|---|---|
| `mt::spellchecker-remove-word` | `invoke('cmd_spellcheck_remove_word')` |
| `mt::spellchecker-switch-language` | renderer-side preference change; `cmd_spellcheck_words` re-queries |
| `mt::spellchecker-get-available-dictionaries` | `invoke('cmd_spellcheck_available_dictionaries')` |
| `mt::spellchecker-set-enabled` | `invoke('cmd_set_preference', { key: 'spellcheckerEnabled' })` |
| `mt::spellchecker-get-custom-dictionary-words` | renderer reads from store |

## Export / print

| Original | New |
|---|---|
| `mt::response-export` | `invoke('cmd_export_html')` or `cmd_export_pdf` |
| `mt::response-print` | webview's `window.print()` directly |
| `mt::open-pdf` | `tauri-plugin-shell::open()` |

## Errors / lifecycle

| Original | New |
|---|---|
| `mt::handle-renderer-error` | renderer calls `console.error` + optional `tracing` via `invoke('cmd_log_error')` (TODO) |
| `mt::NEED_UPDATE` | event `mt://updater/available` |
| `mt::check-for-update` | `tauri-plugin-updater` from renderer |
| `screen-capture` / `mt::make-screenshot` | `tauri-plugin-screenshots` (separate crate, TBD) |
| `mt::open-setting-window` | `invoke('cmd_open_settings')` |
| `mt::show-command-palette` | event `mt://palette/show` |
| `mt::toggle-view-mode-entry` | event `mt://view/toggle` |

## Drag/drop into renderer

The Electron `file-drop` event on `BrowserWindow` is replaced by Tauri's
`dragDrop` window event from the webview. Renderer listens via
`getCurrentWebview().onDragDropEvent(...)`.

## Notes

- All `*-by-id` channels referenced the Electron `BrowserWindow.id` integer.
  In Tauri we use string `label`s instead; the renderer can read its own via
  `getCurrentWebviewWindow().label`.
- Broadcasts use `emit(...)`; targeted events use `emit_to(...)` and listeners
  with a matching event target. The writing agent uses `WebviewWindow` targets.
- All command payloads are JSON-serialisable via serde; no path strings need
  to be normalised (Rust `PathBuf` round-trips through serde as a string).
# Desktop backdrop extension

`cmd_window_enable_backdrop` negotiates native desktop blur for the calling
editor window and returns a boolean. `mt://window/backdrop` emits a boolean when
Linux compositor capabilities change. See [DESKTOP_BLUR.md](DESKTOP_BLUR.md).
# Writing Agent

The writing agent is native to the Tauri edition (no legacy Electron channel).

| Renderer command / event | Purpose |
| --- | --- |
| `cmd_agent_get_config` | Read non-secret settings and key-presence flag |
| `cmd_agent_save_config` | Save base URL / model and optionally update or remove OS-vault credential |
| `cmd_agent_test_connection` | Send a test message with the saved model settings |
| `cmd_agent_start` | Start a bounded writing-agent run on one attachment or an explicit selected set of editable snapshots |
| `cmd_agent_document_versions` | Read bounded disk fingerprints/content hashes for already authorized Markdown paths; no writes or new grants |
| `cmd_agent_history_settings` | Read local-history opt-in (default false) |
| `cmd_agent_history_set_enabled` | Persist history opt-in; existing records remain until explicitly deleted |
| `cmd_agent_history_list` | List bounded local archive metadata without broadcasting transcripts |
| `cmd_agent_history_read` | Read and validate one UUID record |
| `cmd_agent_history_write` | Atomically write one record with optimistic revision checking; rejects disabled storage, stale versions and tombstones |
| `cmd_agent_history_delete` | Replace a matching revision with a content-free tombstone |
| `cmd_agent_cancel` | Cancel only the calling window's matching request |
| `cmd_agent_external_grant` | Explicitly authorize one live renderer document; create an in-memory loopback capability and return bundled stdio adapter path |
| `cmd_agent_external_revoke` | Revoke only the calling window's matching external document grant |
| `cmd_agent_external_take` | Calling window polls its bounded external-request queue and renews the renderer lease |
| `cmd_agent_external_reply` | Calling window answers its matching pending request after live-buffer/version/review validation |
| `cmd_agent_list_skills` | List built-in/imported skill metadata and enabled state |
| `cmd_agent_import_skill` | Open native SKILL.md picker and import its bounded text package |
| `cmd_agent_set_skill_enabled` | Persist a skill's enabled state |
| `cmd_agent_remove_skill` | Remove an imported copy without changing its source files |
| `cmd_agent_read_skill` | Read skill instructions and reference filenames for the management UI |
| `mt://agent/event` | Window-targeted delta, tool, proposal and terminal events, correlated by request ID |


Agent requests may include `references: [{documentId, name, markdown}]` (up to 8 read-only snapshots, 2 MB each / 4 MB combined). `read_document`, `search_document`, and `cite_document` accept `documentId`; in single-document mode omitted or `current` targets the current attachment. Unknown IDs and attempts to edit references are rejected. Citation event JSON includes `documentId`, exact lines, label and quote. The initial model payload contains reference metadata only; bodies are demand-loaded. History records use schemaVersion 1 and stable UUID/revision metadata; full immutable snapshots are interned with per-use ranges. Keys and image bytes are never stored in history.


## A07 selected-document revision

`AgentRequest.editableDocuments?: [{documentId, name, markdown, snapshotId, offset}]` selects 1–8 immutable open-document snapshots (2,000,000 UTF-8 bytes each / 4,000,000 total). IDs are `edit-{UUID}`, `snapshotId` must exactly equal `${requestId}:${documentId}`, and `offset` must be zero. Multi-document mode requires `context: null`, no `editRange`, and `readOnly: false`. Unknown/duplicate IDs and malformed task bindings are rejected.

`read_document`, `search_document`, `cite_document`, and `propose_edit` require an explicit `documentId` in this mode. Only the selected catalog IDs may receive edits; `current`, unselected, reference and project IDs cannot. References/project sources remain read-only. The initial catalog contains metadata only. Successful selected-document reads/citations and the context ledger carry their exact document/snapshot identity; proposals carry authoritative `documentId`. Rust removes routing before proposal validation and adds the validated ID to output. That output-only field is rejected in deserialized external proposal bodies. Single-document tool schemas remain unchanged.

Each selected document may emit one proposal with up to 32 validated non-overlapping changes; one task may therefore emit multiple `proposal` events. The renderer binds each to its own frozen target and uses ordinary per-document buffer transactions. No save/delete/rename/create/Git/Shell tool is added. Normal requests retain a 10-round loop; selected tasks use `10 + 3 × (n − 1)` rounds, capped at 31, within the existing 300-second task limit.

Typed wrapper: `agentDocumentVersions(paths: string[], encodings?: Record<string, string>): Promise<AgentDocumentVersion[]>` invokes `cmd_agent_document_versions` with `{paths, encodings}`. Results preserve input order and contain `{path, fingerprint: string|null, contentHash: string|null, error?: string}`. Paths are canonical when available. Optional bounded encoding labels select decoding for corresponding input paths only; omitted labels use the existing detector. They do not authorize additional sources.

The probe requires existing process document-source capability from normal editor reads/saves, accepts at most eight unique Markdown paths, and bounds reads to 2 MB per file / 4 MB total. `fingerprint` is SHA-256 of original disk bytes; `contentHash` is SHA-256 of losslessly decoded Markdown normalized to LF. Missing/unreadable/undecodable paths return null hashes and stable safe errors; invalid scope or limits reject the request. It performs no writes and grants no access. The renderer compares the first content hash against its saved baseline, then rechecks raw fingerprints and editor identities immediately before Apply/Revert. Untitled targets have no disk probe.

Multi-document state/snapshots are session-only, outside ordinary Agent history and without restart replay. See [A07 workflows](A07_WORKFLOWS.md) and [validation status](A07_VALIDATION.md).


## Notebook and independent local versions

All wrappers are in `src/services/tauri-invoke.ts`; none is exposed as an Agent tool.

| Command | Contract |
| --- | --- |
| `cmd_notes_list`, `cmd_notes_cancel` | Scan only an open canonical workspace on a blocking worker; cancellation scoped by window and request UUID |
| `cmd_notes_read` | Bounded, canonical in-project read with decoded document and SHA-256 fingerprint |
| `cmd_notes_create` | Project-relative `.md`, durable temporary write then exclusive publication, no overwrite or partial target |
| `cmd_notes_config` | Read/write project template and daily settings |
| `cmd_notes_move` | `changes` plus complete `checks: [{relative, expected}]` Markdown manifest; validate path set and byte hashes, journal original bytes, atomic reference writes and move, rollback on failure |
| `cmd_notes_restore_transaction` | UUID journal, matching open root, preflight subsequent changes; returns `{source, destination, files: [{relative, markdown}]}` for deterministic renderer synchronization; original disk bytes preserved |
| `cmd_local_history_capture` | Separate local content-addressed Markdown versions |
| `cmd_local_history_list`, `cmd_local_history_read` | Metadata-only list; bounded selected body with checksum validation |
| `cmd_local_history_settings` | Personal interval, retention and global space limit |

Parsing and structured queries use background workers and one shared notebook parser. Existing `mt://fs/change` events invalidate disk entries. Agent attachment and review contracts are unchanged.

## Frozen document and project export

Typed wrappers remain in `src/services/tauri-invoke.ts`; these are editor workflows, not Agent tools.

| Command/event | Contract |
| --- | --- |
| `cmd_export_load_config`, `cmd_export_save_config` | Versioned `.markcaptain/export.json` in an open canonical project; fingerprint conflicts, unknown-field retention by the renderer merge, final serialized size bound; optional `projectExport` explicit plan |
| `cmd_export_project_list` | Calling-window-owned project only; stable bounded candidate list; reject truncation and invalid config; exclude configured outputs, build/cache and symlinks/junctions |
| `cmd_export_project_snapshot` | Explicit relative paths plus bounded dirty buffers; immutable ordered content revisions; per-source errors, no source writes; post-worker ownership/path revalidation before granting exact successful sources their existing resource-read capability |
| `cmd_export_read_resource` | Authorized Markdown source; resolve local resource against its own base, bounded read and optional canonical project fence; no HTTP fetching |
| `cmd_export_save_dialog` | Native single-file save selection and one-use output grant |
| `cmd_export_preflight` | Shared snapshot/profile/dependency/resource diagnostics; checks `overwrite=false` without replacing existing files |
| `cmd_export_start` | Frozen prepared static HTML and source snapshot; HTML or actual Pandoc files; `overwrite=false` publishes without clobbering another writer; project PDF uses Pandoc |
| `cmd_export_cancel` | Cancel the calling window's task UUID; completed files are not rolled back |
| `mt://export/progress` | Task UUID, sequence and stage for one backend write; renderer aggregates project per-item results |

Project orchestration freezes all selected source versions first. Each chapter is rendered/resource-prepared independently, then batch links or book DOM are composed. Untitled sources stay in the current renderer task and are omitted from persisted relative plans. Book requests carry a bounded source manifest as snapshot metadata and the composed HTML as output input; Markdown bodies are not concatenated to produce a book. Retry rechecks the source manifest and does not rewrite successful items.
