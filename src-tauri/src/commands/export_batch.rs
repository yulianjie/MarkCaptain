//! Bounded project-export discovery and immutable, explicit source snapshots.
//! Output remains owned by the existing single-document writer and its grants.
use super::{export_project, notes, workspace::resolve_existing_inside};
use crate::{
    app::AppState,
    error::{AppError, AppResult},
    filesystem::encoding,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
};

const MAX_SOURCES: usize = 64;
const MAX_DOCUMENT: usize = 2_000_000;
const MAX_TOTAL: usize = 4 * 1024 * 1024;
const MAX_CANDIDATES: usize = 5000;
const MAX_VISITED: usize = 20_000;
const MAX_DEPTH: usize = 32;

fn invalid(message: impl Into<String>) -> AppError {
    AppError::InvalidArgument(message.into())
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn owned_root(state: &AppState, owner: &str, root: &Path) -> AppResult<PathBuf> {
    let root = std::fs::canonicalize(root)?;
    if !state
        .workspace_roots_for_window(owner)
        .iter()
        .any(|candidate| candidate == &root)
    {
        return Err(invalid("export:workspaceNotOwned"));
    }
    Ok(root)
}

fn excluded_component(path: &Path) -> bool {
    path.components().any(|component| {
        let name = component.as_os_str().to_string_lossy().to_ascii_lowercase();
        name.starts_with('.')
            || matches!(
                name.as_str(),
                ".git"
                    | ".markcaptain"
                    | "node_modules"
                    | "target"
                    | "dist"
                    | "build"
                    | ".cache"
                    | "cache"
                    | "__pycache__"
                    | ".next"
                    | ".nuxt"
                    | ".output"
                    | "coverage"
                    | ".venv"
                    | "venv"
            )
    })
}

fn excluded(root: &Path, path: &Path, outputs: &[PathBuf]) -> bool {
    path.strip_prefix(root).map_or(true, excluded_component)
        || outputs.iter().any(|directory| {
            if cfg!(windows) {
                let path = path.to_string_lossy().replace('\\', "/").to_lowercase();
                let directory = directory
                    .to_string_lossy()
                    .replace('\\', "/")
                    .to_lowercase();
                path == directory || path.starts_with(&format!("{directory}/"))
            } else {
                path.starts_with(directory)
            }
        })
}

// Reject every symlink/reparse-point component, including links pointing back
// inside the workspace: alternate spellings must not duplicate chapter inputs.
fn is_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn source_path(root: &Path, relative: &str, outputs: &[PathBuf]) -> AppResult<PathBuf> {
    if relative.len() > 1000 {
        return Err(invalid("export:invalidSourcePath"));
    }
    let relative = notes::relative_path(relative)?;
    let candidate = root.join(&relative);
    if excluded(root, &candidate, outputs) || !notes::is_note_markdown(&candidate) {
        return Err(invalid("export:excludedSource"));
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        if is_link(&std::fs::symlink_metadata(&current)?) {
            return Err(invalid("export:symlinkSource"));
        }
    }
    let resolved = resolve_existing_inside(root, &candidate, false)?;
    if !resolved.is_file() || excluded(root, &resolved, outputs) {
        return Err(invalid("export:invalidSource"));
    }
    Ok(resolved)
}

fn read_source(path: &Path) -> AppResult<String> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)?
        .take(MAX_DOCUMENT as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_DOCUMENT {
        return Err(invalid("export:sourceTooLarge"));
    }
    let (markdown, _, had_errors) = encoding::detect_and_decode(&bytes)?;
    if had_errors {
        return Err(invalid("export:sourceDecodeError"));
    }
    if markdown.len() > MAX_DOCUMENT {
        return Err(invalid("export:sourceTooLarge"));
    }
    Ok(markdown)
}

#[derive(Serialize)]
pub struct ProjectCandidate {
    path: PathBuf,
    relative: String,
    name: String,
    size: u64,
}

fn configured_outputs(root: &Path) -> AppResult<Vec<PathBuf>> {
    let config = export_project::read_config(root)?;
    let mut outputs = vec![root.join("exports")];
    if let Some(profiles) = config["config"]["profiles"].as_array() {
        for profile in profiles {
            if let Some(directory) = profile["output"]["directory"].as_str() {
                outputs.push(root.join(notes::relative_path(directory)?));
            }
        }
    }
    Ok(outputs)
}

pub(super) fn candidates(root: &Path) -> AppResult<Vec<ProjectCandidate>> {
    let outputs = configured_outputs(root)?;
    let mut candidates = Vec::new();
    let walker = walkdir::WalkDir::new(root)
        .follow_links(false)
        .max_depth(MAX_DEPTH + 1)
        .into_iter()
        .filter_entry(|entry| {
            entry.depth() == 0
                || (!excluded(root, entry.path(), &outputs)
                    && entry
                        .metadata()
                        .map(|metadata| !is_link(&metadata))
                        .unwrap_or(true))
        });
    for (visited, entry) in walker.enumerate() {
        if visited >= MAX_VISITED {
            return Err(invalid("export:projectCandidateLimit"));
        }
        let entry = entry.map_err(|_| invalid("export:projectUnreadable"))?;
        if entry.depth() > MAX_DEPTH {
            return Err(invalid("export:projectDepthLimit"));
        }
        if !entry.file_type().is_file() || !notes::is_note_markdown(entry.path()) {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(root)
            .map_err(|_| invalid("export:invalidSourcePath"))?
            .to_string_lossy()
            .replace('\\', "/");
        let path = source_path(root, &relative, &outputs)?;
        let size = entry
            .metadata()
            .map_err(|_| invalid("export:projectUnreadable"))?
            .len();
        candidates.push(ProjectCandidate {
            path,
            relative,
            size,
            name: entry.file_name().to_string_lossy().into_owned(),
        });
        if candidates.len() > MAX_CANDIDATES {
            return Err(invalid("export:projectCandidateLimit"));
        }
    }
    candidates.sort_by(|a, b| a.relative.cmp(&b.relative));
    Ok(candidates)
}

#[derive(Deserialize)]
pub struct DirtyBuffer {
    path: PathBuf,
    markdown: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentSnapshot {
    markdown: String,
    source_path: PathBuf,
    file_name: String,
    captured_at: String,
    revision: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSource {
    source_id: String,
    relative_path: String,
    snapshot: DocumentSnapshot,
    revision: String,
    origin: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotError {
    relative_path: String,
    code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSnapshot {
    root: PathBuf,
    sources: Vec<ProjectSource>,
    errors: Vec<SnapshotError>,
    captured_at: String,
    revision: String,
}

fn normalized(markdown: &str) -> String {
    markdown.replace("\r\n", "\n").replace('\r', "\n")
}
fn path_identity(relative: &str) -> String {
    if cfg!(windows) {
        relative.to_lowercase()
    } else {
        relative.into()
    }
}

fn snapshot(
    root: &Path,
    paths: Vec<String>,
    buffers: Vec<DirtyBuffer>,
) -> AppResult<ProjectSnapshot> {
    if paths.is_empty() || paths.len() > MAX_SOURCES || buffers.len() > MAX_SOURCES {
        return Err(invalid("export:projectSourceLimit"));
    }
    let outputs = configured_outputs(root)?;
    let mut dirty = HashMap::new();
    let mut buffer_bytes = 0usize;
    for buffer in buffers {
        if buffer.path.as_os_str().len() > 4096 {
            return Err(invalid("export:invalidSourcePath"));
        }
        if buffer.markdown.len() > MAX_DOCUMENT {
            return Err(invalid("export:sourceTooLarge"));
        }
        buffer_bytes += buffer.markdown.len();
        if buffer_bytes > MAX_TOTAL {
            return Err(invalid("export:projectSnapshotTooLarge"));
        }
        let path = std::fs::canonicalize(&buffer.path)?;
        let relative = path
            .strip_prefix(root)
            .map_err(|_| invalid("export:bufferOutsideProject"))?
            .to_string_lossy()
            .replace('\\', "/");
        source_path(root, &relative, &outputs)?;
        let markdown = normalized(&buffer.markdown);
        if let Some(previous) = dirty.insert(path, markdown.clone()) {
            if previous != markdown {
                return Err(invalid("export:conflictingBuffers"));
            }
        }
    }
    let captured_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut result = ProjectSnapshot {
        root: root.into(),
        sources: Vec::new(),
        errors: Vec::new(),
        captured_at: captured_at.clone(),
        revision: String::new(),
    };
    let mut seen = HashSet::new();
    let mut total = 0usize;
    let mut manifest = Vec::new();
    for requested in paths {
        // Reject traversal and duplicate identities globally; unreadable documents
        // remain per-item failures so healthy selected documents can still export.
        let relative = notes::relative_path(&requested)?
            .components()
            .collect::<PathBuf>()
            .to_string_lossy()
            .replace('\\', "/");
        if relative.len() > 1000 {
            return Err(invalid("export:invalidSourcePath"));
        }
        let identity = path_identity(&relative);
        if !seen.insert(identity.clone()) {
            return Err(invalid("export:duplicateSource"));
        }
        let captured = (|| -> AppResult<ProjectSource> {
            let path = source_path(root, &relative, &outputs)?;
            let (markdown, origin) = if let Some(markdown) = dirty.get(&path) {
                (markdown.clone(), "buffer")
            } else {
                (normalized(&read_source(&path)?), "disk")
            };
            let revision = hash(markdown.as_bytes());
            let file_name = path
                .file_name()
                .ok_or_else(|| invalid("export:invalidSource"))?
                .to_string_lossy()
                .into_owned();
            Ok(ProjectSource {
                source_id: hash(identity.as_bytes()),
                relative_path: relative.clone(),
                revision: revision.clone(),
                origin,
                snapshot: DocumentSnapshot {
                    markdown,
                    source_path: path,
                    file_name,
                    captured_at: captured_at.clone(),
                    revision,
                },
            })
        })();
        match captured {
            Ok(source) => {
                total += source.snapshot.markdown.len();
                if total > MAX_TOTAL {
                    return Err(invalid("export:projectSnapshotTooLarge"));
                }
                manifest.push((identity, source.revision.clone()));
                result.sources.push(source);
            }
            Err(error) => {
                let code = match error {
                    AppError::InvalidArgument(message) if message.starts_with("export:") => message,
                    _ => "export:sourceUnreadable".into(),
                };
                manifest.push((identity, code.clone()));
                result.errors.push(SnapshotError {
                    relative_path: relative,
                    code,
                });
            }
        }
    }
    result.revision = hash(&serde_json::to_vec(&manifest)?);
    Ok(result)
}

#[tauri::command]
pub async fn cmd_export_project_list(
    state: tauri::State<'_, AppState>,
    window: tauri::WebviewWindow,
    root: PathBuf,
) -> AppResult<Vec<ProjectCandidate>> {
    let root = owned_root(&state, window.label(), &root)?;
    let worker_root = root.clone();
    let result = tokio::task::spawn_blocking(move || candidates(&worker_root))
        .await
        .map_err(|_| invalid("export:projectWorkerFailed"))??;
    owned_root(&state, window.label(), &root)?;
    Ok(result)
}

#[tauri::command]
pub async fn cmd_export_project_snapshot(
    state: tauri::State<'_, AppState>,
    window: tauri::WebviewWindow,
    root: PathBuf,
    paths: Vec<String>,
    buffers: Vec<DirtyBuffer>,
) -> AppResult<ProjectSnapshot> {
    let root = owned_root(&state, window.label(), &root)?;
    let worker_root = root.clone();
    let result = tokio::task::spawn_blocking(move || snapshot(&worker_root, paths, buffers))
        .await
        .map_err(|_| invalid("export:projectWorkerFailed"))??;
    authorize_snapshot_sources(&state, window.label(), result)
}

fn authorize_snapshot_sources(
    state: &AppState,
    owner: &str,
    result: ProjectSnapshot,
) -> AppResult<ProjectSnapshot> {
    // An open editor tab is not required for an explicitly selected project
    // chapter. Reuse the resource reader's existing source capability, but only
    // after the entire bounded capture and the post-worker ownership check pass.
    let root = owned_root(state, owner, &result.root)?;
    let outputs = configured_outputs(&root)?;
    let paths = result
        .sources
        .iter()
        .map(|source| {
            let path = source_path(&root, &source.relative_path, &outputs)?;
            if path != source.snapshot.source_path {
                return Err(invalid("export:projectSourceChanged"));
            }
            Ok(path)
        })
        .collect::<AppResult<Vec<_>>>()?;
    for path in paths {
        state.authorize_document_source(&path)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn project() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn register_project(state: &AppState, root: &Path) {
        state
            .register_workspace(root.into(), "main".into(), root.into(), |_| {
                Ok::<_, AppError>(crate::filesystem::watcher::WatcherHandle {
                    root: root.into(),
                    debouncer: std::sync::Arc::new(parking_lot::Mutex::new(None)),
                })
            })
            .unwrap();
    }

    #[test]
    fn closed_selected_chapter_gets_resource_authority_only_after_successful_capture() {
        let temp = project();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let state = AppState::default();
        register_project(&state, &root);
        for name in ["selected.md", "unselected.md"] {
            std::fs::write(root.join(name), "![local](image.png)").unwrap();
        }
        std::fs::write(root.join("image.png"), b"fixture").unwrap();
        std::fs::create_dir(root.join("exports")).unwrap();
        std::fs::write(root.join("exports/generated.md"), "generated").unwrap();
        std::fs::write(root.join("oversize.md"), vec![b'x'; MAX_DOCUMENT + 1]).unwrap();
        assert!(!state.is_document_source_authorized(&root.join("selected.md")));
        let captured = snapshot(
            &root,
            vec![
                "selected.md".into(),
                "missing.md".into(),
                "exports/generated.md".into(),
                "oversize.md".into(),
            ],
            vec![],
        )
        .unwrap();
        // Capturing in the blocking worker alone grants no capability.
        assert!(!state.is_document_source_authorized(&root.join("selected.md")));
        let captured = authorize_snapshot_sources(&state, "main", captured).unwrap();
        assert_eq!(captured.sources.len(), 1);
        assert_eq!(captured.errors.len(), 3);
        // This is the unchanged cmd_export_read_resource eligibility check.
        assert!(state.is_document_source_authorized(&captured.sources[0].snapshot.source_path));
        for name in [
            "unselected.md",
            "missing.md",
            "exports/generated.md",
            "oversize.md",
        ] {
            assert!(
                !state.is_document_source_authorized(&root.join(name)),
                "{name}"
            );
        }
    }

    #[test]
    fn source_grants_are_withheld_when_owner_closes_or_snapshot_exceeds_budget() {
        let temp = project();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let state = AppState::default();
        register_project(&state, &root);
        std::fs::write(root.join("a.md"), "selected").unwrap();
        let captured = snapshot(&root, vec!["a.md".into()], vec![]).unwrap();
        state.unregister_all_workspaces_for_owner("main");
        assert!(authorize_snapshot_sources(&state, "main", captured).is_err());
        assert!(!state.is_document_source_authorized(&root.join("a.md")));
        register_project(&state, &root);
        for name in ["a.md", "b.md", "c.md"] {
            std::fs::write(root.join(name), vec![b'x'; MAX_DOCUMENT]).unwrap();
        }
        let result = snapshot(
            &root,
            vec!["a.md".into(), "b.md".into(), "c.md".into()],
            vec![],
        )
        .and_then(|captured| authorize_snapshot_sources(&state, "main", captured));
        assert!(result.is_err());
        for name in ["a.md", "b.md", "c.md"] {
            assert!(!state.is_document_source_authorized(&root.join(name)));
        }
    }

    #[test]
    fn frozen_sources_prefer_dirty_buffers_preserve_order_and_version_content() {
        let temp = project();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        std::fs::write(root.join("a.md"), "disk a\r\n").unwrap();
        std::fs::write(root.join("b.md"), "disk b").unwrap();
        let capture = || {
            snapshot(
                &root,
                vec!["b.md".into(), "a.md".into()],
                vec![DirtyBuffer {
                    path: root.join("a.md"),
                    markdown: "unsaved 中文\r\n".into(),
                }],
            )
            .unwrap()
        };
        let first = capture();
        assert_eq!(first.sources[0].relative_path, "b.md");
        assert_eq!(first.sources[0].origin, "disk");
        assert_eq!(first.sources[0].source_id, hash(b"b.md"));
        assert_eq!(first.sources[1].origin, "buffer");
        assert_eq!(first.sources[1].snapshot.markdown, "unsaved 中文\n");
        assert_eq!(first.revision, capture().revision);
        assert_eq!(
            std::fs::read_to_string(root.join("a.md")).unwrap(),
            "disk a\r\n"
        );
        std::fs::write(root.join("b.md"), "changed").unwrap();
        let second = capture();
        assert_ne!(first.revision, second.revision);
        assert_eq!(first.sources[0].source_id, second.sources[0].source_id);
        assert_eq!(first.sources[0].snapshot.markdown, "disk b");
        assert_ne!(second.sources[0].revision, first.sources[0].revision);
        let reversed = snapshot(&root, vec!["a.md".into(), "b.md".into()], vec![]).unwrap();
        assert_ne!(reversed.revision, second.revision);
    }

    #[test]
    fn duplicate_inputs_conflicting_buffers_and_request_budgets_are_rejected() {
        let temp = project();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        std::fs::write(root.join("a.md"), "a").unwrap();
        assert!(snapshot(&root, vec!["a.md".into(), "a.md".into()], vec![]).is_err());
        assert!(snapshot(
            &root,
            vec!["folder//a.md".into(), "folder/a.md".into()],
            vec![]
        )
        .is_err());
        assert!(snapshot(
            &root,
            vec!["a.md".into()],
            vec![
                DirtyBuffer {
                    path: root.join("a.md"),
                    markdown: "a".into()
                },
                DirtyBuffer {
                    path: root.join("a.md"),
                    markdown: "b".into()
                },
            ]
        )
        .is_err());
        assert!(snapshot(&root, vec!["a.md".into(); MAX_SOURCES + 1], vec![]).is_err());
        assert!(snapshot(&root, vec!["../a.md".into()], vec![]).is_err());
        for name in ["a.md", "b.md", "c.md"] {
            std::fs::write(root.join(name), vec![b'x'; MAX_DOCUMENT]).unwrap();
        }
        assert!(snapshot(
            &root,
            vec!["a.md".into(), "b.md".into(), "c.md".into()],
            vec![]
        )
        .is_err());
    }

    #[test]
    fn item_errors_are_redacted_and_do_not_drop_successful_sources() {
        let temp = project();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        std::fs::write(root.join("a.md"), "a").unwrap();
        std::fs::write(root.join("large.md"), vec![b'x'; MAX_DOCUMENT + 1]).unwrap();
        let result = snapshot(
            &root,
            vec!["missing.md".into(), "large.md".into(), "a.md".into()],
            vec![],
        )
        .unwrap();
        assert_eq!(result.sources.len(), 1);
        assert_eq!(result.errors.len(), 2);
        assert_eq!(result.errors[0].code, "export:sourceUnreadable");
        assert_eq!(result.errors[1].code, "export:sourceTooLarge");
        assert_eq!(result.errors[0].relative_path, "missing.md");
    }

    #[test]
    fn discovery_is_sorted_excludes_build_outputs_and_fails_closed_on_bad_config() {
        let temp = project();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        for name in ["b.md", "a.md"] {
            std::fs::write(root.join(name), "a").unwrap();
        }
        std::fs::create_dir(root.join("dist")).unwrap();
        std::fs::write(root.join("dist/generated.md"), "output").unwrap();
        assert_eq!(
            candidates(&root)
                .unwrap()
                .iter()
                .map(|item| item.relative.as_str())
                .collect::<Vec<_>>(),
            vec!["a.md", "b.md"]
        );
        std::fs::create_dir(root.join(".markcaptain")).unwrap();
        std::fs::write(root.join(".markcaptain/export.json"), "{broken}").unwrap();
        assert!(candidates(&root).is_err());
        assert!(snapshot(&root, vec!["a.md".into()], vec![]).is_err());
    }

    #[test]
    fn discovery_refuses_to_return_a_silently_truncated_candidate_list() {
        let temp = project();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        for index in 0..=MAX_CANDIDATES {
            std::fs::write(root.join(format!("{index}.md")), "").unwrap();
        }
        assert!(
            matches!(candidates(&root), Err(AppError::InvalidArgument(code)) if code == "export:projectCandidateLimit")
        );
    }

    #[test]
    fn source_paths_reject_escape_absolute_non_markdown_and_excluded_directories() {
        let temp = project();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        std::fs::write(root.join("ok.md"), "ok").unwrap();
        std::fs::write(root.join("private.txt"), "secret").unwrap();
        for directory in ["exports", "delivery", "build", "dist", ".cache", "target"] {
            std::fs::create_dir(root.join(directory)).unwrap();
            std::fs::write(root.join(directory).join("generated.md"), "output").unwrap();
        }
        let outputs = vec![root.join("exports"), root.join("delivery")];
        assert!(source_path(&root, "ok.md", &outputs).is_ok());
        for path in [
            "../escape.md",
            "C:/escape.md",
            "/escape.md",
            "private.txt",
            "exports/generated.md",
            "delivery/generated.md",
            "build/generated.md",
            "dist/generated.md",
            ".cache/generated.md",
            "target/generated.md",
        ] {
            assert!(source_path(&root, path, &outputs).is_err(), "{path}");
        }
    }

    #[test]
    fn workspace_authority_is_window_owned_and_revoked_on_close() {
        let temp = project();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let state = AppState::default();
        assert!(owned_root(&state, "main", &root).is_err());
        state
            .register_workspace(root.clone(), "main".into(), root.clone(), |_| {
                Ok::<_, AppError>(crate::filesystem::watcher::WatcherHandle {
                    root: root.clone(),
                    debouncer: std::sync::Arc::new(parking_lot::Mutex::new(None)),
                })
            })
            .unwrap();
        assert_eq!(owned_root(&state, "main", &root).unwrap(), root);
        assert!(owned_root(&state, "editor-2", &root).is_err());
        state.unregister_all_workspaces_for_owner("main");
        assert!(owned_root(&state, "main", &root).is_err());
    }

    #[test]
    fn document_byte_limit_and_decode_errors_are_enforced() {
        let temp = project();
        let path = temp.path().join("large.md");
        std::fs::write(&path, vec![b'a'; MAX_DOCUMENT + 1]).unwrap();
        assert!(read_source(&path).is_err());
        std::fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();
        assert!(read_source(&path).is_err());
        std::fs::write(&path, [0xff, 0xfe, b'x', 0]).unwrap();
        assert_eq!(read_source(&path).unwrap(), "x");
    }

    #[cfg(unix)]
    #[test]
    fn symlink_files_and_parent_directories_are_rejected() {
        let temp = project();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        std::fs::create_dir(root.join("inside")).unwrap();
        std::fs::write(root.join("inside/document.md"), "inside").unwrap();
        std::os::unix::fs::symlink(root.join("inside"), root.join("link")).unwrap();
        std::os::unix::fs::symlink(root.join("inside/document.md"), root.join("alias.md")).unwrap();
        assert!(source_path(&root, "link/document.md", &[]).is_err());
        assert!(source_path(&root, "alias.md", &[]).is_err());
        assert_eq!(candidates(&root).unwrap().len(), 1);
    }

    #[cfg(windows)]
    #[test]
    fn junction_parent_directories_are_rejected() {
        let temp = project();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        std::fs::create_dir(root.join("inside")).unwrap();
        std::fs::write(root.join("inside/document.md"), "inside").unwrap();
        // Junctions do not require Developer Mode or symlink privileges.
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(temp.path().join("link"))
            .arg(temp.path().join("inside"))
            .stdout(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
        assert!(source_path(&root, "link/document.md", &[]).is_err());
        assert_eq!(candidates(&root).unwrap().len(), 1);
        std::fs::remove_dir(temp.path().join("link")).unwrap();
    }
}
