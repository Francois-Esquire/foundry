mod client;
mod field;
mod frame;
mod generation;
mod message;
mod methods;
mod non_empty_string;
#[cfg(test)]
mod test_json;

use std::time::Duration;

use thiserror::Error;

pub use crate::identity::ProcessIdentity;
pub use client::{
    AttachParams, DaemonRequest, HelloResult, RegisterParams, SetupDraftParams, WorkspaceIdParams,
    WorkspaceState, WorkspaceSummary,
};
pub use frame::{LineSplitter, LineTooLong, OverflowPolicy, PushedLines};
pub use generation::{
    AgentInput, AgentWork, CommandInput, CommandWork, HandedParams, HostParams, HostResult,
    LineNotificationParams, LiveRun, LiveWork, LoadResult, QueuedParams, QueuedTakeResult,
    ReadNotificationParams, RetireParams, StartParams, StartResult, WorkspaceLoadResult,
    is_valid_live_runs,
};
pub use message::{Notification, Request, Response, WireError, WireMessage, decode, encode};
pub use methods::{
    ClientNotification, DaemonMethod, GenerationMethod, GenerationNotification, WORKSPACE_PREFIX,
    WorkspaceMethod, WorkspaceRoute,
};
pub use non_empty_string::{EmptyString, NonEmptyString};

pub const PROTOCOL_VERSION: u32 = 1;

pub const MAX_LINE_BYTES: usize = 1024 * 1024;

pub const GENERATION_STOP_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("the message is malformed: {0}")]
    Malformed(#[from] serde_json::Error),
    #[error("a wire message must be a JSON object")]
    NotAnObject,
    #[error("a wire message needs an id, a method, or both")]
    MissingIdAndMethod,
    #[error("\"{0}\" is not a known method")]
    UnknownMethod(String),
    #[error("\"{method}\" was sent invalid params: {source}")]
    InvalidParams {
        method: String,
        #[source]
        source: serde_json::Error,
    },
}
