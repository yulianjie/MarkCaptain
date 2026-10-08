//! Native menu builder.
//!
//! Mirrors the legacy `upstream/src/main/menu/` tree at the top level
//! (File / Edit / Paragraph / Format / View / Window / Help). Items that
//! drive the editor emit `mt://menu/<id>` events to the focused webview;
//! the renderer maps them to the corresponding store action.
//!
//! Windows remappable shortcuts are renderer-owned; their menu labels still
//! show the configured keys without registering native accelerators. Other
//! application shortcuts are native menu accelerators. Focus-sensitive
//! editor mutations (undo/redo/select-all, headings, and inline formatting)
//! intentionally stay accelerator-free here so the renderer can route them to
//! Muya, CodeMirror, or a focused text input without mixing history systems.
//!
//! Menu labels are localised via [`i18n::MenuStrings`]. The active locale is
//! read from the persisted `language` preference at install time, and the
//! whole menu is rebuilt via [`rebuild`] whenever the renderer emits
//! `mt://prefs/changed` with a `language` patch.
//!
//! Inline-format items (bold / italic / strikethrough / inline code) are
//! [`CheckMenuItem`]s so the renderer can flip ✓ marks to reflect the
//! current cursor selection. Handles are stashed in [`FormatMenuHandles`]
//! (a [`tauri::State`]) so the `cmd_set_format_menu_state` command can find
//! them. Handles are refreshed every time the menu is rebuilt.

mod i18n;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::Deserialize;
use tauri::{
    menu::{
        CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder,
        PredefinedMenuItem, SubmenuBuilder,
    },
    App, AppHandle, Emitter, Listener, Manager, Runtime, Wry,
};

use crate::error::AppResult;
use crate::preferences::store as prefs_store;

/// Built-in theme IDs surfaced in the Theme menu. Order matches the menu.
const BUILTIN_THEMES: &[&str] = &[
    "light",
    "dark",
    "one-dark",
    "material-dark",
    "ulysses-light",
    "graphite-light",
    "github-blue",
];

/// The renderer and native menu both read this canonical declaration. Keep
/// shortcut defaults, fixed native accelerators, and the reserved set out of
/// Rust source so the two runtimes cannot silently drift.
const SHORTCUT_REGISTRY_JSON: &str = include_str!("../../../src/common/shortcut-registry.json");

#[derive(Debug, Deserialize)]
struct ShortcutRegistry {
    version: u8,
    actions: Vec<ShortcutAction>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShortcutAction {
    id: String,
    remappable: bool,
    #[serde(rename = "default")]
    default_accelerator: String,
    #[serde(default)]
    platform_alternatives: HashMap<String, Vec<String>>,
    reserved: bool,
    dispatch: ShortcutDispatch,
    #[serde(default)]
    system_owned: bool,
    #[serde(default)]
    platforms: Vec<String>,
}

#[derive(Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
enum ShortcutDispatch {
    Application,
    Native,
    System,
    Editor,
    Agent,
    Titlebar,
}

#[allow(dead_code)] // Target-specific variants are selected at compile time.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ShortcutPlatform {
    Windows,
    Macos,
    Linux,
}

impl ShortcutPlatform {
    fn current() -> Self {
        #[cfg(target_os = "macos")]
        return Self::Macos;
        #[cfg(target_os = "linux")]
        return Self::Linux;
        #[cfg(target_os = "windows")]
        return Self::Windows;
        #[allow(unreachable_code)]
        Self::Windows
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Windows => "windows",
            Self::Macos => "macos",
            Self::Linux => "linux",
        }
    }
}

impl ShortcutAction {
    fn accelerators(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.default_accelerator.as_str()).chain(
            self.platform_alternatives
                .values()
                .flatten()
                .map(String::as_str),
        )
    }

    fn supports_platform(&self, platform: ShortcutPlatform) -> bool {
        self.platforms.is_empty()
            || self
                .platforms
                .iter()
                .any(|candidate| candidate == platform.as_str())
    }

    fn accelerators_for_platform(&self, platform: ShortcutPlatform) -> Vec<&str> {
        if !self.supports_platform(platform) {
            return Vec::new();
        }
        let mut accelerators = vec![self.default_accelerator.as_str()];
        if let Some(alternatives) = self.platform_alternatives.get(platform.as_str()) {
            accelerators.extend(alternatives.iter().map(String::as_str));
        }
        accelerators
    }
}

impl ShortcutRegistry {
    fn parse(raw: &str) -> Result<Self, String> {
        let registry: Self = serde_json::from_str(raw)
            .map_err(|error| format!("shortcut registry JSON is invalid: {error}"))?;
        if registry.version != 1 {
            return Err(format!(
                "unsupported shortcut registry version {}",
                registry.version
            ));
        }

        let mut action_ids = HashSet::new();
        let mut accelerators = HashMap::new();
        for action in &registry.actions {
            if action.id.trim().is_empty() {
                return Err("shortcut action id must not be empty".into());
            }
            if action.default_accelerator.trim().is_empty() {
                return Err(format!(
                    "shortcut action `{}` has an empty default accelerator",
                    action.id
                ));
            }
            if action.remappable && action.reserved {
                return Err(format!(
                    "shortcut action `{}` cannot be both remappable and reserved",
                    action.id
                ));
            }
            if action.system_owned != (action.dispatch == ShortcutDispatch::System) {
                return Err(format!(
                    "shortcut action `{}` system ownership must match system dispatch",
                    action.id
                ));
            }
            if action
                .platforms
                .iter()
                .any(|platform| !matches!(platform.as_str(), "windows" | "macos" | "linux"))
            {
                return Err(format!(
                    "shortcut action `{}` declares an unknown platform",
                    action.id
                ));
            }
            let unique_platforms: HashSet<&str> =
                action.platforms.iter().map(String::as_str).collect();
            if unique_platforms.len() != action.platforms.len() {
                return Err(format!(
                    "shortcut action `{}` declares a platform more than once",
                    action.id
                ));
            }
            if !action_ids.insert(action.id.as_str()) {
                return Err(format!("duplicate shortcut action `{}`", action.id));
            }
            for accelerator in action.accelerators() {
                if accelerator.trim().is_empty() {
                    return Err(format!(
                        "shortcut action `{}` has an empty accelerator",
                        action.id
                    ));
                }
                let key = accelerator_key(accelerator);
                if let Some(previous) = accelerators.insert(key, action.id.as_str()) {
                    // The same alternate can be declared for Windows and
                    // Linux on one action (for example Ctrl+Y for redo).
                    // It must still be unique across distinct actions.
                    if previous != action.id.as_str() {
                        return Err(format!(
                            "shortcut accelerator `{accelerator}` is shared by `{previous}` and `{}`",
                            action.id
                        ));
                    }
                }
            }
        }
        Ok(registry)
    }

    fn action(&self, id: &str) -> Option<&ShortcutAction> {
        self.actions.iter().find(|action| action.id == id)
    }
}

static SHORTCUT_REGISTRY: Lazy<ShortcutRegistry> = Lazy::new(|| {
    ShortcutRegistry::parse(SHORTCUT_REGISTRY_JSON)
        .unwrap_or_else(|error| panic!("shortcut registry must be valid: {error}"))
});

fn shortcut_registry() -> &'static ShortcutRegistry {
    Lazy::force(&SHORTCUT_REGISTRY)
}

fn shortcut_action(id: &str) -> Option<&'static ShortcutAction> {
    shortcut_registry().action(id)
}

// Suspend native accelerators while Preferences records a shortcut. The OS
// menu would otherwise consume combinations such as Ctrl+S before the
// focused webview input can observe them.
static ACCELERATORS_ENABLED: AtomicBool = AtomicBool::new(true);
static MENU_REBUILD_LOCK: Mutex<()> = Mutex::new(());

/// Live handles to the 4 inline-format `CheckMenuItem`s. Updated whenever
/// the menu is rebuilt; consumed by `cmd_set_format_menu_state` to toggle
/// the ✓ marks in response to the editor's `selectionFormats` event.
#[derive(Default)]
pub struct FormatMenuHandles {
    inner: Mutex<Option<FormatItems>>,
}

struct FormatItems {
    bold: CheckMenuItem<Wry>,
    italic: CheckMenuItem<Wry>,
    strikethrough: CheckMenuItem<Wry>,
    inline_code: CheckMenuItem<Wry>,
    /// Theme `CheckMenuItem`s keyed by theme id. Updated when the user picks
    /// a new theme so only one ✓ is set.
    themes: Vec<(String, CheckMenuItem<Wry>)>,
}

impl FormatMenuHandles {
    fn store(&self, items: FormatItems) {
        *self.inner.lock().expect("format menu mutex poisoned") = Some(items);
    }

    /// Apply a flat list of active format names (`em`, `strong`, `del`,
    /// `inline_code`, …). Anything we don't track is ignored.
    pub fn apply(&self, active: &[String]) {
        let guard = self.inner.lock().expect("format menu mutex poisoned");
        let Some(items) = guard.as_ref() else { return };
        let _ = items.bold.set_checked(active.iter().any(|f| f == "strong"));
        let _ = items.italic.set_checked(active.iter().any(|f| f == "em"));
        let _ = items
            .strikethrough
            .set_checked(active.iter().any(|f| f == "del"));
        let _ = items
            .inline_code
            .set_checked(active.iter().any(|f| f == "inline_code"));
    }

    /// Tick the ✓ next to `theme_id`; clear the others.
    pub fn apply_theme(&self, theme_id: &str) {
        let guard = self.inner.lock().expect("format menu mutex poisoned");
        let Some(items) = guard.as_ref() else { return };
        for (id, item) in &items.themes {
            let _ = item.set_checked(id == theme_id);
        }
    }
}

/// Windows/Linux editors use client chrome. macOS retains traffic lights and
/// the application menu. Backdrops are negotiated separately before first paint.
pub fn configure_editor_chrome(app: &AppHandle<Wry>) -> AppResult<()> {
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    for (label, window) in app.webview_windows() {
        if label == "main" || label.starts_with("editor-") {
            window.set_decorations(false)?;
            window.hide_menu()?;
        }
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    let _ = app;
    Ok(())
}
pub fn install(app: &mut App) -> AppResult<()> {
    let handle = app.handle();
    let locale = read_locale(handle);
    let strings = i18n::for_locale(&locale);
    let (menu, format_items) =
        build_menu(handle, strings).map_err(|e| crate::error::AppError::Other(e.to_string()))?;
    app.set_menu(menu)?;
    configure_editor_chrome(handle)?;
    if let Some(state) = app.try_state::<FormatMenuHandles>() {
        state.store(format_items);
    }

    app.on_menu_event(move |app, event| {
        let id = event.id().0.as_str();
        // Send menu events ONLY to the focused window — otherwise a "Save"
        // click would trigger a save in every open window simultaneously.
        let target = app
            .webview_windows()
            .into_iter()
            .find(|(_, w)| w.is_focused().unwrap_or(false))
            .map(|(label, _)| label);
        if let Some(label) = target {
            if let Some(win) = app.get_webview_window(&label) {
                let _ = win.emit("mt://menu/action", id.to_string());
                return;
            }
        }
        // Do not broadcast a menu action when no window is focused. Commands
        // such as Save and Close are window-scoped; an app-wide fallback
        // would run them in every editor and could overwrite or discard data.
        tracing::debug!(menu_item = %id, "ignoring menu action with no focused window");
    });

    // Live-rebuild on language / theme / recent-files / keybinding change. The renderer
    // broadcasts a patch every time the user touches a preference; we only
    // act when one of those three keys is in the patch (rebuilding the menu
    // tree on every prefs write would be wasteful and would also flicker
    // the macOS app menu).
    let listener_handle = handle.clone();
    handle.listen_any("mt://prefs/changed", move |event| {
        let payload: serde_json::Value = match serde_json::from_str(event.payload()) {
            Ok(v) => v,
            Err(_) => return,
        };
        let patch = match payload.get("patch") {
            Some(p) => p,
            None => return,
        };
        let has_language = patch.get("language").and_then(|v| v.as_str()).is_some();
        let has_theme = patch.get("theme").is_some();
        let has_theme_mode = patch.get("autoSwitchTheme").is_some();
        let has_recent = patch.get("recentFiles").is_some();
        let has_keybindings = patch.get("keybindings").is_some();
        if !has_language && !has_theme && !has_theme_mode && !has_recent && !has_keybindings {
            return;
        }
        // For recent-files-only updates we still rebuild because the submenu
        // items are baked in at build time; for theme-only updates we could
        // get away with just flipping the ✓ marks but a rebuild keeps the
        // accelerator-free check items consistent across windows.
        let locale = patch
            .get("language")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| read_locale(&listener_handle));
        if let Err(err) = rebuild(&listener_handle, &locale) {
            tracing::warn!(?err, "failed to rebuild menu after prefs change");
        }
    });

    Ok(())
}

/// Rebuild the menu for `locale` and re-attach it to every existing window.
/// Called from the `mt://prefs/changed` listener when the user switches
/// languages.
pub fn rebuild(app: &AppHandle<Wry>, locale: &str) -> AppResult<()> {
    let _guard = MENU_REBUILD_LOCK
        .lock()
        .expect("menu rebuild mutex poisoned");
    rebuild_unlocked(app, locale)
}

fn rebuild_unlocked(app: &AppHandle<Wry>, locale: &str) -> AppResult<()> {
    let strings = i18n::for_locale(locale);
    let (menu, format_items) =
        build_menu(app, strings).map_err(|e| crate::error::AppError::Other(e.to_string()))?;
    // `App::set_menu` is only available on the App during setup. For runtime
    // updates, set the menu per-window — Tauri's app-level menu propagates
    // automatically, but setting it on each window guarantees the swap on
    // platforms where the menu is hosted by the window (Windows / Linux).
    app.set_menu(menu)
        .map_err(|e| crate::error::AppError::Other(e.to_string()))?;
    configure_editor_chrome(app)?;
    // `AppHandle::set_menu` propagates the app-wide menu to every window
    // whose menu is empty, including Preferences. Remove it again before the
    // rebuild completes so changing language/theme/keybindings never leaves
    // a menu bar on the utility window.
    if let Some(settings) = app.get_webview_window("settings") {
        settings
            .remove_menu()
            .map_err(|e| crate::error::AppError::Other(e.to_string()))?;
    }
    if let Some(state) = app.try_state::<FormatMenuHandles>() {
        state.store(format_items);
    }
    Ok(())
}

/// Rebuild the application menu with or without accelerators. Preferences
/// uses this only for the short lifetime of its shortcut recorder.
pub fn set_accelerators_enabled(app: &AppHandle<Wry>, enabled: bool) -> AppResult<()> {
    let _guard = MENU_REBUILD_LOCK
        .lock()
        .expect("menu rebuild mutex poisoned");
    let previous = ACCELERATORS_ENABLED.swap(enabled, Ordering::SeqCst);
    if previous == enabled {
        return Ok(());
    }
    let locale = read_locale(app);
    if let Err(error) = rebuild_unlocked(app, &locale) {
        ACCELERATORS_ENABLED.store(previous, Ordering::SeqCst);
        return Err(error);
    }
    Ok(())
}

/// Pull the `language` preference from the persisted store. Falls back to
/// `"en"` if the store is missing the key or unreadable.
fn read_locale<R: Runtime>(app: &AppHandle<R>) -> String {
    match prefs_store::get(app, "language") {
        Ok(Some(v)) => v
            .as_str()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "en".into()),
        _ => "en".into(),
    }
}

fn read_keybindings<R: Runtime>(app: &AppHandle<R>, cmd_or_ctrl: &str) -> HashMap<String, String> {
    let persisted = prefs_store::get(app, "keybindings").ok().flatten();
    keybindings_from_value(persisted.as_ref(), cmd_or_ctrl)
}

fn keybindings_from_value(
    persisted: Option<&serde_json::Value>,
    cmd_or_ctrl: &str,
) -> HashMap<String, String> {
    logical_keybindings_from_value(persisted)
        .into_iter()
        .map(|(action, accelerator)| {
            // Logical bindings are normalized using Ctrl so the persisted
            // representation matches the renderer. Conversion to Cmd belongs
            // exclusively to native-menu construction on macOS.
            let native = native_accelerator(&accelerator, cmd_or_ctrl)
                .expect("the shortcut registry only supplies native-safe defaults");
            (action, native)
        })
        .collect()
}

/// Produce the complete logical (Ctrl-based) remappable binding map used by
/// both persisted preferences and native menu construction. This deliberately
/// accepts partial/legacy values: explicit valid choices are allocated first,
/// then unassigned actions receive their own unused default or another unused
/// registry default. No action is ever represented by an empty accelerator.
///
/// Keep this allocation order in lockstep with
/// `keybindings::normaliseKeybindingMap` in the renderer.
fn logical_keybindings_from_value(
    persisted: Option<&serde_json::Value>,
) -> HashMap<String, String> {
    let actions: Vec<&ShortcutAction> = shortcut_registry()
        .actions
        .iter()
        .filter(|action| action.remappable)
        .collect();
    let persisted = persisted.and_then(serde_json::Value::as_object);
    let mut bindings = HashMap::with_capacity(actions.len());
    let mut used = HashSet::with_capacity(actions.len());

    // Explicit old values win, in registry declaration order. Repeated legacy
    // values therefore resolve deterministically instead of blanking both
    // actions as the previous fallback algorithm could do.
    if let Some(persisted) = persisted {
        for action in &actions {
            let Some(raw) = persisted
                .get(&action.id)
                .and_then(serde_json::Value::as_str)
            else {
                continue;
            };
            let Some(accelerator) = native_accelerator(raw, "Ctrl") else {
                continue;
            };
            if is_reserved_accelerator(&accelerator) {
                continue;
            }
            assign_logical_keybinding(&mut bindings, &mut used, action, accelerator);
        }
    }

    // Keep each remaining action on its own default if no explicit remap has
    // occupied it first.
    for action in &actions {
        if bindings.contains_key(&action.id) {
            continue;
        }
        let accelerator = native_accelerator(&action.default_accelerator, "Ctrl")
            .expect("the shortcut registry only supplies native-safe remappable defaults");
        assign_logical_keybinding(&mut bindings, &mut used, action, accelerator);
    }

    // Registry defaults are unique, so an unassigned action can always use a
    // free default. If this ever fails, the registry is internally invalid and
    // should fail loudly during development rather than write an empty key.
    let defaults: Vec<String> = actions
        .iter()
        .map(|action| {
            native_accelerator(&action.default_accelerator, "Ctrl")
                .expect("the shortcut registry only supplies native-safe remappable defaults")
        })
        .collect();
    for action in actions {
        if bindings.contains_key(&action.id) {
            continue;
        }
        let accelerator = defaults
            .iter()
            .find(|candidate| !used.contains(&accelerator_key(candidate)))
            .cloned()
            .expect("unique shortcut registry defaults must fill every remappable action");
        let assigned = assign_logical_keybinding(&mut bindings, &mut used, action, accelerator);
        debug_assert!(assigned, "the selected fallback must be unused");
    }

    bindings
}

/// Canonicalize a persisted keybinding object for renderer hydration. Legacy
/// partial/conflicting maps are deliberately completed here instead of being
/// dropped as one invalid preference, matching the renderer's allocator.
pub(crate) fn normalize_keybindings_value(value: &serde_json::Value) -> serde_json::Value {
    let bindings = logical_keybindings_from_value(Some(value));
    serde_json::Value::Object(
        bindings
            .into_iter()
            .map(|(action, accelerator)| (action, serde_json::Value::String(accelerator)))
            .collect(),
    )
}

fn assign_logical_keybinding(
    bindings: &mut HashMap<String, String>,
    used: &mut HashSet<String>,
    action: &ShortcutAction,
    accelerator: String,
) -> bool {
    let key = accelerator_key(&accelerator);
    if key.is_empty() || !used.insert(key) {
        return false;
    }
    bindings.insert(action.id.clone(), accelerator);
    true
}

fn native_accelerator(raw: &str, cmd_or_ctrl: &str) -> Option<String> {
    native_menu_accelerator(raw, cmd_or_ctrl, true)
}

/// Resolve one fixed native-menu accelerator declared by the registry. Fixed
/// actions may use a bare function key (for example F11), while user-created
/// remappable bindings continue to require Ctrl/Cmd or Alt.
fn fixed_native_accelerator(id: &str, cmd_or_ctrl: &str) -> Option<String> {
    let action = shortcut_action(id)?;
    if action.remappable || action.dispatch != ShortcutDispatch::Native {
        return None;
    }
    action
        .accelerators_for_platform(ShortcutPlatform::current())
        .into_iter()
        .find_map(|accelerator| native_menu_accelerator(accelerator, cmd_or_ctrl, false))
}

fn native_menu_accelerator(
    raw: &str,
    cmd_or_ctrl: &str,
    require_primary_or_alt: bool,
) -> Option<String> {
    let mut primary = false;
    let mut shift = false;
    let mut alt = false;
    let mut key: Option<String> = None;

    for token in raw
        .split('+')
        .map(str::trim)
        .filter(|token| !token.is_empty())
    {
        match token.to_ascii_lowercase().as_str() {
            "ctrl" | "control" | "cmd" | "command" | "cmdorctrl" | "commandorcontrol" => {
                primary = true;
            }
            "shift" => shift = true,
            "alt" | "option" => alt = true,
            _ if key.is_none() => key = Some(token.to_string()),
            _ => return None,
        }
    }

    let key = normalize_accelerator_key(&key.filter(|key| !key.is_empty())?)?;
    // User shortcuts always require the platform command modifier or Alt so
    // navigation/editing keys can never be captured globally by accident.
    if require_primary_or_alt && !primary && !alt {
        return None;
    }

    let mut parts = Vec::with_capacity(4);
    if primary {
        parts.push(cmd_or_ctrl.to_string());
    }
    if shift {
        parts.push("Shift".into());
    }
    if alt {
        parts.push("Alt".into());
    }
    parts.push(key);
    Some(parts.join("+"))
}

fn normalize_accelerator_key(key: &str) -> Option<String> {
    let lower = key.to_ascii_lowercase();
    let canonical = match lower.as_str() {
        "escape" | "esc" => "Esc",
        "space" => "Space",
        "backspace" => "Backspace",
        "capslock" => "CapsLock",
        "enter" => "Enter",
        "tab" => "Tab",
        "delete" => "Delete",
        "end" => "End",
        "home" => "Home",
        "insert" => "Insert",
        "pagedown" => "PageDown",
        "pageup" => "PageUp",
        "printscreen" => "PrintScreen",
        "scrolllock" => "ScrollLock",
        "arrowup" | "up" => "Up",
        "arrowdown" | "down" => "Down",
        "arrowleft" | "left" => "Left",
        "arrowright" | "right" => "Right",
        "numlock" => "NumLock",
        "audiovolumedown" | "volumedown" => "VolumeDown",
        "audiovolumeup" | "volumeup" => "VolumeUp",
        "audiovolumemute" | "volumemute" => "VolumeMute",
        _ if key.chars().count() == 1
            && key
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric() || "`\\[],=-.';/".contains(c)) =>
        {
            return Some(key.to_ascii_uppercase());
        }
        _ if lower
            .strip_prefix('f')
            .and_then(|digits| digits.parse::<u8>().ok())
            .is_some_and(|number| (1..=24).contains(&number)) =>
        {
            return Some(lower.to_ascii_uppercase());
        }
        _ if lower.starts_with("numpad") || lower.starts_with("num") => {
            let canonical = match lower.as_str() {
                "numpad0" | "num0" => "Numpad0",
                "numpad1" | "num1" => "Numpad1",
                "numpad2" | "num2" => "Numpad2",
                "numpad3" | "num3" => "Numpad3",
                "numpad4" | "num4" => "Numpad4",
                "numpad5" | "num5" => "Numpad5",
                "numpad6" | "num6" => "Numpad6",
                "numpad7" | "num7" => "Numpad7",
                "numpad8" | "num8" => "Numpad8",
                "numpad9" | "num9" => "Numpad9",
                "numpadadd" | "numpadplus" | "numadd" | "numplus" => "NumpadAdd",
                "numpaddecimal" | "numdecimal" => "NumpadDecimal",
                "numpaddivide" | "numdivide" => "NumpadDivide",
                "numpadenter" | "numenter" => "NumpadEnter",
                "numpadequal" | "numequal" => "NumpadEqual",
                "numpadmultiply" | "nummultiply" => "NumpadMultiply",
                "numpadsubtract" | "numsubtract" => "NumpadSubtract",
                _ => return None,
            };
            return Some(canonical.into());
        }
        _ => return None,
    };
    Some(canonical.into())
}

pub(crate) fn normalize_user_accelerator(raw: &str) -> Option<String> {
    native_accelerator(raw, "Ctrl")
}

pub(crate) fn is_remappable_action(action: &str) -> bool {
    shortcut_action(action).is_some_and(|declaration| declaration.remappable)
}

pub(crate) fn is_reserved_accelerator(accelerator: &str) -> bool {
    is_reserved_accelerator_for_platform(accelerator, ShortcutPlatform::current())
}

fn is_reserved_accelerator_for_platform(accelerator: &str, platform: ShortcutPlatform) -> bool {
    let key = accelerator_key(accelerator);
    shortcut_registry()
        .actions
        .iter()
        .filter(|action| action.reserved && action.supports_platform(platform))
        .flat_map(|action| action.accelerators_for_platform(platform))
        .any(|reserved| accelerator_key(reserved) == key)
}

fn accelerator_key(accel: &str) -> String {
    accel.to_ascii_lowercase().replace(' ', "")
}

fn unclaimed_fixed_accel<'a>(
    candidate: Option<&'a str>,
    keybindings: &HashMap<String, String>,
) -> Option<&'a str> {
    let candidate = candidate?;
    let candidate_key = accelerator_key(candidate);
    if keybindings
        .values()
        .any(|accel| !accel.is_empty() && accelerator_key(accel) == candidate_key)
    {
        None
    } else {
        Some(candidate)
    }
}

fn build_menu(
    app: &AppHandle<Wry>,
    s: &i18n::MenuStrings,
) -> tauri::Result<(Menu<Wry>, FormatItems)> {
    let cmd_or_ctrl = if cfg!(target_os = "macos") {
        "Cmd"
    } else {
        "Ctrl"
    };
    let keybindings = read_keybindings(app, cmd_or_ctrl);
    let custom_accel = |id: &str| {
        keybindings
            .get(id)
            .map(String::as_str)
            .filter(|accel| !accel.is_empty())
    };
    let new_window_accel = fixed_native_accelerator("file.newWindow", cmd_or_ctrl);
    let preferences_accel = fixed_native_accelerator("file.preferences", cmd_or_ctrl);
    let close_window_accel = fixed_native_accelerator("file.closeWindow", cmd_or_ctrl);
    let source_code_accel = fixed_native_accelerator("view.toggleSourceCode", cmd_or_ctrl);
    let zoom_in_accel = fixed_native_accelerator("view.zoomIn", cmd_or_ctrl);
    let zoom_out_accel = fixed_native_accelerator("view.zoomOut", cmd_or_ctrl);
    let zoom_reset_accel = fixed_native_accelerator("view.zoomReset", cmd_or_ctrl);
    let fullscreen_accel = fixed_native_accelerator("window.fullscreen", cmd_or_ctrl);

    // ── Open Recent submenu (dynamic) ──────────────────────────────
    let recent_files: Vec<String> = prefs_store::get(app, "recentFiles")
        .ok()
        .flatten()
        .and_then(|v| v.as_array().cloned())
        .map(|arr| {
            arr.into_iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let mut recent_builder = SubmenuBuilder::new(app, s.open_recent);
    if recent_files.is_empty() {
        let placeholder = MenuItemBuilder::with_id("file.openRecent.empty", s.no_recent)
            .enabled(false)
            .build(app)?;
        recent_builder = recent_builder.item(&placeholder);
    } else {
        for path in recent_files.iter().take(20) {
            let label = display_recent_label(path);
            let id = format!("file.openRecent:{path}");
            let item = MenuItemBuilder::with_id(&id, label).build(app)?;
            recent_builder = recent_builder.item(&item);
        }
        recent_builder = recent_builder.separator();
        let clear = MenuItemBuilder::with_id("file.clearRecent", s.clear_recent).build(app)?;
        recent_builder = recent_builder.item(&clear);
    }
    let recent_submenu = recent_builder.build()?;

    let file = SubmenuBuilder::new(app, s.file)
        .items(&[
            &mi(app, "file.new", s.new_tab, custom_accel("file.new"))?,
            &mi(
                app,
                "file.newWindow",
                s.new_window,
                unclaimed_fixed_accel(new_window_accel.as_deref(), &keybindings),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &mi(app, "file.open", s.open_file, custom_accel("file.open"))?,
            &mi(
                app,
                "file.openFolder",
                s.open_folder,
                custom_accel("file.openFolder"),
            )?,
            &recent_submenu,
            &PredefinedMenuItem::separator(app)?,
            &mi(app, "file.save", s.save, custom_accel("file.save"))?,
            &mi(app, "file.saveAs", s.save_as, custom_accel("file.saveAs"))?,
            &mi(app, "file.saveAll", s.save_all, None)?,
            &PredefinedMenuItem::separator(app)?,
            &mi(app, "file.exportHtml", s.export_html, None)?,
            &mi(app, "file.exportDocx", s.export_docx, None)?,
            &mi(app, "file.exportOdt", s.export_odt, None)?,
            &mi(app, "file.exportEpub", s.export_epub, None)?,
            &mi(app, "file.print", s.print, custom_accel("file.print"))?,
            &PredefinedMenuItem::separator(app)?,
            &mi(
                app,
                "file.preferences",
                s.preferences,
                unclaimed_fixed_accel(preferences_accel.as_deref(), &keybindings),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &mi(
                app,
                "file.closeTab",
                s.close_tab,
                custom_accel("file.closeTab"),
            )?,
            &mi(
                app,
                "file.closeWindow",
                s.close_window,
                unclaimed_fixed_accel(close_window_accel.as_deref(), &keybindings),
            )?,
            &PredefinedMenuItem::quit(app, None)?,
        ])
        .build()?;

    // These stay ordinary items so clicks emit stable ids through
    // `mt://menu/action`. They intentionally have no native accelerators:
    // Ctrl/Cmd+Z, redo, and select-all must reach the focused DOM control so
    // the renderer can choose Muya, CodeMirror, or native input history.
    //
    // Muda's predefined Cut/Copy/Paste items carry their own Ctrl/Cmd
    // accelerators, independently of `mi` and `check_mi`. While Preferences
    // records a shortcut, replace only those three with ordinary no-accelerator
    // items so Ctrl/Cmd+X/C/V reach the recorder and can report "reserved".
    // The regular predefined native items are restored as soon as recording
    // ends, preserving normal editor clipboard behavior outside that lease.
    // Reuse Muda's localized predefined labels for the temporary ordinary
    // items without attaching those predefined items (and their accelerators)
    // to the menu.
    let cut_label = PredefinedMenuItem::cut(app, None)?.text()?;
    let copy_label = PredefinedMenuItem::copy(app, None)?.text()?;
    let paste_label = PredefinedMenuItem::paste(app, None)?.text()?;
    let edit = if ACCELERATORS_ENABLED.load(Ordering::SeqCst) {
        SubmenuBuilder::new(app, s.edit)
            .items(&[
                &mi(app, "edit.undo", s.undo, None)?,
                &mi(app, "edit.redo", s.redo, None)?,
                &PredefinedMenuItem::separator(app)?,
                &PredefinedMenuItem::cut(app, None)?,
                &PredefinedMenuItem::copy(app, None)?,
                &PredefinedMenuItem::paste(app, None)?,
                &mi(app, "edit.selectAll", s.select_all, None)?,
                &PredefinedMenuItem::separator(app)?,
                &mi(app, "edit.find", s.find, custom_accel("edit.find"))?,
                &mi(app, "edit.replace", s.replace, custom_accel("edit.replace"))?,
            ])
            .build()?
    } else {
        SubmenuBuilder::new(app, s.edit)
            .items(&[
                &mi(app, "edit.undo", s.undo, None)?,
                &mi(app, "edit.redo", s.redo, None)?,
                &PredefinedMenuItem::separator(app)?,
                &mi(app, "edit.cut", &cut_label, None)?,
                &mi(app, "edit.copy", &copy_label, None)?,
                &mi(app, "edit.paste", &paste_label, None)?,
                &mi(app, "edit.selectAll", s.select_all, None)?,
                &PredefinedMenuItem::separator(app)?,
                &mi(app, "edit.find", s.find, custom_accel("edit.find"))?,
                &mi(app, "edit.replace", s.replace, custom_accel("edit.replace"))?,
            ])
            .build()?
    };

    let paragraph = SubmenuBuilder::new(app, s.paragraph)
        .items(&[
            &mi(app, "paragraph.h1", s.heading_1, None)?,
            &mi(app, "paragraph.h2", s.heading_2, None)?,
            &mi(app, "paragraph.h3", s.heading_3, None)?,
            &mi(app, "paragraph.h4", s.heading_4, None)?,
            &mi(app, "paragraph.h5", s.heading_5, None)?,
            &mi(app, "paragraph.h6", s.heading_6, None)?,
            &PredefinedMenuItem::separator(app)?,
            &mi(app, "paragraph.paragraph", s.paragraph_item, None)?,
            &mi(app, "paragraph.blockquote", s.blockquote, None)?,
            &mi(app, "paragraph.unorderedList", s.bulleted_list, None)?,
            &mi(app, "paragraph.orderedList", s.numbered_list, None)?,
            &mi(app, "paragraph.taskList", s.task_list, None)?,
            &mi(app, "paragraph.codeBlock", s.code_block, None)?,
            &mi(app, "paragraph.table", s.table, None)?,
            &mi(app, "paragraph.horizontalRule", s.horizontal_rule, None)?,
        ])
        .build()?;

    // Inline-format check items — handles are returned so the renderer can
    // flip ✓ marks via `cmd_set_format_menu_state`. The 3 link/image/clear
    // items remain plain MenuItems since they're actions, not states.
    let bold = check_mi(app, "format.bold", s.bold, None)?;
    let italic = check_mi(app, "format.italic", s.italic, None)?;
    let strikethrough = check_mi(app, "format.strikethrough", s.strikethrough, None)?;
    let inline_code = check_mi(app, "format.inlineCode", s.inline_code, None)?;

    let format = SubmenuBuilder::new(app, s.format)
        .items(&[
            &bold,
            &italic,
            &strikethrough,
            &inline_code,
            &PredefinedMenuItem::separator(app)?,
            &mi(app, "format.link", s.hyperlink, None)?,
            &mi(app, "format.image", s.image, None)?,
            &PredefinedMenuItem::separator(app)?,
            &mi(app, "format.clear", s.clear_formatting, None)?,
        ])
        .build()?;

    let view = SubmenuBuilder::new(app, s.view)
        .items(&[
            &mi(
                app,
                "view.toggleSidebar",
                s.toggle_sidebar,
                custom_accel("view.toggleSidebar"),
            )?,
            &mi(app, "view.toggleTabBar", s.toggle_tab_bar, None)?,
            &mi(app, "view.toggleToolbar", s.toggle_toolbar, None)?,
            &mi(app, "view.toggleAgent", s.toggle_agent, None)?,
            &mi(app, "view.toggleStatusBar", s.toggle_status_bar, None)?,
            &mi(
                app,
                "view.toggleSourceCode",
                s.toggle_source_code,
                unclaimed_fixed_accel(source_code_accel.as_deref(), &keybindings),
            )?,
            &mi(app, "view.toggleTypewriter", s.toggle_typewriter, None)?,
            &mi(app, "view.toggleFocus", s.toggle_focus, None)?,
            &PredefinedMenuItem::separator(app)?,
            &mi(
                app,
                "view.commandPalette",
                s.command_palette,
                custom_accel("view.commandPalette"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &mi(
                app,
                "view.zoomIn",
                s.zoom_in,
                unclaimed_fixed_accel(zoom_in_accel.as_deref(), &keybindings),
            )?,
            &mi(
                app,
                "view.zoomOut",
                s.zoom_out,
                unclaimed_fixed_accel(zoom_out_accel.as_deref(), &keybindings),
            )?,
            &mi(
                app,
                "view.zoomReset",
                s.zoom_reset,
                unclaimed_fixed_accel(zoom_reset_accel.as_deref(), &keybindings),
            )?,
        ])
        .build()?;

    // ── Theme submenu (built-in themes, one ✓ per active) ──────────
    let active_theme: String = prefs_store::get(app, "theme")
        .ok()
        .flatten()
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "light".into());
    let follow_system_theme = prefs_store::get(app, "autoSwitchTheme")
        .ok()
        .flatten()
        .and_then(|value| value.as_i64())
        == Some(1);

    let mut theme_items: Vec<(String, CheckMenuItem<Wry>)> =
        Vec::with_capacity(BUILTIN_THEMES.len());
    for id in BUILTIN_THEMES {
        let label = theme_label(s, id);
        let item = CheckMenuItemBuilder::with_id(format!("theme.set:{id}"), label)
            .checked(!follow_system_theme && *id == active_theme)
            .enabled(!follow_system_theme)
            .build(app)?;
        theme_items.push(((*id).to_string(), item));
    }
    let mut theme_builder = SubmenuBuilder::new(app, s.theme);
    for (_, item) in &theme_items {
        theme_builder = theme_builder.item(item);
    }
    let theme_menu = theme_builder.build()?;

    let window = SubmenuBuilder::new(app, s.window)
        .items(&[
            &PredefinedMenuItem::minimize(app, None)?,
            &mi(app, "window.alwaysOnTop", s.always_on_top, None)?,
            &mi(
                app,
                "window.fullscreen",
                s.fullscreen,
                fullscreen_accel.as_deref(),
            )?,
        ])
        .build()?;

    let help = SubmenuBuilder::new(app, s.help)
        .items(&[
            &mi(app, "help.openDocs", s.documentation, None)?,
            &mi(app, "help.openIssues", s.report_issue, None)?,
            &mi(app, "help.checkForUpdates", s.check_for_updates, None)?,
            &PredefinedMenuItem::separator(app)?,
            &mi(app, "help.about", s.about, None)?,
        ])
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[
            &file,
            &edit,
            &paragraph,
            &format,
            &view,
            &theme_menu,
            &window,
            &help,
        ])
        .build()?;

    Ok((
        menu,
        FormatItems {
            bold,
            italic,
            strikethrough,
            inline_code,
            themes: theme_items,
        },
    ))
}

/// Map a theme id (`light`, `one-dark`, …) to the localised display string.
fn theme_label(s: &i18n::MenuStrings, id: &str) -> &'static str {
    match id {
        "light" => s.theme_light,
        "dark" => s.theme_dark,
        "one-dark" => s.theme_one_dark,
        "material-dark" => s.theme_material_dark,
        "ulysses-light" => s.theme_ulysses_light,
        "graphite-light" => s.theme_graphite_light,
        "github-blue" => s.theme_github_blue,
        _ => "",
    }
}

/// Take a full path and produce a compact menu label (basename, max ~60
/// chars). Keeps the menu scannable even with deep recent paths.
fn display_recent_label(path: &str) -> String {
    let normalised = path.replace('\\', "/");
    let base = normalised.rsplit('/').next().unwrap_or(path);
    let mut chars = base.chars();
    let prefix: String = chars.by_ref().take(60).collect();
    if chars.next().is_some() {
        format!("{prefix}…")
    } else {
        prefix
    }
}

fn renderer_owns_shortcut(id: &str) -> bool {
    cfg!(target_os = "windows") && is_remappable_action(id)
}

/// Helper to build a labelled menu item with an optional accelerator.
fn mi<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    label: &str,
    accel: Option<&str>,
) -> tauri::Result<tauri::menu::MenuItem<R>> {
    if renderer_owns_shortcut(id) {
        // A tab displays a Windows menu shortcut hint without registering it.
        // Only the focused renderer executes it, including with a hidden menu.
        let text = match accel {
            Some(accel) => format!("{label}\t{accel}"),
            None => label.to_string(),
        };
        return MenuItemBuilder::with_id(id, text).build(app);
    }
    if ACCELERATORS_ENABLED.load(Ordering::SeqCst) {
        if let Some(a) = accel {
            match MenuItemBuilder::with_id(id, label)
                .accelerator(a)
                .build(app)
            {
                Ok(item) => return Ok(item),
                Err(error) => {
                    tracing::warn!(%id, accelerator = %a, %error, "ignoring unsupported menu accelerator");
                }
            }
        }
    }
    MenuItemBuilder::with_id(id, label).build(app)
}

/// Helper to build a stateful (✓) menu item with an optional accelerator.
fn check_mi(
    app: &AppHandle<Wry>,
    id: &str,
    label: &str,
    accel: Option<&str>,
) -> tauri::Result<CheckMenuItem<Wry>> {
    if ACCELERATORS_ENABLED.load(Ordering::SeqCst) {
        if let Some(a) = accel {
            match CheckMenuItemBuilder::with_id(id, label)
                .accelerator(a)
                .build(app)
            {
                Ok(item) => return Ok(item),
                Err(error) => {
                    tracing::warn!(%id, accelerator = %a, %error, "ignoring unsupported check-menu accelerator");
                }
            }
        }
    }
    CheckMenuItemBuilder::with_id(id, label).build(app)
}

/// Used by editor commands that want to update the menu's "Always on Top"
/// toggle state. No-op for now; will hook up when we add stateful items.
#[allow(dead_code)]
pub fn refresh_state(_app: &AppHandle<Wry>) {}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn shortcut_registry_contract_is_complete_and_drives_menu_bindings() {
        let parsed = ShortcutRegistry::parse(SHORTCUT_REGISTRY_JSON)
            .expect("the embedded shortcut registry must parse");
        assert_eq!(parsed.version, 1);

        let mut action_ids = std::collections::HashSet::new();
        let mut accelerators = std::collections::HashMap::new();
        for action in &parsed.actions {
            assert!(
                action_ids.insert(action.id.as_str()),
                "duplicate id: {}",
                action.id
            );
            for accelerator in action.accelerators() {
                if let Some(previous) =
                    accelerators.insert(accelerator_key(accelerator), action.id.as_str())
                {
                    assert_eq!(
                        previous,
                        action.id.as_str(),
                        "accelerator is shared by `{previous}` and `{}`: {accelerator}",
                        action.id
                    );
                }
            }
        }
        assert_eq!(
            parsed
                .actions
                .iter()
                .filter(|action| action.remappable)
                .count(),
            11
        );

        assert!(is_remappable_action("file.save"));
        assert!(!is_remappable_action("app.quit"));
        let quit = parsed.action("app.quit").expect("system quit declaration");
        assert_eq!(quit.dispatch, ShortcutDispatch::System);
        assert!(quit.system_owned);
        assert_eq!(quit.platforms, ["macos"]);
        assert_eq!(
            fixed_native_accelerator("file.newWindow", "Ctrl").as_deref(),
            Some("Ctrl+Shift+N")
        );
        assert_eq!(
            fixed_native_accelerator("view.toggleSourceCode", "Cmd").as_deref(),
            Some("Cmd+Alt+S")
        );
        assert_eq!(
            fixed_native_accelerator("window.fullscreen", "Ctrl").as_deref(),
            Some("F11")
        );
        assert_eq!(fixed_native_accelerator("view.toggleAgent", "Ctrl"), None);
        assert_eq!(fixed_native_accelerator("app.quit", "Ctrl"), None);

        let value = json!({
            "file.save": "ctrl+alt+k",
            "edit.find": "f"
        });
        let bindings = keybindings_from_value(Some(&value), "Ctrl");
        assert_eq!(bindings["file.save"], "Ctrl+Alt+K");
        assert_eq!(bindings["file.open"], "Ctrl+O");
        // A malformed/bare legacy value falls back to its non-empty default.
        assert_eq!(bindings["edit.find"], "Ctrl+F");
    }

    #[test]
    fn partial_and_conflicting_legacy_maps_normalize_without_empty_bindings() {
        let partial = json!({ "file.new": "Ctrl+O" });
        let bindings = logical_keybindings_from_value(Some(&partial));
        assert_eq!(bindings["file.new"], "Ctrl+O");
        assert_eq!(bindings["file.open"], "Ctrl+T");
        assert_eq!(bindings.len(), 11);
        assert!(bindings.values().all(|accelerator| !accelerator.is_empty()));

        let renderer_value = normalize_keybindings_value(&partial);
        let renderer_map = renderer_value.as_object().expect("canonical map");
        assert_eq!(renderer_map["file.new"], json!("Ctrl+O"));
        assert_eq!(renderer_map["file.open"], json!("Ctrl+T"));
        assert!(renderer_map
            .values()
            .all(|value| value.as_str().is_some_and(|value| !value.is_empty())));

        let duplicate = json!({
            "file.new": "Ctrl+Alt+K",
            "file.open": "Ctrl+Alt+K"
        });
        let bindings = logical_keybindings_from_value(Some(&duplicate));
        assert_eq!(bindings["file.new"], "Ctrl+Alt+K");
        assert_eq!(bindings["file.open"], "Ctrl+O");
        assert!(bindings.values().all(|accelerator| !accelerator.is_empty()));
    }

    #[test]
    fn primary_modifier_maps_to_command_on_macos_and_bare_keys_are_rejected() {
        assert_eq!(
            native_accelerator("ctrl+shift+s", "Cmd").as_deref(),
            Some("Cmd+Shift+S")
        );
        assert_eq!(native_accelerator("F1", "Cmd"), None);
        assert_eq!(native_accelerator("Shift+Up", "Cmd"), None);
        assert_eq!(
            native_accelerator("Alt+F1", "Cmd").as_deref(),
            Some("Alt+F1")
        );
    }

    #[test]
    fn recorder_key_contract_accepts_only_native_safe_named_keys() {
        // Keep this vector aligned with the renderer's keybinding contract.
        // Supported named keys are standard editing/navigation keys, F1-F24,
        // numpad keys, and the three Volume keys — not web-only Media/Browser
        // or Launch keys that muda cannot register natively.
        assert_eq!(
            native_accelerator("Ctrl+NumpadPlus", "Ctrl").as_deref(),
            Some("Ctrl+NumpadAdd")
        );
        assert_eq!(
            native_accelerator("Alt+AudioVolumeDown", "Ctrl").as_deref(),
            Some("Alt+VolumeDown")
        );
        assert_eq!(
            native_accelerator("Ctrl+F24", "Ctrl").as_deref(),
            Some("Ctrl+F24")
        );

        for accelerator in ["Alt+MediaPlayPause", "Alt+BrowserBack", "Alt+LaunchMail"] {
            assert_eq!(
                native_accelerator(accelerator, "Ctrl"),
                None,
                "{accelerator}"
            );
        }
    }

    #[test]
    fn system_quit_reservation_is_platform_specific() {
        assert!(is_reserved_accelerator_for_platform(
            "Ctrl+Q",
            ShortcutPlatform::Macos
        ));
        assert!(!is_reserved_accelerator_for_platform(
            "Ctrl+Q",
            ShortcutPlatform::Windows
        ));
        assert!(!is_reserved_accelerator_for_platform(
            "Ctrl+Q",
            ShortcutPlatform::Linux
        ));
    }

    #[test]
    fn default_sidebar_binding_does_not_shadow_bold() {
        let bindings = keybindings_from_value(None, "Ctrl");
        assert_eq!(bindings["view.toggleSidebar"], "Ctrl+Shift+B");
        assert_eq!(
            unclaimed_fixed_accel(Some("Ctrl+B"), &bindings),
            Some("Ctrl+B")
        );
        assert_eq!(
            unclaimed_fixed_accel(Some("Ctrl+I"), &bindings),
            Some("Ctrl+I")
        );
    }

    #[test]
    fn reserved_accelerators_and_unknown_keys_are_rejected() {
        let bold = normalize_user_accelerator("Ctrl+B").expect("valid fixed shortcut");
        assert!(is_reserved_accelerator(&bold));

        for accelerator in ["Ctrl+Z", "Ctrl+Y", "Ctrl+Shift+Z", "Ctrl+A", "Ctrl+1"] {
            let normalized = normalize_user_accelerator(accelerator)
                .expect("valid renderer-owned editor shortcut");
            assert!(is_reserved_accelerator(&normalized));
        }

        let save = normalize_user_accelerator("Ctrl+S").expect("valid remappable shortcut");
        assert!(!is_reserved_accelerator(&save));

        assert_eq!(normalize_user_accelerator("Ctrl+Dead"), None);
        assert_eq!(normalize_user_accelerator("Ctrl+Process"), None);
    }

    #[test]
    fn recent_labels_truncate_unicode_at_character_boundaries() {
        let basename = format!("{}-notes.md", "文".repeat(60));
        let label = display_recent_label(&format!("C:/documents/{basename}"));
        assert_eq!(label, format!("{}…", "文".repeat(60)));
        assert_eq!(display_recent_label("C:/documents/短文.md"), "短文.md");
    }
}
