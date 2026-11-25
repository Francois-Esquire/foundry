use std::fs;
use std::os::unix::fs::{FileTypeExt, PermissionsExt};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::Semaphore;

use super::*;
use crate::channel::{ChannelError, CloseReason};
use crate::endpoint::SOCKET_MODE;
use crate::protocol::{ClientNotification, DaemonMethod, Notification, WireError, WorkspaceState};
use crate::recycle::BinaryDigest;
use crate::test_support::{Client, Printed, home, within};

const VERSION: &str = "9.9.9";
const RUNNING_BINARY: &[u8] = b"#!/bin/sh\necho running\n";
const UPGRADED_BINARY: &[u8] = b"#!/bin/sh\necho runninG\n";
const QUICK_POLL: Duration = Duration::from_millis(10);
const QUICK_STABILITY: Duration = Duration::from_millis(20);

#[derive(Debug, Clone, PartialEq, Eq)]
struct Seen {
    trigger: InitializeTrigger,
    claimed: bool,
    serving: bool,
}

#[derive(Clone)]
struct Recording {
    layout: Layout,
    seen: Arc<Mutex<Vec<Seen>>>,
    failing: Option<InitializeTrigger>,
    gate: Option<Arc<Semaphore>>,
    dropped: Option<Arc<AtomicBool>>,
}

struct DropFlag(Arc<AtomicBool>);

impl Drop for DropFlag {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

impl Recording {
    fn new(layout: &Layout) -> Self {
        Self {
            layout: layout.clone(),
            seen: Arc::default(),
            failing: None,
            gate: None,
            dropped: None,
        }
    }

    fn failing_on(self, trigger: InitializeTrigger) -> Self {
        Self {
            failing: Some(trigger),
            ..self
        }
    }

    fn gated(self, gate: &Arc<Semaphore>) -> Self {
        Self {
            gate: Some(Arc::clone(gate)),
            ..self
        }
    }

    fn dropping_into(self, dropped: &Arc<AtomicBool>) -> Self {
        Self {
            dropped: Some(Arc::clone(dropped)),
            ..self
        }
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

impl Initializer for Recording {
    fn initialize(&self, trigger: InitializeTrigger) -> Initialization<'_> {
        Box::pin(async move {
            self.seen
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(Seen {
                    trigger,
                    claimed: lock_path(&self.layout).exists(),
                    serving: self.layout.socket.exists(),
                });
            let gate = self
                .gate
                .as_ref()
                .filter(|_| trigger == InitializeTrigger::ProcessChange);
            let _cancelled = gate
                .and(self.dropped.as_ref())
                .map(|dropped| DropFlag(Arc::clone(dropped)));
            if let Some(gate) = gate {
                let _ = gate.acquire().await.map(|permit| permit.forget());
            }
            if self.failing == Some(trigger) {
                return Err(InitError::new(format!("{trigger:?} broke")));
            }
            Ok(())
        })
    }
}

fn lock_path(layout: &Layout) -> PathBuf {
    layout.state.join("locks").join("process")
}

fn process_file(layout: &Layout) -> PathBuf {
    layout.state.join("process.json")
}

fn options(layout: &Layout, printed: &Printed) -> DaemonOptions {
    DaemonOptions::new(layout.clone(), VERSION).with_output(printed.clone())
}

async fn started(options: DaemonOptions) -> DaemonHandle {
    within(start(options))
        .await
        .expect("the daemon should start")
}

async fn wait_for_phase(daemon: &DaemonHandle, phase: LifecyclePhase) {
    within(async {
        while daemon.phase() != phase {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
}

fn assert_cleaned_up(layout: &Layout) {
    assert!(!layout.socket.exists(), "the socket should be removed");
    assert!(!lock_path(layout).exists(), "the lock should be released");
    assert!(
        !process_file(layout).exists(),
        "the descriptor should be removed"
    );
}

struct WatchedBinary {
    _dir: tempfile::TempDir,
    path: PathBuf,
}

impl WatchedBinary {
    fn new() -> Self {
        let dir = tempfile::tempdir().expect("a temporary binary directory");
        let path = dir.path().join("marbles-daemon");
        let binary = Self { _dir: dir, path };
        binary.install(RUNNING_BINARY);
        binary
    }

    fn install(&self, bytes: &[u8]) {
        let staged = self.path.with_extension("staged");
        fs::write(&staged, bytes).expect("the staged binary");
        fs::set_permissions(&staged, fs::Permissions::from_mode(0o755)).expect("the mode");
        fs::rename(&staged, &self.path).expect("the installed binary");
    }

    fn watched(&self, options: DaemonOptions) -> DaemonOptions {
        let watch = BinaryWatch::for_path(self.path.clone(), QUICK_STABILITY).expect("the watch");
        options
            .with_binary_watch(watch)
            .with_binary_poll_interval(QUICK_POLL)
    }

    fn upgrade(&self) -> RecycleTarget {
        self.install(UPGRADED_BINARY);
        RecycleTarget {
            executable: self.path.clone(),
            previous_digest: digest_of(RUNNING_BINARY),
            new_digest: digest_of(UPGRADED_BINARY),
        }
    }
}

fn digest_of(bytes: &[u8]) -> BinaryDigest {
    let dir = tempfile::tempdir().expect("a temporary directory");
    let path = dir.path().join("bytes");
    fs::write(&path, bytes).expect("the bytes");
    BinaryDigest::hash_file(&path).expect("the digest")
}

fn summary(state: WorkspaceState) -> WorkspaceSummary {
    WorkspaceSummary {
        config: None,
        error: None,
        id: "w1".to_owned(),
        pid: Some(42),
        root: "/repo".to_owned(),
        state,
    }
}

#[tokio::test]
async fn startup_claims_and_initializes_before_serving() {
    let home = home();
    let printed = Printed::default();
    let initializer = Recording::new(&home.layout);

    let daemon =
        started(options(&home.layout, &printed).with_initializer(initializer.clone())).await;

    assert_eq!(
        initializer.seen(),
        [Seen {
            trigger: InitializeTrigger::Start,
            claimed: true,
            serving: false,
        }]
    );
    let socket = fs::metadata(&home.layout.socket).expect("the socket");
    assert!(socket.file_type().is_socket());
    assert_eq!(socket.permissions().mode() & 0o777, SOCKET_MODE);
    assert!(lock_path(&home.layout).exists());
    assert!(process_file(&home.layout).exists());
    assert_eq!(daemon.phase(), LifecyclePhase::Running);
    assert_eq!(daemon.pid(), std::process::id());
    assert_eq!(daemon.socket(), home.layout.socket);
    assert_eq!(
        printed.lines(),
        [format!(
            "[marbles] pid {} · {}",
            std::process::id(),
            home.layout.socket.display()
        )]
    );

    within(daemon.shutdown()).await;
    assert_eq!(daemon.phase(), LifecyclePhase::Stopped);
    assert_cleaned_up(&home.layout);
}

#[tokio::test]
async fn a_failed_initialization_aborts_startup_and_releases_the_claim() {
    let home = home();
    let printed = Printed::default();
    let initializer = Recording::new(&home.layout).failing_on(InitializeTrigger::Start);

    let started = within(start(
        options(&home.layout, &printed).with_initializer(initializer),
    ))
    .await;

    let Err(StartError::Initialize(error)) = started else {
        panic!("a failed initialization should abort the start");
    };
    assert_eq!(error.to_string(), "Start broke");
    assert_cleaned_up(&home.layout);
    assert!(printed.lines().is_empty());
    assert!(ProcessClaim::acquire(&home.layout, VERSION).is_ok());
}

#[tokio::test]
async fn a_socket_that_cannot_be_bound_aborts_startup_and_releases_the_claim() {
    let mut home = home();
    home.layout.socket = home.layout.state.join("missing").join("daemon.sock");
    let printed = Printed::default();

    let started = within(start(options(&home.layout, &printed))).await;

    assert!(matches!(started, Err(StartError::Endpoint(_))));
    assert!(!lock_path(&home.layout).exists());
    assert!(!process_file(&home.layout).exists());
    assert!(ProcessClaim::acquire(&home.layout, VERSION).is_ok());
}

#[tokio::test]
async fn a_held_claim_refuses_a_second_daemon() {
    let home = home();
    let printed = Printed::default();
    let daemon = started(options(&home.layout, &printed)).await;

    let second = within(start(options(&home.layout, &Printed::default()))).await;

    assert!(matches!(second, Err(StartError::Claim(_))));
    assert!(home.layout.socket.exists());
    within(daemon.shutdown()).await;
}

#[tokio::test]
async fn a_process_change_reinitializes_while_still_serving() {
    let home = home();
    let gate = Arc::new(Semaphore::new(0));
    let initializer = Recording::new(&home.layout).gated(&gate);
    let daemon =
        started(options(&home.layout, &Printed::default()).with_initializer(initializer.clone()))
            .await;
    let client = Client::connect(&home.layout.socket).await;

    let changing = tokio::spawn({
        let daemon = daemon.clone();
        async move { daemon.trigger_process_change().await }
    });
    wait_for_phase(&daemon, LifecyclePhase::Initializing).await;
    let answered = client.ask(DaemonMethod::Hello, None).await;
    gate.add_permits(1);
    let changed = within(changing).await.expect("the change should finish");

    assert!(answered.is_ok());
    assert_eq!(changed, Ok(()));
    assert_eq!(daemon.phase(), LifecyclePhase::Running);
    assert_eq!(
        initializer
            .seen()
            .iter()
            .map(|seen| (seen.trigger, seen.serving))
            .collect::<Vec<_>>(),
        [
            (InitializeTrigger::Start, false),
            (InitializeTrigger::ProcessChange, true)
        ]
    );
    within(daemon.shutdown()).await;
}

#[tokio::test]
async fn a_failed_process_change_is_reported_and_the_daemon_keeps_running() {
    let home = home();
    let printed = Printed::default();
    let initializer = Recording::new(&home.layout).failing_on(InitializeTrigger::ProcessChange);
    let daemon = started(options(&home.layout, &printed).with_initializer(initializer)).await;

    let changed = within(daemon.trigger_process_change()).await;

    assert_eq!(
        changed,
        Err(ProcessChangeError::Initialize(
            "ProcessChange broke".to_owned()
        ))
    );
    assert_eq!(daemon.phase(), LifecyclePhase::Running);
    assert!(printed.lines().contains(
        &"[marbles] initializing after a process change failed: ProcessChange broke".to_owned()
    ));
    let client = Client::connect(&home.layout.socket).await;
    assert!(client.ask(DaemonMethod::Hello, None).await.is_ok());
    within(daemon.shutdown()).await;
}

#[tokio::test]
async fn hello_answers_with_the_exact_wire_shape() {
    let home = home();
    let daemon = started(options(&home.layout, &Printed::default())).await;
    let stream = within(UnixStream::connect(&home.layout.socket))
        .await
        .expect("a connection");
    let (reader, mut writer) = stream.into_split();

    writer
        .write_all(b"{\"id\":0,\"method\":\"hello\"}\n")
        .await
        .expect("the request");
    let line = within(BufReader::new(reader).lines().next_line())
        .await
        .expect("a reply")
        .expect("a line");

    assert_eq!(
        line,
        format!(
            "{{\"id\":0,\"result\":{{\"artifacts\":{},\"pid\":{},\"protocol\":1,\"startedAt\":{},\"state\":{},\"version\":\"{VERSION}\"}}}}",
            json!(home.layout.artifacts),
            std::process::id(),
            json!(daemon.started_at()),
            json!(home.layout.state),
        )
    );
    within(daemon.shutdown()).await;
}

#[tokio::test]
async fn workspaces_start_empty_and_unserved_requests_are_refused() {
    let home = home();
    let daemon = started(options(&home.layout, &Printed::default())).await;
    let client = Client::connect(&home.layout.socket).await;

    assert_eq!(
        client.ask(DaemonMethod::Workspaces, None).await,
        Ok(Some(json!([])))
    );
    assert_eq!(
        client
            .ask(DaemonMethod::Register, Some(json!({ "token": "t" })))
            .await,
        Err(ChannelError::Remote(WireError::new(
            "no engine generation was spawned with this token"
        )))
    );
    assert_eq!(
        client
            .ask(DaemonMethod::Detach, Some(json!({ "id": "w9" })))
            .await,
        Err(ChannelError::Remote(WireError::new(
            "no workspace \"w9\" is hosted"
        )))
    );
    within(daemon.shutdown()).await;
}

#[tokio::test]
async fn subscribers_hear_their_workspace_until_they_unsubscribe() {
    let home = home();
    let printed = Printed::default();
    let daemon = started(options(&home.layout, &printed)).await;
    let mut subscriber = Client::connect(&home.layout.socket).await;
    let mut bystander = Client::connect(&home.layout.socket).await;
    let watching = Some(json!({ "id": "w1" }));

    assert_eq!(
        subscriber
            .ask(DaemonMethod::Subscribe, watching.clone())
            .await,
        Ok(None)
    );
    daemon
        .publish_workspace(summary(WorkspaceState::Ready))
        .await;
    daemon.publish_line("w1", "hi").await;

    assert_eq!(
        subscriber.notification().await,
        Notification::new(ClientNotification::Workspace).with_params(json!({
            "config": null, "id": "w1", "pid": 42, "root": "/repo", "state": "ready"
        }))
    );
    assert_eq!(
        subscriber.notification().await,
        Notification::new(ClientNotification::Line)
            .with_params(json!({ "id": "w1", "line": "hi" }))
    );
    assert!(printed.lines().contains(&"[w1] hi".to_owned()));
    assert_eq!(
        bystander.ask(DaemonMethod::Workspaces, None).await,
        Ok(Some(json!([{
            "config": null, "id": "w1", "pid": 42, "root": "/repo", "state": "ready"
        }])))
    );

    assert_eq!(
        subscriber.ask(DaemonMethod::Unsubscribe, watching).await,
        Ok(None)
    );
    daemon.publish_line("w1", "unheard").await;
    assert!(subscriber.ask(DaemonMethod::Hello, None).await.is_ok());
    assert!(subscriber.events.try_recv().is_err());
    assert!(bystander.events.try_recv().is_err());
    within(daemon.shutdown()).await;
}

#[tokio::test]
async fn stopping_marks_subscribed_workspaces_stopped() {
    let home = home();
    let daemon = started(options(&home.layout, &Printed::default())).await;
    let mut subscriber = Client::connect(&home.layout.socket).await;
    assert!(
        subscriber
            .ask(DaemonMethod::Subscribe, Some(json!({ "id": "w1" })))
            .await
            .is_ok()
    );
    daemon
        .publish_workspace(summary(WorkspaceState::Ready))
        .await;
    subscriber.notification().await;

    within(daemon.shutdown()).await;

    assert_eq!(
        subscriber.notification().await,
        Notification::new(ClientNotification::Workspace).with_params(json!({
            "config": null, "id": "w1", "root": "/repo", "state": "stopped"
        }))
    );
    assert!(matches!(subscriber.closed().await, CloseReason::Eof));
}

#[tokio::test]
async fn shutdown_is_acknowledged_before_the_daemon_closes_and_cleans_up() {
    let home = home();
    let printed = Printed::default();
    let daemon = started(options(&home.layout, &printed)).await;
    let mut client = Client::connect(&home.layout.socket).await;

    let acknowledged = client.ask(DaemonMethod::Shutdown, None).await;

    assert_eq!(acknowledged, Ok(None));
    assert!(matches!(client.closed().await, CloseReason::Eof));
    within(daemon.wait_closed()).await;
    assert_eq!(daemon.phase(), LifecyclePhase::Stopped);
    assert_cleaned_up(&home.layout);
    assert_eq!(
        printed.lines().last().map(String::as_str),
        Some("[marbles] stopping")
    );
    assert_eq!(
        within(daemon.trigger_process_change()).await,
        Err(ProcessChangeError::Stopping)
    );
}

#[tokio::test]
async fn losing_the_claim_stops_without_touching_the_successor() {
    let home = home();
    let printed = Printed::default();
    let daemon = started(
        options(&home.layout, &printed).with_claim_check_interval(Duration::from_millis(20)),
    )
    .await;
    let mut client = Client::connect(&home.layout.socket).await;

    fs::remove_file(lock_path(&home.layout)).expect("the lock");
    fs::write(lock_path(&home.layout), "1").expect("the successor's lock");
    fs::remove_file(&home.layout.socket).expect("the socket");
    fs::write(&home.layout.socket, "successor").expect("the successor's socket");
    within(daemon.wait_closed()).await;

    assert!(matches!(client.closed().await, CloseReason::Eof));
    assert_eq!(
        printed.lines()[1..],
        [
            "[marbles] the claim at the state root is gone; stopping".to_owned(),
            "[marbles] stopping".to_owned(),
        ]
    );
    assert_eq!(
        fs::read_to_string(&home.layout.socket).ok().as_deref(),
        Some("successor")
    );
    assert_eq!(
        fs::read_to_string(lock_path(&home.layout)).ok().as_deref(),
        Some("1")
    );
}

#[tokio::test]
async fn stopping_during_a_process_change_refuses_it_and_never_resumes_running() {
    let home = home();
    let gate = Arc::new(Semaphore::new(0));
    let initializer = Recording::new(&home.layout).gated(&gate);
    let daemon =
        started(options(&home.layout, &Printed::default()).with_initializer(initializer)).await;
    let stalled = within(UnixStream::connect(&home.layout.socket))
        .await
        .expect("a connection");
    let (reader, mut writer) = stalled.into_split();
    writer
        .write_all(b"{\"id\":0,\"method\":\"subscribe\",\"params\":{\"id\":\"w1\"}}\n")
        .await
        .expect("the subscription");
    let mut replies = BufReader::new(reader).lines();
    assert_eq!(
        within(replies.next_line()).await.ok().flatten().as_deref(),
        Some("{\"id\":0}")
    );
    let flood = "x".repeat(64 * 1024);
    for _ in 0..32 {
        daemon.publish_line("w1", flood.as_str()).await;
    }

    let changing = tokio::spawn({
        let daemon = daemon.clone();
        async move { daemon.trigger_process_change().await }
    });
    wait_for_phase(&daemon, LifecyclePhase::Initializing).await;
    let stopping = tokio::spawn({
        let daemon = daemon.clone();
        async move { daemon.shutdown().await }
    });
    wait_for_phase(&daemon, LifecyclePhase::Stopping).await;
    let changed = within(changing).await.expect("the change should answer");
    gate.add_permits(1);
    tokio::time::sleep(Duration::from_millis(50)).await;

    assert_eq!(changed, Err(ProcessChangeError::Stopping));
    assert_eq!(daemon.phase(), LifecyclePhase::Stopping);
    drop(replies);
    drop(writer);
    within(stopping).await.expect("the shutdown should finish");
    assert_eq!(daemon.phase(), LifecyclePhase::Stopped);
    assert_cleaned_up(&home.layout);
}

#[tokio::test]
async fn a_changed_binary_recycles_through_a_clean_teardown() {
    let home = home();
    let printed = Printed::default();
    let binary = WatchedBinary::new();
    let daemon = started(binary.watched(options(&home.layout, &printed))).await;
    let stalled = within(UnixStream::connect(&home.layout.socket))
        .await
        .expect("a connection");
    let (reader, mut writer) = stalled.into_split();
    writer
        .write_all(b"{\"id\":0,\"method\":\"subscribe\",\"params\":{\"id\":\"w1\"}}\n")
        .await
        .expect("the subscription");
    let mut replies = BufReader::new(reader).lines();
    assert_eq!(
        within(replies.next_line()).await.ok().flatten().as_deref(),
        Some("{\"id\":0}")
    );
    let flood = "x".repeat(64 * 1024);
    for _ in 0..32 {
        daemon.publish_line("w1", flood.as_str()).await;
    }

    let target = binary.upgrade();
    wait_for_phase(&daemon, LifecyclePhase::Recycling).await;

    assert!(printed.lines().contains(&format!(
        "[marbles] binary changed ({} -> {}); recycling",
        target.previous_digest.short_hex(),
        target.new_digest.short_hex()
    )));
    assert!(!printed.lines().contains(&"[marbles] stopping".to_owned()));
    assert_eq!(
        within(daemon.trigger_process_change()).await,
        Err(ProcessChangeError::Stopping)
    );
    drop(replies);
    drop(writer);
    assert_eq!(
        within(daemon.wait_exit()).await,
        DaemonExit::Recycle(target)
    );
    assert_eq!(daemon.phase(), LifecyclePhase::Stopped);
    assert_cleaned_up(&home.layout);
}

#[tokio::test]
async fn a_recycle_disconnects_clients_and_frees_the_state_root_for_the_successor() {
    let home = home();
    let binary = WatchedBinary::new();
    let daemon = started(binary.watched(options(&home.layout, &Printed::default()))).await;
    let mut client = Client::connect(&home.layout.socket).await;

    let target = binary.upgrade();

    assert!(matches!(client.closed().await, CloseReason::Eof));
    assert_eq!(
        within(daemon.wait_exit()).await,
        DaemonExit::Recycle(target)
    );
    within(daemon.wait_closed()).await;
    assert_cleaned_up(&home.layout);
    let successor = started(options(&home.layout, &Printed::default())).await;
    assert_eq!(successor.phase(), LifecyclePhase::Running);
    within(successor.shutdown()).await;
    assert_eq!(within(successor.wait_exit()).await, DaemonExit::Stopped);
}

#[tokio::test]
async fn an_untouched_binary_keeps_the_daemon_running() {
    let home = home();
    let printed = Printed::default();
    let binary = WatchedBinary::new();
    let daemon = started(binary.watched(options(&home.layout, &printed))).await;

    tokio::time::sleep(QUICK_POLL * 10).await;

    assert_eq!(daemon.phase(), LifecyclePhase::Running);
    within(daemon.shutdown()).await;
    assert_eq!(within(daemon.wait_exit()).await, DaemonExit::Stopped);
    assert_eq!(
        printed.lines().last().map(String::as_str),
        Some("[marbles] stopping")
    );
}

#[tokio::test]
async fn shutting_down_cancels_a_stuck_initializer_before_releasing_the_claim() {
    let home = home();
    let gate = Arc::new(Semaphore::new(0));
    let dropped = Arc::new(AtomicBool::new(false));
    let initializer = Recording::new(&home.layout)
        .gated(&gate)
        .dropping_into(&dropped);
    let daemon =
        started(options(&home.layout, &Printed::default()).with_initializer(initializer)).await;
    let changing = tokio::spawn({
        let daemon = daemon.clone();
        async move { daemon.trigger_process_change().await }
    });
    wait_for_phase(&daemon, LifecyclePhase::Initializing).await;
    assert!(!dropped.load(Ordering::SeqCst));

    within(daemon.shutdown()).await;

    assert!(
        dropped.load(Ordering::SeqCst),
        "the initializer should be cancelled"
    );
    assert_eq!(
        within(changing).await.expect("the change should answer"),
        Err(ProcessChangeError::Stopping)
    );
    assert_cleaned_up(&home.layout);
}

#[tokio::test]
async fn a_changed_binary_waits_for_an_initialization_in_flight_before_recycling() {
    let home = home();
    let gate = Arc::new(Semaphore::new(0));
    let initializer = Recording::new(&home.layout).gated(&gate);
    let binary = WatchedBinary::new();
    let daemon = started(
        binary.watched(options(&home.layout, &Printed::default()).with_initializer(initializer)),
    )
    .await;
    let changing = tokio::spawn({
        let daemon = daemon.clone();
        async move { daemon.trigger_process_change().await }
    });
    wait_for_phase(&daemon, LifecyclePhase::Initializing).await;

    let target = binary.upgrade();
    tokio::time::sleep(QUICK_POLL * 20).await;

    assert_eq!(daemon.phase(), LifecyclePhase::Initializing);
    gate.add_permits(1);
    assert_eq!(within(changing).await.expect("the change answers"), Ok(()));
    assert_eq!(
        within(daemon.wait_exit()).await,
        DaemonExit::Recycle(target)
    );
    assert_eq!(daemon.phase(), LifecyclePhase::Stopped);
    assert_cleaned_up(&home.layout);
}

#[tokio::test]
async fn a_missing_database_is_reported_and_state_is_kept_in_memory() {
    let home = home();
    let printed = Printed::default();

    let daemon = started(options(&home.layout, &printed).with_database()).await;

    assert!(printed.has(&format!(
        "[marbles] no state database at {} yet; using in-memory state store",
        home.layout.database.display()
    )));
    within(daemon.shutdown()).await;
}
