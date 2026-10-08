//! CLI argument parsing — mirrors the original `upstream/src/main/cli/`.
//!
//! Tauri 2 ships `tauri-plugin-cli`, which we use for the actual matching.
//! This module hosts the strongly typed view of the parsed args.

use std::path::PathBuf;

#[derive(Debug, Default, Clone)]
pub struct LaunchArgs {
    pub files: Vec<PathBuf>,
    pub new_window: bool,
    pub debug: bool,
}
