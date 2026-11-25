use std::ffi::OsString;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize, Serializer};

use super::files::ctime_ms;
use crate::atomic_file::{RemoveOnDrop, remove_if_present, write_atomic};
use crate::identity::{ProcessIdentity, is_gone, may_be_same_process, this_process};

const LOCK_MODE: u32 = 0o600;
const EMPTY_LOCK_ABANDONED_AFTER: Duration = Duration::from_secs(30);
const CTIME_TOLERANCE_MS: f64 = 0.001;
const LARGEST_EXACT_INTEGER: f64 = 9_007_199_254_740_991.0;

pub(super) enum LockAttempt {
    Acquired(FileLock),
    Held(LockHolder),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum LockHolder {
    BeingTaken,
    Process(ProcessIdentity),
    Unknown,
}

#[derive(Debug)]
pub(super) struct FileLock {
    path: PathBuf,
}

impl FileLock {
    pub(super) fn is_held(&self) -> bool {
        holds_lock(&self.path)
    }
}

impl Drop for FileLock {
    fn drop(&mut self) {
        if holds_lock(&self.path) {
            let _ = remove_if_present(&owner_note_path(&self.path));
            let _ = remove_if_present(&self.path);
        }
    }
}

pub(super) fn try_lock(path: &Path) -> io::Result<LockAttempt> {
    if try_create_lock(path)? {
        return Ok(acquired(path));
    }
    let seen = read_lock(path);
    let cleared = match &seen {
        LockFile::Missing => true,
        stale if abandoned(stale) => break_stale(path, stale)?,
        LockFile::Holder(_) | LockFile::Empty { .. } | LockFile::Unreadable => false,
    };
    if cleared && try_create_lock(path)? {
        return Ok(acquired(path));
    }
    Ok(LockAttempt::Held(read_lock(path).holder()))
}

pub(super) fn holds_lock(path: &Path) -> bool {
    lock_owner(path).is_some_and(|owner| may_be_same_process(&owner, &this_process()))
}

pub(super) fn lock_owner(path: &Path) -> Option<ProcessIdentity> {
    match read_lock(path) {
        LockFile::Holder(owner) => Some(owner),
        LockFile::Missing | LockFile::Empty { .. } | LockFile::Unreadable => None,
    }
}

pub(super) fn describe_holder(path: &Path, holder: &LockHolder) -> String {
    match holder {
        LockHolder::BeingTaken => "a process that is taking it now; retry".to_owned(),
        LockHolder::Unknown => format!(
            "an unknown process (if none is running, remove {})",
            path.display()
        ),
        LockHolder::Process(owner) if is_gone(owner) => format!(
            "pid {}, which has exited (if no process is taking the lock over, remove {})",
            owner.pid,
            breaker_turn_path(path).display()
        ),
        LockHolder::Process(owner) => format!("pid {}", owner.pid),
    }
}

#[derive(Debug, Clone, PartialEq)]
enum LockFile {
    Missing,
    Holder(ProcessIdentity),
    Empty { ino: u64, modified: SystemTime },
    Unreadable,
}

impl LockFile {
    fn holder(self) -> LockHolder {
        match self {
            Self::Holder(owner) => LockHolder::Process(owner),
            Self::Empty { .. } => LockHolder::BeingTaken,
            Self::Missing | Self::Unreadable => LockHolder::Unknown,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwnerNote {
    #[serde(serialize_with = "javascript_number")]
    ctime_ms: f64,
    ino: u64,
    pid: u32,
    started: String,
}

fn acquired(path: &Path) -> LockAttempt {
    LockAttempt::Acquired(FileLock {
        path: path.to_owned(),
    })
}

fn try_create_lock(path: &Path) -> io::Result<bool> {
    let own = this_process();
    let opened = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(LOCK_MODE)
        .open(path);
    let mut file = match opened {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(false),
        Err(error) => return Err(error),
    };
    let written = file
        .write_all(own.pid.to_string().as_bytes())
        .and_then(|()| file.metadata());
    drop(file);
    let written = match written {
        Ok(written) => written,
        Err(error) => {
            let _ = remove_if_present(path);
            return Err(error);
        }
    };
    if !fs::metadata(path).is_ok_and(|current| current.ino() == written.ino()) {
        return Ok(false);
    }
    if let Some(started) = own.started {
        note_owner(
            path,
            &OwnerNote {
                ctime_ms: ctime_ms(&written),
                ino: written.ino(),
                pid: own.pid,
                started,
            },
        );
    }
    Ok(true)
}

fn note_owner(path: &Path, note: &OwnerNote) {
    if let Ok(encoded) = serde_json::to_vec(note) {
        let _ = write_atomic(&owner_note_path(path), &encoded, Some(LOCK_MODE));
    }
}

fn read_lock(path: &Path) -> LockFile {
    let read = fs::read(path).and_then(|contents| Ok((contents, fs::metadata(path)?)));
    let (contents, metadata) = match read {
        Ok(read) => read,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return LockFile::Missing,
        Err(_) => return LockFile::Unreadable,
    };
    if contents.is_empty() {
        return match metadata.modified() {
            Ok(modified) => LockFile::Empty {
                ino: metadata.ino(),
                modified,
            },
            Err(_) => LockFile::Unreadable,
        };
    }
    let pid = std::str::from_utf8(&contents)
        .ok()
        .and_then(|text| text.trim().parse::<u32>().ok())
        .filter(|&pid| pid > 0);
    match pid {
        Some(pid) => LockFile::Holder(ProcessIdentity {
            pid,
            started: owner_start(path, pid, &metadata),
        }),
        None => LockFile::Unreadable,
    }
}

fn owner_start(path: &Path, pid: u32, lock: &fs::Metadata) -> Option<String> {
    let contents = fs::read(owner_note_path(path)).ok()?;
    let note: OwnerNote = serde_json::from_slice(&contents).ok()?;
    let describes_lock = note.ino == lock.ino()
        && (note.ctime_ms - ctime_ms(lock)).abs() < CTIME_TOLERANCE_MS
        && note.pid == pid;
    describes_lock.then_some(note.started)
}

fn abandoned(lock: &LockFile) -> bool {
    match lock {
        LockFile::Holder(owner) => is_gone(owner),
        LockFile::Empty { modified, .. } => modified
            .elapsed()
            .is_ok_and(|age| age > EMPTY_LOCK_ABANDONED_AFTER),
        LockFile::Missing | LockFile::Unreadable => false,
    }
}

fn break_stale(path: &Path, seen: &LockFile) -> io::Result<bool> {
    let turn = breaker_turn_path(path);
    let opened = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(LOCK_MODE)
        .open(&turn);
    match opened {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Ok(false),
        Err(error) => return Err(error),
    }
    let _turn = RemoveOnDrop(turn);
    if read_lock(path) == *seen {
        remove_if_present(path)?;
    }
    Ok(true)
}

fn owner_note_path(path: &Path) -> PathBuf {
    sibling(path, ".owner")
}

fn breaker_turn_path(path: &Path) -> PathBuf {
    sibling(path, ".break")
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = OsString::from(path.as_os_str());
    name.push(suffix);
    PathBuf::from(name)
}

fn javascript_number<S: Serializer>(value: &f64, serializer: S) -> Result<S::Ok, S::Error> {
    if value.fract() == 0.0 && value.abs() <= LARGEST_EXACT_INTEGER {
        serializer.serialize_i64(*value as i64)
    } else {
        serializer.serialize_f64(*value)
    }
}

#[cfg(test)]
mod tests {
    use std::fs::File;
    use std::process::Command;

    use super::*;
    use crate::identity::read_start;

    const START: &str = "ps:Wed Nov 25 09:46:24 2026";
    const FOREIGN_PID: u32 = 4242;
    const LIVE_PID: u32 = 1;

    fn gone_pid() -> u32 {
        let mut child = Command::new("true").spawn().expect("true should spawn");
        child.wait().expect("the child should be reaped");
        child.id()
    }

    fn lock_in(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join("process")
    }

    fn take(path: &Path) -> FileLock {
        match try_lock(path).expect("the lock attempt") {
            LockAttempt::Acquired(lock) => lock,
            LockAttempt::Held(holder) => panic!("the lock is held by {holder:?}"),
        }
    }

    fn plant_lock(path: &Path, pid: u32, started: Option<&str>) {
        fs::write(path, pid.to_string()).expect("the foreign lock");
        let Some(started) = started else {
            return;
        };
        let metadata = fs::metadata(path).expect("the foreign lock");
        let note = format!(
            r#"{{"ctimeMs":{},"ino":{},"pid":{pid},"started":"{started}"}}"#,
            ctime_ms(&metadata),
            metadata.ino()
        );
        fs::write(owner_note_path(path), note).expect("the foreign owner note");
    }

    #[test]
    fn the_lock_file_holds_only_the_decimal_pid() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = lock_in(&dir);
        let _lock = take(&path);

        assert_eq!(
            fs::read_to_string(&path).expect("the lock"),
            std::process::id().to_string()
        );
        assert_eq!(fs::metadata(&path).expect("the lock").mode() & 0o777, 0o600);
    }

    #[test]
    fn the_owner_note_proves_the_lock_belongs_to_this_process() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = lock_in(&dir);
        let lock = take(&path);

        assert_eq!(lock_owner(&path), Some(this_process()));
        assert!(holds_lock(&path));
        assert!(lock.is_held());
        assert_eq!(
            fs::metadata(owner_note_path(&path))
                .expect("the note")
                .mode()
                & 0o777,
            0o600
        );
    }

    #[test]
    fn the_owner_note_describes_the_lock_file() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = lock_in(&dir);
        let _lock = take(&path);
        let encoded = fs::read_to_string(owner_note_path(&path)).expect("the note");
        let note: OwnerNote = serde_json::from_str(&encoded).expect("a readable note");
        let metadata = fs::metadata(&path).expect("the lock");

        assert!(encoded.starts_with(r#"{"ctimeMs":"#));
        assert!(encoded.contains(&format!(
            r#","ino":{},"pid":{},"started":"#,
            metadata.ino(),
            std::process::id()
        )));
        assert_eq!(note.ctime_ms.to_bits(), ctime_ms(&metadata).to_bits());
        assert_eq!(Some(note.started), this_process().started);
    }

    #[test]
    fn ctimes_are_written_the_way_javascript_prints_them() {
        let note = |ctime_ms| OwnerNote {
            ctime_ms,
            ino: 327_831_920,
            pid: 42,
            started: START.to_owned(),
        };
        let encode = |ctime_ms| serde_json::to_string(&note(ctime_ms)).expect("an encodable note");

        assert_eq!(
            encode(1_795_617_955_724.127_7),
            format!(
                r#"{{"ctimeMs":1795617955724.1277,"ino":327831920,"pid":42,"started":"{START}"}}"#
            )
        );
        assert_eq!(
            encode(1_795_617_955_724.0),
            format!(r#"{{"ctimeMs":1795617955724,"ino":327831920,"pid":42,"started":"{START}"}}"#)
        );
    }

    #[test]
    fn a_replaced_lock_file_loses_its_owner_start() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = lock_in(&dir);
        plant_lock(&path, FOREIGN_PID, Some(START));
        fs::remove_file(&path).expect("the old lock");
        fs::write(&path, FOREIGN_PID.to_string()).expect("the replacement lock");

        assert_eq!(
            lock_owner(&path),
            Some(ProcessIdentity {
                pid: FOREIGN_PID,
                started: None
            })
        );
    }

    #[test]
    fn a_foreign_note_with_a_matching_inode_reveals_the_owner_start() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = lock_in(&dir);
        plant_lock(&path, FOREIGN_PID, Some(START));

        assert_eq!(
            lock_owner(&path),
            Some(ProcessIdentity {
                pid: FOREIGN_PID,
                started: Some(START.to_owned())
            })
        );
        assert!(!holds_lock(&path));
    }

    #[test]
    fn a_live_holder_keeps_the_lock() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = lock_in(&dir);
        let started = read_start(LIVE_PID).known();
        plant_lock(&path, LIVE_PID, started.as_deref());

        let attempt = try_lock(&path).expect("the lock attempt");
        let LockAttempt::Held(holder) = attempt else {
            panic!("a live holder should keep the lock");
        };
        assert_eq!(describe_holder(&path, &holder), format!("pid {LIVE_PID}"));
        assert_eq!(
            fs::read_to_string(&path).expect("the lock"),
            LIVE_PID.to_string()
        );
    }

    #[test]
    fn a_gone_holder_loses_the_lock() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = lock_in(&dir);
        plant_lock(&path, gone_pid(), Some(START));

        let attempt = try_lock(&path).expect("the lock attempt");

        assert!(matches!(attempt, LockAttempt::Acquired(_)));
        assert!(holds_lock(&path));
        assert!(!breaker_turn_path(&path).exists());
    }

    #[test]
    fn a_concurrent_breaker_wins_the_turn() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = lock_in(&dir);
        let gone = gone_pid();
        plant_lock(&path, gone, Some(START));
        fs::write(breaker_turn_path(&path), "").expect("the other breaker's turn");

        let attempt = try_lock(&path).expect("the lock attempt");
        let LockAttempt::Held(holder) = attempt else {
            panic!("another breaker holds the turn");
        };
        assert_eq!(
            describe_holder(&path, &holder),
            format!(
                "pid {gone}, which has exited (if no process is taking the lock over, remove {})",
                breaker_turn_path(&path).display()
            )
        );
    }

    #[test]
    fn a_fresh_empty_lock_is_being_taken() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = lock_in(&dir);
        File::create(&path).expect("the empty lock");

        let attempt = try_lock(&path).expect("the lock attempt");
        let LockAttempt::Held(holder) = attempt else {
            panic!("a fresh empty lock is being taken");
        };
        assert_eq!(
            describe_holder(&path, &holder),
            "a process that is taking it now; retry"
        );
    }

    #[test]
    fn an_abandoned_empty_lock_is_broken() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = lock_in(&dir);
        let file = File::create(&path).expect("the empty lock");
        file.set_modified(SystemTime::now() - Duration::from_secs(31))
            .expect("backdating the empty lock");
        drop(file);

        assert!(matches!(
            try_lock(&path).expect("the lock attempt"),
            LockAttempt::Acquired(_)
        ));
    }

    #[test]
    fn unreadable_contents_name_an_unknown_holder() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = lock_in(&dir);
        fs::write(&path, "not a pid").expect("the odd lock");

        let LockAttempt::Held(holder) = try_lock(&path).expect("the lock attempt") else {
            panic!("an unreadable lock is never broken");
        };
        assert_eq!(
            describe_holder(&path, &holder),
            format!(
                "an unknown process (if none is running, remove {})",
                path.display()
            )
        );
    }

    #[test]
    fn dropping_the_lock_removes_it_and_its_note() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = lock_in(&dir);
        drop(take(&path));

        assert!(!path.exists());
        assert!(!owner_note_path(&path).exists());
    }

    #[test]
    fn dropping_a_lost_lock_spares_its_successor() {
        let dir = tempfile::tempdir().expect("a temporary directory");
        let path = lock_in(&dir);
        let stale = take(&path);
        fs::remove_file(&path).expect("the lock");
        plant_lock(&path, FOREIGN_PID, Some(START));

        assert!(!stale.is_held());
        drop(stale);
        assert_eq!(lock_owner(&path).map(|owner| owner.pid), Some(FOREIGN_PID));
        assert!(owner_note_path(&path).exists());
    }
}
