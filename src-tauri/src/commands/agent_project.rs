//! Declarative project writing preferences and deterministic, read-only document checks.
use super::workspace::{resolve_existing_inside, resolve_open_workspace};
use crate::{
    app::AppState,
    error::{AppError, AppResult},
    filesystem::atomic_write,
};
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
};

const MAX_CONFIG: u64 = 128 * 1024;
const MAX_DOCUMENT: usize = 2_000_000;
const MAX_ISSUES: usize = 200;
static CONFIG_LOCK: Mutex<()> = Mutex::new(());
fn invalid(code: &str) -> AppError {
    AppError::Other(format!("agent:{code}"))
}

fn resolve_owned_root(state: &AppState, window: &str, root: &Path) -> AppResult<PathBuf> {
    let root = resolve_open_workspace(state, root)?;
    if !state
        .workspace_roots_for_window(window)
        .iter()
        .any(|candidate| std::fs::canonicalize(candidate).is_ok_and(|candidate| candidate == root))
    {
        return Err(invalid("projectNotOwned"));
    }
    Ok(root)
}

fn config_path(root: &Path, create: bool) -> AppResult<PathBuf> {
    let directory = root.join(".markcaptain");
    if std::fs::symlink_metadata(&directory).is_ok() {
        resolve_existing_inside(root, &directory, false)?;
        if !directory.is_dir() {
            return Err(invalid("projectConfigInvalid"));
        }
    } else if create {
        std::fs::create_dir(&directory)?;
    }
    let path = directory.join("agent.json");
    if std::fs::symlink_metadata(&path).is_ok() {
        resolve_existing_inside(root, &path, false)?;
    }
    Ok(path)
}

fn bounded_string(value: &Value, limit: usize) -> bool {
    value
        .as_str()
        .is_some_and(|text| text.len() <= limit && !text.contains('\0'))
}
fn validate_patterns(value: &Value, nonempty: bool) -> AppResult<()> {
    let patterns = value
        .as_array()
        .ok_or_else(|| invalid("projectConfigInvalid"))?;
    if patterns.len() > 64 || nonempty && patterns.is_empty() {
        return Err(invalid("projectConfigInvalid"));
    }
    for pattern in patterns {
        let pattern = pattern
            .as_str()
            .ok_or_else(|| invalid("projectConfigInvalid"))?;
        let normalized = pattern.replace('\\', "/");
        if normalized.is_empty()
            || normalized.len() > 256
            || normalized.starts_with('/')
            || normalized.contains([':', '\0'])
            || normalized.split('/').any(|part| part == "..")
        {
            return Err(invalid("projectConfigInvalid"));
        }
    }
    Ok(())
}
fn reject_credentials(value: &Value, depth: usize) -> AppResult<()> {
    if depth > 20 {
        return Err(invalid("projectConfigInvalid"));
    }
    match value {
        Value::Object(fields) => {
            for (key, child) in fields {
                let key = key.to_ascii_lowercase().replace(['_', '-'], "");
                if [
                    "apikey",
                    "accesstoken",
                    "refreshtoken",
                    "password",
                    "secret",
                    "authorization",
                    "headers",
                    "executable",
                    "command",
                    "programpath",
                ]
                .contains(&key.as_str())
                {
                    return Err(invalid("projectConfigContainsCredentials"));
                }
                reject_credentials(child, depth + 1)?;
            }
        }
        Value::Array(values) => {
            for child in values {
                reject_credentials(child, depth + 1)?;
            }
        }
        _ => {}
    }
    Ok(())
}
pub(crate) fn validate_config(config: &Value) -> AppResult<()> {
    if serde_json::to_vec(config)?.len() > MAX_CONFIG as usize {
        return Err(invalid("projectConfigTooLarge"));
    }
    if !config.is_object() || config["schemaVersion"].as_u64() != Some(1) {
        return Err(invalid("projectConfigVersion"));
    }
    reject_credentials(config, 0)?;
    if let Some(writing) = config.get("writing") {
        if !writing.is_object() {
            return Err(invalid("projectConfigInvalid"));
        }
        for (key, size) in [("language", 80), ("audience", 1000), ("tone", 1000)] {
            if let Some(value) = writing.get(key) {
                if !bounded_string(value, size) {
                    return Err(invalid("projectConfigInvalid"));
                }
            }
        }
        if let Some(glossary) = writing.get("glossary") {
            let glossary = glossary
                .as_array()
                .ok_or_else(|| invalid("projectConfigInvalid"))?;
            if glossary.len() > 128 {
                return Err(invalid("projectConfigInvalid"));
            }
            let mut preferred_terms = HashSet::new();
            let mut avoided_terms = HashSet::new();
            for term in glossary {
                if !term.is_object()
                    || !bounded_string(&term["preferred"], 200)
                    || term["preferred"]
                        .as_str()
                        .map_or(true, |s| s.trim().is_empty())
                {
                    return Err(invalid("projectConfigInvalid"));
                }
                if !preferred_terms.insert(term["preferred"].as_str().unwrap_or_default()) {
                    return Err(invalid("projectConfigInvalid"));
                }
                let avoid = term["avoid"]
                    .as_array()
                    .ok_or_else(|| invalid("projectConfigInvalid"))?;
                if avoid.len() > 32
                    || avoid.iter().any(|value| {
                        !bounded_string(value, 200)
                            || value.as_str().map_or(true, |s| s.trim().is_empty())
                    })
                {
                    return Err(invalid("projectConfigInvalid"));
                }
                for value in avoid {
                    if !avoided_terms.insert(value.as_str().unwrap_or_default()) {
                        return Err(invalid("projectConfigInvalid"));
                    }
                }
            }
        }
    }
    if let Some(search) = config.get("projectSearch") {
        if !search.is_object() {
            return Err(invalid("projectConfigInvalid"));
        }
        if search
            .get("enabledByDefault")
            .is_some_and(|v| !v.is_boolean())
        {
            return Err(invalid("projectConfigInvalid"));
        }
        if let Some(include) = search.get("include") {
            validate_patterns(include, true)?;
        }
        if let Some(exclude) = search.get("exclude") {
            validate_patterns(exclude, false)?;
        }
    }
    Ok(())
}

fn read_config(root: &Path) -> AppResult<Value> {
    let path = config_path(root, false)?;
    if !path.exists() {
        return Ok(json!({"config":null,"fingerprint":null}));
    }
    if std::fs::metadata(&path)?.len() > MAX_CONFIG {
        return Err(invalid("projectConfigTooLarge"));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&path)?
        .take(MAX_CONFIG + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_CONFIG as usize {
        return Err(invalid("projectConfigTooLarge"));
    }
    let config: Value =
        serde_json::from_slice(&bytes).map_err(|_| invalid("projectConfigInvalid"))?;
    validate_config(&config)?;
    Ok(json!({"config":config,"fingerprint":format!("{:x}",Sha256::digest(&bytes))}))
}
pub(crate) fn writing_rules(root: &Path) -> AppResult<Value> {
    Ok(read_config(root)?["config"]
        .get("writing")
        .cloned()
        .unwrap_or_else(|| json!({})))
}
pub(crate) fn project_search_config(root: &Path) -> AppResult<Option<Value>> {
    Ok(read_config(root)?["config"].get("projectSearch").cloned())
}
fn merge_config(original: &mut Value, patch: Value) {
    if let (Some(old), Some(new)) = (original.as_object_mut(), patch.as_object()) {
        for (key, value) in new {
            if let Some(existing) = old.get_mut(key) {
                merge_config(existing, value.clone());
            } else {
                old.insert(key.clone(), value.clone());
            }
        }
    } else {
        *original = patch;
    }
}
fn save_config(root: &Path, config: Value, expected: Option<String>) -> AppResult<Value> {
    let _guard = CONFIG_LOCK
        .lock()
        .map_err(|_| invalid("projectConfigInvalid"))?;
    validate_config(&config)?;
    let current = read_config(root)?;
    if current["fingerprint"].as_str() != expected.as_deref() {
        return Err(invalid("projectConfigConflict"));
    }
    let mut merged = current["config"].clone();
    merge_config(&mut merged, config);
    validate_config(&merged)?;
    let bytes = serde_json::to_vec_pretty(&merged)?;
    if bytes.len() > MAX_CONFIG as usize {
        return Err(invalid("projectConfigTooLarge"));
    }
    let path = config_path(root, true)?;
    atomic_write::write(&path, &bytes)?;
    read_config(root)
}
#[tauri::command]
pub async fn cmd_agent_project_load_config(
    state: tauri::State<'_, AppState>,
    window: tauri::WebviewWindow,
    root: PathBuf,
) -> AppResult<Value> {
    let root = resolve_owned_root(&state, window.label(), &root)?;
    tokio::task::spawn_blocking(move || read_config(&root))
        .await
        .map_err(|_| invalid("projectConfigInvalid"))?
}
#[tauri::command]
pub async fn cmd_agent_project_save_config(
    state: tauri::State<'_, AppState>,
    window: tauri::WebviewWindow,
    root: PathBuf,
    config: Value,
    expected_fingerprint: Option<String>,
) -> AppResult<Value> {
    let root = resolve_owned_root(&state, window.label(), &root)?;
    tokio::task::spawn_blocking(move || save_config(&root, config, expected_fingerprint))
        .await
        .map_err(|_| invalid("projectConfigInvalid"))?
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentIssue {
    id: String,
    kind: String,
    severity: String,
    message: String,
    from: usize,
    to: usize,
    line: usize,
    column: usize,
    evidence: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    replacement: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCheck {
    issues: Vec<DocumentIssue>,
    complete: bool,
    external_links_unchecked: usize,
    local_targets_checked: usize,
    truncated: bool,
    scope: String,
}
fn issue(
    markdown: &str,
    kind: &str,
    message: String,
    range: std::ops::Range<usize>,
    replacement: Option<String>,
) -> DocumentIssue {
    let from = range.start.min(markdown.len());
    let end = range.end.min(markdown.len());
    let excerpt = &markdown[from..end];
    let to = from
        + excerpt
            .char_indices()
            .nth(400)
            .map(|(offset, _)| offset)
            .unwrap_or(excerpt.len());
    let prefix = &markdown[..from];
    DocumentIssue {
        id: format!("{kind}-{from}-{to}"),
        kind: kind.into(),
        severity: "warning".into(),
        message,
        from: prefix.encode_utf16().count(),
        to: markdown[..to].encode_utf16().count(),
        line: prefix.bytes().filter(|b| *b == b'\n').count() + 1,
        column: prefix
            .rsplit('\n')
            .next()
            .unwrap_or("")
            .encode_utf16()
            .count()
            + 1,
        evidence: markdown[from..to].into(),
        replacement,
    }
}
fn check_document(
    markdown: &str,
    root: Option<&Path>,
    source: Option<&Path>,
    rules: &Value,
) -> AppResult<DocumentCheck> {
    if markdown.len() > MAX_DOCUMENT {
        return Err(invalid("contextTooLarge"));
    }
    let mut issues = Vec::new();
    let mut external = 0;
    let mut checked = 0;
    let mut truncated = false;
    let mut protected = 0usize;
    let mut last_heading = 0u8;
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_FOOTNOTES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_YAML_STYLE_METADATA_BLOCKS
        | Options::ENABLE_MATH;
    let glossary = rules["glossary"].as_array().cloned().unwrap_or_default();
    for (event, range) in Parser::new_ext(markdown, options).into_offset_iter() {
        if issues.len() >= MAX_ISSUES {
            truncated = true;
            break;
        }
        match event {
            Event::Start(Tag::CodeBlock(_) | Tag::MetadataBlock(_)) => protected += 1,
            Event::End(TagEnd::CodeBlock | TagEnd::MetadataBlock(_)) => {
                protected = protected.saturating_sub(1)
            }
            Event::Start(Tag::Heading { level, .. }) if protected == 0 => {
                let level = level as u8;
                if last_heading > 0 && level > last_heading + 1 {
                    issues.push(issue(
                        markdown,
                        "heading-level",
                        "Heading skips a level; check the document structure.".into(),
                        range,
                        None,
                    ));
                }
                last_heading = level;
            }
            Event::Start(Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. })
                if protected == 0 =>
            {
                let target = dest_url.as_ref();
                if target.is_empty() {
                    issues.push(issue(
                        markdown,
                        "empty-link",
                        "Link or image has an empty target.".into(),
                        range,
                        None,
                    ));
                    continue;
                }
                if target.starts_with('#') {
                    continue;
                }
                if target.contains("://")
                    || target.starts_with("//")
                    || target.starts_with("mailto:")
                    || target.starts_with("data:")
                {
                    external += 1;
                    continue;
                }
                if checked >= 128 {
                    truncated = true;
                    continue;
                }
                checked += 1;
                let target = target.split(['#', '?']).next().unwrap_or("");
                let decoded = match percent_encoding::percent_decode_str(target).decode_utf8() {
                    Ok(decoded) => decoded,
                    Err(_) => {
                        issues.push(issue(
                            markdown,
                            "local-target",
                            "Local target has invalid UTF-8 encoding.".into(),
                            range,
                            None,
                        ));
                        continue;
                    }
                };
                let path = Path::new(decoded.as_ref());
                let base = source.and_then(Path::parent).or(root);
                let scope = root.or_else(|| source.and_then(Path::parent));
                let message = if path.is_absolute() || decoded.contains([':', '\0']) {
                    Some("Absolute or non-file target was not checked outside this document's scope.")
                } else if let (Some(base), Some(scope)) = (base, scope) {
                    let candidate = base.join(path);
                    match std::fs::canonicalize(candidate) {
                        Ok(path) if path.starts_with(scope) => None,
                        Ok(_) => Some("Link target is outside the authorized document or project scope; it was not read."),
                        Err(_) => Some("Local link or image target is missing or unavailable."),
                    }
                } else {
                    Some("This local target cannot be checked until the document has a file location.")
                };
                if let Some(message) = message {
                    issues.push(issue(markdown, "local-target", message.into(), range, None));
                }
            }
            Event::Text(_) if protected == 0 => {
                let text = &markdown[range.clone()];
                for term in &glossary {
                    let Some(preferred) = term["preferred"].as_str() else {
                        continue;
                    };
                    for avoid in term["avoid"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                    {
                        if avoid == preferred {
                            continue;
                        }
                        for (index, _) in text.match_indices(avoid) {
                            if issues.len() >= MAX_ISSUES {
                                truncated = true;
                                break;
                            }
                            issues.push(issue(
                                markdown,
                                "glossary",
                                format!("Project glossary prefers “{preferred}” over “{avoid}”."),
                                range.start + index..range.start + index + avoid.len(),
                                Some(preferred.into()),
                            ));
                        }
                    }
                }
            }
            _ => {}
        }
    }
    Ok(DocumentCheck { issues, complete: !truncated, external_links_unchecked: external, local_targets_checked: checked, truncated,
        scope: "Current Markdown buffer: glossary, heading levels and local link/image existence. External URLs and linked heading contents are not verified.".into() })
}
#[tauri::command]
pub async fn cmd_agent_check_document(
    state: tauri::State<'_, AppState>,
    window: tauri::WebviewWindow,
    markdown: String,
    root: Option<PathBuf>,
    source_path: Option<PathBuf>,
) -> AppResult<DocumentCheck> {
    let root = root
        .as_ref()
        .map(|root| resolve_owned_root(&state, window.label(), root))
        .transpose()?;
    let source = source_path
        .as_ref()
        .map(|source| {
            if let Some(root) = &root {
                resolve_existing_inside(root, source, false)
            } else if state.is_document_source_authorized(source) {
                Ok(std::fs::canonicalize(source)?)
            } else {
                Err(invalid("projectCheckSourceNotAuthorized"))
            }
        })
        .transpose()?;
    tokio::task::spawn_blocking(move || {
        let rules = root
            .as_ref()
            .map(|root| writing_rules(root))
            .transpose()?
            .unwrap_or_else(|| json!({}));
        check_document(&markdown, root.as_deref(), source.as_deref(), &rules)
    })
    .await
    .map_err(|_| invalid("projectCheckFailed"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> Value {
        json!({"schemaVersion":1,"writing":{"language":"zh-CN","audience":"读者","tone":"简洁","glossary":[{"preferred":"MarkCaptain","avoid":["Mark Captain"]}]},"projectSearch":{"enabledByDefault":false,"include":["**/*.md"],"exclude":["exports/**"]}})
    }
    #[test]
    fn config_is_optional_versioned_and_does_not_create_files_on_read() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        assert!(read_config(&root).unwrap()["config"].is_null());
        assert!(!root.join(".markcaptain").exists());
        assert_eq!(writing_rules(&root).unwrap(), json!({}));
        assert!(project_search_config(&root).unwrap().is_none());
        let mut c = config();
        c["schemaVersion"] = json!(2);
        assert!(save_config(&root, c, None).is_err());
    }
    #[test]
    fn atomic_config_save_preserves_extensions_and_rejects_stale_writer() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let mut c = config();
        c["extension"] = json!({"future":true});
        c["writing"]["future"] = json!(7);
        let first = save_config(&root, c, None).unwrap();
        let f = first["fingerprint"].as_str().unwrap().to_owned();
        let second = save_config(&root, config(), Some(f.clone())).unwrap();
        assert_eq!(second["config"]["extension"]["future"], true);
        assert_eq!(second["config"]["writing"]["future"], 7);
        let mut next = config();
        next["writing"]["tone"] = json!("准确");
        let third = save_config(&root, next, Some(f.clone())).unwrap();
        assert_ne!(third["fingerprint"], first["fingerprint"]);
        assert!(save_config(&root, config(), Some(f)).is_err());
    }
    #[test]
    fn config_rejects_credentials_traversal_and_unbounded_fields() {
        for patch in [
            json!({"secret":"bad"}),
            json!({"writing":{"glossary":[{"preferred":"","avoid":[]}]}}),
            json!({"projectSearch":{"include":["../private/**"]}}),
        ] {
            let mut c = config();
            merge_config(&mut c, patch);
            assert!(validate_config(&c).is_err());
        }
    }
    #[test]
    fn oversized_pretty_config_preserves_the_previous_readable_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let mut original = config();
        original["extension"] = json!(vec![0; 20_000]);
        let compact = serde_json::to_vec(&original).unwrap();
        assert!(compact.len() < MAX_CONFIG as usize);
        assert!(serde_json::to_vec_pretty(&original).unwrap().len() > MAX_CONFIG as usize);
        let path = config_path(&root, true).unwrap();
        std::fs::write(&path, &compact).unwrap();
        let before = read_config(&root).unwrap();
        let error = save_config(
            &root,
            json!({"schemaVersion": 1, "writing": {"tone": "new tone"}}),
            Some(before["fingerprint"].as_str().unwrap().into()),
        )
        .unwrap_err();
        assert_eq!(error.to_string(), "agent:projectConfigTooLarge");
        assert_eq!(std::fs::read(&path).unwrap(), compact);
        assert_eq!(read_config(&root).unwrap(), before);
        assert_eq!(writing_rules(&root).unwrap(), original["writing"]);
        assert!(project_search_config(&root).is_ok());
    }

    #[test]
    fn oversized_pretty_config_is_rejected_before_creating_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let value = json!({"schemaVersion":1,"extension":vec![0;20_000]});
        assert_eq!(
            save_config(&root, value, None).unwrap_err().to_string(),
            "agent:projectConfigTooLarge"
        );
        assert!(!root.join(".markcaptain").exists());
    }
    #[test]
    fn terminology_checks_prose_with_utf16_positions_but_not_code_or_frontmatter() {
        let md="---\ntitle: Mark Captain\n---\n# 标题\n\n😀 Mark Captain 与 `Mark Captain`\n\n```text\nMark Captain\n```\n";
        let r = check_document(md, None, None, &config()["writing"]).unwrap();
        let terms: Vec<_> = r.issues.iter().filter(|i| i.kind == "glossary").collect();
        assert_eq!(terms.len(), 1);
        let i = terms[0];
        assert_eq!(i.evidence, "Mark Captain");
        assert_eq!(i.replacement.as_deref(), Some("MarkCaptain"));
        assert_eq!(i.column, 4);
        assert_eq!(
            md.encode_utf16()
                .skip(i.from)
                .take(i.to - i.from)
                .collect::<Vec<_>>(),
            "Mark Captain".encode_utf16().collect::<Vec<_>>()
        );
    }
    #[test]
    fn checks_existing_missing_and_outside_targets_without_fetching_remote_urls() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::write(root.join("ok.svg"), "<svg/>").unwrap();
        let md="# First\n\n### Jump\n\n![ok](ok.svg) [missing](missing.md) [remote](https://example.com/) [outside](../secret.md)\n";
        let r = check_document(md, Some(&root), Some(&root.join("main.md")), &json!({})).unwrap();
        assert!(r.complete);
        assert_eq!(r.external_links_unchecked, 1);
        assert_eq!(r.local_targets_checked, 3);
        assert_eq!(
            r.issues.iter().filter(|i| i.kind == "local-target").count(),
            2
        );
        assert!(r.issues.iter().any(|i| i.kind == "heading-level"));
    }
    #[test]
    fn capped_check_results_explicitly_report_incompleteness() {
        let md = "Mark Captain ".repeat(250);
        let r = check_document(&md, None, None, &config()["writing"]).unwrap();
        assert_eq!(r.issues.len(), MAX_ISSUES);
        assert!(!r.complete);
        assert!(r.truncated);
    }
    #[cfg(unix)]
    #[test]
    fn config_symlink_cannot_escape_project() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join(".markcaptain")).unwrap();
        let canonical = std::fs::canonicalize(root.path()).unwrap();
        assert!(save_config(&canonical, config(), None).is_err());
    }
}
