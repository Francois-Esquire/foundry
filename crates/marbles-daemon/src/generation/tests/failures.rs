use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use super::mock::Plan;
use super::*;
use crate::lifecycle::{InitError, Initialization, InitializeTrigger, Initializer};
use crate::protocol::WorkspaceState;
use crate::store::StateStore;

const SETTLE: Duration = Duration::from_millis(100);

#[derive(Clone)]
struct FailsAfter {
    allowed: usize,
    calls: Arc<AtomicUsize>,
}

impl FailsAfter {
    fn new(allowed: usize) -> Self {
        Self {
            allowed,
            calls: Arc::default(),
        }
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl Initializer for FailsAfter {
    fn initialize(&self, trigger: InitializeTrigger) -> Initialization<'_> {
        let failing = trigger == InitializeTrigger::ProcessChange
            && self.calls.fetch_add(1, Ordering::SeqCst) >= self.allowed;
        Box::pin(async move {
            if failing {
                Err(InitError::new("the schema is newer"))
            } else {
                Ok(())
            }
        })
    }
}

fn edit(repo: &Repo, contents: &str) {
    fs::write(Path::new(&repo.source).join("flow.ts"), contents).expect("the edit");
}

async fn polled(daemon: &Daemon) {
    within(async {
        while !daemon.handle.poll_now().await {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
}

async fn current_on(daemon: &Daemon, number: u64) {
    let line = format!("[marbles] engine generation {number} is current");
    let printed = daemon.printed.clone();
    eventually(move || printed.has(&line)).await;
}

async fn state_of(client: &Client, repo: &Repo) -> Option<WorkspaceState> {
    let listed = ask(client, "workspaces", json!({}))
        .await
        .expect("the workspaces");
    listed?
        .as_array()?
        .iter()
        .find(|workspace| workspace["id"] == repo.id.as_str())
        .and_then(|workspace| serde_json::from_value(workspace["state"].clone()).ok())
}

#[tokio::test]
async fn a_launcher_that_cannot_spawn_reverts_the_workspace_and_refuses_the_change() {
    let world = World::default();
    let daemon = daemon(&world).await;
    let client = daemon.client().await;
    let repo = repo();
    daemon.attach(&client, &repo).await.expect("the attach");
    world.fail_spawns(1);

    edit(&repo, "export const edited = 1;");
    polled(&daemon).await;
    let printed = daemon.printed.clone();
    eventually(move || printed.has_containing("engine generation 2 did not take over")).await;

    assert_eq!(state_of(&client, &repo).await, Some(WorkspaceState::Ready));
    polled(&daemon).await;
    tokio::time::sleep(SETTLE).await;
    polled(&daemon).await;
    tokio::time::sleep(SETTLE).await;
    assert_eq!(world.spawn_attempts(), 2);

    edit(&repo, "export const edited = \"again\";");
    polled(&daemon).await;
    current_on(&daemon, 3).await;
    assert_eq!(state_of(&client, &repo).await, Some(WorkspaceState::Ready));
}

#[tokio::test]
async fn a_failed_process_change_backs_off_instead_of_polling_again() {
    let world = World::default();
    let initializer = FailsAfter::new(1);
    let probe = initializer.clone();
    let daemon = daemon_with(&world, |options| options.with_initializer(initializer)).await;
    let client = daemon.client().await;
    let repo = repo();
    daemon.attach(&client, &repo).await.expect("the attach");

    edit(&repo, "export const edited = 1;");
    polled(&daemon).await;

    let printed = daemon.printed.clone();
    eventually(move || {
        printed.has("[marbles] initializing after a process change failed; the next engine generation starts in 50ms")
            && printed.has("[marbles] initializing after a process change failed; the next engine generation starts in 100ms")
    })
    .await;
    assert_eq!(state_of(&client, &repo).await, Some(WorkspaceState::Ready));
    assert_eq!(world.spawned(), 1);
    assert!(probe.calls() >= 3);
}

#[tokio::test]
async fn an_unclean_exit_of_a_retiring_generation_forces_a_switch() {
    let world = World::default();
    world.plan(1, Plan::default().lingering());
    let daemon = daemon(&world).await;
    let client = daemon.client().await;
    let repo = repo();
    daemon.attach(&client, &repo).await.expect("the attach");
    daemon.reload(&client, &repo).await.expect("the reload");
    current_on(&daemon, 2).await;
    assert_eq!(world.spawned(), 2);

    world.crash(1);

    current_on(&daemon, 3).await;
    assert!(
        daemon
            .printed
            .has_containing("retired engine generation 1 died: it crashed")
    );
    assert!(
        daemon
            .printed
            .has_containing("engine generation 3 starting: a retired engine generation died")
    );
}

#[tokio::test]
async fn reads_sent_before_a_failed_load_are_watched_by_the_refusal() {
    let world = World::default();
    let daemon = daemon(&world).await;
    let client = daemon.client().await;
    let repo = repo();
    let shared = tempfile::tempdir().expect("a shared directory");
    let outside = fs::canonicalize(shared.path())
        .expect("the shared directory")
        .join("shared.ts");
    fs::write(&outside, "export const shared = 1;").expect("the shared file");
    daemon.attach(&client, &repo).await.expect("the attach");
    world.plan(
        2,
        Plan::default()
            .reading_before_load(&repo.root, &outside.display().to_string())
            .failing_load(&repo.root, "it does not parse"),
    );

    edit(&repo, "export const broken = ;");
    polled(&daemon).await;
    let printed = daemon.printed.clone();
    eventually(move || printed.has_containing("engine generation 2 did not take over")).await;
    polled(&daemon).await;
    tokio::time::sleep(SETTLE).await;
    assert_eq!(world.spawned(), 2);

    fs::write(&outside, "export const shared = 22;").expect("the shared edit");
    polled(&daemon).await;

    current_on(&daemon, 3).await;
}

#[tokio::test]
async fn identifying_a_generation_records_the_pid_a_missed_spawn_record_left_blank() {
    let world = World::default();
    let store = StateStore::in_memory().expect("a memory store");
    let shared = store.clone();
    let daemon = daemon_with(&world, |options| options.with_store(shared)).await;
    let client = daemon.client().await;
    let repo = repo();

    daemon.attach(&client, &repo).await.expect("the attach");

    let record = store.read_generation(1).await.expect("generation 1");
    assert_eq!(
        record.map(|record| (record.pid, record.started)),
        Some((i64::from(mock_pid(1)), Some("mock:1".to_owned())))
    );
}

#[tokio::test]
async fn editing_one_workspace_leaves_the_others_ready() {
    let world = World::default();
    let daemon = daemon(&world).await;
    let mut client = daemon.client().await;
    let (first, second) = (repo(), repo());
    daemon
        .attach(&client, &first)
        .await
        .expect("the first attach");
    daemon
        .attach(&client, &second)
        .await
        .expect("the second attach");
    subscribe(&client, &first).await;
    subscribe(&client, &second).await;

    edit(&first, "export const edited = 1;");
    polled(&daemon).await;
    current_on(&daemon, 2).await;

    let mut states: Vec<(String, WorkspaceState)> = Vec::new();
    while let Ok(event) = client.events.try_recv() {
        if let crate::channel::ChannelEvent::Notification(notification) = event {
            if notification.method.as_str() == ClientNotification::Workspace.as_str() {
                let summary = summary_of(notification.params);
                states.push((summary.id, summary.state));
            }
        }
    }
    assert!(states.contains(&(first.id.clone(), WorkspaceState::Reloading)));
    assert!(!states.contains(&(second.id.clone(), WorkspaceState::Reloading)));
    assert_eq!(
        state_of(&client, &second).await,
        Some(WorkspaceState::Ready)
    );
}
