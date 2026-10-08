//! Conservative one-shot reconciliation for a local workspace.
//!
//! It never treats a simultaneous local/remote change as a last-writer-wins
//! update.  Instead it returns an explicit conflict for the caller to show in
//! the conflict center (or hand to the Agent after the user asks it to help).

use super::{
    ConditionalDelete, ConditionalWrite, RemoteContentHash, RemoteEntry, RemoteEntryKind,
    RemoteIdentity, RemotePath, RemoteVersion, StorageError, StorageErrorCode, StorageProvider,
    StorageResult, WritePrecondition,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
};
use walkdir::WalkDir;

const MANIFEST_FILE: &str = ".markcaptain-sync-manifest.json";
const JOURNAL_FILE: &str = ".markcaptain-sync-journal.json";
const MANIFEST_VERSION: u8 = 1;
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncManifest {
    pub schema_version: u8,
    #[serde(default)]
    pub files: BTreeMap<RemotePath, SyncedFile>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncedFile {
    pub local_hash: String,
    pub remote_version: RemoteVersion,
    /// The remote identity and digest are intentionally optional: older
    /// WebDAV servers and v1 plugins only have an opaque version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_id: Option<RemoteIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_content_hash: Option<RemoteContentHash>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum SyncAction {
    CreateRemoteDir {
        path: RemotePath,
    },
    Upload {
        path: RemotePath,
        expected_local_hash: String,
        precondition: WritePrecondition,
    },
    Download {
        path: RemotePath,
        expected_remote_version: Option<RemoteVersion>,
        expected_local_hash: Option<String>,
    },
    DeleteRemote {
        path: RemotePath,
        expected_remote_version: RemoteVersion,
    },
    DeleteLocal {
        path: RemotePath,
        expected_local_hash: String,
    },
}

/// Durable intent written before a file action.  If the process dies after a
/// remote mutation but before the manifest checkpoint, a later sync can
/// verify the resulting bytes and safely finish that checkpoint instead of
/// blindly retrying an old compare-and-swap operation.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncJournal {
    action: SyncAction,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SyncConflictReason {
    BothChanged,
    BothCreated,
    LocalChangedRemoteDeleted,
    LocalDeletedRemoteChanged,
    LocalChangedSincePlan,
    RemoteChangedSincePlan,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SyncConflict {
    pub path: RemotePath,
    pub reason: SyncConflictReason,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SyncPlan {
    pub actions: Vec<SyncAction>,
    pub conflicts: Vec<SyncConflict>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SyncOutcome {
    pub applied: Vec<SyncAction>,
    pub conflicts: Vec<SyncConflict>,
}

pub struct OneShotSync<'a> {
    provider: &'a dyn StorageProvider,
    root: PathBuf,
}

impl<'a> OneShotSync<'a> {
    pub fn new(
        provider: &'a dyn StorageProvider,
        local_root: impl AsRef<Path>,
    ) -> StorageResult<Self> {
        let root = std::fs::canonicalize(local_root)
            .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
        if !root.is_dir() {
            return Err(StorageError::new(StorageErrorCode::InvalidConfig));
        }
        Ok(Self { provider, root })
    }

    pub fn manifest_path(&self) -> PathBuf {
        self.root.join(MANIFEST_FILE)
    }

    fn journal_path(&self) -> PathBuf {
        self.root.join(JOURNAL_FILE)
    }

    pub async fn plan(&self) -> StorageResult<SyncPlan> {
        let manifest = self.load_manifest().await?;
        let local = self.local_tree().await?;
        let remote = self.remote_tree().await?;
        Ok(build_plan(&manifest, &local, &remote))
    }

    /// Executes a plan after checking the local side has not changed since it
    /// was made. Provider conflict responses become explicit conflicts; no
    /// unrelated action is retried with an unconditional write.
    pub async fn apply(&self, plan: SyncPlan) -> StorageResult<SyncOutcome> {
        // A provider must positively prove that it supports conditional
        // writes before this engine can mutate its remote binding.  Pure
        // pulls remain safe and work with a read-only provider.  This also
        // protects plugin implementations that honestly report a
        // last-writer-wins backend.
        if plan.actions.iter().any(action_mutates_remote)
            && !self.provider.probe().await?.conditional_write
        {
            return Err(StorageError::unsupported());
        }

        let mut manifest = self.load_manifest().await?;
        let mut outcome = SyncOutcome {
            applied: Vec::new(),
            conflicts: plan.conflicts,
        };
        for action in plan.actions {
            let journaled = action_updates_manifest(&action);
            if journaled {
                self.save_journal(&SyncJournal {
                    action: action.clone(),
                })
                .await?;
            }
            match self.apply_action(&action).await {
                Ok(()) => {
                    if journaled {
                        self.checkpoint_action(&mut manifest, &action).await?;
                        // The manifest replacement is durable before the
                        // journal is removed, so a crash can never expose a
                        // partially written base state.
                        self.save_manifest(&manifest).await?;
                        self.clear_journal().await?;
                    }
                    outcome.applied.push(action);
                }
                Err(error) if error.code == StorageErrorCode::Conflict => {
                    if journaled {
                        // A confirmed precondition failure made no mutation;
                        // retaining the intent would make a future sync infer
                        // a successful action incorrectly.
                        self.clear_journal().await?;
                    }
                    outcome.conflicts.push(SyncConflict {
                        path: action_path(&action).clone(),
                        reason: SyncConflictReason::RemoteChangedSincePlan,
                    });
                }
                Err(error) => return Err(error),
            }
        }
        Ok(outcome)
    }

    async fn apply_action(&self, action: &SyncAction) -> StorageResult<()> {
        match action {
            SyncAction::CreateRemoteDir { path } => {
                self.provider.create_dir(path).await?;
            }
            SyncAction::Upload {
                path,
                expected_local_hash,
                precondition,
            } => {
                let bytes = self
                    .read_local_file_checked(path, expected_local_hash)
                    .await?;
                self.provider
                    .write(ConditionalWrite {
                        path: path.clone(),
                        bytes,
                        precondition: precondition.clone(),
                    })
                    .await?;
            }
            SyncAction::Download {
                path,
                expected_remote_version,
                expected_local_hash,
            } => {
                if let Some(hash) = expected_local_hash {
                    // A remote-only download should not overwrite a file that
                    // appeared locally after the plan was constructed.
                    let current = self.local_hash(path).await?;
                    if current.as_deref() != Some(hash) {
                        return Err(StorageError::new(StorageErrorCode::Conflict));
                    }
                } else if self.local_hash(path).await?.is_some() {
                    return Err(StorageError::new(StorageErrorCode::Conflict));
                }
                let content = self.provider.read(path).await?;
                if content.version != *expected_remote_version {
                    return Err(StorageError::new(StorageErrorCode::Conflict));
                }
                let target = self.local_path(path)?;
                if let Some(parent) = target.parent() {
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
                }
                crate::filesystem::atomic_write::write_async(target, content.bytes)
                    .await
                    .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
            }
            SyncAction::DeleteRemote {
                path,
                expected_remote_version,
            } => {
                // A file recreated locally after planning turns this into a
                // delete-vs-create race.  Never delete the remote base in
                // that case merely because its old version still matches.
                if self.local_hash(path).await?.is_some() {
                    return Err(StorageError::new(StorageErrorCode::Conflict));
                }
                self.provider
                    .delete(ConditionalDelete {
                        path: path.clone(),
                        expected: Some(expected_remote_version.clone()),
                    })
                    .await?;
            }
            SyncAction::DeleteLocal {
                path,
                expected_local_hash,
            } => {
                let current = self.local_hash(path).await?;
                if current.as_deref() != Some(expected_local_hash) {
                    return Err(StorageError::new(StorageErrorCode::Conflict));
                }
                // The remote was missing while planning.  If it has been
                // recreated since, preserve this local copy for an explicit
                // delete/edit resolution instead of deleting it silently.
                if self.remote_entry(path).await?.is_some() {
                    return Err(StorageError::new(StorageErrorCode::Conflict));
                }
                tokio::fs::remove_file(self.local_path(path)?)
                    .await
                    .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
            }
        }
        Ok(())
    }

    fn local_path(&self, path: &RemotePath) -> StorageResult<PathBuf> {
        if path.is_root() {
            return Err(StorageError::invalid_path());
        }
        let target = path
            .segments()
            .fold(self.root.clone(), |target, segment| target.join(segment));
        // `RemotePath` blocks traversal. This additional check protects the
        // invariant if a future deserializer changes it.
        if !target.starts_with(&self.root) {
            return Err(StorageError::invalid_path());
        }
        Ok(target)
    }

    async fn read_local_file_checked(
        &self,
        path: &RemotePath,
        expected_hash: &str,
    ) -> StorageResult<Vec<u8>> {
        let target = self.local_path(path)?;
        let metadata = tokio::fs::metadata(&target)
            .await
            .map_err(|_| StorageError::new(StorageErrorCode::Conflict))?;
        if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
            return Err(StorageError::new(StorageErrorCode::Conflict));
        }
        let bytes = tokio::fs::read(target)
            .await
            .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
        if hash_bytes(&bytes) != expected_hash {
            return Err(StorageError::new(StorageErrorCode::Conflict));
        }
        Ok(bytes)
    }

    async fn local_hash(&self, path: &RemotePath) -> StorageResult<Option<String>> {
        let target = self.local_path(path)?;
        match tokio::fs::metadata(&target).await {
            Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_FILE_BYTES => {
                let bytes = tokio::fs::read(target)
                    .await
                    .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
                Ok(Some(hash_bytes(&bytes)))
            }
            Ok(_) => Ok(None),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(StorageError::new(StorageErrorCode::Io)),
        }
    }

    async fn checkpoint_action(
        &self,
        manifest: &mut SyncManifest,
        action: &SyncAction,
    ) -> StorageResult<()> {
        match action {
            SyncAction::Upload { path, .. } | SyncAction::Download { path, .. } => {
                let local_hash = self
                    .local_hash(path)
                    .await?
                    .ok_or_else(|| StorageError::new(StorageErrorCode::Conflict))?;
                let remote = self
                    .remote_entry(path)
                    .await?
                    .ok_or_else(|| StorageError::new(StorageErrorCode::Conflict))?;
                let remote_version = remote
                    .version
                    .clone()
                    .ok_or_else(StorageError::invalid_response)?;

                // Re-read after an upload/download before recording a new
                // base.  A concurrent update in the small gap is a conflict,
                // never a base that would hide divergent bytes on the next
                // run.  Providers that return an optional content hash are
                // required to agree with the bytes they just served.
                let content = self.provider.read(path).await?;
                if hash_bytes(&content.bytes) != local_hash
                    || content
                        .version
                        .as_ref()
                        .is_some_and(|version| version != &remote_version)
                    || remote
                        .content_hash
                        .as_ref()
                        .is_some_and(|hash| hash.as_str() != local_hash)
                {
                    return Err(StorageError::new(StorageErrorCode::Conflict));
                }
                manifest.files.insert(
                    path.clone(),
                    SyncedFile {
                        local_hash,
                        remote_version,
                        remote_id: remote.remote_id,
                        remote_content_hash: remote.content_hash,
                    },
                );
            }
            SyncAction::DeleteRemote { path, .. } | SyncAction::DeleteLocal { path, .. } => {
                manifest.files.remove(path);
            }
            SyncAction::CreateRemoteDir { .. } => {}
        }
        Ok(())
    }

    async fn remote_entry(&self, path: &RemotePath) -> StorageResult<Option<RemoteEntry>> {
        let parent = parent_path(path)?;
        let entries = self.provider.list(&parent).await?;
        let mut result = None;
        for entry in entries {
            if entry.path.is_root() || !is_child_of(&parent, &entry.path) {
                return Err(StorageError::invalid_response());
            }
            if entry.path == *path {
                if !matches!(entry.kind, RemoteEntryKind::File) || result.replace(entry).is_some() {
                    return Err(StorageError::invalid_response());
                }
            }
        }
        Ok(result)
    }

    async fn local_tree(&self) -> StorageResult<LocalTree> {
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || scan_local_tree(&root))
            .await
            .map_err(|_| StorageError::new(StorageErrorCode::Io))?
    }

    async fn remote_tree(&self) -> StorageResult<RemoteTree> {
        let mut files = BTreeMap::new();
        let mut dirs = BTreeSet::new();
        let mut pending = vec![RemotePath::root()];
        let mut listed = BTreeSet::new();
        while let Some(directory) = pending.pop() {
            if !listed.insert(directory.clone()) {
                continue;
            }
            for entry in self.provider.list(&directory).await? {
                if entry.path.is_root() || !is_child_of(&directory, &entry.path) {
                    return Err(StorageError::invalid_response());
                }
                if is_internal_path(&entry.path) {
                    continue;
                }
                match entry.kind {
                    RemoteEntryKind::Directory => {
                        dirs.insert(entry.path.clone());
                        pending.push(entry.path);
                    }
                    RemoteEntryKind::File => {
                        files.insert(entry.path.clone(), entry);
                    }
                }
            }
        }
        Ok(RemoteTree { files, dirs })
    }

    async fn load_manifest(&self) -> StorageResult<SyncManifest> {
        let manifest = match tokio::fs::read(self.manifest_path()).await {
            Ok(bytes) => {
                let manifest: SyncManifest =
                    serde_json::from_slice(&bytes).map_err(|_| StorageError::invalid_config())?;
                if manifest.schema_version != MANIFEST_VERSION || manifest.files.len() > 100_000 {
                    return Err(StorageError::invalid_config());
                }
                for (path, entry) in &manifest.files {
                    RemotePath::new(path.as_str())?;
                    if entry.local_hash.len() != 64
                        || !entry
                            .local_hash
                            .bytes()
                            .all(|byte| byte.is_ascii_hexdigit())
                    {
                        return Err(StorageError::invalid_config());
                    }
                    RemoteVersion::new(entry.remote_version.opaque.clone())?;
                    if let Some(remote_id) = &entry.remote_id {
                        RemoteIdentity::new(remote_id.opaque.clone())?;
                    }
                    if let Some(content_hash) = &entry.remote_content_hash {
                        RemoteContentHash::new(content_hash.as_str())?;
                    }
                }
                manifest
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => SyncManifest {
                schema_version: MANIFEST_VERSION,
                files: BTreeMap::new(),
            },
            Err(_) => return Err(StorageError::new(StorageErrorCode::Io)),
        };
        match self.load_journal().await? {
            Some(journal) => {
                let mut recovered = manifest;
                self.recover_journal(&mut recovered, &journal).await?;
                self.save_manifest(&recovered).await?;
                self.clear_journal().await?;
                Ok(recovered)
            }
            None => Ok(manifest),
        }
    }

    async fn save_manifest(&self, manifest: &SyncManifest) -> StorageResult<()> {
        let bytes = serde_json::to_vec_pretty(manifest)
            .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
        crate::filesystem::atomic_write::write_async(self.manifest_path(), bytes)
            .await
            .map_err(|_| StorageError::new(StorageErrorCode::Io))
    }

    async fn save_journal(&self, journal: &SyncJournal) -> StorageResult<()> {
        let bytes =
            serde_json::to_vec(journal).map_err(|_| StorageError::new(StorageErrorCode::Io))?;
        crate::filesystem::atomic_write::write_async(self.journal_path(), bytes)
            .await
            .map_err(|_| StorageError::new(StorageErrorCode::Io))
    }

    async fn load_journal(&self) -> StorageResult<Option<SyncJournal>> {
        match tokio::fs::read(self.journal_path()).await {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|_| StorageError::invalid_config()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(StorageError::new(StorageErrorCode::Io)),
        }
    }

    async fn clear_journal(&self) -> StorageResult<()> {
        match tokio::fs::remove_file(self.journal_path()).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(StorageError::new(StorageErrorCode::Io)),
        }
    }

    async fn recover_journal(
        &self,
        manifest: &mut SyncManifest,
        journal: &SyncJournal,
    ) -> StorageResult<()> {
        // The checkpoint implementation derives a base from the current
        // bytes and version.  It intentionally rejects a mismatched result;
        // a possibly incomplete mutation must remain visible as a conflict
        // rather than being made to look synchronized after a restart.
        let recovery = match &journal.action {
            SyncAction::DeleteRemote { path, .. } | SyncAction::DeleteLocal { path, .. } => {
                if self.local_hash(path).await?.is_none()
                    && self.remote_entry(path).await?.is_none()
                {
                    manifest.files.remove(path);
                    Ok(())
                } else {
                    Err(StorageError::new(StorageErrorCode::Conflict))
                }
            }
            _ => self.checkpoint_action(manifest, &journal.action).await,
        };
        match recovery {
            Ok(()) => Ok(()),
            Err(error) if error.code == StorageErrorCode::Conflict => Ok(()),
            Err(error) => Err(error),
        }
    }
}

#[derive(Default)]
struct LocalTree {
    files: BTreeMap<RemotePath, String>,
    dirs: BTreeSet<RemotePath>,
}
struct RemoteTree {
    files: BTreeMap<RemotePath, RemoteEntry>,
    dirs: BTreeSet<RemotePath>,
}

fn scan_local_tree(root: &Path) -> StorageResult<LocalTree> {
    let mut tree = LocalTree::default();
    // `filter_entry` prevents descent into a Windows junction/reparse point;
    // simply skipping it after it is yielded would be too late.
    let walker = WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| !is_link_or_reparse(entry.path(), entry.file_type()));
    for item in walker {
        let item = item.map_err(|_| StorageError::new(StorageErrorCode::Io))?;
        let path = item.path();
        if path == root {
            continue;
        }
        let file_type = item.file_type();
        if is_link_or_reparse(path, file_type) {
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| StorageError::invalid_path())?;
        if relative.as_os_str() == MANIFEST_FILE {
            continue;
        }
        let text = relative.to_str().ok_or_else(StorageError::invalid_path)?;
        let remote = RemotePath::new(text)?;
        if file_type.is_dir() {
            tree.dirs.insert(remote);
        } else if file_type.is_file() {
            let metadata = item
                .metadata()
                .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
            if metadata.len() > MAX_FILE_BYTES {
                return Err(StorageError::new(StorageErrorCode::InvalidConfig));
            }
            let bytes = std::fs::read(path).map_err(|_| StorageError::new(StorageErrorCode::Io))?;
            tree.files.insert(remote, hash_bytes(&bytes));
        }
    }
    Ok(tree)
}

fn build_plan(manifest: &SyncManifest, local: &LocalTree, remote: &RemoteTree) -> SyncPlan {
    let mut plan = SyncPlan::default();
    // Create parents first, shallow to deep. Directory mutations are not
    // synthesized from remote deletion, avoiding accidental broad deletes.
    let mut missing_dirs: Vec<_> = local.dirs.difference(&remote.dirs).cloned().collect();
    missing_dirs.sort_by_key(|path| path.segments().count());
    plan.actions.extend(
        missing_dirs
            .into_iter()
            .map(|path| SyncAction::CreateRemoteDir { path }),
    );

    let paths: BTreeSet<_> = manifest
        .files
        .keys()
        .chain(local.files.keys())
        .chain(remote.files.keys())
        .cloned()
        .collect();
    for path in paths {
        let base = manifest.files.get(&path);
        let local_hash = local.files.get(&path);
        let remote_entry = remote.files.get(&path);
        match (base, local_hash, remote_entry) {
            (None, Some(hash), None) => plan.actions.push(SyncAction::Upload {
                path,
                expected_local_hash: hash.clone(),
                precondition: WritePrecondition::Missing,
            }),
            (None, None, Some(entry)) => plan.actions.push(SyncAction::Download {
                path,
                expected_remote_version: entry.version.clone(),
                expected_local_hash: None,
            }),
            (None, Some(_), Some(_)) => plan.conflicts.push(SyncConflict {
                path,
                reason: SyncConflictReason::BothCreated,
            }),
            (Some(base), Some(hash), Some(entry)) => {
                let local_changed = hash != &base.local_hash;
                let remote_changed = !remote_matches_base(entry, base);
                match (local_changed, remote_changed) {
                    (false, false) => {}
                    (true, false) => plan.actions.push(SyncAction::Upload {
                        path,
                        expected_local_hash: hash.clone(),
                        precondition: WritePrecondition::Match(base.remote_version.clone()),
                    }),
                    (false, true) => plan.actions.push(SyncAction::Download {
                        path,
                        expected_remote_version: entry.version.clone(),
                        expected_local_hash: Some(hash.clone()),
                    }),
                    (true, true) => plan.conflicts.push(SyncConflict {
                        path,
                        reason: SyncConflictReason::BothChanged,
                    }),
                }
            }
            (Some(base), Some(hash), None) => {
                if hash == &base.local_hash {
                    plan.actions.push(SyncAction::DeleteLocal {
                        path,
                        expected_local_hash: hash.clone(),
                    });
                } else {
                    plan.conflicts.push(SyncConflict {
                        path,
                        reason: SyncConflictReason::LocalChangedRemoteDeleted,
                    });
                }
            }
            (Some(base), None, Some(entry)) => {
                if remote_matches_base(entry, base) {
                    plan.actions.push(SyncAction::DeleteRemote {
                        path,
                        expected_remote_version: base.remote_version.clone(),
                    });
                } else {
                    plan.conflicts.push(SyncConflict {
                        path,
                        reason: SyncConflictReason::LocalDeletedRemoteChanged,
                    });
                }
            }
            (Some(_), None, None) => {}
            // No base plus no resources cannot happen due to the union, but
            // retaining a conservative default makes future variants safe.
            (None, None, None) => {}
        }
    }
    plan
}

fn remote_matches_base(entry: &RemoteEntry, base: &SyncedFile) -> bool {
    entry.version.as_ref() == Some(&base.remote_version)
        && optional_remote_value_matches(entry.remote_id.as_ref(), base.remote_id.as_ref())
        && optional_remote_value_matches(
            entry.content_hash.as_ref(),
            base.remote_content_hash.as_ref(),
        )
}

/// Once a provider has supplied an ABA guard, losing it is not benign.  Treat
/// an absent value from a later response as a remote change instead of silently
/// falling back to version-only behavior.
fn optional_remote_value_matches<T: Eq>(current: Option<&T>, base: Option<&T>) -> bool {
    match base {
        Some(base) => current == Some(base),
        None => true,
    }
}

fn action_updates_manifest(action: &SyncAction) -> bool {
    !matches!(action, SyncAction::CreateRemoteDir { .. })
}

fn action_mutates_remote(action: &SyncAction) -> bool {
    matches!(
        action,
        SyncAction::CreateRemoteDir { .. }
            | SyncAction::Upload { .. }
            | SyncAction::DeleteRemote { .. }
    )
}

fn parent_path(path: &RemotePath) -> StorageResult<RemotePath> {
    let mut segments = path.segments().collect::<Vec<_>>();
    if segments.pop().is_none() {
        return Err(StorageError::invalid_path());
    }
    RemotePath::new(segments.join("/"))
}

fn action_path(action: &SyncAction) -> &RemotePath {
    match action {
        SyncAction::CreateRemoteDir { path }
        | SyncAction::Upload { path, .. }
        | SyncAction::Download { path, .. }
        | SyncAction::DeleteRemote { path, .. }
        | SyncAction::DeleteLocal { path, .. } => path,
    }
}

fn is_child_of(parent: &RemotePath, candidate: &RemotePath) -> bool {
    if parent.is_root() {
        return !candidate.is_root();
    }
    candidate
        .as_str()
        .strip_prefix(parent.as_str())
        .is_some_and(|suffix| suffix.starts_with('/'))
}

fn is_internal_path(path: &RemotePath) -> bool {
    path.as_str() == MANIFEST_FILE
}

fn is_link_or_reparse(path: &Path, file_type: std::fs::FileType) -> bool {
    if file_type.is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        return std::fs::symlink_metadata(path)
            .map(|metadata| metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
            .unwrap_or(true);
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

fn hash_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::sync::Mutex;

    #[derive(Clone)]
    struct FakeRemoteFile {
        entry: RemoteEntry,
        bytes: Vec<u8>,
    }

    struct FakeProvider {
        conditional_write: bool,
        files: Mutex<BTreeMap<RemotePath, FakeRemoteFile>>,
        conflict_on_write: Mutex<Option<RemotePath>>,
        fail_next_read: Mutex<bool>,
        writes: Mutex<usize>,
        revision: Mutex<u64>,
    }

    impl FakeProvider {
        fn new(conditional_write: bool) -> Self {
            Self {
                conditional_write,
                files: Mutex::new(BTreeMap::new()),
                conflict_on_write: Mutex::new(None),
                fail_next_read: Mutex::new(false),
                writes: Mutex::new(0),
                revision: Mutex::new(0),
            }
        }

        fn set_conflict_on_write(&self, path: &str) {
            *self.conflict_on_write.lock().unwrap() = Some(RemotePath::new(path).unwrap());
        }

        fn fail_next_read(&self) {
            *self.fail_next_read.lock().unwrap() = true;
        }
    }

    #[async_trait]
    impl StorageProvider for FakeProvider {
        fn kind(&self) -> super::super::ProviderKind {
            super::super::ProviderKind::SelfHosted
        }

        async fn probe(&self) -> StorageResult<super::super::ProviderCapabilities> {
            Ok(super::super::ProviderCapabilities {
                conditional_write: self.conditional_write,
                ..Default::default()
            })
        }

        async fn list(&self, path: &RemotePath) -> StorageResult<Vec<RemoteEntry>> {
            Ok(self
                .files
                .lock()
                .unwrap()
                .values()
                .filter(|file| {
                    is_child_of(path, &file.entry.path)
                        && file.entry.path.segments().count() == path.segments().count() + 1
                })
                .map(|file| file.entry.clone())
                .collect())
        }

        async fn read(&self, path: &RemotePath) -> StorageResult<super::super::RemoteContent> {
            let mut fail = self.fail_next_read.lock().unwrap();
            if *fail {
                *fail = false;
                return Err(StorageError::new(StorageErrorCode::Unavailable));
            }
            drop(fail);
            let file = self
                .files
                .lock()
                .unwrap()
                .get(path)
                .cloned()
                .ok_or_else(|| StorageError::new(StorageErrorCode::NotFound))?;
            Ok(super::super::RemoteContent {
                bytes: file.bytes,
                version: file.entry.version,
            })
        }

        async fn write(&self, request: ConditionalWrite) -> StorageResult<RemoteVersion> {
            if self.conflict_on_write.lock().unwrap().as_ref() == Some(&request.path) {
                return Err(StorageError::new(StorageErrorCode::Conflict));
            }
            let mut files = self.files.lock().unwrap();
            match &request.precondition {
                WritePrecondition::Missing if !files.contains_key(&request.path) => {}
                WritePrecondition::Match(expected)
                    if files
                        .get(&request.path)
                        .and_then(|file| file.entry.version.as_ref())
                        == Some(expected) => {}
                _ => return Err(StorageError::new(StorageErrorCode::Conflict)),
            }
            let mut revision = self.revision.lock().unwrap();
            *revision += 1;
            let version = RemoteVersion::new(format!("v{revision}"))?;
            let entry = RemoteEntry {
                path: request.path.clone(),
                kind: RemoteEntryKind::File,
                version: Some(version.clone()),
                remote_id: Some(RemoteIdentity::new(format!(
                    "id-{}",
                    request.path.as_str()
                ))?),
                content_hash: Some(RemoteContentHash::new(hash_bytes(&request.bytes))?),
                size: Some(request.bytes.len() as u64),
            };
            files.insert(
                request.path,
                FakeRemoteFile {
                    entry,
                    bytes: request.bytes,
                },
            );
            *self.writes.lock().unwrap() += 1;
            Ok(version)
        }

        async fn create_dir(&self, _path: &RemotePath) -> StorageResult<RemoteVersion> {
            Ok(RemoteVersion::new("created")?)
        }

        async fn move_entry(
            &self,
            _request: super::super::ConditionalMove,
        ) -> StorageResult<RemoteVersion> {
            Err(StorageError::unsupported())
        }

        async fn delete(&self, request: ConditionalDelete) -> StorageResult<()> {
            self.files.lock().unwrap().remove(&request.path);
            Ok(())
        }
    }

    fn file(path: &str, version: &str) -> RemoteEntry {
        RemoteEntry {
            path: RemotePath::new(path).unwrap(),
            kind: RemoteEntryKind::File,
            version: Some(RemoteVersion::new(version).unwrap()),
            remote_id: None,
            content_hash: None,
            size: None,
        }
    }

    #[test]
    fn concurrent_edit_is_always_a_conflict() {
        let path = RemotePath::new("note.md").unwrap();
        let mut manifest = SyncManifest {
            schema_version: 1,
            files: BTreeMap::new(),
        };
        manifest.files.insert(
            path.clone(),
            SyncedFile {
                local_hash: hash_bytes(b"old"),
                remote_version: RemoteVersion::new("v1").unwrap(),
                remote_id: None,
                remote_content_hash: None,
            },
        );
        let local = LocalTree {
            files: BTreeMap::from([(path.clone(), hash_bytes(b"local"))]),
            dirs: BTreeSet::new(),
        };
        let remote = RemoteTree {
            files: BTreeMap::from([(path.clone(), file("note.md", "v2"))]),
            dirs: BTreeSet::new(),
        };
        let plan = build_plan(&manifest, &local, &remote);
        assert!(plan.actions.is_empty());
        assert_eq!(plan.conflicts[0].reason, SyncConflictReason::BothChanged);
    }

    #[test]
    fn remote_only_file_is_downloaded_without_overwriting_local() {
        let path = RemotePath::new("remote.md").unwrap();
        let plan = build_plan(
            &SyncManifest {
                schema_version: 1,
                files: BTreeMap::new(),
            },
            &LocalTree::default(),
            &RemoteTree {
                files: BTreeMap::from([(path, file("remote.md", "v1"))]),
                dirs: BTreeSet::new(),
            },
        );
        assert!(matches!(
            plan.actions.as_slice(),
            [SyncAction::Download {
                expected_local_hash: None,
                ..
            }]
        ));
    }

    #[test]
    fn path_children_are_not_prefix_confused() {
        assert!(is_child_of(
            &RemotePath::new("a").unwrap(),
            &RemotePath::new("a/x").unwrap()
        ));
        assert!(!is_child_of(
            &RemotePath::new("a").unwrap(),
            &RemotePath::new("ab/x").unwrap()
        ));
    }

    #[test]
    fn stable_identity_prevents_delete_recreate_aba_from_looking_unchanged() {
        let path = RemotePath::new("note.md").unwrap();
        let base = SyncedFile {
            local_hash: hash_bytes(b"base"),
            remote_version: RemoteVersion::new("v1").unwrap(),
            remote_id: Some(RemoteIdentity::new("old-entry").unwrap()),
            remote_content_hash: Some(RemoteContentHash::new(hash_bytes(b"base")).unwrap()),
        };
        let manifest = SyncManifest {
            schema_version: MANIFEST_VERSION,
            files: BTreeMap::from([(path.clone(), base)]),
        };
        // A broken/reused version value alone would make this look unchanged,
        // but the new stable resource id exposes a delete-and-recreate race.
        let replacement = RemoteEntry {
            path: path.clone(),
            kind: RemoteEntryKind::File,
            version: Some(RemoteVersion::new("v1").unwrap()),
            remote_id: Some(RemoteIdentity::new("new-entry").unwrap()),
            content_hash: Some(RemoteContentHash::new(hash_bytes(b"remote")).unwrap()),
            size: Some(6),
        };
        let local = LocalTree {
            files: BTreeMap::from([(path.clone(), hash_bytes(b"local"))]),
            dirs: BTreeSet::new(),
        };
        let remote = RemoteTree {
            files: BTreeMap::from([(path.clone(), replacement)]),
            dirs: BTreeSet::new(),
        };

        let plan = build_plan(&manifest, &local, &remote);
        assert!(plan.actions.is_empty());
        assert_eq!(plan.conflicts[0].reason, SyncConflictReason::BothChanged);
    }

    #[tokio::test]
    async fn records_each_successful_path_when_a_later_path_conflicts() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("a.md"), b"a").unwrap();
        std::fs::write(directory.path().join("b.md"), b"b").unwrap();
        let provider = FakeProvider::new(true);
        provider.set_conflict_on_write("b.md");
        let sync = OneShotSync::new(&provider, directory.path()).unwrap();

        let outcome = sync.apply(sync.plan().await.unwrap()).await.unwrap();

        assert_eq!(outcome.applied.len(), 1);
        assert_eq!(outcome.conflicts.len(), 1);
        let manifest = sync.load_manifest().await.unwrap();
        assert!(manifest
            .files
            .contains_key(&RemotePath::new("a.md").unwrap()));
        assert!(!manifest
            .files
            .contains_key(&RemotePath::new("b.md").unwrap()));
        assert!(!sync.journal_path().exists());
    }

    #[tokio::test]
    async fn recovers_a_remote_write_checkpoint_after_an_interrupted_run() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("note.md"), b"note").unwrap();
        let provider = FakeProvider::new(true);
        provider.fail_next_read();
        let sync = OneShotSync::new(&provider, directory.path()).unwrap();

        assert_eq!(
            sync.apply(sync.plan().await.unwrap())
                .await
                .unwrap_err()
                .code,
            StorageErrorCode::Unavailable
        );
        assert!(sync.journal_path().exists());

        // Simulates process restart: loading state consumes the durable intent
        // and only advances the base after verifying bytes and the remote CAS
        // version again.
        let restarted = OneShotSync::new(&provider, directory.path()).unwrap();
        let manifest = restarted.load_manifest().await.unwrap();
        assert!(manifest
            .files
            .contains_key(&RemotePath::new("note.md").unwrap()));
        assert!(!restarted.journal_path().exists());
    }

    #[tokio::test]
    async fn unsafe_provider_never_receives_a_remote_mutation() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("note.md"), b"note").unwrap();
        let provider = FakeProvider::new(false);
        let sync = OneShotSync::new(&provider, directory.path()).unwrap();

        assert_eq!(
            sync.apply(sync.plan().await.unwrap())
                .await
                .unwrap_err()
                .code,
            StorageErrorCode::Unsupported
        );
        assert_eq!(*provider.writes.lock().unwrap(), 0);
    }
}
