mod actor;
mod initializer;
mod output;
mod route;
#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use thiserror::Error;
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinError;

use self::actor::{Actor, Command, DaemonEvent};
pub use self::initializer::{
    InitError, Initialization, InitializeTrigger, Initializer, NoopInitializer,
};
pub use self::output::{OutputSink, StdoutSink};
use crate::Layout;
use crate::claim::{ClaimError, ProcessClaim};
use crate::endpoint::{Endpoint, EndpointError};
use crate::protocol::{HelloResult, PROTOCOL_VERSION, WorkspaceSummary};

pub const CLAIM_CHECK_INTERVAL: Duration = Duration::from_secs(5);

const MAILBOX_CAPACITY: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LifecyclePhase {
    Starting,
    Initializing,
    Running,
    Recycling,
    Stopping,
    Stopped,
}

#[derive(Debug, Error)]
pub enum StartError {
    #[error(transparent)]
    Claim(#[from] ClaimError),
    #[error("the Marbles process could not initialize: {0}")]
    Initialize(#[source] InitError),
    #[error(transparent)]
    Endpoint(#[from] EndpointError),
    #[error("the claim could not be taken: {0}")]
    Claiming(#[source] JoinError),
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ProcessChangeError {
    #[error("the Marbles process is stopping")]
    Stopping,
    #[error("initializing after the process change failed: {0}")]
    Initialize(String),
}

pub struct DaemonOptions {
    pub layout: Layout,
    pub version: String,
    pub initializer: Arc<dyn Initializer>,
    pub output: Arc<dyn OutputSink>,
    pub claim_check_interval: Duration,
}

impl DaemonOptions {
    pub fn new(layout: Layout, version: impl Into<String>) -> Self {
        Self {
            layout,
            version: version.into(),
            initializer: Arc::new(NoopInitializer),
            output: Arc::new(StdoutSink),
            claim_check_interval: CLAIM_CHECK_INTERVAL,
        }
    }

    pub fn with_initializer(self, initializer: impl Initializer) -> Self {
        Self {
            initializer: Arc::new(initializer),
            ..self
        }
    }

    pub fn with_output(self, output: impl OutputSink) -> Self {
        Self {
            output: Arc::new(output),
            ..self
        }
    }

    pub fn with_claim_check_interval(self, claim_check_interval: Duration) -> Self {
        Self {
            claim_check_interval,
            ..self
        }
    }
}

#[derive(Debug)]
struct Started {
    pid: u32,
    socket: PathBuf,
    started_at: String,
}

#[derive(Debug, Clone)]
pub struct DaemonHandle {
    started: Arc<Started>,
    mailbox: mpsc::Sender<DaemonEvent>,
    phase: watch::Receiver<LifecyclePhase>,
}

pub async fn start(options: DaemonOptions) -> Result<DaemonHandle, StartError> {
    let DaemonOptions {
        layout,
        version,
        initializer,
        output,
        claim_check_interval,
    } = options;
    let (phase, observed) = watch::channel(LifecyclePhase::Starting);
    let claim = take_claim(&layout, &version).await?;
    phase.send_replace(LifecyclePhase::Initializing);
    if let Err(error) = initializer.initialize(InitializeTrigger::Start).await {
        release(claim).await;
        return Err(StartError::Initialize(error));
    }
    let endpoint = match Endpoint::bind(&layout.socket) {
        Ok(endpoint) => endpoint,
        Err(error) => {
            release(claim).await;
            return Err(error.into());
        }
    };
    let started = Arc::new(Started {
        pid: std::process::id(),
        socket: layout.socket.clone(),
        started_at: claim.started_at().to_owned(),
    });
    let hello = HelloResult {
        artifacts: layout.artifacts.display().to_string(),
        pid: started.pid,
        protocol: PROTOCOL_VERSION,
        started_at: started.started_at.clone(),
        state: layout.state.display().to_string(),
        version,
    };
    output.line(&format!(
        "[marbles] pid {} · {}",
        started.pid,
        started.socket.display()
    ));
    let (mailbox, received) = mpsc::channel(MAILBOX_CAPACITY);
    phase.send_replace(LifecyclePhase::Running);
    let actor = Actor::new(actor::Parts {
        hello,
        claim: Arc::new(claim),
        endpoint,
        initializer,
        output,
        phase,
        mailbox: received,
        events: mailbox.clone(),
    });
    tokio::spawn(actor.run(claim_check_interval));
    Ok(DaemonHandle {
        started,
        mailbox,
        phase: observed,
    })
}

impl DaemonHandle {
    pub fn pid(&self) -> u32 {
        self.started.pid
    }

    pub fn socket(&self) -> &Path {
        &self.started.socket
    }

    pub fn started_at(&self) -> &str {
        &self.started.started_at
    }

    pub fn phase(&self) -> LifecyclePhase {
        *self.phase.borrow()
    }

    pub async fn shutdown(&self) {
        self.command(Command::Shutdown).await;
        self.wait_closed().await;
    }

    pub async fn trigger_process_change(&self) -> Result<(), ProcessChangeError> {
        let (reply, answered) = oneshot::channel();
        self.command(Command::ProcessChange(reply)).await;
        answered.await.unwrap_or(Err(ProcessChangeError::Stopping))
    }

    pub async fn publish_workspace(&self, summary: WorkspaceSummary) {
        self.command(Command::PublishWorkspace(summary)).await;
    }

    pub async fn publish_line(&self, workspace: impl Into<String>, line: impl Into<String>) {
        self.command(Command::PublishLine {
            workspace: workspace.into(),
            line: line.into(),
        })
        .await;
    }

    pub async fn wait_closed(&self) {
        let mut phase = self.phase.clone();
        let _ = phase
            .wait_for(|phase| *phase == LifecyclePhase::Stopped)
            .await;
    }

    async fn command(&self, command: Command) {
        let _ = self.mailbox.send(DaemonEvent::Command(command)).await;
    }
}

async fn take_claim(layout: &Layout, version: &str) -> Result<ProcessClaim, StartError> {
    let layout = layout.clone();
    let version = version.to_owned();
    tokio::task::spawn_blocking(move || ProcessClaim::acquire(&layout, &version))
        .await
        .map_err(StartError::Claiming)?
        .map_err(StartError::from)
}

async fn release(claim: ProcessClaim) {
    let _ = tokio::task::spawn_blocking(move || claim.release()).await;
}
