//! Top-level application state and startup hooks.
//!
//! Equivalent to the original `upstream/src/main/app/index.js` `App` class —
//! owns the recent-documents list, file watchers, and any other long-lived
//! state that outlives a single command invocation.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::RwLock;
use tauri::App;

use crate::error::AppResult;
use crate::filesystem::watcher::{WatcherHandle, WorkspaceEventTargets};

/// Long-lived state shared across all command handlers via [`tauri::State`].
#[derive(Clone, Default)]
pub struct AppState {
    inner: Arc<RwLock<AppStateInner>>,
}

#[derive(Default)]
struct AppStateInner {
    /// Workspaces (folders) currently opened in the renderer, keyed by path.
    workspaces: WorkspaceRegistry<WatcherHandle>,

    /// Recent files (most-recent first), capped to ~20 entries.
    recent_files: Vec<PathBuf>,

    /// Recent folders (most-recent first), capped to ~20 entries.
    recent_folders: Vec<PathBuf>,

    /// Secrets must not be persisted in `preferences.json`. The GitHub image
    /// upload token intentionally lives only for the lifetime of this process.
    github_token: Option<String>,

    /// Canonical Markdown documents selected through the file read/save
    /// commands during this process lifetime. Export helpers use this as a
    /// source-document capability; workspace membership alone is insufficient
    /// for single-file editor sessions.
    authorized_document_sources: HashSet<PathBuf>,
}

struct RegisteredWorkspace<W> {
    watcher: W,
    targets: WorkspaceEventTargets,
}

struct WorkspaceRegistry<W> {
    by_root: HashMap<PathBuf, RegisteredWorkspace<W>>,
}

impl<W> Default for WorkspaceRegistry<W> {
    fn default() -> Self {
        Self {
            by_root: HashMap::new(),
        }
    }
}

impl<W> WorkspaceRegistry<W> {
    /// Add one window as an owner of a canonical workspace. The factory is
    /// called only for the first owner, so concurrent renderer invokes cannot
    /// replace an already-running watcher for the same root.
    fn register<E>(
        &mut self,
        root: PathBuf,
        owner: String,
        renderer_root: PathBuf,
        create_watcher: impl FnOnce(WorkspaceEventTargets) -> Result<W, E>,
    ) -> Result<bool, E> {
        if let Some(workspace) = self.by_root.get_mut(&root) {
            workspace.targets.write().insert(owner, renderer_root);
            return Ok(false);
        }

        let targets = WorkspaceEventTargets::default();
        targets.write().insert(owner, renderer_root);
        let watcher = create_watcher(targets.clone())?;
        self.by_root
            .insert(root, RegisteredWorkspace { watcher, targets });
        Ok(true)
    }

    fn roots(&self) -> Vec<PathBuf> {
        self.by_root.keys().cloned().collect()
    }

    /// Remove one owner. `canonical_root` is preferred while the path still
    /// exists; `renderer_root` is the deletion-safe fallback retained at
    /// registration time for roots that were renamed or removed externally.
    fn unregister_owner(
        &mut self,
        canonical_root: Option<&Path>,
        renderer_root: &Path,
        owner: &str,
    ) -> Option<W> {
        let root = canonical_root
            .filter(|root| {
                self.by_root
                    .get(*root)
                    .is_some_and(|workspace| workspace.targets.read().contains_key(owner))
            })
            .map(Path::to_path_buf)
            .or_else(|| {
                self.by_root.iter().find_map(|(root, workspace)| {
                    let targets = workspace.targets.read();
                    targets
                        .get(owner)
                        .filter(|registered| renderer_paths_match(registered, renderer_root))
                        .map(|_| root.clone())
                })
            })?;

        let remove_workspace = {
            let workspace = self.by_root.get_mut(&root)?;
            workspace.targets.write().remove(owner);
            workspace.targets.read().is_empty()
        };
        if remove_workspace {
            self.by_root
                .remove(&root)
                .map(|workspace| workspace.watcher)
        } else {
            None
        }
    }

    fn unregister_owner_everywhere(&mut self, owner: &str) -> Vec<W> {
        let mut empty_roots = Vec::new();
        for (root, workspace) in &mut self.by_root {
            let mut targets = workspace.targets.write();
            targets.remove(owner);
            if targets.is_empty() {
                empty_roots.push(root.clone());
            }
        }
        empty_roots
            .into_iter()
            .filter_map(|root| {
                self.by_root
                    .remove(&root)
                    .map(|workspace| workspace.watcher)
            })
            .collect()
    }
}

fn renderer_paths_match(first: &Path, second: &Path) -> bool {
    if first == second {
        return true;
    }
    #[cfg(windows)]
    {
        fn windows_key(path: &Path) -> String {
            let mut value = path.to_string_lossy().replace('\\', "/");
            if let Some(rest) = value.strip_prefix("//?/UNC/") {
                value = format!("//{rest}");
            } else if let Some(rest) = value.strip_prefix("//?/") {
                value = rest.to_string();
            }
            while value.len() > 1 && value.ends_with('/') {
                value.pop();
            }
            value.to_lowercase()
        }
        windows_key(first) == windows_key(second)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

impl AppState {
    /// Grant process-lifetime export-source authority to an existing Markdown
    /// document that the user has just read or saved through the editor.
    pub fn authorize_document_source(&self, path: &Path) -> AppResult<()> {
        let canonical = std::fs::canonicalize(path)?;
        if !canonical.is_file() || !is_markdown_document(&canonical) {
            return Err(crate::error::AppError::InvalidArgument(
                "only existing Markdown documents can be authorized as export sources".into(),
            ));
        }
        self.inner
            .write()
            .authorized_document_sources
            .insert(canonical);
        Ok(())
    }

    /// Check an export-source path against the canonical documents authorized
    /// by successful editor reads/saves in this application process.
    pub fn is_document_source_authorized(&self, path: &Path) -> bool {
        if !is_markdown_document(path) {
            return false;
        }
        let Ok(canonical) = std::fs::canonicalize(path) else {
            return false;
        };
        canonical.is_file()
            && is_markdown_document(&canonical)
            && self
                .inner
                .read()
                .authorized_document_sources
                .contains(&canonical)
    }

    pub fn push_recent_file(&self, path: PathBuf) {
        let mut inner = self.inner.write();
        inner.recent_files.retain(|p| p != &path);
        inner.recent_files.insert(0, path);
        inner.recent_files.truncate(20);
    }

    pub fn push_recent_folder(&self, path: PathBuf) {
        let mut inner = self.inner.write();
        inner.recent_folders.retain(|p| p != &path);
        inner.recent_folders.insert(0, path);
        inner.recent_folders.truncate(20);
    }

    pub fn recent_files(&self) -> Vec<PathBuf> {
        self.inner.read().recent_files.clone()
    }

    pub fn recent_folders(&self) -> Vec<PathBuf> {
        self.inner.read().recent_folders.clone()
    }

    pub fn register_workspace(
        &self,
        root: PathBuf,
        owner: String,
        renderer_root: PathBuf,
        create_watcher: impl FnOnce(WorkspaceEventTargets) -> AppResult<WatcherHandle>,
    ) -> AppResult<bool> {
        self.inner
            .write()
            .workspaces
            .register(root, owner, renderer_root, create_watcher)
    }

    pub fn unregister_workspace_owner(
        &self,
        canonical_root: Option<&Path>,
        renderer_root: &Path,
        owner: &str,
    ) {
        let watcher =
            self.inner
                .write()
                .workspaces
                .unregister_owner(canonical_root, renderer_root, owner);
        drop(watcher);
    }

    /// Drop every workspace lease held by a renderer that has been destroyed.
    /// This is idempotent with an explicit `cmd_unwatch_folder` call.
    pub fn unregister_all_workspaces_for_owner(&self, owner: &str) {
        let watchers = self
            .inner
            .write()
            .workspaces
            .unregister_owner_everywhere(owner);
        drop(watchers);
    }

    /// Return a snapshot of the roots currently registered by renderer
    /// workspaces. Filesystem commands canonicalize these paths before doing
    /// containment checks, so a caller cannot widen its authority by merely
    /// supplying an arbitrary `root` argument.
    pub fn workspace_roots(&self) -> Vec<PathBuf> {
        self.inner.read().workspaces.roots()
    }

    /// Return only canonical roots currently owned by a particular editor
    /// window. Long-running Agent tasks use this to revalidate project grants
    /// after a workspace is closed or ownership changes.
    pub fn workspace_roots_for_window(&self, owner: &str) -> Vec<PathBuf> {
        self.inner
            .read()
            .workspaces
            .by_root
            .iter()
            .filter_map(|(root, workspace)| {
                workspace
                    .targets
                    .read()
                    .contains_key(owner)
                    .then(|| root.clone())
            })
            .collect()
    }

    pub fn set_github_token(&self, token: String) {
        let mut inner = self.inner.write();
        inner.github_token = if token.is_empty() { None } else { Some(token) };
    }

    pub fn github_token(&self) -> Option<String> {
        self.inner.read().github_token.clone()
    }
}

/// Keep this extension rule local to AppState: `commands::notes` depends on
/// AppState, so importing its helper here would create an unnecessary module
/// dependency cycle. Match the note index's accepted Markdown suffixes.
pub(crate) fn is_markdown_document(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("md" | "markdown" | "mkd" | "mdown" | "mkdn" | "mdtxt" | "mdtext")
    )
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::path::PathBuf;
    use std::sync::Arc;

    use super::{AppState, WorkspaceRegistry};
    use crate::filesystem::watcher::WatcherHandle;

    #[test]
    fn github_token_is_process_memory_only_state() {
        let state = AppState::default();
        assert_eq!(state.github_token(), None);
        state.set_github_token("secret".into());
        assert_eq!(state.github_token().as_deref(), Some("secret"));
        state.set_github_token(String::new());
        assert_eq!(state.github_token(), None);
    }

    #[test]
    fn document_source_authorization_is_canonical_markdown_and_process_scoped() {
        let tmp = tempfile::tempdir().unwrap();
        let note = tmp.path().join("项目.MD");
        let text = tmp.path().join("readme.txt");
        std::fs::write(&note, "# Note").unwrap();
        std::fs::write(&text, "not Markdown").unwrap();

        let state = AppState::default();
        assert!(!state.is_document_source_authorized(&note));
        state.authorize_document_source(&note).unwrap();
        assert!(state.is_document_source_authorized(&note));
        assert!(state.is_document_source_authorized(&tmp.path().join(".").join("项目.MD")));
        assert!(!state.is_document_source_authorized(&text));
        assert!(state.authorize_document_source(&text).is_err());
        assert!(state
            .authorize_document_source(&tmp.path().join("missing.md"))
            .is_err());

        // This capability is intentionally retained for the application
        // process even if the renderer closes its current workspace session.
        state.unregister_all_workspaces_for_owner("main");
        assert!(state.is_document_source_authorized(&note));
    }

    #[test]
    fn workspace_registry_shares_one_watcher_until_the_last_owner_leaves() {
        let mut registry = WorkspaceRegistry::<usize>::default();
        let canonical = PathBuf::from("/canonical/notes");
        let main_root = PathBuf::from("/renderer/main/notes");
        let child_root = PathBuf::from("/renderer/child/notes");
        let created = Cell::new(0);

        assert!(registry
            .register(canonical.clone(), "main".into(), main_root.clone(), |_| {
                created.set(created.get() + 1);
                Ok::<_, ()>(41)
            },)
            .unwrap());
        assert!(!registry
            .register(
                canonical.clone(),
                "editor-2".into(),
                child_root.clone(),
                |_| {
                    created.set(created.get() + 1);
                    Ok::<_, ()>(99)
                },
            )
            .unwrap());

        assert_eq!(created.get(), 1, "the second owner must reuse the watcher");
        assert_eq!(registry.roots(), vec![canonical.clone()]);
        assert_eq!(
            registry.unregister_owner(Some(&canonical), &main_root, "main"),
            None,
            "one owner leaving must retain watcher authority for the other",
        );
        assert_eq!(registry.roots(), vec![canonical.clone()]);
        let targets = registry.by_root[&canonical].targets.read();
        assert_eq!(targets.len(), 1);
        assert_eq!(targets.get("editor-2"), Some(&child_root));
        drop(targets);

        assert_eq!(
            registry.unregister_owner(Some(&canonical), &child_root, "editor-2"),
            Some(41),
        );
        assert!(registry.roots().is_empty());
    }

    #[test]
    fn repeated_watch_by_one_owner_is_idempotent_and_updates_its_spelling() {
        let mut registry = WorkspaceRegistry::<usize>::default();
        let canonical = PathBuf::from("/canonical/notes");
        registry
            .register(
                canonical.clone(),
                "main".into(),
                PathBuf::from("/old-spelling"),
                |_| Ok::<_, ()>(7),
            )
            .unwrap();

        assert!(!registry
            .register(
                canonical.clone(),
                "main".into(),
                PathBuf::from("/new-spelling"),
                |_| -> Result<usize, ()> { panic!("idempotent watch created a second watcher") },
            )
            .unwrap());
        assert_eq!(
            registry.by_root[&canonical].targets.read().get("main"),
            Some(&PathBuf::from("/new-spelling")),
        );
    }

    #[test]
    fn deleted_root_unregisters_by_the_owners_saved_renderer_path() {
        let mut registry = WorkspaceRegistry::<usize>::default();
        let canonical = PathBuf::from("/canonical/deleted");
        let renderer = PathBuf::from("/renderer/deleted");
        registry
            .register(canonical, "main".into(), renderer.clone(), |_| {
                Ok::<_, ()>(5)
            })
            .unwrap();

        assert_eq!(registry.unregister_owner(None, &renderer, "main"), Some(5),);
        assert!(registry.roots().is_empty());
    }

    #[test]
    fn destroyed_owner_is_removed_from_every_workspace_without_revoking_peers() {
        let mut registry = WorkspaceRegistry::<usize>::default();
        let first = PathBuf::from("/canonical/first");
        let second = PathBuf::from("/canonical/second");
        registry
            .register(
                first.clone(),
                "main".into(),
                PathBuf::from("/first"),
                |_| Ok::<_, ()>(1),
            )
            .unwrap();
        registry
            .register(
                first.clone(),
                "editor-2".into(),
                PathBuf::from("/first-alias"),
                |_| Ok::<_, ()>(9),
            )
            .unwrap();
        registry
            .register(
                second.clone(),
                "main".into(),
                PathBuf::from("/second"),
                |_| Ok::<_, ()>(2),
            )
            .unwrap();

        assert_eq!(registry.unregister_owner_everywhere("main"), vec![2]);
        assert_eq!(registry.roots(), vec![first.clone()]);
        assert!(registry.by_root[&first]
            .targets
            .read()
            .contains_key("editor-2"));
    }

    #[test]
    fn workspace_roots_are_scoped_to_the_owning_window() {
        let state = AppState::default();
        let first = PathBuf::from("/canonical/first");
        let second = PathBuf::from("/canonical/second");
        state
            .register_workspace(first.clone(), "main".into(), PathBuf::from("/main"), |_| {
                Ok::<_, crate::error::AppError>(WatcherHandle {
                    root: first.clone(),
                    debouncer: Arc::new(parking_lot::Mutex::new(None)),
                })
            })
            .unwrap();
        state
            .register_workspace(
                first.clone(),
                "editor-2".into(),
                PathBuf::from("/editor-2"),
                |_| {
                    Ok::<_, crate::error::AppError>(WatcherHandle {
                        root: first.clone(),
                        debouncer: Arc::new(parking_lot::Mutex::new(None)),
                    })
                },
            )
            .unwrap();
        state
            .register_workspace(
                second.clone(),
                "editor-2".into(),
                PathBuf::from("/editor-2b"),
                |_| {
                    Ok::<_, crate::error::AppError>(WatcherHandle {
                        root: second.clone(),
                        debouncer: Arc::new(parking_lot::Mutex::new(None)),
                    })
                },
            )
            .unwrap();

        let mut main_roots = state.workspace_roots_for_window("main");
        let mut second_roots = state.workspace_roots_for_window("editor-2");
        main_roots.sort();
        second_roots.sort();
        assert_eq!(main_roots, vec![first.clone()]);
        assert_eq!(second_roots, vec![first, second]);
        assert!(state.workspace_roots_for_window("editor-3").is_empty());
    }
}

/// Called once on Tauri `setup`. Inspects `std::env::args` for any positional
/// file arguments and retains them until the editor explicitly drains them.
/// This is also the path
/// file-association launches take on Windows / Linux (the OS hands the path
/// in as argv[1]).
pub fn on_startup(app: &mut App) -> AppResult<()> {
    tracing::info!("MarkCaptain starting up");

    let files = crate::file_open::launch_files(std::env::args().skip(1), &std::env::current_dir()?);
    crate::file_open::enqueue(app.handle(), "main", files);

    Ok(())
}
