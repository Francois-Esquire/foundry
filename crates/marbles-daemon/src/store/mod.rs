mod memory;
mod runs;
mod serial;
mod sqlite;
mod storage;
#[cfg(test)]
pub(crate) mod tests;

use std::path::PathBuf;

use thiserror::Error;

pub(crate) use self::serial::inside_state;
pub use self::serial::{StateStore, Stored};
use crate::identity::ProcessIdentity;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum StoreError {
    #[error("the state store failed: {0}")]
    Failed(String),
    #[error("the state store has stopped")]
    Stopped,
}

impl StoreError {
    pub(crate) fn failed(error: impl ToString) -> Self {
        Self::Failed(error.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredWorkspace {
    pub id: String,
    pub root: PathBuf,
    pub config: Option<PathBuf>,
    pub hosted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GenerationState {
    Loading,
    Current,
    Retiring,
    Failed,
    Exited,
}

impl GenerationState {
    pub const LIVE: [Self; 3] = [Self::Loading, Self::Current, Self::Retiring];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Loading => "loading",
            Self::Current => "current",
            Self::Retiring => "retiring",
            Self::Failed => "failed",
            Self::Exited => "exited",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        [
            Self::Loading,
            Self::Current,
            Self::Retiring,
            Self::Failed,
            Self::Exited,
        ]
        .into_iter()
        .find(|state| state.as_str() == text)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenerationRecord {
    pub number: u64,
    pub fingerprint: String,
    pub pid: i64,
    pub started: Option<String>,
    pub state: GenerationState,
    pub error: Option<String>,
    pub workspaces: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueuedRun {
    pub id: String,
    pub owner: ProcessIdentity,
}
