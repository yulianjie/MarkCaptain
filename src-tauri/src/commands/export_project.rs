//! M1 single-document export: versioned project config, bounded resources and cancellable output.
use super::workspace::{resolve_existing_inside, resolve_open_workspace};
use crate::{
    app::AppState,
    error::{AppError, AppResult},
    filesystem::atomic_write,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use tauri::Emitter;
use tokio::{io::AsyncWriteExt, process::Command};

const MAX_CONFIG: usize = 256 * 1024;
const MAX_BODY: usize = 4 * 1024 * 1024;
const MAX_HTML: usize = 64 * 1024 * 1024;
const MAX_RESOURCE: u64 = 16 * 1024 * 1024;

static OUTPUT_GRANTS: OnceLock<Mutex<HashMap<String, std::collections::HashSet<PathBuf>>>> =
    OnceLock::new();
fn prospective_path(path: &Path) -> AppResult<PathBuf> {
    let mut current = path.to_path_buf();
    let mut suffix = Vec::new();
    while !current.exists() {
        suffix.push(
            current
                .file_name()
                .ok_or_else(|| invalid("export:invalidOutput"))?
                .to_os_string(),
        );
        if !current.pop() {
            return Err(invalid("export:invalidOutput"));
        }
    }
    let mut resolved = std::fs::canonicalize(current)?;
    for name in suffix.iter().rev() {
        resolved.push(name);
    }
    Ok(resolved)
}
fn authorize_output(root: Option<&Path>, output: &Path, window_label: &str) -> AppResult<()> {
    let output = prospective_path(output)?;
    if let Some(root) = root {
        if output_directories(root)
            .iter()
            .filter_map(|p| prospective_path(p).ok())
            .filter(|directory| directory.starts_with(root))
            .any(|dir| output.starts_with(dir))
        {
            return Ok(());
        }
    }
    let mut grants = OUTPUT_GRANTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|e| invalid(e.to_string()))?;
    if grants
        .get_mut(window_label)
        .is_some_and(|paths| paths.remove(&output))
    {
        return Ok(());
    }
    Err(invalid("export:outputNotAuthorized"))
}

static CONFIG_LOCK: Mutex<()> = Mutex::new(());
static JOBS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn invalid(message: impl Into<String>) -> AppError {
    AppError::InvalidArgument(message.into())
}
fn fingerprint(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn text<'a>(v: &'a Value, pointer: &str) -> &'a str {
    v.pointer(pointer).and_then(Value::as_str).unwrap_or("")
}
fn cancelled(flag: &AtomicBool) -> AppResult<()> {
    if flag.load(Ordering::Relaxed) {
        Err(invalid("export:cancelled"))
    } else {
        Ok(())
    }
}
fn relative(value: &str) -> AppResult<PathBuf> {
    super::notes::relative_path(value)
}

pub(crate) fn validate_config(config: &Value) -> AppResult<()> {
    if serde_json::to_vec(config)?.len() > MAX_CONFIG {
        return Err(invalid("export:configTooLarge"));
    }
    if config["schemaVersion"].as_u64() != Some(1) {
        return Err(invalid("export:unsupportedConfigVersion"));
    }
    let profiles = config["profiles"]
        .as_array()
        .ok_or_else(|| invalid("export:invalidProfiles"))?;
    if profiles.is_empty() || profiles.len() > 32 {
        return Err(invalid("export:invalidProfiles"));
    }
    let mut ids = std::collections::HashSet::new();
    for profile in profiles {
        validate_profile(profile)?;
        if !ids.insert(text(profile, "/id")) {
            return Err(invalid("export:duplicateProfile"));
        }
    }
    if !ids.contains(text(config, "/defaultProfile")) {
        return Err(invalid("export:invalidDefaultProfile"));
    }
    if let Some(plan) = config.get("projectExport") {
        validate_project_plan(plan, &ids)?;
    }
    Ok(())
}

fn validate_project_plan(
    plan: &Value,
    profiles: &std::collections::HashSet<&str>,
) -> AppResult<()> {
    if plan["schemaVersion"].as_u64() != Some(1)
        || !["batch", "book"].contains(&text(plan, "/mode"))
        || !profiles.contains(text(plan, "/profileId"))
        || !plan["overwrite"].is_boolean()
    {
        return Err(invalid("export:invalidProjectPlan"));
    }
    let title = plan["title"]
        .as_str()
        .ok_or_else(|| invalid("export:invalidProjectTitle"))?;
    if title.len() > 200 || title.chars().any(char::is_control) {
        return Err(invalid("export:invalidProjectTitle"));
    }
    let name = text(plan, "/bookFileName");
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if name.is_empty()
        || name.len() > 120
        || name.ends_with([' ', '.'])
        || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|', '{', '}'])
        || name.chars().any(char::is_control)
        || [
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ]
        .contains(&stem.as_str())
    {
        return Err(invalid("export:invalidBookFileName"));
    }
    let formats = plan["formats"]
        .as_array()
        .ok_or_else(|| invalid("export:invalidFormats"))?;
    let mut unique_formats = std::collections::HashSet::new();
    if formats.is_empty()
        || formats.len() > 5
        || formats.iter().any(|format| {
            let format = format.as_str().unwrap_or("");
            !["html", "pdf", "docx", "odt", "epub"].contains(&format)
                || !unique_formats.insert(format)
        })
    {
        return Err(invalid("export:invalidFormats"));
    }
    let chapters = plan["chapters"]
        .as_array()
        .ok_or_else(|| invalid("export:invalidChapters"))?;
    if chapters.len() > 64 {
        return Err(invalid("export:invalidChapters"));
    }
    let mut paths = std::collections::HashSet::new();
    for chapter in chapters {
        let path = text(chapter, "/path");
        let path_buf = relative(path)?;
        let identity = path_buf
            .components()
            .collect::<PathBuf>()
            .to_string_lossy()
            .replace('\\', "/");
        let identity = if cfg!(windows) {
            identity.to_lowercase()
        } else {
            identity
        };
        let title = chapter["title"]
            .as_str()
            .ok_or_else(|| invalid("export:invalidChapterTitle"))?;
        if path.len() > 1000
            || path.chars().any(char::is_control)
            || path.contains(['*', '?', '<', '>', '"', '|'])
            || !super::notes::is_note_markdown(&path_buf)
            || !paths.insert(identity)
            || title.len() > 200
            || title.chars().any(char::is_control)
            || !chapter["level"]
                .as_u64()
                .is_some_and(|level| (1..=5).contains(&level))
            || chapter.get("tabId").is_some()
            || chapter.get("markdown").is_some()
        {
            return Err(invalid("export:invalidChapter"));
        }
    }
    Ok(())
}
fn validate_profile(p: &Value) -> AppResult<()> {
    if !["system-cjk", "system-serif"].contains(&text(p, "/typography/bodyFont"))
        || text(p, "/typography/codeFont") != "system-monospace"
    {
        return Err(invalid("export:unsupportedFont"));
    }
    for key in [
        "/id",
        "/name",
        "/typography/bodyFont",
        "/typography/codeFont",
    ] {
        let value = text(p, key);
        if value.is_empty() || value.len() > 200 || value.chars().any(char::is_control) {
            return Err(invalid(format!("export:invalidField:{key}")));
        }
    }
    if !["simple-reading", "technical", "formal-report"].contains(&text(p, "/theme"))
        || text(p, "/content/mode") != "current"
        || text(p, "/content/source") != "buffer"
        || !["A4", "A5", "Letter", "Legal"].contains(&text(p, "/page/size"))
        || !["portrait", "landscape"].contains(&text(p, "/page/orientation"))
        || !["embed", "folder"].contains(&text(p, "/resources/htmlMode"))
        || !["system-print", "pandoc"].contains(&text(p, "/pdf/backend"))
    {
        return Err(invalid("export:invalidProfile"));
    }
    let formats = p["formats"]
        .as_array()
        .ok_or_else(|| invalid("export:invalidFormats"))?;
    if formats.is_empty()
        || formats.len() > 5
        || formats
            .iter()
            .any(|f| !["html", "pdf", "docx", "odt", "epub"].contains(&f.as_str().unwrap_or("")))
    {
        return Err(invalid("export:invalidFormats"));
    }
    relative(text(p, "/output/directory"))?;
    let filename = text(p, "/output/fileName");
    if filename.is_empty() || filename.len() > 180 || filename.contains(['/', '\\', ':', '\0']) {
        return Err(invalid("export:invalidFileName"));
    }
    for (pointer, min, max) in [
        ("/typography/bodySizePt", 6.0, 48.0),
        ("/typography/lineHeight", 1.0, 3.0),
        ("/toc/depth", 1.0, 6.0),
        ("/page/marginMm/top", 0.0, 80.0),
        ("/page/marginMm/right", 0.0, 80.0),
        ("/page/marginMm/bottom", 0.0, 80.0),
        ("/page/marginMm/left", 0.0, 80.0),
    ] {
        let n = p
            .pointer(pointer)
            .and_then(Value::as_f64)
            .ok_or_else(|| invalid(format!("export:invalidNumber:{pointer}")))?;
        if !n.is_finite() || n < min || n > max {
            return Err(invalid(format!("export:invalidNumber:{pointer}")));
        }
    }
    Ok(())
}
fn config_path(root: &Path, create: bool) -> AppResult<PathBuf> {
    let dir = root.join(".markcaptain");
    if create && !dir.exists() {
        std::fs::create_dir(&dir)?;
    }
    if dir.exists() {
        resolve_existing_inside(root, &dir, true)?;
    }
    let path = dir.join("export.json");
    if path.exists() {
        resolve_existing_inside(root, &path, false)?;
    }
    Ok(path)
}
pub(crate) fn read_config(root: &Path) -> AppResult<Value> {
    let path = config_path(root, false)?;
    if !path.exists() {
        return Ok(json!({"config":null,"fingerprint":null}));
    }
    if std::fs::metadata(&path)?.len() > MAX_CONFIG as u64 {
        return Err(invalid("export:configTooLarge"));
    }
    let bytes = std::fs::read(&path)?;
    let config: Value = serde_json::from_slice(&bytes)?;
    validate_config(&config)?;
    Ok(json!({"config":config,"fingerprint":fingerprint(&bytes)}))
}

pub(crate) fn output_directories(root: &Path) -> Vec<PathBuf> {
    let mut result = vec![root.join("exports")];
    if let Ok(snapshot) = read_config(root) {
        if let Some(profiles) = snapshot["config"]["profiles"].as_array() {
            for profile in profiles {
                if let Ok(path) = relative(text(profile, "/output/directory")) {
                    let output = root.join(path);
                    if !result.contains(&output) {
                        result.push(output);
                    }
                }
            }
        }
    }
    result
}

#[tauri::command]
pub async fn cmd_export_load_config(
    state: tauri::State<'_, AppState>,
    root: PathBuf,
) -> AppResult<Value> {
    let root = resolve_open_workspace(&state, &root)?;
    tokio::task::spawn_blocking(move || read_config(&root))
        .await
        .map_err(|e| invalid(e.to_string()))?
}
#[tauri::command]
pub async fn cmd_export_save_config(
    state: tauri::State<'_, AppState>,
    root: PathBuf,
    config: Value,
    expected_fingerprint: Option<String>,
) -> AppResult<Value> {
    let root = resolve_open_workspace(&state, &root)?;
    tokio::task::spawn_blocking(move || {
        let _lock = CONFIG_LOCK.lock().map_err(|e| invalid(e.to_string()))?;
        validate_config(&config)?;
        let current = read_config(&root)?;
        if current["fingerprint"].as_str() != expected_fingerprint.as_deref() {
            return Err(invalid("export:configConflict"));
        }
        let bytes = serialized_config(&config)?;
        let path = config_path(&root, true)?;
        atomic_write::write(&path, &bytes)?;
        read_config(&root)
    })
    .await
    .map_err(|e| invalid(e.to_string()))?
}

// Validate the actual persisted representation: pretty indentation can push an
// otherwise valid compact JSON value beyond the reader's byte limit.
fn serialized_config(config: &Value) -> AppResult<Vec<u8>> {
    validate_config(config)?;
    let bytes = serde_json::to_vec_pretty(config)?;
    if bytes.len() > MAX_CONFIG {
        return Err(invalid("export:configTooLarge"));
    }
    Ok(bytes)
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSnapshot {
    markdown: String,
    source_path: Option<PathBuf>,
    file_name: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    task_id: String,
    project_root: Option<PathBuf>,
    snapshot: ExportSnapshot,
    format: String,
    pdf_backend: Option<String>,
    options: Value,
    output_path: Option<PathBuf>,
    rendered_html: Option<String>,
    #[serde(default = "legacy_overwrite")]
    overwrite: bool,
}
fn legacy_overwrite() -> bool {
    true
}
fn validate_request(request: &ExportRequest) -> AppResult<()> {
    uuid::Uuid::parse_str(&request.task_id).map_err(|_| invalid("export:invalidTaskId"))?;
    validate_profile(&request.options)?;
    if request.snapshot.markdown.len() > MAX_BODY
        || request.snapshot.file_name.len() > 1024
        || request
            .rendered_html
            .as_ref()
            .is_some_and(|s| s.len() > MAX_HTML)
        || !["html", "pdf", "docx", "odt", "epub"].contains(&request.format.as_str())
    {
        return Err(invalid("export:invalidRequest"));
    }
    Ok(())
}
fn resource_path(source: &Path, resource: &str, project: Option<&Path>) -> AppResult<PathBuf> {
    if resource.len() > 8192 || resource.contains('\0') {
        return Err(invalid("export:invalidResource"));
    }
    let source = std::fs::canonicalize(source)?;
    let parent = source
        .parent()
        .ok_or_else(|| invalid("export:missingResourceBase"))?;
    let resource = resource.split('#').next().unwrap_or(resource);
    let decoded = percent_encoding::percent_decode_str(resource)
        .decode_utf8()
        .map_err(|_| invalid("export:invalidResource"))?;
    let path = if decoded.starts_with("file:") {
        url::Url::parse(&decoded)
            .map_err(|_| invalid("export:invalidResource"))?
            .to_file_path()
            .map_err(|_| invalid("export:invalidResource"))?
    } else {
        // HTTP/other schemes must not be interpreted as local drive paths.
        if decoded.contains("://") || decoded.starts_with("data:") {
            return Err(invalid("export:remoteResource"));
        }
        parent.join(decoded.as_ref())
    };
    let path = std::fs::canonicalize(path)?;
    let allowed = project.map_or_else(|| parent.to_path_buf(), Path::to_path_buf);
    if !path.starts_with(&allowed) || !path.is_file() {
        return Err(invalid("export:resourceOutsideScope"));
    }
    Ok(path)
}
fn image_mime(path: &Path) -> AppResult<&'static str> {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Ok("image/png"),
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "gif" => Ok("image/gif"),
        "webp" => Ok("image/webp"),
        "svg" => Ok("image/svg+xml"),
        _ => Err(invalid("export:unsupportedResource")),
    }
}
#[tauri::command]
pub async fn cmd_export_read_resource(
    state: tauri::State<'_, AppState>,
    source_path: PathBuf,
    resource: String,
    project_root: Option<PathBuf>,
) -> AppResult<Value> {
    if !state.is_document_source_authorized(&source_path) {
        return Err(invalid("export:sourceNotAuthorized"));
    }
    let root = project_root
        .as_ref()
        .map(|p| resolve_open_workspace(&state, p))
        .transpose()?;
    if let Some(root) = &root {
        resolve_existing_inside(root, &source_path, false)?;
    }
    tokio::task::spawn_blocking(move || {
        let path = resource_path(&source_path, &resource, root.as_deref())?;
        let mime = image_mime(&path)?;
        use std::io::Read;
        let mut bytes = Vec::new();
        std::fs::File::open(&path)?.take(MAX_RESOURCE + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_RESOURCE { return Err(invalid("export:resourceTooLarge")); }
        Ok(json!({"dataUrl":format!("data:{mime};base64,{}",STANDARD.encode(&bytes)),"mime":mime,"sourcePath":path}))
    }).await.map_err(|e| invalid(e.to_string()))?
}

#[tauri::command]
pub async fn cmd_export_save_dialog(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    format: String,
    default_name: String,
    default_directory: Option<PathBuf>,
) -> AppResult<Option<PathBuf>> {
    use tauri_plugin_dialog::DialogExt;
    if !["html", "pdf", "docx", "odt", "epub"].contains(&format.as_str())
        || default_name.len() > 1024
    {
        return Err(invalid("export:invalidFormat"));
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut dialog = app
        .dialog()
        .file()
        .add_filter(format.to_uppercase(), &[format.as_str()])
        .set_file_name(&default_name);
    if let Some(mut directory) = default_directory {
        while !directory.exists() {
            if !directory.pop() {
                break;
            }
        }
        if directory.is_dir() {
            dialog = dialog.set_directory(directory);
        }
    }
    dialog.save_file(move |file| {
        let _ = tx.send(file.and_then(|file| file.into_path().ok()));
    });
    let selected = rx.await.map_err(|e| invalid(e.to_string()))?;
    if let Some(path) = &selected {
        let approved = prospective_path(path)?;
        OUTPUT_GRANTS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|e| invalid(e.to_string()))?
            .entry(window.label().into())
            .or_default()
            .insert(approved);
    }
    Ok(selected)
}

async fn tool_available(tool: &str) -> bool {
    let mut command = Command::new(tool);
    command
        .arg("--version")
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    matches!(tokio::time::timeout(std::time::Duration::from_secs(4), command.status()).await, Ok(Ok(status)) if status.success())
}
async fn dependencies() -> (bool, Option<&'static str>) {
    let pandoc = tool_available("pandoc").await;
    let mut engine = None;
    if pandoc {
        for name in ["xelatex", "typst", "weasyprint"] {
            if tool_available(name).await {
                engine = Some(name);
                break;
            }
        }
    }
    (pandoc, engine)
}
#[tauri::command]
pub async fn cmd_export_preflight(
    state: tauri::State<'_, AppState>,
    request: ExportRequest,
) -> AppResult<Value> {
    validate_request(&request)?;
    if let Some(root) = &request.project_root {
        resolve_open_workspace(&state, root)?;
    }
    let (pandoc, engine) = dependencies().await;
    let mut blocking = Vec::<Value>::new();
    if !request.overwrite
        && request
            .output_path
            .as_ref()
            .is_some_and(|path| std::fs::symlink_metadata(path).is_ok())
    {
        blocking.push(json!({"code":"outputExists","message":"Output already exists. Choose another name or enable overwrite.","blocking":true}));
    }
    let mut warnings = Vec::<Value>::new();
    let is_pandoc = request.format != "html"
        && !(request.format == "pdf"
            && request
                .pdf_backend
                .as_deref()
                .unwrap_or(text(&request.options, "/pdf/backend"))
                == "system-print");
    if is_pandoc && !pandoc {
        blocking.push(json!({"code":"pandocMissing","message":"Pandoc is not installed or not on PATH.","blocking":true}));
    }
    if is_pandoc && request.format == "pdf" && engine.is_none() {
        blocking.push(json!({"code":"pdfEngineMissing","message":"Install an available PDF engine (XeLaTeX, Typst or WeasyPrint).","blocking":true}));
    }
    if request
        .options
        .pointer("/resources/downloadRemote")
        .and_then(Value::as_bool)
        == Some(true)
    {
        blocking.push(json!({"code":"remoteDownloadUnavailable","message":"Remote resource downloading is not available in M1. Use local resources.","blocking":true}));
    }
    if request.snapshot.markdown.contains("http://")
        || request.snapshot.markdown.contains("https://")
    {
        warnings.push(json!({"code":"externalLinks","message":"External links remain external. Remote images are not downloaded."}));
    }
    Ok(json!({"blocking":blocking,"warnings":warnings,
        "capabilities":{"html":true,"systemPrint":true,"pandoc":pandoc,"pdfEngine":engine,"formats":{"html":true,"pdf":true,"docx":pandoc,"odt":pandoc,"epub":pandoc}},
        "dependencies":{"pandocAvailable":pandoc,"pdfEngine":engine}}))
}
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    task_id: String,
    sequence: u32,
    stage: &'static str,
}
fn emit(window: &tauri::WebviewWindow, id: &str, sequence: u32, stage: &'static str) {
    let _ = window.emit(
        "mt://export/progress",
        Progress {
            task_id: id.into(),
            sequence,
            stage,
        },
    );
}

fn output_destination(request: &ExportRequest) -> AppResult<PathBuf> {
    let output = request
        .output_path
        .as_ref()
        .ok_or_else(|| invalid("export:missingOutput"))?;
    if !output.is_absolute() || output.file_name().is_none() {
        return Err(invalid("export:invalidOutput"));
    }
    if let Some(source) = &request.snapshot.source_path {
        if source == output
            || (output.exists()
                && std::fs::canonicalize(source).ok() == std::fs::canonicalize(output).ok())
        {
            return Err(invalid("export:cannotOverwriteSource"));
        }
    }
    if output
        .extension()
        .and_then(|s| s.to_str())
        .map(str::to_lowercase)
        .as_deref()
        != Some(request.format.as_str())
    {
        return Err(invalid("export:outputExtensionMismatch"));
    }
    Ok(output.clone())
}
fn unpack_images(
    html: &str,
    output: &Path,
    task_id: &str,
    cancel: &AtomicBool,
) -> AppResult<String> {
    let mut result = html.to_string();
    let folder_name = format!("assets-{task_id}");
    let folder = output
        .parent()
        .ok_or_else(|| invalid("export:missingOutput"))?
        .join(&folder_name);
    // Each attempt uses a fresh UUID directory; a failed retry never changes assets of the prior HTML.
    let mut created = false;
    let operation = (|| {
        let mut offset = 0;
        while let Some(found) = result[offset..].find("data:image/") {
            cancelled(cancel)?;
            let start = offset + found;
            let end = result[start..]
                .find(['"', '\'', '<', '>', ' ', '\n'])
                .map(|i| start + i)
                .unwrap_or(result.len());
            let data = &result[start..end];
            if let Some((mime, encoded)) = data
                .strip_prefix("data:")
                .and_then(|v| v.split_once(";base64,"))
            {
                let extension = match mime {
                    "image/png" => "png",
                    "image/jpeg" => "jpg",
                    "image/gif" => "gif",
                    "image/webp" => "webp",
                    "image/svg+xml" => "svg",
                    _ => return Err(invalid("export:unsupportedResource")),
                };
                let bytes = STANDARD
                    .decode(encoded)
                    .map_err(|_| invalid("export:invalidDataResource"))?;
                if bytes.len() as u64 > MAX_RESOURCE {
                    return Err(invalid("export:resourceTooLarge"));
                }
                if !created {
                    std::fs::create_dir(&folder)?;
                    created = true;
                }
                let name = format!("{}.{}", fingerprint(&bytes), extension);
                atomic_write::write(&folder.join(&name), &bytes)?;
                let replacement = format!("{folder_name}/{name}");
                result.replace_range(start..end, &replacement);
                offset = start + replacement.len();
            } else {
                offset = end;
            }
            if offset >= result.len() {
                break;
            }
        }
        Ok(result)
    })();
    if operation.is_err() && created {
        let _ = std::fs::remove_dir_all(&folder);
    }
    operation
}
struct JobGuard(String);
impl Drop for JobGuard {
    fn drop(&mut self) {
        if let Ok(mut jobs) = JOBS.get_or_init(|| Mutex::new(HashMap::new())).lock() {
            jobs.remove(&self.0);
        }
    }
}

#[tauri::command]
pub fn cmd_export_cancel(window: tauri::WebviewWindow, task_id: String) -> AppResult<()> {
    let key = format!("{}:{task_id}", window.label());
    if let Some(flag) = JOBS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|e| invalid(e.to_string()))?
        .get(&key)
    {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}
#[tauri::command]
pub async fn cmd_export_start(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    request: ExportRequest,
) -> AppResult<Value> {
    validate_request(&request)?;
    if let Some(root) = &request.project_root {
        resolve_open_workspace(&state, root)?;
    }
    let output = output_destination(&request)?;
    let root = request
        .project_root
        .as_ref()
        .map(|root| resolve_open_workspace(&state, root))
        .transpose()?;
    authorize_output(root.as_deref(), &output, window.label())?;
    if !request.overwrite && std::fs::symlink_metadata(&output).is_ok() {
        return Err(invalid("export:outputExists"));
    }
    let key = format!("{}:{}", window.label(), request.task_id);
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = JOBS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|e| invalid(e.to_string()))?;
        if jobs.contains_key(&key) {
            return Err(invalid("export:taskAlreadyRunning"));
        }
        jobs.insert(key.clone(), cancel.clone());
    }
    let _guard = JobGuard(key);
    emit(&window, &request.task_id, 1, "rendering");
    let result = run_export(&app, &request, &output, &cancel, &window).await;
    emit(
        &window,
        &request.task_id,
        3,
        if result.is_ok() {
            "completed"
        } else if cancel.load(Ordering::Relaxed) {
            "cancelled"
        } else {
            "failed"
        },
    );
    result.map(|_| json!({"status":"completed","outputPath":output}))
}
fn strip_svg_transport(html: &str) -> String {
    // This attribute is produced by XMLSerializer in the trusted export renderer.
    regex::Regex::new(r#"\sdata-export-svg="data:image/svg\+xml;base64,[A-Za-z0-9+/=]+""#)
        .expect("static SVG transport pattern")
        .replace_all(html, "")
        .into_owned()
}

fn svg_image(tag: &quick_xml::events::BytesStart<'_>) -> AppResult<String> {
    let uri = tag
        .attributes()
        .with_checks(false)
        .filter_map(Result::ok)
        .find(|attr| attr.key.as_ref() == b"data-export-svg")
        .map(|attr| attr.value.into_owned())
        .ok_or_else(|| invalid("export:missingSvgSnapshot"))?;
    let uri = std::str::from_utf8(&uri).map_err(|_| invalid("export:invalidSvgSnapshot"))?;
    let encoded = uri
        .strip_prefix("data:image/svg+xml;base64,")
        .ok_or_else(|| invalid("export:invalidSvgSnapshot"))?;
    if encoded.len() > (MAX_RESOURCE as usize * 4 / 3 + 4) {
        return Err(invalid("export:resourceTooLarge"));
    }
    let xml = STANDARD
        .decode(encoded)
        .map_err(|_| invalid("export:invalidSvgSnapshot"))?;
    if xml.len() > MAX_RESOURCE as usize {
        return Err(invalid("export:resourceTooLarge"));
    }
    // The base64 alphabet cannot introduce HTML attribute delimiters.
    Ok(format!(r#"<img alt="Diagram" src="{uri}">"#))
}

/// Preserve the XML SVG snapshot across Pandoc's HTML parser, and give it only
/// KaTeX's semantic MathML (the visual HTML span otherwise duplicates formulas).
fn portable_pandoc_html(html: &str) -> AppResult<String> {
    use quick_xml::events::Event;
    let mut reader = quick_xml::Reader::from_str(html);
    // Prepared HTML contains void tags such as <img> and <meta>.
    reader.config_mut().check_end_names = false;
    let mut replacements: Vec<(usize, usize, String)> = Vec::new();
    let mut capture: Option<(usize, Vec<u8>, usize, String)> = None;
    loop {
        let start = reader.buffer_position() as usize;
        let event = reader
            .read_event()
            .map_err(|error| invalid(format!("export:invalidPreparedHtml:{error}")))?;
        let end = reader.buffer_position() as usize;
        if let Event::Start(tag) = &event {
            if matches!(tag.name().as_ref(), b"style" | b"script") {
                // CSS may contain literal SVG in a data URL. It is HTML raw text,
                // rather than a document diagram requiring a transport snapshot.
                reader
                    .read_to_end(tag.name())
                    .map_err(|error| invalid(format!("export:invalidPreparedHtml:{error}")))?;
                continue;
            }
        }
        if let Some((_, name, depth, _)) = capture.as_mut() {
            match &event {
                Event::Start(tag) if tag.name().as_ref() == name.as_slice() => *depth += 1,
                Event::End(tag) if tag.name().as_ref() == name.as_slice() => *depth -= 1,
                Event::Eof => return Err(invalid("export:incompletePreparedHtml")),
                _ => {}
            }
            if *depth == 0 {
                let (from, _, _, replacement) = capture.take().expect("active capture");
                replacements.push((from, end, replacement));
            }
            continue;
        }
        match event {
            Event::Start(tag) | Event::Empty(tag) if tag.name().as_ref() == b"svg" => {
                let replacement = svg_image(&tag)?;
                if html[start..end].trim_end().ends_with("/>") {
                    replacements.push((start, end, replacement));
                } else {
                    capture = Some((start, b"svg".to_vec(), 1, replacement));
                }
            }
            Event::Start(tag) if tag.name().as_ref() == b"span" => {
                let mirror = tag
                    .attributes()
                    .with_checks(false)
                    .filter_map(Result::ok)
                    .any(|attr| {
                        attr.key.as_ref() == b"class"
                            && attr
                                .value
                                .split(u8::is_ascii_whitespace)
                                .any(|class| class == b"katex-html")
                    });
                if mirror {
                    capture = Some((start, b"span".to_vec(), 1, String::new()));
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    let mut portable = html.to_owned();
    for (from, to, replacement) in replacements.into_iter().rev() {
        portable.replace_range(from..to, &replacement);
    }
    Ok(portable)
}

async fn run_export(
    _app: &tauri::AppHandle,
    request: &ExportRequest,
    output: &Path,
    cancel: &Arc<AtomicBool>,
    window: &tauri::WebviewWindow,
) -> AppResult<()> {
    cancelled(cancel)?;
    let parent = output
        .parent()
        .ok_or_else(|| invalid("export:missingOutput"))?;
    tokio::fs::create_dir_all(parent).await?;
    if request.format == "html" {
        let html = request
            .rendered_html
            .as_deref()
            .ok_or_else(|| invalid("export:missingRenderedHtml"))?;
        // The XML copy is only for format conversion; HTML keeps the visible inline SVG.
        let html = strip_svg_transport(html);
        emit(window, &request.task_id, 2, "writing");
        let output = output.to_path_buf();
        let cancel = cancel.clone();
        let folder = text(&request.options, "/resources/htmlMode") == "folder";
        let id = request.task_id.clone();
        let overwrite = request.overwrite;
        let owned_assets = folder
            && !output
                .parent()
                .is_some_and(|parent| parent.join(format!("assets-{id}")).exists());
        return tokio::task::spawn_blocking(move || {
            cancelled(&cancel)?;
            let html = if folder {
                unpack_images(&html, &output, &id, &cancel)?
            } else {
                html
            };
            let result = cancelled(&cancel)
                .and_then(|_| write_artifact(&output, html.as_bytes(), overwrite));
            if result.is_err() && owned_assets {
                if let Some(parent) = output.parent() {
                    let _ = std::fs::remove_dir_all(parent.join(format!("assets-{id}")));
                }
            }
            result
        })
        .await
        .map_err(|e| invalid(e.to_string()))?;
    }
    if request.format == "pdf"
        && request
            .pdf_backend
            .as_deref()
            .unwrap_or(text(&request.options, "/pdf/backend"))
            == "system-print"
    {
        return Err(invalid("export:usePrintPreview"));
    }
    let (pandoc, engine) = dependencies().await;
    if !pandoc {
        return Err(invalid("export:pandocMissing"));
    }
    let staging = tempfile::Builder::new()
        .prefix(".markcaptain-export-")
        .tempdir_in(parent)?;
    let artifact = staging.path().join(format!("document.{}", request.format));
    let mut command = Command::new("pandoc");
    command
        .arg("-f")
        .arg("html")
        .arg("-t")
        .arg(&request.format)
        .arg("--standalone")
        .arg("-o")
        .arg(&artifact)
        // Pandoc extracts inline media relative to its CWD. Keep intermediates out of sources.
        .current_dir(staging.path())
        .kill_on_drop(true);
    if let Some(source) = &request.snapshot.source_path {
        if let Some(base) = source.parent() {
            command.arg("--resource-path").arg(base);
        }
    }
    // The prepared HTML already contains the requested title and TOC.
    if request.options["numberHeadings"].as_bool() == Some(true) {
        command.arg("--number-sections");
    }
    command.arg("--metadata").arg("title=");
    if request.format == "pdf" {
        let engine = engine.ok_or_else(|| invalid("export:pdfEngineMissing"))?;
        command.arg("--pdf-engine").arg(engine);
        if engine == "typst" {
            command
                .arg("--template")
                .arg(typst_template(&request.options, staging.path()).await?);
        }
        let paper = text(&request.options, "/page/size").to_lowercase();
        command.arg("-V").arg(format!("papersize:{paper}"));
        command.arg("-V").arg(format!(
            "mainfont:{}",
            style_font(text(&request.options, "/typography/bodyFont"), false)
        ));
        command.arg("-V").arg(format!(
            "codefont:{}",
            style_font(text(&request.options, "/typography/codeFont"), true)
        ));
        command.arg("-V").arg(format!(
            "linestretch:{}",
            request
                .options
                .pointer("/typography/lineHeight")
                .and_then(Value::as_f64)
                .unwrap_or(1.65)
        ));
        for side in ["top", "right", "bottom", "left"] {
            let n = request
                .options
                .pointer(&format!("/page/marginMm/{side}"))
                .and_then(Value::as_f64)
                .unwrap_or(20.0);
            command.arg("-V").arg(format!("geometry:{side}={n}mm"));
        }
        if text(&request.options, "/page/orientation") == "landscape" {
            command.arg("-V").arg("geometry:landscape");
        }
        command.arg("-V").arg(format!(
            "fontsize={}pt",
            request
                .options
                .pointer("/typography/bodySizePt")
                .and_then(Value::as_f64)
                .unwrap_or(11.0)
        ));
    }
    if ["docx", "odt"].contains(&request.format.as_str()) {
        let reference = create_reference(&request.format, &request.options, staging.path()).await?;
        command.arg("--reference-doc").arg(reference);
    }
    if request.format == "epub" {
        let css = staging.path().join("theme.css");
        let font = match text(&request.options, "/typography/bodyFont") {
            "system-serif" => "serif",
            _ => "sans-serif",
        };
        let size = request
            .options
            .pointer("/typography/bodySizePt")
            .and_then(Value::as_f64)
            .unwrap_or(11.0);
        let line = request
            .options
            .pointer("/typography/lineHeight")
            .and_then(Value::as_f64)
            .unwrap_or(1.65);
        let accent = match text(&request.options, "/theme") {
            "technical" => "#225d82",
            "formal-report" => "#243047",
            _ => "#343434",
        };
        tokio::fs::write(&css,format!("body{{font-family:{font};font-size:{size}pt;line-height:{line};color:#17212b}} h1,h2{{color:{accent}}} pre{{white-space:pre-wrap}} img{{max-width:100%}}")).await?;
        command.arg("--css").arg(css);
    }
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let input = portable_pandoc_html(
        request
            .rendered_html
            .as_deref()
            .ok_or_else(|| invalid("export:missingRenderedHtml"))?,
    )?;
    let mut child = command
        .spawn()
        .map_err(|e| invalid(format!("export:pandocStart:{e}")))?;
    let input_writer = if let Some(mut stdin) = child.stdin.take() {
        // Run the bounded input write concurrently with cancellation below.
        Some(tokio::spawn(async move {
            let result = stdin.write_all(input.as_bytes()).await;
            drop(stdin);
            result
        }))
    } else {
        None
    };
    let waiting = child.wait_with_output();
    tokio::pin!(waiting);
    let deadline = tokio::time::sleep(std::time::Duration::from_secs(120));
    tokio::pin!(deadline);
    let completed = loop {
        tokio::select! {
            result=&mut waiting=>{break result?;}
            _=tokio::time::sleep(std::time::Duration::from_millis(100))=>{cancelled(cancel)?;}
            _=&mut deadline=>{return Err(invalid("export:timeout"));}
        }
    };
    if !completed.status.success() {
        return Err(invalid(format!(
            "export:pandocFailed:{}",
            String::from_utf8_lossy(&completed.stderr)
                .chars()
                .take(2000)
                .collect::<String>()
        )));
    }
    if let Some(writer) = input_writer {
        writer.await.map_err(|e| invalid(e.to_string()))??;
    }
    cancelled(cancel)?;
    emit(window, &request.task_id, 2, "writing");
    let bytes = tokio::fs::read(&artifact).await?;
    if bytes.is_empty() {
        return Err(invalid("export:emptyOutput"));
    }
    let destination = output.to_path_buf();
    let overwrite = request.overwrite;
    tokio::task::spawn_blocking(move || write_artifact(&destination, &bytes, overwrite))
        .await
        .map_err(|e| invalid(e.to_string()))??;
    Ok(())
}

fn write_artifact(path: &Path, bytes: &[u8], overwrite: bool) -> AppResult<()> {
    if overwrite {
        return atomic_write::write(path, bytes).map_err(AppError::from);
    }
    use std::io::Write;
    let parent = path
        .parent()
        .ok_or_else(|| invalid("export:invalidOutput"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist_noclobber(path).map_err(|error| {
        if error.error.kind() == std::io::ErrorKind::AlreadyExists {
            invalid("export:outputExists")
        } else {
            AppError::from(error.error)
        }
    })?;
    Ok(())
}

fn xml_value(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('"', "&quot;")
}
fn style_font(value: &str, code: bool) -> String {
    match value {
        "system-serif" => if cfg!(windows) {
            "SimSun"
        } else {
            "Noto Serif CJK SC"
        }
        .into(),
        "system-cjk" => if cfg!(windows) {
            "Microsoft YaHei"
        } else {
            "Noto Sans CJK SC"
        }
        .into(),
        "system-monospace" => if cfg!(windows) {
            "Consolas"
        } else {
            "monospace"
        }
        .into(),
        "" => if code { "monospace" } else { "sans-serif" }.into(),
        value => value.into(),
    }
}
fn odt_page_layout(xml: &str, profile: &Value) -> AppResult<String> {
    let (mut width, mut height) = match text(profile, "/page/size") {
        "A5" => (148.0, 210.0),
        "Letter" => (215.9, 279.4),
        "Legal" => (215.9, 355.6),
        _ => (210.0, 297.0),
    };
    let landscape = text(profile, "/page/orientation") == "landscape";
    if landscape {
        std::mem::swap(&mut width, &mut height);
    }
    let mut fields = vec![
        ("fo:page-width".to_string(), format!("{width}mm")),
        ("fo:page-height".to_string(), format!("{height}mm")),
        (
            "style:print-orientation".to_string(),
            if landscape { "landscape" } else { "portrait" }.to_string(),
        ),
    ];
    for side in ["top", "right", "bottom", "left"] {
        let value = profile
            .pointer(&format!("/page/marginMm/{side}"))
            .and_then(Value::as_f64)
            .unwrap_or(20.0);
        fields.push((format!("fo:margin-{side}"), format!("{value}mm")));
    }
    let mut replacements = Vec::new();
    for (attribute, value) in fields {
        replacements.push((
            regex::Regex::new(&format!(r#"{attribute}="[^"]*""#))
                .map_err(|e| invalid(e.to_string()))?,
            format!(r#"{attribute}="{value}""#),
        ));
    }
    let layout = regex::Regex::new(r#"(?s)<style:page-layout-properties\b[^>]*>"#)
        .map_err(|e| invalid(e.to_string()))?;
    Ok(layout
        .replace_all(xml, |capture: &regex::Captures<'_>| {
            let mut block = capture[0].to_string();
            for (pattern, replacement) in &replacements {
                block = pattern
                    .replace_all(&block, replacement.as_str())
                    .into_owned();
            }
            block
        })
        .into_owned())
}

fn reference_bytes(bytes: Vec<u8>, format: &str, profile: &Value) -> AppResult<Vec<u8>> {
    use std::io::{Cursor, Read, Write};
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| invalid(e.to_string()))?;
    let mut output = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let body_font = xml_value(&style_font(text(profile, "/typography/bodyFont"), false));
    let code_font = xml_value(&style_font(text(profile, "/typography/codeFont"), true));
    let size = profile
        .pointer("/typography/bodySizePt")
        .and_then(Value::as_f64)
        .unwrap_or(11.0);
    let heading_color = match text(profile, "/theme") {
        "technical" => "225D82",
        "formal-report" => "243047",
        _ => "343434",
    };
    let body_style = regex::Regex::new(r#"(?s)<w:style\b[^>]*w:styleId="(Normal|BodyText|FirstParagraph|Heading[1-6]|SourceCode|VerbatimChar)"[^>]*>.*?</w:style>"#).map_err(|e|invalid(e.to_string()))?;
    let run_property = regex::Regex::new(r#"<w:(rFonts|sz|szCs|color)\b[^>]*/>"#)
        .map_err(|e| invalid(e.to_string()))?;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| invalid(e.to_string()))?;
        let name = entry.name().to_string();
        let mut content = Vec::new();
        entry.read_to_end(&mut content)?;
        if name == "word/styles.xml" {
            let xml = String::from_utf8(content).map_err(|e| invalid(e.to_string()))?;
            let changed=body_style.replace_all(&xml, |capture: &regex::Captures<'_>| {
                let id=&capture[1]; let mut block=run_property.replace_all(&capture[0],"").into_owned();
                let font=if id=="SourceCode" || id=="VerbatimChar" {&code_font} else {&body_font};
                let points=if id.starts_with("Heading") {size+(7.0-(id.as_bytes()[7]-b'0') as f64).max(0.0)*1.6} else {size};
                let color=if id.starts_with("Heading") {heading_color} else {"17212B"};
                let properties=format!(r#"<w:rFonts w:ascii="{font}" w:hAnsi="{font}" w:eastAsia="{body_font}"/><w:sz w:val="{}"/><w:szCs w:val="{}"/><w:color w:val="{color}"/>"#,(points*2.0).round(),(points*2.0).round());
                if block.contains("<w:rPr/>") {block=block.replacen("<w:rPr/>",&format!("<w:rPr>{properties}</w:rPr>"),1);}
                else if block.contains("<w:rPr>") {block=block.replacen("<w:rPr>",&format!("<w:rPr>{properties}"),1);}
                else {block=block.replace("</w:style>",&format!("<w:rPr>{properties}</w:rPr></w:style>"));}
                block
            });
            content = changed.as_bytes().to_vec();
        } else if name == "word/document.xml" {
            let xml = String::from_utf8(content).map_err(|e| invalid(e.to_string()))?;
            let (mut width, mut height) = match text(profile, "/page/size") {
                "A5" => (8391, 11906),
                "Letter" => (12240, 15840),
                "Legal" => (12240, 20160),
                _ => (11906, 16838),
            };
            let landscape = text(profile, "/page/orientation") == "landscape";
            if landscape {
                std::mem::swap(&mut width, &mut height);
            }
            let page =
                regex::Regex::new(r#"<w:pgSz\b[^>]*/>"#).map_err(|e| invalid(e.to_string()))?;
            let xml = page.replace_all(
                &xml,
                format!(
                    r#"<w:pgSz w:w="{width}" w:h="{height}" w:orient="{}"/>"#,
                    if landscape { "landscape" } else { "portrait" }
                ),
            );
            let margins =
                regex::Regex::new(r#"<w:pgMar\b[^>]*/>"#).map_err(|e| invalid(e.to_string()))?;
            let mut attributes = String::new();
            for side in ["top", "right", "bottom", "left"] {
                let value = profile
                    .pointer(&format!("/page/marginMm/{side}"))
                    .and_then(Value::as_f64)
                    .unwrap_or(20.0)
                    * 56.692913;
                attributes.push_str(&format!(r#" w:{side}="{}""#, value.round()));
            }
            content = margins
                .replace_all(
                    &xml,
                    format!(r#"<w:pgMar{attributes} w:header="708" w:footer="708" w:gutter="0"/>"#),
                )
                .as_bytes()
                .to_vec();
        } else if format == "odt" && name == "styles.xml" {
            let xml = String::from_utf8(content).map_err(|e| invalid(e.to_string()))?;
            let font = regex::Regex::new(r#"fo:font-family="[^"]*""#)
                .map_err(|e| invalid(e.to_string()))?;
            let xml = font.replace_all(&xml, format!(r#"fo:font-family="{body_font}""#));
            let font_size =
                regex::Regex::new(r#"fo:font-size="12pt""#).map_err(|e| invalid(e.to_string()))?;
            content = font_size
                .replace_all(&xml, format!(r#"fo:font-size="{size}pt""#))
                .as_bytes()
                .to_vec();
            let xml = String::from_utf8(content).map_err(|e| invalid(e.to_string()))?;
            content = odt_page_layout(&xml, profile)?.into_bytes();
        }
        let options =
            zip::write::SimpleFileOptions::default().compression_method(if name == "mimetype" {
                zip::CompressionMethod::Stored
            } else {
                zip::CompressionMethod::Deflated
            });
        output
            .start_file(name, options)
            .map_err(|e| invalid(e.to_string()))?;
        output.write_all(&content)?;
    }
    Ok(output
        .finish()
        .map_err(|e| invalid(e.to_string()))?
        .into_inner())
}
async fn create_reference(format: &str, profile: &Value, directory: &Path) -> AppResult<PathBuf> {
    let mut command = Command::new("pandoc");
    command
        .arg(format!("--print-default-data-file=reference.{format}"))
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(std::time::Duration::from_secs(10), command.output())
        .await
        .map_err(|_| invalid("export:referenceTimeout"))??;
    if !output.status.success() || output.stdout.len() > 2 * 1024 * 1024 {
        return Err(invalid("export:referenceUnavailable"));
    }
    let bytes = reference_bytes(output.stdout, format, profile)?;
    let path = directory.join(format!("reference.{format}"));
    tokio::fs::write(&path, bytes).await?;
    Ok(path)
}

async fn typst_template(profile: &Value, directory: &Path) -> AppResult<PathBuf> {
    let mut command = Command::new("pandoc");
    command.args(["-D", "typst"]).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let result = tokio::time::timeout(std::time::Duration::from_secs(10), command.output())
        .await
        .map_err(|_| invalid("export:templateTimeout"))??;
    if !result.status.success() {
        return Err(invalid("export:templateUnavailable"));
    }
    let template = String::from_utf8(result.stdout).map_err(|e| invalid(e.to_string()))?;
    let mut margins = String::new();
    for side in ["top", "right", "bottom", "left"] {
        let value = profile
            .pointer(&format!("/page/marginMm/{side}"))
            .and_then(Value::as_f64)
            .unwrap_or(20.0);
        margins.push_str(&format!("{side}: {value}mm,"));
    }
    let color = match text(profile, "/theme") {
        "technical" => "225D82",
        "formal-report" => "243047",
        _ => "343434",
    };
    let direction = if text(profile, "/page/orientation") == "landscape" {
        "#set page(flipped: true)\n"
    } else {
        ""
    };
    let injected=format!("#set page(margin: ({margins}))\n{direction}#show heading: set text(fill: rgb(\"#{color}\"))\n#show figure.where(kind: table): set block(breakable: true)\n$body$");
    let path = directory.join("theme.typ");
    tokio::fs::write(&path, template.replace("$body$", &injected)).await?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pandoc_uses_xml_svg_snapshot_and_drops_only_katex_mirror() {
        let xml = r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><text>中文</text></svg>"#;
        let uri = format!("data:image/svg+xml;base64,{}", STANDARD.encode(xml));
        let html = format!(
            r#"<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><br><svg data-export-svg="{uri}"><svg><span class="katex-html">inside</span></svg></svg><span class="katex"><span class="katex-mathml"><math><mi>x</mi></math></span><span class="katex-html visual"><span>x</span></span></span><code>&lt;svg&gt;</code></body></html>"#
        );
        let result = portable_pandoc_html(&html).unwrap();
        assert!(result.contains(&format!(r#"<img alt="Diagram" src="{uri}">"#)));
        assert!(!result.contains("katex-html"));
        assert!(result.contains("<math><mi>x</mi></math>"));
        assert!(result.contains("&lt;svg&gt;"));
        assert!(!result.contains("data-export-svg"));
    }

    #[test]
    fn pandoc_rejects_missing_or_invalid_svg_snapshots() {
        assert!(portable_pandoc_html("<svg></svg>").is_err());
        assert!(portable_pandoc_html(r#"<svg data-export-svg="file:///secret.svg"/>"#).is_err());
        let uri = format!("data:image/svg+xml;base64,{}", STANDARD.encode("<svg/>"));
        assert!(portable_pandoc_html(&format!(r#"<svg data-export-svg="{uri}">"#)).is_err());
        assert!(
            portable_pandoc_html(&format!(r#"<svg data-export-svg="{uri}"/>"#))
                .unwrap()
                .starts_with("<img ")
        );
    }

    #[test]
    fn static_html_removes_transport_without_changing_visible_svg() {
        let html = r#"<svg width="100%" data-export-svg="data:image/svg+xml;base64,PHN2Zy8+"><text>中文</text></svg>"#;
        assert_eq!(
            strip_svg_transport(html),
            r#"<svg width="100%"><text>中文</text></svg>"#
        );
    }

    #[test]
    fn pandoc_does_not_treat_css_data_uri_svg_as_a_document_diagram() {
        let html = r#"<html><style>.icon{background:url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><path/></svg>")}</style><p>中文</p></html>"#;
        assert_eq!(portable_pandoc_html(html).unwrap(), html);
    }
    fn profile() -> Value {
        json!({"id":"technical","name":"技术","theme":"technical","content":{"mode":"current","source":"buffer"},"formats":["html"],"output":{"directory":"exports","fileName":"{name}"},"typography":{"bodyFont":"system-cjk","codeFont":"system-monospace","bodySizePt":11,"lineHeight":1.65},"page":{"size":"A4","orientation":"portrait","marginMm":{"top":20,"right":18,"bottom":20,"left":18}},"toc":{"enabled":true,"depth":3},"resources":{"htmlMode":"embed","downloadRemote":false},"pdf":{"backend":"system-print"}})
    }
    #[test]
    fn profiles_reject_unsafe_and_invalid_settings() {
        let p = profile();
        assert!(validate_profile(&p).is_ok());
        for (field, value) in [
            ("/output/directory", json!("../escape")),
            ("/theme", json!("unknown")),
            ("/typography/bodySizePt", json!(-1)),
        ] {
            let mut p = profile();
            *p.pointer_mut(field).unwrap() = value;
            assert!(validate_profile(&p).is_err());
        }
    }
    #[test]
    fn config_rejects_duplicate_and_unknown_schema() {
        let p = profile();
        let mut c = json!({"schemaVersion":1,"defaultProfile":"technical","profiles":[p]});
        assert!(validate_config(&c).is_ok());
        c["schemaVersion"] = json!(2);
        assert!(validate_config(&c).is_err());
        c["schemaVersion"] = json!(1);
        c["profiles"].as_array_mut().unwrap().push(profile());
        assert!(validate_config(&c).is_err());
    }
    fn project_plan() -> Value {
        json!({"schemaVersion":1,"mode":"book","title":"Manual","chapters":[{"path":"chapters/a.md","title":"First","level":1}],"formats":["html"],"profileId":"technical","bookFileName":"manual","overwrite":false})
    }
    #[test]
    fn project_plan_extension_is_optional_portable_and_bounded() {
        let mut config =
            json!({"schemaVersion":1,"defaultProfile":"technical","profiles":[profile()]});
        assert!(validate_config(&config).is_ok());
        config["projectExport"] = project_plan();
        assert!(validate_config(&config).is_ok());
        for (pointer, value) in [
            ("/schemaVersion", json!(2)),
            ("/mode", json!("glob")),
            ("/profileId", json!("missing")),
            ("/bookFileName", json!("../manual")),
            ("/bookFileName", json!("CON")),
            ("/bookFileName", json!("{name}")),
            ("/chapters/0/path", json!("../secret.md")),
            ("/chapters/0/level", json!(6)),
            ("/chapters/0/path", json!("chapters/*.md")),
            ("/title", json!("x".repeat(201))),
            ("/formats", json!(["html", "html"])),
        ] {
            let mut plan = project_plan();
            *plan.pointer_mut(pointer).unwrap() = value;
            config["projectExport"] = plan;
            assert!(validate_config(&config).is_err(), "{pointer}");
        }
        let mut plan = project_plan();
        let duplicate = plan["chapters"][0].clone();
        plan["chapters"].as_array_mut().unwrap().push(duplicate);
        config["projectExport"] = plan;
        assert!(validate_config(&config).is_err());
        config["projectExport"] = project_plan();
        config["projectExport"]["chapters"][0]["tabId"] = json!("unsaved");
        assert!(validate_config(&config).is_err());
        config["projectExport"] = project_plan();
        config["projectExport"]["chapters"] = json!([]);
        assert!(validate_config(&config).is_ok());
    }

    #[test]
    fn persisted_pretty_config_is_bounded_before_write() {
        let mut config =
            json!({"schemaVersion":1,"defaultProfile":"technical","profiles":[profile()]});
        config["extension"] = json!(vec![""; 40_000]);
        assert!(serde_json::to_vec(&config).unwrap().len() < MAX_CONFIG);
        assert!(validate_config(&config).is_ok());
        assert!(serialized_config(&config).is_err());
    }

    #[test]
    fn every_profile_output_is_excluded_from_project_inputs() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let mut second = profile();
        second["id"] = json!("other");
        second["output"]["directory"] = json!("delivery/manuals");
        let config =
            json!({"schemaVersion":1,"defaultProfile":"technical","profiles":[profile(),second]});
        std::fs::create_dir(root.join(".markcaptain")).unwrap();
        std::fs::write(
            root.join(".markcaptain/export.json"),
            serialized_config(&config).unwrap(),
        )
        .unwrap();
        assert_eq!(
            output_directories(&root),
            vec![root.join("exports"), root.join("delivery/manuals")]
        );
        for directory in ["exports", "delivery/manuals"] {
            std::fs::create_dir_all(root.join(directory)).unwrap();
            std::fs::write(root.join(directory).join("generated.md"), "generated").unwrap();
        }
        std::fs::write(root.join("source.md"), "source").unwrap();
        assert_eq!(
            super::super::export_batch::candidates(&root).unwrap().len(),
            1
        );
    }

    #[test]
    fn no_clobber_publication_preserves_existing_artifacts_and_cleans_staging() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("artifact.html");
        write_artifact(&path, b"first", false).unwrap();
        assert!(write_artifact(&path, b"second", false).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"first");
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
        write_artifact(&path, b"allowed", true).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"allowed");
    }

    #[test]
    fn competing_no_clobber_writers_publish_exactly_one_complete_artifact() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("race.html");
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let tasks: Vec<_> = [b'a', b'b']
            .into_iter()
            .map(|byte| {
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    write_artifact(&path, &vec![byte; 10_000], false).is_ok()
                })
            })
            .collect();
        let completed: Vec<_> = tasks.into_iter().map(|task| task.join().unwrap()).collect();
        assert_eq!(completed.iter().filter(|success| **success).count(), 1);
        let bytes = std::fs::read(path).unwrap();
        assert_eq!(bytes.len(), 10_000);
        assert!(bytes.iter().all(|byte| *byte == bytes[0]));
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
        // The two publications race after staging; persist_noclobber is the
        // final filesystem check, so no exists-then-replace window is present.
    }
    #[test]
    fn resources_cannot_escape_source_or_follow_remote_urls() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("project");
        std::fs::create_dir(&dir).unwrap();
        let source = dir.join("文档.md");
        std::fs::write(&source, "# source").unwrap();
        std::fs::write(tmp.path().join("outside.png"), "outside").unwrap();
        assert!(resource_path(&source, "../outside.png", None).is_err());
        assert!(resource_path(&source, "https://example.com/image.png", None).is_err());
        std::fs::write(dir.join("图片.png"), "inside").unwrap();
        assert!(resource_path(&source, "%E5%9B%BE%E7%89%87.png", None).is_ok());
    }
    #[test]
    fn folder_html_packages_deduplicated_assets() {
        let tmp = tempfile::tempdir().unwrap();
        let output = tmp.path().join("test.html");
        let id = uuid::Uuid::new_v4().to_string();
        let data = format!("data:image/png;base64,{}", STANDARD.encode(b"fixture"));
        let html = format!("<img src=\"{data}\"><img src=\"{data}\">");
        let result = unpack_images(&html, &output, &id, &AtomicBool::new(false)).unwrap();
        assert!(!result.contains("data:image"));
        assert_eq!(
            std::fs::read_dir(tmp.path().join(format!("assets-{id}")))
                .unwrap()
                .count(),
            1
        );
        assert!(unpack_images(
            &html,
            &output,
            &uuid::Uuid::new_v4().to_string(),
            &AtomicBool::new(true)
        )
        .is_err());
    }
    #[test]
    fn absent_config_does_not_create_project_files() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(read_config(tmp.path()).unwrap()["config"].is_null());
        assert!(!tmp.path().join(".markcaptain").exists());
    }

    #[test]
    fn output_paths_require_project_scope_or_one_time_dialog_grant() {
        let root = tempfile::tempdir().unwrap();
        let canonical = std::fs::canonicalize(root.path()).unwrap();
        assert!(authorize_output(
            Some(&canonical),
            &canonical.join("exports/book.html"),
            "test-window"
        )
        .is_ok());
        assert!(authorize_output(
            Some(&canonical),
            &canonical.join("private.html"),
            "test-window"
        )
        .is_err());
        let external = tempfile::tempdir().unwrap();
        let destination = prospective_path(&external.path().join("approved.html")).unwrap();
        OUTPUT_GRANTS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap()
            .entry("grant-window".into())
            .or_default()
            .insert(destination.clone());
        assert!(authorize_output(None, &destination, "another-window").is_err());
        assert!(authorize_output(None, &destination, "grant-window").is_ok());
        assert!(authorize_output(None, &destination, "grant-window").is_err());
    }
    #[test]
    fn failed_asset_unpack_preserves_old_html_and_removes_new_assets() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("existing.html");
        std::fs::write(&output, "old successful export").unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let data = STANDARD.encode(b"first image");
        let html=format!("<img src=\"data:image/png;base64,{data}\"><img src=\"data:image/png;base64,INVALID%%\">");
        assert!(unpack_images(&html, &output, &id, &AtomicBool::new(false)).is_err());
        assert_eq!(
            std::fs::read_to_string(&output).unwrap(),
            "old successful export"
        );
        assert!(!root.path().join(format!("assets-{id}")).exists());
    }
    #[test]
    fn word_reference_applies_theme_fonts_and_page_layout() {
        use std::io::{Cursor, Read, Write};
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, xml) in [
            (
                "word/styles.xml",
                r#"<w:styles><w:style w:styleId="Normal"><w:rPr><w:rFonts w:ascii="Calibri"/><w:sz w:val="22"/></w:rPr></w:style><w:style w:styleId="Heading1"><w:rPr/></w:style></w:styles>"#,
            ),
            (
                "word/document.xml",
                r#"<w:document><w:sectPr><w:pgSz w:w="100" w:h="200"/><w:pgMar w:top="0"/></w:sectPr></w:document>"#,
            ),
        ] {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(xml.as_bytes()).unwrap();
        }
        let mut p = profile();
        p["theme"] = json!("formal-report");
        p["typography"]["bodyFont"] = json!("system-serif");
        let bytes = reference_bytes(zip.finish().unwrap().into_inner(), "docx", &p).unwrap();
        let mut result = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut styles = String::new();
        result
            .by_name("word/styles.xml")
            .unwrap()
            .read_to_string(&mut styles)
            .unwrap();
        assert!(styles.contains("243047"));
        assert!(!styles.contains("Calibri"));
        assert_eq!(styles.matches("<w:rPr>").count(), 2);
        let mut document = String::new();
        result
            .by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut document)
            .unwrap();
        assert!(document.contains(r#"w:w="11906""#));
        assert!(document.contains(r#"w:top="1134""#));
    }
    #[test]
    fn odt_page_margins_do_not_change_paragraph_spacing() {
        let xml = r#"<office:document><style:paragraph-properties fo:margin-top="0.2in"/><style:page-layout-properties fo:page-width="8.5in" fo:page-height="11in" style:print-orientation="portrait" fo:margin-top="1in" fo:margin-bottom="1in" fo:margin-left="1in" fo:margin-right="1in"/></office:document>"#;
        let result = odt_page_layout(xml, &profile()).unwrap();
        assert!(result.contains(r#"style:paragraph-properties fo:margin-top="0.2in""#));
        assert!(result.contains(r#"fo:page-width="210mm""#));
        assert!(result.contains(r#"fo:margin-top="20mm""#));
    }
}
