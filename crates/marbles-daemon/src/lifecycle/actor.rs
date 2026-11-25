use std::collections::{BTreeMap, HashMap, HashSet};
use std::io;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::{Instant, Interval, MissedTickBehavior};

use super::route::{Effect, Reply, Routed, View, route};
use super::{
    DaemonExit, InitError, InitializeTrigger, Initializer, LifecyclePhase, OutputSink,
    ProcessChangeError,
};
use crate::channel::{ChannelEvent, ChannelHandle};
use crate::claim::ProcessClaim;
use crate::endpoint::Endpoint;
use crate::generation::{Publication, SupervisedRequest, Supervisor};
use crate::protocol::{
    ClientNotification, DaemonRequest, HelloResult, Request, Response, WorkspaceState,
    WorkspaceSummary,
};
use crate::recycle::{BinaryChange, BinaryWatch, RecycleTarget};

const CLOSE_GRACE: Duration = Duration::from_secs(2);
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);

type ChangeReply = oneshot::Sender<Result<(), ProcessChangeError>>;
type ClientId = u64;
type Supervision = (Supervisor, mpsc::UnboundedReceiver<Publication>);

#[derive(Debug)]
pub(super) enum Command {
    Shutdown,
    ProcessChange(ChangeReply),
    PublishWorkspace(WorkspaceSummary),
    PublishLine { workspace: String, line: String },
    PollNow(oneshot::Sender<bool>),
    SweepNow(oneshot::Sender<()>),
}

#[derive(Debug)]
pub(super) enum DaemonEvent {
    Command(Command),
    Channel(ClientId, ChannelEvent),
    ClaimChecked(bool),
    Initialized(Result<(), InitError>),
    BinaryPolled(BinaryWatch, BinaryChange),
    GenerationsStopped,
}

pub(super) struct Intervals {
    pub(super) claim_check: Duration,
    pub(super) binary_poll: Duration,
    pub(super) source_poll: Duration,
    pub(super) sweep: Duration,
}

pub(super) struct Parts {
    pub(super) hello: HelloResult,
    pub(super) claim: Arc<ProcessClaim>,
    pub(super) endpoint: Endpoint,
    pub(super) initializer: Arc<dyn Initializer>,
    pub(super) output: Arc<dyn OutputSink>,
    pub(super) phase: watch::Sender<LifecyclePhase>,
    pub(super) exit: watch::Sender<Option<DaemonExit>>,
    pub(super) binary_watch: Option<BinaryWatch>,
    pub(super) mailbox: mpsc::Receiver<DaemonEvent>,
    pub(super) events: mpsc::Sender<DaemonEvent>,
    pub(super) supervision: Option<Supervision>,
}

struct Client {
    channel: ChannelHandle,
    subscriptions: HashSet<String>,
}

struct Initializing {
    task: JoinHandle<()>,
    waiters: Vec<ChangeReply>,
}

struct Stopping {
    deadline: Option<Instant>,
    exit: DaemonExit,
    claim_lost: bool,
}

enum StopReason {
    Requested,
    ClaimLost,
    Recycle(RecycleTarget),
}

pub(super) struct Actor {
    hello: HelloResult,
    claim: Option<Arc<ProcessClaim>>,
    claim_check: Option<JoinHandle<()>>,
    endpoint: Option<Endpoint>,
    initializer: Arc<dyn Initializer>,
    output: Arc<dyn OutputSink>,
    phase: watch::Sender<LifecyclePhase>,
    exit: watch::Sender<Option<DaemonExit>>,
    binary_watch: Option<BinaryWatch>,
    binary_poll: Option<JoinHandle<()>>,
    mailbox: mpsc::Receiver<DaemonEvent>,
    events: mpsc::Sender<DaemonEvent>,
    clients: HashMap<ClientId, Client>,
    generations: HashMap<ClientId, u64>,
    supervisor: Option<Supervisor>,
    published: Option<mpsc::UnboundedReceiver<Publication>>,
    next_client: ClientId,
    workspaces: BTreeMap<String, WorkspaceSummary>,
    initializing: Option<Initializing>,
    queued_changes: Vec<ChangeReply>,
    stopping: Option<Stopping>,
    pending_recycle: Option<RecycleTarget>,
    accept_after: Option<Instant>,
}

impl Actor {
    pub(super) fn new(parts: Parts) -> Self {
        let (supervisor, published) = parts.supervision.unzip();
        Self {
            hello: parts.hello,
            claim: Some(parts.claim),
            claim_check: None,
            endpoint: Some(parts.endpoint),
            initializer: parts.initializer,
            output: parts.output,
            phase: parts.phase,
            exit: parts.exit,
            binary_watch: parts.binary_watch,
            binary_poll: None,
            mailbox: parts.mailbox,
            events: parts.events,
            clients: HashMap::new(),
            generations: HashMap::new(),
            supervisor,
            published,
            next_client: 0,
            workspaces: BTreeMap::new(),
            initializing: None,
            queued_changes: Vec::new(),
            stopping: None,
            pending_recycle: None,
            accept_after: None,
        }
    }

    pub(super) async fn run(mut self, intervals: Intervals) {
        let mut watchdog = ticker(intervals.claim_check);
        let mut binary_ticker = ticker(intervals.binary_poll);
        let mut source_ticker = ticker(intervals.source_poll);
        let mut sweep_ticker = ticker(intervals.sweep);
        while !self.finished() {
            let deadline = self
                .stopping
                .as_ref()
                .and_then(|stopping| stopping.deadline);
            tokio::select! {
                event = self.mailbox.recv() => match event {
                    Some(event) => self.handle(event),
                    None => break,
                },
                Some(publication) = published(self.published.as_mut()) => self.published(publication),
                accepted = accept(self.endpoint.as_ref(), self.accept_after) => self.admit(accepted),
                _ = watchdog.tick(), if self.stopping.is_none() => self.check_claim(),
                _ = binary_ticker.tick(), if self.watches_binary() => {
                    if self.pending_recycle.is_some() {
                        self.maybe_recycle();
                    } else {
                        self.poll_binary();
                    }
                }
                _ = source_ticker.tick(), if self.supervises() => self.poll_sources(),
                _ = sweep_ticker.tick(), if self.supervises() => self.sweep_queues(),
                () = overdue(deadline) => break,
            }
        }
        self.finish().await;
    }

    fn finished(&self) -> bool {
        self.stopping
            .as_ref()
            .is_some_and(|stopping| stopping.deadline.is_some())
            && self.clients.is_empty()
    }

    fn handle(&mut self, event: DaemonEvent) {
        match event {
            DaemonEvent::Command(command) => self.obey(command),
            DaemonEvent::Channel(client, event) => self.hear(client, event),
            DaemonEvent::ClaimChecked(held) => self.claim_checked(held),
            DaemonEvent::Initialized(result) => self.initialized(result),
            DaemonEvent::BinaryPolled(watch, change) => self.binary_polled(watch, change),
            DaemonEvent::GenerationsStopped => self.close_down(),
        }
    }

    fn obey(&mut self, command: Command) {
        match command {
            Command::Shutdown => self.stop(StopReason::Requested),
            Command::ProcessChange(reply) => self.change_process(reply),
            Command::PublishWorkspace(summary) => self.publish_workspace(summary),
            Command::PublishLine { workspace, line } => self.publish_line(&workspace, &line),
            Command::PollNow(reply) => self.poll_now(reply),
            Command::SweepNow(reply) => self.sweep_now(reply),
        }
    }

    fn watches_binary(&self) -> bool {
        self.stopping.is_none() && (self.binary_watch.is_some() || self.pending_recycle.is_some())
    }

    fn supervises(&self) -> bool {
        self.supervisor.is_some() && self.stopping.is_none()
    }

    fn poll_sources(&self) {
        if let Some(supervisor) = &self.supervisor {
            supervisor.poll_tick();
        }
    }

    fn sweep_queues(&self) {
        if let Some(supervisor) = &self.supervisor {
            supervisor.sweep_tick();
        }
    }

    fn poll_now(&self, reply: oneshot::Sender<bool>) {
        let Some(supervisor) = self.supervisor.clone() else {
            let _ = reply.send(false);
            return;
        };
        tokio::spawn(async move {
            let _ = reply.send(supervisor.poll_now().await);
        });
    }

    fn sweep_now(&self, reply: oneshot::Sender<()>) {
        let Some(supervisor) = self.supervisor.clone() else {
            let _ = reply.send(());
            return;
        };
        tokio::spawn(async move {
            supervisor.sweep_now().await;
            let _ = reply.send(());
        });
    }

    fn admit(&mut self, accepted: io::Result<(ChannelHandle, mpsc::Receiver<ChannelEvent>)>) {
        let (channel, mut events) = match accepted {
            Ok(accepted) => accepted,
            Err(error) => {
                self.print(&format!("[marbles] could not accept a connection: {error}"));
                self.accept_after = Some(Instant::now() + ACCEPT_BACKOFF);
                return;
            }
        };
        self.accept_after = None;
        let id = self.next_client;
        self.next_client += 1;
        self.clients.insert(
            id,
            Client {
                channel,
                subscriptions: HashSet::new(),
            },
        );
        let mailbox = self.events.clone();
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                if mailbox.send(DaemonEvent::Channel(id, event)).await.is_err() {
                    break;
                }
            }
        });
    }

    fn hear(&mut self, client: ClientId, event: ChannelEvent) {
        if let Some(&number) = self.generations.get(&client) {
            self.hear_generation(client, number, event);
            return;
        }
        match event {
            ChannelEvent::Request(request) => self.answer(client, request),
            ChannelEvent::Notification(_) => {}
            ChannelEvent::Closed(reason) => {
                self.clients.remove(&client);
                if reason.is_failure() {
                    self.print(&format!("[marbles] a client's connection failed: {reason}"));
                }
            }
        }
    }

    fn hear_generation(&mut self, client: ClientId, number: u64, event: ChannelEvent) {
        let Some(supervisor) = &self.supervisor else {
            return;
        };
        match event {
            ChannelEvent::Request(request) => supervisor.refuse_request(number, &request),
            ChannelEvent::Notification(notification) => supervisor.notified(number, notification),
            ChannelEvent::Closed(reason) => {
                self.generations.remove(&client);
                supervisor.disconnected(number, &reason);
            }
        }
    }

    fn answer(&mut self, client: ClientId, request: Request) {
        let routed = route(
            request,
            &View {
                hello: &self.hello,
                workspaces: &self.workspaces,
                stopping: self.stopping.is_some(),
                supervised: self.supervisor.is_some(),
            },
        );
        match routed {
            Routed::Reply(reply) => self.reply(client, reply),
            Routed::Supervise(id, request) => self.supervise(client, id, request),
        }
    }

    fn reply(&mut self, client: ClientId, reply: Reply) {
        let Some(asker) = self.clients.get_mut(&client) else {
            return;
        };
        match &reply.effect {
            Effect::Subscribe(workspace) => {
                asker.subscriptions.insert(workspace.clone());
            }
            Effect::Unsubscribe(workspace) => {
                asker.subscriptions.remove(workspace);
            }
            Effect::Nothing | Effect::Shutdown => {}
        }
        let _ = asker.channel.respond(reply.response);
        if reply.effect == Effect::Shutdown {
            self.stop(StopReason::Requested);
        }
    }

    fn supervise(&mut self, client: ClientId, id: u64, request: DaemonRequest) {
        let (Some(supervisor), Some(asker)) = (&self.supervisor, self.clients.get(&client)) else {
            return;
        };
        let channel = asker.channel.clone();
        let request = match SupervisedRequest::from_request(request) {
            Ok(request) => request,
            Err(DaemonRequest::Register(params)) => {
                if let Some(number) = supervisor.register(id, &params.token, &channel) {
                    self.clients.remove(&client);
                    self.generations.insert(client, number);
                }
                return;
            }
            Err(_) => return,
        };
        let supervisor = supervisor.clone();
        tokio::spawn(async move {
            let response = match supervisor.answer(request).await {
                Ok(Some(result)) => Response::ok(id, result),
                Ok(None) => Response::empty(id),
                Err(error) => Response::err(id, error),
            };
            let _ = channel.respond(response);
        });
    }

    fn published(&mut self, publication: Publication) {
        match publication {
            Publication::Workspace(summary) => self.publish_workspace(summary),
            Publication::Line { workspace, line } => self.publish_line(&workspace, &line),
            Publication::Withdrawn(id) => {
                self.workspaces.remove(&id);
            }
        }
    }

    fn publish_workspace(&mut self, summary: WorkspaceSummary) {
        if self.workspaces.get(&summary.id) == Some(&summary) {
            return;
        }
        self.announce(&summary);
        self.workspaces.insert(summary.id.clone(), summary);
    }

    fn publish_line(&self, workspace: &str, line: &str) {
        self.print(&format!("[{workspace}] {line}"));
        self.notify_subscribers(
            workspace,
            ClientNotification::Line,
            json!({ "id": workspace, "line": line }),
        );
    }

    fn announce(&self, summary: &WorkspaceSummary) {
        if let Ok(params) = serde_json::to_value(summary) {
            self.notify_subscribers(&summary.id, ClientNotification::Workspace, params);
        }
    }

    fn notify_subscribers(&self, workspace: &str, method: ClientNotification, params: Value) {
        for client in self.clients.values() {
            if client.subscriptions.contains(workspace) {
                let _ = client.channel.notify(method, Some(params.clone()));
            }
        }
    }

    fn change_process(&mut self, reply: ChangeReply) {
        if self.stopping.is_some() {
            let _ = reply.send(Err(ProcessChangeError::Stopping));
        } else if self.initializing.is_some() {
            self.queued_changes.push(reply);
        } else {
            self.initialize(vec![reply]);
        }
    }

    fn initialize(&mut self, waiters: Vec<ChangeReply>) {
        self.phase.send_replace(LifecyclePhase::Initializing);
        let initializer = Arc::clone(&self.initializer);
        let mailbox = self.events.clone();
        let task = tokio::spawn(async move {
            let result = initializer
                .initialize(InitializeTrigger::ProcessChange)
                .await;
            let _ = mailbox.send(DaemonEvent::Initialized(result)).await;
        });
        self.initializing = Some(Initializing { task, waiters });
    }

    fn initialized(&mut self, result: Result<(), InitError>) {
        let Some(Initializing { waiters, .. }) = self.initializing.take() else {
            return;
        };
        if self.stopping.is_some() {
            return;
        }
        let outcome = result.map_err(|error| {
            self.print(&format!(
                "[marbles] initializing after a process change failed: {error}"
            ));
            ProcessChangeError::Initialize(error.to_string())
        });
        for waiter in waiters {
            let _ = waiter.send(outcome.clone());
        }
        if self.queued_changes.is_empty() {
            self.phase.send_replace(LifecyclePhase::Running);
        } else {
            let queued = std::mem::take(&mut self.queued_changes);
            self.initialize(queued);
        }
        self.maybe_recycle();
    }

    fn maybe_recycle(&mut self) {
        let busy = self.initializing.is_some()
            || self
                .supervisor
                .as_ref()
                .is_some_and(Supervisor::is_switching);
        if busy {
            return;
        }
        if let Some(target) = self.pending_recycle.take() {
            self.stop(StopReason::Recycle(target));
        }
    }

    fn check_claim(&mut self) {
        if self
            .claim_check
            .as_ref()
            .is_some_and(|check| !check.is_finished())
        {
            return;
        }
        let Some(claim) = self.claim.clone() else {
            return;
        };
        let mailbox = self.events.clone();
        self.claim_check = Some(tokio::spawn(async move {
            let held = tokio::task::spawn_blocking(move || claim.is_held())
                .await
                .unwrap_or(true);
            let _ = mailbox.send(DaemonEvent::ClaimChecked(held)).await;
        }));
    }

    fn claim_checked(&mut self, held: bool) {
        if !held && self.stopping.is_none() {
            self.print("[marbles] the claim at the state root is gone; stopping");
            self.stop(StopReason::ClaimLost);
        }
    }

    fn poll_binary(&mut self) {
        let Some(mut watch) = self.binary_watch.take() else {
            return;
        };
        let mailbox = self.events.clone();
        self.binary_poll = Some(tokio::spawn(async move {
            let polled = tokio::task::spawn_blocking(move || {
                let change = watch.poll();
                (watch, change)
            })
            .await;
            if let Ok((watch, change)) = polled {
                let _ = mailbox.send(DaemonEvent::BinaryPolled(watch, change)).await;
            }
        }));
    }

    fn binary_polled(&mut self, watch: BinaryWatch, change: BinaryChange) {
        if self.stopping.is_some() {
            return;
        }
        match change {
            BinaryChange::Ready(target) => {
                self.pending_recycle = Some(target);
                self.maybe_recycle();
            }
            BinaryChange::Unchanged | BinaryChange::Pending => self.binary_watch = Some(watch),
        }
    }

    fn stop(&mut self, reason: StopReason) {
        if self.stopping.is_some() {
            return;
        }
        let claim_lost = matches!(reason, StopReason::ClaimLost);
        let (phase, announcement, exit) = match reason {
            StopReason::Requested | StopReason::ClaimLost => (
                LifecyclePhase::Stopping,
                "[marbles] stopping".to_owned(),
                DaemonExit::Stopped,
            ),
            StopReason::Recycle(target) => (
                LifecyclePhase::Recycling,
                format!(
                    "[marbles] binary changed ({} -> {}); recycling",
                    target.previous_digest.short_hex(),
                    target.new_digest.short_hex()
                ),
                DaemonExit::Recycle(target),
            ),
        };
        let graceful = !matches!(exit, DaemonExit::Recycle(_));
        self.stopping = Some(Stopping {
            deadline: None,
            exit,
            claim_lost,
        });
        self.phase.send_replace(phase);
        self.print(&announcement);
        self.refuse_process_changes();
        match self.supervisor.clone() {
            Some(supervisor) if graceful => {
                let mailbox = self.events.clone();
                tokio::spawn(async move {
                    supervisor.shutdown().await;
                    let _ = mailbox.send(DaemonEvent::GenerationsStopped).await;
                });
            }
            Some(supervisor) => {
                supervisor.release_for_recycle();
                self.close_down();
            }
            None => self.close_down(),
        }
    }

    fn close_down(&mut self) {
        let Some(stopping) = self.stopping.as_mut() else {
            return;
        };
        if stopping.deadline.is_some() {
            return;
        }
        stopping.deadline = Some(Instant::now() + CLOSE_GRACE);
        let claim_lost = stopping.claim_lost;
        self.stop_workspaces();
        for client in self.clients.values() {
            client.channel.close();
        }
        self.stop_serving(claim_lost);
    }

    fn refuse_process_changes(&mut self) {
        let waiters = self
            .initializing
            .as_mut()
            .map(|initializing| std::mem::take(&mut initializing.waiters))
            .unwrap_or_default();
        for waiter in waiters.into_iter().chain(self.queued_changes.drain(..)) {
            let _ = waiter.send(Err(ProcessChangeError::Stopping));
        }
    }

    fn stop_serving(&mut self, claim_lost: bool) {
        let Some(endpoint) = self.endpoint.take() else {
            return;
        };
        if claim_lost {
            endpoint.abandon();
        } else {
            endpoint.close();
        }
    }

    fn stop_workspaces(&mut self) {
        let stopped: Vec<WorkspaceSummary> = self
            .workspaces
            .values()
            .filter(|summary| summary.state != WorkspaceState::Stopped)
            .map(|summary| WorkspaceSummary {
                state: WorkspaceState::Stopped,
                pid: None,
                ..summary.clone()
            })
            .collect();
        for summary in stopped {
            self.publish_workspace(summary);
        }
    }

    async fn finish(mut self) {
        self.mailbox.close();
        if let Some(Initializing { mut task, .. }) = self.initializing.take() {
            if tokio::time::timeout(CLOSE_GRACE, &mut task).await.is_err() {
                task.abort();
                let _ = task.await;
            }
        }
        if let Some(check) = self.claim_check.take() {
            let _ = check.await;
        }
        if let Some(poll) = self.binary_poll.take() {
            let _ = poll.await;
        }
        if let Some(endpoint) = self.endpoint.take() {
            endpoint.close();
        }
        if let Some(claim) = self.claim.take() {
            let _ = tokio::task::spawn_blocking(move || drop(claim)).await;
        }
        let exit = self
            .stopping
            .take()
            .map_or(DaemonExit::Stopped, |stopping| stopping.exit);
        self.exit.send_replace(Some(exit));
        self.phase.send_replace(LifecyclePhase::Stopped);
    }

    fn print(&self, line: &str) {
        self.output.line(line);
    }
}

fn ticker(period: Duration) -> Interval {
    let mut ticker = tokio::time::interval(period);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    ticker.reset();
    ticker
}

async fn accept(
    endpoint: Option<&Endpoint>,
    after: Option<Instant>,
) -> io::Result<(ChannelHandle, mpsc::Receiver<ChannelEvent>)> {
    if let Some(after) = after {
        tokio::time::sleep_until(after).await;
    }
    match endpoint {
        Some(endpoint) => endpoint.accept().await,
        None => std::future::pending().await,
    }
}

async fn published(
    published: Option<&mut mpsc::UnboundedReceiver<Publication>>,
) -> Option<Publication> {
    match published {
        Some(published) => published.recv().await,
        None => std::future::pending().await,
    }
}

async fn overdue(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}
