//! Image upload commands — local copy, GitHub upload, Unsplash search.

use std::path::{Component, Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSaveArgs {
    pub source_path: Option<PathBuf>,
    pub data_url: Option<String>,
    pub target_dir: PathBuf,
    pub filename: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSaveResult {
    pub path: PathBuf,
}

#[tauri::command]
pub async fn cmd_save_image_local(args: LocalSaveArgs) -> AppResult<LocalSaveResult> {
    validate_filename(&args.filename)?;
    let target = args.target_dir.join(&args.filename);
    let bytes = if let Some(src) = args.source_path {
        tokio::fs::read(&src).await?
    } else if let Some(data_url) = args.data_url {
        decode_data_url(&data_url)?
    } else {
        return Err(AppError::InvalidArgument(
            "either source_path or data_url is required".into(),
        ));
    };
    crate::filesystem::atomic_write::write_async(target.clone(), bytes).await?;
    Ok(LocalSaveResult { path: target })
}

fn validate_filename(filename: &str) -> AppResult<()> {
    let mut components = Path::new(filename).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => Ok(()),
        _ => Err(AppError::InvalidArgument(
            "image filename must be a single path component".into(),
        )),
    }
}

fn decode_data_url(data_url: &str) -> AppResult<Vec<u8>> {
    let (metadata, payload) = data_url
        .split_once(',')
        .ok_or_else(|| AppError::InvalidArgument("malformed data url".into()))?;
    if !metadata.starts_with("data:")
        || !metadata
            .split(';')
            .skip(1)
            .any(|part| part.eq_ignore_ascii_case("base64"))
    {
        return Err(AppError::InvalidArgument(
            "image data url must contain a base64 payload".into(),
        ));
    }
    base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|error| AppError::InvalidArgument(format!("invalid base64 payload: {error}")))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubUploadArgs {
    pub token: String,
    pub owner: String,
    pub repo: String,
    pub branch: Option<String>,
    pub path: String,
    pub content_base64: String,
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubUploadResult {
    pub download_url: String,
    pub sha: String,
}

#[tauri::command]
pub async fn cmd_upload_image_github(args: GithubUploadArgs) -> AppResult<GithubUploadResult> {
    let client = reqwest::Client::new();
    let url = format!(
        "https://api.github.com/repos/{}/{}/contents/{}",
        args.owner, args.repo, args.path
    );
    let body = serde_json::json!({
        "message": args.message.unwrap_or_else(|| "upload from markcaptain".into()),
        "content": args.content_base64,
        "branch": args.branch,
    });
    let resp = client
        .put(&url)
        .bearer_auth(&args.token)
        .header("User-Agent", "markcaptain")
        .json(&body)
        .send()
        .await?
        .error_for_status()?;
    let v: serde_json::Value = resp.json().await?;
    let download_url = v
        .pointer("/content/download_url")
        .and_then(|s| s.as_str())
        .ok_or_else(|| AppError::Other("missing download_url".into()))?
        .to_string();
    let sha = v
        .pointer("/content/sha")
        .and_then(|s| s.as_str())
        .unwrap_or_default()
        .to_string();
    Ok(GithubUploadResult { download_url, sha })
}

/// PicGo upload — calls a PicGo CLI binary with one or more image paths.
/// The user configures the binary path in preferences (`picgoPath`); a
/// missing or empty value defaults to `picgo` on the PATH.
///
/// PicGo prints uploaded URLs to stdout, one per line. We collect those and
/// hand them back to the renderer. Exit code != 0 (or empty stdout) is
/// reported as an upload failure.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PicgoUploadArgs {
    pub binary: Option<String>,
    pub source_paths: Vec<PathBuf>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PicgoUploadResult {
    pub urls: Vec<String>,
}

#[tauri::command]
pub async fn cmd_upload_image_picgo(args: PicgoUploadArgs) -> AppResult<PicgoUploadResult> {
    if args.source_paths.is_empty() {
        return Err(AppError::InvalidArgument("no source paths".into()));
    }
    let binary = match args.binary {
        Some(s) if !s.trim().is_empty() => s,
        _ => "picgo".to_string(),
    };
    let mut cmd = tokio::process::Command::new(&binary);
    cmd.arg("upload");
    for p in &args.source_paths {
        cmd.arg(p);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| AppError::Other(format!("failed to spawn picgo: {e}")))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(AppError::Other(format!(
            "picgo exited with {:?}: {}",
            output.status.code(),
            err
        )));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let urls: Vec<String> = stdout
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| l.starts_with("http://") || l.starts_with("https://"))
        .collect();
    if urls.is_empty() {
        return Err(AppError::Other(format!(
            "picgo produced no URLs (stdout: {stdout})"
        )));
    }
    Ok(PicgoUploadResult { urls })
}

/// Custom-script upload — runs the user's shell script (or executable) with
/// the image paths as positional args. Same contract as PicGo: URLs on
/// stdout, one per line. The user supplies the executable path through the
/// `cliScript` preference.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptUploadArgs {
    pub script: String,
    pub source_paths: Vec<PathBuf>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptUploadResult {
    pub urls: Vec<String>,
}

#[tauri::command]
pub async fn cmd_upload_image_script(args: ScriptUploadArgs) -> AppResult<ScriptUploadResult> {
    if args.script.trim().is_empty() {
        return Err(AppError::InvalidArgument("script path is empty".into()));
    }
    if args.source_paths.is_empty() {
        return Err(AppError::InvalidArgument("no source paths".into()));
    }
    let mut cmd = tokio::process::Command::new(&args.script);
    for p in &args.source_paths {
        cmd.arg(p);
    }
    let output = cmd
        .output()
        .await
        .map_err(|e| AppError::Other(format!("failed to spawn upload script: {e}")))?;
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(AppError::Other(format!(
            "upload script exited with {:?}: {}",
            output.status.code(),
            err
        )));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let urls: Vec<String> = stdout
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    if urls.is_empty() {
        return Err(AppError::Other(format!(
            "upload script produced no URLs (stdout: {stdout})"
        )));
    }
    Ok(ScriptUploadResult { urls })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsplashSearchArgs {
    pub query: String,
    pub page: Option<u32>,
    pub per_page: Option<u32>,
    pub access_key: String,
}

#[tauri::command]
pub async fn cmd_search_unsplash(args: UnsplashSearchArgs) -> AppResult<serde_json::Value> {
    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.unsplash.com/search/photos")
        .query(&[
            ("query", args.query.as_str()),
            ("page", &args.page.unwrap_or(1).to_string()),
            ("per_page", &args.per_page.unwrap_or(20).to_string()),
        ])
        .header("Authorization", format!("Client-ID {}", args.access_key))
        .send()
        .await?
        .error_for_status()?;
    Ok(resp.json().await?)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn image_request_dtos_accept_camel_case() {
        let local: LocalSaveArgs = serde_json::from_value(json!({
            "sourcePath": "source.png",
            "dataUrl": null,
            "targetDir": "assets",
            "filename": "image.png"
        }))
        .unwrap();
        assert_eq!(local.source_path, Some(PathBuf::from("source.png")));
        assert_eq!(local.target_dir, PathBuf::from("assets"));

        let github: GithubUploadArgs = serde_json::from_value(json!({
            "token": "token",
            "owner": "owner",
            "repo": "repo",
            "path": "image.png",
            "contentBase64": "AA=="
        }))
        .unwrap();
        assert_eq!(github.content_base64, "AA==");

        let picgo: PicgoUploadArgs = serde_json::from_value(json!({
            "sourcePaths": ["one.png", "two.png"]
        }))
        .unwrap();
        assert_eq!(picgo.source_paths.len(), 2);

        let script: ScriptUploadArgs = serde_json::from_value(json!({
            "script": "upload.cmd",
            "sourcePaths": ["one.png"]
        }))
        .unwrap();
        assert_eq!(script.source_paths, vec![PathBuf::from("one.png")]);

        let unsplash: UnsplashSearchArgs = serde_json::from_value(json!({
            "query": "mountain",
            "perPage": 10,
            "accessKey": "key"
        }))
        .unwrap();
        assert_eq!(unsplash.per_page, Some(10));
        assert_eq!(unsplash.access_key, "key");
    }

    #[test]
    fn image_results_serialize_camel_case() {
        let result = GithubUploadResult {
            download_url: "https://example.invalid/image.png".into(),
            sha: "abc".into(),
        };
        let value = serde_json::to_value(result).unwrap();
        assert_eq!(
            value["downloadUrl"],
            json!("https://example.invalid/image.png")
        );
        assert!(value.get("download_url").is_none());
    }

    #[test]
    fn data_url_decoder_rejects_truncated_or_malformed_padding() {
        assert_eq!(
            decode_data_url("data:image/png;base64,AA==").unwrap(),
            vec![0]
        );
        for malformed in [
            "data:image/png,AA==",
            "data:image/png;base64,A",
            "data:image/png;base64,AA=A",
            "not-data:image/png;base64,AA==",
        ] {
            assert!(decode_data_url(malformed).is_err(), "{malformed}");
        }
    }
}
