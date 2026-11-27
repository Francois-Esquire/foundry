use std::future::Future;
use std::pin::Pin;

use crate::protocol::WorkspaceSummary;

pub(crate) type ProcessChange<'a> = Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Publication {
    Workspace(WorkspaceSummary),
    Line { workspace: String, line: String },
    Withdrawn(String),
}

pub(crate) trait DaemonLink: Send + Sync + 'static {
    fn publish(&self, publication: Publication);
    fn process_change(&self) -> ProcessChange<'_>;
}
