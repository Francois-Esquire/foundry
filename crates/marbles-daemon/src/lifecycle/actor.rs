use std::collections::{BTreeMap, HashMap, HashSet};
use std::io;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior};

use super::route::{Effect, View, route};
use super::{
    InitError, InitializeTrigger, Initializer, LifecyclePhase, OutputSink, ProcessChangeError,
};
use crate::channel::{ChannelEvent, ChannelHandle};
use crate::claim::ProcessClaim;
use crate::endpoint::Endpoint;
use crate::protocol::{ClientNotification, HelloResult, Request, WorkspaceState, WorkspaceSummary};

const CLOSE_GRACE: Duration = Duration::from_secs(2);

type ChangeReply = oneshot::Sender<Result<(), ProcessChangeError>>;
type ClientId = u64;

#[derive(Debug)]
pub(super) enum Command {
    Shutdown,
    ProcessChange(ChangeReply),
    PublishWorkspace(WorkspaceSummary),
    PublishLine { workspace: String, line: String },
}

#[derive(Debug)]
pub(super) enum DaemonEvent {
    Command(Command),
    Channel(ClientId, ChannelEvent),
    ClaimChecked(bool),
    Initialized(Result<(), InitError>),
}

pub(super) struct Parts {
    pub(super) hello: HelloResult,
    pub(super) claim: Arc<ProcessClaim>,
    pub(super) endpoint: Endpoint,
    pub(super) initializer: Arc<dyn Initializer>,
    pub(super) output: Arc<dyn OutputSink>,
    pub(super) phase: watch::Sender<LifecyclePhase>,
    pub(super) mailbox: mpsc::Receiver<DaemonEvent>,
    pub(super) events: mpsc::Sender<DaemonEvent>,
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
    deadline: Instant,
}

pub(super) struct Actor {
    hello: HelloResult,
    claim: Option<Arc<ProcessClaim>>,
    claim_check: Option<JoinHandle<()>>,
    endpoint: Option<Endpoint>,
    initializer: Arc<dyn Initializer>,
    output: Arc<dyn OutputSink>,
    phase: watch::Sender<LifecyclePhase>,
    mailbox: mpsc::Receiver<DaemonEvent>,
    events: mpsc::Sender<DaemonEvent>,
    clients: HashMap<ClientId, Client>,
    next_client: ClientId,
    workspaces: BTreeMap<String, WorkspaceSummary>,
    initializing: Option<Initializing>,
    queued_changes: Vec<ChangeReply>,
    stopping: Option<Stopping>,
}

impl Actor {
    pub(super) fn new(parts: Parts) -> Self {
        Self {
            hello: parts.hello,
            claim: Some(parts.claim),
            claim_check: None,
            endpoint: Some(parts.endpoint),
            initializer: parts.initializer,
            output: parts.output,
            phase: parts.phase,
            mailbox: parts.mailbox,
            events: parts.events,
            clients: HashMap::new(),
            next_client: 0,
            workspaces: BTreeMap::new(),
            initializing: None,
            queued_changes: Vec::new(),
            stopping: None,
        }
    }

    pub(super) async fn run(mut self, claim_check_interval: Duration) {
        let mut watchdog = tokio::time::interval(claim_check_interval);
        watchdog.set_missed_tick_behavior(MissedTickBehavior::Delay);
        watchdog.reset();
        while !self.drained() {
            let deadline = self.stopping.as_ref().map(|stopping| stopping.deadline);
            tokio::select! {
                event = self.mailbox.recv() => match event {
                    Some(event) => self.handle(event),
                    None => break,
                },
                accepted = accept(self.endpoint.as_ref()) => self.admit(accepted),
                _ = watchdog.tick(), if self.stopping.is_none() => self.check_claim(),
                () = overdue(deadline) => break,
            }
        }
        self.finish().await;
    }

    fn drained(&self) -> bool {
        self.stopping.is_some() && self.clients.is_empty()
    }

    fn handle(&mut self, event: DaemonEvent) {
        match event {
            DaemonEvent::Command(command) => self.obey(command),
            DaemonEvent::Channel(client, event) => self.hear(client, event),
            DaemonEvent::ClaimChecked(held) => self.claim_checked(held),
            DaemonEvent::Initialized(result) => self.initialized(result),
        }
    }

    fn obey(&mut self, command: Command) {
        match command {
            Command::Shutdown => self.stop(false),
            Command::ProcessChange(reply) => self.change_process(reply),
            Command::PublishWorkspace(summary) => self.publish_workspace(summary),
            Command::PublishLine { workspace, line } => self.publish_line(&workspace, &line),
        }
    }

    fn admit(&mut self, accepted: io::Result<(ChannelHandle, mpsc::Receiver<ChannelEvent>)>) {
        let (channel, mut events) = match accepted {
            Ok(accepted) => accepted,
            Err(error) => {
                self.print(&format!("[marbles] could not accept a connection: {error}"));
                return;
            }
        };
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

    fn answer(&mut self, client: ClientId, request: Request) {
        let routed = route(
            request,
            &View {
                hello: &self.hello,
                workspaces: &self.workspaces,
                stopping: self.stopping.is_some(),
            },
        );
        let Some(asker) = self.clients.get_mut(&client) else {
            return;
        };
        match &routed.effect {
            Effect::Subscribe(workspace) => {
                asker.subscriptions.insert(workspace.clone());
            }
            Effect::Unsubscribe(workspace) => {
                asker.subscriptions.remove(workspace);
            }
            Effect::Nothing | Effect::Shutdown => {}
        }
        let _ = asker.channel.respond(routed.response);
        if routed.effect == Effect::Shutdown {
            self.stop(false);
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
            self.stop(true);
        }
    }

    fn stop(&mut self, claim_lost: bool) {
        if self.stopping.is_some() {
            return;
        }
        self.stopping = Some(Stopping {
            deadline: Instant::now() + CLOSE_GRACE,
        });
        self.phase.send_replace(LifecyclePhase::Stopping);
        self.print("[marbles] stopping");
        self.refuse_process_changes();
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
        if let Some(Initializing { task, .. }) = self.initializing.take() {
            let _ = tokio::time::timeout(CLOSE_GRACE, task).await;
        }
        if let Some(check) = self.claim_check.take() {
            let _ = check.await;
        }
        if let Some(endpoint) = self.endpoint.take() {
            endpoint.close();
        }
        if let Some(claim) = self.claim.take() {
            let _ = tokio::task::spawn_blocking(move || drop(claim)).await;
        }
        self.phase.send_replace(LifecyclePhase::Stopped);
    }

    fn print(&self, line: &str) {
        self.output.line(line);
    }
}

async fn accept(
    endpoint: Option<&Endpoint>,
) -> io::Result<(ChannelHandle, mpsc::Receiver<ChannelEvent>)> {
    match endpoint {
        Some(endpoint) => endpoint.accept().await,
        None => std::future::pending().await,
    }
}

async fn overdue(deadline: Option<Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}
