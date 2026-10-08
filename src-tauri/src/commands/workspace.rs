//! Folder / workspace commands.

use std::ffi::OsStr;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::app::AppState;
use crate::error::{AppError, AppResult};
use crate::filesystem::watcher;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: PathBuf,
    pub is_dir: bool,
    pub is_markdown: bool,
    pub size: u64,
    pub modified_ms: i64,
    pub created_ms: i64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceEntryKind {
    File,
    Directory,
}

fn invalid_argument(message: impl Into<String>) -> AppError {
    AppError::InvalidArgument(message.into())
}

fn ensure_workspace_owner(label: &str) -> AppResult<()> {
    if label == "main" || label.starts_with("editor-") {
        Ok(())
    } else {
        Err(invalid_argument(
            "only an editor window may own a workspace watcher",
        ))
    }
}

fn canonicalize(path: &Path) -> AppResult<PathBuf> {
    std::fs::canonicalize(path).map_err(AppError::from)
}

/// Resolve a renderer-supplied root against the workspaces registered in
/// [`AppState`]. Merely passing an arbitrary directory as `root` must never
/// grant filesystem access.
fn resolve_open_workspace(state: &AppState, requested_root: &Path) -> AppResult<PathBuf> {
    let requested = canonicalize(requested_root)?;
    let is_open = state.workspace_roots().into_iter().any(|registered| {
        canonicalize(&registered)
            .map(|registered| registered == requested)
            .unwrap_or(false)
    });
    if is_open {
        Ok(requested)
    } else {
        Err(invalid_argument("workspace is not open"))
    }
}

/// Canonicalization resolves `..` and every symlink in the existing path;
/// `Path::starts_with` then compares path components rather than vulnerable
/// string prefixes such as `notes` versus `notes-old`.
fn resolve_existing_inside(root: &Path, candidate: &Path, allow_root: bool) -> AppResult<PathBuf> {
    let resolved = canonicalize(candidate)?;
    if !resolved.starts_with(root) {
        return Err(invalid_argument("path is outside the open workspace"));
    }
    if !allow_root && resolved == root {
        return Err(invalid_argument("the workspace root cannot be modified"));
    }
    Ok(resolved)
}

fn map_to_renderer_root(
    canonical_root: &Path,
    renderer_root: &Path,
    canonical_path: &Path,
) -> AppResult<PathBuf> {
    let relative = canonical_path
        .strip_prefix(canonical_root)
        .map_err(|_| invalid_argument("path is outside the open workspace"))?;
    Ok(renderer_root.join(relative))
}

fn validate_entry_name(name: &str) -> AppResult<&OsStr> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(invalid_argument(
            "name must be one file or folder name without path separators",
        ));
    }
    let mut components = Path::new(name).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(value)), None) if !value.is_empty() => Ok(value),
        _ => Err(invalid_argument(
            "name must be one file or folder name without path separators",
        )),
    }
}

fn ensure_directory(path: &Path) -> AppResult<()> {
    if std::fs::metadata(path)?.is_dir() {
        Ok(())
    } else {
        Err(invalid_argument("destination is not a directory"))
    }
}

fn ensure_target_available(path: &Path) -> AppResult<()> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Err(invalid_argument("destination already exists")),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
}

fn ensure_not_symlink(path: &Path) -> AppResult<()> {
    if std::fs::symlink_metadata(path)?.file_type().is_symlink() {
        Err(invalid_argument(
            "symbolic links cannot be modified from the project tree",
        ))
    } else {
        Ok(())
    }
}

fn ensure_transfer_not_self_contained(source: &Path, destination_dir: &Path) -> AppResult<()> {
    if std::fs::metadata(source)?.is_dir() && destination_dir.starts_with(source) {
        Err(invalid_argument(
            "a folder cannot be copied or moved into itself",
        ))
    } else {
        Ok(())
    }
}

fn preflight_copy_source(path: &Path) -> AppResult<()> {
    ensure_not_symlink(path)?;
    if std::fs::metadata(path)?.is_dir() {
        for entry in std::fs::read_dir(path)? {
            preflight_copy_source(&entry?.path())?;
        }
    }
    Ok(())
}

fn copy_entry_recursive(source: &Path, destination: &Path) -> AppResult<()> {
    ensure_not_symlink(source)?;
    let metadata = std::fs::metadata(source)?;
    if metadata.is_dir() {
        std::fs::create_dir(destination)?;
        for entry in std::fs::read_dir(source)? {
            let entry = entry?;
            copy_entry_recursive(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        std::fs::copy(source, destination)?;
    } else {
        return Err(invalid_argument("unsupported workspace entry type"));
    }
    Ok(())
}

fn remove_incomplete_copy(path: &Path) {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return;
    };
    if metadata.is_dir() {
        let _ = std::fs::remove_dir_all(path);
    } else {
        let _ = std::fs::remove_file(path);
    }
}

#[tauri::command]
pub async fn cmd_open_folder(app: AppHandle) -> AppResult<Option<PathBuf>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let result = rx
        .await
        .map_err(|_| AppError::Other("dialog cancelled".into()))?;
    Ok(result.and_then(|path| path.into_path().ok()))
}

#[tauri::command]
pub async fn cmd_list_directory(path: PathBuf) -> AppResult<Vec<DirEntry>> {
    ensure_directory(&canonicalize(&path)?)?;
    list_directory_entries(path).await
}

#[tauri::command]
pub async fn cmd_workspace_list_directory(
    state: tauri::State<'_, AppState>,
    root: PathBuf,
    path: PathBuf,
) -> AppResult<Vec<DirEntry>> {
    let renderer_root = root.clone();
    let root = resolve_open_workspace(&state, &root)?;
    let path = resolve_existing_inside(&root, &path, true)?;
    ensure_directory(&path)?;
    let mut entries = list_directory_entries(path).await?;
    for entry in &mut entries {
        entry.path = map_to_renderer_root(&root, &renderer_root, &entry.path)?;
    }
    Ok(entries)
}

async fn list_directory_entries(path: PathBuf) -> AppResult<Vec<DirEntry>> {
    let mut entries = Vec::new();
    let mut read = tokio::fs::read_dir(&path).await?;
    while let Some(entry) = read.next_entry().await? {
        let file_type = entry.file_type().await?;
        // Do not expose symlink-backed entries through the project tree: a
        // click on one could otherwise escape the workspace during a later
        // read, and recursively following directory links can create cycles.
        if file_type.is_symlink() {
            continue;
        }
        let meta = entry.metadata().await?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = file_type.is_dir();
        let path = entry.path();
        let is_markdown = !is_dir
            && path
                .extension()
                .and_then(|s| s.to_str())
                .map(|s| {
                    matches!(
                        s.to_ascii_lowercase().as_str(),
                        "md" | "markdown" | "mkd" | "mdown" | "mdtxt"
                    )
                })
                .unwrap_or(false);
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        // Birth time is not available on every filesystem. Falling back to
        // modified time keeps created-sort deterministic on those platforms.
        let created_ms = meta
            .created()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(modified_ms);
        entries.push(DirEntry {
            name,
            path,
            is_dir,
            is_markdown,
            size: meta.len(),
            modified_ms,
            created_ms,
        });
    }
    Ok(entries)
}

#[tauri::command]
pub async fn cmd_workspace_create(
    state: tauri::State<'_, AppState>,
    root: PathBuf,
    parent: PathBuf,
    name: String,
    kind: WorkspaceEntryKind,
) -> AppResult<PathBuf> {
    let renderer_root = root.clone();
    let root = resolve_open_workspace(&state, &root)?;
    let parent = resolve_existing_inside(&root, &parent, true)?;
    ensure_directory(&parent)?;
    let target = parent.join(validate_entry_name(&name)?);
    ensure_target_available(&target)?;
    match kind {
        WorkspaceEntryKind::File => {
            tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .await?;
        }
        WorkspaceEntryKind::Directory => tokio::fs::create_dir(&target).await?,
    }
    map_to_renderer_root(&root, &renderer_root, &target)
}

#[tauri::command]
pub async fn cmd_workspace_rename(
    state: tauri::State<'_, AppState>,
    root: PathBuf,
    source: PathBuf,
    new_name: String,
) -> AppResult<PathBuf> {
    let renderer_root = root.clone();
    let root = resolve_open_workspace(&state, &root)?;
    ensure_not_symlink(&source)?;
    let source = resolve_existing_inside(&root, &source, false)?;
    let parent = source
        .parent()
        .ok_or_else(|| invalid_argument("workspace entry has no parent"))?;
    let target = parent.join(validate_entry_name(&new_name)?);
    if target == source {
        return map_to_renderer_root(&root, &renderer_root, &source);
    }
    ensure_target_available(&target)?;
    tokio::fs::rename(&source, &target).await?;
    map_to_renderer_root(&root, &renderer_root, &target)
}

#[tauri::command]
pub async fn cmd_workspace_copy(
    state: tauri::State<'_, AppState>,
    root: PathBuf,
    source: PathBuf,
    destination_dir: PathBuf,
) -> AppResult<PathBuf> {
    let renderer_root = root.clone();
    let root = resolve_open_workspace(&state, &root)?;
    ensure_not_symlink(&source)?;
    let source = resolve_existing_inside(&root, &source, false)?;
    let destination_dir = resolve_existing_inside(&root, &destination_dir, true)?;
    ensure_directory(&destination_dir)?;
    ensure_transfer_not_self_contained(&source, &destination_dir)?;
    let filename = source
        .file_name()
        .ok_or_else(|| invalid_argument("workspace entry has no name"))?;
    let destination = destination_dir.join(filename);
    ensure_target_available(&destination)?;

    let source_for_copy = source.clone();
    let destination_for_copy = destination.clone();
    tokio::task::spawn_blocking(move || {
        preflight_copy_source(&source_for_copy)?;
        if let Err(err) = copy_entry_recursive(&source_for_copy, &destination_for_copy) {
            remove_incomplete_copy(&destination_for_copy);
            return Err(err);
        }
        Ok::<(), AppError>(())
    })
    .await
    .map_err(|err| AppError::Other(err.to_string()))??;
    map_to_renderer_root(&root, &renderer_root, &destination)
}

#[tauri::command]
pub async fn cmd_workspace_move(
    state: tauri::State<'_, AppState>,
    root: PathBuf,
    source: PathBuf,
    destination_dir: PathBuf,
) -> AppResult<PathBuf> {
    let renderer_root = root.clone();
    let root = resolve_open_workspace(&state, &root)?;
    ensure_not_symlink(&source)?;
    let source = resolve_existing_inside(&root, &source, false)?;
    let destination_dir = resolve_existing_inside(&root, &destination_dir, true)?;
    ensure_directory(&destination_dir)?;
    ensure_transfer_not_self_contained(&source, &destination_dir)?;
    let filename = source
        .file_name()
        .ok_or_else(|| invalid_argument("workspace entry has no name"))?;
    let destination = destination_dir.join(filename);
    ensure_target_available(&destination)?;
    tokio::fs::rename(&source, &destination).await?;
    map_to_renderer_root(&root, &renderer_root, &destination)
}

#[tauri::command]
pub async fn cmd_workspace_trash(
    state: tauri::State<'_, AppState>,
    root: PathBuf,
    path: PathBuf,
) -> AppResult<()> {
    let root = resolve_open_workspace(&state, &root)?;
    ensure_not_symlink(&path)?;
    let path = resolve_existing_inside(&root, &path, false)?;
    tokio::task::spawn_blocking(move || trash::delete(&path))
        .await
        .map_err(|err| AppError::Other(err.to_string()))?
        .map_err(|err| AppError::Other(err.to_string()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use serde_json::json;

    use super::*;

    struct TempWorkspace(PathBuf);

    impl TempWorkspace {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "markcaptain-workspace-test-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempWorkspace {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn directory_entry_serializes_camel_case_timestamps() {
        let value = serde_json::to_value(DirEntry {
            name: "note.md".into(),
            path: "note.md".into(),
            is_dir: false,
            is_markdown: true,
            size: 42,
            modified_ms: 10,
            created_ms: 5,
        })
        .unwrap();
        assert_eq!(value["isDir"], json!(false));
        assert_eq!(value["isMarkdown"], json!(true));
        assert_eq!(value["modifiedMs"], json!(10));
        assert_eq!(value["createdMs"], json!(5));
        assert!(value.get("modified_ms").is_none());
    }

    #[test]
    fn entry_names_are_single_components_on_every_platform() {
        assert_eq!(
            validate_entry_name("draft.md").unwrap(),
            OsStr::new("draft.md")
        );
        for invalid in ["", ".", "..", "nested/file.md", "nested\\file.md"] {
            assert!(
                validate_entry_name(invalid).is_err(),
                "accepted {invalid:?}"
            );
        }
    }

    #[test]
    fn canonical_containment_rejects_prefix_collisions() {
        let temp = TempWorkspace::new();
        let root = temp.path().join("notes");
        let sibling = temp.path().join("notes-old");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&sibling).unwrap();
        fs::write(root.join("inside.md"), "inside").unwrap();
        fs::write(sibling.join("outside.md"), "outside").unwrap();
        let root = canonicalize(&root).unwrap();

        assert!(resolve_existing_inside(&root, &root.join("inside.md"), false).is_ok());
        assert!(resolve_existing_inside(&root, &sibling.join("outside.md"), false).is_err());
        assert!(resolve_existing_inside(&root, &root, false).is_err());
    }

    #[test]
    fn canonical_paths_are_mapped_back_to_renderer_root_spelling() {
        let temp = TempWorkspace::new();
        let child = temp.path().join("draft.md");
        fs::write(&child, "draft").unwrap();
        let canonical_root = canonicalize(temp.path()).unwrap();
        let canonical_child = canonicalize(&child).unwrap();

        assert_eq!(
            map_to_renderer_root(&canonical_root, temp.path(), &canonical_child).unwrap(),
            child
        );
    }

    #[test]
    fn directory_transfer_cannot_target_its_own_descendant() {
        let temp = TempWorkspace::new();
        let source = temp.path().join("source");
        let child = source.join("child");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&child).unwrap();
        let source = canonicalize(&source).unwrap();
        let child = canonicalize(&child).unwrap();
        let root = canonicalize(temp.path()).unwrap();

        assert!(ensure_transfer_not_self_contained(&source, &child).is_err());
        assert!(ensure_transfer_not_self_contained(&source, &source).is_err());
        assert!(ensure_transfer_not_self_contained(&source, &root).is_ok());
    }

    #[test]
    fn recursive_copy_never_overwrites_an_existing_target() {
        let temp = TempWorkspace::new();
        let source = temp.path().join("source");
        let destination = temp.path().join("destination");
        fs::create_dir(&source).unwrap();
        fs::write(source.join("draft.md"), "draft").unwrap();

        ensure_target_available(&destination).unwrap();
        preflight_copy_source(&source).unwrap();
        copy_entry_recursive(&source, &destination).unwrap();
        assert_eq!(
            fs::read_to_string(destination.join("draft.md")).unwrap(),
            "draft"
        );
        assert!(ensure_target_available(&destination).is_err());
    }

    #[test]
    fn only_editor_windows_can_own_workspace_watchers() {
        assert!(ensure_workspace_owner("main").is_ok());
        assert!(ensure_workspace_owner("editor-123").is_ok());
        assert!(ensure_workspace_owner("settings").is_err());
        assert!(ensure_workspace_owner("editor").is_err());
    }
}

#[tauri::command]
pub fn cmd_watch_folder(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    window: WebviewWindow,
    path: PathBuf,
) -> AppResult<PathBuf> {
    let canonical = canonicalize(&path)?;
    ensure_directory(&canonical)?;
    ensure_workspace_owner(window.label())?;
    let owner = window.label().to_string();
    let watch_root = canonical.clone();
    state.register_workspace(canonical, owner, path.clone(), move |targets| {
        // One canonical watcher is shared by every owner. The watcher maps
        // event paths back to each owner's renderer-facing root spelling.
        watcher::spawn(app, watch_root, targets)
    })?;
    state.push_recent_folder(path.clone());
    Ok(path)
}

#[tauri::command]
pub fn cmd_unwatch_folder(
    state: tauri::State<'_, AppState>,
    window: WebviewWindow,
    path: PathBuf,
) -> AppResult<()> {
    ensure_workspace_owner(window.label())?;
    // A deleted/renamed root cannot be canonicalized. AppState retains the
    // renderer spelling per owner so that this still releases the right lease.
    let canonical = canonicalize(&path).ok();
    state.unregister_workspace_owner(canonical.as_deref(), &path, window.label());
    Ok(())
}
