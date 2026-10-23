//! Read-only disk-version checks for already authorized Markdown documents.
use crate::{
    app::{is_markdown_document, AppState},
    error::{AppError, AppResult},
    filesystem::encoding,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::PathBuf,
};

const MAX_DOCUMENT: usize = 2_000_000;
const MAX_TOTAL: usize = 4_000_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDocumentVersion {
    path: PathBuf,
    fingerprint: Option<String>,
    content_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn invalid(code: &str) -> AppError {
    AppError::InvalidArgument(format!("agent:{code}"))
}

fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn versions_with_encodings(
    state: &AppState,
    paths: Vec<PathBuf>,
    encodings: HashMap<PathBuf, String>,
) -> AppResult<Vec<AgentDocumentVersion>> {
    if paths.is_empty() || paths.len() > 8 {
        return Err(invalid("documentVersionLimit"));
    }
    // Labels only choose how already-authorized bytes are decoded. They never
    // add source paths, and unrelated or unbounded options fail before reads.
    if encodings.len() > 8
        || encodings
            .iter()
            .any(|(path, label)| !paths.contains(path) || label.is_empty() || label.len() > 80)
    {
        return Err(invalid("documentVersionScope"));
    }
    let mut unique = HashSet::new();
    let mut sources = Vec::new();
    // Authorize the complete input before reading any body. A failed probe grants nothing.
    for path in paths {
        if !path.is_absolute() || path.as_os_str().len() > 8192 || !is_markdown_document(&path) {
            return Err(invalid("documentVersionScope"));
        }
        let source_encoding = encodings.get(&path).cloned();
        let canonical = std::fs::canonicalize(&path).ok();
        let resolved = canonical.clone().unwrap_or(path);
        let key = if cfg!(windows) {
            resolved.to_string_lossy().to_lowercase()
        } else {
            resolved.to_string_lossy().into_owned()
        };
        if !unique.insert(key) {
            return Err(invalid("documentVersionLimit"));
        }
        if canonical.is_some() && !state.is_document_source_authorized(&resolved) {
            return Err(invalid("documentVersionScope"));
        }
        sources.push((resolved, canonical.is_some(), source_encoding));
    }
    let mut total_raw = 0usize;
    let mut total_decoded = 0usize;
    let mut results = Vec::new();
    for (path, exists, source_encoding) in sources {
        let mut result = AgentDocumentVersion {
            path: path.clone(),
            fingerprint: None,
            content_hash: None,
            error: None,
        };
        if !exists {
            result.error = Some("agent:documentUnavailable".into());
            results.push(result);
            continue;
        }
        let mut read_limit_exceeded = false;
        let read = (|| -> Result<Vec<u8>, ()> {
            if !state.is_document_source_authorized(&path) {
                return Err(());
            }
            let file = std::fs::File::open(&path).map_err(|_| ())?;
            if !file.metadata().map_err(|_| ())?.is_file() {
                return Err(());
            }
            let mut bytes = Vec::new();
            let read_result = file
                .take(MAX_DOCUMENT.min(MAX_TOTAL.saturating_sub(total_raw)) as u64 + 1)
                .read_to_end(&mut bytes);
            total_raw += bytes.len();
            read_limit_exceeded = bytes.len() > MAX_DOCUMENT || total_raw > MAX_TOTAL;
            read_result.map_err(|_| ())?;
            // Detect a path removed or redirected during the read.
            if std::fs::canonicalize(&path).ok().as_ref() != Some(&path)
                || !state.is_document_source_authorized(&path)
            {
                return Err(());
            }
            Ok(bytes)
        })();
        if read_limit_exceeded {
            return Err(invalid("documentVersionLimit"));
        }
        match read {
            Err(()) => result.error = Some("agent:documentUnavailable".into()),
            Ok(bytes) => match source_encoding.as_deref().map_or_else(
                || encoding::detect_and_decode(&bytes),
                |label| encoding::decode(&bytes, label),
            ) {
                Ok((markdown, _, false)) => {
                    let markdown = markdown.replace("\r\n", "\n").replace('\r', "\n");
                    total_decoded += markdown.len();
                    if markdown.len() > MAX_DOCUMENT || total_decoded > MAX_TOTAL {
                        return Err(invalid("documentVersionLimit"));
                    }
                    result.fingerprint = Some(hash(&bytes));
                    result.content_hash = Some(hash(markdown.as_bytes()));
                }
                _ => result.error = Some("agent:documentDecodeError".into()),
            },
        }
        results.push(result);
    }
    Ok(results)
}

#[tauri::command]
pub async fn cmd_agent_document_versions(
    state: tauri::State<'_, AppState>,
    paths: Vec<PathBuf>,
    encodings: Option<HashMap<PathBuf, String>>,
) -> AppResult<Vec<AgentDocumentVersion>> {
    let state = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        versions_with_encodings(&state, paths, encodings.unwrap_or_default())
    })
    .await
    .map_err(|_| invalid("documentUnavailable"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn versions(state: &AppState, paths: Vec<PathBuf>) -> AppResult<Vec<AgentDocumentVersion>> {
        versions_with_encodings(state, paths, HashMap::new())
    }

    #[test]
    fn matches_open_document_encoding_without_a_bom_and_preserves_raw_fingerprint() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::default();
        for (label, text) in [
            ("utf-16le", "# Plain\r\nHello"),
            ("windows-1251", "# Привет\r\nМир"),
        ] {
            let path = tmp.path().join(format!("{label}.md"));
            let bytes = encoding::encode(text, label).unwrap();
            assert!(encoding::detect_bom(&bytes).is_none());
            std::fs::write(&path, &bytes).unwrap();
            let labels = HashMap::from([(path.clone(), label.to_owned())]);
            assert!(versions_with_encodings(&state, vec![path.clone()], labels.clone()).is_err());
            assert!(!state.is_document_source_authorized(&path));
            state.authorize_document_source(&path).unwrap();
            let result = versions_with_encodings(&state, vec![path.clone()], labels)
                .unwrap()
                .remove(0);
            assert_eq!(
                result.content_hash,
                Some(hash(text.replace("\r\n", "\n").as_bytes()))
            );
            assert_eq!(result.fingerprint, Some(hash(&bytes)));
            assert!(result.error.is_none());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
            if label == "utf-16le" {
                assert_ne!(
                    versions(&state, vec![path]).unwrap()[0].content_hash,
                    result.content_hash
                );
            }
        }
    }

    #[test]
    fn encoding_options_do_not_expand_scope_or_allow_lossy_decoding() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("selected.md");
        std::fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();
        let state = AppState::default();
        state.authorize_document_source(&path).unwrap();
        let unrelated = tmp.path().join("unselected.md");
        assert!(versions_with_encodings(
            &state,
            vec![path.clone()],
            HashMap::from([(unrelated.clone(), "utf8".into())])
        )
        .is_err());
        assert!(!state.is_document_source_authorized(&unrelated));
        for label in ["utf-16le", "utf8", "unknown-encoding"] {
            let result = versions_with_encodings(
                &state,
                vec![path.clone()],
                HashMap::from([(path.clone(), label.into())]),
            )
            .unwrap()
            .remove(0);
            assert_eq!(result.error.as_deref(), Some("agent:documentDecodeError"));
            assert!(result.fingerprint.is_none() && result.content_hash.is_none());
        }
        std::fs::write(&path, vec![0x80; 1_000_001]).unwrap();
        assert!(versions_with_encodings(
            &state,
            vec![path.clone()],
            HashMap::from([(path, "windows-1252".into())])
        )
        .is_err());
    }

    #[test]
    fn hashes_normalized_decoded_text_and_original_bytes_without_grants_or_writes() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("中文.md");
        let original = b"\xef\xbb\xbf# Title\r\ntext\rrest\n";
        std::fs::write(&path, original).unwrap();
        let state = AppState::default();
        assert!(versions(&state, vec![path.clone()]).is_err());
        assert!(!state.is_document_source_authorized(&path));
        state.authorize_document_source(&path).unwrap();
        let first = versions(&state, vec![path.clone()]).unwrap().remove(0);
        assert_eq!(first.path, std::fs::canonicalize(&path).unwrap());
        assert_eq!(first.fingerprint.as_deref(), Some(hash(original).as_str()));
        assert_eq!(
            first.content_hash.as_deref(),
            Some(hash(b"# Title\ntext\nrest\n").as_str())
        );
        assert_eq!(std::fs::read(&path).unwrap(), original);
        std::fs::write(&path, b"# Title\ntext\nrest\n").unwrap();
        let next = versions(&state, vec![path.clone()]).unwrap().remove(0);
        assert_eq!(first.content_hash, next.content_hash);
        assert_ne!(first.fingerprint, next.fingerprint);
        std::fs::remove_file(&path).unwrap();
        let missing = versions(&state, vec![path]).unwrap().remove(0);
        assert!(missing.fingerprint.is_none() && missing.content_hash.is_none());
        assert_eq!(missing.error.as_deref(), Some("agent:documentUnavailable"));
    }

    #[test]
    fn rejects_scope_duplicates_limits_and_lossy_decoding() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("note.md");
        std::fs::write(&path, b"\xff\xfe\x00").unwrap();
        let state = AppState::default();
        state.authorize_document_source(&path).unwrap();
        let invalid_text = versions(&state, vec![path.clone()]).unwrap().remove(0);
        assert_eq!(
            invalid_text.error.as_deref(),
            Some("agent:documentDecodeError")
        );
        assert!(invalid_text.fingerprint.is_none() && invalid_text.content_hash.is_none());
        assert!(versions(&state, vec![]).is_err());
        assert!(versions(&state, vec![path.clone(); 9]).is_err());
        assert!(versions(
            &state,
            vec![path.clone(), tmp.path().join(".").join("note.md")]
        )
        .is_err());
        assert!(versions(&state, vec![PathBuf::from("note.md")]).is_err());
        assert!(versions(&state, vec![tmp.path().join("private.txt")]).is_err());
        std::fs::write(&path, vec![b'a'; MAX_DOCUMENT + 1]).unwrap();
        assert!(versions(&state, vec![path.clone()]).is_err());
        let paths = (0..3)
            .map(|i| {
                let path = tmp.path().join(format!("large-{i}.md"));
                std::fs::write(&path, vec![b'a'; 1_500_000]).unwrap();
                state.authorize_document_source(&path).unwrap();
                path
            })
            .collect();
        assert!(versions(&state, paths).is_err());
    }
}
