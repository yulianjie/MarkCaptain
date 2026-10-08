//! Persisted preferences via `tauri-plugin-store`.
//!
//! The plugin silently treats malformed JSON as an empty store, so every
//! access first validates an existing on-disk file. Writes are serialized,
//! schema-validated before mutation, flushed to a same-directory temporary
//! file, and atomically replace the destination. Auto-save is disabled so the
//! plugin's non-atomic `fs::write` implementation is never used.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_store::{Store, StoreExt};

use crate::error::{AppError, AppResult};
use crate::filesystem::atomic_write;

use super::schema;

pub const STORE_FILE_NAME: &str = "preferences.json";

static STORE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

pub fn path_from_data_dir(data_dir: &Path, bundle_identifier: &str) -> PathBuf {
    data_dir.join(bundle_identifier).join(STORE_FILE_NAME)
}

fn resolved_store_path<R: Runtime>(app: &AppHandle<R>) -> AppResult<PathBuf> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(STORE_FILE_NAME))
        .map_err(AppError::from)
}

fn validate_existing_file<R: Runtime>(app: &AppHandle<R>) -> AppResult<()> {
    let path = resolved_store_path(app)?;
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(AppError::Io(error)),
    };
    serde_json::from_slice::<Map<String, Value>>(&bytes).map_err(|error| {
        AppError::Other(format!(
            "refusing to load malformed preference store {}: {error}",
            path.display()
        ))
    })?;
    Ok(())
}

fn open_store<R: Runtime>(app: &AppHandle<R>) -> AppResult<Arc<Store<R>>> {
    validate_existing_file(app)?;
    app.store_builder(STORE_FILE_NAME)
        .disable_auto_save()
        .build()
        .map_err(|error| AppError::Other(error.to_string()))
}

/// Return canonical defaults overlaid by valid persisted preferences. Internal
/// user data and unknown/invalid legacy values are intentionally not exposed.
pub fn get_all<R: Runtime>(app: &AppHandle<R>) -> AppResult<Value> {
    let _guard = STORE_LOCK.lock();
    let store = open_store(app)?;
    let mut preferences = schema::defaults();
    for (key, value) in store.entries() {
        if key == "_userData" {
            continue;
        }
        if key == "keybindings" {
            // Old releases could persist a partial map. Normalize it before
            // exposing it so the renderer and native menu see the same full,
            // non-empty effective map even when the on-disk value conflicts.
            preferences.insert(key, crate::menu::normalize_keybindings_value(&value));
            continue;
        }
        match schema::validate_preference(&key, &value) {
            Ok(()) => {
                preferences.insert(key, value);
            }
            Err(error) => {
                tracing::warn!(preference = %key, %error, "ignoring invalid persisted preference");
            }
        }
    }
    Ok(Value::Object(preferences))
}

pub fn get<R: Runtime>(app: &AppHandle<R>, key: &str) -> AppResult<Option<Value>> {
    if !schema::is_known_preference_key(key) {
        return Err(AppError::Schema(format!("unknown preference key `{key}`")));
    }

    let _guard = STORE_LOCK.lock();
    let store = open_store(app)?;
    if let Some(value) = store.get(key) {
        if key == "keybindings" {
            return Ok(Some(crate::menu::normalize_keybindings_value(&value)));
        }
        match schema::validate_preference(key, &value) {
            Ok(()) => return Ok(Some(value)),
            Err(error) => {
                tracing::warn!(preference = %key, %error, "using default for invalid persisted preference");
            }
        }
    }
    Ok(schema::defaults().remove(key))
}

pub fn set<R: Runtime>(app: &AppHandle<R>, key: &str, value: Value) -> AppResult<()> {
    schema::validate_preference(key, &value)?;
    let mut patch = Map::new();
    patch.insert(key.to_string(), value);
    set_validated_many(app, patch)
}

pub fn set_many<R: Runtime>(app: &AppHandle<R>, patch: Map<String, Value>) -> AppResult<()> {
    // Validate the complete patch before changing any in-memory value.
    schema::validate_patch(&patch)?;
    set_validated_many(app, patch)
}

fn set_validated_many<R: Runtime>(app: &AppHandle<R>, patch: Map<String, Value>) -> AppResult<()> {
    let _guard = STORE_LOCK.lock();
    let store = open_store(app)?;
    apply_and_save(&store, &resolved_store_path(app)?, patch)
}

/// Return user data with structural defaults. Unknown and invalid legacy
/// fields stay untouched on disk but are not sent to the renderer. The legacy
/// plaintext GitHub token is always omitted and migrated separately.
pub fn get_user_data<R: Runtime>(app: &AppHandle<R>) -> AppResult<Map<String, Value>> {
    let _guard = STORE_LOCK.lock();
    let store = open_store(app)?;
    let mut result = schema::user_data_defaults();
    let Some(raw) = store.get("_userData") else {
        return Ok(result);
    };
    let Some(mut raw) = raw.as_object().cloned() else {
        return Err(AppError::Schema(
            "persisted `_userData` must be an object; refusing to overwrite it".into(),
        ));
    };

    if sanitize_legacy_user_data(&mut raw) {
        let mut patch = Map::new();
        patch.insert("_userData".into(), Value::Object(raw.clone()));
        apply_and_save(&store, &resolved_store_path(app)?, patch)?;
    }

    for (key, value) in &raw {
        if key == "githubToken" {
            continue;
        }
        match schema::validate_user_data_value(key, value) {
            Ok(()) => merge_value(&mut result, key.clone(), value.clone()),
            Err(error) => {
                tracing::warn!(user_data = %key, %error, "ignoring invalid persisted user data");
            }
        }
    }
    Ok(result)
}

/// Read one opaque application-owned user-data value without exposing it
/// through the generic renderer user-data snapshot. Dedicated IPC commands
/// validate the value before returning it.
pub fn get_user_data_key<R: Runtime>(app: &AppHandle<R>, key: &str) -> AppResult<Option<Value>> {
    let _guard = STORE_LOCK.lock();
    let store = open_store(app)?;
    match store.get("_userData") {
        Some(Value::Object(object)) => Ok(object.get(key).cloned()),
        Some(_) => Err(AppError::Schema(
            "persisted `_userData` must be an object; refusing to overwrite it".into(),
        )),
        None => Ok(None),
    }
}

/// Atomically replace one opaque application-owned user-data value. This is
/// intentionally separate from the deep-merged/broadcast generic API.
pub fn set_user_data_key<R: Runtime>(app: &AppHandle<R>, key: &str, value: Value) -> AppResult<()> {
    let _guard = STORE_LOCK.lock();
    let store = open_store(app)?;
    let mut user_data = match store.get("_userData") {
        Some(Value::Object(object)) => object,
        Some(_) => {
            return Err(AppError::Schema(
                "persisted `_userData` must be an object; refusing to overwrite it".into(),
            ));
        }
        None => Map::new(),
    };
    // A dedicated opaque write must not accidentally preserve a plaintext
    // token left by a legacy build.
    user_data.remove("githubToken");
    user_data.insert(key.to_owned(), value);
    let mut outer = Map::new();
    outer.insert("_userData".into(), Value::Object(user_data));
    apply_and_save(&store, &resolved_store_path(app)?, outer)
}

/// Deep-merge a validated user-data patch into the existing subtree. Object
/// children are merged recursively; scalar and array values replace only their
/// own key, never sibling settings.
pub fn merge_user_data<R: Runtime>(app: &AppHandle<R>, patch: Map<String, Value>) -> AppResult<()> {
    schema::validate_user_data_patch(&patch)?;
    if patch.is_empty() {
        return Ok(());
    }

    let _guard = STORE_LOCK.lock();
    let store = open_store(app)?;
    let mut existing = match store.get("_userData") {
        Some(Value::Object(object)) => object,
        Some(_) => {
            return Err(AppError::Schema(
                "persisted `_userData` must be an object; refusing to overwrite it".into(),
            ));
        }
        None => Map::new(),
    };
    deep_merge(&mut existing, patch);
    // Secrets are session-only even if an older renderer attempts a generic
    // object update or an old installation already persisted one.
    existing.remove("githubToken");
    sanitize_legacy_user_data(&mut existing);

    let mut outer = Map::new();
    outer.insert("_userData".into(), Value::Object(existing));
    apply_and_save(&store, &resolved_store_path(app)?, outer)
}

/// Remove a formerly persisted user-data field and return its old value. Used
/// to migrate plaintext secrets into process memory on first read.
pub fn remove_user_data_key<R: Runtime>(app: &AppHandle<R>, key: &str) -> AppResult<Option<Value>> {
    let _guard = STORE_LOCK.lock();
    let store = open_store(app)?;
    let Some(raw) = store.get("_userData") else {
        return Ok(None);
    };
    let Some(mut user_data) = raw.as_object().cloned() else {
        return Err(AppError::Schema(
            "persisted `_userData` must be an object; refusing to overwrite it".into(),
        ));
    };
    let removed = user_data.remove(key);
    if removed.is_none() {
        return Ok(None);
    }
    let mut patch = Map::new();
    patch.insert("_userData".into(), Value::Object(user_data));
    apply_and_save(&store, &resolved_store_path(app)?, patch)?;
    Ok(removed)
}

fn apply_and_save<R: Runtime>(
    store: &Store<R>,
    path: &Path,
    patch: Map<String, Value>,
) -> AppResult<()> {
    let snapshot = store.entries();
    for (key, value) in patch {
        store.set(key, value);
    }
    if let Err(error) = persist_store_atomically(path, store.entries()) {
        restore_snapshot(store, snapshot.clone());
        if let Err(rollback_error) = persist_store_atomically(path, snapshot) {
            tracing::warn!(%rollback_error, "failed to restore preference store on disk after atomic save error");
        }
        return Err(AppError::Other(format!(
            "failed to save preferences: {error}"
        )));
    }
    Ok(())
}

fn restore_snapshot<R: Runtime>(store: &Store<R>, snapshot: Vec<(String, Value)>) {
    store.clear();
    for (key, value) in snapshot {
        store.set(key, value);
    }
}

fn persist_store_atomically(path: &Path, entries: Vec<(String, Value)>) -> AppResult<()> {
    let cache: HashMap<String, Value> = entries.into_iter().collect();
    let bytes = serde_json::to_vec_pretty(&cache)?;
    atomic_write::write(path, &bytes).map_err(AppError::Io)
}

fn merge_value(target: &mut Map<String, Value>, key: String, incoming: Value) {
    match (target.get_mut(&key), incoming) {
        (Some(Value::Object(current)), Value::Object(patch)) => deep_merge(current, patch),
        (_, value) => {
            target.insert(key, value);
        }
    }
}

fn deep_merge(target: &mut Map<String, Value>, patch: Map<String, Value>) {
    for (key, value) in patch {
        merge_value(target, key, value);
    }
}

/// Normalize retired image providers without discarding valid GitHub fields.
/// Returning `true` lets callers durably rewrite the migration. This same
/// sanitizer runs before every user-data write so an invalid legacy sibling
/// cannot survive forever beside otherwise valid patches.
fn sanitize_legacy_user_data(user_data: &mut Map<String, Value>) -> bool {
    let mut changed = false;
    if user_data
        .get("currentUploader")
        .and_then(Value::as_str)
        .is_some_and(|provider| !matches!(provider, "none" | "github" | "picgo" | "script"))
        || user_data
            .get("currentUploader")
            .is_some_and(|provider| !provider.is_string())
    {
        user_data.insert("currentUploader".into(), Value::String("none".into()));
        changed = true;
    }

    match user_data.get_mut("imageBed") {
        Some(Value::Object(image_bed)) => {
            let before = image_bed.len();
            image_bed.retain(|provider, _| provider == "github");
            changed |= image_bed.len() != before;

            if let Some(github) = image_bed.get_mut("github") {
                match github {
                    Value::Object(fields) => {
                        let before = fields.len();
                        fields.retain(|field, value| {
                            matches!(field.as_str(), "owner" | "repo" | "branch")
                                && value.is_string()
                        });
                        changed |= fields.len() != before;
                    }
                    _ => {
                        image_bed.remove("github");
                        changed = true;
                    }
                }
            }
        }
        Some(_) => {
            user_data.remove("imageBed");
            changed = true;
        }
        None => {}
    }
    changed
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn store_path_uses_the_data_directory() {
        let root = Path::new("data-root");
        assert_eq!(
            path_from_data_dir(root, "io.github.yulianjie.markcaptain"),
            root.join("io.github.yulianjie.markcaptain")
                .join("preferences.json")
        );
    }

    #[test]
    fn deep_merge_preserves_top_level_and_nested_siblings() {
        let mut current = json!({
            "currentUploader": "github",
            "githubToken": "legacy",
            "imageBed": {
                "github": { "owner": "old", "repo": "repo", "branch": "main" }
            }
        })
        .as_object()
        .unwrap()
        .clone();
        let patch = json!({ "imageBed": { "github": { "owner": "new" } } })
            .as_object()
            .unwrap()
            .clone();

        deep_merge(&mut current, patch);

        assert_eq!(current["currentUploader"], json!("github"));
        assert_eq!(current["githubToken"], json!("legacy"));
        assert_eq!(current["imageBed"]["github"]["owner"], json!("new"));
        assert_eq!(current["imageBed"]["github"]["repo"], json!("repo"));
        assert_eq!(current["imageBed"]["github"]["branch"], json!("main"));
    }

    #[test]
    fn arrays_and_scalars_replace_only_their_own_key() {
        let mut current = json!({ "webImages": [1], "picgoPath": "old", "other": true })
            .as_object()
            .unwrap()
            .clone();
        deep_merge(
            &mut current,
            json!({ "webImages": [2], "picgoPath": "new" })
                .as_object()
                .unwrap()
                .clone(),
        );
        assert_eq!(current["webImages"], json!([2]));
        assert_eq!(current["picgoPath"], json!("new"));
        assert_eq!(current["other"], json!(true));
    }

    #[test]
    fn legacy_image_beds_are_sanitized_without_losing_valid_github_settings() {
        let mut user_data = json!({
            "currentUploader": "s3",
            "imageBed": {
                "github": {
                    "owner": "octo",
                    "repo": "images",
                    "branch": "main",
                    "token": "retired",
                    "invalidTypedField": 1
                },
                "s3": { "bucket": "legacy" },
                "smms": { "token": "legacy" }
            }
        })
        .as_object()
        .unwrap()
        .clone();

        assert!(sanitize_legacy_user_data(&mut user_data));
        assert_eq!(user_data["currentUploader"], json!("none"));
        assert!(user_data["imageBed"].get("s3").is_none());
        assert!(user_data["imageBed"].get("smms").is_none());
        assert_eq!(user_data["imageBed"]["github"]["owner"], json!("octo"));
        assert_eq!(user_data["imageBed"]["github"]["repo"], json!("images"));
        assert_eq!(user_data["imageBed"]["github"]["branch"], json!("main"));
        assert!(user_data["imageBed"]["github"].get("token").is_none());
        assert!(user_data["imageBed"]["github"]
            .get("invalidTypedField")
            .is_none());
        assert!(!sanitize_legacy_user_data(&mut user_data));
    }

    #[test]
    fn legal_patch_cleans_invalid_legacy_image_bed_siblings() {
        let mut existing = json!({
            "currentUploader": "github",
            "imageBed": {
                "github": { "owner": "old", "repo": "images", "branch": "main", "legacy": true },
                "s3": { "bucket": "retired" }
            }
        })
        .as_object()
        .unwrap()
        .clone();
        let patch = json!({ "imageBed": { "github": { "owner": "new" } } })
            .as_object()
            .unwrap()
            .clone();

        deep_merge(&mut existing, patch);
        assert!(sanitize_legacy_user_data(&mut existing));

        assert_eq!(existing["imageBed"]["github"]["owner"], json!("new"));
        assert_eq!(existing["imageBed"]["github"]["repo"], json!("images"));
        assert!(existing["imageBed"]["github"].get("legacy").is_none());
        assert!(existing["imageBed"].get("s3").is_none());
    }
}
