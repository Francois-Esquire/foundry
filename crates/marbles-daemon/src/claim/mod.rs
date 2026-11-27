mod files;
mod lock;
mod record;
#[cfg(test)]
mod tests;

use std::fs::{self, DirBuilder, Permissions};
use std::io;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use thiserror::Error;

use self::lock::{FileLock, LockAttempt, describe_holder, lock_owner, try_lock};
pub use self::record::{ProcessHost, RecordedProcess};
use crate::Layout;
use crate::atomic_file::remove_if_present;
use crate::identity::is_gone;
use crate::timestamp::iso_timestamp;

pub const STATE_MODE: u32 = 0o700;

const LOCKS_DIR: &str = "locks";
const PROCESS_LOCK: &str = "process";
const PROCESS_FILE: &str = "process.json";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessStatus {
    pub alive: bool,
    pub pid: u32,
    pub recorded: Option<RecordedProcess>,
}

#[derive(Debug, Error)]
pub enum ClaimError {
    #[error("{}", held_message(.state, .holder_description, .last_recorded.as_deref()))]
    AlreadyHeld {
        state: PathBuf,
        holder_description: String,
        last_recorded: Option<Box<ProcessStatus>>,
    },
    #[error("could not {action} {}: {source}", .path.display())]
    Io {
        action: &'static str,
        path: PathBuf,
        source: io::Error,
    },
}

#[derive(Debug)]
pub struct ProcessClaim {
    process_file: PathBuf,
    started_at: String,
    lock: FileLock,
}

impl ProcessClaim {
    pub fn acquire(layout: &Layout, marbles_version: &str) -> Result<Self, ClaimError> {
        let state = layout.state.as_path();
        prepare_state_root(state)?;
        let locks = state.join(LOCKS_DIR);
        fs::create_dir_all(&locks).map_err(io_error("create", &locks))?;
        let lock_path = locks.join(PROCESS_LOCK);
        let lock = match try_lock(&lock_path).map_err(io_error("lock", &lock_path))? {
            LockAttempt::Acquired(lock) => lock,
            LockAttempt::Held(holder) => {
                return Err(ClaimError::AlreadyHeld {
                    state: state.to_owned(),
                    holder_description: describe_holder(&lock_path, &holder),
                    last_recorded: read_process(state).map(Box::new),
                });
            }
        };
        let process_file = state.join(PROCESS_FILE);
        let started_at = iso_timestamp(SystemTime::now());
        RecordedProcess {
            artifacts: Some(layout.artifacts.clone()),
            config: None,
            host: ProcessHost::Daemon,
            pid: std::process::id(),
            socket: Some(layout.socket.clone()),
            started_at: started_at.clone(),
            marbles_version: Some(marbles_version.to_owned()),
        }
        .write(&process_file)
        .map_err(io_error("record the process in", &process_file))?;
        Ok(Self {
            process_file,
            started_at,
            lock,
        })
    }

    pub fn started_at(&self) -> &str {
        &self.started_at
    }

    pub fn is_held(&self) -> bool {
        self.lock.is_held()
    }

    pub fn release(self) {
        drop(self);
    }
}

impl Drop for ProcessClaim {
    fn drop(&mut self) {
        let recorded = RecordedProcess::read(&self.process_file);
        if recorded.is_some_and(|recorded| recorded.pid == std::process::id()) {
            let _ = remove_if_present(&self.process_file);
        }
    }
}

pub fn read_process(state: &Path) -> Option<ProcessStatus> {
    let owner = lock_owner(&state.join(LOCKS_DIR).join(PROCESS_LOCK));
    let recorded = RecordedProcess::read(&state.join(PROCESS_FILE));
    let pid = owner
        .as_ref()
        .map(|owner| owner.pid)
        .or(recorded.as_ref().map(|recorded| recorded.pid))?;
    Some(ProcessStatus {
        alive: owner.as_ref().is_some_and(|owner| !is_gone(owner)),
        pid,
        recorded: recorded.filter(|recorded| recorded.pid == pid),
    })
}

fn prepare_state_root(state: &Path) -> Result<(), ClaimError> {
    if let Some(parent) = state.parent() {
        fs::create_dir_all(parent).map_err(io_error("create", parent))?;
    }
    DirBuilder::new()
        .recursive(true)
        .mode(STATE_MODE)
        .create(state)
        .map_err(io_error("create the state root", state))?;
    fs::set_permissions(state, Permissions::from_mode(STATE_MODE))
        .map_err(io_error("secure the state root", state))
}

fn io_error(action: &'static str, path: &Path) -> impl FnOnce(io::Error) -> ClaimError {
    let path = path.to_owned();
    move |source| ClaimError::Io {
        action,
        path,
        source,
    }
}

fn held_message(state: &Path, holder: &str, last_recorded: Option<&ProcessStatus>) -> String {
    let recorded = last_recorded
        .filter(|status| status.alive)
        .and_then(|status| status.recorded.as_ref());
    let host = recorded
        .map(|recorded| format!(" ({})", recorded.host))
        .unwrap_or_default();
    let since = recorded
        .map(|recorded| format!(" since {}", recorded.started_at))
        .unwrap_or_default();
    format!(
        "a Marbles process already runs here: {holder}{host}{since}. Stop it first, or set FOUNDRY_ROOT to another Foundry home (state: {}).",
        state.display()
    )
}
