//! Client for the private MarkCaptain Sync service.
//!
//! The service intentionally exposes workspace-relative paths at this layer:
//! stable entry ids and revision storage remain a server implementation detail.
//! Every mutation carries an opaque revision precondition where one exists.

use super::{
    ChangePage, ConditionalDelete, ConditionalMove, ConditionalWrite, ProviderCapabilities,
    ProviderKind, RemoteContent, RemoteEntry, RemotePath, RemoteVersion, SecretString,
    StorageError, StorageErrorCode, StorageProvider, StorageResult, WritePrecondition,
};
use async_trait::async_trait;
use reqwest::{header, Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;

const MAX_CONTENT_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelfHostedConfig {
    /// API origin, e.g. `https://sync.example.test`. Credentials in URLs are
    /// prohibited. HTTP is accepted only on loopback for a local test server.
    pub base_url: String,
    pub workspace_id: String,
}

impl SelfHostedConfig {
    pub fn validate(&self) -> StorageResult<Url> {
        if self.workspace_id.is_empty()
            || self.workspace_id.len() > 128
            || !self
                .workspace_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        {
            return Err(StorageError::invalid_config());
        }
        let url = Url::parse(self.base_url.trim()).map_err(|_| StorageError::invalid_config())?;
        let loopback = url.host_str().is_some_and(|host| {
            host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1"
        });
        if (!matches!(url.scheme(), "https") && !(url.scheme() == "http" && loopback))
            || url.host().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path() != "/"
        {
            return Err(StorageError::invalid_config());
        }
        Ok(url)
    }
}

pub struct SelfHostedProvider {
    base_url: Url,
    workspace_id: String,
    token: SecretString,
    client: reqwest::Client,
}

impl std::fmt::Debug for SelfHostedProvider {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SelfHostedProvider")
            .field("base_url", &self.base_url)
            .field("workspace_id", &self.workspace_id)
            .field("token", &"[redacted]")
            .finish()
    }
}

impl SelfHostedProvider {
    pub fn new(config: SelfHostedConfig, token: SecretString) -> StorageResult<Self> {
        let base_url = config.validate()?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(45))
            .build()
            .map_err(|_| StorageError::new(StorageErrorCode::Unavailable))?;
        Ok(Self {
            base_url,
            workspace_id: config.workspace_id,
            token,
            client,
        })
    }

    fn endpoint(&self, suffix: &str) -> StorageResult<Url> {
        let prefix = format!("v1/workspaces/{}/", self.workspace_id);
        self.base_url
            .join(&format!("{prefix}{suffix}"))
            .map_err(|_| StorageError::invalid_config())
    }

    fn request(&self, method: Method, url: Url) -> reqwest::RequestBuilder {
        self.client
            .request(method, url)
            .bearer_auth(self.token.expose())
    }

    async fn send(&self, request: reqwest::RequestBuilder) -> StorageResult<reqwest::Response> {
        request.send().await.map_err(map_reqwest_error)
    }

    async fn json<T: serde::de::DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> StorageResult<T> {
        let response = self.send(request).await?;
        ensure_status(response.status())?;
        response
            .json()
            .await
            .map_err(|_| StorageError::invalid_response())
    }

    fn path_query(url: &mut Url, path: &RemotePath) {
        url.query_pairs_mut().append_pair("path", path.as_str());
    }
}

#[async_trait]
impl StorageProvider for SelfHostedProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::SelfHosted
    }

    async fn probe(&self) -> StorageResult<ProviderCapabilities> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Probe {
            capabilities: ProviderCapabilities,
        }
        let response: Probe = self
            .json(self.request(Method::GET, self.endpoint("capabilities")?))
            .await?;
        Ok(response.capabilities)
    }

    async fn list(&self, path: &RemotePath) -> StorageResult<Vec<RemoteEntry>> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Response {
            entries: Vec<RemoteEntry>,
        }
        let mut url = self.endpoint("entries")?;
        Self::path_query(&mut url, path);
        Ok(self
            .json::<Response>(self.request(Method::GET, url))
            .await?
            .entries)
    }

    async fn read(&self, path: &RemotePath) -> StorageResult<RemoteContent> {
        let mut url = self.endpoint("content")?;
        Self::path_query(&mut url, path);
        let response = self.send(self.request(Method::GET, url)).await?;
        ensure_status(response.status())?;
        if response
            .content_length()
            .is_some_and(|length| length > MAX_CONTENT_BYTES as u64)
        {
            return Err(StorageError::invalid_response());
        }
        let version = response
            .headers()
            .get("X-MarkCaptain-Revision")
            .and_then(|header| header.to_str().ok())
            .map(|value| RemoteVersion::new(value.to_owned()))
            .transpose()?;
        let bytes = response.bytes().await.map_err(map_reqwest_error)?;
        if bytes.len() > MAX_CONTENT_BYTES {
            return Err(StorageError::invalid_response());
        }
        Ok(RemoteContent {
            bytes: bytes.to_vec(),
            version,
        })
    }

    async fn write(&self, request: ConditionalWrite) -> StorageResult<RemoteVersion> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Response {
            revision: RemoteVersion,
        }
        let mut url = self.endpoint("content")?;
        Self::path_query(&mut url, &request.path);
        if matches!(&request.precondition, WritePrecondition::None) {
            return Err(StorageError::new(StorageErrorCode::InvalidConfig));
        }
        if request.bytes.len() > MAX_CONTENT_BYTES {
            return Err(StorageError::new(StorageErrorCode::InvalidConfig));
        }
        let mut builder = self.request(Method::PUT, url).body(request.bytes);
        builder = match request.precondition {
            WritePrecondition::Match(version) => builder.header(header::IF_MATCH, version.opaque),
            WritePrecondition::Missing => builder.header(header::IF_NONE_MATCH, "*"),
            WritePrecondition::None => unreachable!("checked above"),
        };
        Ok(self.json::<Response>(builder).await?.revision)
    }

    async fn create_dir(&self, path: &RemotePath) -> StorageResult<RemoteVersion> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Response {
            revision: RemoteVersion,
        }
        let response: Response = self
            .json(
                self.request(Method::POST, self.endpoint("directories")?)
                    .header(header::IF_NONE_MATCH, "*")
                    .json(&json!({"path": path})),
            )
            .await?;
        Ok(response.revision)
    }

    async fn move_entry(&self, request: ConditionalMove) -> StorageResult<RemoteVersion> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Response {
            revision: RemoteVersion,
        }
        let response: Response = self
            .json(
                self.request(Method::POST, self.endpoint("moves")?)
                    .json(&request),
            )
            .await?;
        Ok(response.revision)
    }

    async fn delete(&self, request: ConditionalDelete) -> StorageResult<()> {
        let mut url = self.endpoint("content")?;
        Self::path_query(&mut url, &request.path);
        let mut builder = self.request(Method::DELETE, url);
        if let Some(version) = request.expected {
            builder = builder.header(header::IF_MATCH, version.opaque);
        }
        let response = self.send(builder).await?;
        ensure_status(response.status())
    }

    async fn changes(&self, cursor: Option<&str>) -> StorageResult<ChangePage> {
        let mut url = self.endpoint("changes")?;
        if let Some(cursor) = cursor {
            if cursor.len() > 4096 || cursor.chars().any(char::is_control) {
                return Err(StorageError::invalid_config());
            }
            url.query_pairs_mut().append_pair("cursor", cursor);
        }
        self.json(self.request(Method::GET, url)).await
    }
}

fn map_reqwest_error(error: reqwest::Error) -> StorageError {
    if error.is_timeout() {
        StorageError::new(StorageErrorCode::Timeout)
    } else if error.is_connect() || error.is_request() {
        StorageError::new(StorageErrorCode::Unavailable)
    } else {
        StorageError::invalid_response()
    }
}

fn ensure_status(status: StatusCode) -> StorageResult<()> {
    if status.is_success() {
        return Ok(());
    }
    Err(match status.as_u16() {
        401 => StorageError::new(StorageErrorCode::Unauthorized),
        403 => StorageError::new(StorageErrorCode::Forbidden),
        404 => StorageError::new(StorageErrorCode::NotFound),
        409 | 412 => StorageError::new(StorageErrorCode::Conflict),
        408 | 504 => StorageError::new(StorageErrorCode::Timeout),
        429 | 500..=599 => StorageError::new(StorageErrorCode::Unavailable),
        _ => StorageError::invalid_response(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn self_hosted_config_requires_safe_origin_and_workspace() {
        assert!(SelfHostedConfig {
            base_url: "https://sync.example.test".into(),
            workspace_id: "notes-1".into()
        }
        .validate()
        .is_ok());
        assert_eq!(
            SelfHostedConfig {
                base_url: "https://token@example.test".into(),
                workspace_id: "notes".into()
            }
            .validate()
            .unwrap_err()
            .code,
            StorageErrorCode::InvalidConfig
        );
        assert_eq!(
            SelfHostedConfig {
                base_url: "https://sync.example.test".into(),
                workspace_id: "../notes".into()
            }
            .validate()
            .unwrap_err()
            .code,
            StorageErrorCode::InvalidConfig
        );
    }

    #[tokio::test]
    async fn directory_creation_is_create_only() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buffer = [0u8; 1024];
            loop {
                let count = stream.read(&mut buffer).await.unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..count]);
                if request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let body = r#"{"revision":{"opaque":"dir-v1"}}"#;
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            request
        });
        let provider = SelfHostedProvider::new(
            SelfHostedConfig {
                base_url: format!("http://{address}"),
                workspace_id: "notes".into(),
            },
            SecretString::new("test-token").unwrap(),
        )
        .unwrap();

        provider
            .create_dir(&RemotePath::new("folder").unwrap())
            .await
            .unwrap();

        let request = String::from_utf8(server.await.unwrap()).unwrap();
        assert!(request.starts_with("POST /v1/workspaces/notes/directories HTTP/1.1"));
        assert!(
            request.contains("if-none-match: *") || request.contains("If-None-Match: *"),
            "request: {request}"
        );
    }

    #[test]
    fn self_hosted_entries_accept_transition_id_and_canonical_remote_id() {
        let canonical: RemoteEntry = serde_json::from_str(
            r#"{"path":"note.md","kind":"file","version":{"opaque":"v1"},"remoteId":"entry-1","contentHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":1}"#,
        )
        .unwrap();
        assert_eq!(canonical.remote_id.unwrap().opaque, "entry-1");
        assert_eq!(
            canonical.content_hash.unwrap().as_str(),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );

        let transition: RemoteEntry = serde_json::from_str(
            r#"{"path":"note.md","kind":"file","version":{"opaque":"v1"},"id":"entry-2"}"#,
        )
        .unwrap();
        assert_eq!(transition.remote_id.unwrap().opaque, "entry-2");
    }
}
