//! MarkCaptain Tauri backend.
//!
//! Mirrors the responsibilities of the original Electron main process
//! (`upstream/src/main/`). The top-level orchestrator lives in
//! [`app::AppState`]; IPC commands are grouped under [`commands`] and wired
//! up in [`run`].

pub mod app;
pub mod cli;
pub mod commands;
pub mod error;
pub mod filesystem;
pub mod ipc;
pub mod menu;
pub mod preferences;
pub mod storage;
mod window_placement;

use tauri::{Emitter, LogicalSize, Manager, Size};
use tauri_plugin_window_state::StateFlags;

/// Bundle identifier — kept in sync with `tauri.conf.json` `identifier`.
/// Used to locate `preferences.json` before any Tauri plugin is initialised
/// (we need to know whether to restore the window's saved size *before* the
/// window-state plugin is built, but at that point the store plugin isn't
/// available yet).
const BUNDLE_IDENTIFIER: &str = "io.github.yulianjie.markcaptain";

/// Reads the `rememberWindowSize` preference straight off disk. Falls back
/// to `false` (don't restore size — every launch uses the conf default) if
/// anything fails. This mirrors `tauri-plugin-store`'s on-disk layout:
/// `app_data_dir() / "preferences.json"`.
fn load_remember_window_size_pref() -> bool {
    // tauri-plugin-store resolves relative stores against AppData, not
    // AppConfig. These differ under XDG on Linux.
    let Some(data_dir) = dirs::data_dir() else {
        return false;
    };
    let path = preferences::store::path_from_data_dir(&data_dir, BUNDLE_IDENTIFIER);
    let Ok(content) = std::fs::read_to_string(&path) else {
        return false;
    };
    let Ok(v): Result<serde_json::Value, _> = serde_json::from_str(&content) else {
        return false;
    };
    v.get("rememberWindowSize")
        .and_then(|x| x.as_bool())
        .unwrap_or(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();

    let remember_window_size = load_remember_window_size_pref();
    // When the user hasn't opted in, drop SIZE from the restored state set so
    // every launch uses the conf-default 1200×900 (4:3). Position and the
    // maximized/fullscreen flags are still restored so the window opens
    // where the user left it. The renderer owns first visibility so geometry
    // can be checked after restoration, before the first painted frame.
    let window_state_flags = if remember_window_size {
        StateFlags::all() - StateFlags::VISIBLE
    } else {
        StateFlags::all() - StateFlags::SIZE - StateFlags::VISIBLE
    };

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_cli::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags)
                .build(),
        );

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            tracing::info!(?argv, ?cwd, "second instance launched, forwarding to main");
            // Pick a target: the focused window if any, else "main".
            // We target events at one window so a second instance's file
            // doesn't get opened in every editor window simultaneously.
            let target = app
                .webview_windows()
                .into_iter()
                .find(|(label, w)| {
                    (label.as_str() == "main" || label.starts_with("editor-"))
                        && w.is_focused().unwrap_or(false)
                })
                .map(|(label, _)| label)
                .unwrap_or_else(|| "main".into());
            if let Some(window) = app.get_webview_window(&target) {
                tauri::async_runtime::spawn(async move {
                    let _ = window_placement::show(&window, None);
                });
            }
            for arg in argv.iter().skip(1) {
                if arg.starts_with("--") || arg.starts_with('-') {
                    continue;
                }
                let p = std::path::PathBuf::from(arg);
                if p.exists() && p.is_file() {
                    if let Some(win) = app.get_webview_window(&target) {
                        let _ = win.emit("mt://window/open-file", serde_json::json!({ "path": p }));
                    }
                }
            }
            let payload = ipc::events::SecondInstance {
                argv,
                cwd: cwd.into(),
            };
            let _ = app.emit("mt://second-instance", payload);
        }));
        // Updater plugin: registered so the renderer can call check()/
        // downloadAndInstall(). With `pubkey` empty in tauri.conf.json the
        // check itself gracefully fails until release signing is set up —
        // the UI just reports "no update available".
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .manage(app::AppState::default())
        .manage(commands::agent::AgentState::default())
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                commands::agent::cancel_window(window.app_handle(), window.label());
            }
            if matches!(event, tauri::WindowEvent::Focused(true)) {
                let app = window.app_handle().clone();
                let label = window.label().to_owned();
                // Never perform geometry queries inside the native event callback.
                tauri::async_runtime::spawn(async move {
                    if let Some(window) = app.get_webview_window(&label) {
                        if let Err(error) = window_placement::ensure_reachable(&window, None) {
                            tracing::debug!(%error, "window recovery on focus deferred");
                        }
                    }
                });
            }
        })
        .manage(menu::FormatMenuHandles::default())
        .invoke_handler(markcaptain_handler!())
        .setup(move |app| {
            // HiDPI-aware 4:3 clamp. Runs every launch when the user hasn't
            // opted in to remembering window size — the conf-default 1200×900
            // is in effect, and on smaller monitors it needs to scale down.
            // When `rememberWindowSize` IS on, only run on first launch (no
            // saved geometry yet); subsequent launches restore whatever the
            // user last had.
            if let Some(window) = app.get_webview_window("main") {
                commands::window::install_editor_workspace_cleanup(&window);
                // tauri-plugin-window-state saves to `app_config_dir()`, so
                // detect first launch against the same path. (On Windows
                // app_config_dir == app_data_dir, but they diverge on
                // macOS/Linux — the old code looked at the wrong dir.)
                let should_clamp = if remember_window_size {
                    let state_path = app
                        .path()
                        .app_config_dir()
                        .ok()
                        .map(|d| d.join(".window-state.json"));
                    state_path.as_ref().map_or(true, |p| !p.exists())
                } else {
                    true
                };

                if should_clamp {
                    if let Ok(Some(monitor)) =
                        window.current_monitor().and_then(|monitor| match monitor {
                            Some(monitor) => Ok(Some(monitor)),
                            None => window.primary_monitor(),
                        })
                    {
                        let scale = monitor.scale_factor();
                        let logical_w = monitor.size().width as f64 / scale;
                        let logical_h = monitor.size().height as f64 / scale;
                        if logical_h < 950.0 || logical_w < 1250.0 {
                            let mut target_h = (logical_h * 0.9).min(900.0);
                            let mut target_w = target_h * 4.0 / 3.0;
                            // Re-derive height from width when width is the
                            // binding constraint, so the resulting box stays
                            // 4:3 instead of squashing to ~1.29:1.
                            let max_w = logical_w * 0.95;
                            if target_w > max_w {
                                target_w = max_w;
                                target_h = target_w * 3.0 / 4.0;
                            }
                            let _ = window.set_size(Size::Logical(LogicalSize {
                                width: target_w,
                                height: target_h,
                            }));
                            let _ = window.center();
                        }
                    }
                }
            }

            menu::install(app)?;
            app::on_startup(app)?;
            window_placement::watch_displays(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn init_logging() {
    use tracing_subscriber::{fmt, prelude::*, EnvFilter};

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,markcaptain_lib=debug,tauri=info"));

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(true))
        .init();
}
