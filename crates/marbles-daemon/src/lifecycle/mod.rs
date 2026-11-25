mod actor;
mod initializer;
mod link;
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
    INITIALIZE_TRIGGER_ENV, InitError, Initialization, InitializeTrigger, Initializer,
    NoopInitializer, SubprocessInitializer,
};
use self::link::LifecycleLink;
use crate::Layout;
use crate::claim::{ClaimError, ProcessClaim};
use crate::endpoint::{Endpoint, EndpointError};
#[cfg(test)]
use crate::generation::ReadObserver;
use crate::generation::{GenerationLauncher, Supervisor, SupervisorParts, TimingConfig};
pub use crate::output::{OutputSink, StdoutSink};
use crate::protocol::{HelloResult, PROTOCOL_VERSION, WorkspaceSummary};
use crate::recycle::{BinaryWatch, RecycleTarget};
use crate::store::{StateStore, StoreError};

pub const CLAIM_CHECK_INTERVAL: Duration = Duration::from_secs(5);
pub const BINARY_POLL_INTERVAL: Duration = Duration::from_secs(2);

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DaemonExit {
    Stopped,
    Recycle(RecycleTarget),
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
    #[error("the Marbles state could not be read: {0}")]
    Store(#[source] StoreError),
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
    pub binary_watch: Option<BinaryWatch>,
    pub binary_poll_interval: Duration,
    pub launcher: Option<Arc<dyn GenerationLauncher>>,
    #[cfg(test)]
    pub reads: Option<Arc<dyn ReadObserver>>,
    pub timings: TimingConfig,
    pub store: Option<StateStore>,
    pub open_database: bool,
    pub installation: Option<PathBuf>,
}

impl DaemonOptions {
    pub fn new(layout: Layout, version: impl Into<String>) -> Self {
        Self {
            layout,
            version: version.into(),
            initializer: Arc::new(NoopInitializer),
            output: Arc::new(StdoutSink),
            claim_check_interval: CLAIM_CHECK_INTERVAL,
            binary_watch: None,
            binary_poll_interval: BINARY_POLL_INTERVAL,
            launcher: None,
            #[cfg(test)]
            reads: None,
            timings: TimingConfig::default(),
            store: None,
            open_database: false,
            installation: None,
        }
    }

    pub fn with_store(self, store: StateStore) -> Self {
        Self {
            store: Some(store),
            ..self
        }
    }

    pub fn with_database(self) -> Self {
        Self {
            open_database: true,
            ..self
        }
    }

    pub fn with_installation(self, installation: impl Into<PathBuf>) -> Self {
        Self {
            installation: Some(installation.into()),
            ..self
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

    pub fn with_binary_watch(self, binary_watch: BinaryWatch) -> Self {
        Self {
            binary_watch: Some(binary_watch),
            ..self
        }
    }

    pub fn with_binary_poll_interval(self, binary_poll_interval: Duration) -> Self {
        Self {
            binary_poll_interval,
            ..self
        }
    }

    pub fn with_launcher(self, launcher: impl GenerationLauncher) -> Self {
        Self {
            launcher: Some(Arc::new(launcher)),
            ..self
        }
    }

    #[cfg(test)]
    pub fn with_read_observer(self, reads: impl ReadObserver) -> Self {
        Self {
            reads: Some(Arc::new(reads)),
            ..self
        }
    }

    pub fn with_timings(self, timings: TimingConfig) -> Self {
        Self { timings, ..self }
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
    exit: watch::Receiver<Option<DaemonExit>>,
}

pub async fn start(options: DaemonOptions) -> Result<DaemonHandle, StartError> {
    let DaemonOptions {
        layout,
        version,
        initializer,
        output,
        claim_check_interval,
        binary_watch,
        binary_poll_interval,
        launcher,
        #[cfg(test)]
        reads,
        timings,
        store,
        open_database,
        installation,
    } = options;
    let (phase, observed) = watch::channel(LifecyclePhase::Starting);
    let (exit, exited) = watch::channel(None);
    let claim = take_claim(&layout, &version).await?;
    phase.send_replace(LifecyclePhase::Initializing);
    if let Err(error) = initializer.initialize(InitializeTrigger::Start).await {
        release(claim).await;
        return Err(StartError::Initialize(error));
    }
    let (store, store_notice) = match open_store(store, open_database, &layout).await {
        Ok(opened) => opened,
        Err(error) => {
            release(claim).await;
            return Err(StartError::Store(error));
        }
    };
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
        version: version.clone(),
    };
    output.line(&format!(
        "[marbles] pid {} · {}",
        started.pid,
        started.socket.display()
    ));
    if let Some(notice) = store_notice {
        output.line(&notice);
    }
    let (mailbox, received) = mpsc::channel(MAILBOX_CAPACITY);
    let supervision = launcher.map(|launcher| {
        let (publications, published) = mpsc::unbounded_channel();
        let supervisor = Supervisor::new(SupervisorParts {
            launcher,
            #[cfg(test)]
            reads,
            timings,
            layout: layout.clone(),
            output: Arc::clone(&output),
            link: Arc::new(LifecycleLink {
                events: mailbox.clone(),
                publications,
            }),
            store: store.clone(),
            installation,
            version,
        });
        (supervisor, published)
    });
    let booted = match &supervision {
        Some((supervisor, _)) => supervisor.boot().await,
        None => Ok(false),
    };
    let rehosting = match booted {
        Ok(rehosting) => rehosting,
        Err(error) => {
            endpoint.close();
            release(claim).await;
            return Err(StartError::Store(error));
        }
    };
    let rehost = supervision
        .as_ref()
        .filter(|_| rehosting)
        .map(|(supervisor, _)| supervisor.clone());
    phase.send_replace(LifecyclePhase::Running);
    let actor = Actor::new(actor::Parts {
        hello,
        claim: Arc::new(claim),
        endpoint,
        initializer,
        output,
        phase,
        exit,
        binary_watch,
        mailbox: received,
        events: mailbox.clone(),
        supervision,
    });
    tokio::spawn(actor.run(actor::Intervals {
        claim_check: claim_check_interval,
        binary_poll: binary_poll_interval,
        source_poll: timings.source_poll,
        sweep: timings.sweep,
    }));
    if let Some(supervisor) = rehost {
        supervisor.host_registered();
    }
    Ok(DaemonHandle {
        started,
        mailbox,
        phase: observed,
        exit: exited,
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

    pub async fn poll_now(&self) -> bool {
        let (reply, answered) = oneshot::channel();
        self.command(Command::PollNow(reply)).await;
        answered.await.unwrap_or(false)
    }

    pub async fn sweep_now(&self) {
        let (reply, answered) = oneshot::channel();
        self.command(Command::SweepNow(reply)).await;
        let _ = answered.await;
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

    pub async fn wait_exit(&self) -> DaemonExit {
        let mut exit = self.exit.clone();
        let exited = exit.wait_for(Option::is_some).await;
        exited
            .ok()
            .and_then(|exit| exit.clone())
            .unwrap_or(DaemonExit::Stopped)
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

async fn open_store(
    given: Option<StateStore>,
    open_database: bool,
    layout: &Layout,
) -> Result<(StateStore, Option<String>), StoreError> {
    if let Some(store) = given {
        return Ok((store, None));
    }
    let mut notice = None;
    if open_database {
        let at = layout.clone();
        let opened = tokio::task::spawn_blocking(move || StateStore::open_existing_sqlite(&at))
            .await
            .map_err(StoreError::failed)??;
        match opened {
            Some(opened) => return Ok((opened, None)),
            None => {
                notice = Some(format!(
                    "[marbles] no state database at {} yet; using in-memory state store",
                    layout.database.display()
                ));
            }
        }
    }
    Ok((StateStore::in_memory_within(layout.state.clone())?, notice))
}

async fn release(claim: ProcessClaim) {
    let _ = tokio::task::spawn_blocking(move || claim.release()).await;
}
