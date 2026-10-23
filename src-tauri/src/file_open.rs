//! Durable, per-window handoff for file-association and second-instance opens.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter, EventTarget, Manager};

#[derive(Default)]
pub struct PendingFileOpens(Mutex<HashMap<String, Vec<PathBuf>>>);

impl PendingFileOpens {
    fn enqueue(&self, label: &str, files: Vec<PathBuf>) {
        self.0.lock().entry(label.into()).or_default().extend(files);
    }

    pub fn take(&self, label: &str) -> Vec<PathBuf> {
        self.0.lock().remove(label).unwrap_or_default()
    }
}

pub fn launch_files(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<PathBuf> {
    args.into_iter()
        .filter(|arg| !arg.starts_with('-'))
        .map(|arg| cwd.join(arg))
        .filter(|path| path.is_file())
        .collect()
}

pub fn enqueue(app: &AppHandle, label: &str, files: Vec<PathBuf>) {
    if files.is_empty() {
        return;
    }
    app.state::<PendingFileOpens>().enqueue(label, files);
    // This is only a wake-up signal. If the webview is still booting, its
    // first explicit drain will retrieve the requests without any timer.
    if let Err(error) = app.emit_to(
        EventTarget::webview_window(label),
        "mt://window/open-file",
        (),
    ) {
        tracing::warn!(%error, label, "file-open notification failed; requests remain queued");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retains_cold_start_and_early_second_instance_requests_in_order() {
        let pending = PendingFileOpens::default();
        pending.enqueue("main", vec!["first.md".into()]);
        pending.enqueue("main", vec!["second.md".into(), "third.md".into()]);
        assert_eq!(
            pending.take("main"),
            vec![
                PathBuf::from("first.md"),
                "second.md".into(),
                "third.md".into()
            ]
        );
        assert!(pending.take("main").is_empty());
        pending.enqueue("main", vec!["later.md".into()]);
        assert_eq!(pending.take("main"), vec![PathBuf::from("later.md")]);
    }

    #[test]
    fn each_window_can_only_drain_its_own_requests() {
        let pending = PendingFileOpens::default();
        pending.enqueue("main", vec!["main.md".into()]);
        pending.enqueue("editor-1", vec!["other.md".into()]);
        assert!(pending.take("settings").is_empty());
        assert_eq!(pending.take("editor-1"), vec![PathBuf::from("other.md")]);
        assert_eq!(pending.take("main"), vec![PathBuf::from("main.md")]);
    }

    #[test]
    fn resolves_relative_arguments_against_the_launching_process_directory() {
        let root = tempfile::tempdir().expect("fixture directory");
        let relative = root.path().join("中文 file.md");
        let absolute = root.path().join("absolute.md");
        std::fs::write(&relative, "# First").expect("fixture file");
        std::fs::write(&absolute, "# Second").expect("fixture file");
        assert_eq!(
            launch_files(
                vec![
                    "--debug".into(),
                    "-n".into(),
                    "中文 file.md".into(),
                    absolute.to_string_lossy().into_owned(),
                    "missing.md".into(),
                    root.path().to_string_lossy().into_owned(),
                ],
                root.path(),
            ),
            vec![relative, absolute]
        );
    }
}
