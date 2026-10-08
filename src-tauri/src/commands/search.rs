//! Folder search — wraps the `grep` / `ignore` crates.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::app::AppState;
use crate::error::{AppError, AppResult};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchArgs {
    pub root: PathBuf,
    pub query: String,
    pub case_sensitive: Option<bool>,
    pub whole_word: Option<bool>,
    pub regex: Option<bool>,
    pub include_hidden: Option<bool>,
    pub follow_symlinks: Option<bool>,
    pub max_file_size: Option<u64>,
    pub exclusions: Option<Vec<String>>,
    pub no_ignore: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: PathBuf,
    /// One-based line number.
    pub line: u64,
    /// One-based Unicode-scalar column.
    pub column: u64,
    /// Match length measured in Unicode scalar values.
    pub length: u64,
    /// One-based exclusive Unicode-scalar end column (`column + length`).
    pub end_column: u64,
    pub preview: String,
}

#[tauri::command]
pub async fn cmd_search_in_folder(
    state: tauri::State<'_, AppState>,
    args: SearchArgs,
) -> AppResult<Vec<SearchHit>> {
    let workspace_roots = state.workspace_roots();
    tokio::task::spawn_blocking(move || {
        let canonical_root = resolve_open_workspace_root(&workspace_roots, &args.root)?;
        run_search(args, canonical_root)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

/// Resolve a renderer-supplied search root against the roots registered by
/// `cmd_watch_folder`. Canonical equality is deliberate: searching a child of
/// an open workspace (or a similarly prefixed sibling) must not manufacture a
/// new authority boundary.
fn resolve_open_workspace_root(
    workspace_roots: &[PathBuf],
    requested_root: &Path,
) -> AppResult<PathBuf> {
    let requested = std::fs::canonicalize(requested_root).map_err(|error| {
        AppError::InvalidArgument(format!(
            "cannot resolve search root `{}`: {error}",
            requested_root.display()
        ))
    })?;
    if !requested.is_dir() {
        return Err(AppError::InvalidArgument(format!(
            "search root is not a directory: {}",
            requested_root.display()
        )));
    }

    let is_open = workspace_roots.iter().any(|registered| {
        std::fs::canonicalize(registered)
            .map(|registered| registered == requested)
            .unwrap_or(false)
    });
    if !is_open {
        return Err(AppError::InvalidArgument(format!(
            "search root is not an open workspace: {}. Open the folder as a workspace before searching it",
            requested_root.display()
        )));
    }
    Ok(requested)
}

/// Resolve one walker entry and prove that it still belongs to the canonical
/// workspace. `Path::starts_with` compares path components, not string
/// prefixes, after canonicalization has resolved `..` and symbolic links.
fn resolve_entry_inside_workspace(
    canonical_root: &Path,
    entry_path: &Path,
    path_is_symlink: bool,
) -> AppResult<PathBuf> {
    let resolved = std::fs::canonicalize(entry_path).map_err(|error| {
        AppError::InvalidArgument(format!(
            "cannot safely resolve search entry `{}`: {error}",
            entry_path.display()
        ))
    })?;
    if !resolved.starts_with(canonical_root) {
        return Err(AppError::InvalidArgument(format!(
            "search entry escapes the open workspace: {} -> {}",
            entry_path.display(),
            resolved.display()
        )));
    }

    // The ignore/walkdir walker also detects inode loops. Reject the common
    // ancestor-link form here so it is pruned before descent (and before it
    // can produce a walker error). Canonicalization failures above cover
    // direct and mutually recursive symlink loops.
    if path_is_symlink && resolved.is_dir() {
        for ancestor in entry_path.ancestors().skip(1) {
            let Ok(resolved_ancestor) = std::fs::canonicalize(ancestor) else {
                continue;
            };
            if !resolved_ancestor.starts_with(canonical_root) {
                break;
            }
            if resolved_ancestor == resolved {
                return Err(AppError::InvalidArgument(format!(
                    "search entry creates a symbolic-link cycle: {} points to ancestor {}",
                    entry_path.display(),
                    ancestor.display()
                )));
            }
        }
    }
    Ok(resolved)
}

fn map_to_renderer_root(
    canonical_root: &Path,
    renderer_root: &Path,
    walked_path: &Path,
) -> AppResult<PathBuf> {
    let relative = walked_path.strip_prefix(canonical_root).map_err(|_| {
        AppError::InvalidArgument(format!(
            "walked search path is outside the open workspace: {}",
            walked_path.display()
        ))
    })?;
    Ok(renderer_root.join(relative))
}

fn is_walk_loop(error: &ignore::Error) -> bool {
    match error {
        ignore::Error::Loop { .. } => true,
        ignore::Error::WithLineNumber { err, .. }
        | ignore::Error::WithPath { err, .. }
        | ignore::Error::WithDepth { err, .. } => is_walk_loop(err),
        ignore::Error::Partial(errors) => !errors.is_empty() && errors.iter().all(is_walk_loop),
        _ => false,
    }
}

fn run_search(args: SearchArgs, canonical_root: PathBuf) -> AppResult<Vec<SearchHit>> {
    use grep::matcher::Matcher;
    use grep::searcher::{Searcher, SearcherBuilder, Sink, SinkMatch};
    use ignore::overrides::OverrideBuilder;
    use ignore::WalkBuilder;

    let renderer_root = args.root.clone();

    let pattern = if args.regex.unwrap_or(false) {
        args.query.clone()
    } else {
        regex_escape(&args.query)
    };
    let pattern = if args.whole_word.unwrap_or(false) {
        format!(r"\b{pattern}\b")
    } else {
        pattern
    };
    let matcher = grep::regex::RegexMatcherBuilder::new()
        .case_insensitive(!args.case_sensitive.unwrap_or(false))
        .build(&pattern)
        .map_err(|e| AppError::Other(e.to_string()))?;

    let mut hits = Vec::new();
    let mut walk_builder = WalkBuilder::new(&canonical_root);
    walk_builder
        .hidden(!args.include_hidden.unwrap_or(false))
        .follow_links(args.follow_symlinks.unwrap_or(true))
        .max_filesize(args.max_file_size);

    let filter_root = canonical_root.clone();
    walk_builder.filter_entry(move |entry| {
        match resolve_entry_inside_workspace(&filter_root, entry.path(), entry.path_is_symlink()) {
            Ok(_) => true,
            Err(error) => {
                tracing::warn!(
                    %error,
                    path = %entry.path().display(),
                    "skipping unsafe search entry"
                );
                false
            }
        }
    });

    let respect_ignore_files = !args.no_ignore.unwrap_or(false);
    walk_builder
        .parents(respect_ignore_files)
        .ignore(respect_ignore_files)
        .git_global(respect_ignore_files)
        .git_ignore(respect_ignore_files)
        .git_exclude(respect_ignore_files);

    if let Some(patterns) = args.exclusions.as_deref() {
        let mut overrides = OverrideBuilder::new(&canonical_root);
        for raw in patterns {
            let pattern = raw.trim();
            if pattern.is_empty() {
                continue;
            }
            // Search preferences are exclusion-only. Strip a leading `!` so
            // a gitignore-style value cannot accidentally become a whitelist.
            let pattern = pattern.strip_prefix('!').unwrap_or(pattern);
            overrides.add(&format!("!{pattern}")).map_err(|error| {
                AppError::InvalidArgument(format!(
                    "invalid search exclusion pattern `{raw}`: {error}"
                ))
            })?;
        }
        walk_builder.overrides(overrides.build().map_err(|error| {
            AppError::InvalidArgument(format!("invalid search exclusions: {error}"))
        })?);
    }
    let walker = walk_builder.build();

    let mut searcher: Searcher = SearcherBuilder::new().build();
    struct Collector<'a> {
        hits: &'a mut Vec<SearchHit>,
        path: PathBuf,
        matcher: &'a grep::regex::RegexMatcher,
    }
    impl<'a> Sink for Collector<'a> {
        type Error = std::io::Error;
        fn matched(
            &mut self,
            _searcher: &Searcher,
            mat: &SinkMatch<'_>,
        ) -> Result<bool, Self::Error> {
            let line = mat.line_number().unwrap_or(1);
            let preview = String::from_utf8_lossy(mat.bytes()).into_owned();
            let preview = preview.trim_end_matches(&['\r', '\n'][..]).to_string();
            let mut matches = Vec::new();
            self.matcher
                .find_iter(mat.bytes(), |matched| {
                    matches.push(matched);
                    true
                })
                .map_err(|error| std::io::Error::other(error.to_string()))?;

            for matched in matches {
                let column = String::from_utf8_lossy(&mat.bytes()[..matched.start()])
                    .chars()
                    .count() as u64
                    + 1;
                let length = String::from_utf8_lossy(&mat.bytes()[matched.start()..matched.end()])
                    .chars()
                    .count() as u64;
                self.hits.push(SearchHit {
                    path: self.path.clone(),
                    line,
                    column,
                    length,
                    end_column: column + length,
                    preview: preview.clone(),
                });
            }
            Ok(true)
        }
    }

    let mut errors = Vec::new();
    for entry in walker {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                if is_walk_loop(&error) {
                    tracing::warn!(%error, "skipping symbolic-link cycle during search");
                    continue;
                }
                tracing::warn!(%error, "unable to walk search path");
                errors.push(error.to_string());
                continue;
            }
        };
        let walked_path = entry.path();
        let resolved_path = match resolve_entry_inside_workspace(
            &canonical_root,
            walked_path,
            entry.path_is_symlink(),
        ) {
            Ok(path) => path,
            Err(error) => {
                tracing::warn!(
                    %error,
                    path = %walked_path.display(),
                    "skipping unsafe search entry before reading"
                );
                continue;
            }
        };
        if !resolved_path.is_file() {
            continue;
        }
        let renderer_path = match map_to_renderer_root(&canonical_root, &renderer_root, walked_path)
        {
            Ok(path) => path,
            Err(error) => {
                tracing::warn!(%error, "unable to map search result path");
                errors.push(error.to_string());
                continue;
            }
        };
        let mut collector = Collector {
            hits: &mut hits,
            path: renderer_path,
            matcher: &matcher,
        };
        if let Err(error) = searcher.search_path(&matcher, &resolved_path, &mut collector) {
            tracing::warn!(%error, path = %walked_path.display(), "unable to search file");
            errors.push(format!("{}: {error}", walked_path.display()));
        }
    }
    if hits.is_empty() && !errors.is_empty() {
        let additional = errors.len().saturating_sub(1);
        return Err(AppError::Other(format!(
            "search failed: {}{}",
            errors[0],
            if additional == 0 {
                String::new()
            } else {
                format!(" ({additional} additional errors)")
            }
        )));
    }
    Ok(hits)
}

fn regex_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        if "\\.+*?()[]{}|^$".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

// Silence the unused import warning when `RegexMatcher` is only referenced by
// the inner builder; keeps the explicit type around for readability.
#[allow(dead_code)]
fn _force_use() -> Option<grep::regex::RegexMatcher> {
    None
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io;
    use std::path::Path;

    use serde_json::json;

    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("markcaptain-search-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(unix)]
    fn create_dir_symlink(target: &Path, link: &Path) -> io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_dir_symlink(target: &Path, link: &Path) -> io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    #[cfg(not(any(unix, windows)))]
    fn create_dir_symlink(_target: &Path, _link: &Path) -> io::Result<()> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "directory symlinks are unsupported on this platform",
        ))
    }

    fn args(root: PathBuf) -> SearchArgs {
        SearchArgs {
            root,
            query: "needle".into(),
            case_sensitive: None,
            whole_word: None,
            regex: None,
            include_hidden: None,
            follow_symlinks: None,
            max_file_size: None,
            exclusions: None,
            no_ignore: None,
        }
    }

    fn run_search_in_root(args: SearchArgs) -> AppResult<Vec<SearchHit>> {
        let canonical_root = std::fs::canonicalize(&args.root)?;
        run_search(args, canonical_root)
    }

    #[test]
    fn search_args_deserialize_camel_case() {
        let parsed: SearchArgs = serde_json::from_value(json!({
            "root": ".",
            "query": "needle",
            "caseSensitive": true,
            "wholeWord": true,
            "includeHidden": true,
            "followSymlinks": false,
            "maxFileSize": 1024,
            "exclusions": ["target/**"],
            "noIgnore": true
        }))
        .unwrap();
        assert_eq!(parsed.case_sensitive, Some(true));
        assert_eq!(parsed.whole_word, Some(true));
        assert_eq!(parsed.max_file_size, Some(1024));
        assert_eq!(parsed.exclusions.unwrap(), vec!["target/**"]);
        assert_eq!(parsed.no_ignore, Some(true));
    }

    #[test]
    fn search_root_must_exactly_match_an_open_workspace() {
        let temp = TempDir::new();
        let open = temp.path().join("open");
        let unopened = temp.path().join("unopened");
        let child = open.join("child");
        fs::create_dir_all(&child).unwrap();
        fs::create_dir_all(&unopened).unwrap();
        let registered = vec![open.clone()];

        assert_eq!(
            resolve_open_workspace_root(&registered, &open).unwrap(),
            fs::canonicalize(&open).unwrap()
        );
        assert!(resolve_open_workspace_root(&registered, &unopened).is_err());
        assert!(resolve_open_workspace_root(&registered, &child).is_err());
    }

    #[test]
    fn workspace_authority_rejects_path_prefix_collisions() {
        let temp = TempDir::new();
        let notes = temp.path().join("notes");
        let notes_old = temp.path().join("notes-old");
        fs::create_dir(&notes).unwrap();
        fs::create_dir(&notes_old).unwrap();

        assert!(resolve_open_workspace_root(std::slice::from_ref(&notes), &notes_old).is_err());
        assert!(resolve_open_workspace_root(std::slice::from_ref(&notes_old), &notes).is_err());
    }

    #[test]
    fn canonical_entry_boundary_accepts_internal_paths_and_rejects_prefixed_siblings() {
        let temp = TempDir::new();
        let root = temp.path().join("notes");
        let sibling = temp.path().join("notes-old");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&sibling).unwrap();
        let inside = root.join("inside.md");
        let outside = sibling.join("outside.md");
        fs::write(&inside, "needle").unwrap();
        fs::write(&outside, "needle").unwrap();
        let canonical_root = fs::canonicalize(&root).unwrap();

        assert_eq!(
            resolve_entry_inside_workspace(&canonical_root, &inside, false).unwrap(),
            fs::canonicalize(&inside).unwrap()
        );
        assert!(resolve_entry_inside_workspace(&canonical_root, &outside, false).is_err());
    }

    #[test]
    fn walked_paths_are_mapped_back_to_renderer_root_spelling() {
        let temp = TempDir::new();
        let canonical_root = fs::canonicalize(temp.path()).unwrap();
        let walked_path = canonical_root.join("nested").join("note.md");
        let renderer_root = PathBuf::from("renderer-root-spelling");

        assert_eq!(
            map_to_renderer_root(&canonical_root, &renderer_root, &walked_path).unwrap(),
            renderer_root.join("nested").join("note.md")
        );
    }

    #[test]
    fn followed_external_symlink_is_pruned_from_search() {
        let temp = TempDir::new();
        let root = temp.path().join("workspace");
        let outside = temp.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        fs::write(root.join("inside.md"), "needle").unwrap();
        fs::write(outside.join("outside.md"), "needle").unwrap();
        let escape = root.join("escape");
        if let Err(error) = create_dir_symlink(&outside, &escape) {
            eprintln!("skipping symlink test because symlinks are unavailable: {error}");
            return;
        }

        let canonical_root = fs::canonicalize(&root).unwrap();
        assert!(resolve_entry_inside_workspace(&canonical_root, &escape, true).is_err());
        let mut search_args = args(root.clone());
        search_args.follow_symlinks = Some(true);
        search_args.no_ignore = Some(true);
        let hits = run_search(search_args, canonical_root).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, root.join("inside.md"));
    }

    #[test]
    fn ancestor_symlink_cycle_is_pruned_without_losing_valid_hits() {
        let temp = TempDir::new();
        let root = temp.path().join("workspace");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("inside.md"), "needle").unwrap();
        let cycle = root.join("cycle");
        if let Err(error) = create_dir_symlink(&root, &cycle) {
            eprintln!("skipping symlink test because symlinks are unavailable: {error}");
            return;
        }

        let canonical_root = fs::canonicalize(&root).unwrap();
        assert!(resolve_entry_inside_workspace(&canonical_root, &cycle, true).is_err());
        let hits = run_search(args(root.clone()), canonical_root).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, root.join("inside.md"));
    }

    #[test]
    fn exclusions_and_no_ignore_affect_walk_results() {
        let temp = TempDir::new();
        let root = temp.path().to_path_buf();
        fs::write(root.join("visible.md"), "needle").unwrap();
        fs::write(root.join("ignored.md"), "needle").unwrap();
        fs::write(root.join("excluded.md"), "needle").unwrap();
        fs::write(root.join(".ignore"), "ignored.md\n").unwrap();

        let mut default_args = args(root.clone());
        default_args.exclusions = Some(vec!["excluded.md".into()]);
        let default_hits = run_search_in_root(default_args).unwrap();
        let default_names: Vec<_> = default_hits
            .iter()
            .filter_map(|hit| hit.path.file_name().and_then(|name| name.to_str()))
            .collect();
        assert_eq!(default_names, vec!["visible.md"]);

        let mut no_ignore_args = args(root.clone());
        no_ignore_args.no_ignore = Some(true);
        no_ignore_args.exclusions = Some(vec!["excluded.md".into()]);
        let no_ignore_hits = run_search_in_root(no_ignore_args).unwrap();
        let mut no_ignore_names: Vec<_> = no_ignore_hits
            .iter()
            .filter_map(|hit| hit.path.file_name().and_then(|name| name.to_str()))
            .collect();
        no_ignore_names.sort_unstable();
        assert_eq!(no_ignore_names, vec!["ignored.md", "visible.md"]);
    }

    #[test]
    fn hidden_and_max_file_size_options_still_apply() {
        let temp = TempDir::new();
        let root = temp.path().to_path_buf();
        fs::write(root.join("visible.md"), "needle").unwrap();
        fs::write(root.join(".hidden.md"), "needle").unwrap();
        fs::write(root.join("large.md"), "needle plus extra bytes").unwrap();

        let mut default_args = args(root.clone());
        default_args.max_file_size = Some(6);
        let default_hits = run_search_in_root(default_args).unwrap();
        assert_eq!(default_hits.len(), 1);
        assert_eq!(default_hits[0].path, root.join("visible.md"));

        let mut hidden_args = args(root.clone());
        hidden_args.include_hidden = Some(true);
        hidden_args.max_file_size = Some(6);
        let mut names: Vec<_> = run_search_in_root(hidden_args)
            .unwrap()
            .into_iter()
            .filter_map(|hit| {
                hit.path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(str::to_owned)
            })
            .collect();
        names.sort_unstable();
        assert_eq!(names, vec![".hidden.md", "visible.md"]);
    }

    #[test]
    fn rejects_missing_root_and_reports_match_column() {
        let missing = std::env::temp_dir().join(format!(
            "markcaptain-search-missing-{}",
            uuid::Uuid::new_v4()
        ));
        assert!(run_search_in_root(args(missing)).is_err());

        let temp = TempDir::new();
        let root = temp.path().to_path_buf();
        fs::write(root.join("column.md"), "prefix needle").unwrap();
        let hits = run_search_in_root(args(root)).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 1);
        assert_eq!(hits[0].column, 8);
        assert_eq!(hits[0].length, 6);
        assert_eq!(hits[0].end_column, 14);
    }

    #[test]
    fn reports_every_match_with_unicode_character_coordinates() {
        let temp = TempDir::new();
        let root = temp.path().to_path_buf();
        fs::write(root.join("unicode.md"), "😀 needle needle\n").unwrap();

        let hits = run_search_in_root(args(root)).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].line, 1);
        assert_eq!(hits[0].column, 3);
        assert_eq!(hits[0].length, 6);
        assert_eq!(hits[0].end_column, 9);
        assert_eq!(hits[1].line, 1);
        assert_eq!(hits[1].column, 10);
        assert_eq!(hits[1].length, 6);
        assert_eq!(hits[1].end_column, 16);
    }

    #[test]
    fn case_word_and_regex_options_still_apply_to_each_match() {
        let temp = TempDir::new();
        let root = temp.path().to_path_buf();
        fs::write(
            root.join("options.md"),
            "Needle needle needlex NEEDLE h11 h22\n",
        )
        .unwrap();

        let mut exact = args(root.clone());
        exact.case_sensitive = Some(true);
        exact.whole_word = Some(true);
        assert_eq!(run_search_in_root(exact).unwrap().len(), 1);

        let mut insensitive = args(root.clone());
        insensitive.whole_word = Some(true);
        assert_eq!(run_search_in_root(insensitive).unwrap().len(), 3);

        let mut regex = args(root);
        regex.query = r"h\d{2}".into();
        regex.regex = Some(true);
        assert_eq!(run_search_in_root(regex).unwrap().len(), 2);
    }
}
