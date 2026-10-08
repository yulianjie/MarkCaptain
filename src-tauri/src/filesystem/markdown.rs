//! Markdown file I/O — equivalent to `upstream/src/main/filesystem/markdown.js`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::fs;

use crate::error::AppResult;
use crate::filesystem::{atomic_write, encoding};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedDocument {
    pub path: PathBuf,
    pub markdown: String,
    pub encoding: String,
    pub line_ending: String,
    pub had_decode_errors: bool,
    pub bom: bool,
}

pub async fn read_markdown(path: impl AsRef<Path>) -> AppResult<LoadedDocument> {
    read_markdown_with_options(path, true, "utf8").await
}

pub async fn read_markdown_with_options(
    path: impl AsRef<Path>,
    auto_guess_encoding: bool,
    default_encoding: &str,
) -> AppResult<LoadedDocument> {
    let path = path.as_ref().to_path_buf();
    let bytes = fs::read(&path).await?;
    let bom = encoding::detect_bom(&bytes).is_some();
    let (text, encoding_name, had_errors) = if auto_guess_encoding {
        encoding::detect_and_decode(&bytes)?
    } else {
        encoding::decode(&bytes, default_encoding)?
    };
    let line_ending = encoding::detect_line_ending(&text).to_string();
    Ok(LoadedDocument {
        path,
        markdown: text,
        encoding: encoding_name.to_string(),
        line_ending,
        had_decode_errors: had_errors,
        bom,
    })
}

pub async fn write_markdown(
    path: impl AsRef<Path>,
    markdown: &str,
    encoding_name: &str,
    line_ending: &str,
) -> AppResult<()> {
    write_markdown_with_options(path, markdown, encoding_name, line_ending, None).await
}

/// Save Markdown using an atomic whole-file replacement. When `bom` is
/// omitted, an existing Unicode BOM is preserved; new files remain BOM-less.
/// Explicit `true` adds the target encoding's BOM and rejects legacy encodings.
pub async fn write_markdown_with_options(
    path: impl AsRef<Path>,
    markdown: &str,
    encoding_name: &str,
    line_ending: &str,
    bom: Option<bool>,
) -> AppResult<()> {
    let path = path.as_ref().to_path_buf();
    let normalized = match line_ending {
        "crlf" => markdown.replace("\r\n", "\n").replace('\n', "\r\n"),
        _ => markdown.replace("\r\n", "\n"),
    };
    let existing_bom = match fs::read(&path).await {
        Ok(bytes) => encoding::detect_bom(&bytes).is_some(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    let target_bom = match bom {
        Some(true) => Some(encoding::bom_for_label(encoding_name).ok_or_else(|| {
            crate::error::AppError::InvalidArgument(format!(
                "encoding {encoding_name} does not support a Unicode BOM"
            ))
        })?),
        Some(false) => None,
        None if existing_bom => encoding::bom_for_label(encoding_name),
        None => None,
    };

    let encoded = encoding::encode(&normalized, encoding_name)?;
    let mut bytes = Vec::with_capacity(
        encoded.len() + target_bom.map_or(0, |byte_order_mark| byte_order_mark.bytes().len()),
    );
    if let Some(byte_order_mark) = target_bom {
        bytes.extend_from_slice(byte_order_mark.bytes());
    }
    bytes.extend_from_slice(&encoded);

    atomic_write::write_async(path, bytes).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;

    use crate::filesystem::encoding::{self, Bom};

    use super::*;

    #[test]
    fn loaded_document_serializes_camel_case_status_fields() {
        let value = serde_json::to_value(LoadedDocument {
            path: "note.md".into(),
            markdown: "hello".into(),
            encoding: "UTF-8".into(),
            line_ending: "crlf".into(),
            had_decode_errors: false,
            bom: true,
        })
        .unwrap();
        assert_eq!(value["lineEnding"], json!("crlf"));
        assert_eq!(value["hadDecodeErrors"], json!(false));
        assert_eq!(value["bom"], json!(true));
        assert!(value.get("line_ending").is_none());
    }

    #[tokio::test]
    async fn save_preserves_existing_bom_unless_explicitly_disabled() {
        let root =
            std::env::temp_dir().join(format!("markcaptain-markdown-bom-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("note.md");
        let mut original = Bom::Utf8.bytes().to_vec();
        original.extend_from_slice(b"old");
        fs::write(&path, original).unwrap();

        write_markdown_with_options(&path, "new", "utf8", "lf", None)
            .await
            .unwrap();
        let preserved = fs::read(&path).unwrap();
        assert_eq!(encoding::detect_bom(&preserved), Some(Bom::Utf8));
        assert_eq!(detect_and_decode_text(&preserved), "new");

        write_markdown_with_options(&path, "plain", "utf8", "lf", Some(false))
            .await
            .unwrap();
        let without_bom = fs::read(&path).unwrap();
        assert_eq!(encoding::detect_bom(&without_bom), None);
        assert_eq!(without_bom, b"plain");
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn save_can_add_utf16_bom_and_read_reports_it() {
        let root = std::env::temp_dir().join(format!(
            "markcaptain-markdown-utf16-bom-{}",
            uuid::Uuid::new_v4()
        ));
        let path = root.join("nested").join("note.md");

        write_markdown_with_options(&path, "hello 😀", "utf16le", "lf", Some(true))
            .await
            .unwrap();

        let bytes = fs::read(&path).unwrap();
        assert_eq!(encoding::detect_bom(&bytes), Some(Bom::Utf16Le));
        let loaded = read_markdown(&path).await.unwrap();
        assert_eq!(loaded.markdown, "hello 😀");
        assert_eq!(loaded.encoding, "UTF-16LE");
        assert!(loaded.bom);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn encoding_failure_leaves_existing_document_untouched() {
        let root = std::env::temp_dir().join(format!(
            "markcaptain-markdown-encode-failure-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("note.md");
        fs::write(&path, b"original").unwrap();

        let result = write_markdown_with_options(&path, "中文", "ascii", "lf", None).await;

        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original");
        fs::remove_dir_all(root).unwrap();
    }

    fn detect_and_decode_text(bytes: &[u8]) -> String {
        encoding::detect_and_decode(bytes).unwrap().0
    }
}
