//! Explicit, window-scoped project search for the writing Agent.
//!
//! Candidate discovery is read-only and bounded. A result ID is not a file
//! path and does not authorize a read until `read_project_document` is called.
use super::{failure, AgentState, Context};
use crate::{
    app::{is_markdown_document, AppState},
    commands::{agent_project, workspace::resolve_open_workspace},
    error::{AppError, AppResult},
};
use ignore::{
    overrides::{Override, OverrideBuilder},
    Match,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Digest;
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock,
    },
};
use tauri::{State, WebviewWindow};
use walkdir::{DirEntry, WalkDir};

const MAX_INCLUDE: usize = 64;
const MAX_EXCLUDE: usize = 128;
const MAX_PATTERN_BYTES: usize = 256;
const MAX_BUFFERS: usize = 128;
const MAX_BUFFER_BYTES: usize = 2_000_000;
const MAX_BUFFER_TOTAL: usize = 16 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 2_000_000;
const MAX_SCAN_FILES: usize = 5_000;
const MAX_WALK_ENTRIES: usize = 100_000;
const MAX_TOTAL_SCAN_BYTES: usize = 128 * 1024 * 1024;
// Keep aggregate immutable snapshots below the renderer's bounded reference
// cache as well as limiting per-task backend memory.
const MAX_CACHED_BYTES: usize = 16 * 1024 * 1024;
const MAX_CANDIDATES: usize = 50;
static MAX_READ_DOCUMENTS: LazyLock<usize> = LazyLock::new(|| {
    serde_json::from_str::<Value>(include_str!(
        "../../../../src/common/agent-project-limits.json"
    ))
    .expect("valid shared project limits")["maxReadDocuments"]
        .as_u64()
        .expect("shared project read limit") as usize
});
const MAX_QUERY_BYTES: usize = 2_000;
const MAX_SNIPPET_CHARS: usize = 360;
const MAX_GRANTS_PER_WINDOW: usize = 16;

const HARD_EXCLUDES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "build",
    "dist",
    "output",
    "exports",
    "cache",
    ".markcaptain/cache",
];

#[derive(Clone)]
pub(super) struct ProjectGrant {
    pub(super) id: String,
    pub(super) owner: String,
    pub(super) root: PathBuf,
    pub(super) include: Vec<String>,
    pub(super) exclude: Vec<String>,
    config_fingerprint: Option<String>,
}

pub(super) type ProjectGrantStore = Arc<Mutex<HashMap<String, ProjectGrant>>>;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSearchRequest {
    pub grant_id: String,
    #[serde(default)]
    pub buffers: Vec<DirtyBuffer>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirtyBuffer {
    pub path: PathBuf,
    pub markdown: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGrantView {
    pub grant_id: String,
    pub root: PathBuf,
    pub include: Vec<String>,
    pub exclude: Vec<String>,
}

struct ProjectDocument {
    document_id: String,
    path: PathBuf,
    relative_path: String,
    markdown: String,
    snapshot: Option<Context>,
    source_emitted: bool,
}

pub(super) struct ProjectAccess {
    grant: ProjectGrant,
    task_id: String,
    buffers: HashMap<PathBuf, String>,
    documents: HashMap<String, ProjectDocument>,
    ids_by_path: HashMap<PathBuf, String>,
    cached_bytes: usize,
    scanned_bytes: usize,
    scanned_files: usize,
    walked_entries: usize,
    searches: usize,
    search_cache: HashMap<String, Value>,
}

fn invalid(code: &str) -> AppError {
    failure(code)
}

fn resolve_owned_root(state: &AppState, owner: &str, requested: &Path) -> AppResult<PathBuf> {
    let root = resolve_open_workspace(state, requested)?;
    if !state
        .workspace_roots_for_window(owner)
        .iter()
        .any(|candidate| candidate == &root)
    {
        return Err(invalid("projectNotOwned"));
    }
    Ok(root)
}

fn config_fingerprint(root: &Path) -> AppResult<Option<String>> {
    let config =
        agent_project::project_search_config(root).map_err(|_| invalid("projectConfigInvalid"))?;
    let mut output_directories = output_exclusion_patterns(root);
    output_directories.sort();
    let bytes = serde_json::to_vec(&json!({
        "projectSearch": config,
        "exportOutputDirectories": output_directories,
    }))
    .map_err(|_| invalid("projectConfigInvalid"))?;
    Ok(Some(format!("{:x}", sha2::Sha256::digest(bytes))))
}

fn output_exclusion_patterns(root: &Path) -> Vec<String> {
    crate::commands::export_project::output_directories(root)
        .into_iter()
        .filter_map(|directory| directory.strip_prefix(root).ok().map(relative_display))
        .filter(|relative| !relative.is_empty())
        .map(|relative| format!("{relative}/**"))
        .collect()
}

fn normalize_patterns(values: &[String], max: usize) -> AppResult<Vec<String>> {
    if values.len() > max {
        return Err(invalid("projectPatternLimit"));
    }
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for value in values {
        let normalized = value.replace('\\', "/");
        let path = Path::new(&normalized);
        if normalized.trim().is_empty()
            || normalized.len() > MAX_PATTERN_BYTES
            || normalized.contains([':', '\0'])
            || normalized.starts_with('/')
            || path.is_absolute()
            || path.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
            || normalized.starts_with('!')
        {
            return Err(invalid("projectPatternInvalid"));
        }
        if seen.insert(normalized.clone()) {
            result.push(normalized);
        }
    }
    Ok(result)
}

fn configured_patterns(config: Option<&Value>, key: &str) -> Vec<String> {
    config
        .and_then(|value| value.get(key))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn effective_patterns(
    root: &Path,
    config: Option<&Value>,
    include: &[String],
    exclude: &[String],
) -> AppResult<(Vec<String>, Vec<String>)> {
    let include_defaults = configured_patterns(config, "include");
    let requested_include = if include.is_empty() {
        if include_defaults.is_empty() {
            vec!["**/*.md".to_owned()]
        } else {
            include_defaults
        }
    } else {
        include.to_vec()
    };
    let mut effective_exclude = configured_patterns(config, "exclude");
    effective_exclude.extend(exclude.iter().cloned());
    effective_exclude.extend(output_exclusion_patterns(root));
    effective_exclude.extend(HARD_EXCLUDES.iter().map(|pattern| (*pattern).to_owned()));
    Ok((
        normalize_patterns(&requested_include, MAX_INCLUDE)?,
        normalize_patterns(&effective_exclude, MAX_EXCLUDE)?,
    ))
}

fn compile_scope(root: &Path, include: &[String], exclude: &[String]) -> AppResult<Override> {
    let mut builder = OverrideBuilder::new(root);
    builder
        .case_insensitive(cfg!(windows))
        .map_err(|_| invalid("projectPatternInvalid"))?;
    for pattern in include {
        builder
            .add(pattern)
            .map_err(|_| invalid("projectPatternInvalid"))?;
    }
    for pattern in exclude {
        builder
            .add(&format!("!{pattern}"))
            .map_err(|_| invalid("projectPatternInvalid"))?;
    }
    builder
        .build()
        .map_err(|_| invalid("projectPatternInvalid"))
}

fn built_in_excluded(relative: &Path) -> bool {
    let components: Vec<String> = relative
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .map(|component| component.to_ascii_lowercase())
        .collect();
    if components.iter().any(|component| {
        matches!(
            component.as_str(),
            ".git" | "node_modules" | "target" | "build" | "dist" | "output" | "exports" | "cache"
        )
    }) {
        return true;
    }
    components
        .windows(2)
        .any(|pair| pair == [".markcaptain", "cache"])
}

fn within_root(root: &Path, path: &Path) -> AppResult<PathBuf> {
    let canonical = std::fs::canonicalize(path).map_err(|_| invalid("projectPathUnavailable"))?;
    if !canonical.starts_with(root) || !canonical.is_file() {
        return Err(invalid("projectPathOutsideRoot"));
    }
    Ok(canonical)
}

fn read_bounded_file(path: &Path) -> AppResult<Vec<u8>> {
    let file = File::open(path).map_err(|_| invalid("projectPathUnavailable"))?;
    let mut bytes = Vec::with_capacity((MAX_FILE_BYTES as usize).saturating_add(1));
    file.take(MAX_FILE_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| invalid("projectPathUnavailable"))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(invalid("projectFileTooLarge"));
    }
    Ok(bytes)
}

fn canonical_buffer_path(root: &Path, path: &Path) -> AppResult<PathBuf> {
    if !path.is_absolute() || !is_markdown_document(path) {
        return Err(invalid("projectBufferInvalid"));
    }
    let canonical = match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(invalid("projectBufferSymlink"));
        }
        Ok(_) => std::fs::canonicalize(path).map_err(|_| invalid("projectBufferInvalid"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .ok_or_else(|| invalid("projectBufferInvalid"))?;
            let parent =
                std::fs::canonicalize(parent).map_err(|_| invalid("projectBufferInvalid"))?;
            parent.join(
                path.file_name()
                    .ok_or_else(|| invalid("projectBufferInvalid"))?,
            )
        }
        Err(_) => return Err(invalid("projectBufferInvalid")),
    };
    if !canonical.starts_with(root) || !is_markdown_document(&canonical) {
        return Err(invalid("projectBufferOutsideRoot"));
    }
    Ok(canonical)
}

pub(super) fn validate_search_request(request: &ProjectSearchRequest) -> AppResult<()> {
    uuid::Uuid::parse_str(&request.grant_id).map_err(|_| invalid("projectGrantInvalid"))?;
    if request.buffers.len() > MAX_BUFFERS {
        return Err(invalid("projectBufferLimit"));
    }
    let mut bytes = 0usize;
    for buffer in &request.buffers {
        if buffer.path.as_os_str().to_string_lossy().len() > 8192
            || buffer.markdown.len() > MAX_BUFFER_BYTES
        {
            return Err(invalid("projectBufferLimit"));
        }
        bytes = bytes.saturating_add(buffer.markdown.len());
        if bytes > MAX_BUFFER_TOTAL {
            return Err(invalid("projectBufferLimit"));
        }
    }
    Ok(())
}

pub(super) fn prepare_access(
    state: &AppState,
    grants: &ProjectGrantStore,
    owner: &str,
    task_id: &str,
    request: &ProjectSearchRequest,
) -> AppResult<ProjectAccess> {
    validate_search_request(request)?;
    let grant = validate_live_grant(state, grants, owner, &request.grant_id)?;
    let mut buffers = HashMap::new();
    for buffer in &request.buffers {
        let path = canonical_buffer_path(&grant.root, &buffer.path)?;
        if built_in_excluded(
            path.strip_prefix(&grant.root)
                .map_err(|_| invalid("projectBufferOutsideRoot"))?,
        ) {
            continue;
        }
        let scope = compile_scope(&grant.root, &grant.include, &grant.exclude)?;
        let relative = path
            .strip_prefix(&grant.root)
            .map_err(|_| invalid("projectBufferOutsideRoot"))?;
        if !scope.matched(relative, false).is_whitelist() {
            continue;
        }
        if let Some(previous) = buffers.insert(path, buffer.markdown.clone()) {
            if previous != buffer.markdown {
                return Err(invalid("projectBufferConflict"));
            }
        }
    }
    Ok(ProjectAccess {
        grant,
        task_id: task_id.to_owned(),
        buffers,
        documents: HashMap::new(),
        ids_by_path: HashMap::new(),
        cached_bytes: 0,
        scanned_bytes: 0,
        scanned_files: 0,
        walked_entries: 0,
        searches: 0,
        search_cache: HashMap::new(),
    })
}

fn validate_live_grant(
    state: &AppState,
    grants: &ProjectGrantStore,
    owner: &str,
    grant_id: &str,
) -> AppResult<ProjectGrant> {
    let grant = grants
        .lock()
        .get(grant_id)
        .cloned()
        .ok_or_else(|| invalid("projectGrantExpired"))?;
    if grant.owner != owner {
        return Err(invalid("projectGrantExpired"));
    }
    let root = resolve_owned_root(state, owner, &grant.root)?;
    if root != grant.root || config_fingerprint(&root)? != grant.config_fingerprint {
        return Err(invalid("projectGrantChanged"));
    }
    Ok(grant)
}

#[tauri::command]
pub async fn cmd_agent_project_grant(
    state: State<'_, AppState>,
    agent: State<'_, AgentState>,
    window: WebviewWindow,
    root: PathBuf,
    include: Vec<String>,
    exclude: Vec<String>,
) -> AppResult<ProjectGrantView> {
    let owner = window.label().to_owned();
    let root = resolve_owned_root(&state, &owner, &root)?;
    let config =
        agent_project::project_search_config(&root).map_err(|_| invalid("projectConfigInvalid"))?;
    let config_signature = config_fingerprint(&root)?;
    let (include, exclude) = effective_patterns(&root, config.as_ref(), &include, &exclude)?;
    compile_scope(&root, &include, &exclude)?;

    let mut grants = agent.project_grants.lock();
    grants.retain(|_, grant| !(grant.owner == owner && grant.root == root));
    let owned = grants.values().filter(|grant| grant.owner == owner).count();
    if owned >= MAX_GRANTS_PER_WINDOW {
        return Err(invalid("projectGrantLimit"));
    }
    // A new authorization for this root supersedes the old root grant, making
    // every candidate ID from the prior selection unusable immediately.
    let grant_id = uuid::Uuid::new_v4().to_string();
    grants.insert(
        grant_id.clone(),
        ProjectGrant {
            id: grant_id.clone(),
            owner,
            root: root.clone(),
            include: include.clone(),
            exclude: exclude.clone(),
            config_fingerprint: config_signature,
        },
    );
    Ok(ProjectGrantView {
        grant_id,
        root,
        include,
        exclude,
    })
}

#[tauri::command]
pub fn cmd_agent_project_revoke(
    agent: State<'_, AgentState>,
    window: WebviewWindow,
    grant_id: String,
) -> AppResult<()> {
    let mut grants = agent.project_grants.lock();
    if grants
        .get(&grant_id)
        .is_some_and(|grant| grant.owner == window.label())
    {
        grants.remove(&grant_id);
    }
    Ok(())
}

pub(super) fn revoke_window(grants: &ProjectGrantStore, owner: &str) {
    grants.lock().retain(|_, grant| grant.owner != owner);
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectSearchFilters {
    pub path_prefix: Option<String>,
    pub title: Option<String>,
    pub limit: Option<usize>,
}

fn validate_filters(filters: Option<&Value>) -> AppResult<ProjectSearchFilters> {
    let Some(filters) = filters else {
        return Ok(ProjectSearchFilters::default());
    };
    let filters: ProjectSearchFilters =
        serde_json::from_value(filters.clone()).map_err(|_| invalid("projectFiltersInvalid"))?;
    if filters.path_prefix.as_ref().is_some_and(|value| {
        value.len() > 512
            || value.starts_with('/')
            || value.starts_with('\\')
            || value.contains([':', '\0'])
            || value.replace('\\', "/").split('/').any(|part| part == "..")
    }) || filters
        .title
        .as_ref()
        .is_some_and(|value| value.len() > 200 || value.chars().any(char::is_control))
        || filters
            .limit
            .is_some_and(|limit| !(1..=MAX_CANDIDATES).contains(&limit))
    {
        return Err(invalid("projectFiltersInvalid"));
    }
    Ok(filters)
}

fn case_contains(haystack: &str, needle: &str) -> Option<usize> {
    haystack.to_lowercase().find(&needle.to_lowercase())
}

fn path_has_prefix(path: &str, prefix: &str) -> bool {
    let prefix = prefix.replace('\\', "/").trim_matches('/').to_owned();
    let path = path.replace('\\', "/");
    prefix.is_empty() || path == prefix || path.starts_with(&format!("{prefix}/"))
}

fn title(markdown: &str, relative: &str) -> String {
    let mut in_frontmatter = markdown.starts_with("---\n");
    let mut in_fence = false;
    for (index, line) in markdown.lines().take(400).enumerate() {
        if index == 0 && in_frontmatter {
            continue;
        }
        if in_frontmatter {
            if line.trim() == "---" {
                in_frontmatter = false;
                continue;
            }
            if let Some((key, value)) = line.split_once(':') {
                if key.trim().eq_ignore_ascii_case("title") {
                    let value = value.trim().trim_matches(['"', '\'']);
                    if !value.is_empty() {
                        return value.chars().take(160).collect();
                    }
                }
            }
            continue;
        }
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let hashes = trimmed.chars().take_while(|ch| *ch == '#').count();
        if (1..=6).contains(&hashes) && trimmed.chars().nth(hashes) == Some(' ') {
            let value = trimmed[hashes + 1..].trim();
            if !value.is_empty() {
                return value.chars().take(160).collect();
            }
        }
    }
    Path::new(relative)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(relative)
        .chars()
        .take(160)
        .collect()
}

fn snippet(markdown: &str, query: &str) -> Option<(usize, String)> {
    let query_lower = query.trim().to_lowercase();
    let terms: Vec<&str> = query_lower
        .split_whitespace()
        .filter(|term| !term.is_empty())
        .collect();
    if terms.is_empty() {
        return None;
    }
    for (index, line) in markdown.lines().enumerate() {
        let lower = line.to_lowercase();
        let matched = terms.iter().all(|term| lower.contains(term));
        if !matched {
            continue;
        }
        let position = terms.iter().find_map(|term| lower.find(term)).unwrap_or(0);
        let safe_position = line
            .char_indices()
            .take_while(|(offset, _)| *offset <= position)
            .map(|(offset, _)| offset)
            .last()
            .unwrap_or(0);
        let start = line[..safe_position]
            .char_indices()
            .rev()
            .nth(MAX_SNIPPET_CHARS / 2)
            .map_or(0, |(offset, _)| offset);
        let excerpt = line[start..].chars().take(MAX_SNIPPET_CHARS).collect();
        return Some((index + 1, excerpt));
    }
    None
}

fn relative_display(path: &Path) -> String {
    path.components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>()
        .join("/")
}

fn is_excluded_directory(entry: &DirEntry, root: &Path) -> bool {
    let relative = match entry.path().strip_prefix(root) {
        Ok(value) => value,
        Err(_) => return true,
    };
    entry.file_type().is_symlink() || built_in_excluded(relative)
}

fn scoped_path(scope: &Override, root: &Path, path: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    if built_in_excluded(relative) {
        return false;
    }
    matches!(scope.matched(relative, false), Match::Whitelist(_))
}

impl ProjectAccess {
    pub(super) fn validate(
        &self,
        state: &AppState,
        grants: &ProjectGrantStore,
        owner: &str,
    ) -> AppResult<()> {
        let active = validate_live_grant(state, grants, owner, &self.grant.id)?;
        if active.root != self.grant.root
            || active.include != self.grant.include
            || active.exclude != self.grant.exclude
        {
            return Err(invalid("projectGrantChanged"));
        }
        Ok(())
    }

    pub(super) fn search(
        &mut self,
        state: &AppState,
        grants: &ProjectGrantStore,
        owner: &str,
        query: &str,
        filters: Option<&Value>,
        cancelled: &AtomicBool,
    ) -> AppResult<Value> {
        if cancelled.load(Ordering::Relaxed) {
            return Err(invalid("cancelled"));
        }
        self.validate(state, grants, owner)?;
        let query = query.trim();
        if query.is_empty() || query.len() > MAX_QUERY_BYTES || query.chars().any(char::is_control)
        {
            return Err(invalid("projectQueryInvalid"));
        }
        let filters = validate_filters(filters)?;
        let cache_key = format!(
            "{}\u{0}{}\u{0}{}\u{0}{}\u{0}{:?}",
            self.grant.id,
            query,
            filters.path_prefix.as_deref().unwrap_or(""),
            filters.title.as_deref().unwrap_or(""),
            filters.limit
        );
        if let Some(cached) = self.search_cache.get(&cache_key) {
            if cancelled.load(Ordering::Relaxed) {
                return Err(invalid("cancelled"));
            }
            self.validate(state, grants, owner)?;
            return Ok(cached.clone());
        }
        if self.searches >= 8 {
            return Err(invalid("projectSearchLimit"));
        }
        self.searches += 1;
        let scope = compile_scope(&self.grant.root, &self.grant.include, &self.grant.exclude)?;
        let mut matches = Vec::<Value>::new();
        let mut complete = true;
        let mut skipped = 0usize;
        let mut scanned = 0usize;
        let limit = filters.limit.unwrap_or(20).min(MAX_CANDIDATES);
        let mut processed = HashSet::<PathBuf>::new();
        let mut exhausted_budget = false;

        // Candidates already occupy the bounded cache. Reuse their content
        // before applying discovery budgets, without scanning or charging it again.
        for doc in self.documents.values() {
            processed.insert(doc.path.clone());
            if filters
                .path_prefix
                .as_ref()
                .is_some_and(|prefix| !path_has_prefix(&doc.relative_path, prefix))
            {
                continue;
            }
            let Some((line, excerpt)) = snippet(&doc.markdown, query) else {
                continue;
            };
            let doc_title = title(&doc.markdown, &doc.relative_path);
            if filters
                .title
                .as_ref()
                .is_some_and(|filter| case_contains(&doc_title, filter).is_none())
            {
                continue;
            }
            if matches.len() >= limit {
                complete = false;
                exhausted_budget = true;
                continue;
            }
            let source = if self.buffers.contains_key(&doc.path) {
                "buffer"
            } else {
                "disk"
            };
            matches.push(json!({"documentId":doc.document_id,"path":doc.relative_path,"title":doc_title,
                "snippet":excerpt,"line":line,"source":source,"indexStatus":"literal-search","read":"on-demand"}));
        }

        for entry in WalkDir::new(&self.grant.root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| !is_excluded_directory(entry, &self.grant.root))
        {
            if cancelled.load(Ordering::Relaxed) {
                return Err(invalid("cancelled"));
            }
            if self.walked_entries >= MAX_WALK_ENTRIES {
                complete = false;
                exhausted_budget = true;
                break;
            }
            self.walked_entries += 1;
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    skipped += 1;
                    complete = false;
                    continue;
                }
            };
            if entry.file_type().is_symlink()
                || !entry.file_type().is_file()
                || !is_markdown_document(entry.path())
            {
                continue;
            }
            let canonical = match within_root(&self.grant.root, entry.path()) {
                Ok(path) => path,
                Err(_) => {
                    skipped += 1;
                    complete = false;
                    continue;
                }
            };
            if !processed.insert(canonical.clone()) {
                continue;
            }
            if !scoped_path(&scope, &self.grant.root, &canonical) {
                continue;
            }
            let relative = canonical
                .strip_prefix(&self.grant.root)
                .map_err(|_| invalid("projectPathOutsideRoot"))?;
            let relative_text = relative_display(relative);
            if filters
                .path_prefix
                .as_ref()
                .is_some_and(|prefix| !path_has_prefix(&relative_text, prefix))
            {
                continue;
            }
            if self.scanned_files >= MAX_SCAN_FILES {
                complete = false;
                exhausted_budget = true;
                break;
            }
            self.scanned_files += 1;
            scanned += 1;
            let markdown = if let Some(buffer) = self.buffers.get(&canonical) {
                buffer.clone()
            } else {
                let metadata = match std::fs::metadata(&canonical) {
                    Ok(metadata) => metadata,
                    Err(_) => {
                        skipped += 1;
                        complete = false;
                        continue;
                    }
                };
                if metadata.len() > MAX_FILE_BYTES {
                    skipped += 1;
                    complete = false;
                    continue;
                }
                if self.scanned_bytes.saturating_add(metadata.len() as usize) > MAX_TOTAL_SCAN_BYTES
                {
                    complete = false;
                    exhausted_budget = true;
                    break;
                }
                let bytes = match read_bounded_file(&canonical) {
                    Ok(bytes) => bytes,
                    Err(error) if error.to_string() == "agent:projectFileTooLarge" => {
                        skipped += 1;
                        complete = false;
                        continue;
                    }
                    Err(_) => {
                        skipped += 1;
                        complete = false;
                        continue;
                    }
                };
                match crate::filesystem::encoding::detect_and_decode(&bytes) {
                    Ok((text, _, false)) => text,
                    _ => {
                        skipped += 1;
                        complete = false;
                        continue;
                    }
                }
            };
            let next_total = self.scanned_bytes.saturating_add(markdown.len());
            if next_total > MAX_TOTAL_SCAN_BYTES {
                complete = false;
                exhausted_budget = true;
                break;
            }
            self.scanned_bytes = next_total;
            if let Some((line, excerpt)) = snippet(&markdown, query) {
                let doc_title = title(&markdown, &relative_text);
                if filters
                    .title
                    .as_ref()
                    .is_some_and(|filter| case_contains(&doc_title, filter).is_none())
                {
                    continue;
                }
                if matches.len() >= limit
                    || self.documents.len() >= MAX_CANDIDATES
                    || self.cached_bytes.saturating_add(markdown.len()) > MAX_CACHED_BYTES
                {
                    complete = false;
                    exhausted_budget = true;
                    continue;
                }
                let id = self
                    .ids_by_path
                    .get(&canonical)
                    .cloned()
                    .unwrap_or_else(|| {
                        let id = format!("project-{}-{}", self.grant.id, uuid::Uuid::new_v4());
                        self.ids_by_path.insert(canonical.clone(), id.clone());
                        id
                    });
                let source = if self.buffers.contains_key(&canonical) {
                    "buffer"
                } else {
                    "disk"
                };
                if !self.documents.contains_key(&id) {
                    self.cached_bytes = self.cached_bytes.saturating_add(markdown.len());
                    self.documents.insert(
                        id.clone(),
                        ProjectDocument {
                            document_id: id.clone(),
                            path: canonical,
                            relative_path: relative_text.clone(),
                            markdown,
                            snapshot: None,
                            source_emitted: false,
                        },
                    );
                }
                matches.push(json!({"documentId":id,"path":relative_text,"title":doc_title,"snippet":excerpt,"line":line,
                    "source":source,"indexStatus":"literal-search","read":"on-demand"}));
            }
        }

        // A dirty buffer may refer to a newly-created file that is not present
        // in the directory walk. It is still eligible if its explicit path is
        // inside this grant and matches the selected scope.
        for (path, markdown) in self.buffers.clone() {
            if cancelled.load(Ordering::Relaxed) {
                return Err(invalid("cancelled"));
            }
            if processed.contains(&path) || !scoped_path(&scope, &self.grant.root, &path) {
                continue;
            }
            processed.insert(path.clone());
            let relative = path
                .strip_prefix(&self.grant.root)
                .map_err(|_| invalid("projectBufferOutsideRoot"))?;
            let relative_text = relative_display(relative);
            if filters
                .path_prefix
                .as_ref()
                .is_some_and(|prefix| !path_has_prefix(&relative_text, prefix))
            {
                continue;
            }
            if self.scanned_files >= MAX_SCAN_FILES
                || self.scanned_bytes.saturating_add(markdown.len()) > MAX_TOTAL_SCAN_BYTES
            {
                complete = false;
                exhausted_budget = true;
                break;
            }
            self.scanned_files += 1;
            self.scanned_bytes = self.scanned_bytes.saturating_add(markdown.len());
            scanned += 1;
            if let Some((line, excerpt)) = snippet(&markdown, query) {
                let doc_title = title(&markdown, &relative_text);
                if filters
                    .title
                    .as_ref()
                    .is_some_and(|filter| case_contains(&doc_title, filter).is_none())
                {
                    continue;
                }
                if matches.len() >= limit
                    || self.documents.len() >= MAX_CANDIDATES
                    || self.cached_bytes.saturating_add(markdown.len()) > MAX_CACHED_BYTES
                {
                    complete = false;
                    exhausted_budget = true;
                    continue;
                }
                let id = self.ids_by_path.get(&path).cloned().unwrap_or_else(|| {
                    let id = format!("project-{}-{}", self.grant.id, uuid::Uuid::new_v4());
                    self.ids_by_path.insert(path.clone(), id.clone());
                    id
                });
                if !self.documents.contains_key(&id) {
                    self.cached_bytes = self.cached_bytes.saturating_add(markdown.len());
                    self.documents.insert(
                        id.clone(),
                        ProjectDocument {
                            document_id: id.clone(),
                            path,
                            relative_path: relative_text.clone(),
                            markdown,
                            snapshot: None,
                            source_emitted: false,
                        },
                    );
                }
                matches.push(json!({"documentId":id,"path":relative_text,"title":doc_title,"snippet":excerpt,"line":line,
                    "source":"buffer","indexStatus":"literal-search","read":"on-demand"}));
            }
        }
        if exhausted_budget {
            complete = false;
        }
        let response = json!({"results":matches,"complete":complete,"completeness":{"mode":"bounded-literal-search","complete":complete,
            "scannedFiles":scanned,"skippedFiles":skipped,"scanBytes":self.scanned_bytes,
            "reason":if complete { Value::Null } else { json!(if exhausted_budget {"searchBudgetReached"} else {"someFilesSkipped"}) }}});
        if cancelled.load(Ordering::Relaxed) {
            return Err(invalid("cancelled"));
        }
        self.validate(state, grants, owner)?;
        self.search_cache.insert(cache_key, response.clone());
        Ok(response)
    }

    pub(super) fn read(
        &mut self,
        state: &AppState,
        grants: &ProjectGrantStore,
        owner: &str,
        document_id: &str,
        start_line: usize,
        end_line: usize,
        cancelled: &AtomicBool,
    ) -> AppResult<(Value, Option<Value>)> {
        if cancelled.load(Ordering::Relaxed) {
            return Err(invalid("cancelled"));
        }
        self.validate(state, grants, owner)?;
        let document = self
            .documents
            .get(document_id)
            .ok_or_else(|| invalid("projectDocumentNotFound"))?;
        if !document.source_emitted
            && self
                .documents
                .values()
                .filter(|doc| doc.source_emitted)
                .count()
                >= *MAX_READ_DOCUMENTS
        {
            return Err(invalid("projectReadBudgetReached"));
        }
        let (result, source_event, emit_source) = {
            let doc = self
                .documents
                .get_mut(document_id)
                .ok_or_else(|| invalid("projectDocumentNotFound"))?;
            if doc.snapshot.is_none() {
                let canonical = within_root(&self.grant.root, &doc.path)?;
                let relative = canonical
                    .strip_prefix(&self.grant.root)
                    .map_err(|_| invalid("projectPathOutsideRoot"))?;
                let scope =
                    compile_scope(&self.grant.root, &self.grant.include, &self.grant.exclude)?;
                if !scoped_path(&scope, &self.grant.root, &canonical) {
                    return Err(invalid("projectDocumentOutsideScope"));
                }
                let relative_text = relative_display(relative);
                let markdown = if let Some(buffer) = self.buffers.get(&canonical) {
                    buffer.clone()
                } else {
                    let metadata = std::fs::metadata(&canonical)
                        .map_err(|_| invalid("projectPathUnavailable"))?;
                    if metadata.len() > MAX_FILE_BYTES {
                        return Err(invalid("projectDocumentTooLarge"));
                    }
                    let bytes = read_bounded_file(&canonical)?;
                    if cancelled.load(Ordering::Relaxed) {
                        return Err(invalid("cancelled"));
                    }
                    let (markdown, _, lossy) =
                        crate::filesystem::encoding::detect_and_decode(&bytes)
                            .map_err(|_| invalid("projectDocumentUnreadable"))?;
                    if lossy {
                        return Err(invalid("projectDocumentUnreadable"));
                    }
                    markdown
                };
                let next_cache = self
                    .cached_bytes
                    .saturating_sub(doc.markdown.len())
                    .saturating_add(markdown.len());
                if next_cache > MAX_CACHED_BYTES {
                    return Err(invalid("projectReadBudgetReached"));
                }
                self.cached_bytes = next_cache;
                doc.markdown = markdown;
                doc.path = canonical;
                doc.relative_path = relative_text;
            }
            let snapshot = doc.snapshot.get_or_insert_with(|| Context {
                name: doc.relative_path.clone(),
                markdown: doc.markdown.clone(),
                // Project anchors must never accidentally be accepted as edit
                // anchors for the current document, whose id is the request id.
                snapshot_id: format!("{}:{}", self.task_id, doc.document_id),
                offset: 0,
            });
            let call = super::protocol::Call {
                id: uuid::Uuid::new_v4().to_string(),
                name: "read_document".into(),
                arguments: json!({"startLine":start_line,"endLine":end_line}).to_string(),
            };
            let (mut result, _) = super::protocol::execute(&call, Some(snapshot), true);
            let emit_source = result.get("error").is_none() && !doc.source_emitted;
            let source_event = if emit_source {
                result["documentId"] = json!(doc.document_id);
                Some(json!({"documentId":doc.document_id,"snapshot":{
                    "tabId":format!("project-{}",doc.document_id),"name":doc.relative_path,"markdown":doc.markdown,
                    "from":0,"to":doc.markdown.encode_utf16().count(),"path":doc.path,"snapshotId":format!("{}:{}",self.task_id,doc.document_id)
                }}))
            } else {
                None
            };
            (result, source_event, emit_source)
        };
        if cancelled.load(Ordering::Relaxed) {
            return Err(invalid("cancelled"));
        }
        self.validate(state, grants, owner)?;
        if emit_source {
            self.documents
                .get_mut(document_id)
                .ok_or_else(|| invalid("projectDocumentNotFound"))?
                .source_emitted = true;
        }
        Ok((result, source_event))
    }

    pub(super) fn cite(
        &self,
        state: &AppState,
        grants: &ProjectGrantStore,
        owner: &str,
        document_id: &str,
        start_line: usize,
        end_line: usize,
        label: &str,
        cancelled: &AtomicBool,
    ) -> AppResult<Value> {
        if cancelled.load(Ordering::Relaxed) {
            return Err(invalid("cancelled"));
        }
        self.validate(state, grants, owner)?;
        let result = {
            let doc = self
                .documents
                .get(document_id)
                .ok_or_else(|| invalid("projectDocumentNotFound"))?;
            if !doc.source_emitted {
                return Err(invalid("projectDocumentNotRead"));
            }
            let Some(snapshot) = &doc.snapshot else {
                return Err(invalid("projectDocumentNotRead"));
            };
            let call = super::protocol::Call {
                id: uuid::Uuid::new_v4().to_string(),
                name: "cite_document".into(),
                arguments: json!({"startLine":start_line,"endLine":end_line,"label":label})
                    .to_string(),
            };
            let (mut result, _) = super::protocol::execute(&call, Some(snapshot), true);
            if result.get("error").is_none() {
                result["documentId"] = json!(doc.document_id);
            }
            result
        };
        if cancelled.load(Ordering::Relaxed) {
            return Err(invalid("cancelled"));
        }
        self.validate(state, grants, owner)?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filesystem::watcher::WatcherHandle;

    fn register_root(state: &AppState, root: &Path) {
        let root = root.to_path_buf();
        state
            .register_workspace(root.clone(), "main".into(), root.clone(), |_| {
                Ok(WatcherHandle {
                    root,
                    debouncer: Arc::new(parking_lot::Mutex::new(None)),
                })
            })
            .unwrap();
    }

    fn registered_access(
        root: &Path,
        buffers: Vec<DirtyBuffer>,
    ) -> (AppState, ProjectGrantStore, ProjectAccess) {
        let root = std::fs::canonicalize(root).unwrap();
        let state = AppState::default();
        register_root(&state, &root);
        let config = agent_project::project_search_config(&root).unwrap();
        let (include, exclude) = effective_patterns(&root, config.as_ref(), &[], &[]).unwrap();
        let grant = ProjectGrant {
            id: uuid::Uuid::new_v4().to_string(),
            owner: "main".into(),
            root: root.clone(),
            include,
            exclude,
            config_fingerprint: config_fingerprint(&root).unwrap(),
        };
        let grant_id = grant.id.clone();
        let grants = Arc::new(Mutex::new(HashMap::from([(grant_id.clone(), grant)])));
        let request = ProjectSearchRequest { grant_id, buffers };
        let access = prepare_access(
            &state,
            &grants,
            "main",
            &uuid::Uuid::new_v4().to_string(),
            &request,
        )
        .unwrap();
        (state, grants, access)
    }

    #[test]
    fn scope_patterns_reject_absolute_and_parent_paths_and_include_markdown_only() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let includes = vec!["**/*.md".to_string()];
        let excludes = vec!["notes/private/**".to_string(), ".git".to_string()];
        let scope = compile_scope(&root, &includes, &excludes).unwrap();
        assert!(scope
            .matched(Path::new("notes/one.md"), false)
            .is_whitelist());
        assert!(scope
            .matched(Path::new("notes/private/secret.md"), false)
            .is_ignore());
        assert!(scope.matched(Path::new("notes/one.txt"), false).is_ignore());
        assert!(normalize_patterns(&["../private/**".into()], 8).is_err());
        assert!(normalize_patterns(&["C:/private/**".into()], 8).is_err());
    }

    #[test]
    fn literal_search_returns_relative_candidates_and_dirty_buffers_override_disk() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let note = root.join("notes.md");
        std::fs::write(&note, "# Disk title\nold phrase\n").unwrap();
        let grant = ProjectGrant {
            id: uuid::Uuid::new_v4().to_string(),
            owner: "main".into(),
            root: root.clone(),
            include: vec!["**/*.md".into()],
            exclude: HARD_EXCLUDES.iter().map(|v| (*v).into()).collect(),
            config_fingerprint: None,
        };
        let access = ProjectAccess {
            grant,
            task_id: uuid::Uuid::new_v4().to_string(),
            buffers: HashMap::from([(note.clone(), "# Buffer title\nnew phrase\n".into())]),
            documents: HashMap::new(),
            ids_by_path: HashMap::new(),
            cached_bytes: 0,
            scanned_bytes: 0,
            scanned_files: 0,
            walked_entries: 0,
            searches: 0,
            search_cache: HashMap::new(),
        };
        let source = "# Buffer title\nnew phrase\n";
        let hit = snippet(source, "new phrase").unwrap();
        assert_eq!(hit.0, 2);
        assert_eq!(title(source, "notes.md"), "Buffer title");
        assert!(snippet("old phrase", "new phrase").is_none());
        assert_eq!(access.buffers.get(&note).unwrap(), source);
    }

    #[test]
    fn actual_project_read_creates_utf16_snapshot_and_citation_from_latest_disk_contents() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let note = root.join("中文笔记.md");
        std::fs::write(&note, "# 初始标题\nneedle OLD_PRIVATE_SENTINEL\n").unwrap();
        let (state, grants, mut access) = registered_access(&root, vec![]);
        let cancelled = AtomicBool::new(false);

        let candidates = access
            .search(&state, &grants, "main", "needle", None, &cancelled)
            .unwrap();
        assert_eq!(candidates["results"].as_array().unwrap().len(), 1);
        assert_eq!(candidates["results"][0]["path"], "中文笔记.md");
        assert!(candidates["results"][0].get("markdown").is_none());
        let id = candidates["results"][0]["documentId"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-'));

        let current = "# 最新标题\nneedle CURRENT_PRIVATE_SENTINEL 😀\n尾部\n";
        std::fs::write(&note, current).unwrap();
        let (read, source) = access
            .read(&state, &grants, "main", &id, 1, 3, &cancelled)
            .unwrap();
        assert_eq!(
            read["markdown"],
            "# 最新标题\nneedle CURRENT_PRIVATE_SENTINEL 😀\n尾部"
        );
        let source = source.unwrap();
        assert_eq!(source["documentId"], id);
        assert_eq!(source["snapshot"]["path"], note.to_string_lossy().as_ref());
        assert_eq!(source["snapshot"]["markdown"], current);
        assert_eq!(source["snapshot"]["to"], current.encode_utf16().count());
        assert_ne!(source["snapshot"]["snapshotId"], access.task_id);

        let citation = access
            .cite(
                &state,
                &grants,
                "main",
                &id,
                2,
                2,
                "Current evidence",
                &cancelled,
            )
            .unwrap();
        assert_eq!(citation["quote"], "needle CURRENT_PRIVATE_SENTINEL 😀");
        assert_eq!(citation["documentId"], id);
    }

    #[test]
    fn dirty_buffer_is_the_source_for_candidate_read_even_when_disk_differs() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let note = root.join("笔记.md");
        std::fs::write(&note, "disk-only phrase\n").unwrap();
        let dirty = "# 缓冲区\nopen-tab-only phrase\n".to_owned();
        let (state, grants, mut access) = registered_access(
            &root,
            vec![DirtyBuffer {
                path: note.clone(),
                markdown: dirty.clone(),
            }],
        );
        let cancelled = AtomicBool::new(false);
        let candidates = access
            .search(&state, &grants, "main", "open-tab-only", None, &cancelled)
            .unwrap();
        assert_eq!(candidates["results"].as_array().unwrap().len(), 1);
        let id = candidates["results"][0]["documentId"]
            .as_str()
            .unwrap()
            .to_owned();
        let (read, source) = access
            .read(&state, &grants, "main", &id, 1, 2, &cancelled)
            .unwrap();
        assert_eq!(read["markdown"], dirty.trim_end());
        assert_eq!(source.unwrap()["snapshot"]["markdown"], dirty);
    }

    #[test]
    fn configured_export_directories_are_excluded_from_search_buffers_and_reads() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let config_dir = root.join(".markcaptain");
        std::fs::create_dir(&config_dir).unwrap();
        let profile = json!({
            "id":"technical","name":"Technical","theme":"technical",
            "content":{"mode":"current","source":"buffer"},"formats":["html"],
            "output":{"directory":"deliverables","fileName":"{name}"},
            "typography":{"bodyFont":"system-cjk","codeFont":"system-monospace","bodySizePt":11,"lineHeight":1.65},
            "page":{"size":"A4","orientation":"portrait","marginMm":{"top":20,"right":18,"bottom":20,"left":18}},
            "toc":{"enabled":true,"depth":3},"resources":{"htmlMode":"embed","downloadRemote":false},
            "pdf":{"backend":"system-print"}
        });
        let export_config = |directory: &str| {
            let mut profile = profile.clone();
            profile["output"]["directory"] = json!(directory);
            json!({
                "schemaVersion":1,"defaultProfile":"technical","profiles":[profile]
            })
        };
        let config_path = config_dir.join("export.json");
        std::fs::write(
            &config_path,
            serde_json::to_vec(&export_config("deliverables")).unwrap(),
        )
        .unwrap();

        let note = root.join("notes.md");
        let output_dir = root.join("deliverables");
        std::fs::create_dir(&output_dir).unwrap();
        let output_note = output_dir.join("rendered.md");
        std::fs::write(&note, "visible marker\n").unwrap();
        std::fs::write(&output_note, "visible marker secret export\n").unwrap();
        let dirty = DirtyBuffer {
            path: output_note.clone(),
            markdown: "visible marker dirty output\n".into(),
        };
        let (state, grants, mut access) = registered_access(&root, vec![dirty]);
        assert!(access
            .grant
            .exclude
            .iter()
            .any(|pattern| pattern == "deliverables/**"));

        let cancelled = AtomicBool::new(false);
        let candidates = access
            .search(&state, &grants, "main", "visible marker", None, &cancelled)
            .unwrap();
        assert_eq!(candidates["results"].as_array().unwrap().len(), 1);
        assert_eq!(candidates["results"][0]["path"], "notes.md");

        let old_id = format!("project-{}-{}", access.grant.id, uuid::Uuid::new_v4());
        access.documents.insert(
            old_id.clone(),
            ProjectDocument {
                document_id: old_id.clone(),
                path: output_note.clone(),
                relative_path: "deliverables/rendered.md".into(),
                markdown: String::new(),
                snapshot: None,
                source_emitted: false,
            },
        );
        assert!(access
            .read(&state, &grants, "main", &old_id, 1, 1, &cancelled)
            .is_err());

        std::fs::write(
            &config_path,
            serde_json::to_vec(&export_config("published")).unwrap(),
        )
        .unwrap();
        assert!(access.validate(&state, &grants, "main").is_err());
    }

    #[test]
    fn revoked_or_other_window_grants_cannot_read_old_candidate_ids() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        std::fs::write(root.join("note.md"), "needle\n").unwrap();
        let (state, grants, mut access) = registered_access(&root, vec![]);
        let cancelled = AtomicBool::new(false);
        let candidates = access
            .search(&state, &grants, "main", "needle", None, &cancelled)
            .unwrap();
        let id = candidates["results"][0]["documentId"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(access.validate(&state, &grants, "editor-2").is_err());
        grants.lock().clear();
        assert!(access
            .read(&state, &grants, "main", &id, 1, 1, &cancelled)
            .is_err());
    }

    #[test]
    fn cancelled_search_does_not_scan_or_return_candidates() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        std::fs::write(root.join("note.md"), "needle\n").unwrap();
        let (state, grants, mut access) = registered_access(&root, vec![]);
        let cancelled = AtomicBool::new(true);
        let error = access
            .search(&state, &grants, "main", "needle", None, &cancelled)
            .unwrap_err();
        assert_eq!(error.to_string(), "agent:cancelled");
        assert_eq!(access.scanned_files, 0);
        assert!(access.documents.is_empty());
    }

    #[test]
    fn file_reader_never_reads_past_the_per_file_limit() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("large.md");
        std::fs::write(&path, vec![b'x'; MAX_FILE_BYTES as usize + 1]).unwrap();
        let error = read_bounded_file(&path).unwrap_err();
        assert_eq!(error.to_string(), "agent:projectFileTooLarge");
    }

    #[test]
    fn failed_read_does_not_authorize_citation_or_emit_a_source() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("note.md"), "needle\nsecond line").unwrap();
        let (state, grants, mut access) = registered_access(temp.path(), vec![]);
        let cancelled = AtomicBool::new(false);
        let results = access
            .search(&state, &grants, "main", "needle", None, &cancelled)
            .unwrap();
        let id = results["results"][0]["documentId"].as_str().unwrap();
        let (failed, source) = access
            .read(&state, &grants, "main", id, 1, 200, &cancelled)
            .unwrap();
        assert!(failed.get("error").is_some());
        assert!(source.is_none());
        assert_eq!(
            access
                .cite(&state, &grants, "main", id, 1, 1, "Evidence", &cancelled)
                .unwrap_err()
                .to_string(),
            "agent:projectDocumentNotRead"
        );
        let (read, source) = access
            .read(&state, &grants, "main", id, 1, 1, &cancelled)
            .unwrap();
        assert!(read.get("error").is_none());
        assert!(source.is_some());
        assert_eq!(
            access
                .cite(&state, &grants, "main", id, 1, 1, "Evidence", &cancelled)
                .unwrap()["quote"],
            "needle"
        );
    }

    fn assert_full_candidate_cache_can_be_filtered(use_buffers: bool) {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let mut buffers = Vec::new();
        for index in 0..MAX_CANDIDATES {
            let path = root.join(format!("note-{index:02}.md"));
            let markdown = format!("# Title {index:02}\nneedle");
            if use_buffers {
                buffers.push(DirtyBuffer { path, markdown });
            } else {
                std::fs::write(path, markdown).unwrap();
            }
        }
        let (state, grants, mut access) = registered_access(&root, buffers);
        let cancelled = AtomicBool::new(false);
        let first = access
            .search(
                &state,
                &grants,
                "main",
                "needle",
                Some(&json!({"limit":50})),
                &cancelled,
            )
            .unwrap();
        assert_eq!(first["results"].as_array().unwrap().len(), MAX_CANDIDATES);
        let bytes = (
            access.cached_bytes,
            access.scanned_bytes,
            access.scanned_files,
        );
        let id = first["results"]
            .as_array()
            .unwrap()
            .iter()
            .find(|doc| doc["path"] == "note-00.md")
            .unwrap()["documentId"]
            .clone();
        let narrow = access
            .search(
                &state,
                &grants,
                "main",
                "needle",
                Some(&json!({"pathPrefix":"note-00.md"})),
                &cancelled,
            )
            .unwrap();
        assert_eq!(narrow["results"].as_array().unwrap().len(), 1);
        assert_eq!(narrow["results"][0]["documentId"], id);
        assert_eq!(narrow["complete"], true);
        assert_eq!(
            (
                access.cached_bytes,
                access.scanned_bytes,
                access.scanned_files
            ),
            bytes
        );
        let by_title = access
            .search(
                &state,
                &grants,
                "main",
                "Title",
                Some(&json!({"title":"Title 00"})),
                &cancelled,
            )
            .unwrap();
        assert_eq!(by_title["results"].as_array().unwrap().len(), 1);
        assert_eq!(by_title["results"][0]["documentId"], id);
        assert_eq!(
            (
                access.cached_bytes,
                access.scanned_bytes,
                access.scanned_files
            ),
            bytes
        );
    }

    #[test]
    fn full_disk_candidate_cache_can_be_filtered_without_duplicate_charges() {
        assert_full_candidate_cache_can_be_filtered(false);
    }

    #[test]
    fn full_buffer_candidate_cache_can_be_filtered_without_duplicate_charges() {
        assert_full_candidate_cache_can_be_filtered(true);
    }

    #[test]
    fn full_byte_cache_remains_searchable_without_duplicate_charges() {
        let temp = tempfile::tempdir().unwrap();
        let mut remaining = MAX_CACHED_BYTES;
        let mut count = 0;
        while remaining > 0 {
            let size = remaining.min(MAX_FILE_BYTES as usize);
            let markdown = format!("needle\n{}", "x".repeat(size - 7));
            std::fs::write(temp.path().join(format!("note-{count}.md")), markdown).unwrap();
            remaining -= size;
            count += 1;
        }
        let (state, grants, mut access) = registered_access(temp.path(), vec![]);
        let cancelled = AtomicBool::new(false);
        let first = access
            .search(&state, &grants, "main", "needle", None, &cancelled)
            .unwrap();
        assert_eq!(first["results"].as_array().unwrap().len(), count);
        assert_eq!(access.cached_bytes, MAX_CACHED_BYTES);
        let bytes = access.scanned_bytes;
        let narrow = access
            .search(
                &state,
                &grants,
                "main",
                "needle",
                Some(&json!({"pathPrefix":"note-0.md"})),
                &cancelled,
            )
            .unwrap();
        assert_eq!(narrow["results"].as_array().unwrap().len(), 1);
        assert_eq!(narrow["complete"], true);
        assert_eq!(access.cached_bytes, MAX_CACHED_BYTES);
        assert_eq!(access.scanned_bytes, bytes);
    }

    #[test]
    fn only_successful_distinct_reads_consume_the_shared_source_limit() {
        let temp = tempfile::tempdir().unwrap();
        for index in 0..MAX_CANDIDATES {
            std::fs::write(
                temp.path().join(format!("note-{index}.md")),
                "needle\nsecond line",
            )
            .unwrap();
        }
        let (state, grants, mut access) = registered_access(temp.path(), vec![]);
        let cancelled = AtomicBool::new(false);
        let first = access
            .search(
                &state,
                &grants,
                "main",
                "needle",
                Some(&json!({"limit":50})),
                &cancelled,
            )
            .unwrap();
        let ids: Vec<_> = first["results"]
            .as_array()
            .unwrap()
            .iter()
            .map(|doc| doc["documentId"].as_str().unwrap())
            .collect();
        assert_eq!(*MAX_READ_DOCUMENTS, 40);
        for id in &ids {
            let (failed, source) = access
                .read(&state, &grants, "main", id, 1, 200, &cancelled)
                .unwrap();
            assert!(failed.get("error").is_some());
            assert!(source.is_none());
        }
        for id in ids.iter().take(*MAX_READ_DOCUMENTS) {
            let (read, source) = access
                .read(&state, &grants, "main", id, 1, 1, &cancelled)
                .unwrap();
            assert!(read.get("error").is_none());
            assert!(source.is_some());
            let (repeat, duplicate) = access
                .read(&state, &grants, "main", id, 2, 2, &cancelled)
                .unwrap();
            assert!(repeat.get("error").is_none());
            assert!(duplicate.is_none());
        }
        assert_eq!(
            access
                .read(&state, &grants, "main", ids[40], 1, 1, &cancelled)
                .unwrap_err()
                .to_string(),
            "agent:projectReadBudgetReached"
        );
        assert_eq!(
            access
                .cite(&state, &grants, "main", ids[40], 1, 1, "Evidence", &cancelled)
                .unwrap_err()
                .to_string(),
            "agent:projectDocumentNotRead"
        );
        assert!(access
            .read(&state, &grants, "main", ids[0], 1, 1, &cancelled)
            .unwrap()
            .1
            .is_none());
        assert_eq!(
            access
                .documents
                .values()
                .filter(|doc| doc.source_emitted)
                .count(),
            40
        );
    }

    #[test]
    fn authoritative_globs_filter_dirty_buffers_before_search_and_reads() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        std::fs::create_dir(root.join(".markcaptain")).unwrap();
        std::fs::write(
            root.join(".markcaptain/agent.json"),
            serde_json::to_vec(&json!({
                "schemaVersion":1,"projectSearch":{"include":["**/*.{md,markdown}"],
                    "exclude":["**/{secret,private}.*","**/draft[0-9].md"]}
            }))
            .unwrap(),
        )
        .unwrap();
        let buffers = [
            "note.md",
            "long.markdown",
            "secret.md",
            "private.markdown",
            "draft1.md",
        ]
        .into_iter()
        .map(|name| {
            let path = root.join(name);
            std::fs::write(&path, "disk stale").unwrap();
            DirtyBuffer {
                path,
                markdown: "dirty needle".into(),
            }
        })
        .collect();
        let (state, grants, mut access) = registered_access(&root, buffers);
        assert_eq!(access.buffers.len(), 2);
        let cancelled = AtomicBool::new(false);
        let results = access
            .search(&state, &grants, "main", "needle", None, &cancelled)
            .unwrap();
        assert_eq!(results["results"].as_array().unwrap().len(), 2);
        for doc in results["results"].as_array().unwrap() {
            assert!(doc["path"] == "note.md" || doc["path"] == "long.markdown");
            let (read, source) = access
                .read(
                    &state,
                    &grants,
                    "main",
                    doc["documentId"].as_str().unwrap(),
                    1,
                    1,
                    &cancelled,
                )
                .unwrap();
            assert_eq!(read["markdown"], "dirty needle");
            assert_eq!(source.unwrap()["snapshot"]["markdown"], "dirty needle");
        }
        assert!(access
            .search(&state, &grants, "main", "disk stale", None, &cancelled)
            .unwrap()["results"]
            .as_array()
            .unwrap()
            .is_empty());
    }
}
