//! Recoverable reference rewrites, using the same renderer index/plan as backlinks.
use super::{
    notes::{fingerprint, is_excluded_note_directory, is_note_markdown, relative_path},
    workspace::{resolve_existing_inside, resolve_open_workspace},
};
use crate::{
    app::AppState,
    error::{AppError, AppResult},
    filesystem::{atomic_write, encoding},
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;
static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
#[derive(Deserialize)]
pub struct Rewrite {
    relative: String,
    expected: String,
    markdown: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RewriteCheck {
    pub relative: String,
    pub expected: String,
}
#[derive(Serialize, Deserialize)]
struct Backup {
    relative: String,
    destination: String,
    before: Vec<u8>,
    after: Vec<u8>,
}
#[derive(Serialize, Deserialize)]
struct Journal {
    root: PathBuf,
    source: String,
    destination: String,
    files: Vec<Backup>,
    #[serde(default)]
    checks: Vec<RewriteCheck>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredFile {
    /// Original project-relative path before the move transaction.
    pub relative: String,
    /// Original Markdown normalized to the editor's internal LF representation.
    pub markdown: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    /// Original project-relative source path before the move transaction.
    pub source: String,
    /// Destination path recorded by the move transaction.
    pub destination: String,
    pub files: Vec<RestoredFile>,
}
fn conflict(message: &str) -> AppError {
    AppError::InvalidArgument(message.into())
}
fn commit_failure_message(
    error: &AppError,
    recovery: &AppResult<RestoreResult>,
    id: &str,
) -> String {
    let recovery_summary = match recovery {
        Ok(_) => "rollback complete".to_owned(),
        Err(error) => format!("rollback failed: {error}"),
    };
    format!("{error}; {recovery_summary}; backup transaction: {id}")
}
fn entry_exists(path: &Path) -> AppResult<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}
fn destination_path(root: &Path, relative: &str) -> AppResult<PathBuf> {
    let relative = relative_path(relative)?;
    let parent = resolve_existing_inside(
        root,
        &root.join(relative.parent().unwrap_or(Path::new(""))),
        true,
    )?;
    Ok(parent.join(
        relative
            .file_name()
            .ok_or_else(|| conflict("missing destination filename"))?,
    ))
}
fn mapped(source: &str, destination: &str, path: &str) -> String {
    if path == source || path.starts_with(&(source.to_owned() + "/")) {
        destination.to_owned() + &path[source.len()..]
    } else {
        path.into()
    }
}
fn validate_index_manifest(root: &Path, checks: &[RewriteCheck]) -> AppResult<()> {
    let mut expected = HashMap::with_capacity(checks.len());
    for check in checks {
        let relative = relative_path(&check.relative)?;
        let normalized = relative.to_string_lossy().replace('\\', "/");
        if normalized != check.relative
            || check.expected.len() != 64
            || !check.expected.bytes().all(|byte| byte.is_ascii_hexdigit())
            || expected
                .insert(normalized, check.expected.as_str())
                .is_some()
        {
            return Err(conflict("invalid Markdown index manifest"));
        }
    }

    let walker = walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            !entry.file_type().is_dir() || !is_excluded_note_directory(entry.file_name())
        });
    let mut total_bytes = 0usize;
    for entry in walker {
        let entry = entry.map_err(|error| AppError::Other(error.to_string()))?;
        if !entry.file_type().is_file() || !is_note_markdown(entry.path()) {
            continue;
        }
        let path = super::workspace::resolve_existing_inside(root, entry.path(), false)?;
        let relative = path
            .strip_prefix(root)
            .map_err(|error| AppError::Other(error.to_string()))?
            .to_string_lossy()
            .replace('\\', "/");
        let expected_hash = expected
            .remove(&relative)
            .ok_or_else(|| conflict("project Markdown files changed; rebuild and retry"))?;
        let mut bytes = Vec::new();
        std::fs::File::open(path)?
            .take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err(conflict("project Markdown file exceeds 4 MiB"));
        }
        total_bytes = total_bytes.saturating_add(bytes.len());
        if total_bytes > 128 * 1024 * 1024 {
            return Err(conflict("project Markdown index exceeds 128 MiB"));
        }
        if fingerprint(&bytes) != expected_hash {
            return Err(conflict(
                "project Markdown files changed; rebuild and retry",
            ));
        }
    }
    if !expected.is_empty() {
        return Err(conflict(
            "project Markdown files changed; rebuild and retry",
        ));
    }
    Ok(())
}
fn preserve_line_endings(text: &str, original: &str) -> String {
    let fallback = if encoding::detect_line_ending(original) == "crlf" {
        "\r\n"
    } else {
        "\n"
    };
    let mut original_endings = Vec::new();
    let mut chars = original.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '\r' if chars.peek() == Some(&'\n') => {
                chars.next();
                original_endings.push("\r\n");
            }
            '\r' => original_endings.push("\r"),
            '\n' => original_endings.push("\n"),
            _ => {}
        }
    }
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut endings = original_endings.into_iter();
    let mut result = String::with_capacity(normalized.len());
    for character in normalized.chars() {
        if character == '\n' {
            result.push_str(endings.next().unwrap_or(fallback));
        } else {
            result.push(character);
        }
    }
    result
}
fn prepare(
    root: &Path,
    source: String,
    destination: String,
    changes: Vec<Rewrite>,
    checks: Vec<RewriteCheck>,
) -> AppResult<Journal> {
    validate_index_manifest(root, &checks)?;
    let source_entry = root.join(relative_path(&source)?);
    if std::fs::symlink_metadata(&source_entry)?
        .file_type()
        .is_symlink()
    {
        return Err(conflict(
            "symbolic links cannot be moved with reference updates",
        ));
    }
    let source_path = resolve_existing_inside(root, &source_entry, false)?;
    let destination_path = destination_path(root, &destination)?;
    if entry_exists(&destination_path)? || destination_path.starts_with(&source_path) {
        return Err(conflict("destination exists or is inside source"));
    }
    let mut files = Vec::new();
    let mut total = 0usize;
    let mut seen = std::collections::HashSet::new();
    for change in changes {
        if !seen.insert(change.relative.clone()) {
            return Err(conflict("duplicate rewrite path"));
        }
        let path =
            resolve_existing_inside(root, &root.join(relative_path(&change.relative)?), false)?;
        let mut before = Vec::new();
        std::fs::File::open(&path)?
            .take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut before)?;
        if before.len() > 4 * 1024 * 1024 || change.markdown.len() > 4 * 1024 * 1024 {
            return Err(conflict("reference note exceeds 4 MiB"));
        }
        total += before.len() + change.markdown.len();
        if total > 64 * 1024 * 1024 {
            return Err(conflict("reference transaction exceeds 64 MiB"));
        }
        if fingerprint(&before) != change.expected {
            return Err(conflict(
                "a referenced file changed externally; rebuild and retry",
            ));
        }
        let (original, label, errors) = encoding::detect_and_decode(&before)?;
        if errors {
            return Err(conflict("cannot safely decode a referenced file"));
        }
        let text = preserve_line_endings(&change.markdown, &original);
        let mut after = encoding::encode(&text, label)?;
        if encoding::detect_bom(&before).is_some() {
            if let Some(bom) = encoding::bom_for_label(label) {
                let mut bytes = bom.bytes().to_vec();
                bytes.append(&mut after);
                after = bytes;
            }
        }
        files.push(Backup {
            destination: mapped(&source, &destination, &change.relative),
            relative: change.relative,
            before,
            after,
        });
    }
    Ok(Journal {
        root: root.into(),
        source,
        destination,
        files,
        checks,
    })
}
fn restore(
    root: &Path,
    journal: &Journal,
    rollback_after_failed_commit: bool,
) -> AppResult<RestoreResult> {
    if journal.root != root {
        return Err(conflict("transaction belongs to another project"));
    }
    let source = root.join(relative_path(&journal.source)?);
    let destination = root.join(relative_path(&journal.destination)?);
    let source_exists = entry_exists(&source)?;
    let destination_exists = entry_exists(&destination)?;
    let was_moved = !source_exists && destination_exists;
    // A failed commit can have already rewritten references when an external
    // file appears at the destination. In that case the source still exists,
    // so roll back the reference bytes at their original paths without ever
    // touching the unrelated destination.
    let failed_commit_kept_source =
        rollback_after_failed_commit && source_exists && destination_exists;
    if !was_moved && !(source_exists && !destination_exists) && !failed_commit_kept_source {
        return Err(conflict("move paths changed; manual recovery is required"));
    }
    // Prepare the renderer synchronization payload before mutating disk. A bad
    // or legacy journal must fail before any part of the restore is applied.
    let files = journal
        .files
        .iter()
        .map(|file| {
            let (markdown, _, had_decode_errors) = encoding::detect_and_decode(&file.before)?;
            if had_decode_errors {
                return Err(conflict("cannot safely decode a transaction backup"));
            }
            Ok(RestoredFile {
                relative: file.relative.clone(),
                markdown: markdown.replace("\r\n", "\n").replace('\r', "\n"),
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    // Preflight every file before restoring anything. Never overwrite newer work.
    for file in &journal.files {
        let path = resolve_existing_inside(
            root,
            &root.join(relative_path(if was_moved {
                &file.destination
            } else {
                &file.relative
            })?),
            false,
        )?;
        let bytes = std::fs::read(path)?;
        if bytes != file.before && bytes != file.after {
            return Err(conflict(
                "a transaction file changed; manual recovery is required",
            ));
        }
    }
    if was_moved {
        if std::fs::symlink_metadata(&destination)?
            .file_type()
            .is_symlink()
        {
            return Err(conflict("transaction destination became a symbolic link"));
        }
        resolve_existing_inside(root, &destination, false)?;
        let target = destination_path(root, &journal.source)?;
        if entry_exists(&target)? {
            return Err(conflict("transaction source path is occupied"));
        }
        std::fs::rename(&destination, target)?;
    }
    for file in &journal.files {
        let path =
            resolve_existing_inside(root, &root.join(relative_path(&file.relative)?), false)?;
        let current = std::fs::read(&path)?;
        if current != file.before && current != file.after {
            return Err(conflict(
                "file changed during recovery; original bytes remain in the journal",
            ));
        }
        atomic_write::write(&path, &file.before)?;
    }
    Ok(RestoreResult {
        source: journal.source.clone(),
        destination: journal.destination.clone(),
        files,
    })
}
fn commit(root: &Path, journal: &Journal) -> AppResult<()> {
    commit_with_hook(root, journal, || Ok(()))
}
fn commit_with_hook(
    root: &Path,
    journal: &Journal,
    before_move: impl FnOnce() -> AppResult<()>,
) -> AppResult<()> {
    validate_index_manifest(root, &journal.checks)?;
    for file in &journal.files {
        let path =
            resolve_existing_inside(root, &root.join(relative_path(&file.relative)?), false)?;
        if std::fs::read(&path)? != file.before {
            return Err(conflict("file changed during reference update"));
        }
        atomic_write::write(&path, &file.after)?;
    }
    let after_checks: Vec<RewriteCheck> = journal
        .checks
        .iter()
        .map(|check| {
            let expected = journal
                .files
                .iter()
                .find(|file| file.relative == check.relative)
                .map(|file| fingerprint(&file.after))
                .unwrap_or_else(|| check.expected.clone());
            RewriteCheck {
                relative: check.relative.clone(),
                expected,
            }
        })
        .collect();
    validate_index_manifest(root, &after_checks)?;
    before_move()?;
    let source_entry = root.join(relative_path(&journal.source)?);
    if std::fs::symlink_metadata(&source_entry)?
        .file_type()
        .is_symlink()
    {
        return Err(conflict("transaction source became a symbolic link"));
    }
    let source = resolve_existing_inside(root, &source_entry, false)?;
    let destination = destination_path(root, &journal.destination)?;
    if entry_exists(&destination)? {
        return Err(conflict("destination was created during reference update"));
    }
    std::fs::rename(source, destination)?;
    Ok(())
}
#[tauri::command]
pub async fn cmd_notes_move(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    root: PathBuf,
    source: String,
    destination: String,
    changes: Vec<Rewrite>,
    checks: Vec<RewriteCheck>,
) -> AppResult<String> {
    let root = resolve_open_workspace(&state, &root)?;
    let journal_dir = app
        .path()
        .app_local_data_dir()?
        .join("reference-transactions");
    tokio::task::spawn_blocking(move || {
        let _guard = LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|e| AppError::Other(e.to_string()))?;
        let journal = prepare(&root, source, destination, changes, checks)?;
        let id = uuid::Uuid::new_v4().to_string();
        std::fs::create_dir_all(&journal_dir)?;
        atomic_write::write(
            &journal_dir.join(format!("{id}.json")),
            &serde_json::to_vec(&journal)?,
        )?;
        if let Err(error) = commit(&root, &journal) {
            let recovery = restore(&root, &journal, true);
            return Err(AppError::Other(commit_failure_message(
                &error, &recovery, &id,
            )));
        }
        Ok(id)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}
#[tauri::command]
pub async fn cmd_notes_restore_transaction(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    root: PathBuf,
    id: String,
) -> AppResult<RestoreResult> {
    let root = resolve_open_workspace(&state, &root)?;
    uuid::Uuid::parse_str(&id).map_err(|e| conflict(&e.to_string()))?;
    let path = app
        .path()
        .app_local_data_dir()?
        .join("reference-transactions")
        .join(format!("{id}.json"));
    tokio::task::spawn_blocking(move || {
        let _guard = LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|e| AppError::Other(e.to_string()))?;
        let journal: Journal = serde_json::from_slice(&std::fs::read(path)?)?;
        restore(&root, &journal, false)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}
#[cfg(test)]
mod tests {
    use super::*;
    fn checked_files(root: &Path, relative_paths: &[&str]) -> Vec<RewriteCheck> {
        relative_paths
            .iter()
            .map(|relative| RewriteCheck {
                relative: (*relative).into(),
                expected: fingerprint(&std::fs::read(root.join(relative)).unwrap()),
            })
            .collect()
    }
    #[test]
    fn rewrite_preserves_crlf_bom_and_can_restore_original_bytes() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let bytes = b"\xef\xbb\xbf[old](old.md)\r\n";
        std::fs::write(root.join("old.md"), "target").unwrap();
        std::fs::write(root.join("ref.md"), bytes).unwrap();
        let journal = prepare(
            &root,
            "old.md".into(),
            "new.md".into(),
            vec![Rewrite {
                relative: "ref.md".into(),
                expected: fingerprint(bytes),
                markdown: "[old](new.md)\n".into(),
            }],
            checked_files(&root, &["old.md", "ref.md"]),
        )
        .unwrap();
        commit(&root, &journal).unwrap();
        assert_eq!(
            std::fs::read(root.join("ref.md")).unwrap(),
            b"\xef\xbb\xbf[old](new.md)\r\n"
        );
        let restored = restore(&root, &journal, false).unwrap();
        assert_eq!(restored.source, "old.md");
        assert_eq!(restored.destination, "new.md");
        assert_eq!(restored.files.len(), 1);
        assert_eq!(restored.files[0].relative, "ref.md");
        assert_eq!(restored.files[0].markdown, "[old](old.md)\n");
        assert_eq!(std::fs::read(root.join("ref.md")).unwrap(), bytes);
        assert!(root.join("old.md").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rewrite_preserves_mixed_line_endings() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let bytes = b"[old](old.md)\r\nline two\nline three\r";
        std::fs::write(root.join("old.md"), "source note").unwrap();
        std::fs::write(root.join("ref.md"), bytes).unwrap();
        let journal = prepare(
            &root,
            "old.md".into(),
            "new.md".into(),
            vec![Rewrite {
                relative: "ref.md".into(),
                expected: fingerprint(bytes),
                markdown: "[old](new.md)\nline two\nline three\n".into(),
            }],
            checked_files(&root, &["old.md", "ref.md"]),
        )
        .unwrap();
        commit(&root, &journal).unwrap();
        assert_eq!(
            std::fs::read(root.join("ref.md")).unwrap(),
            b"[old](new.md)\r\nline two\nline three\r"
        );
        restore(&root, &journal, false).unwrap();
        assert_eq!(std::fs::read(root.join("ref.md")).unwrap(), bytes);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn stale_reference_and_recovery_conflict_do_not_overwrite() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        std::fs::write(root.join("a.md"), "original").unwrap();
        assert!(prepare(
            &root,
            "a.md".into(),
            "b.md".into(),
            vec![Rewrite {
                relative: "a.md".into(),
                expected: "stale".into(),
                markdown: "new".into()
            }],
            checked_files(&root, &["a.md"]),
        )
        .is_err());
        let journal = prepare(
            &root,
            "a.md".into(),
            "b.md".into(),
            vec![Rewrite {
                relative: "a.md".into(),
                expected: fingerprint(b"original"),
                markdown: "new".into(),
            }],
            checked_files(&root, &["a.md"]),
        )
        .unwrap();
        commit(&root, &journal).unwrap();
        std::fs::write(root.join("b.md"), "external edit").unwrap();
        assert!(restore(&root, &journal, false).is_err());
        assert_eq!(std::fs::read(root.join("b.md")).unwrap(), b"external edit");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_commit_rolls_back_references_when_destination_appears() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let before = b"[old](old.md)\r\n";
        std::fs::write(root.join("old.md"), "source note").unwrap();
        std::fs::write(root.join("ref.md"), before).unwrap();
        let journal = prepare(
            &root,
            "old.md".into(),
            "new.md".into(),
            vec![Rewrite {
                relative: "ref.md".into(),
                expected: fingerprint(before),
                markdown: "[old](new.md)\n".into(),
            }],
            checked_files(&root, &["old.md", "ref.md"]),
        )
        .unwrap();

        // Simulate another process creating the destination between the final
        // index check and the move. Reference writes must still be rolled back.
        assert!(commit_with_hook(&root, &journal, || {
            std::fs::write(root.join("new.md"), "unrelated external file")?;
            Ok(())
        })
        .is_err());
        assert_eq!(
            std::fs::read(root.join("ref.md")).unwrap(),
            b"[old](new.md)\r\n"
        );

        // The failed-move rollback restores the reference without moving or
        // overwriting the file created by the other process.
        restore(&root, &journal, true).unwrap();
        assert_eq!(std::fs::read(root.join("ref.md")).unwrap(), before);
        assert_eq!(
            std::fs::read_to_string(root.join("new.md")).unwrap(),
            "unrelated external file"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("old.md")).unwrap(),
            "source note"
        );
        assert!(restore(&root, &journal, false).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn changes_to_unrewritten_markdown_abort_before_reference_writes() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let before = b"[old](old.md)\n";
        std::fs::write(root.join("old.md"), "source note").unwrap();
        std::fs::write(root.join("ref.md"), before).unwrap();
        std::fs::write(root.join("unrewritten.md"), "indexed baseline").unwrap();
        let journal = prepare(
            &root,
            "old.md".into(),
            "new.md".into(),
            vec![Rewrite {
                relative: "ref.md".into(),
                expected: fingerprint(before),
                markdown: "[old](new.md)\n".into(),
            }],
            checked_files(&root, &["old.md", "ref.md", "unrewritten.md"]),
        )
        .unwrap();
        std::fs::write(root.join("unrewritten.md"), "external edit").unwrap();
        assert!(commit(&root, &journal).is_err());
        assert_eq!(std::fs::read(root.join("ref.md")).unwrap(), before);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn added_or_deleted_markdown_aborts_before_reference_writes() {
        for add_note in [true, false] {
            let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
            std::fs::create_dir_all(&root).unwrap();
            let root = std::fs::canonicalize(root).unwrap();
            let before = b"[old](old.md)\n";
            std::fs::write(root.join("old.md"), "source note").unwrap();
            std::fs::write(root.join("ref.md"), before).unwrap();
            std::fs::write(root.join("other.md"), "indexed baseline").unwrap();
            let journal = prepare(
                &root,
                "old.md".into(),
                "new.md".into(),
                vec![Rewrite {
                    relative: "ref.md".into(),
                    expected: fingerprint(before),
                    markdown: "[old](new.md)\n".into(),
                }],
                checked_files(&root, &["old.md", "ref.md", "other.md"]),
            )
            .unwrap();
            if add_note {
                std::fs::write(root.join("added.md"), "new note").unwrap();
            } else {
                std::fs::remove_file(root.join("other.md")).unwrap();
            }
            assert!(commit(&root, &journal).is_err());
            assert_eq!(std::fs::read(root.join("ref.md")).unwrap(), before);
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn failed_move_error_never_formats_restored_markdown() {
        let payload = "private reference body";
        let recovery = Ok(RestoreResult {
            source: "old.md".into(),
            destination: "new.md".into(),
            files: vec![RestoredFile {
                relative: "ref.md".into(),
                markdown: payload.into(),
            }],
        });
        let message =
            commit_failure_message(&conflict("destination was created"), &recovery, "tx-1");
        assert!(message.contains("rollback complete"));
        assert!(message.contains("backup transaction: tx-1"));
        assert!(!message.contains(payload));
    }
}
