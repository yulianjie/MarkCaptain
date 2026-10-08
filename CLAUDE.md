# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Project Overview

MarkCaptain — a Tauri 2 + Vue 3 + Rust Markdown editor with an integrated writing Agent. It uses the same Muya WYSIWYG editor engine as MarkText, with a Rust backend, Vue 3 + Pinia, Element Plus, and Vite. **Goal: a focused native writing experience with safe, review-first Agent workflows.**

## Commands

```bash
npm install            # Install JS deps
npm run tauri:dev      # Start Vite dev server + Rust app (HMR enabled)
npm run tauri:build    # Production build → src-tauri/target/release/bundle/
npm run dev            # Vite only (frontend dev with no Tauri shell)
npm run build          # Type-check (vue-tsc) + Vite build → dist/
npm run lint           # ESLint on src/
npm run test:unit      # Vitest
npm run test:e2e       # Playwright (drives the built Tauri binary)
```

## Architecture

**Two-layer app:**

- **Rust backend** (`src-tauri/src/`): owns the filesystem, watchers, preferences store, native menu, image upload, and search. Entry at `main.rs` → `lib.rs::run()`. State lives in `app::AppState`; IPC handlers are grouped under `commands/` and registered via `commands::all()` (the macro-generated `tauri::generate_handler!`). All command results are `AppResult<T>` (`error::AppError` is `Serialize`).

- **Vue 3 frontend** (`src/`): standard SPA with Vue Router 4 + Pinia. UI library is Element Plus (auto-imported via `unplugin-vue-components`). The Muya engine (`src/muya/`) is imported as plain JS into `pages/EditorPage.vue`; it is unmodified from the upstream Electron build except for path resolution shims.

**IPC contract:** every Rust→JS exchange goes through one of two paths:

- *Renderer → Rust*: `invoke('cmd_*')` (typed wrappers in `src/services/tauri-invoke.ts`). Command names match `#[tauri::command]` function names 1:1.
- *Rust → renderer*: `app.emit('mt://...', payload)` + renderer-side `listen()` (subscriptions registered in `src/services/tauri-bridge.ts`).

The full Electron-channel → Tauri-command mapping is in `docs/IPC_MAP.md`.

## Build & toolchain

- **Vite 6**: aliases mirror the original webpack config (`@` → `src/renderer` equivalent = `src/`; `muya` → `src/muya`; `common` → `src/common`). `cytoscape/dist/cytoscape.umd.js` is aliased explicitly to keep Mermaid happy.
- **Tauri 2**: dev URL is `http://localhost:1420`, fixed. Build output is `dist/`. Capabilities for the default window live in `src-tauri/capabilities/default.json`.
- **Vue 3 + TS 5.7** with `<script setup>`. Strict mode on. Element Plus components are auto-resolved, Vue/Pinia/router APIs are auto-imported.

## Key technical details

- **Preferences schema** lives at `src/common/preferences-schema.json` so both Rust (`include_str!`) and the renderer (Vite JSON import) read the same canonical copy.
- **Encoding detection** uses `chardetng` + `encoding_rs` — same algorithm as the original `ced` native addon, no native dependency.
- **File watcher** uses `notify` + `notify-debouncer-full` (300 ms debounce). Events surface as `mt://fs/change` with a typed `FileWatchEvent` payload.
- **Muya path shim**: original Muya's `utils/index.js` uses `require('path').resolve()` once (for image-path resolution in non-Electron contexts). This is the **only** Node API call in the entire Muya source; it must be replaced with a browser shim before Phase 4 lands.
- **Persistence** via `tauri-plugin-store`. The store file `preferences.json` holds prefs at the top level and user-data under the `_userData` key.
- **PDF export** is stubbed (`cmd_export_pdf` returns an error). Tauri 2 doesn't expose `webContents.printToPDF` natively; final approach TBD between (a) a JS-side `window.print()` driver, (b) a Pandoc subprocess.

## Code style

- **Rust**: 2021 edition. Errors flow through `crate::error::AppError`. Logging via `tracing`. No `unwrap()` in command handlers.
- **TypeScript**: strict mode. Tauri commands always go through the typed wrappers in `src/services/tauri-invoke.ts` — components must not call `invoke()` directly. New commands require a wrapper *before* the first call site.
- **Vue**: `<script setup lang="ts">` only. No Options API. Pinia stores in `src/stores/`, one file per domain.

## Watch-outs

- The original Electron project's IPC channel names contain `::` (e.g. `mt::save-file`). Don't reuse those; new channels follow `mt://<area>/<action>` for events and `cmd_<area>_<verb>` for commands.
- Tauri 2 plugin crates use underscores (`tauri_plugin_clipboard_manager`) but their npm counterparts use hyphens (`@tauri-apps/plugin-clipboard-manager`).
- The frontend dev URL must match `build.devUrl` in `tauri.conf.json` AND `server.port` in `vite.config.ts` (1420). Changing one without the other breaks `tauri dev`.
