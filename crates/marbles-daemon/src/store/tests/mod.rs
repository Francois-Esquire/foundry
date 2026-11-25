pub(crate) mod schema;

use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};

use rusqlite::Connection;
use serde_json::{Value, json};

use super::{GenerationState, QueuedRun, StateStore, StoreError, StoredWorkspace};
use crate::identity::{ProcessIdentity, this_process};
use crate::test_support::{Home, home};

const GONE_PID: u32 = 4_999_999;

enum Backing {
    Memory(StateStore),
    Sqlite(StateStore, Connection),
}

struct Fixture {
    home: Home,
    backing: Backing,
}

impl Fixture {
    fn memory() -> Self {
        let home = home();
        fs::create_dir_all(&home.layout.state).expect("the state root");
        let store = StateStore::in_memory_within(&home.layout.state).expect("a memory store");
        Self {
            home,
            backing: Backing::Memory(store),
        }
    }

    fn sqlite() -> Self {
        let home = home();
        let connection = schema::create(&home.layout);
        let store = StateStore::open_existing_sqlite(&home.layout)
            .expect("the database opens")
            .expect("the database exists");
        Self {
            home,
            backing: Backing::Sqlite(store, connection),
        }
    }

    fn both() -> [Self; 2] {
        [Self::memory(), Self::sqlite()]
    }

    fn store(&self) -> &StateStore {
        match &self.backing {
            Backing::Memory(store) => store,
            Backing::Sqlite(store, _) => store,
        }
    }

    fn state(&self) -> &Path {
        &self.home.layout.state
    }

    async fn put_run(&self, scope: &str, body: &Value) {
        match &self.backing {
            Backing::Memory(store) => store.put_queue_run(scope, body).await.expect("the run"),
            Backing::Sqlite(_, connection) => schema::put_queue_run(connection, scope, body),
        }
    }

    async fn generation(&self, number: u64) -> Option<super::GenerationRecord> {
        match &self.backing {
            Backing::Memory(store) => store.read_generation(number).await,
            Backing::Sqlite(store, _) => store.read_generation(number).await,
        }
        .expect("the generation reads")
    }

    async fn state_of(&self, number: u64) -> Option<GenerationState> {
        self.generation(number).await.map(|record| record.state)
    }
}

fn workspace(id: &str, hosted: bool) -> StoredWorkspace {
    StoredWorkspace {
        id: id.to_owned(),
        root: PathBuf::from(format!("/repos/{id}")),
        config: hosted.then(|| PathBuf::from(format!("/repos/{id}/.foundry/marbles"))),
        hosted,
    }
}

async fn touch(store: &StateStore, workspace: &StoredWorkspace) {
    store
        .touch_workspace(
            &workspace.id,
            &workspace.root,
            workspace.config.as_deref(),
            workspace.hosted,
        )
        .await
        .expect("the touch");
}

fn queued(id: &str, at: u64, owner: &ProcessIdentity) -> Value {
    json!({ "id": id, "state": { "kind": "queued", "queuedAt": at, "availableAt": at, "owner": owner } })
}

#[tokio::test]
async fn workspaces_are_touched_listed_by_id_and_unhosted_once() {
    for fixture in Fixture::both() {
        let store = fixture.store();
        touch(store, &workspace("b2", true)).await;
        touch(store, &workspace("a1", true)).await;
        touch(store, &workspace("c3", false)).await;

        let hosted = store.list_hosted_workspaces().await.expect("the list");
        assert_eq!(hosted, [workspace("a1", true), workspace("b2", true)]);
        assert_eq!(
            store.read_workspace("c3").await.expect("the read"),
            Some(workspace("c3", false))
        );
        assert_eq!(store.read_workspace("zz").await.expect("the read"), None);

        assert!(store.unhost_workspace("a1").await.expect("the unhost"));
        assert!(!store.unhost_workspace("a1").await.expect("the unhost"));
        assert!(!store.unhost_workspace("zz").await.expect("the unhost"));
        let hosted = store.list_hosted_workspaces().await.expect("the list");
        assert_eq!(hosted, [workspace("b2", true)]);
    }
}

#[tokio::test]
async fn a_touch_keeps_when_a_workspace_was_first_seen_and_where_it_works() {
    let fixture = Fixture::sqlite();
    let Backing::Sqlite(store, connection) = &fixture.backing else {
        return;
    };
    connection
        .execute(
            "INSERT INTO marbles_workspaces (config, cwd, first_seen, hosted, id, last_seen, root) \
             VALUES (NULL, '/elsewhere', 'then', 0, 'a1', 'then', '/old')",
            [],
        )
        .expect("an earlier registration");

    touch(store, &workspace("a1", true)).await;

    let (cwd, first_seen, last_seen, root): (String, String, String, String) = connection
        .query_row(
            "SELECT cwd, first_seen, last_seen, root FROM marbles_workspaces WHERE id = 'a1'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .expect("the registration");
    assert_eq!(cwd, "/elsewhere");
    assert_eq!(first_seen, "then");
    assert_ne!(last_seen, "then");
    assert_eq!(root, "/repos/a1");
}

#[tokio::test]
async fn a_workspace_whose_state_links_out_of_the_state_root_is_left_out() {
    for fixture in Fixture::both() {
        let outside = tempfile::tempdir().expect("an outside directory");
        fs::create_dir_all(fixture.state().join("kept")).expect("a real state directory");
        symlink(outside.path(), fixture.state().join("linked")).expect("the link");
        let store = fixture.store();
        for id in ["kept", "linked", "fresh"] {
            touch(store, &workspace(id, true)).await;
        }

        let hosted: Vec<String> = store
            .list_hosted_workspaces()
            .await
            .expect("the list")
            .into_iter()
            .map(|workspace| workspace.id)
            .collect();

        assert_eq!(hosted, ["fresh", "kept"]);
        assert_eq!(
            store.read_workspace("linked").await.expect("the read"),
            None
        );
    }
}

#[tokio::test]
async fn generations_are_numbered_and_recorded_as_they_move() {
    for fixture in Fixture::both() {
        let store = fixture.store();
        assert_eq!(store.begin_generation("fp1").await, Ok(1));
        assert_eq!(store.begin_generation("fp2").await, Ok(2));
        store
            .record_generation_spawned(2, 42, None)
            .await
            .expect("spawned");
        store
            .record_generation_identified(2, 42, Some("ps:x"))
            .await
            .expect("identified");
        store
            .record_generation_hosting(2, &["b".to_owned(), "a".to_owned()])
            .await
            .expect("hosting");
        store
            .mark_generation(2, GenerationState::Failed, Some("it broke"))
            .await
            .expect("failed");
        store
            .mark_generation(2, GenerationState::Exited, None)
            .await
            .expect("exited");

        let record = fixture.generation(2).await.expect("generation 2");
        assert_eq!(record.fingerprint, "fp2");
        assert_eq!(record.pid, 42);
        assert_eq!(record.started.as_deref(), Some("ps:x"));
        assert_eq!(record.workspaces, ["a", "b"]);
        assert_eq!(record.state, GenerationState::Exited);
        assert_eq!(record.error.as_deref(), Some("it broke"));
        assert_eq!(fixture.state_of(1).await, Some(GenerationState::Loading));
    }
}

#[tokio::test]
async fn identifying_a_generation_repairs_the_pid_and_start_a_missed_spawn_left_blank() {
    for fixture in Fixture::both() {
        let store = fixture.store();
        assert_eq!(store.begin_generation("fp").await, Ok(1));
        assert_eq!(
            fixture.generation(1).await.map(|record| record.pid),
            Some(0)
        );

        store
            .record_generation_identified(1, 77, Some("ps:real"))
            .await
            .expect("identified");

        let record = fixture.generation(1).await.expect("generation 1");
        assert_eq!(record.pid, 77);
        assert_eq!(record.started.as_deref(), Some("ps:real"));
    }
}

async fn generation_at(
    store: &StateStore,
    identity: Option<&ProcessIdentity>,
    state: GenerationState,
) -> u64 {
    let number = store.begin_generation("fp").await.expect("a number");
    if let Some(identity) = identity {
        store
            .record_generation_spawned(number, identity.pid, identity.started.as_deref())
            .await
            .expect("spawned");
    }
    store
        .mark_generation(number, state, None)
        .await
        .expect("marked");
    number
}

#[tokio::test]
async fn ending_all_generations_retires_live_ones_and_exits_gone_ones() {
    let me = this_process();
    assert!(
        me.started.is_some(),
        "this process's start should be readable"
    );
    let gone = ProcessIdentity {
        pid: GONE_PID,
        started: Some("ps:gone".to_owned()),
    };
    let unknown = ProcessIdentity {
        pid: me.pid,
        started: None,
    };
    for fixture in Fixture::both() {
        let store = fixture.store();
        let never_spawned = generation_at(store, None, GenerationState::Loading).await;
        let alive = generation_at(store, Some(&me), GenerationState::Current).await;
        let dead = generation_at(store, Some(&gone), GenerationState::Retiring).await;
        let unprovable = generation_at(store, Some(&unknown), GenerationState::Current).await;
        let failed = generation_at(store, Some(&gone), GenerationState::Failed).await;

        store.end_all_generations().await.expect("the ending");

        assert_eq!(
            fixture.state_of(never_spawned).await,
            Some(GenerationState::Exited)
        );
        assert_eq!(
            fixture.state_of(alive).await,
            Some(GenerationState::Retiring)
        );
        assert_eq!(fixture.state_of(dead).await, Some(GenerationState::Exited));
        assert_eq!(
            fixture.state_of(unprovable).await,
            Some(GenerationState::Current)
        );
        assert_eq!(
            fixture.state_of(failed).await,
            Some(GenerationState::Failed)
        );
    }
}

#[tokio::test]
async fn retiring_generations_proved_gone_are_recorded_exited() {
    let me = this_process();
    let gone = ProcessIdentity {
        pid: GONE_PID,
        started: Some("ps:gone".to_owned()),
    };
    let unproved = ProcessIdentity {
        pid: GONE_PID,
        started: None,
    };
    for fixture in Fixture::both() {
        let store = fixture.store();
        let alive = generation_at(store, Some(&me), GenerationState::Retiring).await;
        let dead = generation_at(store, Some(&gone), GenerationState::Retiring).await;
        let unknown = generation_at(store, Some(&unproved), GenerationState::Retiring).await;
        let current = generation_at(store, Some(&gone), GenerationState::Current).await;

        assert_eq!(store.end_gone_generations().await, Ok(vec![dead]));
        assert_eq!(store.end_gone_generations().await, Ok(vec![]));

        assert_eq!(
            fixture.state_of(alive).await,
            Some(GenerationState::Retiring)
        );
        assert_eq!(fixture.state_of(dead).await, Some(GenerationState::Exited));
        assert_eq!(
            fixture.state_of(unknown).await,
            Some(GenerationState::Retiring)
        );
        assert_eq!(
            fixture.state_of(current).await,
            Some(GenerationState::Current)
        );
    }
}

#[tokio::test]
async fn queued_runs_come_in_queue_order_and_owners_are_read_from_runs() {
    let one = ProcessIdentity {
        pid: 11,
        started: Some("ps:one".to_owned()),
    };
    let two = ProcessIdentity {
        pid: 22,
        started: None,
    };
    for fixture in Fixture::both() {
        fixture.put_run("w1", &queued("late", 30, &one)).await;
        fixture.put_run("w1", &queued("early", 10, &two)).await;
        fixture.put_run("w2", &queued("other", 1, &one)).await;
        fixture
            .put_run(
                "w1",
                &json!({ "id": "busy", "state": { "kind": "running", "lease": { "claimedAt": 1, "owner": one } } }),
            )
            .await;
        let store = fixture.store();

        assert_eq!(
            store.queued_runs("w1").await,
            Ok(vec![
                QueuedRun {
                    id: "early".to_owned(),
                    owner: two.clone(),
                },
                QueuedRun {
                    id: "late".to_owned(),
                    owner: one.clone(),
                },
            ])
        );
        assert_eq!(
            store.read_run_owner("w1", "busy").await,
            Ok(Some(one.clone()))
        );
        assert_eq!(
            store.read_run_owner("w1", "early").await,
            Ok(Some(two.clone()))
        );
        assert_eq!(store.read_run_owner("w1", "other").await, Ok(None));
    }
}

#[test]
fn a_missing_database_is_not_made() {
    let home = home();

    assert!(matches!(
        StateStore::open_existing_sqlite(&home.layout),
        Ok(None)
    ));
    assert!(matches!(
        StateStore::open_sqlite(&home.layout),
        Err(StoreError::Failed(_))
    ));
    assert!(!home.layout.database.exists());
}
