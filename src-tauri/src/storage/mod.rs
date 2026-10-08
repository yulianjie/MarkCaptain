//! Local-first cloud storage provider contract.
//!
//! The editor only ever works against a local workspace.  This module is the
//! narrow, renderer-independent boundary used by the sync engine to reconcile
//! that workspace with a remote provider.  Connection settings deliberately
//! contain no passwords or tokens: those are held in the operating system
//! credential store through [`CredentialStore`].

use async_trait::async_trait;
use serde::{de::Error as _, Deserialize, Deserializer, Serialize};
use std::{fmt, future::Future, pin::Pin};

pub mod git;
pub mod plugin;
pub mod self_hosted;
pub mod sync;
pub mod webdav;

pub const STORAGE_KEYRING_SERVICE: &str = "app.markcaptain.storage";

/// A provider kind is stored in normal configuration.  Secrets are never
/// embedded in this value or in [`ConnectionConfig`].
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    SelfHosted,
    Git,
    WebDav,
    Plugin,
}

/// Non-secret connection record persisted by the command layer.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionConfig {
    pub id: String,
    pub label: String,
    pub provider: ProviderKind,
    /// Provider-specific public configuration, such as an HTTPS endpoint or
    /// a plugin manifest id.  It is intentionally an object rather than a
    /// string so callers cannot accidentally persist a raw credential.
    #[serde(default)]
    pub settings: serde_json::Map<String, serde_json::Value>,
}

impl ConnectionConfig {
    pub fn validate(&self) -> StorageResult<()> {
        validate_connection_id(&self.id)?;
        if self.label.trim().is_empty()
            || self.label.len() > 120
            || self.label.chars().any(char::is_control)
        {
            return Err(StorageError::invalid_config());
        }
        if self.settings.len() > 32 {
            return Err(StorageError::invalid_config());
        }
        // Connection settings must remain metadata.  Reject common secret
        // keys rather than relying on each caller to remember this boundary.
        if self.settings.keys().any(|key| {
            matches!(
                key.to_ascii_lowercase().as_str(),
                "token" | "password" | "secret" | "apikey" | "api_key" | "authorization"
            )
        }) {
            return Err(StorageError::invalid_config());
        }
        Ok(())
    }
}

pub fn validate_connection_id(value: &str) -> StorageResult<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(StorageError::invalid_config());
    }
    Ok(())
}

/// A relative, normalized path in a remote workspace.
///
/// It never starts with `/`, contains no empty, `.` or `..` segments, and
/// cannot contain a NUL/control character.  This makes it safe to combine
/// with a local root and to encode as a WebDAV URL segment-by-segment.
#[derive(Clone, Debug, Default, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize)]
#[serde(transparent)]
pub struct RemotePath(String);

impl RemotePath {
    pub fn root() -> Self {
        Self(String::new())
    }

    pub fn new(value: impl AsRef<str>) -> StorageResult<Self> {
        let value = value.as_ref().replace('\\', "/");
        let value = value.trim_matches('/');
        if value.is_empty() {
            return Ok(Self::root());
        }
        if value.len() > 4096
            || value.split('/').any(|segment| {
                segment.is_empty()
                    || matches!(segment, "." | "..")
                    || segment
                        .chars()
                        .any(|character| character == '\0' || character.is_control())
            })
        {
            return Err(StorageError::invalid_path());
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn is_root(&self) -> bool {
        self.0.is_empty()
    }

    pub fn segments(&self) -> impl Iterator<Item = &str> {
        self.0.split('/').filter(|segment| !segment.is_empty())
    }

    pub fn join(&self, child: &str) -> StorageResult<Self> {
        let child = RemotePath::new(child)?;
        if self.is_root() {
            return Ok(child);
        }
        if child.is_root() {
            return Ok(self.clone());
        }
        Self::new(format!("{}/{}", self.0, child.0))
    }
}

impl fmt::Display for RemotePath {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(if self.is_root() { "/" } else { &self.0 })
    }
}

impl<'de> Deserialize<'de> for RemotePath {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::new(value).map_err(D::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RemoteEntryKind {
    File,
    Directory,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteVersion {
    /// WebDAV providers use the opaque ETag; self-hosted providers use their
    /// opaque revision.  Clients must never parse or synthesize this value.
    pub opaque: String,
}

impl RemoteVersion {
    pub fn new(value: impl Into<String>) -> StorageResult<Self> {
        let opaque = value.into();
        if opaque.is_empty() || opaque.len() > 4096 || opaque.chars().any(char::is_control) {
            return Err(StorageError::invalid_response());
        }
        Ok(Self { opaque })
    }
}

impl<'de> Deserialize<'de> for RemoteVersion {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Value {
            opaque: String,
        }
        Self::new(Value::deserialize(deserializer)?.opaque).map_err(D::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteEntry {
    pub path: RemotePath,
    pub kind: RemoteEntryKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<RemoteVersion>,
    /// Stable identity supplied by providers that can distinguish a deleted
    /// resource from a new resource created at the same path.  It is optional
    /// so WebDAV and v1 plugins remain wire-compatible.
    #[serde(
        default,
        alias = "id",
        alias = "entryId",
        skip_serializing_if = "Option::is_none"
    )]
    pub remote_id: Option<RemoteIdentity>,
    /// SHA-256 of the remote file bytes when the provider exposes one.  It is
    /// a second ABA guard for providers whose version values are scoped or
    /// otherwise not globally unique.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<RemoteContentHash>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// Opaque stable identity of a remotely stored entry.
///
/// This is deliberately distinct from [`RemoteVersion`]: an identity remains
/// stable across edits, while a version must change whenever bytes change.
#[derive(Clone, Debug, Default, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize)]
#[serde(transparent)]
pub struct RemoteIdentity {
    pub opaque: String,
}

impl RemoteIdentity {
    pub fn new(value: impl Into<String>) -> StorageResult<Self> {
        let opaque = value.into();
        if opaque.is_empty() || opaque.len() > 4096 || opaque.chars().any(char::is_control) {
            return Err(StorageError::invalid_response());
        }
        Ok(Self { opaque })
    }
}

impl<'de> Deserialize<'de> for RemoteIdentity {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Value {
            Opaque { opaque: String },
            Legacy(String),
        }
        let opaque = match Value::deserialize(deserializer)? {
            Value::Opaque { opaque } | Value::Legacy(opaque) => opaque,
        };
        Self::new(opaque).map_err(D::Error::custom)
    }
}

/// A lowercase hexadecimal SHA-256 content digest supplied by a provider.
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Hash, Serialize)]
#[serde(transparent)]
pub struct RemoteContentHash(String);

impl RemoteContentHash {
    pub fn new(value: impl Into<String>) -> StorageResult<Self> {
        let value = value.into();
        if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(StorageError::invalid_response());
        }
        Ok(Self(value.to_ascii_lowercase()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for RemoteContentHash {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(String::deserialize(deserializer)?).map_err(D::Error::custom)
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteContent {
    pub bytes: Vec<u8>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<RemoteVersion>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WritePrecondition {
    /// Update only if the existing opaque remote version still matches.
    Match(RemoteVersion),
    /// Create only if no remote resource exists at this path.
    Missing,
    /// An explicit compatibility escape hatch.  The sync engine never emits
    /// this variant; providers may reject it when they cannot safely write.
    None,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConditionalWrite {
    pub path: RemotePath,
    pub bytes: Vec<u8>,
    pub precondition: WritePrecondition,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConditionalMove {
    pub from: RemotePath,
    pub to: RemotePath,
    #[serde(default)]
    pub overwrite: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_source: Option<RemoteVersion>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConditionalDelete {
    pub path: RemotePath,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected: Option<RemoteVersion>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderCapabilities {
    pub conditional_write: bool,
    pub incremental_changes: bool,
    pub atomic_move: bool,
    pub version_history: bool,
    pub stable_file_id: bool,
    pub case_sensitive: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_object_size: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum ChangeKind {
    Upsert,
    Delete,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteChange {
    pub path: RemotePath,
    pub kind: ChangeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<RemoteEntry>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChangePage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default)]
    pub changes: Vec<RemoteChange>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StorageErrorCode {
    InvalidConfig,
    InvalidPath,
    InvalidResponse,
    Unauthorized,
    Forbidden,
    NotFound,
    Conflict,
    Unsupported,
    Timeout,
    Unavailable,
    Credential,
    Protocol,
    Io,
}

impl StorageErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidConfig => "invalidConfig",
            Self::InvalidPath => "invalidPath",
            Self::InvalidResponse => "invalidResponse",
            Self::Unauthorized => "unauthorized",
            Self::Forbidden => "forbidden",
            Self::NotFound => "notFound",
            Self::Conflict => "conflict",
            Self::Unsupported => "unsupported",
            Self::Timeout => "timeout",
            Self::Unavailable => "unavailable",
            Self::Credential => "credential",
            Self::Protocol => "protocol",
            Self::Io => "io",
        }
    }
}

/// Deliberately contains only a stable, presentation-safe code.  Do not put
/// request URLs, response bodies, credentials, or plugin stderr in this type.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("storage: {}", .code.as_str())]
pub struct StorageError {
    pub code: StorageErrorCode,
}

impl StorageError {
    pub const fn new(code: StorageErrorCode) -> Self {
        Self { code }
    }
    pub const fn invalid_config() -> Self {
        Self::new(StorageErrorCode::InvalidConfig)
    }
    pub const fn invalid_path() -> Self {
        Self::new(StorageErrorCode::InvalidPath)
    }
    pub const fn invalid_response() -> Self {
        Self::new(StorageErrorCode::InvalidResponse)
    }
    pub const fn unsupported() -> Self {
        Self::new(StorageErrorCode::Unsupported)
    }
    pub const fn protocol() -> Self {
        Self::new(StorageErrorCode::Protocol)
    }
}

pub type StorageResult<T> = Result<T, StorageError>;

/// A secret which is intentionally neither serializable nor printable.
pub struct SecretString(String);

impl SecretString {
    pub fn new(value: impl Into<String>) -> StorageResult<Self> {
        let value = value.into();
        if value.is_empty() || value.len() > 16 * 1024 || value.chars().any(char::is_control) {
            return Err(StorageError::invalid_config());
        }
        Ok(Self(value))
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretString([redacted])")
    }
}

/// Keyring-backed secret storage, scoped to a non-secret connection id.
pub struct CredentialStore {
    connection_id: String,
}

impl CredentialStore {
    pub fn new(connection_id: impl Into<String>) -> StorageResult<Self> {
        let connection_id = connection_id.into();
        validate_connection_id(&connection_id)?;
        Ok(Self { connection_id })
    }

    fn entry(&self) -> StorageResult<keyring::Entry> {
        keyring::Entry::new(STORAGE_KEYRING_SERVICE, &self.connection_id)
            .map_err(|_| StorageError::new(StorageErrorCode::Credential))
    }

    pub fn read(&self) -> StorageResult<Option<SecretString>> {
        match self.entry()?.get_password() {
            Ok(value) => SecretString::new(value).map(Some),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(StorageError::new(StorageErrorCode::Credential)),
        }
    }

    pub fn write(&self, secret: &SecretString) -> StorageResult<()> {
        self.entry()?
            .set_password(secret.expose())
            .map_err(|_| StorageError::new(StorageErrorCode::Credential))
    }

    pub fn delete(&self) -> StorageResult<()> {
        match self.entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(StorageError::new(StorageErrorCode::Credential)),
        }
    }
}

impl fmt::Debug for CredentialStore {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CredentialStore")
            .field("connection_id", &self.connection_id)
            .finish_non_exhaustive()
    }
}

#[async_trait]
pub trait StorageProvider: Send + Sync {
    fn kind(&self) -> ProviderKind;

    async fn probe(&self) -> StorageResult<ProviderCapabilities>;
    async fn list(&self, path: &RemotePath) -> StorageResult<Vec<RemoteEntry>>;
    async fn read(&self, path: &RemotePath) -> StorageResult<RemoteContent>;
    async fn write(&self, request: ConditionalWrite) -> StorageResult<RemoteVersion>;
    async fn create_dir(&self, path: &RemotePath) -> StorageResult<RemoteVersion>;
    async fn move_entry(&self, request: ConditionalMove) -> StorageResult<RemoteVersion>;
    async fn delete(&self, request: ConditionalDelete) -> StorageResult<()>;

    async fn changes(&self, _cursor: Option<&str>) -> StorageResult<ChangePage> {
        Err(StorageError::unsupported())
    }
}

/// Object-safe type alias used by callers that keep providers in application
/// state.  Kept here so future Git and first-party providers share exactly the
/// same boundary.
pub type DynStorageProvider = dyn StorageProvider;

/// A helper for providers that need to expose a boxed future in adapters.
pub type StorageFuture<'a, T> = Pin<Box<dyn Future<Output = StorageResult<T>> + Send + 'a>>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_paths_cannot_escape_a_workspace() {
        for invalid in ["../x", "/../x", "x//y", "x/./y", "x\\..\\y", "x\0y"] {
            assert_eq!(
                RemotePath::new(invalid).unwrap_err().code,
                StorageErrorCode::InvalidPath
            );
        }
        assert_eq!(
            RemotePath::new("notes/中文.md").unwrap().as_str(),
            "notes/中文.md"
        );
    }

    #[test]
    fn connection_config_rejects_secret_fields() {
        let config = ConnectionConfig {
            id: "webdav-primary".into(),
            label: "WebDAV".into(),
            provider: ProviderKind::WebDav,
            settings: serde_json::json!({"password":"nope"})
                .as_object()
                .unwrap()
                .clone(),
        };
        assert_eq!(
            config.validate().unwrap_err().code,
            StorageErrorCode::InvalidConfig
        );
    }

    #[test]
    fn secrets_do_not_format_as_plain_text() {
        let secret = SecretString::new("actually-secret").unwrap();
        assert!(!format!("{secret:?}").contains("actually-secret"));
    }

    #[test]
    fn remote_identity_uses_the_canonical_string_wire_shape() {
        let entry = RemoteEntry {
            path: RemotePath::new("note.md").unwrap(),
            kind: RemoteEntryKind::File,
            version: Some(RemoteVersion::new("v1").unwrap()),
            remote_id: Some(RemoteIdentity::new("entry-1").unwrap()),
            content_hash: Some(
                RemoteContentHash::new(
                    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                )
                .unwrap(),
            ),
            size: Some(1),
        };
        let value = serde_json::to_value(entry).unwrap();
        assert_eq!(value["remoteId"], "entry-1");
        assert_eq!(
            value["contentHash"],
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
    }
}
