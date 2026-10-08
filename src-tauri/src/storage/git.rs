//! Git-backed cloud storage primitives.
//!
//! This module deliberately shells out only to the installed `git` executable
//! with a fixed argument vector. It never invokes a shell, never force-pushes,
//! and never resets a worktree. The command layer is expected to expose these
//! operations only after explicit user intent; in particular, `abort_in_progress`
//! is a user-requested escape hatch, not part of automatic synchronisation.
//!
//! ## Storage-core adapter
//!
//! `storage::mod` should construct a [`GitStorage`] from its persisted
//! connection settings, map [`GitRepositoryState`] to the common connection
//! status, and route provider actions to `fetch`, `pull_fast_forward`, `push`,
//! `merge_remote_for_review`, `conflict_inventory`,
//! `read_conflict_stage_text`, and `abort_in_progress`. Credentials deliberately
//! do not appear in [`GitRepositoryConfig`]: Git Credential Manager/SSH handles
//! them outside normal preferences and logs.

use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use tokio::process::Command;

const GIT: &str = "git";

/// Persistable, non-secret connection settings for one Git workspace.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitRepositoryConfig {
    pub repository_path: PathBuf,
    pub remote: String,
    pub branch: String,
}

/// A validated local Git worktree. Use [`GitStorage::open`] rather than
/// constructing this directly so a path cannot accidentally address a parent
/// directory or a missing remote.
#[derive(Debug, Clone)]
pub struct GitStorage {
    root: PathBuf,
    config: GitRepositoryConfig,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum GitStorageError {
    #[error("git:invalidConfig")]
    InvalidConfig,
    #[error("git:notRepository")]
    NotRepository,
    #[error("git:repositoryRootRequired")]
    RepositoryRootRequired,
    #[error("git:unavailable")]
    Unavailable,
    #[error("git:invalidOutput")]
    InvalidOutput,
    #[error("git:unsafeState")]
    UnsafeState,
    #[error("git:branchMismatch")]
    BranchMismatch,
    #[error("git:noOperation")]
    NoOperation,
    #[error("git:{0}")]
    CommandFailed(&'static str),
}

pub type GitResult<T> = Result<T, GitStorageError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitChangedPath {
    /// The literal two-character porcelain-v1 status code, such as `" M"` or
    /// `"??"`. It is intentionally not interpreted as a sync instruction.
    pub code: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictStage {
    /// Git index stage: 1 common base, 2 current/local, 3 incoming/remote.
    pub stage: u8,
    pub mode: String,
    pub object_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitConflictFile {
    pub path: String,
    pub stages: Vec<GitConflictStage>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum GitOperationInProgress {
    Merge,
    Rebase,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRepositoryState {
    pub root: PathBuf,
    pub configured_remote: String,
    pub configured_branch: String,
    pub current_branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub changes: Vec<GitChangedPath>,
    pub conflicts: Vec<GitConflictFile>,
    pub operation_in_progress: Option<GitOperationInProgress>,
    /// True only when there are no worktree/index changes, no conflicts and
    /// no unfinished merge/rebase. This is the precondition for pull/push.
    pub clean: bool,
}

impl GitStorage {
    /// Validate that the supplied path is the root of a worktree and that the
    /// named remote and branch are usable. This performs no network operation.
    pub async fn open(config: GitRepositoryConfig) -> GitResult<Self> {
        validate_config(&config)?;
        let supplied_root = tokio::fs::canonicalize(&config.repository_path)
            .await
            .map_err(|_| GitStorageError::NotRepository)?;

        let probe = Self {
            root: supplied_root.clone(),
            config,
        };
        let top_level = probe
            .command_text(&["rev-parse", "--show-toplevel"], "validate")
            .await
            .map_err(|error| match error {
                GitStorageError::Unavailable => error,
                _ => GitStorageError::NotRepository,
            })?;
        let git_root = tokio::fs::canonicalize(Path::new(top_level.trim()))
            .await
            .map_err(|_| GitStorageError::NotRepository)?;
        if supplied_root != git_root {
            return Err(GitStorageError::RepositoryRootRequired);
        }

        probe
            .command_text(
                &["remote", "get-url", &probe.config.remote],
                "validateRemote",
            )
            .await
            .map_err(|error| match error {
                GitStorageError::Unavailable => error,
                _ => GitStorageError::InvalidConfig,
            })?;
        probe
            .command_text(
                &["check-ref-format", "--branch", &probe.config.branch],
                "validateBranch",
            )
            .await
            .map_err(|error| match error {
                GitStorageError::Unavailable => error,
                _ => GitStorageError::InvalidConfig,
            })?;
        Ok(probe)
    }

    pub fn config(&self) -> &GitRepositoryConfig {
        &self.config
    }

    /// Return local worktree/index status plus unmerged index stages. This is
    /// safe during an unfinished merge or rebase and powers manual resolution.
    pub async fn status(&self) -> GitResult<GitRepositoryState> {
        let changes = parse_porcelain(
            &self
                .command_bytes(
                    &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
                    "status",
                )
                .await?,
        )?;
        let conflicts = self.conflict_inventory().await?;
        let operation_in_progress = self.operation_in_progress().await?;
        let current_branch = self
            .command_text_optional(&["symbolic-ref", "--quiet", "--short", "HEAD"])
            .await?
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        let upstream = self
            .command_text_optional(&[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ])
            .await?
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        let (ahead, behind) = self.ahead_behind().await?;
        let clean = changes.is_empty() && conflicts.is_empty() && operation_in_progress.is_none();
        Ok(GitRepositoryState {
            root: self.root.clone(),
            configured_remote: self.config.remote.clone(),
            configured_branch: self.config.branch.clone(),
            current_branch,
            upstream,
            ahead,
            behind,
            changes,
            conflicts,
            operation_in_progress,
            clean,
        })
    }

    /// Fetch remote refs without touching the worktree. A failed fetch leaves
    /// the local worktree untouched and returns a stable, secret-free error.
    pub async fn fetch(&self) -> GitResult<GitRepositoryState> {
        self.command_bytes(&["fetch", "--prune", &self.config.remote], "fetch")
            .await?;
        self.status().await
    }

    /// Pull exactly the configured branch, but only if the local worktree is
    /// clean. `--ff-only` prevents Git from creating a merge commit or opening
    /// an interactive conflict; it never uses reset or force options.
    pub async fn pull_fast_forward(&self) -> GitResult<GitRepositoryState> {
        self.require_clean_configured_branch().await?;
        self.command_bytes(
            &[
                "pull",
                "--ff-only",
                &self.config.remote,
                &self.config.branch,
            ],
            "pull",
        )
        .await?;
        self.status().await
    }

    /// Fetch then perform a clean fast-forward pull. No upload occurs here;
    /// callers must invoke [`GitStorage::push`] separately after user intent.
    pub async fn sync_clean_fast_forward(&self) -> GitResult<GitRepositoryState> {
        self.require_clean_configured_branch().await?;
        self.fetch().await?;
        self.pull_fast_forward().await
    }

    /// Start a user-requested, reviewable three-way merge after a separate
    /// successful [`GitStorage::fetch`]. Unlike the normal sync path, this is
    /// allowed to surface conflicts. `--no-commit` leaves every outcome for
    /// the user to inspect; callers can offer manual resolution, an
    /// Agent-reviewed proposal, or [`GitStorage::abort_in_progress`].
    ///
    /// A non-zero merge exit is returned as success *only* when Git reports
    /// unmerged index entries. Other failures are sanitized as `mergeReview`.
    pub async fn merge_remote_for_review(&self) -> GitResult<GitRepositoryState> {
        self.require_clean_configured_branch().await?;
        let remote_ref = format!("refs/remotes/{}/{}", self.config.remote, self.config.branch);
        if self
            .command_text_optional(&["show-ref", "--verify", "--quiet", &remote_ref])
            .await?
            .is_none()
        {
            return Err(GitStorageError::CommandFailed("fetchRequired"));
        }
        let output = self
            .command(&["merge", "--no-commit", "--no-ff", &remote_ref])
            .await?;
        if output.status.success() {
            return self.status().await;
        }
        let state = self.status().await?;
        if !state.conflicts.is_empty() {
            Ok(state)
        } else {
            Err(GitStorageError::CommandFailed("mergeReview"))
        }
    }

    /// Push the configured local branch to the same-named branch on the named
    /// remote. This has no force flag and refuses a dirty, conflicted, detached
    /// or differently checked-out branch.
    pub async fn push(&self) -> GitResult<GitRepositoryState> {
        self.require_clean_configured_branch().await?;
        let destination = format!("refs/heads/{0}:refs/heads/{0}", self.config.branch);
        self.command_bytes(&["push", &self.config.remote, &destination], "push")
            .await?;
        self.status().await
    }

    /// Enumerate all unresolved paths and their base/local/remote object IDs.
    /// The UI can use these IDs to obtain *only the selected file's* three
    /// versions for a manual or Agent-assisted merge; this method reads no file
    /// bodies and never tries to resolve a conflict itself.
    pub async fn conflict_inventory(&self) -> GitResult<Vec<GitConflictFile>> {
        parse_unmerged_index(
            &self
                .command_bytes(&["ls-files", "-u", "-z"], "conflicts")
                .await?,
        )
    }

    /// Read one index stage for one conflict file, for example stage 1 for the
    /// common base. Callers must request this only for a path returned by
    /// [`GitStorage::conflict_inventory`]. The method accepts no glob, ref or
    /// arbitrary revision syntax, so an Agent merge packet stays confined to
    /// the selected file rather than reading a repository-wide snapshot.
    pub async fn read_conflict_stage_text(&self, path: &str, stage: u8) -> GitResult<String> {
        if !(1..=3).contains(&stage) || !valid_repository_relative_path(path) {
            return Err(GitStorageError::InvalidConfig);
        }
        if !self
            .conflict_inventory()
            .await?
            .iter()
            .any(|conflict| conflict.path == path)
        {
            return Err(GitStorageError::InvalidConfig);
        }
        let object = format!(":{stage}:{path}");
        self.command_text(&["show", &object], "conflictStage").await
    }

    /// Abort only an active merge or rebase. The caller must make this an
    /// explicit, confirmed user action. It is never called by synchronisation
    /// and intentionally does not use `reset`.
    pub async fn abort_in_progress(&self) -> GitResult<GitRepositoryState> {
        match self.operation_in_progress().await? {
            Some(GitOperationInProgress::Merge) => {
                self.command_bytes(&["merge", "--abort"], "mergeAbort")
                    .await?;
            }
            Some(GitOperationInProgress::Rebase) => {
                self.command_bytes(&["rebase", "--abort"], "rebaseAbort")
                    .await?;
            }
            None => return Err(GitStorageError::NoOperation),
        }
        self.status().await
    }

    async fn require_clean_configured_branch(&self) -> GitResult<()> {
        let state = self.status().await?;
        if !state.clean {
            return Err(GitStorageError::UnsafeState);
        }
        if state.current_branch.as_deref() != Some(self.config.branch.as_str()) {
            return Err(GitStorageError::BranchMismatch);
        }
        Ok(())
    }

    async fn ahead_behind(&self) -> GitResult<(u32, u32)> {
        let remote_ref = format!("refs/remotes/{}/{}", self.config.remote, self.config.branch);
        let range = format!("{remote_ref}...HEAD");
        let Some(value) = self
            .command_text_optional(&["rev-list", "--left-right", "--count", &range])
            .await?
        else {
            // The remote branch may not have been fetched yet. That is an
            // ordinary pre-fetch state, not a reason to hide local status.
            return Ok((0, 0));
        };
        let mut values = value.split_whitespace();
        let behind = values
            .next()
            .and_then(|number| number.parse::<u32>().ok())
            .ok_or(GitStorageError::InvalidOutput)?;
        let ahead = values
            .next()
            .and_then(|number| number.parse::<u32>().ok())
            .ok_or(GitStorageError::InvalidOutput)?;
        if values.next().is_some() {
            return Err(GitStorageError::InvalidOutput);
        }
        Ok((ahead, behind))
    }

    async fn operation_in_progress(&self) -> GitResult<Option<GitOperationInProgress>> {
        if self
            .command_text_optional(&["rev-parse", "-q", "--verify", "MERGE_HEAD"])
            .await?
            .is_some()
        {
            return Ok(Some(GitOperationInProgress::Merge));
        }
        for name in ["rebase-merge", "rebase-apply"] {
            let path = self
                .command_text(&["rev-parse", "--git-path", name], "operation")
                .await?;
            let path = PathBuf::from(path.trim());
            let path = if path.is_absolute() {
                path
            } else {
                self.root.join(path)
            };
            if tokio::fs::try_exists(path)
                .await
                .map_err(|_| GitStorageError::InvalidOutput)?
            {
                return Ok(Some(GitOperationInProgress::Rebase));
            }
        }
        Ok(None)
    }

    async fn command_text(&self, args: &[&str], operation: &'static str) -> GitResult<String> {
        String::from_utf8(self.command_bytes(args, operation).await?)
            .map_err(|_| GitStorageError::InvalidOutput)
    }

    /// Like [`GitStorage::command_text`], but a non-zero status is represented
    /// as `None` for expected probes (`HEAD` detached, no upstream/ref yet).
    /// Spawn failures still surface as `git:unavailable`.
    async fn command_text_optional(&self, args: &[&str]) -> GitResult<Option<String>> {
        let output = self.command(args).await?;
        if !output.status.success() {
            return Ok(None);
        }
        String::from_utf8(output.stdout)
            .map(Some)
            .map_err(|_| GitStorageError::InvalidOutput)
    }

    async fn command_bytes(&self, args: &[&str], operation: &'static str) -> GitResult<Vec<u8>> {
        let output = self.command(args).await?;
        if output.status.success() {
            Ok(output.stdout)
        } else {
            // stderr often contains a remote URL or provider response. Do not
            // forward it to logs/UI, where an embedded token could leak.
            Err(GitStorageError::CommandFailed(operation))
        }
    }

    async fn command(&self, args: &[&str]) -> GitResult<std::process::Output> {
        Command::new(GIT)
            .arg("-C")
            .arg(&self.root)
            .args(args)
            // Do not let a background sync open a credential prompt. Existing
            // credential helpers and SSH agents can still answer noninteractively.
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .await
            .map_err(|_| GitStorageError::Unavailable)
    }
}

fn validate_config(config: &GitRepositoryConfig) -> GitResult<()> {
    let valid_remote = !config.remote.is_empty()
        && !config.remote.starts_with('-')
        && config
            .remote
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    let valid_branch = !config.branch.is_empty()
        && !config.branch.starts_with('-')
        && !config.branch.bytes().any(|byte| byte.is_ascii_control());
    if config.repository_path.as_os_str().is_empty() || !valid_remote || !valid_branch {
        return Err(GitStorageError::InvalidConfig);
    }
    Ok(())
}

fn valid_repository_relative_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.starts_with(['/', '\\'])
        && path.split(['/', '\\']).all(|segment| {
            !segment.is_empty()
                && !matches!(segment, "." | "..")
                && !segment
                    .chars()
                    .any(|character| character == '\0' || character.is_control())
        })
}

fn parse_porcelain(bytes: &[u8]) -> GitResult<Vec<GitChangedPath>> {
    let mut records = bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    let mut changes = Vec::new();
    while let Some(record) = records.next() {
        if record.len() < 4 || record[2] != b' ' {
            return Err(GitStorageError::InvalidOutput);
        }
        let code = std::str::from_utf8(&record[..2])
            .map_err(|_| GitStorageError::InvalidOutput)?
            .to_owned();
        let path = std::str::from_utf8(&record[3..])
            .map_err(|_| GitStorageError::InvalidOutput)?
            .to_owned();
        let renamed_or_copied =
            matches!(record[0], b'R' | b'C') || matches!(record[1], b'R' | b'C');
        changes.push(GitChangedPath { code, path });
        if renamed_or_copied {
            // With `-z`, porcelain v1 places the source path as the next NUL
            // record without a status prefix. It is metadata for the change,
            // not an independent changed file.
            records.next().ok_or(GitStorageError::InvalidOutput)?;
        }
    }
    Ok(changes)
}

fn parse_unmerged_index(bytes: &[u8]) -> GitResult<Vec<GitConflictFile>> {
    let mut grouped: BTreeMap<String, Vec<GitConflictStage>> = BTreeMap::new();
    for record in bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let Some(tab) = record.iter().position(|byte| *byte == b'\t') else {
            return Err(GitStorageError::InvalidOutput);
        };
        let header =
            std::str::from_utf8(&record[..tab]).map_err(|_| GitStorageError::InvalidOutput)?;
        let path = std::str::from_utf8(&record[tab + 1..])
            .map_err(|_| GitStorageError::InvalidOutput)?
            .to_owned();
        let mut fields = header.split_whitespace();
        let mode = fields.next().ok_or(GitStorageError::InvalidOutput)?;
        let object_id = fields.next().ok_or(GitStorageError::InvalidOutput)?;
        let stage = fields
            .next()
            .and_then(|stage| stage.parse::<u8>().ok())
            .filter(|stage| (1..=3).contains(stage))
            .ok_or(GitStorageError::InvalidOutput)?;
        if fields.next().is_some()
            || !mode.bytes().all(|byte| byte.is_ascii_digit())
            || object_id.is_empty()
            || !object_id.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(GitStorageError::InvalidOutput);
        }
        grouped.entry(path).or_default().push(GitConflictStage {
            stage,
            mode: mode.to_owned(),
            object_id: object_id.to_owned(),
        });
    }
    Ok(grouped
        .into_iter()
        .map(|(path, mut stages)| {
            stages.sort_by_key(|stage| stage.stage);
            GitConflictFile { path, stages }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, process::Command as StdCommand};
    use tempfile::TempDir;

    fn git(dir: &Path, args: &[&str]) {
        let output = StdCommand::new(GIT)
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "git command failed: {args:?}");
    }

    fn git_text(dir: &Path, args: &[&str]) -> String {
        let output = StdCommand::new(GIT)
            .current_dir(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success(), "git command failed: {args:?}");
        String::from_utf8(output.stdout).unwrap()
    }

    fn repository() -> (TempDir, GitRepositoryConfig) {
        let temp = TempDir::new().unwrap();
        git(temp.path(), &["init"]);
        git(
            temp.path(),
            &["config", "user.email", "tests@example.invalid"],
        );
        git(temp.path(), &["config", "user.name", "MarkCaptain test"]);
        fs::write(temp.path().join("note.md"), "first\n").unwrap();
        git(temp.path(), &["add", "note.md"]);
        git(temp.path(), &["commit", "-m", "initial"]);
        git(temp.path(), &["branch", "-M", "main"]);
        git(
            temp.path(),
            &[
                "remote",
                "add",
                "origin",
                "https://example.invalid/repo.git",
            ],
        );
        let config = GitRepositoryConfig {
            repository_path: temp.path().to_path_buf(),
            remote: "origin".into(),
            branch: "main".into(),
        };
        (temp, config)
    }

    #[test]
    fn parses_status_and_unmerged_index_without_path_shelling() {
        let changes = parse_porcelain(b" M note.md\0?? dir/new.md\0").unwrap();
        assert_eq!(changes.len(), 2);
        assert_eq!(changes[0].code, " M");
        assert_eq!(changes[1].path, "dir/new.md");
        let conflicts = parse_unmerged_index(
            b"100644 abcdef 1\tnote.md\0100644 123abc 2\tnote.md\0100644 fedcba 3\tnote.md\0",
        )
        .unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(
            conflicts[0]
                .stages
                .iter()
                .map(|stage| stage.stage)
                .collect::<Vec<_>>(),
            [1, 2, 3]
        );
    }

    #[tokio::test]
    async fn validates_root_and_never_treats_dirty_worktree_as_syncable() {
        let (temp, config) = repository();
        let storage = GitStorage::open(config.clone()).await.unwrap();
        let state = storage.status().await.unwrap();
        assert!(state.clean);
        fs::write(temp.path().join("note.md"), "changed\n").unwrap();
        let state = storage.status().await.unwrap();
        assert!(!state.clean);
        assert_eq!(
            storage.pull_fast_forward().await.unwrap_err(),
            GitStorageError::UnsafeState
        );

        let nested = temp.path().join("nested");
        fs::create_dir(&nested).unwrap();
        let error = GitStorage::open(GitRepositoryConfig {
            repository_path: nested,
            ..config
        })
        .await
        .unwrap_err();
        assert_eq!(error, GitStorageError::RepositoryRootRequired);
    }

    #[tokio::test]
    async fn rejects_unsafe_remote_and_branch_configuration_before_git_runs() {
        let (_, config) = repository();
        for changed in [
            GitRepositoryConfig {
                remote: "--upload-pack=x".into(),
                ..config.clone()
            },
            GitRepositoryConfig {
                branch: "bad\nbranch".into(),
                ..config.clone()
            },
        ] {
            assert_eq!(
                GitStorage::open(changed).await.unwrap_err(),
                GitStorageError::InvalidConfig
            );
        }
    }

    #[tokio::test]
    async fn exposes_review_merge_conflicts_without_auto_resolving_them() {
        let (temp, config) = repository();
        git(temp.path(), &["checkout", "-b", "incoming"]);
        fs::write(temp.path().join("note.md"), "incoming\n").unwrap();
        git(temp.path(), &["add", "note.md"]);
        git(temp.path(), &["commit", "-m", "incoming"]);
        let incoming = git_text(temp.path(), &["rev-parse", "HEAD"]);
        git(temp.path(), &["checkout", "main"]);
        fs::write(temp.path().join("note.md"), "local\n").unwrap();
        git(temp.path(), &["add", "note.md"]);
        git(temp.path(), &["commit", "-m", "local"]);
        // Set a fetched remote-tracking ref without performing network I/O.
        git(
            temp.path(),
            &["update-ref", "refs/remotes/origin/main", incoming.trim()],
        );
        let storage = GitStorage::open(config).await.unwrap();
        let state = storage.merge_remote_for_review().await.unwrap();
        assert_eq!(
            state.operation_in_progress,
            Some(GitOperationInProgress::Merge)
        );
        assert_eq!(state.conflicts.len(), 1);
        assert_eq!(state.conflicts[0].path, "note.md");
        let head = storage
            .read_conflict_stage_text("note.md", 1)
            .await
            .unwrap();
        assert_eq!(head, "first\n");
        for path in ["../note.md", ".git/config", "dir//note.md"] {
            assert_eq!(
                storage.read_conflict_stage_text(path, 1).await.unwrap_err(),
                GitStorageError::InvalidConfig
            );
        }
        let aborted = storage.abort_in_progress().await.unwrap();
        assert!(aborted.clean);
        drop(temp);
    }
}
