//! Window-level commands.

use serde::Deserialize;
use serde_json::Value;
use tauri::{
    AppHandle, Manager, State, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use crate::app::AppState;
use crate::error::{AppError, AppResult};

/// Accept only the explicit native palettes. Tauri's Theme deserializer maps
/// unknown strings to Light, which would silently hide a renderer typo.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NativeWindowTheme {
    Light,
    Dark,
}

impl From<NativeWindowTheme> for Theme {
    fn from(theme: NativeWindowTheme) -> Self {
        match theme {
            NativeWindowTheme::Light => Self::Light,
            NativeWindowTheme::Dark => Self::Dark,
        }
    }
}

/// User CSS needs the renderer's computed background to determine brightness.
/// Such windows stay hidden until that resolution and native synchronization
/// have completed. Known palettes can set their title bar during construction.
fn initial_window_theme(preferences: &Value) -> Option<Theme> {
    if preferences.get("autoSwitchTheme").and_then(Value::as_u64) == Some(1) {
        return None;
    }
    match preferences.get("theme").and_then(Value::as_str) {
        Some("dark" | "one-dark" | "material-dark") => Some(Theme::Dark),
        Some("light" | "github-blue" | "graphite-light" | "ulysses-light") => Some(Theme::Light),
        _ => None,
    }
}

fn initial_window_theme_from_snapshot(snapshot: AppResult<Value>) -> Option<Theme> {
    match snapshot {
        Ok(preferences) => initial_window_theme(&preferences),
        Err(error) => {
            tracing::warn!(%error, "initial settings theme unavailable; using system appearance");
            None
        }
    }
}

#[tauri::command]
pub fn cmd_window_set_theme(
    window: WebviewWindow,
    theme: Option<NativeWindowTheme>,
) -> AppResult<()> {
    // Use the injected caller instead of accepting an arbitrary window label.
    // None clears the manual override so later OS changes remain automatic.
    window
        .set_theme(theme.map(Theme::from))
        .map_err(AppError::from)
}

#[tauri::command]
pub async fn cmd_new_window(app: AppHandle, label: Option<String>) -> AppResult<()> {
    let label = label.unwrap_or_else(|| format!("editor-{}", uuid::Uuid::new_v4()));
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()));
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    let builder = builder.transparent(true);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    let window = builder
        .title("MarkCaptain")
        .inner_size(1200.0, 900.0)
        .min_inner_size(800.0, 600.0)
        .visible(false)
        .center()
        .build()
        .map_err(|e| AppError::Other(e.to_string()))?;
    install_editor_workspace_cleanup(&window);
    crate::menu::configure_editor_chrome(&app)?;
    Ok(())
}

#[tauri::command]
pub fn cmd_close_window(app: AppHandle, label: String) -> AppResult<()> {
    if let Some(win) = app.get_webview_window(&label) {
        win.close().map_err(|e| AppError::Other(e.to_string()))?;
    }
    Ok(())
}

fn ensure_editor_window(label: &str) -> AppResult<()> {
    if label == "main" || label.starts_with("editor-") {
        Ok(())
    } else {
        Err(AppError::InvalidArgument(
            "only an editor window may invoke this command".into(),
        ))
    }
}

/// Called after session restoration and installation of the file-open listener.
#[tauri::command]
pub fn cmd_take_pending_open_files(
    window: WebviewWindow,
    state: State<'_, crate::file_open::PendingFileOpens>,
) -> AppResult<Vec<std::path::PathBuf>> {
    ensure_editor_window(window.label())?;
    Ok(state.take(window.label()))
}

/// Release all workspace ownership leases even when renderer teardown cannot
/// send `cmd_unwatch_folder` (process crash, forced destroy, or app shutdown).
pub fn install_editor_workspace_cleanup(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let owner = window.label().to_string();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            app.state::<AppState>()
                .unregister_all_workspaces_for_owner(&owner);
        }
    });
}

/// Destroy an editor only after its renderer has resolved every unsaved tab.
///
/// Like Preferences, a normal `close()` is not reliably re-entrant after a
/// cancelled `CloseRequested` callback on Windows. Restricting this command to
/// editor labels keeps the destructive step out of unrelated utility windows.
#[tauri::command]
pub fn cmd_destroy_editor_window(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> AppResult<()> {
    ensure_editor_window(window.label())?;
    let owner = window.label().to_string();
    window.destroy().map_err(AppError::from)?;
    // The Destroyed hook above is the general cleanup path. Keep this explicit
    // removal as an idempotent guarantee for the renderer-authorized destroy
    // command even on platforms that deliver lifecycle callbacks later.
    state.unregister_all_workspaces_for_owner(&owner);
    Ok(())
}

fn ensure_settings_window(label: &str) -> AppResult<()> {
    if label == "settings" {
        Ok(())
    } else {
        Err(AppError::InvalidArgument(
            "only the settings window may invoke cmd_destroy_settings_window".into(),
        ))
    }
}

/// Destroy Preferences after its renderer has flushed pending drafts.
///
/// A normal `close()` cannot be re-entered reliably from a cancelled
/// `CloseRequested` callback on Windows. Keeping the destructive operation in
/// Rust also avoids granting the generic window-destroy capability to every
/// editor renderer.
#[tauri::command]
pub fn cmd_destroy_settings_window(window: WebviewWindow) -> AppResult<()> {
    ensure_settings_window(window.label())?;
    window.destroy().map_err(AppError::from)
}

#[tauri::command]
pub fn cmd_set_always_on_top(app: AppHandle, label: String, on_top: bool) -> AppResult<()> {
    if let Some(win) = app.get_webview_window(&label) {
        win.set_always_on_top(on_top)
            .map_err(|e| AppError::Other(e.to_string()))?;
    }
    Ok(())
}

#[tauri::command]
pub fn cmd_set_menu_accelerators_enabled(app: AppHandle, enabled: bool) -> AppResult<()> {
    crate::menu::set_accelerators_enabled(&app, enabled)
}

#[tauri::command]
pub async fn cmd_show_window(window: WebviewWindow) -> AppResult<()> {
    crate::window_placement::show(&window, None)?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_open_settings(app: AppHandle, window: WebviewWindow) -> AppResult<()> {
    let preferred = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let label = "settings";
    if let Some(win) = app.get_webview_window(label) {
        // Preferences is a utility window, not an editor window. Reassert the
        // menu-less contract before showing an existing instance in case an
        // app-wide menu rebuild occurred while it was hidden/minimized.
        win.remove_menu()
            .map_err(|e| AppError::Other(e.to_string()))?;
        crate::window_placement::show(&win, preferred.as_ref())?;
        return Ok(());
    }
    // A corrupt/unreadable preference snapshot must not make the utility
    // window unreachable. Its renderer retains the existing defaults fallback.
    let native_theme = initial_window_theme_from_snapshot(crate::preferences::store::get_all(&app));
    let window = WebviewWindowBuilder::new(
        &app,
        label,
        WebviewUrl::App("index.html#/preferences".into()),
    )
    .title("Preferences")
    .theme(native_theme)
    .inner_size(900.0, 700.0)
    .min_inner_size(760.0, 560.0)
    // The renderer shows the window after preferences/i18n are hydrated,
    // preventing an English/default-theme first-frame flash.
    .visible(false)
    .build()
    .map_err(|e| AppError::Other(e.to_string()))?;
    // App-level menus are inherited by newly-created windows on Windows and
    // Linux. Preferences must remain a menu-less utility window.
    window
        .remove_menu()
        .map_err(|e| AppError::Other(e.to_string()))?;
    if let Err(error) = crate::window_placement::ensure_reachable(&window, preferred.as_ref()) {
        tracing::warn!(%error, "initial settings placement deferred until show");
    }
    // Renderer teardown cannot reliably await an IPC call. Restore the
    // app-wide menu accelerator lease from Rust after Preferences is actually
    // destroyed. CloseRequested may be cancelled while a draft save fails.
    let restore_app = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            if let Err(error) = crate::menu::set_accelerators_enabled(&restore_app, true) {
                tracing::warn!(%error, "failed to restore menu accelerators after settings close");
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_editor_window, ensure_settings_window, initial_window_theme,
        initial_window_theme_from_snapshot, NativeWindowTheme,
    };
    use serde_json::json;
    use tauri::Theme;

    #[test]
    fn initial_settings_theme_uses_known_palettes_and_preserves_system_mode() {
        for theme in ["dark", "one-dark", "material-dark"] {
            assert_eq!(
                initial_window_theme(&json!({"theme": theme, "autoSwitchTheme": 2})),
                Some(Theme::Dark)
            );
        }
        for theme in ["light", "github-blue", "graphite-light", "ulysses-light"] {
            assert_eq!(
                initial_window_theme(&json!({"theme": theme, "autoSwitchTheme": 2})),
                Some(Theme::Light)
            );
        }
        assert_eq!(
            initial_window_theme(&json!({"theme": "dark", "autoSwitchTheme": 1})),
            None
        );
        assert_eq!(
            initial_window_theme(&json!({"theme": "custom-dark-name", "autoSwitchTheme": 2})),
            None
        );
    }

    #[test]
    fn native_theme_command_rejects_unknown_palettes() {
        assert!(serde_json::from_value::<NativeWindowTheme>(json!("dark")).is_ok());
        assert!(serde_json::from_value::<NativeWindowTheme>(json!("light")).is_ok());
        assert!(serde_json::from_value::<NativeWindowTheme>(json!("not-a-theme")).is_err());
    }

    #[test]
    fn initial_settings_theme_read_failure_falls_back_without_blocking_window_creation() {
        assert_eq!(
            initial_window_theme_from_snapshot(Err(crate::error::AppError::Other(
                "preference snapshot unreadable".into()
            ))),
            None
        );
    }

    #[test]
    fn editor_destroy_command_rejects_non_editor_windows() {
        assert!(ensure_editor_window("main").is_ok());
        assert!(ensure_editor_window("editor-123").is_ok());
        assert!(ensure_editor_window("settings").is_err());
        assert!(ensure_editor_window("editor").is_err());
    }

    #[test]
    fn settings_destroy_command_rejects_non_settings_windows() {
        assert!(ensure_settings_window("settings").is_ok());
        assert!(ensure_settings_window("main").is_err());
        assert!(ensure_settings_window("editor-123").is_err());
    }
}
