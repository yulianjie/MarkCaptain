//! Durable whole-file replacement shared by preferences and documents.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Write a complete replacement beside the destination so the final rename
/// never crosses filesystems. A crash can leave an orphan `.tmp` file, but it
/// cannot expose a partially-written destination file.
pub fn write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let destination = resolve_destination(path)?;
    let path = destination.as_path();
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;

    let temporary = parent.join(format!(
        ".mt-write-{}-{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let permissions = match fs::metadata(path) {
        Ok(metadata) => Some(metadata.permissions()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };

    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.flush()?;
        if let Some(permissions) = permissions {
            file.set_permissions(permissions)?;
        }
        file.sync_all()?;
        drop(file);

        replace_file(&temporary, path)?;
        sync_parent_directory(parent)?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

/// Replacing a symlink path would destroy the link instead of updating its
/// target, unlike a normal file write. Resolve only the final symlink and keep
/// ordinary/nonexistent paths unchanged.
fn resolve_destination(path: &Path) -> io::Result<PathBuf> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => fs::canonicalize(path),
        Ok(_) => Ok(path.to_path_buf()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(path.to_path_buf()),
        Err(error) => Err(error),
    }
}

/// Async-runtime friendly wrapper around [`write`]. The flush and filesystem
/// sync operations are blocking and must not run on a Tokio worker thread.
pub async fn write_async(path: PathBuf, bytes: Vec<u8>) -> io::Result<()> {
    tokio::task::spawn_blocking(move || write(&path, &bytes))
        .await
        .map_err(|error| io::Error::other(format!("atomic write worker failed: {error}")))?
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::ffi::c_void;

    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    #[link(name = "kernel32")]
    extern "system" {
        fn ReplaceFileW(
            replaced_file_name: *const u16,
            replacement_file_name: *const u16,
            backup_file_name: *const u16,
            replace_flags: u32,
            exclude: *mut c_void,
            reserved: *mut c_void,
        ) -> i32;
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }

    let source = windows_api_path(source)?;
    let destination_wide = windows_api_path(destination)?;
    let destination_exists = match fs::metadata(destination) {
        Ok(_) => true,
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(error),
    };

    let replaced = if destination_exists {
        // REPLACEFILE_WRITE_THROUGH is documented as unsupported. The
        // replacement bytes have already been FlushFileBuffers'd by
        // `File::sync_all`; ReplaceFileW preserves DACLs, compression,
        // encryption and named streams from the existing destination.
        unsafe {
            ReplaceFileW(
                destination_wide.as_ptr(),
                source.as_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        }
    } else {
        // Do not use REPLACE_EXISTING here: if another writer creates the
        // destination after our metadata check, its file must not be lost.
        unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination_wide.as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    if replaced == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn windows_api_path(path: &Path) -> io::Result<Vec<u16>> {
    use std::os::windows::ffi::OsStrExt;

    // `std::fs::canonicalize` returns an extended-length (`\\?\`) path on
    // Windows. For a destination that does not exist yet, canonicalize its
    // existing parent and append only the final component.
    let extended = match fs::canonicalize(path) {
        Ok(path) => path,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."));
            let file_name = path.file_name().ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!(
                        "atomic-write destination has no file name: {}",
                        path.display()
                    ),
                )
            })?;
            fs::canonicalize(parent)?.join(file_name)
        }
        Err(error) => return Err(error),
    };
    Ok(extended.as_os_str().encode_wide().chain(Some(0)).collect())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> io::Result<()> {
    fs::File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> io::Result<()> {
    // New files use MOVEFILE_WRITE_THROUGH. Existing files use ReplaceFileW,
    // whose WRITE_THROUGH flag is documented as unsupported; their temporary
    // contents were explicitly flushed before the metadata-preserving swap.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomically_replaces_the_complete_file() {
        let root =
            std::env::temp_dir().join(format!("markcaptain-atomic-write-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("data.json");
        fs::write(&path, br#"{"old":true}"#).unwrap();

        write(&path, br#"{"new":true}"#).unwrap();

        assert_eq!(fs::read(&path).unwrap(), br#"{"new":true}"#);
        assert!(fs::read_dir(&root).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn creates_missing_parent_directories() {
        let root = std::env::temp_dir().join(format!(
            "markcaptain-atomic-write-parent-{}",
            uuid::Uuid::new_v4()
        ));
        let path = root.join("nested").join("note.md");

        write(&path, b"safe").unwrap();

        assert_eq!(fs::read(path).unwrap(), b"safe");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn short_temp_name_supports_long_target_components() {
        let unique = uuid::Uuid::new_v4().simple().to_string();

        let ascii_prefix = format!("mt-ascii-{unique}-");
        let ascii_suffix = ".md";
        let ascii_name = format!(
            "{ascii_prefix}{}{ascii_suffix}",
            "a".repeat(240 - ascii_prefix.len() - ascii_suffix.len())
        );
        assert_eq!(ascii_name.len(), 240);

        let utf8_prefix = format!("mt-utf8-{unique}-");
        let utf8_suffix = ".md";
        let utf8_fill = (245 - utf8_prefix.len() - utf8_suffix.len()) / '界'.len_utf8();
        let utf8_name = format!("{utf8_prefix}{}{utf8_suffix}", "界".repeat(utf8_fill));
        assert!(utf8_name.len() >= 240);
        assert!(utf8_name.len() <= 245);

        exercise_long_target_name(&ascii_name);
        exercise_long_target_name(&utf8_name);
    }

    fn exercise_long_target_name(file_name: &str) {
        let path = std::env::temp_dir().join(file_name);
        if let Err(error) = fs::write(&path, b"old") {
            eprintln!(
                "skipping long filename atomic-write case unsupported by this platform: {error}"
            );
            return;
        }

        write(&path, b"new").unwrap_or_else(|error| {
            panic!(
                "atomic replacement failed after the platform accepted a {}-byte target name: {error}",
                file_name.len()
            )
        });
        assert_eq!(fs::read(&path).unwrap(), b"new");
        fs::remove_file(path).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_replace_preserves_existing_named_streams() {
        let root = std::env::temp_dir().join(format!(
            "markcaptain-atomic-write-stream-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("note.md");
        let stream = root.join("note.md:markcaptain-test");
        fs::write(&path, b"old").unwrap();
        if let Err(error) = fs::write(&stream, b"metadata") {
            eprintln!("skipping named-stream test on a filesystem without ADS support: {error}");
            fs::remove_dir_all(root).unwrap();
            return;
        }

        write(&path, b"new").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(fs::read(&stream).unwrap(), b"metadata");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn preserves_unix_permissions_and_follows_file_symlinks() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let root = std::env::temp_dir().join(format!(
            "markcaptain-atomic-write-symlink-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let target = root.join("target.md");
        let link = root.join("link.md");
        fs::write(&target, b"old").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
        symlink(&target, &link).unwrap();

        write(&link, b"new").unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o640
        );
        fs::remove_dir_all(root).unwrap();
    }
}
