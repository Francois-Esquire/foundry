use std::env;
use std::fs::{self, Metadata};
use std::io;
use std::path::{self, Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use super::BinaryDigest;

pub const STABILITY_WINDOW: Duration = Duration::from_millis(500);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecycleTarget {
    pub executable: PathBuf,
    pub previous_digest: BinaryDigest,
    pub new_digest: BinaryDigest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BinaryChange {
    Unchanged,
    Pending,
    Ready(RecycleTarget),
}

#[derive(Debug)]
pub struct BinaryWatch {
    executable: PathBuf,
    initial_digest: BinaryDigest,
    stability_window: Duration,
    observed: Option<FileStamp>,
    pending: Option<PendingChange>,
}

#[derive(Debug)]
struct PendingChange {
    digest: BinaryDigest,
    since: Instant,
}

#[derive(Debug, PartialEq, Eq)]
struct FileStamp {
    len: u64,
    modified: Option<SystemTime>,
    link: Option<PathBuf>,
    identity: FileIdentity,
    executable: bool,
}

impl BinaryWatch {
    pub fn capture_current() -> io::Result<Self> {
        let current = env::current_exe()?;
        let executable = env::args_os()
            .next()
            .and_then(|launched| launched_as(PathBuf::from(launched), &current))
            .unwrap_or(current);
        Self::for_path(executable, STABILITY_WINDOW)
    }

    pub fn for_path(executable: PathBuf, stability_window: Duration) -> io::Result<Self> {
        let executable = path::absolute(executable)?;
        let observed = FileStamp::read(&executable)?;
        let initial_digest = BinaryDigest::hash_file(&executable)?;
        Ok(Self {
            executable,
            initial_digest,
            stability_window,
            observed: Some(observed),
            pending: None,
        })
    }

    pub fn with_stability_window(self, stability_window: Duration) -> Self {
        Self {
            stability_window,
            ..self
        }
    }

    pub fn initial_digest(&self) -> BinaryDigest {
        self.initial_digest
    }

    pub fn executable_path(&self) -> &Path {
        &self.executable
    }

    pub fn poll(&mut self) -> BinaryChange {
        self.poll_at(Instant::now())
    }

    fn poll_at(&mut self, now: Instant) -> BinaryChange {
        let Ok(stamp) = FileStamp::read(&self.executable) else {
            return self.forget();
        };
        if self.pending.is_none() && self.observed.as_ref() == Some(&stamp) {
            return BinaryChange::Unchanged;
        }
        if !stamp.executable {
            return self.forget();
        }
        let Ok(digest) = BinaryDigest::hash_file(&self.executable) else {
            return self.forget();
        };
        self.observed = Some(stamp);
        self.settle(digest, now)
    }

    fn settle(&mut self, digest: BinaryDigest, now: Instant) -> BinaryChange {
        if digest == self.initial_digest {
            self.pending = None;
            return BinaryChange::Unchanged;
        }
        match &self.pending {
            Some(pending) if pending.digest == digest => {
                if now.saturating_duration_since(pending.since) < self.stability_window {
                    BinaryChange::Pending
                } else {
                    BinaryChange::Ready(RecycleTarget {
                        executable: self.executable.clone(),
                        previous_digest: self.initial_digest,
                        new_digest: digest,
                    })
                }
            }
            _ => {
                self.pending = Some(PendingChange { digest, since: now });
                BinaryChange::Pending
            }
        }
    }

    fn forget(&mut self) -> BinaryChange {
        self.observed = None;
        self.pending = None;
        BinaryChange::Unchanged
    }
}

fn launched_as(launched: PathBuf, current: &Path) -> Option<PathBuf> {
    let launched = path::absolute(launched).ok()?;
    let same = fs::canonicalize(&launched).ok()? == fs::canonicalize(current).ok()?;
    same.then_some(launched)
}

impl FileStamp {
    fn read(path: &Path) -> io::Result<Self> {
        let metadata = fs::metadata(path)?;
        let identity = FileIdentity::of(&metadata);
        Ok(Self {
            len: metadata.len(),
            modified: metadata.modified().ok(),
            link: fs::read_link(path).ok(),
            executable: metadata.is_file() && identity.is_executable(),
            identity,
        })
    }
}

#[cfg(unix)]
#[derive(Debug, PartialEq, Eq)]
struct FileIdentity {
    device: u64,
    inode: u64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
    mode: u32,
}

#[cfg(unix)]
impl FileIdentity {
    fn of(metadata: &Metadata) -> Self {
        use std::os::unix::fs::MetadataExt;

        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            changed_seconds: metadata.ctime(),
            changed_nanoseconds: metadata.ctime_nsec(),
            mode: metadata.mode(),
        }
    }

    fn is_executable(&self) -> bool {
        self.mode & 0o111 != 0
    }
}

#[cfg(not(unix))]
#[derive(Debug, PartialEq, Eq)]
struct FileIdentity;

#[cfg(not(unix))]
impl FileIdentity {
    fn of(_metadata: &Metadata) -> Self {
        Self
    }

    fn is_executable(&self) -> bool {
        true
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::fs::{File, Permissions};
    use std::os::unix::fs::{PermissionsExt, symlink};

    use super::*;

    const WINDOW: Duration = Duration::from_millis(20);
    const ORIGINAL: &[u8] = b"#!/bin/sh\necho original\n";
    const CHANGED: &[u8] = b"#!/bin/sh\necho originaL\n";
    const CHANGED_AGAIN: &[u8] = b"#!/bin/sh\necho oRiginal\n";

    struct WatchedBinary {
        dir: tempfile::TempDir,
        path: PathBuf,
    }

    impl WatchedBinary {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("a temporary directory");
            let path = dir.path().join("marbles-daemon");
            install(&path, ORIGINAL, 0o755);
            Self { dir, path }
        }

        fn watch(&self) -> BinaryWatch {
            BinaryWatch::for_path(self.path.clone(), WINDOW).expect("the watch")
        }
    }

    fn install(path: &Path, bytes: &[u8], mode: u32) {
        let mut staged = path.as_os_str().to_owned();
        staged.push(".staged");
        let staged = PathBuf::from(staged);
        fs::write(&staged, bytes).expect("the staged binary");
        fs::set_permissions(&staged, Permissions::from_mode(mode)).expect("the mode");
        fs::rename(&staged, path).expect("the installed binary");
    }

    fn digest(bytes: &[u8]) -> BinaryDigest {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = dir.path().join("bytes");
        fs::write(&path, bytes).expect("the bytes");
        BinaryDigest::hash_file(&path).expect("the digest")
    }

    fn ready(executable: &Path, new: &[u8]) -> BinaryChange {
        BinaryChange::Ready(RecycleTarget {
            executable: executable.to_owned(),
            previous_digest: digest(ORIGINAL),
            new_digest: digest(new),
        })
    }

    #[test]
    fn an_untouched_binary_stays_unchanged() {
        let bin = WatchedBinary::new();
        let mut watch = bin.watch();
        let now = Instant::now();

        assert_eq!(watch.initial_digest(), digest(ORIGINAL));
        assert_eq!(watch.executable_path(), bin.path);
        assert_eq!(watch.poll_at(now), BinaryChange::Unchanged);
        assert_eq!(watch.poll_at(now + WINDOW * 10), BinaryChange::Unchanged);
    }

    #[test]
    fn a_one_byte_change_is_ready_once_stable_for_the_window() {
        let bin = WatchedBinary::new();
        let mut watch = bin.watch();
        let seen = Instant::now();

        install(&bin.path, CHANGED, 0o755);

        assert_eq!(watch.poll_at(seen), BinaryChange::Pending);
        assert_eq!(
            watch.poll_at(seen + WINDOW - Duration::from_millis(1)),
            BinaryChange::Pending
        );
        assert_eq!(watch.poll_at(seen + WINDOW), ready(&bin.path, CHANGED));
    }

    #[test]
    fn an_in_place_overwrite_is_detected() {
        let bin = WatchedBinary::new();
        let mut watch = bin.watch();
        let seen = Instant::now();
        let modified = fs::metadata(&bin.path)
            .and_then(|metadata| metadata.modified())
            .expect("the modified time");

        fs::write(&bin.path, CHANGED).expect("the overwrite");
        File::options()
            .write(true)
            .open(&bin.path)
            .and_then(|file| file.set_modified(modified + Duration::from_secs(1)))
            .expect("a distinct modified time");

        assert_eq!(watch.poll_at(seen), BinaryChange::Pending);
        assert_eq!(watch.poll_at(seen + WINDOW), ready(&bin.path, CHANGED));
    }

    #[test]
    fn another_change_mid_debounce_restarts_the_window() {
        let bin = WatchedBinary::new();
        let mut watch = bin.watch();
        let first = Instant::now();
        install(&bin.path, CHANGED, 0o755);
        assert_eq!(watch.poll_at(first), BinaryChange::Pending);

        install(&bin.path, CHANGED_AGAIN, 0o755);
        let second = first + WINDOW;

        assert_eq!(watch.poll_at(second), BinaryChange::Pending);
        assert_eq!(
            watch.poll_at(second + WINDOW - Duration::from_millis(1)),
            BinaryChange::Pending
        );
        assert_eq!(
            watch.poll_at(second + WINDOW),
            ready(&bin.path, CHANGED_AGAIN)
        );
    }

    #[test]
    fn reverting_to_the_original_bytes_cancels_the_change() {
        let bin = WatchedBinary::new();
        let mut watch = bin.watch();
        let seen = Instant::now();
        install(&bin.path, CHANGED, 0o755);
        assert_eq!(watch.poll_at(seen), BinaryChange::Pending);

        install(&bin.path, ORIGINAL, 0o755);

        assert_eq!(watch.poll_at(seen + WINDOW), BinaryChange::Unchanged);
        assert_eq!(watch.poll_at(seen + WINDOW * 10), BinaryChange::Unchanged);
    }

    #[test]
    fn a_missing_or_non_executable_binary_is_ignored_until_it_can_run() {
        let bin = WatchedBinary::new();
        let mut watch = bin.watch();
        let seen = Instant::now();

        fs::remove_file(&bin.path).expect("the removal");
        assert_eq!(watch.poll_at(seen), BinaryChange::Unchanged);

        install(&bin.path, CHANGED, 0o644);
        assert_eq!(watch.poll_at(seen), BinaryChange::Unchanged);
        assert_eq!(watch.poll_at(seen + WINDOW * 10), BinaryChange::Unchanged);

        fs::set_permissions(&bin.path, Permissions::from_mode(0o755)).expect("the mode");
        let runnable = seen + WINDOW * 20;
        assert_eq!(watch.poll_at(runnable), BinaryChange::Pending);
        assert_eq!(watch.poll_at(runnable + WINDOW), ready(&bin.path, CHANGED));
    }

    #[test]
    fn repointing_a_launch_symlink_is_ready_through_the_symlink() {
        let bin = WatchedBinary::new();
        let upgraded = bin.dir.path().join("marbles-daemon-next");
        install(&upgraded, CHANGED, 0o755);
        let launcher = bin.dir.path().join("launcher");
        symlink(&bin.path, &launcher).expect("the launch symlink");
        let mut watch = BinaryWatch::for_path(launcher.clone(), WINDOW).expect("the watch");
        let seen = Instant::now();

        let staged = bin.dir.path().join("launcher.staged");
        symlink(&upgraded, &staged).expect("the repointed symlink");
        fs::rename(&staged, &launcher).expect("the repoint");

        assert_eq!(watch.poll_at(seen), BinaryChange::Pending);
        let change = watch.poll_at(seen + WINDOW);
        assert_eq!(change, ready(&launcher, CHANGED));
        let BinaryChange::Ready(target) = change else {
            panic!("the repointed symlink should be ready");
        };
        assert_eq!(
            fs::canonicalize(&target.executable).ok(),
            fs::canonicalize(&upgraded).ok()
        );
    }

    #[test]
    fn a_launch_path_is_kept_only_when_it_reaches_the_running_binary() {
        let bin = WatchedBinary::new();
        let launcher = bin.dir.path().join("launcher");
        symlink(&bin.path, &launcher).expect("the launch symlink");
        let unrelated = bin.dir.path().join("unrelated");
        install(&unrelated, CHANGED, 0o755);

        assert_eq!(launched_as(launcher.clone(), &bin.path), Some(launcher));
        assert_eq!(launched_as(unrelated, &bin.path), None);
        assert_eq!(launched_as(bin.dir.path().join("missing"), &bin.path), None);
    }

    #[test]
    fn the_stability_window_can_be_tuned() {
        let watch = WatchedBinary::new()
            .watch()
            .with_stability_window(STABILITY_WINDOW);

        assert_eq!(watch.stability_window, STABILITY_WINDOW);
    }
}
