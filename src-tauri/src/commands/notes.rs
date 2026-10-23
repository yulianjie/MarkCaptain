//! Local notebook operations. Authority is an already-open workspace, never Agent scope.
use super::workspace::{resolve_existing_inside, resolve_open_workspace};
use crate::{
    app::AppState,
    error::{AppError, AppResult},
    filesystem::{atomic_write, markdown},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
static SCANS: OnceLock<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteFile {
    path: PathBuf,
    relative: String,
    modified: u64,
    size: u64,
}
#[derive(Serialize)]
pub struct NoteDocument {
    #[serde(flatten)]
    document: markdown::LoadedDocument,
    fingerprint: String,
}
pub(crate) fn fingerprint(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(crate) fn is_note_markdown(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|s| s.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("md" | "markdown" | "mkd" | "mdown" | "mkdn" | "mdtxt" | "mdtext")
    )
}
pub(crate) fn is_excluded_note_directory(name: &OsStr) -> bool {
    matches!(
        name.to_str(),
        Some(".git" | ".markcaptain" | "node_modules" | "target")
    )
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NotesConfig {
    pub template_directory: String,
    pub daily_directory: String,
    pub daily_format: String,
    pub daily_template: String,
}
impl Default for NotesConfig {
    fn default() -> Self {
        Self {
            template_directory: "Templates".into(),
            daily_directory: "Daily".into(),
            daily_format: "YYYY-MM-DD".into(),
            daily_template: "builtin:work".into(),
        }
    }
}

pub(crate) fn relative_path(value: &str) -> AppResult<PathBuf> {
    let path = PathBuf::from(value.replace('\\', "/"));
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        || value.contains(':')
        || value.contains('\0')
    {
        return Err(AppError::InvalidArgument(
            "expected a project-relative path without .. or a drive".into(),
        ));
    }
    Ok(path)
}
fn safe_parent(root: &Path, relative: &Path) -> AppResult<PathBuf> {
    let mut parent = root.to_path_buf();
    for c in relative.parent().unwrap_or(Path::new("")).components() {
        parent.push(c);
        if !parent.exists() {
            std::fs::create_dir(&parent)?;
        }
        parent = resolve_existing_inside(root, &parent, true)?;
    }
    Ok(parent.join(
        relative
            .file_name()
            .ok_or_else(|| AppError::InvalidArgument("missing filename".into()))?,
    ))
}
fn publish_create_new_with(
    path: &Path,
    content: &[u8],
    write_content: impl FnOnce(&mut std::fs::File, &[u8]) -> std::io::Result<()>,
) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::InvalidArgument("missing parent directory".into()))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    write_content(temporary.as_file_mut(), content)?;
    temporary.as_file().sync_all()?;
    temporary
        .persist_noclobber(path)
        .map_err(|error| error.error)?;
    Ok(())
}

#[tauri::command]
pub async fn cmd_notes_list(
    state: tauri::State<'_, AppState>,
    window: tauri::WebviewWindow,
    root: PathBuf,
    request_id: String,
) -> AppResult<Vec<NoteFile>> {
    let canonical = resolve_open_workspace(&state, &root)?;
    uuid::Uuid::parse_str(&request_id).map_err(|e| AppError::InvalidArgument(e.to_string()))?;
    let scan_key = format!("{}:{request_id}", window.label());
    let cancellation = Arc::new(AtomicBool::new(false));
    SCANS
        .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
        .lock()
        .map_err(|e| AppError::Other(e.to_string()))?
        .insert(scan_key.clone(), cancellation.clone());
    let result = tokio::task::spawn_blocking(move || {
        let mut notes = Vec::new();
        let output_directories = super::export_project::output_directories(&canonical);
        let walker = walkdir::WalkDir::new(&canonical)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                !e.file_type().is_dir()
                    || (!is_excluded_note_directory(e.file_name())
                        && !output_directories
                            .iter()
                            .any(|output| e.path().starts_with(output)))
            });
        for entry in walker {
            if cancellation.load(Ordering::Relaxed) {
                return Err(AppError::Other("notes:scanCancelled".into()));
            }
            let entry = entry.map_err(|e| AppError::Other(e.to_string()))?;
            if !entry.file_type().is_file() || !is_note_markdown(entry.path()) {
                continue;
            }
            let path = resolve_existing_inside(&canonical, entry.path(), false)?;
            let rel = path
                .strip_prefix(&canonical)
                .map_err(|e| AppError::Other(e.to_string()))?;
            let meta = entry
                .metadata()
                .map_err(|e| AppError::Other(e.to_string()))?;
            notes.push(NoteFile {
                path: root.join(rel),
                relative: rel.to_string_lossy().replace('\\', "/"),
                size: meta.len(),
                modified: meta
                    .modified()?
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
            });
        }
        notes.sort_by(|a, b| a.relative.cmp(&b.relative));
        Ok(notes)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?;
    SCANS
        .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
        .lock()
        .map_err(|e| AppError::Other(e.to_string()))?
        .remove(&scan_key);
    result
}
#[tauri::command]
pub fn cmd_notes_cancel(window: tauri::WebviewWindow, request_id: String) -> AppResult<()> {
    let scans = SCANS
        .get_or_init(|| Mutex::new(std::collections::HashMap::new()))
        .lock()
        .map_err(|e| AppError::Other(e.to_string()))?;
    if let Some(cancel) = scans.get(&format!("{}:{request_id}", window.label())) {
        cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
pub async fn cmd_notes_read(
    state: tauri::State<'_, AppState>,
    root: PathBuf,
    relative: String,
) -> AppResult<NoteDocument> {
    let canonical = resolve_open_workspace(&state, &root)?;
    let path = resolve_existing_inside(
        &canonical,
        &canonical.join(relative_path(&relative)?),
        false,
    )?;
    if std::fs::metadata(&path)?.len() > 4 * 1024 * 1024 {
        return Err(AppError::InvalidArgument(
            "note exceeds 4 MiB index limit".into(),
        ));
    }
    use tokio::io::AsyncReadExt;
    let mut bytes = Vec::new();
    tokio::fs::File::open(&path)
        .await?
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(AppError::InvalidArgument(
            "note exceeds 4 MiB index limit".into(),
        ));
    }
    let (text, encoding, had_decode_errors) =
        crate::filesystem::encoding::detect_and_decode(&bytes)?;
    let line_ending = crate::filesystem::encoding::detect_line_ending(&text).to_string();
    Ok(NoteDocument {
        fingerprint: fingerprint(&bytes),
        document: markdown::LoadedDocument {
            path,
            markdown: text,
            encoding: encoding.into(),
            line_ending,
            had_decode_errors,
            bom: crate::filesystem::encoding::detect_bom(&bytes).is_some(),
        },
    })
}

#[tauri::command]
pub async fn cmd_notes_create(
    state: tauri::State<'_, AppState>,
    root: PathBuf,
    relative: String,
    content: String,
) -> AppResult<PathBuf> {
    let canonical = resolve_open_workspace(&state, &root)?;
    let relative = relative_path(&relative)?;
    if relative.extension().and_then(|s| s.to_str()) != Some("md") {
        return Err(AppError::InvalidArgument("new notes must use .md".into()));
    }
    if content.len() > 4 * 1024 * 1024 {
        return Err(AppError::InvalidArgument("note exceeds 4 MiB".into()));
    }
    let renderer_path = root.join(&relative);
    tokio::task::spawn_blocking(move || {
        let path = safe_parent(&canonical, &relative)?;
        // Publish only a fully written note. The no-clobber operation also
        // keeps daily-note creation safe when another writer wins the race.
        publish_create_new_with(&path, content.as_bytes(), |file, bytes| {
            use std::io::Write;
            file.write_all(bytes)
        })?;
        Ok(renderer_path)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[tauri::command]
pub async fn cmd_notes_config(
    state: tauri::State<'_, AppState>,
    root: PathBuf,
    config: Option<NotesConfig>,
) -> AppResult<NotesConfig> {
    let canonical = resolve_open_workspace(&state, &root)?;
    tokio::task::spawn_blocking(move || {
        let path = safe_parent(&canonical, Path::new(".markcaptain/notes.json"))?;
        if path.exists() {
            resolve_existing_inside(&canonical, &path, false)?;
        }
        if let Some(config) = config {
            relative_path(&config.template_directory)?;
            relative_path(&config.daily_directory)?;
            if !config.daily_template.is_empty() && !config.daily_template.starts_with("builtin:") {
                relative_path(&config.daily_template)?;
            }
            if config.daily_format.is_empty() || config.daily_format.len() > 128 {
                return Err(AppError::InvalidArgument(
                    "invalid daily date format".into(),
                ));
            }
            atomic_write::write(&path, &serde_json::to_vec_pretty(&config)?)?;
            Ok(config)
        } else if path.exists() {
            Ok(serde_json::from_slice(&std::fs::read(path)?)?)
        } else {
            Ok(NotesConfig::default())
        }
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relative_paths_reject_escape_and_drive() {
        for path in ["../x.md", "a/../b.md", "C:/a.md", "/a.md", "a:x.md", ""] {
            assert!(relative_path(path).is_err(), "{path}");
        }
        assert!(relative_path("中文/会议.md").is_ok());
    }
    #[test]
    fn config_defaults_are_separate_from_agent_skills() {
        let config: NotesConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(config.daily_format, "YYYY-MM-DD");
        assert_eq!(config.template_directory, "Templates");
    }
    #[test]
    fn failed_note_write_leaves_no_partial_target_or_temp_file() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("daily.md");
        let error = publish_create_new_with(&target, b"complete note", |file, bytes| {
            use std::io::Write;
            file.write_all(&bytes[..5])?;
            Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "injected write failure",
            ))
        });
        assert!(error.is_err());
        assert!(!target.exists());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn create_new_publishes_complete_bytes_without_replacing_existing_note() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let target = root.join("daily.md");
        publish_create_new_with(&target, b"complete note", |file, bytes| {
            use std::io::Write;
            file.write_all(bytes)
        })
        .unwrap();
        let error = publish_create_new_with(&target, b"replacement", |file, bytes| {
            use std::io::Write;
            file.write_all(bytes)
        });
        assert!(error.is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"complete note");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
