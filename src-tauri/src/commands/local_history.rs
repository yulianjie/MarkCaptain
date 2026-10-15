//! Independent device-local snapshots, with content-addressed deduplication.
use crate::{
    error::{AppError, AppResult},
    filesystem::atomic_write,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri::Manager;
static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HistorySettings {
    pub interval_seconds: u64,
    pub retention_days: u64,
    pub max_megabytes: u64,
}
impl Default for HistorySettings {
    fn default() -> Self {
        Self {
            interval_seconds: 60,
            retention_days: 30,
            max_megabytes: 256,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalVersion {
    pub id: String,
    pub path: PathBuf,
    pub timestamp: u64,
    pub markdown: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMetadata {
    pub id: String,
    pub path: PathBuf,
    pub timestamp: u64,
    pub size: usize,
    pub content_id: String,
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn validate_version_id(id: &str) -> AppResult<()> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| AppError::InvalidArgument("invalid history version id".into()))
}
fn validate_metadata_record(path: &Path, version: &VersionMetadata) -> AppResult<()> {
    validate_version_id(&version.id)?;
    if path.file_stem().and_then(|value| value.to_str()) != Some(version.id.as_str()) {
        return Err(AppError::InvalidArgument(
            "history version id does not match its file".into(),
        ));
    }
    if version.content_id.len() != 64
        || !version
            .content_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(AppError::InvalidArgument(
            "invalid history content id".into(),
        ));
    }
    Ok(())
}
fn key(path: &Path) -> String {
    let path = path.to_string_lossy().replace('\\', "/");
    digest(
        if cfg!(windows) {
            path.to_lowercase()
        } else {
            path
        }
        .as_bytes(),
    )
}
fn settings(base: &Path) -> AppResult<HistorySettings> {
    let path = base.join("settings.json");
    if path.exists() {
        let value: HistorySettings = serde_json::from_slice(&std::fs::read(path)?)?;
        if !(5..=86400).contains(&value.interval_seconds)
            || !(1..=3650).contains(&value.retention_days)
            || !(8..=32768).contains(&value.max_megabytes)
        {
            return Err(AppError::InvalidArgument("invalid history settings".into()));
        }
        Ok(value)
    } else {
        Ok(HistorySettings::default())
    }
}
fn metadata(directory: &Path) -> AppResult<Vec<VersionMetadata>> {
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut result: Vec<VersionMetadata> = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let path = entry?.path();
        if path.extension().and_then(|s| s.to_str()) == Some("json") {
            let value: VersionMetadata = serde_json::from_slice(&std::fs::read(&path)?)?;
            validate_metadata_record(&path, &value)?;
            result.push(value);
        }
    }
    result.sort_by(|a, b| b.timestamp.cmp(&a.timestamp).then_with(|| b.id.cmp(&a.id)));
    Ok(result)
}
fn read_version(base: &Path, version: VersionMetadata) -> AppResult<LocalVersion> {
    if version.content_id.len() != 64 || !version.content_id.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(AppError::InvalidArgument(
            "invalid history content id".into(),
        ));
    }
    let markdown = std::fs::read_to_string(
        base.join("blobs")
            .join(format!("{}.txt", version.content_id)),
    )?;
    if digest(markdown.as_bytes()) != version.content_id {
        return Err(AppError::Other("history content checksum mismatch".into()));
    }
    Ok(LocalVersion {
        id: version.id,
        path: version.path,
        timestamp: version.timestamp,
        markdown,
    })
}
fn ensure_blob(base: &Path, content_id: &str, markdown: &str) -> AppResult<()> {
    let path = base.join("blobs").join(format!("{content_id}.txt"));
    std::fs::create_dir_all(
        path.parent()
            .ok_or_else(|| AppError::Other("missing blob parent".into()))?,
    )?;
    match std::fs::read(&path) {
        Ok(bytes) if digest(&bytes) == content_id => Ok(()),
        Ok(_) => Ok(atomic_write::write(&path, markdown.as_bytes())?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(atomic_write::write(&path, markdown.as_bytes())?)
        }
        Err(error) => Err(error.into()),
    }
}
#[cfg(test)]
fn versions(directory: &Path) -> AppResult<Vec<LocalVersion>> {
    let base = directory
        .parent()
        .ok_or_else(|| AppError::InvalidArgument("missing history root".into()))?;
    metadata(directory)?
        .into_iter()
        .map(|v| read_version(base, v))
        .collect()
}
fn prune(base: &Path, config: &HistorySettings, protected: &Path) -> AppResult<()> {
    let cutoff = now().saturating_sub(config.retention_days * 86_400_000);
    let mut snapshots = Vec::new();
    let mut references: HashMap<String, usize> = HashMap::new();
    let mut size = 0u64;
    for entry in walkdir::WalkDir::new(base)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| e.file_name() != "blobs")
    {
        let entry = entry.map_err(|e| AppError::Other(e.to_string()))?;
        if !entry.file_type().is_file()
            || entry.file_name() == "settings.json"
            || entry.path().extension().and_then(|value| value.to_str()) != Some("json")
        {
            continue;
        }
        let version: VersionMetadata = serde_json::from_slice(&std::fs::read(entry.path())?)?;
        validate_metadata_record(entry.path(), &version)?;
        let bytes = entry
            .metadata()
            .map_err(|e| AppError::Other(e.to_string()))?
            .len();
        size += bytes;
        *references.entry(version.content_id.clone()).or_default() += 1;
        snapshots.push((version, entry.path().to_path_buf(), bytes));
    }
    let blobs = base.join("blobs");
    let mut blob_sizes = HashMap::new();
    if blobs.exists() {
        for entry in std::fs::read_dir(&blobs)? {
            let entry = entry?;
            let path = entry.path();
            let id = path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let bytes = entry.metadata()?.len();
            if !references.contains_key(&id) {
                std::fs::remove_file(path)?;
            } else {
                size += bytes;
                blob_sizes.insert(id, bytes);
            }
        }
    }
    snapshots.sort_by_key(|v| v.0.timestamp);
    for (version, path, bytes) in snapshots {
        if path != protected
            && (version.timestamp < cutoff || size > config.max_megabytes * 1024 * 1024)
        {
            std::fs::remove_file(path)?;
            size = size.saturating_sub(bytes);
            let count = references
                .get_mut(&version.content_id)
                .ok_or_else(|| AppError::Other("history reference missing".into()))?;
            *count -= 1;
            if *count == 0 {
                let blob = blobs.join(format!("{}.txt", version.content_id));
                if blob.exists() {
                    std::fs::remove_file(blob)?;
                }
                size = size.saturating_sub(*blob_sizes.get(&version.content_id).unwrap_or(&0));
            }
        }
    }
    Ok(())
}
fn capture(base: &Path, path: PathBuf, markdown: String, force: bool) -> AppResult<()> {
    if markdown.len() > 4 * 1024 * 1024 {
        return Err(AppError::InvalidArgument(
            "history snapshot exceeds 4 MiB".into(),
        ));
    }
    let config = settings(base)?;
    let dir = base.join(key(&path));
    std::fs::create_dir_all(&dir)?;
    let previous = metadata(&dir)?;
    let content_id = digest(markdown.as_bytes());
    if let Some(last) = previous.first() {
        if last.content_id == content_id {
            // A deduplicated capture still has to prove that its content blob
            // is readable. Repair a missing or damaged blob before reporting
            // success, especially because restore relies on this capture as
            // its safety copy.
            ensure_blob(base, &content_id, &markdown)?;
            if force {
                let file = dir.join(format!("{}.json", last.id));
                let refreshed = VersionMetadata {
                    timestamp: now().max(last.timestamp.saturating_add(1)),
                    ..last.clone()
                };
                atomic_write::write(&file, &serde_json::to_vec(&refreshed)?)?;
                prune(base, &config, &file)?;
            }
            return Ok(());
        }
        if !force && now().saturating_sub(last.timestamp) < config.interval_seconds * 1000 {
            return Ok(());
        }
    }
    ensure_blob(base, &content_id, &markdown)?;
    let version = VersionMetadata {
        id: uuid::Uuid::new_v4().to_string(),
        path,
        timestamp: now().max(previous.first().map(|v| v.timestamp + 1).unwrap_or(0)),
        size: markdown.len(),
        content_id,
    };
    let file = dir.join(format!("{}.json", version.id));
    atomic_write::write(&file, &serde_json::to_vec(&version)?)?;
    prune(base, &config, &file)
}
#[tauri::command]
pub async fn cmd_local_history_capture(
    app: tauri::AppHandle,
    path: PathBuf,
    markdown: String,
    force: bool,
) -> AppResult<()> {
    let base = app.path().app_local_data_dir()?.join("local-history");
    let path = std::fs::canonicalize(path)?;
    tokio::task::spawn_blocking(move || {
        let _guard = LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|e| AppError::Other(e.to_string()))?;
        capture(&base, path, markdown, force)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}
#[tauri::command]
pub async fn cmd_local_history_list(
    app: tauri::AppHandle,
    path: PathBuf,
) -> AppResult<Vec<VersionMetadata>> {
    let base = app.path().app_local_data_dir()?.join("local-history");
    let path = std::fs::canonicalize(path)?;
    tokio::task::spawn_blocking(move || {
        let _guard = LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|e| AppError::Other(e.to_string()))?;
        metadata(&base.join(key(&path)))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}
#[tauri::command]
pub async fn cmd_local_history_read(
    app: tauri::AppHandle,
    path: PathBuf,
    id: String,
) -> AppResult<LocalVersion> {
    let base = app.path().app_local_data_dir()?.join("local-history");
    let path = std::fs::canonicalize(path)?;
    uuid::Uuid::parse_str(&id).map_err(|e| AppError::InvalidArgument(e.to_string()))?;
    tokio::task::spawn_blocking(move || {
        let _guard = LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|e| AppError::Other(e.to_string()))?;
        let version = metadata(&base.join(key(&path)))?
            .into_iter()
            .find(|v| v.id == id)
            .ok_or_else(|| AppError::InvalidArgument("history version not found".into()))?;
        read_version(&base, version)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}
#[tauri::command]
pub async fn cmd_local_history_settings(
    app: tauri::AppHandle,
    value: Option<HistorySettings>,
) -> AppResult<HistorySettings> {
    let base = app.path().app_local_data_dir()?.join("local-history");
    tokio::task::spawn_blocking(move || {
        let _guard = LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|e| AppError::Other(e.to_string()))?;
        if let Some(value) = value {
            if !(5..=86400).contains(&value.interval_seconds)
                || !(1..=3650).contains(&value.retention_days)
                || !(8..=32768).contains(&value.max_megabytes)
            {
                return Err(AppError::InvalidArgument("invalid history limits".into()));
            }
            std::fs::create_dir_all(&base)?;
            atomic_write::write(&base.join("settings.json"), &serde_json::to_vec(&value)?)?;
            prune(&base, &value, Path::new(""))?;
            Ok(value)
        } else {
            settings(&base)
        }
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nonconsecutive_identical_versions_share_content_and_prune_keeps_referenced_blobs() {
        let base = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let path = PathBuf::from("note.md");
        for content in ["A", "B", "A"] {
            capture(&base, path.clone(), content.into(), true).unwrap();
        }
        assert_eq!(versions(&base.join(key(&path))).unwrap().len(), 3);
        assert_eq!(std::fs::read_dir(base.join("blobs")).unwrap().count(), 2);
        let mut records = metadata(&base.join(key(&path))).unwrap();
        let old = records.pop().unwrap();
        let old_file = base.join(key(&path)).join(format!("{}.json", old.id));
        let expired = VersionMetadata {
            timestamp: 0,
            ..old
        };
        atomic_write::write(&old_file, &serde_json::to_vec(&expired).unwrap()).unwrap();
        prune(&base, &HistorySettings::default(), Path::new("")).unwrap();
        assert_eq!(versions(&base.join(key(&path))).unwrap().len(), 2);
        assert_eq!(std::fs::read_dir(base.join("blobs")).unwrap().count(), 2);
        let newest = records[0].clone();
        let protected = base.join(key(&path)).join(format!("{}.json", newest.id));
        prune(
            &base,
            &HistorySettings {
                max_megabytes: 0,
                ..HistorySettings::default()
            },
            &protected,
        )
        .unwrap();
        assert_eq!(versions(&base.join(key(&path))).unwrap().len(), 1);
        assert_eq!(std::fs::read_dir(base.join("blobs")).unwrap().count(), 1);
        std::fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn deduplicates_repairs_the_blob_and_preserves_before_restore() {
        let base = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let path = PathBuf::from("中文.md");
        capture(&base, path.clone(), "old".into(), true).unwrap();
        let before = metadata(&base.join(key(&path))).unwrap().remove(0);
        let blob = base
            .join("blobs")
            .join(format!("{}.txt", before.content_id));
        std::fs::write(&blob, "corrupt history bytes").unwrap();
        capture(&base, path.clone(), "old".into(), true).unwrap();
        capture(&base, path.clone(), "unsaved".into(), true).unwrap();
        let list = versions(&base.join(key(&path))).unwrap();
        assert_eq!(list.len(), 2);
        assert!(list.iter().any(|v| v.markdown == "unsaved"));
        assert!(list.iter().any(|v| v.markdown == "old"));
        assert_eq!(std::fs::read_to_string(blob).unwrap(), "old");
        let latest = metadata(&base.join(key(&path))).unwrap().remove(0);
        let latest_blob = base
            .join("blobs")
            .join(format!("{}.txt", latest.content_id));
        std::fs::remove_file(&latest_blob).unwrap();
        capture(&base, path.clone(), "unsaved".into(), true).unwrap();
        assert_eq!(versions(&base.join(key(&path))).unwrap().len(), 2);
        assert_eq!(std::fs::read_to_string(latest_blob).unwrap(), "unsaved");
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn same_content_capture_refreshes_and_protects_the_existing_record() {
        let base = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let path = PathBuf::from("note.md");
        capture(&base, path.clone(), "current".into(), true).unwrap();
        let dir = base.join(key(&path));
        let mut old = metadata(&dir).unwrap().remove(0);
        let id = old.id.clone();
        old.timestamp = 0;
        let file = dir.join(format!("{}.json", old.id));
        atomic_write::write(&file, &serde_json::to_vec(&old).unwrap()).unwrap();

        capture(&base, path, "current".into(), true).unwrap();
        let refreshed = metadata(&dir).unwrap();
        assert_eq!(refreshed.len(), 1);
        assert_eq!(refreshed[0].id, id);
        assert!(refreshed[0].timestamp > now().saturating_sub(30 * 86_400_000));
        assert_eq!(versions(&dir).unwrap()[0].markdown, "current");
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn periodic_same_content_capture_does_not_change_snapshot_time() {
        let base = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let path = PathBuf::from("note.md");
        capture(&base, path.clone(), "current".into(), true).unwrap();
        let dir = base.join(key(&path));
        let mut record = metadata(&dir).unwrap().remove(0);
        record.timestamp = 123;
        let file = dir.join(format!("{}.json", record.id));
        atomic_write::write(&file, &serde_json::to_vec(&record).unwrap()).unwrap();

        capture(&base, path, "current".into(), false).unwrap();
        assert_eq!(metadata(&dir).unwrap()[0].timestamp, 123);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn orphan_atomic_write_temp_does_not_block_history_capture_or_prune() {
        let base = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let path = PathBuf::from("note.md");
        capture(&base, path.clone(), "before".into(), true).unwrap();
        let dir = base.join(key(&path));
        std::fs::write(
            dir.join(".mt-write-1234-0123456789abcdef0123456789abcdef.tmp"),
            b"{ partial metadata",
        )
        .unwrap();

        capture(&base, path.clone(), "protected current".into(), true).unwrap();
        let versions = versions(&dir).unwrap();
        assert_eq!(versions.len(), 2);
        assert!(versions
            .iter()
            .any(|version| version.markdown == "protected current"));
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn invalid_metadata_id_is_rejected_before_capture_uses_it_as_a_path() {
        let base = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let path = PathBuf::from("note.md");
        let dir = base.join(key(&path));
        std::fs::create_dir_all(&dir).unwrap();
        let invalid = VersionMetadata {
            id: "../outside".into(),
            path: path.clone(),
            timestamp: now(),
            size: 7,
            content_id: digest(b"current"),
        };
        atomic_write::write(
            &dir.join("stored-name.json"),
            &serde_json::to_vec(&invalid).unwrap(),
        )
        .unwrap();

        assert!(capture(&base, path, "current".into(), true).is_err());
        assert!(!base.join("outside.json").exists());
        assert!(prune(&base, &HistorySettings::default(), Path::new("")).is_err());
        std::fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn interval_throttles_but_force_keeps_changed_version() {
        let base = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let path = PathBuf::from("note.md");
        capture(&base, path.clone(), "one".into(), false).unwrap();
        capture(&base, path.clone(), "two".into(), false).unwrap();
        assert_eq!(versions(&base.join(key(&path))).unwrap().len(), 1);
        capture(&base, path.clone(), "two".into(), true).unwrap();
        assert_eq!(versions(&base.join(key(&path))).unwrap().len(), 2);
        std::fs::remove_dir_all(base).unwrap();
    }
}
