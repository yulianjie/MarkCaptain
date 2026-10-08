//! Optional local transcripts. One UUID file per conversation, guarded across
//! windows with revisions; tombstones reject delayed writes after deletion.
use super::failure;
use crate::{error::AppResult, filesystem::atomic_write};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

static LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
const MAX_RECORD: u64 = 16_000_000;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    schema_version: u32,
    id: String,
    revision: u64,
    title: String,
    created_at: u64,
    updated_at: u64,
    data: Value,
}

fn directory(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app.path().app_config_dir()?.join("agent-history"))
}
fn record_path(dir: &Path, id: &str) -> AppResult<PathBuf> {
    let uuid = uuid::Uuid::parse_str(id).map_err(|_| failure("historyInvalid"))?;
    if uuid.to_string() != id {
        return Err(failure("historyInvalid"));
    }
    Ok(dir.join(format!("{id}.json")))
}
fn read_json(path: &Path) -> AppResult<Value> {
    let meta = fs::metadata(path).map_err(|_| failure("historyRead"))?;
    if meta.len() > MAX_RECORD {
        return Err(failure("historyInvalid"));
    }
    serde_json::from_slice(&fs::read(path).map_err(|_| failure("historyRead"))?)
        .map_err(|_| failure("historyInvalid"))
}
fn enabled(dir: &Path) -> AppResult<bool> {
    let path = dir.join("settings.json");
    if !path.exists() {
        return Ok(false);
    }
    read_json(&path)?["enabled"]
        .as_bool()
        .ok_or_else(|| failure("historyInvalid"))
}
fn validate(record: &Record) -> AppResult<()> {
    record_path(Path::new(""), &record.id)?;
    let snapshots = record.data["snapshots"]
        .as_array()
        .ok_or_else(|| failure("historyInvalid"))?;
    let messages = record.data["chat"]["messages"]
        .as_array()
        .ok_or_else(|| failure("historyInvalid"))?;
    if record.schema_version != 1
        || record.title.len() > 500
        || record.title.trim().is_empty()
        || record.created_at > record.updated_at
        || record.updated_at > 9_007_199_254_740_991
        || record.revision > 9_007_199_254_740_000
        || snapshots.len() > 512
        || messages.len() > 400
        || serde_json::to_vec(record)
            .map_err(|_| failure("historyInvalid"))?
            .len() as u64
            > MAX_RECORD
        || messages.iter().any(|m| {
            !matches!(m["role"].as_str(), Some("user" | "assistant"))
                || m["content"].as_str().map_or(true, |c| c.len() > 2_000_000)
                || m.get("images").is_some()
        })
    {
        return Err(failure("historyInvalid"));
    }
    for snapshot in snapshots {
        let text = snapshot["markdown"]
            .as_str()
            .ok_or_else(|| failure("historyInvalid"))?;
        let from = snapshot["from"]
            .as_u64()
            .ok_or_else(|| failure("historyInvalid"))?;
        let to = snapshot["to"]
            .as_u64()
            .ok_or_else(|| failure("historyInvalid"))?;
        if text.len() > 2_000_000
            || from > to
            || to > text.encode_utf16().count() as u64
            || snapshot["name"].as_str().map_or(true, |s| s.len() > 1024)
            || snapshot["tabId"].as_str().map_or(true, |s| s.len() > 128)
            || snapshot
                .get("path")
                .is_some_and(|p| p.as_str().map_or(true, |s| s.len() > 8192))
        {
            return Err(failure("historyInvalid"));
        }
    }
    Ok(())
}
fn write(dir: &Path, mut record: Record) -> AppResult<Record> {
    validate(&record)?;
    if !enabled(dir)? {
        return Err(failure("historyDisabled"));
    }
    let path = record_path(dir, &record.id)?;
    if path.exists() {
        let old = read_json(&path)?;
        if old["deleted"] == true || old["revision"].as_u64() != Some(record.revision) {
            return Err(failure("historyConflict"));
        }
    } else if record.revision != 0 {
        return Err(failure("historyConflict"));
    }
    let mut count = 0usize;
    let mut bytes = 0u64;
    for entry in fs::read_dir(dir).map_err(|_| failure("historyRead"))? {
        let entry = entry.map_err(|_| failure("historyRead"))?;
        let candidate = entry.path();
        if candidate == path || candidate.extension().map_or(true, |e| e != "json") {
            continue;
        }
        let Some(stem) = candidate.file_stem().and_then(|v| v.to_str()) else {
            continue;
        };
        if uuid::Uuid::parse_str(stem).is_err() {
            continue;
        }
        let size = entry.metadata().map_err(|_| failure("historyRead"))?.len();
        // Tombstones are smaller than valid records; inspect only these tiny files.
        if size < 200 && read_json(&candidate)?["deleted"] == true {
            continue;
        }
        count += 1;
        bytes += size;
    }
    let new_size = serde_json::to_vec(&record)
        .map_err(|_| failure("historyInvalid"))?
        .len() as u64;
    if count >= 100 || bytes + new_size > 128_000_000 {
        return Err(failure("historyLimit"));
    }
    record.revision += 1;
    atomic_write::write(
        &path,
        &serde_json::to_vec(&record).map_err(|_| failure("historyInvalid"))?,
    )
    .map_err(|_| failure("historyWrite"))?;
    Ok(record)
}

#[tauri::command]
pub async fn cmd_agent_history_settings(app: AppHandle) -> AppResult<Value> {
    tokio::task::spawn_blocking(move || {
        let _guard = LOCK.lock();
        Ok(json!({"enabled":enabled(&directory(&app)?)?}))
    })
    .await
    .map_err(|_| failure("historyRead"))?
}
#[tauri::command]
pub async fn cmd_agent_history_set_enabled(app: AppHandle, enabled: bool) -> AppResult<Value> {
    tokio::task::spawn_blocking(move || {
        let _guard = LOCK.lock();
        let dir = directory(&app)?;
        fs::create_dir_all(&dir).map_err(|_| failure("historyWrite"))?;
        atomic_write::write(
            &dir.join("settings.json"),
            &serde_json::to_vec(&json!({"enabled":enabled}))
                .map_err(|_| failure("historyWrite"))?,
        )
        .map_err(|_| failure("historyWrite"))?;
        Ok(json!({"enabled":enabled}))
    })
    .await
    .map_err(|_| failure("historyRead"))?
}
#[tauri::command]
pub async fn cmd_agent_history_list(app: AppHandle) -> AppResult<Vec<Value>> {
    tokio::task::spawn_blocking(move || {

    let _guard = LOCK.lock(); let dir = directory(&app)?;
    if !dir.exists() { return Ok(vec![]); }
    let mut items = vec![];
    let mut bytes = 0u64;
    for entry in fs::read_dir(&dir).map_err(|_| failure("historyRead"))? {
        let entry = entry.map_err(|_| failure("historyRead"))?;
        let path = entry.path();
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else { continue; };
        if uuid::Uuid::parse_str(id).is_err() || path.extension().map_or(true, |e| e != "json") { continue; }
        let value = read_json(&path)?;
        if value["deleted"] == true { continue; }
        bytes += entry.metadata().map_err(|_| failure("historyRead"))?.len();
        if bytes > 128_000_000 || items.len() >= 100 { return Err(failure("historyLimit")); }
        let record: Record = serde_json::from_value(value).map_err(|_| failure("historyInvalid"))?;
        validate(&record)?;
        if record.id != id { return Err(failure("historyInvalid")); }
        items.push(json!({"id":record.id,"revision":record.revision,"title":record.title,"createdAt":record.created_at,"updatedAt":record.updated_at}));
    }
    items.sort_by_key(|item| std::cmp::Reverse(item["updatedAt"].as_u64().unwrap_or(0)));
    Ok(items)

    }).await.map_err(|_| failure("historyRead"))?
}
#[tauri::command]
pub async fn cmd_agent_history_read(app: AppHandle, id: String) -> AppResult<Record> {
    tokio::task::spawn_blocking(move || {
        let _guard = LOCK.lock();
        let record: Record =
            serde_json::from_value(read_json(&record_path(&directory(&app)?, &id)?)?)
                .map_err(|_| failure("historyInvalid"))?;
        validate(&record)?;
        if record.id != id {
            return Err(failure("historyInvalid"));
        }
        Ok(record)
    })
    .await
    .map_err(|_| failure("historyRead"))?
}
#[tauri::command]
pub async fn cmd_agent_history_write(app: AppHandle, record: Record) -> AppResult<Record> {
    tokio::task::spawn_blocking(move || {
        let _guard = LOCK.lock();
        write(&directory(&app)?, record)
    })
    .await
    .map_err(|_| failure("historyRead"))?
}
#[tauri::command]
pub async fn cmd_agent_history_delete(app: AppHandle, id: String, revision: u64) -> AppResult<()> {
    tokio::task::spawn_blocking(move || {
        let _guard = LOCK.lock();
        let path = record_path(&directory(&app)?, &id)?;
        let old = read_json(&path)?;
        if old["revision"].as_u64() != Some(revision) {
            return Err(failure("historyConflict"));
        }
        atomic_write::write(
            &path,
            &serde_json::to_vec(&json!({"id":id,"revision":revision+1,"deleted":true}))
                .map_err(|_| failure("historyWrite"))?,
        )
        .map_err(|_| failure("historyWrite"))?;
        Ok(())
    })
    .await
    .map_err(|_| failure("historyRead"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn uuid_paths_and_snapshot_bounds_are_checked() {
        assert!(record_path(Path::new("."), "../settings").is_err());
        let mut record = Record {
            schema_version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            revision: 0,
            title: "Chat".into(),
            created_at: 1,
            updated_at: 1,
            data: json!({"snapshots":[{"tabId":"a","name":"note","markdown":"ok","from":0,"to":2}],"chat":{"messages":[{"role":"user","content":"hello"}]}}),
        };
        assert!(validate(&record).is_ok());
        record.data["snapshots"][0]["to"] = json!(3);
        assert!(validate(&record).is_err());
    }
    #[test]
    fn stale_window_writes_and_deleted_record_resurrection_are_rejected() {
        let dir =
            std::env::temp_dir().join(format!("markcaptain-history-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("settings.json"), br#"{"enabled":true}"#).unwrap();
        let initial = Record {
            schema_version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            revision: 0,
            title: "Chat".into(),
            created_at: 1,
            updated_at: 1,
            data: json!({"snapshots":[],"chat":{"messages":[]}}),
        };
        let first = write(&dir, initial.clone()).unwrap();
        assert_eq!(first.revision, 1);
        assert!(write(&dir, initial).is_err());
        let path = record_path(&dir, &first.id).unwrap();
        fs::write(path, br#"{"revision":1,"deleted":true}"#).unwrap();
        assert!(write(&dir, first).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
