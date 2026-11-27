use super::mock::{Answer, Plan};
use super::*;
use crate::identity::{ProcessIdentity, this_process};
use crate::protocol::GenerationMethod;
use crate::store::{GenerationState, StateStore};

const GONE_PID: u32 = 4_999_999;

struct Swept {
    daemon: Daemon,
    store: StateStore,
    repo: Repo,
    _client: Client,
}

async fn swept(world: &World) -> Swept {
    let store = StateStore::in_memory().expect("a memory store");
    let shared = store.clone();
    let daemon = daemon_with(world, |options| options.with_store(shared)).await;
    let client = daemon.client().await;
    let repo = repo();
    daemon.attach(&client, &repo).await.expect("the attach");
    Swept {
        daemon,
        store,
        repo,
        _client: client,
    }
}

fn generation_identity(number: u64) -> ProcessIdentity {
    ProcessIdentity {
        pid: mock_pid(number),
        started: Some(format!("mock:{number}")),
    }
}

fn gone() -> ProcessIdentity {
    ProcessIdentity {
        pid: GONE_PID,
        started: Some("ps:gone".to_owned()),
    }
}

impl Swept {
    async fn queue(&self, run_id: &str, owner: &ProcessIdentity) {
        let body = json!({
            "id": run_id,
            "state": { "kind": "queued", "queuedAt": 1, "availableAt": 1, "owner": owner },
        });
        self.store
            .put_queue_run(&self.repo.id, &body)
            .await
            .expect("the queued run");
    }

    async fn sweep(&self) {
        within(self.daemon.handle.sweep_now()).await;
    }
}

#[tokio::test]
async fn runs_queued_by_the_current_generation_are_taken_over_once() {
    let world = World::default();
    let swept = swept(&world).await;
    swept.queue("mine", &generation_identity(1)).await;

    swept.sweep().await;
    swept.sweep().await;

    assert_eq!(
        world.params_of(1, GenerationMethod::TakeHanded.as_str()),
        [json!({ "id": swept.repo.id, "runId": "mine" })]
    );
}

#[tokio::test]
async fn a_declined_hand_over_is_offered_again_only_once_it_rests() {
    let world = World::default();
    world.plan(
        1,
        Plan::default().answering(
            GenerationMethod::TakeHanded.as_str(),
            [Answer::Value(json!(false))],
        ),
    );
    let swept = swept(&world).await;
    swept.queue("mine", &generation_identity(1)).await;

    swept.sweep().await;
    let offered = world
        .params_of(1, GenerationMethod::TakeHanded.as_str())
        .len();
    swept.sweep().await;

    assert_eq!(offered, 5);
    assert_eq!(
        world
            .params_of(1, GenerationMethod::TakeHanded.as_str())
            .len(),
        offered
    );
}

#[tokio::test]
async fn a_queued_run_of_a_gone_process_is_adopted() {
    let world = World::default();
    world.plan(
        1,
        Plan::default().answering(
            GenerationMethod::TakeQueued.as_str(),
            [Answer::Value(json!({ "taken": true }))],
        ),
    );
    let swept = swept(&world).await;
    swept.queue("orphan", &gone()).await;
    swept.queue("alive", &this_process()).await;

    swept.sweep().await;

    assert_eq!(
        world.params_of(1, GenerationMethod::TakeQueued.as_str()),
        [json!({ "id": swept.repo.id, "owner": gone(), "runId": "orphan" })]
    );
    assert!(
        world
            .params_of(1, GenerationMethod::TakeHanded.as_str())
            .is_empty()
    );
}

#[tokio::test]
async fn a_declined_adoption_is_reported_once_and_rests_before_another_offer() {
    let world = World::default();
    world.plan(
        1,
        Plan::default().answering(
            GenerationMethod::TakeQueued.as_str(),
            [Answer::Value(
                json!({ "taken": false, "why": "its pool is paused" }),
            )],
        ),
    );
    let swept = swept(&world).await;
    swept.queue("orphan", &gone()).await;

    swept.sweep().await;
    swept.sweep().await;

    assert_eq!(
        world
            .params_of(1, GenerationMethod::TakeQueued.as_str())
            .len(),
        1
    );
    let report = format!(
        "[{}] queued run orphan of gone process pid {GONE_PID} left queued: its pool is paused; offered again every 30 s",
        swept.repo.id
    );
    let reports = swept
        .daemon
        .printed
        .lines()
        .into_iter()
        .filter(|line| *line == report)
        .count();
    assert_eq!(reports, 1);
}

#[tokio::test]
async fn retiring_generations_proved_gone_are_recorded_exited_by_the_sweep() {
    let world = World::default();
    let swept = swept(&world).await;
    let number = swept.store.begin_generation("old").await.expect("a row");
    let dead = gone();
    swept
        .store
        .record_generation_spawned(number, dead.pid, dead.started.as_deref())
        .await
        .expect("spawned");
    swept
        .store
        .mark_generation(number, GenerationState::Retiring, None)
        .await
        .expect("retiring");

    swept.sweep().await;

    assert!(swept.daemon.printed.has(&format!(
        "[marbles] engine generation {number} is gone, and recorded exited"
    )));
    let record = swept.store.read_generation(number).await.expect("the row");
    assert_eq!(
        record.map(|record| record.state),
        Some(GenerationState::Exited)
    );
}

#[tokio::test]
async fn an_answer_no_host_takes_sweeps_once_before_it_fails() {
    let world = World::default();
    world.plan(
        1,
        Plan::default()
            .answering(
                "workspace.answer",
                [Answer::Fail("no such question".to_owned())],
            )
            .answering(
                GenerationMethod::TakeQueued.as_str(),
                [Answer::Value(json!({ "taken": true }))],
            ),
    );
    let swept = swept(&world).await;
    swept.queue("orphan", &gone()).await;
    let client = swept.daemon.client().await;

    let answered = ask(&client, "workspace.answer", json!({ "id": swept.repo.id })).await;

    assert_eq!(answered.map_err(remote), Err("no such question".to_owned()));
    assert_eq!(world.params_of(1, "workspace.answer").len(), 2);
    assert_eq!(
        world
            .params_of(1, GenerationMethod::TakeQueued.as_str())
            .len(),
        1
    );
}
