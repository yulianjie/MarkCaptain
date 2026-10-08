//! Restricted-process adapter for trusted third-party storage providers.
//!
//! A plugin is an explicitly installed executable with a small JSON manifest.
//! It receives one JSON-RPC 2.0 request over stdin and returns one response on
//! stdout.  No shell is involved, executable paths are allowlisted, protocol
//! messages are bounded, inherited environment is removed, and stderr is
//! intentionally discarded so credentials cannot enter application logs.

use super::{
    ChangePage, ConditionalDelete, ConditionalMove, ConditionalWrite, ProviderCapabilities,
    ProviderKind, RemoteContent, RemoteEntry, RemotePath, RemoteVersion, SecretString,
    StorageError, StorageErrorCode, StorageProvider, StorageResult,
};
use async_trait::async_trait;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
};

pub const PLUGIN_MANIFEST_VERSION: u16 = 1;
pub const PLUGIN_PROTOCOL_VERSION: u16 = 1;
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: u64 = 512 * 1024;
/// File bytes never travel as JSON number arrays.  The plugin transfer
/// contract uses app-created files and has this hard upper bound even if a
/// manifest omits `maxObjectSize`.
pub const MAX_PLUGIN_TRANSFER_BYTES: u64 = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoragePluginManifest {
    pub manifest_version: u16,
    pub id: String,
    pub display_name: String,
    /// Human/plugin release version, distinct from the manifest and protocol
    /// compatibility versions.
    pub version: String,
    pub protocol_version: u16,
    /// Relative to the manifest file unless it is an explicitly allowlisted
    /// absolute path.  The resolved executable is canonicalized before use.
    pub executable: PathBuf,
    #[serde(default)]
    pub arguments: Vec<String>,
    pub capabilities: ProviderCapabilities,
}

impl StoragePluginManifest {
    pub fn validate(&self) -> StorageResult<()> {
        if self.manifest_version != PLUGIN_MANIFEST_VERSION
            || self.protocol_version != PLUGIN_PROTOCOL_VERSION
            || self.id.is_empty()
            || self.id.len() > 120
            || !self
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
            || self.display_name.trim().is_empty()
            || self.display_name.len() > 120
            || self.display_name.chars().any(char::is_control)
            || self.version.is_empty()
            || self.version.len() > 64
            || !self.version.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b'+')
            })
            || self.executable.as_os_str().is_empty()
            || self.arguments.len() > 16
            || self
                .arguments
                .iter()
                .any(|argument| argument.len() > 1024 || argument.chars().any(char::is_control))
        {
            return Err(StorageError::invalid_config());
        }
        Ok(())
    }
}

/// The command layer builds this only from the app's plugin install roots.
/// `PluginProvider::load` canonicalizes both the executable and every root,
/// so sibling-path and symlink escapes are rejected.
#[derive(Clone, Debug, Default)]
pub struct PluginAllowlist {
    roots: Vec<PathBuf>,
}

impl PluginAllowlist {
    pub fn new(roots: Vec<PathBuf>) -> StorageResult<Self> {
        if roots.is_empty() || roots.len() > 16 {
            return Err(StorageError::invalid_config());
        }
        let mut seen = HashSet::new();
        let mut canonical = Vec::with_capacity(roots.len());
        for root in roots {
            let root = std::fs::canonicalize(root).map_err(|_| StorageError::invalid_config())?;
            if !root.is_dir() || !seen.insert(root.clone()) {
                return Err(StorageError::invalid_config());
            }
            canonical.push(root);
        }
        Ok(Self { roots: canonical })
    }

    fn permits(&self, executable: &Path) -> bool {
        self.roots.iter().any(|root| executable.starts_with(root))
    }
}

pub struct PluginProvider {
    manifest: StoragePluginManifest,
    executable: PathBuf,
    plugin_directory: PathBuf,
    credential: Option<SecretString>,
    configuration: Map<String, Value>,
    timeout: Duration,
}

impl std::fmt::Debug for PluginProvider {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PluginProvider")
            .field("plugin", &self.manifest.id)
            .field("executable", &self.executable)
            .field("plugin_directory", &self.plugin_directory)
            .field(
                "credential",
                &self.credential.as_ref().map(|_| "[redacted]"),
            )
            .field(
                "configurationKeys",
                &self.configuration.keys().collect::<Vec<_>>(),
            )
            .finish()
    }
}

impl PluginProvider {
    /// Load a plugin selected by its installation directory.  The final path
    /// component is the installation id and must be exactly the reviewed
    /// manifest id; callers should prefer this over accepting a manifest path
    /// from arbitrary user input.
    pub fn load_from_plugin_directory(
        plugin_directory: impl AsRef<Path>,
        allowlist: &PluginAllowlist,
    ) -> StorageResult<Self> {
        let plugin_directory =
            std::fs::canonicalize(plugin_directory).map_err(|_| StorageError::invalid_config())?;
        if !plugin_directory.is_dir() || !allowlist.permits(&plugin_directory) {
            return Err(StorageError::invalid_config());
        }
        Self::load(plugin_directory.join("storage-plugin.json"), allowlist)
    }

    /// Compatibility loader for callers that already resolved the manifest
    /// path.  It still validates the selected directory identity, so it cannot
    /// bypass [`Self::load_from_plugin_directory`]'s trust boundary.
    pub fn load(
        manifest_path: impl AsRef<Path>,
        allowlist: &PluginAllowlist,
    ) -> StorageResult<Self> {
        let manifest_path =
            std::fs::canonicalize(manifest_path).map_err(|_| StorageError::invalid_config())?;
        let metadata =
            std::fs::metadata(&manifest_path).map_err(|_| StorageError::invalid_config())?;
        if !metadata.is_file() || metadata.len() > MAX_MANIFEST_BYTES {
            return Err(StorageError::invalid_config());
        }
        let source = std::fs::read(&manifest_path).map_err(|_| StorageError::invalid_config())?;
        let manifest: StoragePluginManifest =
            serde_json::from_slice(&source).map_err(|_| StorageError::invalid_config())?;
        manifest.validate()?;
        let manifest_dir = manifest_path
            .parent()
            .ok_or_else(StorageError::invalid_config)?;
        let selected_id = manifest_dir
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(StorageError::invalid_config)?;
        if selected_id != manifest.id || !allowlist.permits(manifest_dir) {
            return Err(StorageError::invalid_config());
        }
        let candidate = if manifest.executable.is_absolute() {
            manifest.executable.clone()
        } else {
            manifest_dir.join(&manifest.executable)
        };
        let executable =
            std::fs::canonicalize(candidate).map_err(|_| StorageError::invalid_config())?;
        let executable_metadata =
            std::fs::metadata(&executable).map_err(|_| StorageError::invalid_config())?;
        if !executable_metadata.is_file() || !allowlist.permits(&executable) {
            return Err(StorageError::invalid_config());
        }
        Ok(Self {
            manifest,
            executable,
            plugin_directory: manifest_dir.to_path_buf(),
            credential: None,
            configuration: Map::new(),
            timeout: DEFAULT_TIMEOUT,
        })
    }

    pub fn with_credential(mut self, credential: Option<SecretString>) -> Self {
        self.credential = credential;
        self
    }

    /// Non-secret configuration passed to every plugin request.  This is for
    /// endpoints, bucket names, account ids and similar connection metadata;
    /// credentials belong in `CredentialStore` and are supplied separately.
    pub fn with_configuration(mut self, configuration: Map<String, Value>) -> StorageResult<Self> {
        validate_plugin_configuration(&configuration)?;
        self.configuration = configuration;
        Ok(self)
    }

    pub fn manifest(&self) -> &StoragePluginManifest {
        &self.manifest
    }

    pub fn configuration(&self) -> &Map<String, Value> {
        &self.configuration
    }

    fn request_value(&self, id: &str, method: &str, params: Value) -> StorageResult<Vec<u8>> {
        let mut params = params;
        let object = params.as_object_mut().ok_or_else(StorageError::protocol)?;
        object.insert("protocolVersion".into(), json!(PLUGIN_PROTOCOL_VERSION));
        object.insert(
            "configuration".into(),
            Value::Object(self.configuration.clone()),
        );
        if let Some(credential) = &self.credential {
            // Sent solely over the already-spawned process's stdin. It is not
            // an argument, environment variable, log field, or config value.
            object.insert(
                "credential".into(),
                Value::String(credential.expose().to_owned()),
            );
        }
        let bytes = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .map_err(|_| StorageError::protocol())?;
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err(StorageError::invalid_config());
        }
        Ok(bytes)
    }

    fn transfer_limit(&self) -> u64 {
        self.manifest
            .capabilities
            .max_object_size
            .unwrap_or(MAX_PLUGIN_TRANSFER_BYTES)
            .min(MAX_PLUGIN_TRANSFER_BYTES)
    }

    async fn rpc<R: DeserializeOwned>(&self, method: &str, params: Value) -> StorageResult<R> {
        let id = uuid::Uuid::new_v4().to_string();
        let request = self.request_value(&id, method, params)?;
        let mut child = self.spawn()?;
        let deadline = Instant::now() + self.timeout;
        let stdout = child.stdout.take().ok_or_else(StorageError::protocol)?;
        let output_task = tokio::spawn(async move {
            let mut limited = stdout.take(MAX_RESPONSE_BYTES + 1);
            let mut output = Vec::new();
            limited.read_to_end(&mut output).await.map(|_| output)
        });
        let mut stdin = child.stdin.take().ok_or_else(StorageError::protocol)?;
        let write = async {
            stdin
                .write_all(&request)
                .await
                .map_err(|_| StorageError::protocol())?;
            stdin
                .write_all(b"\n")
                .await
                .map_err(|_| StorageError::protocol())
        };
        match tokio::time::timeout(remaining(deadline)?, write).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                output_task.abort();
                return Err(error);
            }
            Err(_) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                output_task.abort();
                return Err(StorageError::new(StorageErrorCode::Timeout));
            }
        }
        drop(stdin);
        let status = match tokio::time::timeout(remaining(deadline)?, child.wait()).await {
            Ok(Ok(status)) => status,
            Ok(Err(_)) => {
                output_task.abort();
                return Err(StorageError::new(StorageErrorCode::Protocol));
            }
            Err(_) => {
                // `start_kill` does not wait; wait avoids leaking the child
                // before returning a timeout to the sync engine.
                let _ = child.start_kill();
                let _ = child.wait().await;
                output_task.abort();
                return Err(StorageError::new(StorageErrorCode::Timeout));
            }
        };
        let output = tokio::time::timeout(remaining(deadline)?, output_task)
            .await
            .map_err(|_| StorageError::new(StorageErrorCode::Protocol))?
            .map_err(|_| StorageError::new(StorageErrorCode::Protocol))?
            .map_err(|_| StorageError::new(StorageErrorCode::Protocol))?;
        if !status.success() || output.len() > MAX_RESPONSE_BYTES as usize {
            return Err(StorageError::new(StorageErrorCode::Protocol));
        }
        parse_response(&id, &output)
    }

    fn spawn(&self) -> StorageResult<Child> {
        let mut command = Command::new(&self.executable);
        command
            .args(&self.manifest.arguments)
            .env_clear()
            .current_dir(&self.plugin_directory)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        configure_safe_environment(&mut command);
        command
            .spawn()
            .map_err(|_| StorageError::new(StorageErrorCode::Unavailable))
    }
}

fn configure_safe_environment(command: &mut Command) {
    #[cfg(windows)]
    {
        // Windows programs (and the loader) can require SystemRoot, but PATH,
        // user profiles, tokens and application-specific variables are not
        // inherited by a provider process.
        for key in ["SystemRoot", "WINDIR", "ComSpec"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
    }
    #[cfg(not(windows))]
    {
        // A deterministic system-only path supports shebang launchers without
        // passing the caller's PATH or shell configuration to the plugin.
        command.env("PATH", "/usr/bin:/bin");
    }
}

struct TransferDirectory {
    directory: tempfile::TempDir,
}

impl TransferDirectory {
    fn new() -> StorageResult<Self> {
        tempfile::Builder::new()
            .prefix("markcaptain-storage-plugin-")
            .tempdir()
            .map(|directory| Self { directory })
            .map_err(|_| StorageError::new(StorageErrorCode::Io))
    }

    fn input_path(&self) -> PathBuf {
        self.directory.path().join("input.bin")
    }
    fn output_path(&self) -> PathBuf {
        self.directory.path().join("output.bin")
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransferReadResponse {
    #[serde(default)]
    version: Option<RemoteVersion>,
}

fn validate_transfer_output(path: &Path, maximum: u64) -> StorageResult<()> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|_| StorageError::new(StorageErrorCode::Protocol))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > maximum {
        return Err(StorageError::new(StorageErrorCode::Protocol));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(StorageError::new(StorageErrorCode::Protocol));
        }
    }
    Ok(())
}

fn remaining(deadline: Instant) -> StorageResult<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|duration| !duration.is_zero())
        .ok_or_else(|| StorageError::new(StorageErrorCode::Timeout))
}

/// Validates metadata that will be persisted in ordinary connection config.
/// The recursive check prevents a plugin setting such as
/// `{ "auth": { "token": "..." } }` from silently becoming a second
/// credential store.
pub fn validate_plugin_configuration(configuration: &Map<String, Value>) -> StorageResult<()> {
    if configuration.len() > 64
        || serde_json::to_vec(configuration).map_or(true, |bytes| bytes.len() > 64 * 1024)
    {
        return Err(StorageError::invalid_config());
    }
    let mut nodes = 0usize;
    for (key, value) in configuration {
        validate_configuration_value(key, value, 0, &mut nodes)?;
    }
    Ok(())
}

fn validate_configuration_value(
    key: &str,
    value: &Value,
    depth: u8,
    nodes: &mut usize,
) -> StorageResult<()> {
    *nodes = nodes.saturating_add(1);
    let normalized_key = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    let secret_like_key = [
        "token",
        "password",
        "secret",
        "apikey",
        "authorization",
        "credential",
        "privatekey",
        "accesskey",
    ]
    .iter()
    .any(|suffix| normalized_key.ends_with(suffix));
    if *nodes > 256
        || depth > 8
        || key.is_empty()
        || key.len() > 128
        || key.chars().any(char::is_control)
        || secret_like_key
    {
        return Err(StorageError::invalid_config());
    }
    match value {
        Value::String(value) if value.len() > 8192 || value.chars().any(char::is_control) => {
            Err(StorageError::invalid_config())
        }
        Value::Array(values) => {
            if values.len() > 64 {
                return Err(StorageError::invalid_config());
            }
            for value in values {
                validate_configuration_value("item", value, depth + 1, nodes)?;
            }
            Ok(())
        }
        Value::Object(values) => {
            if values.len() > 64 {
                return Err(StorageError::invalid_config());
            }
            for (key, value) in values {
                validate_configuration_value(key, value, depth + 1, nodes)?;
            }
            Ok(())
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => Ok(()),
    }
}

fn parse_response<R: DeserializeOwned>(expected_id: &str, source: &[u8]) -> StorageResult<R> {
    let value: Value = serde_json::from_slice(source).map_err(|_| StorageError::protocol())?;
    let object = value.as_object().ok_or_else(StorageError::protocol)?;
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || object.get("id").and_then(Value::as_str) != Some(expected_id)
    {
        return Err(StorageError::protocol());
    }
    if object.contains_key("error") {
        // Plugin messages are untrusted and can contain provider response
        // bodies/secrets.  Surface only the stable protocol classification.
        return Err(StorageError::new(StorageErrorCode::Protocol));
    }
    let result = object.get("result").ok_or_else(StorageError::protocol)?;
    serde_json::from_value(result.clone()).map_err(|_| StorageError::protocol())
}

#[async_trait]
impl StorageProvider for PluginProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Plugin
    }

    async fn probe(&self) -> StorageResult<ProviderCapabilities> {
        let reported: ProviderCapabilities = self.rpc("storage/probe", json!({})).await?;
        // A plugin cannot claim capabilities not declared in its reviewed
        // manifest. This keeps a post-install binary update from expanding
        // permissions without a new manifest review.
        Ok(ProviderCapabilities {
            conditional_write: reported.conditional_write
                && self.manifest.capabilities.conditional_write,
            incremental_changes: reported.incremental_changes
                && self.manifest.capabilities.incremental_changes,
            atomic_move: reported.atomic_move && self.manifest.capabilities.atomic_move,
            version_history: reported.version_history && self.manifest.capabilities.version_history,
            stable_file_id: reported.stable_file_id && self.manifest.capabilities.stable_file_id,
            case_sensitive: reported.case_sensitive && self.manifest.capabilities.case_sensitive,
            max_object_size: match (
                reported.max_object_size,
                self.manifest.capabilities.max_object_size,
            ) {
                (Some(reported), Some(manifest)) => Some(reported.min(manifest)),
                (Some(reported), None) => Some(reported.min(MAX_PLUGIN_TRANSFER_BYTES)),
                (None, Some(manifest)) => Some(manifest.min(MAX_PLUGIN_TRANSFER_BYTES)),
                (None, None) => Some(MAX_PLUGIN_TRANSFER_BYTES),
            },
        })
    }

    async fn list(&self, path: &RemotePath) -> StorageResult<Vec<RemoteEntry>> {
        self.rpc("storage/list", json!({"path": path})).await
    }

    async fn read(&self, path: &RemotePath) -> StorageResult<RemoteContent> {
        let transfer = TransferDirectory::new()?;
        let output_path = transfer.output_path();
        let response: TransferReadResponse = self
            .rpc(
                "storage/read",
                json!({"path": path, "transfer": {"outputPath": output_path}}),
            )
            .await?;
        validate_transfer_output(&output_path, self.transfer_limit())?;
        let bytes = tokio::fs::read(output_path)
            .await
            .map_err(|_| StorageError::new(StorageErrorCode::Protocol))?;
        Ok(RemoteContent {
            bytes,
            version: response.version,
        })
    }

    async fn write(&self, request: ConditionalWrite) -> StorageResult<RemoteVersion> {
        if matches!(&request.precondition, super::WritePrecondition::None) {
            return Err(StorageError::new(StorageErrorCode::InvalidConfig));
        }
        if request.bytes.len() as u64 > self.transfer_limit() {
            return Err(StorageError::new(StorageErrorCode::InvalidConfig));
        }
        let transfer = TransferDirectory::new()?;
        let input_path = transfer.input_path();
        tokio::fs::write(&input_path, request.bytes)
            .await
            .map_err(|_| StorageError::new(StorageErrorCode::Io))?;
        self.rpc(
            "storage/write",
            json!({
                "path": request.path,
                "precondition": request.precondition,
                "transfer": {"inputPath": input_path},
            }),
        )
        .await
    }

    async fn create_dir(&self, path: &RemotePath) -> StorageResult<RemoteVersion> {
        self.rpc("storage/createDir", json!({"path": path})).await
    }

    async fn move_entry(&self, request: ConditionalMove) -> StorageResult<RemoteVersion> {
        self.rpc(
            "storage/move",
            serde_json::to_value(request).map_err(|_| StorageError::protocol())?,
        )
        .await
    }

    async fn delete(&self, request: ConditionalDelete) -> StorageResult<()> {
        self.rpc(
            "storage/delete",
            serde_json::to_value(request).map_err(|_| StorageError::protocol())?,
        )
        .await
    }

    async fn changes(&self, cursor: Option<&str>) -> StorageResult<ChangePage> {
        self.rpc("storage/changes", json!({"cursor": cursor})).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_request_includes_no_secret_unless_configured() {
        let value: Value = serde_json::from_slice(
            &PluginProvider {
                manifest: StoragePluginManifest {
                    manifest_version: 1,
                    id: "test".into(),
                    display_name: "Test".into(),
                    version: "1.0.0".into(),
                    protocol_version: 1,
                    executable: PathBuf::from("test"),
                    arguments: vec![],
                    capabilities: ProviderCapabilities::default(),
                },
                executable: PathBuf::from("test"),
                plugin_directory: PathBuf::from("."),
                credential: None,
                configuration: Map::new(),
                timeout: DEFAULT_TIMEOUT,
            }
            .request_value("request", "storage/probe", json!({}))
            .unwrap(),
        )
        .unwrap();
        assert!(value["params"].get("credential").is_none());
        assert_eq!(value["jsonrpc"], "2.0");
    }

    #[test]
    fn protocol_rejects_plugin_error_text_and_mismatched_id() {
        let error = br#"{"jsonrpc":"2.0","id":"right","error":{"message":"token=secret"}}"#;
        assert_eq!(
            parse_response::<Value>("right", error).unwrap_err().code,
            StorageErrorCode::Protocol
        );
        let mismatch = br#"{"jsonrpc":"2.0","id":"wrong","result":{}}"#;
        assert_eq!(
            parse_response::<Value>("right", mismatch).unwrap_err().code,
            StorageErrorCode::Protocol
        );
    }

    #[test]
    fn allowlist_is_canonical_and_refuses_escape() {
        let directory = tempfile::tempdir().unwrap();
        let allowed = directory.path().join("allowed");
        let outside = directory.path().join("outside");
        std::fs::create_dir_all(&allowed).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let manifest = allowed.join("storage-plugin.json");
        std::fs::write(&manifest, r#"{"manifestVersion":1,"id":"test","displayName":"Test","version":"1.0.0","protocolVersion":1,"executable":"../outside/nope","capabilities":{"conditionalWrite":false,"incrementalChanges":false,"atomicMove":false,"versionHistory":false,"stableFileId":false,"caseSensitive":true}}"#).unwrap();
        let list = PluginAllowlist::new(vec![allowed]).unwrap();
        assert_eq!(
            PluginProvider::load(manifest, &list).unwrap_err().code,
            StorageErrorCode::InvalidConfig
        );
    }

    #[test]
    fn checked_loader_requires_manifest_id_to_match_selected_directory() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("storage-plugins");
        let selected = root.join("selected-plugin");
        std::fs::create_dir_all(&selected).unwrap();
        std::fs::write(selected.join("provider.exe"), b"trusted plugin binary").unwrap();
        std::fs::write(
            selected.join("storage-plugin.json"),
            r#"{"manifestVersion":1,"id":"other-plugin","displayName":"Other","version":"1.0.0","protocolVersion":1,"executable":"provider.exe","capabilities":{"conditionalWrite":false,"incrementalChanges":false,"atomicMove":false,"versionHistory":false,"stableFileId":false,"caseSensitive":true}}"#,
        )
        .unwrap();
        let allowlist = PluginAllowlist::new(vec![root]).unwrap();

        assert_eq!(
            PluginProvider::load_from_plugin_directory(&selected, &allowlist)
                .unwrap_err()
                .code,
            StorageErrorCode::InvalidConfig
        );
    }

    #[test]
    fn plugin_configuration_is_bounded_and_never_accepts_nested_secrets() {
        let valid =
            serde_json::json!({"endpoint":"https://cloud.example.test", "account":{"id":"alice"}})
                .as_object()
                .unwrap()
                .clone();
        assert!(validate_plugin_configuration(&valid).is_ok());
        let secret = serde_json::json!({"account":{"token":"do-not-store"}})
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(
            validate_plugin_configuration(&secret).unwrap_err().code,
            StorageErrorCode::InvalidConfig
        );
        for key in ["accessToken", "client_secret", "private-key", "apiKey"] {
            let secret = serde_json::json!({key:"do-not-store"})
                .as_object()
                .unwrap()
                .clone();
            assert_eq!(
                validate_plugin_configuration(&secret).unwrap_err().code,
                StorageErrorCode::InvalidConfig
            );
        }
    }
}
