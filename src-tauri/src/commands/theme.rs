//! User-theme commands.
//!
//! User themes live in `<config>/markcaptain/themes/*.css` (config dir comes
//! from `dirs::config_dir`). The renderer asks for a list, then reads any
//! one back as a string and injects it into the document.
//!
//! Built-in themes are exposed by their CSS variable palette in
//! `src/assets/styles/global.css` — those don't need disk I/O. Anything
//! returned from `cmd_list_themes` is in addition to those.

use std::path::PathBuf;

use serde::Serialize;

use crate::error::{AppError, AppResult};

#[derive(Debug, Serialize)]
pub struct UserTheme {
    /// Theme id used in `prefs.theme`. Derived from the file stem.
    pub id: String,
    /// Display label — same as id for now.
    pub name: String,
    /// Absolute path to the .css file on disk.
    pub path: PathBuf,
}

fn themes_dir() -> AppResult<PathBuf> {
    let base = dirs::config_dir()
        .ok_or_else(|| AppError::Other("could not resolve user config dir".into()))?;
    Ok(base.join("markcaptain").join("themes"))
}

#[tauri::command]
pub async fn cmd_list_themes() -> AppResult<Vec<UserTheme>> {
    let dir = themes_dir()?;
    if !dir.exists() {
        // First run / no user themes yet — create the dir so it shows up in
        // the file manager and return an empty list.
        let _ = tokio::fs::create_dir_all(&dir).await;
        return Ok(Vec::new());
    }
    let mut read = tokio::fs::read_dir(&dir).await?;
    let mut out = Vec::new();
    while let Some(entry) = read.next_entry().await? {
        let path = entry.path();
        if path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("css"))
            .unwrap_or(false)
        {
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("untitled")
                .to_string();
            out.push(UserTheme {
                id: stem.clone(),
                name: stem,
                path,
            });
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

#[tauri::command]
pub async fn cmd_read_theme_css(path: PathBuf) -> AppResult<String> {
    // Limit to themes_dir so a malicious renderer can't exfiltrate arbitrary
    // files via this command. (Renderer is sandboxed too, but defence-in-depth.)
    let dir = themes_dir()?;
    let canon_dir = tokio::fs::canonicalize(&dir).await.unwrap_or(dir);
    let canon_path = tokio::fs::canonicalize(&path).await?;
    if !canon_path.starts_with(&canon_dir) {
        return Err(AppError::InvalidArgument(
            "theme path must be inside the user themes directory".into(),
        ));
    }
    let css = tokio::fs::read_to_string(&canon_path).await?;
    Ok(css)
}
