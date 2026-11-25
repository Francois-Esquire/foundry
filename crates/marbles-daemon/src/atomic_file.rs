use std::fs::{self, OpenOptions};
use std::io::{self, Write};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMPORARY_SERIAL: AtomicU64 = AtomicU64::new(0);

pub(crate) fn write_atomic(path: &Path, contents: &[u8], mode: Option<u32>) -> io::Result<()> {
    let temporary = RemoveOnDrop(temporary_beside(path));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if let Some(mode) = mode {
        options.mode(mode);
    }
    let mut file = options.open(&temporary.0)?;
    #[cfg(unix)]
    if let Some(mode) = mode {
        file.set_permissions(fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    file.write_all(contents)?;
    drop(file);
    fs::rename(&temporary.0, path)
}

pub(crate) fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

pub(crate) struct RemoveOnDrop(pub(crate) PathBuf);

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = remove_if_present(&self.0);
    }
}

fn temporary_beside(path: &Path) -> PathBuf {
    let serial = TEMPORARY_SERIAL.fetch_add(1, Ordering::Relaxed);
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".{}.{serial}.tmp", std::process::id()));
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_writes_replace_the_target_and_leave_no_temporaries() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = dir.path().join("note");

        write_atomic(&path, b"first", None).expect("the first write");
        write_atomic(&path, b"second", Some(0o600)).expect("the second write");

        let entries = fs::read_dir(dir.path()).expect("the directory").count();
        assert_eq!(fs::read_to_string(&path).expect("the note"), "second");
        assert_eq!(entries, 1);
        #[cfg(unix)]
        {
            let mode = fs::metadata(&path).expect("the note").permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn removing_an_absent_file_is_not_an_error() {
        let dir = tempfile::tempdir().expect("a temporary directory");

        assert!(remove_if_present(&dir.path().join("absent")).is_ok());
    }
}
