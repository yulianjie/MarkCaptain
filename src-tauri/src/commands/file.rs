//! File-level commands: open/read/save/rename/trash for individual `.md` files.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::app::{is_markdown_document, AppState};
use crate::error::{AppError, AppResult};
use crate::filesystem::markdown::{self, LoadedDocument};

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOptions {
    pub encoding: Option<String>,
    pub line_ending: Option<String>,
    pub bom: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadOptions {
    pub auto_guess_encoding: Option<bool>,
    pub default_encoding: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAsResult {
    pub path: PathBuf,
}

#[tauri::command]
pub async fn cmd_read_markdown(
    state: State<'_, AppState>,
    path: PathBuf,
    options: Option<ReadOptions>,
) -> AppResult<LoadedDocument> {
    read_markdown_authorized(&state, path, options).await
}

async fn read_markdown_authorized(
    state: &AppState,
    path: PathBuf,
    options: Option<ReadOptions>,
) -> AppResult<LoadedDocument> {
    let options = options.unwrap_or_default();
    let auto_guess_encoding = options.auto_guess_encoding.unwrap_or(true);
    let default_encoding = options.default_encoding.as_deref().unwrap_or("utf8");
    let loaded =
        markdown::read_markdown_with_options(path, auto_guess_encoding, default_encoding).await?;
    if is_markdown_document(&loaded.path) {
        state.authorize_document_source(&loaded.path)?;
    }
    Ok(loaded)
}

#[tauri::command]
pub async fn cmd_save_markdown(
    state: State<'_, AppState>,
    path: PathBuf,
    markdown: String,
    options: Option<SaveOptions>,
) -> AppResult<()> {
    save_markdown_authorized(&state, path, markdown, options).await
}

async fn save_markdown_authorized(
    state: &AppState,
    path: PathBuf,
    markdown: String,
    options: Option<SaveOptions>,
) -> AppResult<()> {
    let opts = options.unwrap_or_default();
    let encoding = opts.encoding.as_deref().unwrap_or("utf-8");
    let line_ending = opts.line_ending.as_deref().unwrap_or("lf");
    crate::filesystem::markdown::write_markdown_with_options(
        &path,
        &markdown,
        encoding,
        line_ending,
        opts.bom,
    )
    .await?;
    if is_markdown_document(&path) {
        state.authorize_document_source(&path)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn cmd_open_files(app: AppHandle) -> AppResult<Vec<PathBuf>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown", "mkd", "mdown", "mdtxt"])
        .pick_files(move |paths| {
            let _ = tx.send(paths);
        });
    let result = rx
        .await
        .map_err(|_| AppError::Other("dialog cancelled".into()))?;
    Ok(result
        .map(|paths| {
            paths
                .into_iter()
                .filter_map(|p| p.into_path().ok())
                .collect()
        })
        .unwrap_or_default())
}

#[tauri::command]
pub async fn cmd_save_as_dialog(
    app: AppHandle,
    default_name: Option<String>,
    default_dir: Option<PathBuf>,
) -> AppResult<Option<PathBuf>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut builder = app.dialog().file();
    if let Some(name) = default_name {
        builder = builder.set_file_name(&name);
    }
    if let Some(dir) = default_dir {
        builder = builder.set_directory(dir);
    }
    builder
        .add_filter("Markdown", &["md"])
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let result = rx
        .await
        .map_err(|_| AppError::Other("dialog cancelled".into()))?;
    Ok(result.and_then(|p| p.into_path().ok()))
}

#[tauri::command]
pub async fn cmd_rename_file(from: PathBuf, to: PathBuf) -> AppResult<()> {
    tokio::fs::rename(from, to).await?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_trash_file(path: PathBuf) -> AppResult<()> {
    tokio::task::spawn_blocking(move || trash::delete(&path))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
        .map_err(|e| AppError::Other(e.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;

    use crate::app::AppState;

    use super::*;

    #[test]
    fn nested_file_options_use_camel_case() {
        let save: SaveOptions = serde_json::from_value(json!({
            "encoding": "utf8",
            "lineEnding": "crlf",
            "bom": true
        }))
        .unwrap();
        assert_eq!(save.line_ending.as_deref(), Some("crlf"));
        assert_eq!(save.bom, Some(true));

        let read: ReadOptions = serde_json::from_value(json!({
            "autoGuessEncoding": false,
            "defaultEncoding": "windows-1252"
        }))
        .unwrap();
        assert_eq!(read.auto_guess_encoding, Some(false));
        assert_eq!(read.default_encoding.as_deref(), Some("windows-1252"));
    }

    #[tokio::test]
    async fn successful_markdown_reads_and_saves_authorize_canonical_sources() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::default();
        let read_path = temp.path().join("readme.MARKDOWN");
        fs::write(&read_path, "# Read").unwrap();
        assert!(!state.is_document_source_authorized(&read_path));

        let loaded = read_markdown_authorized(&state, read_path.clone(), None)
            .await
            .unwrap();
        assert_eq!(loaded.markdown, "# Read");
        assert!(state.is_document_source_authorized(&read_path));
        assert!(state.is_document_source_authorized(&loaded.path));

        let save_path = temp.path().join("new-note.mdown");
        assert!(!state.is_document_source_authorized(&save_path));
        save_markdown_authorized(&state, save_path.clone(), "# Saved".into(), None)
            .await
            .unwrap();
        assert!(state.is_document_source_authorized(&save_path));
        assert_eq!(fs::read_to_string(&save_path).unwrap(), "# Saved");
    }

    #[tokio::test]
    async fn successful_non_markdown_reads_do_not_grant_document_source_authority() {
        let temp = tempfile::tempdir().unwrap();
        let state = AppState::default();
        let path = temp.path().join("notes.txt");
        fs::write(&path, "plain text").unwrap();
        read_markdown_authorized(&state, path.clone(), None)
            .await
            .unwrap();
        assert!(!state.is_document_source_authorized(&path));
    }
}
