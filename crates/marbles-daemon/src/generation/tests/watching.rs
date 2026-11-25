use std::path::Path;
use std::time::Duration;

use super::mock::{Answer, Plan};
use super::*;
use crate::Layout;
use crate::lifecycle::{Initialization, InitializeTrigger, Initializer};
use crate::protocol::GenerationMethod;
use crate::store::tests::schema;
use crate::store::{GenerationState, StateStore};

const SETTLE: Duration = Duration::from_millis(100);

fn memory() -> StateStore {
    StateStore::in_memory().expect("a memory store")
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

#[tokio::test]
async fn an_edited_source_reloads_into_a_new_generation() {
    let world = World::default();
    let daemon = daemon(&world).await;
    let client = daemon.client().await;
    let repo = repo();
    daemon.attach(&client, &repo).await.expect("the attach");

    polled(&daemon).await;
    tokio::time::sleep(SETTLE).await;
    assert_eq!(world.spawned(), 1);

    edit(&repo, "export const edited = 1;");
    polled(&daemon).await;

    current_on(&daemon, 2).await;
    assert!(
        daemon
            .printed
            .has(&format!("[{}] source changed · reloading", repo.id))
    );
    daemon.exited(1).await;
    polled(&daemon).await;
    tokio::time::sleep(SETTLE).await;
    assert_eq!(world.spawned(), 2);
}

#[tokio::test]
async fn a_refused_edit_is_not_loaded_again_until_it_changes() {
    let world = World::default();
    let daemon = daemon(&world).await;
    let client = daemon.client().await;
    let repo = repo();
    daemon.attach(&client, &repo).await.expect("the attach");
    world.plan(
        2,
        Plan::default().failing_load(&repo.root, "it does not parse"),
    );

    edit(&repo, "export const broken = ;");
    polled(&daemon).await;
    daemon.exited(2).await;
    let printed = daemon.printed.clone();
    eventually(move || printed.has_containing("engine generation 2 did not take over")).await;

    polled(&daemon).await;
    tokio::time::sleep(SETTLE).await;
    polled(&daemon).await;
    tokio::time::sleep(SETTLE).await;
    assert_eq!(world.spawned(), 2);

    edit(&repo, "export const fixed = \"a longer edit\";");
    polled(&daemon).await;
    current_on(&daemon, 3).await;
    assert_eq!(world.spawned(), 3);
}

#[tokio::test]
async fn a_file_read_outside_the_root_joins_the_fingerprint() {
    let world = World::default();
    let daemon = daemon(&world).await;
    let client = daemon.client().await;
    let repo = repo();
    let shared = tempfile::tempdir().expect("a shared directory");
    let file = fs::canonicalize(shared.path())
        .expect("the shared directory")
        .join("shared.ts");
    fs::write(&file, "export const shared = 1;").expect("the shared file");
    daemon.attach(&client, &repo).await.expect("the attach");

    world.notify(
        1,
        "read",
        json!({ "file": file.display().to_string(), "readAt": u64::MAX, "root": repo.root }),
    );
    tokio::time::sleep(SETTLE).await;
    polled(&daemon).await;
    tokio::time::sleep(SETTLE).await;
    assert_eq!(world.spawned(), 1);

    fs::write(&file, "export const shared = 22;").expect("the shared edit");
    polled(&daemon).await;

    current_on(&daemon, 2).await;
}

#[tokio::test]
async fn registered_workspaces_are_hosted_again_when_the_process_starts() {
    let world = World::default();
    let store = memory();
    let stale = store.begin_generation("old").await.expect("a stale row");
    store
        .mark_generation(stale, GenerationState::Current, None)
        .await
        .expect("the stale mark");
    let repo = repo();
    world.register_root(&repo.root);
    store
        .touch_workspace(
            &repo.id,
            Path::new(&repo.root),
            Some(Path::new(&repo.source)),
            true,
        )
        .await
        .expect("the registration");
    let shared = store.clone();

    let daemon = daemon_with(&world, |options| options.with_store(shared)).await;

    current_on(&daemon, 2).await;
    assert!(
        daemon
            .printed
            .has("[marbles] engine generation 2 starting: the Marbles process started")
    );
    let record = store.read_generation(stale).await.expect("the stale row");
    assert_eq!(
        record.map(|record| record.state),
        Some(GenerationState::Exited)
    );
    let probe = store.clone();
    let id = repo.id.clone();
    within(async move {
        loop {
            let record = probe.read_generation(2).await.expect("generation 2");
            if record.as_ref().is_some_and(|record| {
                record.state == GenerationState::Current && record.workspaces == [id.clone()]
            }) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    let client = daemon.client().await;
    let listed = ask(&client, "workspaces", json!({}))
        .await
        .expect("the workspaces");
    assert_eq!(
        listed,
        Some(json!([
            serde_json::to_value(ready_on(&repo, 2)).expect("a summary")
        ]))
    );
}

#[tokio::test]
async fn attaching_and_detaching_record_whether_a_workspace_is_hosted() {
    let world = World::default();
    let store = memory();
    let shared = store.clone();
    let daemon = daemon_with(&world, |options| options.with_store(shared)).await;
    let client = daemon.client().await;
    let repo = repo();

    daemon.attach(&client, &repo).await.expect("the attach");
    let registered = store.read_workspace(&repo.id).await.expect("the read");
    assert!(registered.is_some_and(|registered| registered.hosted));

    ask(&client, "detach", json!({ "id": repo.id }))
        .await
        .expect("the detach");
    let registered = store.read_workspace(&repo.id).await.expect("the read");
    assert!(registered.is_some_and(|registered| !registered.hosted));
    let hosting = store.read_generation(1).await.expect("generation 1");
    assert_eq!(hosting.map(|record| record.workspaces), Some(Vec::new()));
}

#[tokio::test]
async fn a_failed_first_attach_unregisters_the_workspace() {
    let world = World::default();
    world.plan(1, Plan::default().failing_start("the engine broke"));
    let store = memory();
    let shared = store.clone();
    let daemon = daemon_with(&world, |options| options.with_store(shared)).await;
    let client = daemon.client().await;
    let repo = repo();

    let attached = daemon.attach(&client, &repo).await;

    assert!(attached.is_err());
    let registered = store.read_workspace(&repo.id).await.expect("the read");
    assert!(registered.is_some_and(|registered| !registered.hosted));
    let failed = store.read_generation(1).await.expect("generation 1");
    assert_eq!(
        failed.map(|record| record.state),
        Some(GenerationState::Failed)
    );
}

struct CreatesDatabase(Layout);

impl Initializer for CreatesDatabase {
    fn initialize(&self, trigger: InitializeTrigger) -> Initialization<'_> {
        if trigger == InitializeTrigger::Start {
            drop(schema::create(&self.0));
        }
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test]
async fn the_database_an_initializer_made_is_where_hosting_is_recorded() {
    let world = World::default();
    let mut made = None;
    let daemon = daemon_with(&world, |options| {
        made = Some(options.layout.clone());
        let initializer = CreatesDatabase(options.layout.clone());
        options.with_initializer(initializer).with_database()
    })
    .await;
    let layout = made.expect("the layout");
    let client = daemon.client().await;
    let repo = repo();

    daemon.attach(&client, &repo).await.expect("the attach");

    let reader = StateStore::open_existing_sqlite(&layout)
        .expect("the database opens")
        .expect("the initializer made it");
    let registered = reader.read_workspace(&repo.id).await.expect("the read");
    assert!(registered.is_some_and(|registered| registered.hosted));
    let first = reader.read_generation(1).await.expect("generation 1");
    assert_eq!(first.map(|record| record.fingerprint.len()), Some(64));
}

async fn hosting_recorded(store: &StateStore, number: u64, wanted: &[String]) {
    within(async {
        loop {
            let record = store.read_generation(number).await.expect("the generation");
            if record.is_some_and(|record| record.workspaces == wanted) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
}

#[tokio::test]
async fn unrecorded_hosts_are_written_again_after_a_backoff() {
    let world = World::default();
    let store = memory();
    store.fail_hosting_records(2).await.expect("the fault");
    let shared = store.clone();
    let daemon = daemon_with(&world, |options| options.with_store(shared)).await;
    let client = daemon.client().await;
    let repo = repo();

    daemon.attach(&client, &repo).await.expect("the attach");

    hosting_recorded(&store, 1, std::slice::from_ref(&repo.id)).await;
    let failed = "[marbles] which workspaces engine generation 1 hosts was not recorded: the state store failed: the disk is full; it is written again after a backoff";
    let reports = daemon
        .printed
        .lines()
        .into_iter()
        .filter(|line| line == failed)
        .count();
    assert_eq!(reports, 2);
}

#[tokio::test]
async fn a_failed_attach_keeps_a_registration_that_was_already_hosted() {
    let world = World::default();
    world.plan(1, Plan::default().failing_start("the engine broke"));
    let store = memory();
    let repo = repo();
    let shared = store.clone();
    let daemon = daemon_with(&world, |options| options.with_store(shared)).await;
    let client = daemon.client().await;
    store
        .touch_workspace(&repo.id, Path::new(&repo.root), None, true)
        .await
        .expect("a registration another host made");

    let attached = daemon.attach(&client, &repo).await;

    assert!(attached.is_err());
    let registered = store.read_workspace(&repo.id).await.expect("the read");
    assert!(registered.is_some_and(|registered| registered.hosted));
}

#[tokio::test]
async fn a_detach_whose_retirement_fails_puts_the_registration_and_fingerprint_back() {
    let world = World::default();
    world.plan(
        1,
        Plan::default().answering(
            GenerationMethod::Unhost.as_str(),
            [Answer::Fail("a run is stuck".to_owned())],
        ),
    );
    let store = memory();
    let shared = store.clone();
    let daemon = daemon_with(&world, |options| options.with_store(shared)).await;
    let client = daemon.client().await;
    let repo = repo();
    daemon.attach(&client, &repo).await.expect("the attach");

    let detached = ask(&client, "detach", json!({ "id": repo.id })).await;

    assert_eq!(detached.map_err(remote), Err("a run is stuck".to_owned()));
    let registered = store.read_workspace(&repo.id).await.expect("the read");
    assert!(registered.is_some_and(|registered| registered.hosted));
    let listed = ask(&client, "workspaces", json!({}))
        .await
        .expect("the workspaces");
    assert_eq!(
        listed
            .as_ref()
            .and_then(|listed| listed[0]["error"].as_str()),
        Some("detach failed: a run is stuck; attach it again to load it afresh")
    );
    polled(&daemon).await;
    tokio::time::sleep(SETTLE).await;
    assert_eq!(world.spawned(), 1);
}
