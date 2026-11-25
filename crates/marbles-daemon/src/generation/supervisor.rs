use std::collections::{BTreeMap, HashSet};
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use super::hosted::Hosted;
use super::launcher::{GenerationExit, GenerationLauncher, SpawnSpec, registration_token};
use super::link::{DaemonLink, Publication};
use super::registry::{Generation, GenerationRole, Generations};
use super::seams::{ReadObserver, RunOwnerResolver, TimingConfig};
use crate::Layout;
use crate::channel::{ChannelError, ChannelHandle, CloseReason};
use crate::lifecycle::OutputSink;
use crate::protocol::{
    GenerationNotification, HandedParams, LineNotificationParams, NonEmptyString, Notification,
    ReadNotificationParams, Request, Response, WireError, WorkspaceLoadResult, WorkspaceState,
};

const RETIRING_ERROR: &str = "EngineRetiringError";
const STOPPING: &str = "the Marbles process is stopping; retry once it has exited";

pub(crate) struct SupervisorParts {
    pub(crate) launcher: Arc<dyn GenerationLauncher>,
    pub(crate) run_owners: Arc<dyn RunOwnerResolver>,
    pub(crate) reads: Option<Arc<dyn ReadObserver>>,
    pub(crate) timings: TimingConfig,
    pub(crate) layout: Layout,
    pub(crate) output: Arc<dyn OutputSink>,
    pub(crate) link: Arc<dyn DaemonLink>,
}

#[derive(Clone)]
pub(crate) struct Supervisor {
    inner: Arc<Inner>,
}

struct Inner {
    state: Mutex<State>,
    turn: tokio::sync::Mutex<()>,
    changes: watch::Sender<u64>,
    parts: SupervisorParts,
}

pub(super) struct State {
    pub(super) generations: Generations,
    pub(super) hosted: BTreeMap<String, Hosted>,
    pub(super) stopping: bool,
    pub(super) orphaned: bool,
    pub(super) replace_delay: Duration,
    pub(super) replacement: Option<JoinHandle<()>>,
    pub(super) offering: HashSet<(String, String)>,
    pub(super) live_unread: HashSet<(String, u64)>,
}

impl Supervisor {
    pub(crate) fn new(parts: SupervisorParts) -> Self {
        let state = State {
            generations: Generations::default(),
            hosted: BTreeMap::new(),
            stopping: false,
            orphaned: false,
            replace_delay: parts.timings.replace_min,
            replacement: None,
            offering: HashSet::new(),
            live_unread: HashSet::new(),
        };
        Self {
            inner: Arc::new(Inner {
                state: Mutex::new(state),
                turn: tokio::sync::Mutex::new(()),
                changes: watch::channel(0).0,
                parts,
            }),
        }
    }

    pub(super) fn lock(&self) -> MutexGuard<'_, State> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    pub(super) async fn take_turn(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.inner.turn.lock().await
    }

    pub(super) fn timings(&self) -> &TimingConfig {
        &self.inner.parts.timings
    }

    pub(super) fn link(&self) -> &dyn DaemonLink {
        self.inner.parts.link.as_ref()
    }

    pub(super) fn run_owners(&self) -> &dyn RunOwnerResolver {
        self.inner.parts.run_owners.as_ref()
    }

    pub(super) fn print(&self, line: &str) {
        self.inner.parts.output.line(line);
    }

    pub(super) fn changed(&self) {
        self.inner
            .changes
            .send_modify(|count| *count = count.wrapping_add(1));
    }

    pub(super) async fn settle<T>(&self, mut probe: impl FnMut(&State) -> Option<T>) -> T {
        let mut changes = self.inner.changes.subscribe();
        loop {
            if let Some(found) = probe(&self.lock()) {
                return found;
            }
            let _ = changes.changed().await;
        }
    }

    pub(super) async fn next_change(&self, wait: Duration) {
        let mut changes = self.inner.changes.subscribe();
        let _ = tokio::time::timeout(wait, changes.changed()).await;
    }

    pub(super) fn refuse_while_stopping(&self) -> Result<(), WireError> {
        if self.lock().stopping {
            return Err(WireError::new(STOPPING));
        }
        Ok(())
    }

    pub(super) fn update(
        &self,
        state: &mut State,
        id: &str,
        workspace_state: WorkspaceState,
        error: Option<String>,
        pid: Option<u32>,
    ) {
        let changed = state
            .hosted
            .get_mut(id)
            .and_then(|hosted| hosted.set_state(workspace_state, error, pid));
        if let Some(summary) = changed {
            self.link().publish(Publication::Workspace(summary));
        }
    }

    pub(super) fn forward_line(&self, id: Option<String>, line: String) {
        match id {
            Some(workspace) => self.link().publish(Publication::Line { workspace, line }),
            None => self.print(&format!("[marbles] {line}")),
        }
    }

    pub(super) async fn ask(
        &self,
        number: u64,
        method: impl Into<NonEmptyString>,
        params: Option<Value>,
    ) -> Result<Option<Value>, WireError> {
        let channel = {
            let state = self.lock();
            let generation = state.generations.get(number);
            match generation.and_then(Generation::open_channel) {
                Some(channel) => channel,
                None => {
                    let why = generation
                        .and_then(|generation| generation.exit.as_ref())
                        .map(|exit| format!(": {}", exit.reason))
                        .unwrap_or_default();
                    return Err(WireError::new(format!(
                        "engine generation {number} is gone{why}"
                    )));
                }
            }
        };
        let asked = channel.request(method, params);
        tokio::select! {
            answered = asked => answered.map_err(|error| match error {
                ChannelError::Remote(error) => error,
                ChannelError::Closed => WireError::new(format!(
                    "engine generation {number}'s connection closed"
                )),
            }),
            why = self.exit_of(number) => Err(WireError::new(format!(
                "engine generation {number} exited: {why}"
            ))),
        }
    }

    pub(super) async fn exit_of(&self, number: u64) -> String {
        self.settle(|state| state.generations.exit_reason(number))
            .await
    }

    pub(super) async fn spawn_generation(&self) -> Result<u64, WireError> {
        let token = registration_token().map_err(|error| {
            WireError::new(format!("a registration token could not be made: {error}"))
        })?;
        let number = {
            let mut state = self.lock();
            let number = state.generations.next_number();
            state
                .generations
                .insert(Generation::candidate(number, token.clone(), None, None));
            number
        };
        let spec = SpawnSpec {
            number,
            token,
            socket: self.inner.parts.layout.socket.clone(),
            layout: self.inner.parts.layout.clone(),
        };
        let launcher = Arc::clone(&self.inner.parts.launcher);
        let spawned = tokio::task::spawn_blocking(move || launcher.spawn(spec))
            .await
            .map_err(std::io::Error::other)
            .and_then(|spawned| spawned);
        let spawned = match spawned {
            Ok(spawned) => spawned,
            Err(error) => {
                self.lock().generations.remove(number);
                return Err(WireError::new(format!(
                    "the engine generation did not start: {error}"
                )));
            }
        };
        let mut lines = spawned.lines;
        let stopping = {
            let mut state = self.lock();
            if let Some(generation) = state.generations.get_mut(number) {
                generation.pid = spawned.pid;
                generation.spawned_as = spawned.spawned_as;
            }
            state.stopping
        };
        let this = self.clone();
        tokio::spawn(async move {
            while let Some(line) = lines.recv().await {
                this.print(&format!("[generation {number}] {line}"));
            }
        });
        let this = self.clone();
        let exited = spawned.exited;
        tokio::spawn(async move {
            let exit = exited.await.unwrap_or_else(|_| GenerationExit {
                clean: false,
                reason: "its exit was never reported".to_owned(),
            });
            this.on_exit(number, exit);
        });
        if stopping {
            self.stop_generation(number).await;
            return Err(WireError::new(STOPPING));
        }
        Ok(number)
    }

    fn on_exit(&self, number: u64, exit: GenerationExit) {
        let mut state = self.lock();
        let Some(generation) = state.generations.get_mut(number) else {
            return;
        };
        if generation.exit.is_some() {
            return;
        }
        generation.exit = Some(exit.clone());
        generation.channel = None;
        generation.start_settled = true;
        let role = generation.role;
        let hosts = generation.hosts.clone();
        let since = generation.became_current_at;
        if !state.stopping {
            if state.generations.is_current(number) && role == GenerationRole::Current {
                state.generations.current = None;
                self.print(&format!(
                    "[marbles] engine generation {number} exited: {}",
                    exit.reason
                ));
                for id in &hosts {
                    self.update(
                        &mut state,
                        id,
                        WorkspaceState::Failed,
                        Some(exit.reason.clone()),
                        None,
                    );
                }
                self.replace_current(&mut state, "the engine generation exited", since);
            } else if role == GenerationRole::Retiring && !exit.clean {
                self.print(&format!(
                    "[marbles] retired engine generation {number} died: {}",
                    exit.reason
                ));
            }
        }
        drop(state);
        self.changed();
    }

    pub(crate) fn register(
        &self,
        request: u64,
        token: &NonEmptyString,
        channel: &ChannelHandle,
    ) -> Option<u64> {
        let mut state = self.lock();
        let registered = state.generations.register(token, channel.clone());
        let _ = channel.respond(match &registered {
            Ok(_) => Response::empty(request),
            Err(refusal) => Response::err(request, WireError::new(refusal.clone())),
        });
        drop(state);
        self.changed();
        registered.ok()
    }

    pub(crate) fn refuse_request(&self, number: u64, request: &Request) {
        let channel = self
            .lock()
            .generations
            .get(number)
            .and_then(Generation::open_channel);
        if let Some(channel) = channel {
            let _ = channel.respond(Response::err(
                request.id,
                WireError::new("a generation only notifies"),
            ));
        }
    }

    pub(crate) fn disconnected(&self, number: u64, reason: &CloseReason) {
        if reason.is_failure() {
            self.print(&format!(
                "[generation {number}] its connection failed: {reason}"
            ));
        }
        self.changed();
    }

    pub(crate) fn notified(&self, number: u64, notification: Notification) {
        let Ok(method) = notification
            .method
            .as_str()
            .parse::<GenerationNotification>()
        else {
            return;
        };
        let params = notification.params.unwrap_or(Value::Null);
        match method {
            GenerationNotification::Line => {
                if let Some(line) = parsed::<LineNotificationParams>(params) {
                    self.heard_line(number, line);
                }
            }
            GenerationNotification::Handed => {
                if let Some(handed) = parsed::<HandedParams>(params) {
                    self.handed(handed);
                }
            }
            GenerationNotification::Read => {
                let observer = self.inner.parts.reads.as_ref();
                if let (Some(observer), Some(read)) =
                    (observer, parsed::<ReadNotificationParams>(params))
                {
                    observer.read(number, &read);
                }
            }
        }
    }

    fn heard_line(&self, number: u64, line: LineNotificationParams) {
        let Some(root) = line.root else {
            self.print(&format!("[generation {number}] {}", line.line));
            return;
        };
        let id = self.lock().loaded_id(&WorkspaceLoadResult {
            error: None,
            id: None,
            root,
        });
        self.forward_line(id, line.line);
    }

    pub(super) async fn within_task<T: Send + 'static>(
        &self,
        limit: Duration,
        what: &str,
        work: impl Future<Output = Result<T, WireError>> + Send + 'static,
    ) -> Result<T, WireError> {
        match tokio::time::timeout(limit, tokio::spawn(work)).await {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(error)) => Err(WireError::new(format!("{what} failed: {error}"))),
            Err(_) => Err(WireError::new(format!("{what} timed out"))),
        }
    }
}

impl State {
    pub(super) fn loaded_id(&self, load: &WorkspaceLoadResult) -> Option<String> {
        load.id.clone().or_else(|| {
            self.hosted
                .values()
                .find(|hosted| hosted.is_at(&load.root))
                .map(|hosted| hosted.summary.id.clone())
        })
    }
}

pub(super) async fn within<T>(
    limit: Duration,
    what: &str,
    work: impl Future<Output = Result<T, WireError>>,
) -> Result<T, WireError> {
    tokio::time::timeout(limit, work)
        .await
        .unwrap_or_else(|_| Err(WireError::new(format!("{what} timed out"))))
}

pub(super) fn is_retiring(error: &WireError) -> bool {
    error.name.as_deref() == Some(RETIRING_ERROR)
}

pub(super) fn reply_of<T: DeserializeOwned>(
    what: &str,
    value: Option<Value>,
) -> Result<T, WireError> {
    serde_json::from_value(value.unwrap_or(Value::Null))
        .map_err(|error| WireError::new(format!("{what} is malformed: {error}")))
}

pub(super) fn params_of(value: &impl serde::Serialize) -> Option<Value> {
    serde_json::to_value(value).ok()
}

fn parsed<T: DeserializeOwned>(params: Value) -> Option<T> {
    serde_json::from_value(params).ok()
}
