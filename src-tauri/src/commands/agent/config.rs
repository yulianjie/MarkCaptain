//! Non-secret settings on disk; credentials are scoped to the exact API base URL
//! in the OS credential store. Neither read commands nor errors expose secrets.
use super::failure;
use crate::{error::AppResult, filesystem::atomic_write};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use reqwest::header::{HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};
use url::Url;

static CONFIG_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

#[derive(Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AuthMode {
    #[default]
    System,
    None,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub auth_mode: AuthMode,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            base_url: "https://api.deepseek.com".into(),
            model: "deepseek-flash".into(),
            auth_mode: AuthMode::System,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    #[serde(flatten)]
    settings: Settings,
    has_key: bool,
    has_headers: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomHeader {
    pub name: String,
    pub value: String,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Credentials {
    pub(super) version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub headers: Vec<CustomHeader>,
}

pub fn validate(mut settings: Settings) -> AppResult<Settings> {
    let url = Url::parse(settings.base_url.trim()).map_err(|_| failure("invalidUrl"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.as_str().len() > 2048
        || url.path().ends_with("/chat/completions")
    {
        return Err(failure("invalidUrl"));
    }
    settings.base_url = url.as_str().trim_end_matches('/').to_string();
    settings.model = settings.model.trim().to_string();
    if settings.model.is_empty()
        || settings.model.len() > 200
        || settings.model.chars().any(char::is_control)
    {
        return Err(failure("invalidModel"));
    }
    Ok(settings)
}

fn path(app: &AppHandle) -> AppResult<PathBuf> {
    Ok(app.path().app_config_dir()?.join("agent-settings.json"))
}

fn read(app: &AppHandle) -> AppResult<Settings> {
    let path = path(app)?;
    match fs::read(path) {
        Ok(bytes) => validate(serde_json::from_slice(&bytes).map_err(|_| failure("configRead"))?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Settings::default()),
        Err(_) => Err(failure("configRead")),
    }
}

fn entry(settings: &Settings) -> AppResult<keyring::Entry> {
    keyring::Entry::new("app.marktext.agent", &settings.base_url).map_err(|_| failure("keychain"))
}

fn credentials_from_secret(secret: String) -> Credentials {
    match serde_json::from_str::<Credentials>(&secret) {
        Ok(credentials) if credentials.version == 1 => credentials,
        _ => Credentials {
            version: 1,
            api_key: Some(secret),
            headers: vec![],
        },
    }
}

pub(super) fn credentials_for(settings: &Settings) -> AppResult<Credentials> {
    credentials_for_with(settings, || match entry(settings)?.get_password() {
        Ok(secret) => Ok(credentials_from_secret(secret)),
        Err(keyring::Error::NoEntry) => Ok(Credentials::default()),
        Err(_) => Err(failure("keychain")),
    })
}

fn credentials_for_with(
    settings: &Settings,
    read: impl FnOnce() -> AppResult<Credentials>,
) -> AppResult<Credentials> {
    if settings.auth_mode == AuthMode::None {
        return Ok(Credentials::default());
    }
    read()
}

fn validate_headers(headers: Vec<CustomHeader>) -> AppResult<Vec<CustomHeader>> {
    if headers.len() > 32 {
        return Err(failure("invalidHeaders"));
    }
    let blocked = [
        "connection",
        "content-length",
        "content-type",
        "host",
        "proxy-authorization",
        "proxy-connection",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
    ];
    let mut names = HashSet::new();
    let mut total = 0usize;
    let mut validated = Vec::with_capacity(headers.len());
    for header in headers {
        let name = header.name.trim().to_ascii_lowercase();
        let value = header.value.trim().to_string();
        total = total.saturating_add(name.len()).saturating_add(value.len());
        if name.is_empty()
            || value.is_empty()
            || name.len() > 128
            || value.len() > 8192
            || total > 32768
            || blocked.contains(&name.as_str())
            || !names.insert(name.clone())
            || HeaderName::from_bytes(name.as_bytes()).is_err()
            || HeaderValue::from_str(&value).is_err()
        {
            return Err(failure("invalidHeaders"));
        }
        validated.push(CustomHeader { name, value });
    }
    Ok(validated)
}

fn write_credentials(settings: &Settings, credentials: &Credentials) -> AppResult<()> {
    if settings.auth_mode == AuthMode::None {
        return Ok(());
    }
    let entry = entry(settings)?;
    if credentials.api_key.is_none() && credentials.headers.is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(failure("keychain")),
        };
    }
    let secret = serde_json::to_string(credentials).map_err(|_| failure("keychain"))?;
    entry.set_password(&secret).map_err(|_| failure("keychain"))
}

pub fn get(app: &AppHandle) -> AppResult<ConfigView> {
    let _guard = CONFIG_LOCK.lock();
    let settings = read(app)?;
    let credentials = credentials_for(&settings)?;
    Ok(ConfigView {
        settings,
        has_key: credentials.api_key.is_some(),
        has_headers: !credentials.headers.is_empty(),
    })
}

pub fn save(
    app: &AppHandle,
    settings: Settings,
    api_key: Option<String>,
    headers: Option<Vec<CustomHeader>>,
) -> AppResult<ConfigView> {
    let _guard = CONFIG_LOCK.lock();
    let settings = validate(settings)?;
    let config_path = path(app)?;
    let credentials = update_credentials_with(
        &settings,
        api_key,
        headers,
        || credentials_for(&settings),
        |credentials| write_credentials(&settings, credentials),
    )?;
    atomic_write::write(&config_path, &serde_json::to_vec_pretty(&settings)?)
        .map_err(|_| failure("configWrite"))?;
    Ok(ConfigView {
        settings,
        has_key: credentials.api_key.is_some(),
        has_headers: !credentials.headers.is_empty(),
    })
}

fn update_credentials_with(
    settings: &Settings,
    api_key: Option<String>,
    headers: Option<Vec<CustomHeader>>,
    read: impl FnOnce() -> AppResult<Credentials>,
    write: impl FnOnce(&Credentials) -> AppResult<()>,
) -> AppResult<Credentials> {
    if settings.auth_mode == AuthMode::None {
        // Reject secret input rather than silently dropping it or persisting it on disk.
        if api_key.is_some_and(|key| !key.is_empty())
            || headers.is_some_and(|headers| !headers.is_empty())
        {
            return Err(failure("noAuthCredentials"));
        }
        return Ok(Credentials::default());
    }
    let mut credentials = read()?;
    if let Some(secret) = api_key {
        if secret.len() > 4096 || secret.chars().any(char::is_control) {
            return Err(failure("invalidKey"));
        }
        if secret.trim().is_empty() {
            credentials.api_key = None;
        } else {
            credentials.api_key = Some(secret.trim().to_string());
        }
    }
    if let Some(headers) = headers {
        credentials.headers = validate_headers(headers)?;
    }
    credentials.version = 1;
    write(&credentials)?;
    Ok(credentials)
}

pub fn credentials(app: &AppHandle) -> AppResult<(Settings, Credentials)> {
    let _guard = CONFIG_LOCK.lock();
    let settings = read(app)?;
    let credentials = credentials_for(&settings)?;
    Ok((settings, credentials))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn no_auth_never_calls_an_unavailable_credential_store() {
        let settings = Settings {
            base_url: "http://localhost:11434/v1".into(),
            model: "local".into(),
            auth_mode: AuthMode::None,
        };
        let credentials =
            credentials_for_with(&settings, || panic!("credential read attempted")).unwrap();
        assert!(credentials.api_key.is_none() && credentials.headers.is_empty());
        for (key, headers) in [(None, None), (Some(String::new()), Some(vec![]))] {
            let saved = update_credentials_with(
                &settings,
                key,
                headers,
                || panic!("credential read attempted"),
                |_| panic!("credential write/delete attempted"),
            )
            .unwrap();
            assert!(saved.api_key.is_none() && saved.headers.is_empty());
        }
        let serialized = serde_json::to_value(&settings).unwrap();
        assert_eq!(
            serialized,
            serde_json::json!({"baseUrl":"http://localhost:11434/v1","model":"local","authMode":"none"})
        );
        assert!(update_credentials_with(
            &settings,
            Some("secret".into()),
            None,
            || panic!("read"),
            |_| panic!("write")
        )
        .is_err());
        assert!(update_credentials_with(
            &settings,
            None,
            Some(vec![CustomHeader {
                name: "x-key".into(),
                value: "secret".into()
            }]),
            || panic!("read"),
            |_| panic!("write")
        )
        .is_err());
    }

    #[test]
    fn authenticated_mode_fails_closed_and_old_settings_keep_it() {
        let settings: Settings = serde_json::from_value(
            serde_json::json!({"baseUrl":"https://api.deepseek.com","model":"test"}),
        )
        .unwrap();
        assert!(settings.auth_mode == AuthMode::System);
        assert!(credentials_for_with(&settings, || Err(failure("keychain"))).is_err());
        assert!(update_credentials_with(
            &settings,
            Some("secret".into()),
            None,
            || Err(failure("keychain")),
            |_| panic!("must not write after failed read")
        )
        .is_err());
        assert!(update_credentials_with(
            &settings,
            Some("secret".into()),
            None,
            || Ok(Credentials::default()),
            |_| Err(failure("keychain"))
        )
        .is_err());
        assert!(serde_json::from_value::<Settings>(
            serde_json::json!({"baseUrl":"http://localhost","model":"local","authMode":"invalid"})
        )
        .is_err());
    }

    #[test]
    fn urls_accept_http_and_https_without_embedded_secrets() {
        for base_url in [
            "https://user:pass@example.com",
            "https://a.com/?key=x",
            "https://a.com/#secret",
            "file:///tmp/api",
            "ftp://api.example.com/v1",
            "https://a.com/v1/chat/completions",
        ] {
            assert!(validate(Settings {
                base_url: base_url.into(),
                model: "model".into(),
                ..Settings::default()
            })
            .is_err());
        }
        for base_url in [
            "http://localhost:11434/v1",
            "http://127.0.0.1:11434/v1",
            "http://[::1]:11434/v1",
            "http://api.example.com/v1",
            "https://api.deepseek.com/",
        ] {
            assert!(validate(Settings {
                base_url: base_url.into(),
                model: "model".into(),
                ..Settings::default()
            })
            .is_ok());
        }
    }

    #[test]
    fn custom_headers_are_bounded_normalized_and_cannot_control_transport() {
        let headers = validate_headers(vec![
            CustomHeader {
                name: "X-Tenant-ID".into(),
                value: " tenant-1 ".into(),
            },
            CustomHeader {
                name: "Authorization".into(),
                value: "Token custom".into(),
            },
        ])
        .unwrap();
        assert_eq!(
            headers[0],
            CustomHeader {
                name: "x-tenant-id".into(),
                value: "tenant-1".into()
            }
        );
        for name in [
            "Host",
            "Content-Length",
            "Content-Type",
            "Connection",
            "Transfer-Encoding",
        ] {
            assert!(validate_headers(vec![CustomHeader {
                name: name.into(),
                value: "x".into()
            }])
            .is_err());
        }
        assert!(validate_headers(vec![
            CustomHeader {
                name: "X-Test".into(),
                value: "a".into()
            },
            CustomHeader {
                name: "x-test".into(),
                value: "b".into()
            },
        ])
        .is_err());
        assert!(validate_headers(vec![CustomHeader {
            name: "Bad Header".into(),
            value: "x".into()
        }])
        .is_err());
    }

    #[test]
    fn credential_envelope_keeps_legacy_api_keys_compatible() {
        let legacy = credentials_from_secret("sk-existing".into());
        assert_eq!(legacy.api_key.as_deref(), Some("sk-existing"));
        assert!(legacy.headers.is_empty());
        let current = credentials_from_secret(
            r#"{"version":1,"apiKey":"sk-new","headers":[{"name":"x-tenant","value":"one"}]}"#
                .into(),
        );
        assert_eq!(current.api_key.as_deref(), Some("sk-new"));
        assert_eq!(current.headers[0].name, "x-tenant");
    }
}
