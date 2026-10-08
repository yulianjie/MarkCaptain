//! Tauri command handlers — equivalent to the original `ipcMain` listeners.
//!
//! Each submodule mirrors one cluster of the legacy IPC surface; see
//! `docs/IPC_MAP.md` at the project root for the full channel → command
//! mapping table.
//!
//! The canonical list of commands lives in the `markcaptain_handler!` macro at
//! the bottom of this file. `lib.rs::run` expands it via
//! `tauri::Builder::invoke_handler`. Add a `#[tauri::command]` here AND in
//! the macro — the build fails fast if you forget either.

pub mod agent;
pub mod backdrop;
pub mod debug;
pub mod export;
pub mod file;
pub mod image;
pub mod menu;
pub mod prefs;
pub mod search;
pub mod spellcheck;
pub mod storage;
pub mod theme;
pub mod window;
pub mod workspace;

/// Generates the invoke-handler list. Macro (not function) because
/// `tauri::generate_handler!` returns an opaque closure type that can't be
/// boxed cleanly across an FFI boundary.
#[macro_export]
macro_rules! markcaptain_handler {
    () => {
        tauri::generate_handler![
            $crate::commands::agent::history::cmd_agent_history_settings,
            $crate::commands::agent::history::cmd_agent_history_set_enabled,
            $crate::commands::agent::history::cmd_agent_history_list,
            $crate::commands::agent::history::cmd_agent_history_read,
            $crate::commands::agent::history::cmd_agent_history_write,
            $crate::commands::agent::history::cmd_agent_history_delete,
            $crate::commands::agent::cmd_agent_get_config,
            $crate::commands::agent::cmd_agent_save_config,
            $crate::commands::agent::cmd_agent_test_connection,
            $crate::commands::agent::cmd_agent_start,
            $crate::commands::agent::cmd_agent_cancel,
            $crate::commands::agent::skills::cmd_agent_list_skills,
            $crate::commands::agent::skills::cmd_agent_import_skill,
            $crate::commands::agent::skills::cmd_agent_set_skill_enabled,
            $crate::commands::agent::skills::cmd_agent_remove_skill,
            $crate::commands::agent::skills::cmd_agent_read_skill,
            // debug
            $crate::commands::debug::cmd_log,
            // file
            $crate::commands::file::cmd_open_files,
            $crate::commands::file::cmd_read_markdown,
            $crate::commands::file::cmd_save_markdown,
            $crate::commands::file::cmd_save_as_dialog,
            $crate::commands::file::cmd_rename_file,
            $crate::commands::file::cmd_trash_file,
            // workspace
            $crate::commands::workspace::cmd_open_folder,
            $crate::commands::workspace::cmd_list_directory,
            $crate::commands::workspace::cmd_workspace_list_directory,
            $crate::commands::workspace::cmd_watch_folder,
            $crate::commands::workspace::cmd_unwatch_folder,
            $crate::commands::workspace::cmd_workspace_create,
            $crate::commands::workspace::cmd_workspace_rename,
            $crate::commands::workspace::cmd_workspace_copy,
            $crate::commands::workspace::cmd_workspace_move,
            $crate::commands::workspace::cmd_workspace_trash,
            // window
            $crate::commands::backdrop::cmd_window_enable_backdrop,
            $crate::commands::window::cmd_new_window,
            $crate::commands::window::cmd_close_window,
            $crate::commands::window::cmd_destroy_editor_window,
            $crate::commands::window::cmd_destroy_settings_window,
            $crate::commands::window::cmd_set_always_on_top,
            $crate::commands::window::cmd_set_menu_accelerators_enabled,
            $crate::commands::window::cmd_open_settings,
            $crate::commands::window::cmd_show_window,
            // prefs
            $crate::commands::prefs::cmd_get_preferences,
            $crate::commands::prefs::cmd_get_preference,
            $crate::commands::prefs::cmd_set_preference,
            $crate::commands::prefs::cmd_set_preferences,
            $crate::commands::prefs::cmd_push_recent,
            $crate::commands::prefs::cmd_get_user_data,
            $crate::commands::prefs::cmd_set_user_data,
            $crate::commands::prefs::cmd_get_editor_session,
            $crate::commands::prefs::cmd_set_editor_session,
            $crate::commands::prefs::cmd_clear_editor_session,
            // cloud storage
            $crate::commands::storage::cmd_storage_list_connections,
            $crate::commands::storage::cmd_storage_save_connection,
            $crate::commands::storage::cmd_storage_delete_connection,
            $crate::commands::storage::cmd_storage_probe_connection,
            $crate::commands::storage::cmd_storage_list_plugins,
            $crate::commands::storage::cmd_storage_resolve_project,
            $crate::commands::storage::cmd_storage_list_remote_directories,
            $crate::commands::storage::cmd_storage_upload_file,
            $crate::commands::storage::cmd_storage_sync,
            $crate::commands::storage::cmd_storage_git_sync,
            $crate::commands::storage::cmd_storage_git_prepare_merge,
            $crate::commands::storage::cmd_storage_git_conflict_stage,
            $crate::commands::storage::cmd_storage_git_abort,
            // export
            $crate::commands::export::cmd_export_html,
            $crate::commands::export::cmd_export_pdf,
            $crate::commands::export::cmd_pandoc_convert,
            $crate::commands::export::cmd_pandoc_pdf_export,
            // image
            $crate::commands::image::cmd_save_image_local,
            $crate::commands::image::cmd_upload_image_github,
            $crate::commands::image::cmd_upload_image_picgo,
            $crate::commands::image::cmd_upload_image_script,
            $crate::commands::image::cmd_search_unsplash,
            // search
            $crate::commands::search::cmd_search_in_folder,
            // spellcheck
            $crate::commands::spellcheck::cmd_spellcheck_words,
            $crate::commands::spellcheck::cmd_spellcheck_suggest,
            $crate::commands::spellcheck::cmd_spellcheck_add_word,
            $crate::commands::spellcheck::cmd_spellcheck_remove_word,
            $crate::commands::spellcheck::cmd_spellcheck_available_dictionaries,
            // theme
            $crate::commands::theme::cmd_list_themes,
            $crate::commands::theme::cmd_read_theme_css,
            // menu
            $crate::commands::menu::cmd_set_format_menu_state,
            $crate::commands::menu::cmd_popup_editor_menu,
        ]
    };
}
